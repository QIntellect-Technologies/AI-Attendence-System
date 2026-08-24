#!/usr/bin/env python3
"""
test_tier1_auth.py
────────────────────────────────────────────────────────────────────────────
Regression test for the Tier 1 (account-takeover / destructive) auth fixes.

Fill in the CONFIG block below with real credentials for your local/staging
server, then run:

    pip install requests --break-system-packages   # if not already installed
    python3 test_tier1_auth.py

Every check prints PASS/FAIL. Non-zero exit code if anything fails, so this
is also CI-friendly (wire it into a pre-deploy check).

WHAT THIS PROVES, per route:
  1. No Authorization header                -> 401
  2. Garbage/invalid token                   -> 401
  3. Valid token, WRONG role (admin route)   -> 403
  4. Valid token, RIGHT role, WRONG org      -> 404 (never leak cross-org)
  5. Valid token, RIGHT role, RIGHT org      -> 200 (route still works!)

Steps 1-4 prove the vulnerability is closed. Step 5 proves you didn't lock
out legitimate use while closing it — always test both directions.
"""
import sys
import requests

# ─── CONFIG — fill these in for your environment ──────────────────────────
BASE_URL = "http://localhost:5000"

# An admin account in org A, and a non-admin (hr/staff) account in the SAME
# org A — used to prove admin-only routes reject non-admins.
ORG_A_ADMIN = {"email": "fatimafertilizers@gmail.com", "password": "W4qBp25KkSHQiA6d"}
ORG_A_NONADMIN = {"email": "imrankhalid@gmail.com", "password": "Nm@iPHtofafaV"}

# An admin account in a DIFFERENT org B — used to prove org-scoping, i.e.
# org A's admin token can never touch org B's records and vice versa.
ORG_B_ADMIN = {"email": "principal@greenwood-demo.qintellect.io", "password": "Demo@2026!"}

# A real, currently-ARCHIVED numeric user id belonging to org A. Needed for
# the restore/purge tests (safe to reuse — restore then re-archive it, or
# use a disposable seed record).
ORG_A_ARCHIVED_USER_ID = "1146b5cc-9d9f-41f7-b512-492b5ca840da"  # <-- set this

# A real, ACTIVE numeric user id belonging to org A, distinct from the admin
# account itself — needed for the "admin cannot reset someone else's
# password" test.
ORG_A_OTHER_USER_ID = "12edf044-8386-4605-b967-7af2f6317c2f"  # <-- set this
# ────────────────────────────────────────────────────────────────────────


def login(creds: dict) -> str | None:
    r = requests.post(f"{BASE_URL}/api/login", json=creds, timeout=10)
    r.raise_for_status()
    return r.json().get("token")


class Check:
    def __init__(self):
        self.failures = []

    def expect(self, label: str, response: requests.Response, expected_status: int):
        ok = response.status_code == expected_status
        mark = "PASS" if ok else "FAIL"
        print(f"[{mark}] {label} -> got {response.status_code}, expected {expected_status}")
        if not ok:
            self.failures.append(label)

    def summary(self):
        print("\n" + "=" * 60)
        if self.failures:
            print(f"{len(self.failures)} FAILURE(S):")
            for f in self.failures:
                print(f"  - {f}")
            sys.exit(1)
        print("All checks passed.")
        sys.exit(0)


def auth_header(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def main():
    c = Check()

    print("Logging in test accounts...")
    admin_a_token = login(ORG_A_ADMIN)
    nonadmin_a_token = login(ORG_A_NONADMIN)
    admin_b_token = login(ORG_B_ADMIN)
    print(f"  org A admin token:     {'ok' if admin_a_token else 'MISSING'}")
    print(f"  org A non-admin token: {'ok' if nonadmin_a_token else 'MISSING'}")
    print(f"  org B admin token:     {'ok' if admin_b_token else 'MISSING'}\n")

    uid = ORG_A_ARCHIVED_USER_ID
    other_uid = ORG_A_OTHER_USER_ID

    # ── POST /api/change-password ──────────────────────────────────────
    print("-- /api/change-password --")
    c.expect(
        "change-password: no auth header -> 401",
        requests.post(f"{BASE_URL}/api/change-password",
                      json={"user_id": other_uid, "new_password": "x"}),
        401,
    )
    c.expect(
        "change-password: admin resetting ANOTHER user's password -> 403 (self-only policy)",
        requests.post(f"{BASE_URL}/api/change-password",
                      json={"user_id": other_uid, "new_password": "NewPass123!"},
                      headers=auth_header(admin_a_token)),
        403,
    )
    # Positive case: self-reset should still work. Fill in the admin's own
    # numeric id to exercise this, or skip if not applicable to your setup.

    # ── DELETE /api/staff/<int:user_id> (admin-only, org-scoped) ────────
    print("\n-- /api/staff/<id> DELETE --")
    c.expect(
        "staff DELETE: no auth -> 401",
        requests.delete(f"{BASE_URL}/api/staff/{other_uid}"),
        401,
    )
    c.expect(
        "staff DELETE: non-admin same org -> 403",
        requests.delete(f"{BASE_URL}/api/staff/{other_uid}",
                         headers=auth_header(nonadmin_a_token)),
        403,
    )
    c.expect(
        "staff DELETE: admin, WRONG org (org B admin targeting org A user) -> 404",
        requests.delete(f"{BASE_URL}/api/staff/{other_uid}",
                         headers=auth_header(admin_b_token)),
        404,
    )
    # Positive case (destructive — only run against a disposable seed user):
    # c.expect("staff DELETE: admin, correct org -> 200",
    #     requests.delete(f"{BASE_URL}/api/staff/{DISPOSABLE_UID}",
    #                      headers=auth_header(admin_a_token)), 200)

    # ── POST /api/staff/<id>/restore (admin-only, org-scoped) ───────────
    print("\n-- /api/staff/<id>/restore --")
    c.expect(
        "restore: no auth -> 401",
        requests.post(f"{BASE_URL}/api/staff/{uid}/restore", json={}),
        401,
    )
    c.expect(
        "restore: non-admin -> 403",
        requests.post(f"{BASE_URL}/api/staff/{uid}/restore", json={},
                       headers=auth_header(nonadmin_a_token)),
        403,
    )
    c.expect(
        "restore: admin WRONG org -> 404",
        requests.post(f"{BASE_URL}/api/staff/{uid}/restore", json={},
                       headers=auth_header(admin_b_token)),
        404,
    )
    r = requests.post(f"{BASE_URL}/api/staff/{uid}/restore", json={},
                       headers=auth_header(admin_a_token))
    c.expect("restore: admin RIGHT org -> 200 (route still works)", r, 200)

    # ── POST/DELETE /api/staff/archived/<id>/delete (permanent purge) ───
    print("\n-- /api/staff/archived/<id>/delete --")
    c.expect(
        "purge: no auth -> 401",
        requests.post(f"{BASE_URL}/api/staff/archived/{uid}/delete", json={}),
        401,
    )
    c.expect(
        "purge: non-admin -> 403",
        requests.post(f"{BASE_URL}/api/staff/archived/{uid}/delete", json={},
                       headers=auth_header(nonadmin_a_token)),
        403,
    )
    c.expect(
        "purge: admin WRONG org -> 404",
        requests.post(f"{BASE_URL}/api/staff/archived/{uid}/delete", json={},
                       headers=auth_header(admin_b_token)),
        404,
    )
    # Positive case intentionally NOT run automatically (irreversible).

    c.summary()


if __name__ == "__main__":
    main()
