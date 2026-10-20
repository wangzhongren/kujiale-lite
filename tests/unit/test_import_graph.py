"""Static import-graph regression gate: acyclic and layered.

This test parses the real ``app/`` sources with :mod:`ast` (no imports that
could hide cycles) and asserts the dependency direction required by the
proposal: http -> services -> repository -> db, with pure modules at the
bottom and observability/config as leaves.
"""

from __future__ import annotations

import ast
import unittest
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[2] / "app"

LAYER_HTTP = {"app.http", "app.server", "app.__main__"}
PURE_MODULES = {
    "app.plans.geometry",
    "app.plans.schema",
    "app.plans.validate",
    "app.plans.migrate",
    "app.export.csv",
}
FORBIDDEN_FOR_PURE = {
    "app.db",
    "app.http",
    "app.server",
    "app.plans.repository",
    "app.plans.service",
}
DB_MODULES = {"app.db", "app.db.connection", "app.db.migrations"}
OBS_MODULES = {"app.obs", "app.obs.errors", "app.obs.logging"}


def _module_name(path: Path) -> str:
    relative = path.relative_to(APP_ROOT.parent).with_suffix("")
    parts = list(relative.parts)
    if parts and parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def _collect_modules() -> dict[str, tuple[Path, ast.Module]]:
    modules: dict[str, tuple[Path, ast.Module]] = {}
    for path in sorted(APP_ROOT.rglob("*.py")):
        source = path.read_text(encoding="utf-8")
        modules[_module_name(path)] = (path, ast.parse(source, filename=str(path)))
    return modules


def _collect_imports(tree: ast.Module) -> tuple[set[str], bool]:
    names: set[str] = set()
    uses_relative = False
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                uses_relative = True
                continue
            base = node.module or ""
            names.add(base)
            for alias in node.names:
                names.add(f"{base}.{alias.name}" if base else alias.name)
    return names, uses_relative


def _resolve(name: str, known: set[str]) -> str | None:
    parts = name.split(".")
    for index in range(len(parts), 0, -1):
        candidate = ".".join(parts[:index])
        if candidate in known:
            return candidate
    return None


class ImportGraphTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.modules = _collect_modules()
        cls.known = set(cls.modules)
        cls.edges: set[tuple[str, str]] = set()
        cls.raw_imports: dict[str, set[str]] = {}
        cls.relative_imports: list[str] = []
        for module, (_path, tree) in cls.modules.items():
            names, uses_relative = _collect_imports(tree)
            cls.raw_imports[module] = names
            if uses_relative:
                cls.relative_imports.append(module)
            for name in names:
                if not name.startswith("app"):
                    continue
                resolved = _resolve(name, cls.known)
                if resolved and resolved != module:
                    cls.edges.add((module, resolved))

    def test_expected_modules_exist(self) -> None:
        for module in (
            "app.server",
            "app.http.api",
            "app.http.middleware",
            "app.http.request",
            "app.http.response",
            "app.http.router",
            "app.http.static",
            "app.auth.passwords",
            "app.auth.sessions",
            "app.auth.csrf",
            "app.auth.ratelimit",
            "app.plans.geometry",
            "app.plans.schema",
            "app.plans.validate",
            "app.plans.stats",
            "app.plans.repository",
            "app.plans.service",
            "app.plans.migrate",
            "app.share.service",
            "app.export.csv",
            "app.catalog.loader",
            "app.db.connection",
            "app.db.migrations",
            "app.obs.logging",
            "app.obs.errors",
        ):
            self.assertIn(module, self.known)

    def test_no_relative_imports(self) -> None:
        self.assertEqual(self.relative_imports, [])

    def test_graph_is_acyclic(self) -> None:
        graph: dict[str, set[str]] = {}
        for module, dependency in self.edges:
            graph.setdefault(module, set()).add(dependency)
        state: dict[str, int] = {}
        path: list[str] = []

        def visit(node: str) -> None:
            marker = state.get(node, 0)
            if marker == 1:
                cycle = path[path.index(node):] + [node]
                self.fail("import cycle: " + " -> ".join(cycle))
            if marker == 2:
                return
            state[node] = 1
            path.append(node)
            for dependency in sorted(graph.get(node, ())):
                visit(dependency)
            path.pop()
            state[node] = 2

        for module in sorted(self.known):
            visit(module)

    def test_only_http_layer_imports_transport(self) -> None:
        for module, dependency in self.edges:
            if dependency == "app.server" or dependency.startswith("app.http"):
                self.assertIn(
                    module,
                    LAYER_HTTP | {m for m in self.known if m.startswith("app.http")},
                    f"{module} must not import transport module {dependency}",
                )

    def test_pure_modules_stay_pure(self) -> None:
        for module in PURE_MODULES:
            self.assertIn(module, self.known)
            for dependency in {d for m, d in self.edges if m == module}:
                for forbidden in FORBIDDEN_FOR_PURE:
                    self.assertFalse(
                        dependency == forbidden or dependency.startswith(forbidden + "."),
                        f"{module} imports forbidden {dependency}",
                    )
            self.assertNotIn("sqlite3", self.raw_imports[module])
            self.assertNotIn("app.db", self.raw_imports[module])

    def test_db_is_a_leaf(self) -> None:
        for module in DB_MODULES:
            app_dependencies = {d for m, d in self.edges if m == module}
            self.assertEqual(app_dependencies, set(), f"{module} depends on {app_dependencies}")

    def test_observability_is_a_leaf(self) -> None:
        for module in OBS_MODULES:
            app_dependencies = {d for m, d in self.edges if m == module}
            self.assertEqual(app_dependencies, set(), f"{module} depends on {app_dependencies}")

    def test_geometry_and_csv_are_io_free(self) -> None:
        for module in ("app.plans.geometry", "app.export.csv"):
            for forbidden in ("sqlite3", "http", "app.db", "app.http", "app.server"):
                self.assertNotIn(
                    forbidden,
                    self.raw_imports[module],
                    f"{module} must not import {forbidden}",
                )

    def test_service_layer_does_not_import_http(self) -> None:
        service_modules = {
            module
            for module in self.known
            if module.startswith(("app.plans", "app.auth", "app.share", "app.export", "app.catalog"))
        }
        for module in service_modules:
            for dependency in {d for m, d in self.edges if m == module}:
                self.assertFalse(
                    dependency == "app.http" or dependency.startswith("app.http."),
                    f"{module} imports {dependency}",
                )
                self.assertNotEqual(dependency, "app.server")

    def test_repository_layer_does_not_import_services(self) -> None:
        repository = "app.plans.repository"
        dependencies = {d for m, d in self.edges if m == repository}
        self.assertFalse(
            any(d in {"app.plans.service", "app.share.service"} for d in dependencies)
        )


if __name__ == "__main__":
    unittest.main()
