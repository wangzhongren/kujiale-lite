"""Semantic validation for plan documents (references, geometry, catalog)."""

from __future__ import annotations

from typing import Any

from app.obs.errors import validation_error
from app.plans import geometry
from app.plans.schema import check_document_shape, enforce_document_size


def validate_document(document: object, catalog: dict[str, Any]) -> dict[str, Any]:
    """Validate a v1 document against the catalog; raises ``AppError``.

    ``catalog`` is the in-memory catalog (``{"furniture": [...],
    "materials": [...]}``) so this function stays pure and testable.
    """
    doc = check_document_shape(document)
    enforce_document_size(doc)

    walls_by_id: dict[str, dict[str, Any]] = {}
    endpoint_pairs: set[frozenset[tuple[float, float]]] = set()
    for wall in doc["walls"]:
        wall_id = wall["id"]
        walls_by_id[wall_id] = wall
        pair = frozenset(
            {
                geometry.point_key(wall["a"]),
                geometry.point_key(wall["b"]),
            }
        )
        if pair in endpoint_pairs:
            raise validation_error(f"墙 {wall_id} 与已有墙端点重复", "walls")
        endpoint_pairs.add(pair)
        if geometry.wall_length(wall) < 1.0:
            raise validation_error(f"墙 {wall_id} 长度过短", "walls")

    openings_by_wall: dict[str, list[dict[str, Any]]] = {}
    for index, opening in enumerate(doc["openings"]):
        prefix = f"openings[{index}]"
        wall = walls_by_id.get(opening["wallId"])
        if wall is None:
            raise validation_error(
                f"开洞引用了不存在的墙：{opening['wallId']}", f"{prefix}.wallId"
            )
        wall_length = geometry.wall_length(wall)
        offset = float(opening["offset"])
        width = float(opening["width"])
        height = float(opening["height"])
        sill = float(opening.get("sill", 0))
        wall_height = float(wall["height"])
        if offset + width > wall_length + 1e-6:
            raise validation_error(
                f"开洞超出墙长（offset+width={offset + width:g} > {wall_length:g}）",
                f"{prefix}.offset",
            )
        if height > wall_height + 1e-6:
            raise validation_error("开洞高度超过墙高", f"{prefix}.height")
        if sill + height > wall_height + 1e-6:
            raise validation_error("开洞高度加窗台高超过墙高", f"{prefix}.sill")
        openings_by_wall.setdefault(opening["wallId"], []).append(opening)

    for wall_id, wall_openings in openings_by_wall.items():
        if geometry.opening_overlaps(wall_openings):
            raise validation_error(f"墙 {wall_id} 上的开洞相互重叠", "openings")

    room_ids: set[str] = set()
    loop_keys: set[str] = set()
    for index, room in enumerate(doc["rooms"]):
        prefix = f"rooms[{index}]"
        room_ids.add(room["id"])
        loop_key = room["loopKey"]
        loop_ids = loop_key.split("|")
        if any(not part for part in loop_ids):
            raise validation_error("loopKey 格式不合法", f"{prefix}.loopKey")
        canonical = "|".join(sorted(loop_ids))
        if loop_key != canonical:
            raise validation_error(
                "loopKey 必须是墙 id 排序后用 | 拼接的规范形式", f"{prefix}.loopKey"
            )
        if loop_key in loop_keys:
            raise validation_error("存在重复的房间边界（loopKey）", f"{prefix}.loopKey")
        loop_keys.add(loop_key)
        try:
            geometry.room_metrics(walls_by_id, openings_by_wall, loop_ids)
        except ValueError as exc:
            raise validation_error(f"房间边界不合法：{exc}", f"{prefix}.loopKey") from exc

    furniture_ids = {item["id"] for item in catalog.get("furniture", []) if "id" in item}
    for index, piece in enumerate(doc["furniture"]):
        catalog_id = piece["catalogId"]
        if catalog_id not in furniture_ids:
            raise validation_error(
                f"未知的家具目录项：{catalog_id}", f"furniture[{index}].catalogId"
            )

    materials = catalog.get("materials", [])
    materials_by_id = {item["id"]: item for item in materials if "id" in item}
    for kind in ("floor", "wall"):
        mapping = doc.get("materials", {}).get(kind, {})
        for room_id, material_id in mapping.items():
            if room_id not in room_ids:
                raise validation_error(
                    f"材质引用了不存在的房间：{room_id}", f"materials.{kind}"
                )
            material = materials_by_id.get(material_id)
            if material is None:
                raise validation_error(
                    f"未知的材质：{material_id}", f"materials.{kind}.{room_id}"
                )
            if material.get("kind") != kind:
                raise validation_error(
                    f"材质 {material_id} 不适用于 {kind}", f"materials.{kind}.{room_id}"
                )

    return doc
