"""
tests/conftest.py
─────────────────────────────────────────────────────────────────────────────
A fake Supabase client covering just the query surface support_db_shifts
uses: select/insert/update/delete, chained .eq()/.limit()/.order(), and
.execute() returning an object with a .data list.

In-memory and dependency-free on purpose — these tests are about the shift
invariant, and should run in CI without network or a database.
"""
from __future__ import annotations

import itertools
import sys
from pathlib import Path
from types import ModuleType

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# support_db_shifts imports supabase_client at module scope; that module
# reaches for real credentials on import, so stand in a stub before the
# import chain runs.
if "supabase_client" not in sys.modules:
    stub = ModuleType("supabase_client")
    stub.get_supabase = lambda: None          # each test patches this anyway
    sys.modules["supabase_client"] = stub


class _Result:
    def __init__(self, data):
        self.data = data


class _NotFilter:
    """Backs PostgREST's `.not_.is_("col", "null")` chain, which
    resolve_staff_shift_windows uses to skip staff with no shift or no
    person_code. Attribute-then-call, not a single method, so the fake has to
    mirror that shape."""

    def __init__(self, query):
        self._query = query

    def is_(self, column, value):
        if str(value).lower() != "null":
            raise AssertionError(f"fake supports not_.is_(col, 'null'), got {value!r}")
        self._query._not_null.append(column)
        return self._query


class _Query:
    def __init__(self, table, op, values=None):
        self._table = table
        self._op = op
        self._values = values
        self._filters: list[tuple[str, str]] = []
        self._not_null: list[str] = []
        self._limit = None

    @property
    def not_(self):
        return _NotFilter(self)

    def eq(self, column, value):
        self._filters.append((column, str(value)))
        return self

    def order(self, _column, **_kwargs):
        return self

    def limit(self, count):
        self._limit = count
        return self

    def _matches(self, row):
        if any(row.get(col) is None for col in self._not_null):
            return False
        return all(str(row.get(col)) == val for col, val in self._filters)

    def execute(self):
        if self._op == "insert":
            row = {"id": self._table.next_id(), **self._values}
            self._table.rows.append(row)
            return _Result([dict(row)])

        selected = [r for r in self._table.rows if self._matches(r)]
        if self._limit is not None:
            selected = selected[: self._limit]

        if self._op == "select":
            return _Result([dict(r) for r in selected])

        if self._op == "update":
            for row in selected:
                row.update(self._values)
            return _Result([dict(r) for r in selected])

        if self._op == "delete":
            for row in selected:
                self._table.rows.remove(row)
            return _Result([dict(r) for r in selected])

        raise AssertionError(f"unsupported op {self._op}")


class _Table:
    def __init__(self, name):
        self.name = name
        self.rows: list[dict] = []
        self._ids = itertools.count(1)

    def next_id(self):
        return f"{self.name}-{next(self._ids)}"

    def select(self, *_columns):
        return _Query(self, "select")

    def insert(self, values):
        return _Query(self, "insert", dict(values))

    def update(self, values):
        return _Query(self, "update", dict(values))

    def delete(self):
        return _Query(self, "delete")


class _FakeSupabase:
    def __init__(self):
        self._tables: dict[str, _Table] = {}

    def table(self, name):
        return self._tables.setdefault(name, _Table(name))


@pytest.fixture
def fake_supabase():
    return _FakeSupabase()
