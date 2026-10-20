"""Password hashing with scrypt and a documented password policy."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import unicodedata

from app.obs.errors import validation_error

SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 32
SALT_BYTES = 16

MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 128

# Small denylist of passwords that are weak regardless of length.
_WEAK_PASSWORDS = frozenset(
    {
        "password",
        "password1",
        "password12",
        "password123",
        "12345678",
        "123456789",
        "1234567890",
        "qwertyui",
        "qwerty123",
        "abc12345",
        "iloveyou",
        "admin123",
        "letmein1",
        "woaini520",
    }
)

_DUMMY_SALT = b"\x00" * SALT_BYTES


def _b64encode(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def _b64decode(value: str) -> bytes:
    return base64.b64decode(value.encode("ascii"), validate=True)


def validate_password(password: object) -> str:
    if not isinstance(password, str):
        raise validation_error("密码必须是字符串", "password")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise validation_error(
            f"密码至少需要 {MIN_PASSWORD_LENGTH} 个字符", "password", minLength=MIN_PASSWORD_LENGTH
        )
    if len(password) > MAX_PASSWORD_LENGTH:
        raise validation_error(
            f"密码不能超过 {MAX_PASSWORD_LENGTH} 个字符", "password", maxLength=MAX_PASSWORD_LENGTH
        )
    if any(unicodedata.category(ch) == "Cc" for ch in password):
        raise validation_error("密码不能包含控制字符", "password")
    if password.lower() in _WEAK_PASSWORDS:
        raise validation_error("密码过于常见，请换一个更安全的密码", "password")
    if len(set(password)) == 1:
        raise validation_error("密码不能由重复字符构成", "password")
    return password


def hash_password(password: str) -> str:
    validate_password(password)
    salt = secrets.token_bytes(SALT_BYTES)
    derived = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=SCRYPT_DKLEN,
    )
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64encode(salt)}${_b64encode(derived)}"


def _parse(stored: str) -> tuple[int, int, int, bytes, bytes] | None:
    try:
        algorithm, n_raw, r_raw, p_raw, salt_raw, hash_raw = stored.split("$")
        if algorithm != "scrypt":
            return None
        n, r, p = int(n_raw), int(r_raw), int(p_raw)
        if n < 2 or r < 1 or p < 1:
            return None
        return n, r, p, _b64decode(salt_raw), _b64decode(hash_raw)
    except (ValueError, TypeError):
        return None


def verify_password(password: str, stored: str) -> bool:
    if not isinstance(password, str) or not isinstance(stored, str):
        return False
    parsed = _parse(stored)
    if parsed is None:
        return False
    n, r, p, salt, expected = parsed
    try:
        derived = hashlib.scrypt(
            password.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=len(expected)
        )
    except (ValueError, MemoryError):
        return False
    return hmac.compare_digest(derived, expected)


def dummy_verify(password: str) -> None:
    """Spend comparable time when a username does not exist (no enumeration)."""
    try:
        hashlib.scrypt(
            password.encode("utf-8"),
            salt=_DUMMY_SALT,
            n=SCRYPT_N,
            r=SCRYPT_R,
            p=SCRYPT_P,
            dklen=SCRYPT_DKLEN,
        )
    except (ValueError, MemoryError):
        pass
