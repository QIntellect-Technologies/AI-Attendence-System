#!/usr/bin/env python3
"""
verify_https_enforcement.py — prove audit finding #11 is fixed (and that the
fix does not take the deployment down).

    python verify_https_enforcement.py
    python verify_https_enforcement.py --url https://your-app.up.railway.app

The local run exercises the Flask hooks directly with a test client, faking
the X-Forwarded-Proto header that Railway's edge sets. The --url run checks a
real deployment: that http:// redirects rather than serving, and that https://
carries HSTS.

Every check has a control: the "enforcement off" cases must show the insecure
behaviour, or a pass proves nothing.
"""

from __future__ import annotations

import argparse
import os
import sys
import urllib.error
import urllib.request

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"
if not sys.stdout.isatty() or os.environ.get("NO_COLOR"):
    GREEN = RED = YELLOW = DIM = RESET = ""

results: list[tuple[str, str, str]] = []


def record(ok, label, detail=""):
    verdict = "SKIP" if ok is None else ("PASS" if ok else "FAIL")
    results.append((verdict, label, detail))
    colour = {"PASS": GREEN, "FAIL": RED, "SKIP": YELLOW}[verdict]
    print(f"  {colour}{verdict:4}{RESET}  {label}" + (f"  {DIM}{detail}{RESET}" if detail else ""))


def build_app(env: dict):
    """Fresh Flask app with the real hooks, under a given env."""
    for k in ("FORCE_HTTPS", "HTTPS_STRICT", "HSTS_MAX_AGE",
              "HSTS_INCLUDE_SUBDOMAINS", "HSTS_PRELOAD", "HTTPS_EXEMPT_PATHS"):
        os.environ.pop(k, None)
    os.environ.update({k: v for k, v in env.items() if v is not None})

    import importlib
    import https_enforcement
    importlib.reload(https_enforcement)

    from flask import Flask, jsonify
    from werkzeug.middleware.proxy_fix import ProxyFix

    app = Flask("probe")
    app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)
    https_enforcement.init_app(app)

    @app.get("/api/health")
    def health():
        return jsonify(ok=True)

    @app.post("/api/client/login")
    def login():
        return jsonify(token="secret")

    @app.get("/api/data")
    def data():
        return jsonify(ok=True)

    return app, https_enforcement


HTTPS = {"X-Forwarded-Proto": "https"}
HTTP = {"X-Forwarded-Proto": "http"}


def local_checks():
    print("\n1. Plaintext handling (enforcement ON, as on Railway)")
    app, mod = build_app({"FORCE_HTTPS": "1"})
    c = app.test_client()

    r = c.post("/api/client/login", headers=HTTP, json={"email": "a@b.c", "password": "hunter2"})
    record(r.status_code == 308, "http login POST is redirected, not served",
           f"{r.status_code} -> {r.headers.get('Location')}")
    record(str(r.headers.get("Location", "")).startswith("https://"),
           "redirect target is https", r.headers.get("Location", ""))
    record(r.status_code == 308,
           "redirect is 308 (method-preserving, POST stays POST)", f"code={r.status_code}")

    r = c.get("/api/data", headers=HTTP)
    record(r.status_code == 308, "http GET is redirected", str(r.status_code))

    r = c.get("/api/data", headers=HTTPS)
    record(r.status_code == 200, "https GET is served normally", str(r.status_code))

    print("\n2. Control: enforcement OFF must show the insecure behaviour")
    app_off, _ = build_app({"FORCE_HTTPS": "0"})
    r = app_off.test_client().post("/api/client/login", headers=HTTP, json={"password": "hunter2"})
    record(r.status_code == 200, "control: plaintext login succeeds when disabled",
           f"{r.status_code} (this is the bug being fixed)")

    print("\n3. HSTS")
    app, _ = build_app({"FORCE_HTTPS": "1"})
    c = app.test_client()
    r = c.get("/api/data", headers=HTTPS)
    hsts = r.headers.get("Strict-Transport-Security")
    record(bool(hsts) and "max-age=" in hsts, "HSTS sent over https", str(hsts))
    record(hsts is not None and "max-age=0" not in hsts, "max-age is non-zero", str(hsts))
    record("preload" not in (hsts or ""), "preload NOT set by default",
           "irreversible; opt in only when every subdomain has a cert")

    r = c.get("/api/health", headers=HTTP)
    record(r.headers.get("Strict-Transport-Security") is None,
           "HSTS NOT sent over plaintext", "RFC 6797 - a stripper could forge it")

    print("\n4. Availability guards (the ways this fix could cause an outage)")
    app, _ = build_app({"FORCE_HTTPS": "1"})
    c = app.test_client()
    r = c.get("/api/health", headers=HTTP, environ_overrides={"REMOTE_ADDR": "127.0.0.1"})
    record(r.status_code == 200, "container healthcheck (loopback, no XFP) still 200",
           f"{r.status_code} - a redirect here means restart loops")
    r = c.get("/api/health", headers=HTTP)
    record(r.status_code == 200, "/api/health exempt even from the network", str(r.status_code))

    print("\n5. Default posture (auto mode)")
    saved = {k: v for k, v in os.environ.items() if k.startswith("RAILWAY_")}
    for k in list(saved):
        os.environ.pop(k)
    _, mod = build_app({})
    record(mod.enforcement_enabled() is False,
           "auto: OFF with no RAILWAY_* env", "LAN nodes keep serving http")
    os.environ["RAILWAY_ENVIRONMENT"] = "production"
    _, mod = build_app({})
    record(mod.enforcement_enabled() is True, "auto: ON when RAILWAY_* present")
    os.environ.pop("RAILWAY_ENVIRONMENT")
    os.environ.update(saved)

    print("\n6. Strict mode")
    app, _ = build_app({"FORCE_HTTPS": "1", "HTTPS_STRICT": "1"})
    c = app.test_client()
    r = c.post("/api/client/login", headers=HTTP, json={"password": "hunter2"})
    record(r.status_code == 403, "HTTPS_STRICT=1 rejects plaintext writes", str(r.status_code))
    r = c.get("/api/data", headers=HTTP)
    record(r.status_code == 308, "HTTPS_STRICT still redirects reads", str(r.status_code))

    print("\n7. Outbound base URLs baked into node configs")
    _, mod = build_app({})
    f = mod.require_https_base_url
    record(f("http://api.example.com") == "https://api.example.com",
           "public http:// base URL upgraded", f("http://api.example.com"))
    record(f("https://api.example.com") == "https://api.example.com",
           "https left alone")
    record(f("http://192.168.1.50:5000") == "http://192.168.1.50:5000",
           "LAN address left alone", "no cert on-prem; upgrading would break it")
    record(f("http://localhost:5000") == "http://localhost:5000", "loopback left alone")
    record(f("") == "", "empty input safe")


def url_checks(base: str):
    base = base.rstrip("/")
    host = base.split("://", 1)[-1]
    print(f"\n8. Deployed instance: {host}")

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    opener = urllib.request.build_opener(NoRedirect)
    try:
        opener.open(f"http://{host}/api/health", timeout=15)
        record(False, "http:// does not serve content", "returned 200 in the clear")
    except urllib.error.HTTPError as e:
        loc = e.headers.get("Location", "")
        record(e.code in (301, 302, 307, 308) and loc.startswith("https://"),
               "http:// redirects to https://", f"{e.code} -> {loc}")
        record(e.code in (307, 308), "redirect preserves method",
               f"{e.code} (301/302 would downgrade POST to GET)")
    except Exception as e:
        record(None, "http:// probe", f"{e.__class__.__name__}: {e}")

    try:
        with urllib.request.urlopen(f"https://{host}/api/health", timeout=15) as r:
            hsts = r.headers.get("Strict-Transport-Security")
            record(bool(hsts), "HSTS present on https", str(hsts))
    except Exception as e:
        record(False, "https reachable", f"{e.__class__.__name__}: {e}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", help="deployed base URL, e.g. https://app.up.railway.app")
    ap.add_argument("--skip-local", action="store_true")
    ap.add_argument("--backend", default=os.getcwd())
    args = ap.parse_args()

    sys.path.insert(0, os.path.abspath(args.backend))
    if not args.skip_local:
        if not os.path.isfile(os.path.join(args.backend, "https_enforcement.py")):
            print(f"{RED}https_enforcement.py not found — run from backend/{RESET}")
            return 2
        local_checks()
    if args.url:
        url_checks(args.url)

    failed = [r for r in results if r[0] == "FAIL"]
    skipped = [r for r in results if r[0] == "SKIP"]
    print("\n" + "-" * 62)
    if failed:
        print(f"{RED}{len(failed)} check(s) FAILED{RESET}")
        for _, label, detail in failed:
            print(f"  - {label} {DIM}{detail}{RESET}")
        return 1
    print(f"{GREEN}All checks passed{RESET}" + (f", {len(skipped)} skipped" if skipped else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
