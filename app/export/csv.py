"""Per-room CSV export (UTF-8 BOM, CRLF, RFC 4180, formula-injection safe)."""

from __future__ import annotations

import csv
import io
from typing import Any, Iterable
from urllib.parse import quote

COLUMNS = (
    "room_name",
    "area_m2",
    "furniture_count",
    "floor_material",
    "floor_area_m2",
    "wall_material",
    "wall_area_m2",
)

_FORMULA_PREFIXES = ("=", "+", "-", "@")


def sanitize_cell(value: Any) -> str:
    """Prefix risky leading characters so spreadsheets treat cells as text."""
    if value is None:
        return ""
    text = str(value)
    stripped = text.lstrip()
    if stripped[:1] in _FORMULA_PREFIXES:
        return "'" + text
    return text


def _room_rows(stats: Iterable[dict[str, Any]]) -> Iterable[list[str]]:
    for row in stats:
        area = float(row["areaM2"])
        wall_area = float(row["wallAreaM2"])
        yield [
            sanitize_cell(row["roomName"]),
            f"{area:.2f}",
            sanitize_cell(row["furnitureCount"]),
            sanitize_cell(row.get("floorMaterial")),
            f"{area:.2f}",
            sanitize_cell(row.get("wallMaterial")),
            f"{wall_area:.2f}",
        ]


def build_csv(stats: list[dict[str, Any]]) -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
    writer.writerow(COLUMNS)
    writer.writerows(_room_rows(stats))
    return buffer.getvalue().encode("utf-8-sig")


def filename_for(plan_name: str, plan_id: int) -> str:
    safe_ascii = f"plan-{int(plan_id)}.csv"
    pretty = f"{plan_name}.csv" if plan_name else safe_ascii
    return f"attachment; filename=\"{safe_ascii}\"; filename*=UTF-8''{quote(pretty, safe='')}"
