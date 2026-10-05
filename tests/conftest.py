"""
conftest.py — isolates support_db_attendance_exceptions from its DB-layer
siblings (supabase_client, support_db_hierarchy, support_db_notifications)
so these are true unit tests: no real Supabase connection, no bcrypt/cv2/
torch pulled in transitively. Each test gets a fresh MagicMock for
get_supabase() via the `sb` fixture and can assert against it directly.
"""
import sys
import types
from unittest.mock import MagicMock

import pytest


def _install_stub(name: str, **attrs):
    if name in sys.modules:
        return sys.modules[name]
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    sys.modules[name] = mod
    return mod


# supabase_client.get_supabase() is called fresh inside every function under
# test, so the stub's get_supabase must always return the SAME mock object
# for a given test -- tests patch this via the `sb` fixture below.
_current_sb = MagicMock()
# support_db_core imports the reset hook even when tests only patch get_supabase.
_install_stub(
    "supabase_client",
    get_supabase=lambda: _current_sb,
    reset_supabase_client=MagicMock(),
)
_install_stub("support_db_hierarchy", resolve_notification_target=MagicMock(return_value=None))
_install_stub("support_db_notifications", create_notification=MagicMock())


@pytest.fixture
def sb():
    """Fresh Supabase mock per test. Reset instead of reassigned so the
    lambda captured in supabase_client's stub keeps returning this object."""
    _current_sb.reset_mock(return_value=True, side_effect=True)
    return _current_sb


from copy import deepcopy
from types import SimpleNamespace
import uuid


class FakeNotModifier:
    def __init__(self, query):
        self.query = query

    def is_(self, field, value):
        if value is None or str(value).lower() in ("null", "none"):
            self.query.filters.append(lambda row: row.get(field) is not None)
        else:
            self.query.filters.append(lambda row: row.get(field) != value)
        return self.query

    def eq(self, field, value):
        self.query.filters.append(lambda row: str(row.get(field)) != str(value))
        return self.query


class FakeQuery:
    def __init__(self, table):
        self.table = table
        self.operation = "select"
        self.values = {}
        self.filters = []
        self._limit = None
        self.not_ = FakeNotModifier(self)


    def select(self, *_fields):
        if self.operation != "insert":
            self.operation = "select"
        return self

    def insert(self, values):
        self.operation = "insert"
        if isinstance(values, list):
            self.values = values
        else:
            self.values = [values]
        return self

    def update(self, values):
        self.operation = "update"
        self.values = values
        return self

    def eq(self, field, value):
        self.filters.append(lambda row: str(row.get(field)) == str(value))
        return self

    def in_(self, field, values):
        val_set = {str(v) for v in values}
        self.filters.append(lambda row: str(row.get(field)) in val_set)
        return self

    def limit(self, count):
        self._limit = count
        return self

    def single(self):
        self._limit = 1
        return self

    def order(self, field, desc=False):
        return self

    def is_(self, field, value):
        if value is None or str(value).lower() in ("null", "none"):
            self.filters.append(lambda row: row.get(field) is None)
        else:
            self.filters.append(lambda row: row.get(field) == value)
        return self

    def execute(self):
        if self.operation == "insert":
            inserted = []
            for item in self.values:
                row = deepcopy(item)
                if "id" not in row or not row["id"]:
                    row["id"] = str(uuid.uuid4())
                self.table.rows.append(row)
                inserted.append(row)
            return SimpleNamespace(data=deepcopy(inserted))

        matched = [
            row for row in self.table.rows
            if all(f(row) for f in self.filters)
        ]
        if self._limit is not None:
            matched = matched[:self._limit]

        if self.operation == "update":
            self.table.update_count += 1
            for row in matched:
                row.update(self.values)
        return SimpleNamespace(data=deepcopy(matched))



class FakeTable:
    def __init__(self):
        self.rows = []
        self.update_count = 0

    def select(self, *fields):
        return FakeQuery(self).select(*fields)

    def insert(self, values):
        return FakeQuery(self).insert(values)

    def update(self, values):
        return FakeQuery(self).update(values)


class FakeSupabaseDB:
    def __init__(self):
        self.tables = {}

    def table(self, name):
        if name not in self.tables:
            self.tables[name] = FakeTable()
        return self.tables[name]


@pytest.fixture
def fake_supabase():
    return FakeSupabaseDB()



@pytest.fixture(autouse=True)
def _reset_hierarchy_notifications_mocks():
    import support_db_hierarchy as hierarchy_db
    import support_db_notifications as notifications_db
    hierarchy_db.resolve_notification_target.reset_mock(return_value=True, side_effect=True)
    hierarchy_db.resolve_notification_target.return_value = None
    notifications_db.create_notification.reset_mock(return_value=True, side_effect=True)
    yield