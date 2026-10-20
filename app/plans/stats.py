"""Server-authoritative per-room statistics.

Areas and material quantities always come from the same document that 2D, 3D
and CSV use, so the exported numbers can never drift from the editor.
"""

from __future__ import annotations

from typing import Any

from app.plans import geometry


def _index(document: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    walls_by_id = {wall["id"]: wall for wall in document.get("walls", [])}
    openings_by_wall: dict[str, list[dict[str, Any]]] = {}
    for opening in document.get("openings", []):
        openings_by_wall.setdefault(opening["wallId"], []).append(opening)
    return walls_by_id, openings_by_wall


def room_stats(document: dict[str, Any]) -> list[dict[str, Any]]:
    """Compute one stat record per room, in document order."""
    walls_by_id, openings_by_wall = _index(document)
    furniture = document.get("furniture", [])
    materials = document.get("materials", {}) or {}
    floor_materials = materials.get("floor", {}) or {}
    wall_materials = materials.get("wall", {}) or {}

    stats: list[dict[str, Any]] = []
    for room in document.get("rooms", []):
        loop_ids = room["loopKey"].split("|")
        metrics = geometry.room_metrics(walls_by_id, openings_by_wall, loop_ids)
        polygon = [tuple(point) for point in metrics["polygon"]]
        furniture_count = sum(
            1
            for piece in furniture
            if geometry.point_in_polygon((piece["x"], piece["y"]), polygon)
        )
        stats.append(
            {
                "roomId": room["id"],
                "roomName": room["name"],
                "areaM2": metrics["areaM2"],
                "perimeterM": metrics["perimeterM"],
                "wallAreaM2": metrics["wallAreaM2"],
                "furnitureCount": furniture_count,
                "floorMaterial": floor_materials.get(room["id"]),
                "wallMaterial": wall_materials.get(room["id"]),
            }
        )
    return stats


def summary(document: dict[str, Any], stats: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    rows = room_stats(document) if stats is None else stats
    return {
        "roomCount": len(rows),
        "totalAreaM2": round(sum(row["areaM2"] for row in rows), 2),
        "furnitureCount": len(document.get("furniture", [])),
    }
