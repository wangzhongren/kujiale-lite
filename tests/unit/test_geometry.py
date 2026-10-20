"""Unit tests for the pure geometry layer."""

from __future__ import annotations

import unittest

from app.plans import geometry


def wall(wall_id, a, b, height=2800, thickness=120):
    return {"id": wall_id, "a": list(a), "b": list(b), "thickness": thickness, "height": height}


def rectangle_walls(width=4000, depth=3000):
    return {
        "w1": wall("w1", (0, 0), (width, 0)),
        "w2": wall("w2", (width, 0), (width, depth)),
        "w3": wall("w3", (width, depth), (0, depth)),
        "w4": wall("w4", (0, depth), (0, 0)),
    }


class GeometryTestCase(unittest.TestCase):
    def test_wall_length(self) -> None:
        self.assertEqual(geometry.wall_length(wall("w", (0, 0), (4000, 0))), 4000)
        self.assertAlmostEqual(geometry.wall_length(wall("w", (0, 0), (3000, 4000))), 5000)

    def test_rectangle_area_and_perimeter(self) -> None:
        walls = rectangle_walls()
        points = geometry.ordered_loop(walls, ["w1", "w2", "w3", "w4"])
        self.assertEqual(len(points), 4)
        self.assertEqual(geometry.polygon_area_m2(points), 12.0)
        self.assertEqual(geometry.polygon_perimeter_m(points), 14.0)

        metrics = geometry.room_metrics(walls, {}, ["w1", "w2", "w3", "w4"])
        self.assertEqual(metrics["areaM2"], 12.0)
        self.assertEqual(metrics["perimeterM"], 14.0)
        self.assertEqual(metrics["wallAreaM2"], 39.2)

    def test_loop_order_is_independent_of_input_order(self) -> None:
        walls = rectangle_walls()
        forward = geometry.ordered_loop(walls, ["w1", "w2", "w3", "w4"])
        shuffled = geometry.ordered_loop(walls, ["w3", "w1", "w4", "w2"])
        self.assertEqual(set(forward), set(shuffled))
        self.assertEqual(geometry.polygon_area_m2(shuffled), 12.0)

    def test_open_loop_is_rejected(self) -> None:
        walls = rectangle_walls()
        with self.assertRaises(ValueError):
            geometry.ordered_loop(walls, ["w1", "w2", "w3"])

    def test_missing_wall_is_rejected(self) -> None:
        walls = rectangle_walls()
        with self.assertRaises(ValueError):
            geometry.ordered_loop(walls, ["w1", "w2", "w3", "missing"])

    def test_duplicate_wall_ids_rejected(self) -> None:
        walls = rectangle_walls()
        with self.assertRaises(ValueError):
            geometry.ordered_loop(walls, ["w1", "w1", "w2", "w3", "w4"])

    def test_too_few_walls_rejected(self) -> None:
        walls = rectangle_walls()
        with self.assertRaises(ValueError):
            geometry.ordered_loop(walls, ["w1", "w2"])

    def test_spur_vertex_breaks_closed_loop(self) -> None:
        walls = rectangle_walls()
        walls["w5"] = wall("w5", (0, 0), (500, 500))
        with self.assertRaises(ValueError):
            geometry.ordered_loop(walls, ["w1", "w2", "w3", "w4", "w5"])

    def test_self_intersection_rejected(self) -> None:
        walls = {
            "w1": wall("w1", (0, 0), (1000, 1000)),
            "w2": wall("w2", (1000, 1000), (1000, 0)),
            "w3": wall("w3", (1000, 0), (0, 1000)),
            "w4": wall("w4", (0, 1000), (0, 0)),
        }
        with self.assertRaises(ValueError):
            geometry.ordered_loop(walls, ["w1", "w2", "w3", "w4"])

    def test_triangle_area(self) -> None:
        walls = {
            "w1": wall("w1", (0, 0), (3000, 0)),
            "w2": wall("w2", (3000, 0), (0, 4000)),
            "w3": wall("w3", (0, 4000), (0, 0)),
        }
        metrics = geometry.room_metrics(walls, {}, ["w1", "w2", "w3"])
        self.assertEqual(metrics["areaM2"], 6.0)

    def test_point_in_polygon(self) -> None:
        points = [(0.0, 0.0), (4000.0, 0.0), (4000.0, 3000.0), (0.0, 3000.0)]
        self.assertTrue(geometry.point_in_polygon((2000, 1500), points))
        self.assertTrue(geometry.point_in_polygon((0, 1500), points))
        self.assertTrue(geometry.point_in_polygon((4000, 3000), points))
        self.assertFalse(geometry.point_in_polygon((4001, 1500), points))
        self.assertFalse(geometry.point_in_polygon((2000, -1), points))

    def test_openings_reduce_wall_area(self) -> None:
        walls = rectangle_walls()
        openings = {
            "w3": [
                {"id": "o1", "wallId": "w3", "type": "door", "offset": 1400,
                 "width": 900, "height": 2100, "sill": 0},
                {"id": "o2", "wallId": "w3", "type": "window", "offset": 0,
                 "width": 1000, "height": 1000, "sill": 900},
            ]
        }
        metrics = geometry.room_metrics(walls, openings, ["w1", "w2", "w3", "w4"])
        self.assertAlmostEqual(
            metrics["wallAreaM2"], round(39.2 - 1.89 - 1.0, 2)
        )

    def test_opening_area(self) -> None:
        opening = {"width": 900, "height": 2100}
        self.assertAlmostEqual(geometry.opening_area_m2(opening), 1.89)

    def test_opening_overlap_detection(self) -> None:
        first = {"offset": 100, "width": 500}
        second = {"offset": 600, "width": 500}
        overlapping = {"offset": 590, "width": 100}
        self.assertFalse(geometry.opening_overlaps([first, second]))
        self.assertTrue(geometry.opening_overlaps([first, second, overlapping]))

    def test_shared_wall_between_two_rooms(self) -> None:
        walls = rectangle_walls()
        walls.update(
            {
                "w5": wall("w5", (4000, 0), (7000, 0)),
                "w6": wall("w6", (7000, 0), (7000, 3000)),
                "w7": wall("w7", (7000, 3000), (4000, 3000)),
            }
        )
        left = geometry.room_metrics(walls, {}, ["w1", "w2", "w3", "w4"])
        right = geometry.room_metrics(walls, {}, ["w2", "w5", "w6", "w7"])
        self.assertEqual(left["areaM2"], 12.0)
        self.assertEqual(right["areaM2"], 9.0)
        self.assertEqual(right["perimeterM"], 12.0)

    def test_polygon_preserves_exact_coordinates(self) -> None:
        walls = {
            "w1": wall("w1", (0.1254, 0.25), (4000.5678, 0.25)),
            "w2": wall("w2", (4000.5678, 0.25), (4000.5678, 3000.75)),
            "w3": wall("w3", (4000.5678, 3000.75), (0.1254, 3000.75)),
            "w4": wall("w4", (0.1254, 3000.75), (0.1254, 0.25)),
        }
        points = geometry.ordered_loop(walls, ["w1", "w2", "w3", "w4"])
        self.assertIn((4000.5678, 0.25), points)
        self.assertIn((0.1254, 3000.75), points)
        self.assertAlmostEqual(geometry.polygon_area_m2(points), 12.0033, places=4)

    def test_zero_area_rejected(self) -> None:
        walls = {
            "w1": wall("w1", (0, 0), (1000, 0)),
            "w2": wall("w2", (1000, 0), (0, 0)),
            "w3": wall("w3", (0, 0), (1000, 0)),
        }
        with self.assertRaises(ValueError):
            geometry.ordered_loop(walls, ["w1", "w2", "w3"])


if __name__ == "__main__":
    unittest.main()
