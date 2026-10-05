"""
server_identity.py — strip the software/version banner from HTTP responses.

Audit finding #10 (Medium): every response carried

    Server: Werkzeug/3.0.1 Python/3.10.0

which names the WSGI server, its exact version, and the Python version. That
is free reconnaissance: an attacker pastes the version into a CVE search and
gets a list of known bugs to try, and the "Python" token alone tells them
which classes of payload are worth attempting at all. Suppressing it doesn't
patch anything -- it just stops the server volunteering a target list.

Why this is a module and not an `@app.after_request` hook
--------------------------------------------------------
The `Server` header is written by the *WSGI server*, not by Flask, and it is
written BEFORE the application's own headers go out:

  * Werkzeug's dev server calls `BaseHTTPRequestHandler.send_response()`,
    which emits `Server: <version_string()>` first, then appends whatever the
    app returned. Setting the header in `after_request` therefore does not
    replace it -- it produces two `Server` headers on every response.
  * gunicorn does the same in `Response.default_headers()`, and its
    `process_headers()` happily appends an app-supplied `Server` on top.

So the value has to be changed at the source, in the server, before any
request is handled. Both patches below are idempotent and safe to call when
the corresponding server isn't installed.

Usage: `import server_identity` as early as possible in the app entry module
(it self-applies on import). Set SERVER_HEADER to override the value; set it
to an empty string to drop the header entirely where the server allows it.
"""

from __future__ import annotations

import os

__all__ = ["SERVER_HEADER", "apply", "status"]

# Neutral, versionless, product-agnostic. Anything here is a lie by design;
# the point is that it identifies nothing. An empty value removes the header
# outright under gunicorn and blanks it under the dev server.
SERVER_HEADER = os.environ.get("SERVER_HEADER", "server").strip()

_status: dict[str, str] = {}


def _harden_werkzeug() -> None:
    """Dev server / anything using werkzeug.serving (`flask run`, app.run)."""
    try:
        from werkzeug.serving import WSGIRequestHandler
    except Exception as exc:  # werkzeug missing or unexpected layout
        _status["werkzeug"] = f"skipped ({exc.__class__.__name__})"
        return

    # In Werkzeug 3.x `server_version` is a read-only property that reads
    # `self.server._server_version` ("Werkzeug/3.0.1"), and `sys_version`
    # comes from http.server as "Python/3.10.0". `version_string()` joins
    # the two. Assigning plain class attributes shadows both, and also
    # cleans up the SERVER_SOFTWARE value in the WSGI environ, which
    # make_environ() derives from `server_version`.
    WSGIRequestHandler.server_version = SERVER_HEADER  # type: ignore[assignment]
    WSGIRequestHandler.sys_version = ""

    # version_string() is `server_version + " " + sys_version`, which would
    # leave a trailing space. Override it so the header is exactly the value.
    WSGIRequestHandler.version_string = lambda self: SERVER_HEADER  # type: ignore[assignment]

    _status["werkzeug"] = f"patched -> {SERVER_HEADER!r}"


def _harden_gunicorn() -> None:
    """Production server (see Dockerfile CMD)."""
    try:
        import gunicorn.http.wsgi as gunicorn_wsgi
    except Exception as exc:  # not installed in local dev -- fine
        _status["gunicorn"] = f"skipped ({exc.__class__.__name__})"
        return

    # `Response.__init__` does `self.version = SERVER`, a module-global read
    # at call time, so rebinding the name on the module is enough and works
    # no matter which import ran first. Note this must be
    # `gunicorn.http.wsgi.SERVER`, not `gunicorn.SERVER`: wsgi.py did
    # `from gunicorn import SERVER`, so it holds its own reference and
    # patching the top-level package has no effect.
    gunicorn_wsgi.SERVER = SERVER_HEADER

    # Same banner is handed to the app in environ["SERVER_SOFTWARE"], where
    # it carries the full "gunicorn/22.0.0". Nothing in this codebase echoes
    # it, but a future error page or debug endpoint might.
    if hasattr(gunicorn_wsgi, "SERVER_SOFTWARE"):
        gunicorn_wsgi.SERVER_SOFTWARE = SERVER_HEADER

    _status["gunicorn"] = f"patched -> {SERVER_HEADER!r}"


def apply() -> dict[str, str]:
    """Apply every available patch. Idempotent; returns a status mapping."""
    _harden_werkzeug()
    _harden_gunicorn()
    return dict(_status)


def status() -> dict[str, str]:
    """What was patched, for startup logging."""
    return dict(_status)


apply()
