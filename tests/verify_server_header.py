#!/usr/bin/env python3
"""
verify_server_header.py — prove audit finding #10 is actually fixed.

Run from your backend/ directory (the one containing app.py and
server_identity.py):

    python verify_server_header.py              # local: dev server + gunicorn
    python verify_server_header.py --url https://your-app.up.railway.app/api/health
    python verify_server_header.py --real-app   # boot the real app.py, not a stub

What it does
------------
1. Unit check: imports server_identity and confirms the patched values are in
   place on werkzeug and gunicorn.
2. Live check: boots a throwaway Flask app on a spare port under BOTH the
   werkzeug dev server and gunicorn, with the fix off and then on, and reads
   the Server header off a real HTTP response. The "off" runs are the control
   -- if they don't show the banner, the test itself is broken and a pass
   would mean nothing.
3. Duplicate check: a response carrying two Server headers means someone also
   set it in an after_request hook. That is the classic wrong fix and it
   leaves the original banner on the wire, so it is reported as a FAIL.
4. Optional --url: same header check against a deployed instance.

Exit code is 0 only if every check passes, so this is CI-safe.

Notes
-----
* gunicorn does not run on Windows. On Windows the gunicorn rows are skipped
  and reported as SKIP, not FAIL -- but your Railway container runs gunicorn,
  so use --url against the deploy to cover it for real.
* No pytest, no network, no deps beyond what the app already needs.
"""

from __future__ import annotations

import argparse
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

BANNER_TOKENS = ("werkzeug", "python/", "gunicorn/")

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"
if not sys.stdout.isatty() or os.environ.get("NO_COLOR"):
    GREEN = RED = YELLOW = DIM = RESET = ""

results: list[tuple[str, str, str]] = []  # (verdict, label, detail)


def record(ok: bool | None, label: str, detail: str = "") -> None:
    verdict = "SKIP" if ok is None else ("PASS" if ok else "FAIL")
    results.append((verdict, label, detail))
    colour = {"PASS": GREEN, "FAIL": RED, "SKIP": YELLOW}[verdict]
    print(f"  {colour}{verdict:4}{RESET}  {label}" + (f"  {DIM}{detail}{RESET}" if detail else ""))


def leaks_version(value: str) -> bool:
    """True if the header names software or a version number."""
    low = value.lower()
    return any(tok in low for tok in BANNER_TOKENS) or any(c.isdigit() for c in low)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def fetch_server_header(url: str, timeout: float = 20.0) -> tuple[str | None, list[str]]:
    """Poll until the server answers; return (Server value, all Server values)."""
    deadline = time.time() + timeout
    last_err = None
    while time.time() < deadline:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "verify-server-header"})
            with urllib.request.urlopen(req, timeout=3) as resp:
                return resp.headers.get("Server", "<absent>"), resp.headers.get_all("Server") or []
        except urllib.error.HTTPError as e:  # 4xx/5xx still carry headers
            return e.headers.get("Server", "<absent>"), e.headers.get_all("Server") or []
        except Exception as e:
            last_err = e
            time.sleep(0.3)
    raise RuntimeError(f"no response from {url}: {last_err}")


# ---------------------------------------------------------------- stub app

STUB = '''
import os, sys
sys.path.insert(0, {backend!r})
if os.environ.get("APPLY_FIX") == "1":
    import server_identity
from flask import Flask, jsonify
app = Flask("probe")

@app.get("/api/health")
def health():
    return jsonify(ok=True)

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ["PORT"]), use_reloader=False, debug=False)
'''


def write_stub(tmpdir: str, backend: str) -> str:
    path = os.path.join(tmpdir, "probe_app.py")
    with open(path, "w") as fh:
        fh.write(STUB.format(backend=backend))
    return path


def boot_and_read(cmd: list[str], cwd: str, port: int, apply_fix: bool,
                  extra_env: dict | None = None) -> tuple[str | None, list[str]]:
    env = dict(os.environ,
               PORT=str(port),
               APPLY_FIX="1" if apply_fix else "0",
               PYTHONUNBUFFERED="1")
    env.update(extra_env or {})
    kwargs = {}
    if os.name != "nt":
        kwargs["preexec_fn"] = os.setsid
    proc = subprocess.Popen(cmd, cwd=cwd, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kwargs)
    try:
        return fetch_server_header(f"http://127.0.0.1:{port}/api/health")
    finally:
        try:
            if os.name != "nt":
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            else:
                proc.kill()
        except Exception:
            pass
        proc.wait(timeout=10)


# ------------------------------------------------------------------ checks

def check_module(backend: str) -> None:
    print("\n1. Module check (is the patch in place in-process?)")
    sys.path.insert(0, backend)
    try:
        import server_identity
    except Exception as e:
        record(False, "import server_identity", f"{e.__class__.__name__}: {e}")
        return
    expected = server_identity.SERVER_HEADER
    record(True, "server_identity imports", f"SERVER_HEADER={expected!r}")

    try:
        from werkzeug.serving import WSGIRequestHandler
    except ImportError as e:
        record(None, "werkzeug not installed here", str(e))
    else:
        try:
            actual = WSGIRequestHandler.version_string(None)
        except Exception:
            # Unpatched, version_string() reads a property off a live handler
            # instance and blows up on None. That failure IS the diagnosis:
            # the class attribute was never shadowed, so the banner is intact.
            record(False, "werkzeug version_string() patched",
                   "still the stock property -> will serve Werkzeug/<version>")
        else:
            record(actual == expected and not leaks_version(actual),
                   "werkzeug version_string() patched", f"-> {actual!r}")

    try:
        import gunicorn.http.wsgi as gw
    except ImportError:
        record(None, "gunicorn not installed here", "covered by --url against the deploy")
    else:
        record(gw.SERVER == expected and not leaks_version(gw.SERVER),
               "gunicorn.http.wsgi.SERVER patched", f"-> {gw.SERVER!r}")


def check_live(backend: str, real_app: bool) -> None:
    print("\n2. Live HTTP check (what actually goes out on the wire?)")
    tmpdir = tempfile.mkdtemp(prefix="serverhdr-")
    try:
        if real_app:
            cwd, module = backend, "app"
            stub_cmd = [sys.executable, "app.py"]
            print(f"  {DIM}using the real app.py (slow: loads face models){RESET}")
        else:
            write_stub(tmpdir, backend)
            cwd, module = tmpdir, "probe_app"
            stub_cmd = [sys.executable, "probe_app.py"]

        # --- werkzeug dev server: control run, then fixed run
        try:
            before, _ = boot_and_read(stub_cmd, cwd, free_port(), apply_fix=False)
            record(leaks_version(before or ""), "control: dev server leaks banner without fix",
                   f"Server: {before!r}")
        except Exception as e:
            record(None, "control run (dev server)", str(e))

        try:
            after, all_after = boot_and_read(stub_cmd, cwd, free_port(), apply_fix=True)
            record(not leaks_version(after or ""), "dev server with fix", f"Server: {after!r}")
            record(len(all_after) <= 1, "no duplicate Server header (dev server)",
                   f"{len(all_after)} present")
        except Exception as e:
            record(False, "dev server with fix", str(e))

        # --- gunicorn
        if shutil.which("gunicorn") is None or os.name == "nt":
            record(None, "gunicorn runs", "not available on this OS/env -- use --url on the deploy")
            return
        gcmd = lambda p: ["gunicorn", f"{module}:app", "--bind", f"127.0.0.1:{p}",
                          "--workers", "1", "--threads", "4", "--timeout", "120"]
        try:
            port = free_port()
            before, _ = boot_and_read(gcmd(port), cwd, port, apply_fix=False)
            # gunicorn's default is bare "gunicorn" (no version) -- still a
            # software disclosure, so we assert it changes, not that it leaks
            # a version number.
            record(True, "control: gunicorn default banner", f"Server: {before!r}")
        except Exception as e:
            record(None, "control run (gunicorn)", str(e))

        try:
            port = free_port()
            after, all_after = boot_and_read(gcmd(port), cwd, port, apply_fix=True)
            ok = not leaks_version(after or "") and "gunicorn" not in (after or "").lower()
            record(ok, "gunicorn with fix", f"Server: {after!r}")
            record(len(all_after) <= 1, "no duplicate Server header (gunicorn)",
                   f"{len(all_after)} present")
        except Exception as e:
            record(False, "gunicorn with fix", str(e))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def check_url(url: str) -> None:
    print(f"\n3. Deployed instance: {url}")
    try:
        value, all_values = fetch_server_header(url, timeout=15)
    except Exception as e:
        record(False, "reachable", str(e))
        return
    record(not leaks_version(value or ""), "no software/version banner", f"Server: {value!r}")
    record(len(all_values) <= 1, "no duplicate Server header", f"{len(all_values)} present")
    if value and value != "<absent>" and "railway" in value.lower():
        print(f"  {DIM}note: that looks like the edge proxy's banner, not your app's.{RESET}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", help="also check a deployed instance (full URL to any endpoint)")
    ap.add_argument("--real-app", action="store_true",
                    help="boot app.py instead of a stub (slow; needs all deps installed)")
    ap.add_argument("--backend", default=os.getcwd(), help="path to backend/ (default: cwd)")
    ap.add_argument("--skip-local", action="store_true", help="only run --url check")
    args = ap.parse_args()

    backend = os.path.abspath(args.backend)
    if not args.skip_local and not os.path.isfile(os.path.join(backend, "server_identity.py")):
        print(f"{RED}server_identity.py not found in {backend}{RESET}")
        print("Run this from your backend/ directory, or pass --backend /path/to/backend")
        return 2

    print(f"{DIM}backend: {backend}{RESET}")
    if not args.skip_local:
        check_module(backend)
        check_live(backend, args.real_app)
    if args.url:
        check_url(args.url)

    failed = [r for r in results if r[0] == "FAIL"]
    skipped = [r for r in results if r[0] == "SKIP"]
    print("\n" + "-" * 60)
    if failed:
        print(f"{RED}{len(failed)} check(s) FAILED{RESET}"
              + (f", {len(skipped)} skipped" if skipped else ""))
        for _, label, detail in failed:
            print(f"  - {label} {DIM}{detail}{RESET}")
        return 1
    print(f"{GREEN}All checks passed{RESET}"
          + (f", {len(skipped)} skipped" if skipped else ""))
    if skipped:
        for _, label, detail in skipped:
            print(f"  {YELLOW}skipped:{RESET} {label} {DIM}{detail}{RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
