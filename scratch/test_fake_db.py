from copy import deepcopy
from types import SimpleNamespace
import uuid

class FakeQuery:
    def __init__(self, table):
        self.table = table
        self.operation = "select"
        self.values = {}
        self.filters = []

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

print("FakeSupabaseDB helper test ready")
