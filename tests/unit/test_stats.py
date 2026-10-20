"""Unit tests for server-authoritative room statistics."""

from __future__ import annotations

import copy
import unittest

from app.catalog.loader import get_sample_plan
from app.plans.stats import room_stats, summary


class StatsTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.doc = copy.deepcopy(get_sample_plan()["doc"])

    def test_sample_rooms(self) -> None:
        rows = room_stats(self.doc)
        self.assertEqual(len(rows), 2)
        living = rows[0]
        self.assertEqual(living["roomId"], "r1")
        self.assertEqual(living["areaM2"], 12.0)
        self.assertEqual(living["perimeterM"], 14.0)
        self.assertEqual(living["wallAreaM2"], 33.32)
        self.assertEqual(living["furnitureCount"], 4)
        self.assertEqual(living["floorMaterial"], "floor-oak")
        self.assertEqual(living["wallMaterial"], "paint-warm-white")

    def test_summary(self) -> None:
        rows = room_stats(self.doc)
        totals = summary(self.doc, rows)
        self.assertEqual(totals["roomCount"], 2)
        self.assertEqual(totals["totalAreaM2"], 21.0)
        self.assertEqual(totals["furnitureCount"], 7)

    def test_furniture_on_boundary_is_counted(self) -> None:
        self.doc["furniture"].append(
            {"id": "f99", "catalogId": "plant", "x": 0, "y": 1500, "rotation": 0}
        )
        rows = room_stats(self.doc)
        # (0, 1500) sits on the shared left wall of room r1 (and outside r2).
        self.assertEqual(rows[0]["furnitureCount"], 5)
        self.assertEqual(rows[1]["furnitureCount"], 3)

    def test_furniture_outside_rooms_is_not_counted(self) -> None:
        self.doc["furniture"].append(
            {"id": "f98", "catalogId": "plant", "x": 9000, "y": 9000, "rotation": 0}
        )
        rows = room_stats(self.doc)
        self.assertEqual(rows[0]["furnitureCount"], 4)
        self.assertEqual(rows[1]["furnitureCount"], 3)
        self.assertEqual(summary(self.doc, rows)["furnitureCount"], 8)

    def test_missing_materials_report_none(self) -> None:
        self.doc["materials"] = {}
        rows = room_stats(self.doc)
        self.assertIsNone(rows[0]["floorMaterial"])
        self.assertIsNone(rows[0]["wallMaterial"])

    def test_no_rooms(self) -> None:
        document = copy.deepcopy(self.doc)
        document["rooms"] = []
        self.assertEqual(room_stats(document), [])
        self.assertEqual(
            summary(document, []),
            {"roomCount": 0, "totalAreaM2": 0, "furnitureCount": 7},
        )


if __name__ == "__main__":
    unittest.main()
