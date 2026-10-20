"""Unit tests for plan schema limits and semantic validation."""

from __future__ import annotations

import copy
import unittest

from app.catalog.loader import get_catalog
from app.obs.errors import AppError
from app.plans import migrate
from app.plans.service import default_document
from app.plans.validate import validate_document


class ValidationTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = get_catalog()

    def setUp(self) -> None:
        self.doc = default_document()

    def assert_code(self, expected: str, document, catalog=None) -> AppError:
        with self.assertRaises(AppError) as caught:
            validate_document(document, catalog or self.catalog)
        self.assertEqual(caught.exception.code, expected)
        return caught.exception

    def test_default_document_is_valid(self) -> None:
        result = validate_document(self.doc, self.catalog)
        self.assertEqual(result["schemaVersion"], 1)

    def test_sample_plan_is_valid(self) -> None:
        from app.catalog.loader import get_sample_plan

        sample = get_sample_plan()
        validate_document(sample["doc"], self.catalog)

    def test_unknown_extra_fields_are_preserved(self) -> None:
        self.doc["camera"] = {"x": 1, "y": 2}
        result = validate_document(self.doc, self.catalog)
        self.assertEqual(result["camera"], {"x": 1, "y": 2})

    def test_missing_or_wrong_schema_version(self) -> None:
        for version in (None, "1", 1.0, True, 0):
            with self.subTest(version=version):
                document = copy.deepcopy(self.doc)
                if version is None:
                    document.pop("schemaVersion")
                else:
                    document["schemaVersion"] = version
                self.assert_code("VALIDATION_FAILED", document)

    def test_higher_schema_version_rejected(self) -> None:
        with self.assertRaises(AppError) as caught:
            migrate.migrate_document({**self.doc, "schemaVersion": 2})
        self.assertEqual(caught.exception.code, "UNSUPPORTED_SCHEMA_VERSION")
        self.assertEqual(caught.exception.details["schemaVersion"], 2)

    def test_units_must_be_mm(self) -> None:
        self.doc["units"] = "cm"
        self.assert_code("VALIDATION_FAILED", self.doc)

    def test_wall_count_limits(self) -> None:
        empty = copy.deepcopy(self.doc)
        empty["walls"] = []
        empty["rooms"] = []
        self.assert_code("VALIDATION_FAILED", empty)

        too_many = copy.deepcopy(self.doc)
        too_many["walls"] = [
            {
                "id": f"w{i}",
                "a": [i * 100, 0],
                "b": [i * 100 + 50, 100],
                "thickness": 120,
                "height": 2800,
            }
            for i in range(401)
        ]
        too_many["rooms"] = []
        too_many["openings"] = []
        self.assert_code("VALIDATION_FAILED", too_many)

    def test_four_hundred_walls_are_accepted(self) -> None:
        document = copy.deepcopy(self.doc)
        document["walls"] = [
            {
                "id": f"w{i}",
                "a": [i * 100, 0],
                "b": [i * 100 + 50, 100],
                "thickness": 120,
                "height": 2800,
            }
            for i in range(400)
        ]
        document["rooms"] = []
        validate_document(document, self.catalog)

    def test_duplicate_wall_ids(self) -> None:
        self.doc["walls"][1]["id"] = "w1"
        self.assert_code("VALIDATION_FAILED", self.doc)

    def test_duplicate_endpoint_pair(self) -> None:
        self.doc["walls"].append(
            {"id": "w9", "a": [0, 0], "b": [4000, 0], "thickness": 120, "height": 2800}
        )
        self.assert_code("VALIDATION_FAILED", self.doc)

    def test_coordinate_bounds(self) -> None:
        for coordinate in (-100001, 100001):
            with self.subTest(coordinate=coordinate):
                document = copy.deepcopy(self.doc)
                document["walls"][0]["a"] = [coordinate, 0]
                self.assert_code("VALIDATION_FAILED", document)
        document = copy.deepcopy(self.doc)
        document["walls"][0]["a"] = [True, 0]
        self.assert_code("VALIDATION_FAILED", document)
        document = copy.deepcopy(self.doc)
        document["walls"][0]["height"] = float("nan")
        self.assert_code("VALIDATION_FAILED", document)

    def test_wall_thickness_and_height_bounds(self) -> None:
        document = copy.deepcopy(self.doc)
        document["walls"][0]["thickness"] = 1
        self.assert_code("VALIDATION_FAILED", document)

        document = copy.deepcopy(self.doc)
        document["walls"][0]["height"] = 99999
        self.assert_code("VALIDATION_FAILED", document)

    def test_room_name_length(self) -> None:
        self.doc["rooms"][0]["name"] = "房" * 81
        self.assert_code("VALIDATION_FAILED", self.doc)

    def test_room_name_control_characters(self) -> None:
        self.doc["rooms"][0]["name"] = "客\x00厅"
        self.assert_code("VALIDATION_FAILED", self.doc)

    def test_room_loop_must_be_canonical(self) -> None:
        self.doc["rooms"][0]["loopKey"] = "w4|w3|w2|w1"
        self.assert_code("VALIDATION_FAILED", self.doc)

    def test_room_loop_must_close(self) -> None:
        self.doc["rooms"][0]["loopKey"] = "w1|w2|w3"
        self.assert_code("VALIDATION_FAILED", self.doc)

    def test_room_loop_must_reference_known_walls(self) -> None:
        self.doc["rooms"][0]["loopKey"] = "w1|w2|w3|w9"
        self.assert_code("VALIDATION_FAILED", self.doc)

    def test_duplicate_room_boundary(self) -> None:
        self.doc["rooms"].append(
            {"id": "r2", "name": "另一个", "loopKey": "w1|w2|w3|w4"}
        )
        self.assert_code("VALIDATION_FAILED", self.doc)

    def test_room_count_limit(self) -> None:
        document = copy.deepcopy(self.doc)
        document["rooms"] = [
            {"id": f"r{i}", "name": f"房间{i}", "loopKey": "w1|w2|w3|w4"}
            for i in range(51)
        ]
        self.assert_code("VALIDATION_FAILED", document)

    def _with_opening(self, **overrides):
        document = copy.deepcopy(self.doc)
        opening = {
            "id": "o1",
            "wallId": "w1",
            "type": "window",
            "offset": 500,
            "width": 900,
            "height": 1400,
            "sill": 900,
        }
        opening.update(overrides)
        document["openings"] = [opening]
        return document

    def test_valid_opening(self) -> None:
        validate_document(self._with_opening(), self.catalog)

    def test_opening_beyond_wall(self) -> None:
        self.assert_code("VALIDATION_FAILED", self._with_opening(offset=3900, width=900))

    def test_opening_unknown_wall(self) -> None:
        self.assert_code("VALIDATION_FAILED", self._with_opening(wallId="w9"))

    def test_opening_height_over_wall(self) -> None:
        self.assert_code("VALIDATION_FAILED", self._with_opening(height=3000, sill=0))

    def test_door_sill_must_be_zero(self) -> None:
        self.assert_code("VALIDATION_FAILED", self._with_opening(type="door", sill=100))

    def test_opening_overlap(self) -> None:
        document = self._with_opening(offset=100, width=500)
        document["openings"].append(
            {
                "id": "o2",
                "wallId": "w1",
                "type": "window",
                "offset": 500,
                "width": 500,
                "height": 1000,
                "sill": 900,
            }
        )
        self.assert_code("VALIDATION_FAILED", document)

    def test_opening_count_limit(self) -> None:
        document = copy.deepcopy(self.doc)
        document["openings"] = [
            {
                "id": f"o{i}",
                "wallId": "w1",
                "type": "window",
                "offset": 0,
                "width": 1,
                "height": 1,
                "sill": 0,
            }
            for i in range(401)
        ]
        self.assert_code("VALIDATION_FAILED", document)

    def test_furniture_validation(self) -> None:
        document = copy.deepcopy(self.doc)
        document["furniture"] = [
            {"id": "f1", "catalogId": "sofa-2", "x": 1000, "y": 1000, "rotation": 0}
        ]
        validate_document(document, self.catalog)

        unknown = copy.deepcopy(document)
        unknown["furniture"][0]["catalogId"] = "nope"
        self.assert_code("VALIDATION_FAILED", unknown)

        outside = copy.deepcopy(document)
        outside["furniture"][0]["x"] = 200000
        self.assert_code("VALIDATION_FAILED", outside)

        too_many = copy.deepcopy(self.doc)
        too_many["furniture"] = [
            {"id": f"f{i}", "catalogId": "sofa-2", "x": 0, "y": 0, "rotation": 0}
            for i in range(401)
        ]
        self.assert_code("VALIDATION_FAILED", too_many)

    def test_material_references(self) -> None:
        document = copy.deepcopy(self.doc)
        document["materials"] = {
            "floor": {"r1": "floor-oak"},
            "wall": {"r1": "paint-warm-white"},
        }
        validate_document(document, self.catalog)

        unknown_material = copy.deepcopy(document)
        unknown_material["materials"]["floor"]["r1"] = "missing-floor"
        self.assert_code("VALIDATION_FAILED", unknown_material)

        wrong_kind = copy.deepcopy(document)
        wrong_kind["materials"]["floor"]["r1"] = "paint-warm-white"
        self.assert_code("VALIDATION_FAILED", wrong_kind)

        unknown_room = copy.deepcopy(document)
        unknown_room["materials"]["floor"]["r9"] = "floor-oak"
        self.assert_code("VALIDATION_FAILED", unknown_room)

    def test_document_size_limit(self) -> None:
        document = copy.deepcopy(self.doc)
        document["blob"] = "x" * (2 * 1024 * 1024)
        self.assert_code("PAYLOAD_TOO_LARGE", document)

    def test_bad_catalog_id_reference_is_rejected(self) -> None:
        document = copy.deepcopy(self.doc)
        document["furniture"] = [
            {"id": "f1", "catalogId": "bad id with spaces", "x": 0, "y": 0}
        ]
        self.assert_code("VALIDATION_FAILED", document)


if __name__ == "__main__":
    unittest.main()
