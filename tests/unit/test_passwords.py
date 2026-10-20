"""Unit tests for scrypt password hashing and the password policy."""

from __future__ import annotations

import unittest

from app.auth.passwords import (
    dummy_verify,
    hash_password,
    validate_password,
    verify_password,
)
from app.obs.errors import AppError

VALID = "correct-horse-9"


class PasswordTestCase(unittest.TestCase):
    def test_hash_format_and_verification(self) -> None:
        stored = hash_password(VALID)
        parts = stored.split("$")
        self.assertEqual(len(parts), 6)
        self.assertEqual(parts[0], "scrypt")
        self.assertEqual(parts[1], "16384")
        self.assertEqual(parts[2], "8")
        self.assertEqual(parts[3], "1")
        self.assertTrue(verify_password(VALID, stored))
        self.assertFalse(verify_password("wrong-password-1", stored))

    def test_salts_are_unique(self) -> None:
        first = hash_password(VALID)
        second = hash_password(VALID)
        self.assertNotEqual(first, second)
        self.assertTrue(verify_password(VALID, first))
        self.assertTrue(verify_password(VALID, second))

    def test_malformed_hashes_are_rejected(self) -> None:
        for stored in (
            "",
            "plaintext",
            "bcrypt$1$2$3$abc$def",
            "scrypt$0$8$1$abc$def",
            "scrypt$16384$8$1$not-base64$also-not",
            "scrypt$16384$8$1$YWJj$YWJj$extra",
            None,
            123,
        ):
            with self.subTest(stored=stored):
                self.assertFalse(verify_password(VALID, stored))

    def test_password_policy(self) -> None:
        for value in ("short", "a" * 129, "password123", "aaaaaaaaaa", "abc\x00defgh"):
            with self.subTest(value=value):
                with self.assertRaises(AppError) as caught:
                    validate_password(value)
                self.assertEqual(caught.exception.code, "VALIDATION_FAILED")

        for value in ("correct-horse-9", "安全密码12345", "S3cure!Pass"):
            with self.subTest(value=value):
                self.assertEqual(validate_password(value), value)

    def test_non_string_password(self) -> None:
        for value in (None, 12345678, [1, 2, 3]):
            with self.subTest(value=value):
                with self.assertRaises(AppError):
                    validate_password(value)

    def test_hash_password_enforces_policy(self) -> None:
        with self.assertRaises(AppError):
            hash_password("short")

    def test_dummy_verify_does_not_raise(self) -> None:
        dummy_verify("anything-at-all")


if __name__ == "__main__":
    unittest.main()
