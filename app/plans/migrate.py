"""Plan document schema migration chain.

v1 is current; the chain exists so future versions can be added without
changing stored documents in place.  A document from a newer schema is
rejected with ``UNSUPPORTED_SCHEMA_VERSION`` rather than silently truncated.
"""

from __future__ import annotations

import copy
from typing import Any, Callable

from app.obs.errors import AppError, validation_error

CURRENT_SCHEMA_VERSION = 1

# target version -> function(document) -> document
MIGRATIONS: dict[int, Callable[[dict[str, Any]], dict[str, Any]]] = {}


def migrate_document(document: object) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise validation_error("方案文档必须是 JSON 对象", "doc")
    version = document.get("schemaVersion")
    if not isinstance(version, int) or isinstance(version, bool):
        raise validation_error("schemaVersion 必须是整数", "schemaVersion")
    if version > CURRENT_SCHEMA_VERSION:
        raise AppError(
            "UNSUPPORTED_SCHEMA_VERSION",
            "方案文档版本高于当前服务端支持的版本",
            {"schemaVersion": version, "supportedVersion": CURRENT_SCHEMA_VERSION},
        )
    if version < 1:
        raise validation_error(f"不支持的 schemaVersion：{version}", "schemaVersion")

    migrated = copy.deepcopy(document)
    for target in range(version + 1, CURRENT_SCHEMA_VERSION + 1):
        migration = MIGRATIONS.get(target)
        if migration is None:  # pragma: no cover - guarded by constant
            raise AppError(
                "UNSUPPORTED_SCHEMA_VERSION",
                "缺少方案文档迁移步骤",
                {"schemaVersion": target},
            )
        migrated = migration(migrated)
        migrated["schemaVersion"] = target
    return migrated
