"""Unit tests for CSV formatting and formula-injection hardening."""

from __future__ import annotations

import csv
import io
import unittest

from app.export.csv import COLUMNS, build_csv, filename_for, sanitize_cell

STATS = [
    {
        "roomName": "客厅",
        "areaM2": 12.0,
        "furnitureCount": 4,
        "floorMaterial": "floor-oak",
        "wallMaterial": "paint-warm-white",
        "wallAreaM2": 33.32,
    },
    {
        "roomName": "卧室",
        "areaM2": 9.0,
        "furnitureCount": 3,
        "floorMaterial": None,
        "wallMaterial": None,
        "wallAreaM2": 30.03,
    },
]


class CsvTestCase(unittest.TestCase):
    def test_columns_are_frozen(self) -> None:
        self.assertEqual(
            COLUMNS,
            (
                "room_name",
                "area_m2",
                "furniture_count",
                "floor_material",
                "floor_area_m2",
                "wall_material",
                "wall_area_m2",
            ),
        )

    def test_bom_and_crlf(self) -> None:
        data = build_csv(STATS)
        self.assertTrue(data.startswith(b"\xef\xbb\xbf"))
        text = data.decode("utf-8-sig")
        self.assertIn("\r\n", text)
        self.assertNotIn("\n", text.replace("\r\n", ""))
        lines = text.split("\r\n")
        self.assertEqual(lines[-1], "")
        self.assertEqual(lines[0], ",".join(COLUMNS))

    def test_rows_and_numbers(self) -> None:
        text = build_csv(STATS).decode("utf-8-sig")
        rows = list(csv.reader(io.StringIO(text, newline="")))
        self.assertEqual(rows[1][0], "客厅")
        self.assertEqual(rows[1][1], "12.00")
        self.assertEqual(rows[1][2], "4")
        self.assertEqual(rows[1][3], "floor-oak")
        self.assertEqual(rows[1][4], "12.00")
        self.assertEqual(rows[1][5], "paint-warm-white")
        self.assertEqual(rows[1][6], "33.32")
        self.assertEqual(rows[2][3], "")
        self.assertEqual(rows[2][5], "")

    def test_formula_prefixes_are_neutralised(self) -> None:
        for risky in ("=SUM(A1)", "+1+1", "-2+3", "@cmd", "  =1+1"):
            with self.subTest(value=risky):
                cleaned = sanitize_cell(risky)
                self.assertTrue(cleaned.startswith("'"), cleaned)
        self.assertEqual(sanitize_cell("normal"), "normal")
        self.assertEqual(sanitize_cell(None), "")
        self.assertEqual(sanitize_cell(12), "12")

    def test_formula_injection_in_room_name(self) -> None:
        stats = [
            {
                "roomName": "=SUM(A1)",
                "areaM2": 12.0,
                "furnitureCount": 0,
                "floorMaterial": None,
                "wallMaterial": None,
                "wallAreaM2": 1.0,
            }
        ]
        text = build_csv(stats).decode("utf-8-sig")
        rows = list(csv.reader(io.StringIO(text, newline="")))
        self.assertEqual(rows[1][0], "'=SUM(A1)")

    def test_rfc4180_escaping(self) -> None:
        stats = [
            {
                "roomName": '客厅, "主"',
                "areaM2": 12.0,
                "furnitureCount": 0,
                "floorMaterial": "floor-oak",
                "wallMaterial": None,
                "wallAreaM2": 1.0,
            }
        ]
        text = build_csv(stats).decode("utf-8-sig")
        rows = list(csv.reader(io.StringIO(text, newline="")))
        self.assertEqual(rows[1][0], '客厅, "主"')
        self.assertIn('"客厅, ""主"""', text)

    def test_filename_has_ascii_fallback_and_utf8_name(self) -> None:
        disposition = filename_for("演示户型", 7)
        self.assertIn('filename="plan-7.csv"', disposition)
        self.assertIn("filename*=UTF-8''", disposition)
        self.assertIn("%E6%BC%94%E7%A4%BA", disposition)


if __name__ == "__main__":
    unittest.main()
