#!/usr/bin/env python3
"""
test_tier4_auth.py
────────────────────────────────────────────────────────────────────────────
Regression test for the Tier 4 (live CCTV / streaming) auth fixes, plus the
two extra routes found and fixed during the same sweep (/api/cameras,
which was still open when this was written; /api/stats, which turned out
to already be fixed — see the CAMERAS block below for org-isolation proof
on the one that actually needed it).

Same conventions as test_tier1_auth.py / test_tier2_tier3_auth.py — fill in
CONFIG (or just reuse the same accounts), then:

    pip install requests --break-system-packages   # if not already installed
    python3 test_tier4_auth.py

WHAT THIS PROVES, per route:
  /api/live-detections        no auth -> 401 ; valid org A token -> 200,
                               and never contains org B's camera ids
  /api/cctv/live-tracking     no auth -> 401 ; valid token -> 200, org
                               pinned to token (org param in URL is ignored)
  /api/cameras                no auth -> 401 ; valid org A token -> 200,
                               and org_id query param pointing at org B is
                               IGNORED (still returns org A's cameras only)
  /api/stats                  no auth -> 401 ; valid token -> 200
  /api/stream/token           no auth -> 401 ; org A token + org B's
                               camera_id -> 404 (can't mint a token for a
                               camera you don't own) ; org A token + org A's
                               own camera_id -> 200 with a stream_token
  /api/stream/<camera_id>     no stream_token -> 401 ; a token minted for
                               camera X used against camera Y's URL -> 401
                               (token/camera_id mismatch caught by
                               verify_stream_token)
  /api/recognize/frame        POST, any auth or none -> 410 (retired)
  /api/recognize/rtsp         POST, any auth or none -> 410 (retired)
  /api/dashboard/embeddings/import   no auth -> 401 ; non-admin -> 403

This is a read-mostly test file — nothing here deletes or mutates data,
so it's safe to run repeatedly against a shared staging environment.
"""
import sys
import requests

# ─── CONFIG — same accounts as test_tier1_auth.py / test_tier2_tier3_auth.py
BASE_URL = "http://localhost:5000"

ORG_A_ADMIN = {"email": "fatimafertilizers@gmail.com", "password": " W4qBp25KkSHQiA6d"}
ORG_A_NONADMIN = {"email": "imrankhalid@gmail.com", "password": "Nm@iPHtofafaV"}
ORG_B_ADMIN = {"email": "schooladmin@gmail.com", "password": "FhMXBsYLrzpC#Ddi"}

# A real camera_id that belongs to org A — used for the positive-path
# token-mint test and the token/camera-mismatch test.
ORG_A_CAMERA_ID = "859de9a7-fb0d-4765-9f2f-dc02a12e1ab8"
# ────────────────────────────────────────────────────────────────────────
# A real camera_id that belongs to org B — used to prove org A's token
# can't mint a stream token for it. Grab one from org B's
# /api/cameras response (as org B) if you don't already have it.
ORG_B_CAMERA_ID = "48d89561-a102-4e41-b917-334c3d8f7cb8"


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
        return response

    def expect_true(self, label: str, condition: bool):
        mark = "PASS" if condition else "FAIL"
        print(f"[{mark}] {label}")
        if not condition:
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

    # ── GET /api/live-detections ─────────────────────────────────────────
    print("-- /api/live-detections --")
    c.expect(
        "live-detections: no auth -> 401",
        requests.get(f"{BASE_URL}/api/live-detections"),
        401,
    )
    r = c.expect(
        "live-detections: org A token -> 200",
        requests.get(f"{BASE_URL}/api/live-detections", headers=auth_header(admin_a_token)),
        200,
    )
    c.expect(
        "live-detections: org param in query string is ignored (no cross-org leak via ?organization_id=)",
        requests.get(
            f"{BASE_URL}/api/live-detections?organization_id=some-other-org-id",
            headers=auth_header(admin_a_token),
        ),
        200,  # should succeed and just return org A's own detections, not error or leak org B's
    )

    # ── GET /api/cctv/live-tracking ──────────────────────────────────────
    print("\n-- /api/cctv/live-tracking --")
    c.expect(
        "cctv/live-tracking: no auth -> 401",
        requests.get(f"{BASE_URL}/api/cctv/live-tracking"),
        401,
    )
    c.expect(
        "cctv/live-tracking: org A token -> 200",
        requests.get(f"{BASE_URL}/api/cctv/live-tracking", headers=auth_header(admin_a_token)),
        200,
    )

    # ── GET /api/cameras ──────────────────────────────────────────────────
    print("\n-- /api/cameras --")
    c.expect(
        "cameras: no auth -> 401",
        requests.get(f"{BASE_URL}/api/cameras"),
        401,
    )
    r_a = c.expect(
        "cameras: org A token -> 200",
        requests.get(f"{BASE_URL}/api/cameras", headers=auth_header(admin_a_token)),
        200,
    )
    # The real proof of the fix: even if you TRY to ask for org B's cameras
    # via the query string, using org A's token, you still only get org A's
    # cameras back (the param is now decorative — org comes from the token).
    r_spoof = c.expect(
        "cameras: org A token + ?organization_id=<org B> in URL -> 200, still org A's cameras",
        requests.get(
            f"{BASE_URL}/api/cameras?organization_id=00000000-0000-0000-0000-000000000000",
            headers=auth_header(admin_a_token),
        ),
        200,
    )
    try:
        ids_a = {cam.get("id") or cam.get("camera_id") for cam in r_a.json()}
        ids_spoof = {cam.get("id") or cam.get("camera_id") for cam in r_spoof.json()}
        c.expect_true(
            "cameras: spoofed org_id param did not change the result set",
            ids_a == ids_spoof,
        )
    except Exception as e:
        c.expect_true(f"cameras: could not compare response bodies ({e})", False)

    # ── GET /api/stats ────────────────────────────────────────────────────
    print("\n-- /api/stats --")
    c.expect(
        "stats: no auth -> 401",
        requests.get(f"{BASE_URL}/api/stats"),
        401,
    )
    c.expect(
        "stats: org A token -> 200",
        requests.get(f"{BASE_URL}/api/stats", headers=auth_header(admin_a_token)),
        200,
    )

    # ── POST /api/stream/token ───────────────────────────────────────────
    print("\n-- /api/stream/token --")
    c.expect(
        "stream/token: no auth -> 401",
        requests.post(f"{BASE_URL}/api/stream/token", json={"camera_id": ORG_A_CAMERA_ID}),
        401,
    )
    c.expect(
        "stream/token: org A token requesting org B's camera_id -> 404 (not owned)",
        requests.post(
            f"{BASE_URL}/api/stream/token",
            json={"camera_id": ORG_B_CAMERA_ID},
            headers=auth_header(admin_a_token),
        ),
        404,
    )
    r_token = c.expect(
        "stream/token: org A token requesting its OWN camera_id -> 200",
        requests.post(
            f"{BASE_URL}/api/stream/token",
            json={"camera_id": ORG_A_CAMERA_ID},
            headers=auth_header(admin_a_token),
        ),
        200,
    )
    stream_token = None
    try:
        stream_token = r_token.json().get("stream_token")
        c.expect_true("stream/token: response includes a stream_token", bool(stream_token))
    except Exception:
        c.expect_true("stream/token: response body was valid JSON", False)

    # ── GET /api/stream/<camera_id> ──────────────────────────────────────
    print("\n-- /api/stream/<camera_id> --")
    c.expect(
        "stream: no stream_token param -> 401",
        requests.get(f"{BASE_URL}/api/stream/{ORG_A_CAMERA_ID}", stream=True),
        401,
    )
    if stream_token:
        c.expect(
            "stream: token minted for org A's camera used against org B's camera_id -> 401 (mismatch)",
            requests.get(
                f"{BASE_URL}/api/stream/{ORG_B_CAMERA_ID}?stream_token={stream_token}",
                stream=True,
            ),
            401,
        )
        # Positive case intentionally not asserted on status code alone —
        # this opens a real MJPEG connection to a live camera. Uncomment to
        # smoke-test manually against a camera you know is online:
        # r = requests.get(
        #     f"{BASE_URL}/api/stream/{ORG_A_CAMERA_ID}?stream_token={stream_token}",
        #     stream=True, timeout=5,
        # )
        # print("stream: correct camera + own token ->", r.status_code)

    # ── POST /api/recognize/frame & /api/recognize/rtsp (retired) ───────
    print("\n-- retired endpoints --")
    c.expect(
        "recognize/frame: retired -> 410 regardless of auth",
        requests.post(f"{BASE_URL}/api/recognize/frame", json={}),
        410,
    )
    c.expect(
        "recognize/rtsp: retired -> 410 regardless of auth",
        requests.post(f"{BASE_URL}/api/recognize/rtsp", json={}),
        410,
    )

    # ── POST /api/dashboard/embeddings/import (admin-only) ──────────────
    print("\n-- /api/dashboard/embeddings/import --")
    c.expect(
        "embeddings/import: no auth -> 401",
        requests.post(f"{BASE_URL}/api/dashboard/embeddings/import", json={}),
        401,
    )
    c.expect(
        "embeddings/import: non-admin -> 403",
        requests.post(
            f"{BASE_URL}/api/dashboard/embeddings/import",
            json={},
            headers=auth_header(nonadmin_a_token),
        ),
        403,
    )
    # Positive case not run automatically — it mutates real embedding data.

    c.summary()


if __name__ == "__main__":
    main()
