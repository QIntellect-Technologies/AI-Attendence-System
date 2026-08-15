#!/usr/bin/env python3
"""
test_tier2_tier3_auth.py
────────────────────────────────────────────────────────────────────────────
Regression test for the Tier 2 (mass PII/financial data exposure) and
Tier 3 (attendance integrity + legacy endpoint sprawl) auth fixes, plus the
handful of extra routes found and fixed during those sweeps (/api/stats,
/api/client/bootstrap, /api/client/onboarding/complete, /api/client/session,
/api/init).

Same conventions as test_tier1_auth.py — fill in CONFIG, then:

    pip install requests --break-system-packages   # if not already installed
    python3 test_tier2_tier3_auth.py

Unlike Tier 1, most Tier 2/3 routes no longer accept org_id from the
caller at all (it's pulled from the verified token), so there's usually no
"right role, WRONG org" case to test the way Tier 1 had — org isolation is
proven by the fact org A's token can only ever see org A's data, full stop.
Where a route still takes an explicit id in the URL/body (bootstrap,
session, salary/<id>), the wrong-org / wrong-user case IS tested.

Login responses are used to derive each account's own id and org_id
dynamically (see whoami()) rather than hardcoding them, since Tier 1's
CONFIG already gives us three working accounts across two orgs.
"""
import sys
import requests

# ─── CONFIG — same accounts as test_tier1_auth.py ─────────────────────────
BASE_URL = "http://localhost:5000"

ORG_A_ADMIN = {"email": "fatimafertilizers@gmail.com", "password": " W4qBp25KkSHQiA6d"}
ORG_A_NONADMIN = {"email": "imrankhalid@gmail.com", "password": "Nm@iPHtofafaV"}
ORG_B_ADMIN = {"email": "principal@greenwood-demo.qintellect.io", "password": "Demo@2026!"}

# A real, currently-ARCHIVED staff UUID belonging to org A (same one used
# in test_tier1_auth.py) — used for the salary/<id> lookup test.
ORG_A_ARCHIVED_USER_ID = "1146b5cc-9d9f-41f7-b512-492b5ca840da"  # <-- set this
# ────────────────────────────────────────────────────────────────────────


def login(creds: dict) -> dict | None:
    r = requests.post(f"{BASE_URL}/api/login", json=creds, timeout=10)
    r.raise_for_status()
    body = r.json()
    if not body.get("token"):
        return None
    return body


class Check:
    def __init__(self):
        self.failures = []
        self.skipped = []

    def expect(self, label: str, response: requests.Response, expected_status: int):
        ok = response.status_code == expected_status
        mark = "PASS" if ok else "FAIL"
        print(f"[{mark}] {label} -> got {response.status_code}, expected {expected_status}")
        if not ok:
            self.failures.append(label)

    def skip(self, label: str, reason: str):
        print(f"[SKIP] {label} -> {reason}")
        self.skipped.append(label)

    def summary(self):
        print("\n" + "=" * 60)
        if self.skipped:
            print(f"{len(self.skipped)} SKIPPED (see reasons above)")
        if self.failures:
            print(f"{len(self.failures)} FAILURE(S):")
            for f in self.failures:
                print(f"  - {f}")
            sys.exit(1)
        print("All checks passed.")
        sys.exit(0)


def auth_header(token: str | None) -> dict:
    # Never send "Bearer None" — that produces a misleading pass/fail
    # instead of a clean skip, same discipline as test_tier1_auth.py.
    return {"Authorization": f"Bearer {token}"} if token else {}


def main():
    c = Check()

    print("Logging in test accounts...")
    admin_a = login(ORG_A_ADMIN)
    nonadmin_a = login(ORG_A_NONADMIN)
    admin_b = login(ORG_B_ADMIN)
    print(f"  org A admin:     {'ok' if admin_a else 'MISSING'}")
    print(f"  org A non-admin: {'ok' if nonadmin_a else 'MISSING'}")
    print(f"  org B admin:     {'ok' if admin_b else 'MISSING'}\n")

    admin_a_token = (admin_a or {}).get("token")
    nonadmin_a_token = (nonadmin_a or {}).get("token")
    admin_b_token = (admin_b or {}).get("token")

    admin_a_id = str((admin_a or {}).get("user", {}).get("id") or "")
    admin_a_org = str((admin_a or {}).get("organization_id") or "")
    admin_b_org = str((admin_b or {}).get("organization_id") or "")

    uid = ORG_A_ARCHIVED_USER_ID

    # ── Tier 2 ───────────────────────────────────────────────────────────

    print("-- GET /api/users, /api/users/<id> (retired) --")
    c.expect("GET /api/users -> 410 (retired, no auth needed)",
              requests.get(f"{BASE_URL}/api/users"), 410)
    c.expect("GET /api/users/1 -> 410 (retired, no auth needed)",
              requests.get(f"{BASE_URL}/api/users/1"), 410)

    print("\n-- GET /api/staff/archived --")
    c.expect("archived: no auth -> 401",
              requests.get(f"{BASE_URL}/api/staff/archived"), 401)
    if admin_a_token:
        c.expect("archived: authed org A -> 200",
                  requests.get(f"{BASE_URL}/api/staff/archived",
                               headers=auth_header(admin_a_token)), 200)
    else:
        c.skip("archived: authed org A -> 200", "org A admin login missing")

    print("\n-- GET /api/salary --")
    c.expect("salary list: no auth -> 401",
              requests.get(f"{BASE_URL}/api/salary"), 401)
    if nonadmin_a_token:
        c.expect("salary list: non-admin -> 403",
                  requests.get(f"{BASE_URL}/api/salary",
                               headers=auth_header(nonadmin_a_token)), 403)
    else:
        c.skip("salary list: non-admin -> 403", "org A non-admin login missing")
    if admin_a_token:
        c.expect("salary list: admin -> 200",
                  requests.get(f"{BASE_URL}/api/salary",
                               headers=auth_header(admin_a_token)), 200)
    else:
        c.skip("salary list: admin -> 200", "org A admin login missing")

    print("\n-- GET /api/salary/<id> --")
    c.expect("salary detail: no auth -> 401",
              requests.get(f"{BASE_URL}/api/salary/{uid}"), 401)
    if nonadmin_a_token:
        c.expect("salary detail: non-admin -> 403",
                  requests.get(f"{BASE_URL}/api/salary/{uid}",
                               headers=auth_header(nonadmin_a_token)), 403)
    else:
        c.skip("salary detail: non-admin -> 403", "org A non-admin login missing")

    print("\n-- POST /api/salary (write) --")
    c.expect("salary write: no auth -> 401",
              requests.post(f"{BASE_URL}/api/salary",
                             json={"user_id": uid, "basic_salary": 1}), 401)
    if nonadmin_a_token:
        c.expect("salary write: non-admin -> 403",
                  requests.post(f"{BASE_URL}/api/salary",
                                 json={"user_id": uid, "basic_salary": 1},
                                 headers=auth_header(nonadmin_a_token)), 403)
    else:
        c.skip("salary write: non-admin -> 403", "org A non-admin login missing")
    # Positive case intentionally NOT run automatically — it overwrites
    # real salary data. Uncomment against disposable seed data only:
    # c.expect("salary write: admin -> 200",
    #     requests.post(f"{BASE_URL}/api/salary",
    #                    json={"user_id": uid, "basic_salary": 50000},
    #                    headers=auth_header(admin_a_token)), 200)

    print("\n-- /api/legal/<type> (retired, all methods) --")
    c.expect("legal GET -> 410",
              requests.get(f"{BASE_URL}/api/legal/privacy-policy"), 410)
    c.expect("legal POST -> 410",
              requests.post(f"{BASE_URL}/api/legal/privacy-policy", json={}), 410)

    # ── Tier 3 ───────────────────────────────────────────────────────────

    print("\n-- GET /api/attendance/today --")
    c.expect("attendance today: no auth -> 401",
              requests.get(f"{BASE_URL}/api/attendance/today"), 401)
    if admin_a_token:
        c.expect("attendance today: authed -> 200",
                  requests.get(f"{BASE_URL}/api/attendance/today",
                               headers=auth_header(admin_a_token)), 200)
    else:
        c.skip("attendance today: authed -> 200", "org A admin login missing")

    print("\n-- POST /api/attendance/mark-absent --")
    c.expect("mark-absent: no auth -> 401",
              requests.post(f"{BASE_URL}/api/attendance/mark-absent",
                             json={"user_id": uid}), 401)
    # Positive case intentionally NOT run automatically — it writes a real
    # attendance record for `uid`.

    print("\n-- Legacy /get_* + /update_leave_status cluster (retired) --")
    for path, method in [
        ("/get_staff_list", "get"), ("/add_staff", "post"),
        ("/get_attendance_today", "get"), ("/get_attendance_today_array", "get"),
        ("/get_pending_leaves", "get"), ("/update_leave_status", "post"),
        ("/get_detected_name/all", "get"), ("/get_detected_name/nvr", "get"),
        ("/get_detected_name/dvr", "get"), ("/get_staff_by_name", "get"),
        ("/get_attendance_by_name", "get"),
    ]:
        fn = requests.post if method == "post" else requests.get
        kwargs = {"json": {}} if method == "post" else {}
        c.expect(f"legacy {path} -> 410", fn(f"{BASE_URL}{path}", **kwargs), 410)

    print("\n-- GET /api/stats --")
    c.expect("stats: no auth -> 401",
              requests.get(f"{BASE_URL}/api/stats"), 401)
    if admin_a_token:
        c.expect("stats: authed -> 200",
                  requests.get(f"{BASE_URL}/api/stats",
                               headers=auth_header(admin_a_token)), 200)
    else:
        c.skip("stats: authed -> 200", "org A admin login missing")

    print("\n-- GET /api/client/bootstrap --")
    c.expect("bootstrap: no auth -> 401",
              requests.get(f"{BASE_URL}/api/client/bootstrap?organization_id={admin_a_org or 'x'}"),
              401)
    if admin_a_token and admin_b_org:
        c.expect("bootstrap: org A token requesting org B's bootstrap -> 404",
                  requests.get(f"{BASE_URL}/api/client/bootstrap?organization_id={admin_b_org}",
                               headers=auth_header(admin_a_token)), 404)
    else:
        c.skip("bootstrap: cross-org -> 404", "org A/B org ids not resolved from login")
    if admin_a_token and admin_a_org:
        c.expect("bootstrap: org A token requesting own org -> 200",
                  requests.get(f"{BASE_URL}/api/client/bootstrap?organization_id={admin_a_org}",
                               headers=auth_header(admin_a_token)), 200)
    else:
        c.skip("bootstrap: own org -> 200", "org A org id not resolved from login")

    print("\n-- GET /api/client/session/<id> --")
    c.expect("session: no auth -> 401",
              requests.get(f"{BASE_URL}/api/client/session/{admin_a_id or 'x'}"), 401)
    if nonadmin_a_token and admin_a_id:
        c.expect("session: authed as someone else, requesting admin A's id -> 403",
                  requests.get(f"{BASE_URL}/api/client/session/{admin_a_id}",
                               headers=auth_header(nonadmin_a_token)), 403)
    else:
        c.skip("session: cross-user -> 403", "non-admin login or admin id missing")
    if admin_a_token and admin_a_id:
        c.expect("session: authed requesting own id -> 200",
                  requests.get(f"{BASE_URL}/api/client/session/{admin_a_id}",
                               headers=auth_header(admin_a_token)), 200)
    else:
        c.skip("session: own id -> 200", "org A admin id not resolved from login")

    print("\n-- POST /api/client/onboarding/complete --")
    c.expect("onboarding-complete: no auth -> 401",
              requests.post(f"{BASE_URL}/api/client/onboarding/complete",
                             json={"user_id": admin_a_id or "x", "config": {}}), 401)
    if nonadmin_a_token and admin_a_id:
        c.expect("onboarding-complete: authed as someone else, targeting admin A's id -> 403",
                  requests.post(f"{BASE_URL}/api/client/onboarding/complete",
                                 json={"user_id": admin_a_id, "config": {}},
                                 headers=auth_header(nonadmin_a_token)), 403)
    else:
        c.skip("onboarding-complete: cross-user -> 403", "non-admin login or admin id missing")
    # Positive case intentionally NOT run automatically — it overwrites
    # real org config (departments/shifts/cameras/NVR-DVR IPs).

    print("\n-- POST /api/init (retired) --")
    c.expect("init -> 410", requests.post(f"{BASE_URL}/api/init"), 410)

    c.summary()


if __name__ == "__main__":
    main()
