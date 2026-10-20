"""Unit tests for the document migration chain."""

from __future__ import annotations

import unittest

from app.obs.errors import AppError
from app.plans import migrate
from app.plans.service import default_document


class MigrateTestCase(unittest.TestCase):
    def test_current_version(self) -> None:
        self.assertEqual(migrate.CURRENT_SCHEMA_VERSION, 1)

    def test_v1_document_is_returned_as_deep_copy(self) -> None:
        original = default_document()
        result = migrate.migrate_document(original)
        self.assertEqual(result, original)
        self.assertIsNot(result, original)
        result["walls"].clear()
        self.assertTrue(original["walls"])

    def test_higher_version_is_rejected(self) -> None:
        for version in (2, 99):
            with self.subTest(version=version):
                with self.assertRaises(AppError) as caught:
                    migrate.migrate_document({**default_document(), "schemaVersion": version})
                self.assertEqual(caught.exception.code, "UNSUPPORTED_SCHEMA_VERSION")
                self.assertEqual(caught.exception.details["supportedVersion"], 1)

    def test_invalid_versions_are_validation_errors(self) -> None:
        cases = [None, "1", 1.0, True, 0, -3]
        for version in cases:
            with self.subTest(version=version):
                document = default_document()
                if version is None:
                    document.pop("schemaVersion")
                else:
                    document["schemaVersion"] = version
                with self.assertRaises(AppError) as caught:
                    migrate.migrate_document(document)
                self.assertEqual(caught.exception.code, "VALIDATION_FAILED")

    def test_non_object_document_rejected(self) -> None:
        for value in ([], "doc", 3, None):
            with self.subTest(value=value):
                with self.assertRaises(AppError) as caught:
                    migrate.migrate_document(value)
                self.assertEqual(caught.exception.code, "VALIDATION_FAILED")

    def test_no_registered_migrations_for_current_version(self) -> None:
        self.assertNotIn(1, migrate.MIGRATIONS)
        self.assertEqual(migrate.MIGRATIONS, {})


if __name__ == "__main__":
    unittest.main()
