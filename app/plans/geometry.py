"""Pure computational geometry for plan documents.

Coordinates are millimetres.  Areas are reported in square metres and rounded
to two decimals (the contract's canonical example 4000x3000 mm -> 12.00 m2).
No database, HTTP or filesystem access happens here.
"""

from __future__ import annotations

import math
from typing import Any, Iterable, Sequence

Point = tuple[float, float]


def point_key(point: Sequence[float], ndigits: int = 6) -> Point:
    return (round(float(point[0]), ndigits), round(float(point[1]), ndigits))


def _exact_point(point: Sequence[float]) -> Point:
    """Preserve the stored coordinate while topology uses the rounded key."""
    return (float(point[0]), float(point[1]))


def wall_length(wall: dict[str, Any]) -> float:
    ax, ay = float(wall["a"][0]), float(wall["a"][1])
    bx, by = float(wall["b"][0]), float(wall["b"][1])
    return math.hypot(bx - ax, by - ay)


def ordered_loop(walls_by_id: dict[str, dict[str, Any]], loop_ids: Sequence[str]) -> list[Point]:
    """Return the closed polygon vertices for a room's walls.

    Raises ``ValueError`` when the walls are missing, duplicated, not a single
    end-to-end cycle, degenerate, or self-intersecting.
    """
    ids = list(loop_ids)
    if len(ids) < 3:
        raise ValueError("房间至少需要 3 面墙")
    if len(set(ids)) != len(ids):
        raise ValueError("房间的墙列表包含重复墙")
    if len(ids) > 400:
        raise ValueError("房间墙数量超出上限")

    adjacency: dict[Point, list[tuple[str, Point]]] = {}
    for wall_id in ids:
        wall = walls_by_id.get(wall_id)
        if wall is None:
            raise ValueError(f"房间引用了不存在的墙：{wall_id}")
        a = point_key(wall["a"])
        b = point_key(wall["b"])
        if a == b:
            raise ValueError(f"墙 {wall_id} 长度为零")
        adjacency.setdefault(a, []).append((wall_id, b))
        adjacency.setdefault(b, []).append((wall_id, a))

    for links in adjacency.values():
        if len(links) != 2:
            raise ValueError("房间的墙未首尾相接，无法闭合")

    start_wall_id = ids[0]
    start_wall = walls_by_id[start_wall_id]
    start_key = point_key(start_wall["a"])
    start_point = _exact_point(start_wall["a"])
    points: list[Point] = []
    used: set[str] = set()
    current_wall_id = start_wall_id
    current_key = start_key
    current_point = start_point

    while True:
        if current_wall_id in used:
            raise ValueError("房间的墙列表不构成单一闭环")
        used.add(current_wall_id)
        wall = walls_by_id[current_wall_id]
        a = point_key(wall["a"])
        b = point_key(wall["b"])
        if a == current_key:
            other_key = b
            other_point = _exact_point(wall["b"])
        elif b == current_key:
            other_key = a
            other_point = _exact_point(wall["a"])
        else:
            raise ValueError("房间的墙未首尾相接")
        points.append(current_point)
        current_key = other_key
        current_point = other_point
        if current_key == start_key:
            break
        candidates = [link for link in adjacency[current_key] if link[0] != current_wall_id]
        if len(candidates) != 1:
            raise ValueError("房间的墙未首尾相接，无法闭合")
        current_wall_id = candidates[0][0]

    if len(used) != len(ids):
        raise ValueError("房间的墙列表不构成单一闭环")
    if len(points) < 3:
        raise ValueError("房间多边形顶点不足")
    if abs(signed_area(points)) < 1.0:  # 1 mm2
        raise ValueError("房间面积为零")
    if _self_intersects(points):
        raise ValueError("房间边界自相交")
    return points


def signed_area(points: Sequence[Point]) -> float:
    total = 0.0
    count = len(points)
    for index in range(count):
        x1, y1 = points[index]
        x2, y2 = points[(index + 1) % count]
        total += x1 * y2 - x2 * y1
    return total / 2.0


def polygon_area_m2(points: Sequence[Point]) -> float:
    return abs(signed_area(points)) / 1_000_000.0


def polygon_perimeter_m(points: Sequence[Point]) -> float:
    total = 0.0
    count = len(points)
    for index in range(count):
        x1, y1 = points[index]
        x2, y2 = points[(index + 1) % count]
        total += math.hypot(x2 - x1, y2 - y1)
    return total / 1000.0


def opening_area_m2(opening: dict[str, Any]) -> float:
    return float(opening["width"]) * float(opening["height"]) / 1_000_000.0


def point_in_polygon(point: Sequence[float], points: Sequence[Point]) -> bool:
    """Boundary-inclusive ray casting test."""
    px, py = float(point[0]), float(point[1])
    count = len(points)
    for index in range(count):
        a = points[index]
        b = points[(index + 1) % count]
        if _point_on_segment((px, py), a, b):
            return True
    inside = False
    for index in range(count):
        x1, y1 = points[index]
        x2, y2 = points[(index + 1) % count]
        if (y1 > py) != (y2 > py):
            intersection_x = (x2 - x1) * (py - y1) / (y2 - y1) + x1
            if px < intersection_x:
                inside = not inside
    return inside


def room_metrics(
    walls_by_id: dict[str, dict[str, Any]],
    openings_by_wall: dict[str, list[dict[str, Any]]],
    loop_ids: Sequence[str],
) -> dict[str, Any]:
    polygon = ordered_loop(walls_by_id, loop_ids)
    area = polygon_area_m2(polygon)
    perimeter = polygon_perimeter_m(polygon)

    wall_area = 0.0
    for wall_id in set(loop_ids):
        wall = walls_by_id[wall_id]
        length_m = wall_length(wall) / 1000.0
        height_m = float(wall["height"]) / 1000.0
        opening_area = sum(opening_area_m2(opening) for opening in openings_by_wall.get(wall_id, []))
        wall_area += max(0.0, length_m * height_m - opening_area)

    return {
        "polygon": [list(point) for point in polygon],
        "areaM2": round(area, 2),
        "perimeterM": round(perimeter, 3),
        "wallAreaM2": round(wall_area, 2),
    }


def _cross(ax: float, ay: float, bx: float, by: float, cx: float, cy: float) -> float:
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)


def _point_on_segment(point: Point, a: Point, b: Point, epsilon: float = 1e-9) -> bool:
    px, py = point
    ax, ay = a
    bx, by = b
    if abs(_cross(ax, ay, bx, by, px, py)) > epsilon:
        return False
    return (
        min(ax, bx) - epsilon <= px <= max(ax, bx) + epsilon
        and min(ay, by) - epsilon <= py <= max(ay, by) + epsilon
    )


def _segments_intersect(a: Point, b: Point, c: Point, d: Point) -> bool:
    d1 = _cross(c[0], c[1], d[0], d[1], a[0], a[1])
    d2 = _cross(c[0], c[1], d[0], d[1], b[0], b[1])
    d3 = _cross(a[0], a[1], b[0], b[1], c[0], c[1])
    d4 = _cross(a[0], a[1], b[0], b[1], d[0], d[1])
    if ((d1 > 0 > d2) or (d1 < 0 < d2)) and ((d3 > 0 > d4) or (d3 < 0 < d4)):
        return True
    if _point_on_segment(a, c, d) or _point_on_segment(b, c, d):
        return True
    if _point_on_segment(c, a, b) or _point_on_segment(d, a, b):
        return True
    return False


def _self_intersects(points: Sequence[Point]) -> bool:
    count = len(points)
    for i in range(count):
        a, b = points[i], points[(i + 1) % count]
        for j in range(i + 1, count):
            if j == i + 1 or (i == 0 and j == count - 1):
                continue
            c, d = points[j], points[(j + 1) % count]
            if _segments_intersect(a, b, c, d):
                return True
    return False


def opening_intervals(opening: dict[str, Any]) -> tuple[float, float]:
    start = float(opening["offset"])
    return start, start + float(opening["width"])


def opening_overlaps(openings: Iterable[dict[str, Any]]) -> bool:
    intervals = sorted(opening_intervals(opening) for opening in openings)
    previous_end: float | None = None
    for start, end in intervals:
        if previous_end is not None and start < previous_end - 1e-6:
            return True
        previous_end = end if previous_end is None else max(previous_end, end)
    return False
