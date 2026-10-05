from types import SimpleNamespace

import supabase_client

if not hasattr(supabase_client, "reset_supabase_client"):
    supabase_client.reset_supabase_client = lambda: None

import support_db_organizations as organizations_db


class DeleteQuery:
    def __init__(self, table_name, deleted_tables):
        self.table_name = table_name
        self.deleted_tables = deleted_tables
        self.operation = None

    def update(self, _payload):
        self.operation = "update"
        return self

    def delete(self):
        self.operation = "delete"
        return self

    def eq(self, *_args):
        return self

    def in_(self, *_args):
        return self

    def execute(self):
        if self.operation == "delete":
            self.deleted_tables.append(self.table_name)
        data = [{"id": "org-id"}] if (
            self.table_name == "organizations" and self.operation == "delete"
        ) else []
        return SimpleNamespace(data=data)


class DeleteClient:
    def __init__(self):
        self.deleted_tables = []

    def table(self, table_name):
        return DeleteQuery(table_name, self.deleted_tables)


def test_visit_dependencies_are_deleted_before_client_staff(monkeypatch):
    client = DeleteClient()
    monkeypatch.setattr(
        organizations_db, "get_organization", lambda _org_id: {"name": "Example Org"}
    )
    monkeypatch.setattr(organizations_db, "get_supabase", lambda: client)
    monkeypatch.setattr(
        organizations_db, "_load_org_branch_ids_for_delete", lambda _org_id: ["branch-id"]
    )
    monkeypatch.setattr(organizations_db, "_invalidate_tenant_meta_cache", lambda _org_id: None)

    organizations_db.permanently_delete_organization(
        org_id="org-id",
        deleted_by="support-user-id",
        confirm_name="Example Org",
    )

    visits_index = client.deleted_tables.index("visits")
    plans_index = client.deleted_tables.index("visit_plans")
    staff_index = client.deleted_tables.index("client_staff")
    assert visits_index < plans_index < staff_index
