"""Furniture / material catalog and sample plan loading.

Catalog data is the extension point: adding furniture or materials only
requires editing the JSON files, never code or schema.  Loading is fail-fast
and cached for the process lifetime.
"""

from __future__ import annotations

import copy
import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

CATALOG_DIR = Path(__file__).resolve().parent
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$")

MIN_FURNITURE = 9
MIN_MATERIALS = 6


class CatalogError(RuntimeError):
    """Catalog or sample data is missing or malformed (startup failure)."""


def _read_json(filename: str) -> dict[str, Any]:
    path = CATALOG_DIR / filename
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise CatalogError(f"cannot read catalog file {filename}: {exc}") from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raising = CatalogError(f"catalog file {filename} is not valid JSON: {exc}")
        raise raising from exc
    if not isinstance(data, dict) or not isinstance(data.get("items", data.get("doc")), (list, dict)):
        raise CatalogError(f"catalog file {filename} has an unexpected structure")
    return data


def _validate_items(items: object, filename: str) -> list[dict[str, Any]]:
    if not isinstance(items, list):
        raise CatalogError(f"{filename} must contain an items array")
    seen: set[str] = set()
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise CatalogError(f"{filename} item {index} is not an object")
        identifier = item.get("id")
        if not isinstance(identifier, str) or not ID_PATTERN.match(identifier):
            raise CatalogError(f"{filename} item {index} has an invalid id")
        if identifier in seen:
            raise CatalogError(f"{filename} contains duplicate id {identifier}")
        seen.add(identifier)
        if not isinstance(item.get("name"), str) or not item["name"].strip():
            raise CatalogError(f"{filename} item {identifier} has no name")
    return items


@lru_cache(maxsize=1)
def load_catalog() -> dict[str, Any]:
    furniture_raw = _read_json("furniture.json")
    materials_raw = _read_json("materials.json")
    furniture = _validate_items(furniture_raw.get("items"), "furniture.json")
    materials = _validate_items(materials_raw.get("items"), "materials.json")

    if len(furniture) < MIN_FURNITURE:
        raise CatalogError(f"catalog needs at least {MIN_FURNITURE} furniture items")
    if len(materials) < MIN_MATERIALS:
        raise CatalogError(f"catalog needs at least {MIN_MATERIALS} materials")
    floor_count = sum(1 for item in materials if item.get("kind") == "floor")
    wall_count = sum(1 for item in materials if item.get("kind") == "wall")
    if floor_count < 3 or wall_count < 3:
        raise CatalogError("catalog needs at least 3 floor and 3 wall materials")
    for item in materials:
        if item.get("kind") not in {"floor", "wall"}:
            raise CatalogError(f"material {item['id']} has an invalid kind")
    for item in furniture:
        for field in ("width", "depth", "height"):
            value = item.get(field)
            if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
                raise CatalogError(f"furniture {item['id']} has an invalid {field}")

    return {"furniture": furniture, "materials": materials}


def get_catalog() -> dict[str, Any]:
    """Return a defensive copy so callers cannot mutate the cached catalog."""
    return copy.deepcopy(load_catalog())


@lru_cache(maxsize=1)
def load_sample_plan() -> dict[str, Any]:
    data = _read_json("sample-plan.json")
    doc = data.get("doc")
    name = data.get("name")
    if not isinstance(doc, dict) or not isinstance(name, str) or not name.strip():
        raise CatalogError("sample-plan.json must contain name and doc")
    return {"id": data.get("id", "sample"), "name": name, "doc": doc}


def get_sample_plan() -> dict[str, Any]:
    return copy.deepcopy(load_sample_plan())
