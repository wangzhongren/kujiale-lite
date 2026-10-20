"""Plan document schema v1: structural checks and hard limits.

The schema is part of the frozen v1 contract.  Unknown extra fields are
preserved verbatim (the contract allows additive fields) but every known
field is type- and range-checked here.  Semantic checks live in
``app.plans.validate``; this module is pure and does no I/O.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any

from app.obs.errors import AppError, validation_error

SCHEMA_VERSION = 1
UNITS = "mm"

MAX_DOC_BYTES = 2 * 1024 * 1024
MAX_WALLS = 400
MAX_OPENINGS = 400
MAX_FURNITURE = 400
MAX_ROOMS = 50
MAX_NAME_LENGTH = 80
MAX_ID_LENGTH = 64

COORD_MIN = -100000.0
COORD_MAX = 100000.0
MIN_WALL_LENGTH = 1.0
MIN_THICKNESS = 10.0
MAX_THICKNESS = 1000.0
MIN_WALL_HEIGHT = 100.0
MAX_WALL_HEIGHT = 10000.0
MIN_OPENING_SIZE = 1.0
MAX_ROTATION = 100000.0

ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$")
CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")
OPENING_TYPES = frozenset({"door", "window"})


def is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def ensure_object(value: object, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise validation_error(f"{field} 必须是对象", field)
    return value


def ensure_list(value: object, field: str) -> list[Any]:
    if not isinstance(value, list):
        raise validation_error(f"{field} 必须是数组", field)
    return value


def ensure_number(
    value: object,
    field: str,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float:
    if not is_number(value):
        raise validation_error(f"{field} 必须是有限数值", field)
    number = float(value)
    if minimum is not None and number < minimum:
        raise validation_error(f"{field} 不能小于 {minimum:g}", field)
    if maximum is not None and number > maximum:
        raise validation_error(f"{field} 不能大于 {maximum:g}", field)
    return number


def ensure_coordinate(value: object, field: str) -> float:
    return ensure_number(value, field, minimum=COORD_MIN, maximum=COORD_MAX)


def ensure_id(value: object, field: str) -> str:
    if not isinstance(value, str) or not ID_PATTERN.match(value):
        raise validation_error(
            f"{field} 必须是 1-{MAX_ID_LENGTH} 位字母、数字或 _.:- 组成的标识", field
        )
    return value


def ensure_name(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise validation_error(f"{field} 必须是字符串", field)
    if CONTROL_CHARACTERS.search(value):
        raise validation_error(f"{field} 不能包含控制字符", field)
    if not value.strip():
        raise validation_error(f"{field} 不能为空", field)
    if len(value) > MAX_NAME_LENGTH:
        raise validation_error(f"{field} 不能超过 {MAX_NAME_LENGTH} 个字符", field)
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise validation_error(f"{field} 包含非法 Unicode 字符", field) from exc
    return value


def ensure_point(value: object, field: str) -> tuple[float, float]:
    point = ensure_list(value, field)
    if len(point) != 2:
        raise validation_error(f"{field} 必须是 [x, y]", field)
    return (
        ensure_coordinate(point[0], f"{field}[0]"),
        ensure_coordinate(point[1], f"{field}[1]"),
    )


def check_unique_ids(items: list[dict[str, Any]], field: str) -> None:
    seen: set[str] = set()
    for index, item in enumerate(items):
        identifier = item["id"]
        if identifier in seen:
            raise validation_error(f"{field} 中存在重复 id：{identifier}", f"{field}[{index}].id")
        seen.add(identifier)


def check_document_shape(document: object) -> dict[str, Any]:
    """Validate the v1 document structure; raises ``AppError`` on failure."""
    doc = ensure_object(document, "doc")

    version = doc.get("schemaVersion")
    if not isinstance(version, int) or isinstance(version, bool):
        raise validation_error("schemaVersion 必须是整数", "schemaVersion")
    if version != SCHEMA_VERSION:
        # Higher versions are rejected by the migration chain with
        # UNSUPPORTED_SCHEMA_VERSION; reaching here means a lower/odd value.
        raise validation_error(f"不支持的 schemaVersion：{version}", "schemaVersion")

    if doc.get("units") != UNITS:
        raise validation_error('units 必须是 "mm"', "units")

    walls = ensure_list(doc.get("walls"), "walls")
    if not 1 <= len(walls) <= MAX_WALLS:
        raise validation_error(f"墙体数量必须在 1 到 {MAX_WALLS} 之间", "walls")
    for index, wall in enumerate(walls):
        prefix = f"walls[{index}]"
        item = ensure_object(wall, prefix)
        ensure_id(item.get("id"), f"{prefix}.id")
        a = ensure_point(item.get("a"), f"{prefix}.a")
        b = ensure_point(item.get("b"), f"{prefix}.b")
        if a == b:
            raise validation_error("墙的起点和终点不能相同", f"{prefix}.b")
        ensure_number(item.get("thickness"), f"{prefix}.thickness", minimum=MIN_THICKNESS, maximum=MAX_THICKNESS)
        ensure_number(item.get("height"), f"{prefix}.height", minimum=MIN_WALL_HEIGHT, maximum=MAX_WALL_HEIGHT)
    check_unique_ids(walls, "walls")

    openings = ensure_list(doc.get("openings"), "openings")
    if len(openings) > MAX_OPENINGS:
        raise validation_error(f"开洞数量不能超过 {MAX_OPENINGS}", "openings")
    for index, opening in enumerate(openings):
        prefix = f"openings[{index}]"
        item = ensure_object(opening, prefix)
        ensure_id(item.get("id"), f"{prefix}.id")
        ensure_id(item.get("wallId"), f"{prefix}.wallId")
        if item.get("type") not in OPENING_TYPES:
            raise validation_error('开洞 type 必须是 "door" 或 "window"', f"{prefix}.type")
        ensure_number(item.get("offset"), f"{prefix}.offset", minimum=0, maximum=COORD_MAX)
        ensure_number(item.get("width"), f"{prefix}.width", minimum=MIN_OPENING_SIZE, maximum=COORD_MAX)
        ensure_number(item.get("height"), f"{prefix}.height", minimum=MIN_OPENING_SIZE, maximum=COORD_MAX)
        sill = item.get("sill", 0)
        ensure_number(sill, f"{prefix}.sill", minimum=0, maximum=MAX_WALL_HEIGHT)
        if item["type"] == "door" and float(sill) != 0:
            raise validation_error("门的 sill 必须为 0", f"{prefix}.sill")
    check_unique_ids(openings, "openings")

    rooms = ensure_list(doc.get("rooms"), "rooms")
    if len(rooms) > MAX_ROOMS:
        raise validation_error(f"房间数量不能超过 {MAX_ROOMS}", "rooms")
    for index, room in enumerate(rooms):
        prefix = f"rooms[{index}]"
        item = ensure_object(room, prefix)
        ensure_id(item.get("id"), f"{prefix}.id")
        ensure_name(item.get("name"), f"{prefix}.name")
        loop_key = item.get("loopKey")
        if not isinstance(loop_key, str) or not loop_key:
            raise validation_error("loopKey 必须是非空字符串", f"{prefix}.loopKey")
        if len(loop_key) > 32768:
            raise validation_error("loopKey 过长", f"{prefix}.loopKey")
    check_unique_ids(rooms, "rooms")

    furniture = ensure_list(doc.get("furniture"), "furniture")
    if len(furniture) > MAX_FURNITURE:
        raise validation_error(f"家具数量不能超过 {MAX_FURNITURE}", "furniture")
    for index, piece in enumerate(furniture):
        prefix = f"furniture[{index}]"
        item = ensure_object(piece, prefix)
        ensure_id(item.get("id"), f"{prefix}.id")
        ensure_id(item.get("catalogId"), f"{prefix}.catalogId")
        ensure_coordinate(item.get("x"), f"{prefix}.x")
        ensure_coordinate(item.get("y"), f"{prefix}.y")
        rotation = item.get("rotation", 0)
        ensure_number(rotation, f"{prefix}.rotation", minimum=-MAX_ROTATION, maximum=MAX_ROTATION)
    check_unique_ids(furniture, "furniture")

    materials = doc.get("materials", {})
    materials_dict = ensure_object(materials, "materials")
    for kind in ("floor", "wall"):
        mapping = materials_dict.get(kind, {})
        if not isinstance(mapping, dict):
            raise validation_error(f"materials.{kind} 必须是对象", f"materials.{kind}")
        for room_id, material_id in mapping.items():
            if not isinstance(room_id, str) or not room_id:
                raise validation_error(f"materials.{kind} 的键必须是房间 id", f"materials.{kind}")
            if not isinstance(material_id, str) or not material_id:
                raise validation_error(f"materials.{kind}.{room_id} 必须是材质 id", f"materials.{kind}")
    return doc


def serialized_document_size(document: object) -> int:
    try:
        payload = json.dumps(document, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise AppError("VALIDATION_FAILED", "方案文档无法序列化", {"field": "doc"}) from exc
    return len(payload.encode("utf-8"))


def enforce_document_size(document: object) -> None:
    size = serialized_document_size(document)
    if size > MAX_DOC_BYTES:
        raise AppError(
            "PAYLOAD_TOO_LARGE",
            f"方案文档不能超过 {MAX_DOC_BYTES} 字节",
            {"bytes": size, "maxBytes": MAX_DOC_BYTES},
        )
