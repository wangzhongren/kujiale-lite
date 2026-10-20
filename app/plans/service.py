"""Plan use-cases: validation, persistence, statistics and CSV export."""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from typing import Any, Callable

from app.export.csv import build_csv, filename_for
from app.obs.errors import AppError, validation_error
from app.obs.logging import get_logger
from app.plans import migrate, repository, schema, stats
from app.plans.validate import validate_document

DEFAULT_PLAN_NAME = "未命名方案"
MAX_SEARCH_LENGTH = 80
MAX_SQLITE_INTEGER = 2**63 - 1


def default_document() -> dict[str, Any]:
    """A valid starter plan: one 4000x3000 mm room (12.00 m2)."""
    return {
        "schemaVersion": 1,
        "units": "mm",
        "walls": [
            {"id": "w1", "a": [0, 0], "b": [4000, 0], "thickness": 120, "height": 2800},
            {"id": "w2", "a": [4000, 0], "b": [4000, 3000], "thickness": 120, "height": 2800},
            {"id": "w3", "a": [4000, 3000], "b": [0, 3000], "thickness": 120, "height": 2800},
            {"id": "w4", "a": [0, 3000], "b": [0, 0], "thickness": 120, "height": 2800},
        ],
        "openings": [],
        "rooms": [{"id": "r1", "name": "房间 1", "loopKey": "w1|w2|w3|w4"}],
        "furniture": [],
        "materials": {},
    }


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _dump_document(document: dict[str, Any]) -> str:
    try:
        return json.dumps(document, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise validation_error("方案文档无法序列化", "doc") from exc


class PlanService:
    def __init__(
        self,
        database,
        catalog: dict[str, Any],
        now: Callable[[], datetime] | None = None,
        logger=None,
    ) -> None:
        self.database = database
        self.catalog = catalog
        self._now = now or (lambda: datetime.now(timezone.utc))
        self.logger = logger or get_logger("plans")

    # ------------------------------------------------------------------ create
    def create(self, user_id: int, payload: object) -> dict[str, Any]:
        if payload is None:
            payload = {}
        if not isinstance(payload, dict):
            raise validation_error("请求体必须是 JSON 对象")
        name = schema.ensure_name(payload.get("name", DEFAULT_PLAN_NAME), "name")
        raw_doc = payload.get("doc")
        document = default_document() if raw_doc is None else raw_doc
        document = migrate.migrate_document(document)
        validate_document(document, self.catalog)
        document_json = _dump_document(document)
        now_iso = _iso(self._now())
        with self.database.transaction() as connection:
            row = repository.create_plan(connection, user_id, name, document_json, now_iso)
        return self.serialize_row(row)

    # --------------------------------------------------------------------- read
    def get(self, user_id: int, plan_id: int) -> dict[str, Any]:
        plan_id = self._validate_plan_id(plan_id)
        with self.database.connection() as connection:
            row = repository.get_plan(connection, user_id, plan_id)
        if row is None:
            raise AppError("NOT_FOUND", "方案不存在")
        return self.serialize_row(row)

    def list(
        self,
        user_id: int,
        page: int = 1,
        page_size: int = 20,
        query: str | None = None,
    ) -> dict[str, Any]:
        if page < 1:
            raise validation_error("page 必须大于等于 1", "page")
        if page_size < 1:
            raise validation_error("pageSize 必须大于等于 1", "pageSize")
        page_size = min(page_size, 100)
        if page_size and (page - 1) > MAX_SQLITE_INTEGER // page_size:
            raise validation_error("page 过大", "page")
        cleaned_query = None
        if isinstance(query, str):
            cleaned_query = query.strip()
            if len(cleaned_query) > MAX_SEARCH_LENGTH:
                raise validation_error(
                    f"q 不能超过 {MAX_SEARCH_LENGTH} 个字符", "q"
                )
            if not cleaned_query:
                cleaned_query = None
        offset = (page - 1) * page_size
        with self.database.connection() as connection:
            rows, total = repository.list_plans(
                connection, user_id, limit=page_size, offset=offset, query=cleaned_query
            )
        items = [self._list_item(row) for row in rows]
        total_pages = 0 if total == 0 else math.ceil(total / page_size)
        return {
            "items": items,
            "page": page,
            "pageSize": page_size,
            "total": total,
            "totalPages": total_pages,
        }

    # ------------------------------------------------------------------- update
    def update(self, user_id: int, plan_id: int, payload: object) -> dict[str, Any]:
        plan_id = self._validate_plan_id(plan_id)
        if not isinstance(payload, dict):
            raise validation_error("请求体必须是 JSON 对象")
        expected = payload.get("expectedRevision")
        if not isinstance(expected, int) or isinstance(expected, bool) or expected < 1:
            raise validation_error("expectedRevision 必须是正整数", "expectedRevision")
        if "doc" not in payload:
            raise validation_error("缺少 doc", "doc")

        with self.database.connection() as connection:
            current = repository.get_plan(connection, user_id, plan_id)
        if current is None:
            raise AppError("NOT_FOUND", "方案不存在")

        if "name" in payload:
            name = schema.ensure_name(payload.get("name"), "name")
        else:
            name = str(current["name"])
        document = migrate.migrate_document(payload["doc"])
        validate_document(document, self.catalog)
        document_json = _dump_document(document)
        now_iso = _iso(self._now())

        with self.database.transaction() as connection:
            row = repository.update_plan(
                connection,
                user_id,
                plan_id,
                name=name,
                document_json=document_json,
                expected_revision=expected,
                now_iso=now_iso,
            )
        return self.serialize_row(row)

    def delete(self, user_id: int, plan_id: int) -> None:
        plan_id = self._validate_plan_id(plan_id)
        with self.database.transaction() as connection:
            deleted = repository.delete_plan(connection, user_id, plan_id)
        if not deleted:
            raise AppError("NOT_FOUND", "方案不存在")

    # ---------------------------------------------------------------- rendering
    def serialize_row(self, row) -> dict[str, Any]:
        document = self._load_document(row)
        room_rows = self._room_stats(document, row)
        return {
            "id": int(row["id"]),
            "name": row["name"],
            "revision": int(row["revision"]),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "doc": document,
            "stats": {
                "rooms": room_rows,
                **stats.summary(document, room_rows),
            },
        }

    def share_view(self, row) -> dict[str, Any]:
        document = self._load_document(row)
        room_rows = self._room_stats(document, row)
        return {
            "name": row["name"],
            "revision": int(row["revision"]),
            "updatedAt": row["updated_at"],
            "doc": document,
            "stats": {
                "rooms": room_rows,
                **stats.summary(document, room_rows),
            },
            "readOnly": True,
        }

    def csv_payload(self, row) -> tuple[bytes, str]:
        document = self._load_document(row)
        room_rows = self._room_stats(document, row)
        return build_csv(room_rows), filename_for(str(row["name"]), int(row["id"]))

    def csv_for_owner(self, user_id: int, plan_id: int) -> tuple[bytes, str]:
        plan_id = self._validate_plan_id(plan_id)
        with self.database.connection() as connection:
            row = repository.get_plan(connection, user_id, plan_id)
        if row is None:
            raise AppError("NOT_FOUND", "方案不存在")
        return self.csv_payload(row)

    # ------------------------------------------------------------------ helpers
    def _load_document(self, row) -> dict[str, Any]:
        try:
            raw = json.loads(row["doc"])
        except (TypeError, ValueError) as exc:
            self.logger.error(
                "stored plan document is corrupt",
                extra={"event": "plan_document_corrupt", "fields": {"planId": int(row["id"])}},
            )
            raise AppError(
                "INTERNAL", "存储的方案文档损坏", {"planId": int(row["id"])}
            ) from exc
        return migrate.migrate_document(raw)

    def _room_stats(self, document: dict[str, Any], row) -> list[dict[str, Any]]:
        try:
            return stats.room_stats(document)
        except (KeyError, ValueError, TypeError) as exc:
            self.logger.error(
                "plan statistics computation failed",
                extra={"event": "plan_stats_failed", "fields": {"planId": int(row["id"])}},
            )
            raise AppError(
                "INTERNAL", "方案统计计算失败", {"planId": int(row["id"])}
            ) from exc

    def _list_item(self, row) -> dict[str, Any]:
        document = self._load_document(row)
        room_rows = self._room_stats(document, row)
        totals = stats.summary(document, room_rows)
        return {
            "id": int(row["id"]),
            "name": row["name"],
            "revision": int(row["revision"]),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "roomCount": totals["roomCount"],
            "totalAreaM2": totals["totalAreaM2"],
            "furnitureCount": totals["furnitureCount"],
        }

    @staticmethod
    def _validate_plan_id(plan_id: object) -> int:
        if not isinstance(plan_id, int) or isinstance(plan_id, bool) or plan_id < 1:
            raise AppError("NOT_FOUND", "方案不存在")
        return plan_id
