#!/usr/bin/env python3
"""
api_smoke_test.py
─────────────────────────────────────────────────────────────────────────
Fast, no-browser check that every key API route your frontend depends on
is (a) reachable at the right URL and (b) not 4xx/5xx-ing for a logged-in
user. This is the automated version of "open Network tab, click a page,
eyeball for red rows" — run it after every deploy in a couple of seconds.

It does NOT replace the Playwright UI test (e2e-smoke.spec.js) — that one
catches things this can't (broken buttons, JS errors, CORS issues that
only show up from a real browser origin). This one is just much faster
for "did I break the API routing again" checks, which is what most of
today's bugs actually were.

SETUP (one-time per session — tokens expire, so redo this occasionally):
  1. Log into the dashboard normally in your browser.
  2. Open DevTools -> Application tab -> Local Storage -> your site.
  3. Copy the value of the "dashboardAuthToken" key.
  4. Paste it below, or set it as an env var:
       set DASHBOARD_TOKEN=eyJhbGciOi...        (Windows PowerShell: $env:DASHBOARD_TOKEN="...")
  5. Also set your organization_id the same way (visible in any Network
     request query string, e.g. ?organization_id=0713e40a-...).

RUN:
  python api_smoke_test.py

Add/remove routes in ROUTES below as your app grows — this list matches
what we traced through together (bootstrap, attendance, payroll, staff,
leave, notifications, live CCTV, etc).
─────────────────────────────────────────────────────────────────────────
"""

import os
import sys
import json
import urllib.request
import urllib.error
from datetime import date

# ─── Config ─────────────────────────────────────────────────────────────

API_BASE = os.environ.get("API_BASE", "https://api.qintellecttechnologies.com")
TOKEN = os.environ.get("DASHBOARD_TOKEN", "PASTE_YOUR_TOKEN_HERE")
ORG_ID = os.environ.get("ORG_ID", "0713e40a-6a1d-4d8c-9a76-fb823825b9a7")
TODAY = date.today().isoformat()

if TOKEN in ("", "PASTE_YOUR_TOKEN_HERE"):
    print("ERROR: set DASHBOARD_TOKEN (env var or edit the script). See SETUP above.")
    sys.exit(2)

HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Accept": "application/json",
}

# ─── Routes to check ────────────────────────────────────────────────────
# (method, path, description) — path may use {org} / {today} placeholders.
# Add branch_id/staff_id-specific ones if you want deeper coverage; these
# are the org-scoped "does the page load at all" checks.

ROUTES = [
    ("GET", "/api/client/bootstrap?organization_id={org}", "App bootstrap / login load"),
    ("GET", "/api/attendance/today?organization_id={org}&date={today}&people_type=staff", "Attendance - Today"),
    ("GET", "/api/attendance?organization_id={org}&limit=50", "Attendance - Logs"),
    ("GET", "/api/stats?organization_id={org}", "Attendance - Stats"),
    ("GET", "/api/leaves?organization_id={org}", "Leave Management - List"),
    ("GET", "/api/leaves/types?organization_id={org}", "Leave Management - Types"),
    ("GET", "/api/notifications?organization_id={org}", "Notifications"),
    ("GET", "/api/client/branches/{org}/departments", "Departments (adjust branch id if needed)"),
    ("GET", "/api/staff?organization_id={org}", "Staff Management - List"),
    ("GET", "/api/client/attendance/exceptions?organization_id={org}", "Attendance Exceptions"),
    ("GET", "/api/cameras?organization_id={org}", "Live CCTV - Cameras"),
    ("GET", "/api/cctv/live-tracking?organization_id={org}", "Live CCTV - Tracking"),
    ("GET", "/api/live-detections?organization_id={org}", "Live Attendance - Detections"),
    ("GET", "/api/tenant/config?org_id={org}", "Tenant Config"),
]

# Status codes we treat as "fine" even though they're not 200 — e.g. an
# empty list might legitimately 200, but some endpoints 204 on no data.
ACCEPTABLE = {200, 204}


def check(method, path_template, description):
    path = path_template.format(org=ORG_ID, today=TODAY)
    url = f"{API_BASE}{path}"
    req = urllib.request.Request(url, headers=HEADERS, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            status = resp.status
            body_preview = resp.read(200).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            body_preview = e.read(200).decode("utf-8", errors="replace")
        except Exception:
            body_preview = "<no body>"
    except Exception as e:
        return {
            "description": description, "url": url, "status": "ERROR",
            "ok": False, "detail": str(e),
        }

    ok = status in ACCEPTABLE
    return {
        "description": description, "url": url, "status": status,
        "ok": ok, "detail": body_preview,
    }


def main():
    print(f"API base:   {API_BASE}")
    print(f"Org ID:     {ORG_ID}")
    print(f"Date:       {TODAY}")
    print(f"Routes:     {len(ROUTES)}")
    print("-" * 70)

    results = []
    for method, path, desc in ROUTES:
        r = check(method, path, desc)
        results.append(r)
        mark = "PASS" if r["ok"] else "FAIL"
        print(f"[{mark}] {r['status']!s:>5}  {desc}")
        if not r["ok"]:
            print(f"        {r['url']}")
            print(f"        {r['detail'][:200]}")

    print("-" * 70)
    failed = [r for r in results if not r["ok"]]
    print(f"{len(results) - len(failed)}/{len(results)} passed.")

    with open("api_smoke_report.json", "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)
    print("Full report written to api_smoke_report.json")

    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
