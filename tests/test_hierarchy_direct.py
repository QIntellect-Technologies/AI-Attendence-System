"""
test_hierarchy_direct.py
──────────────────────────────────────────────────────────────────────────────
Exercises support_db_hierarchy.py functions directly against your real
Supabase — no Flask server needed. Fastest way to verify the logic itself
(tenant isolation, cycle detection, UUID validation) before wiring routes.

SETUP — fill these in with real ids from your DB before running:
  ORG_ID            - a real org_id (client_staff.org_id)
  OTHER_ORG_ID       - a DIFFERENT org's id, for tenant-isolation checks
  STAFF_A, STAFF_B, STAFF_C  - three real client_staff ids in ORG_ID
  CLIENT_USER_ID     - a real client_users id in ORG_ID (for linked-account test)
  FOREIGN_STAFF_ID   - a real client_staff id that belongs to OTHER_ORG_ID

Run:  python3 test_hierarchy_direct.py
Every check prints PASS/FAIL — nothing here mutates data outside the
manager_id/linked_client_user_id columns on the three test staff rows, and
the last step clears them back to NULL.
"""
from __future__ import annotations
from core.env import load_env
load_env()
import support_db_hierarchy as h

# ─── Fill these in ─────────────────────────────────────────────────────
ORG_ID = "b50c00a6-c4e8-4e1f-af68-d3cbd767e297"
OTHER_ORG_ID = "320fd52f-df2a-4f6c-97de-025926f5ca45"
STAFF_A = "12edf044-8386-4605-b967-7af2f6317c2f"   # will be given a manager
STAFF_B = "6ac279fd-f2f2-4846-b715-6713a9b41b51"   # will be STAFF_A's manager
STAFF_C = "912d1f3b-5f02-4880-98e9-66a5ea113015"   # will be STAFF_B's manager (chain: A -> B -> C)
CLIENT_USER_ID = "4a0ead0a-0480-4b4c-82d8-a8a5e5edd104"
FOREIGN_STAFF_ID = "b8d540c8-d040-49a4-8d33-d3ac1989b2fe" 
# ────────────────────────────────────────────────────────────────────────

passed, failed = 0, 0


def check(label, condition):
    global passed, failed
    if condition:
        print(f"PASS  {label}")
        passed += 1
    else:
        print(f"FAIL  {label}")
        failed += 1


def expect_value_error(label, fn):
    global passed, failed
    try:
        fn()
        print(f"FAIL  {label} (expected ValueError, none raised)")
        failed += 1
    except ValueError as e:
        print(f"PASS  {label} ({e})")
        passed += 1


print("\n--- 1. Basic assignment ---")
result = h.assign_manager(ORG_ID, STAFF_A, STAFF_B)
check("assign_manager sets manager_id", result.get("manager_id") == STAFF_B)

print("\n--- 2. Chain read-back ---")
chain = h.get_manager_chain(ORG_ID, STAFF_A)
check("manager_chain has 1 entry", len(chain) == 1)
check("manager_chain[0] is STAFF_B", chain and chain[0]["id"] == STAFF_B)
check("manager_chain[0] has a manager_label", chain and "manager_label" in chain[0])

print("\n--- 3. Direct reports ---")
reports = h.get_direct_reports(ORG_ID, STAFF_B)
check("STAFF_B's reports include STAFF_A", any(r["id"] == STAFF_A for r in reports))

print("\n--- 4. Self-assignment rejected ---")
expect_value_error("cannot be own manager", lambda: h.assign_manager(ORG_ID, STAFF_A, STAFF_A))

print("\n--- 5. Cycle rejected ---")
h.assign_manager(ORG_ID, STAFF_B, STAFF_C)  # B -> C
expect_value_error(
    "C -> A would close the loop A->B->C->A",
    lambda: h.assign_manager(ORG_ID, STAFF_C, STAFF_A),
)

print("\n--- 6. Cross-tenant rejected ---")
expect_value_error(
    "manager_id from another org is rejected",
    lambda: h.assign_manager(ORG_ID, STAFF_A, FOREIGN_STAFF_ID),
)
expect_value_error(
    "staff_id from another org is rejected",
    lambda: h.assign_manager(OTHER_ORG_ID, STAFF_A, STAFF_B),
)

print("\n--- 7. Malformed UUID rejected ---")
expect_value_error("garbage manager_id string", lambda: h.assign_manager(ORG_ID, STAFF_A, "not-a-uuid"))

print("\n--- 8. Notification target resolution ---")
target_before = h.resolve_notification_target(ORG_ID, STAFF_A)
check("no target before linking (manager has no linked_client_user_id yet)", target_before is None)

# linked_client_user_id is set on the MANAGER's own row (STAFF_B), not on
# the report (STAFF_A) — set_linked_client_user, not assign_manager.
h.set_linked_client_user(ORG_ID, STAFF_B, CLIENT_USER_ID)
target_after = h.resolve_notification_target(ORG_ID, STAFF_A)
check("target resolves to CLIENT_USER_ID once manager is linked", target_after == CLIENT_USER_ID)

print("\n--- 9. No-manager fallback ---")
no_manager_target = h.resolve_notification_target(ORG_ID, STAFF_C)
check("staff with no manager returns None (falls back to broadcast)", no_manager_target is None)

print("\n--- 10. Cleanup ---")
h.assign_manager(ORG_ID, STAFF_A, None)
h.assign_manager(ORG_ID, STAFF_B, None)
h.set_linked_client_user(ORG_ID, STAFF_B, None)
cleared = h.get_manager_chain(ORG_ID, STAFF_A)
check("chain is empty after clearing", cleared == [])

print(f"\n{passed} passed, {failed} failed")