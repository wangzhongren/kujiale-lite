"""Unit tests for catalog loading, sample plan and defensive copies."""

from __future__ import annotations

import unittest

from app.catalog.loader import get_catalog, get_sample_plan, load_catalog
from app.plans.stats import room_stats
from app.plans.validate import validate_document


class CatalogTestCase(unittest.TestCase):
    def test_catalog_has_required_items(self) -> None:
        catalog = get_catalog()
        self.assertGreaterEqual(len(catalog["furniture"]), 9)
        self.assertGreaterEqual(len(catalog["materials"]), 6)
        furniture_ids = [item["id"] for item in catalog["furniture"]]
        material_ids = [item["id"] for item in catalog["materials"]]
        self.assertEqual(len(furniture_ids), len(set(furniture_ids)))
        self.assertEqual(len(material_ids), len(set(material_ids)))
        kinds = {item["kind"] for item in catalog["materials"]}
        self.assertEqual(kinds, {"floor", "wall"})
        for item in catalog["furniture"]:
            self.assertGreater(item["width"], 0)
            self.assertGreater(item["depth"], 0)
            self.assertGreater(item["height"], 0)

    def test_catalog_is_cached_but_returned_as_copy(self) -> None:
        first = get_catalog()
        first["furniture"].clear()
        second = get_catalog()
        self.assertTrue(second["furniture"])
        self.assertIs(load_catalog(), load_catalog())

    def test_sample_plan_structure(self) -> None:
        sample = get_sample_plan()
        doc = sample["doc"]
        self.assertEqual(doc["schemaVersion"], 1)
        self.assertEqual(len(doc["rooms"]), 2)
        self.assertEqual(len(doc["openings"]), 4)
        self.assertGreaterEqual(len(doc["furniture"]), 3)
        validate_document(doc, get_catalog())

    def test_sample_plan_statistics(self) -> None:
        doc = get_sample_plan()["doc"]
        stats = room_stats(doc)
        self.assertEqual([row["roomName"] for row in stats], ["客厅", "卧室"])
        self.assertEqual(stats[0]["areaM2"], 12.0)
        self.assertEqual(stats[1]["areaM2"], 9.0)
        self.assertEqual(stats[0]["furnitureCount"], 4)
        self.assertEqual(stats[1]["furnitureCount"], 3)

    def test_sample_plan_is_returned_as_copy(self) -> None:
        first = get_sample_plan()
        first["doc"]["walls"].clear()
        second = get_sample_plan()
        self.assertTrue(second["doc"]["walls"])


if __name__ == "__main__":
    unittest.main()
