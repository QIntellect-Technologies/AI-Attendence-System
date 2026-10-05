"""
https_enforcement.py — refuse to serve the API over plaintext (audit #11).

What this does and, importantly, what it cannot do
--------------------------------------------------
TLS itself is terminated upstream: on Railway by their edge, on a LAN node by
whatever reverse proxy you put in front of it. Flask never holds the
certificate, so no amount of application code "adds HTTPS". What application
code CAN do, and what was missing, is three things:

  1. Stop *accepting* plaintext. The deployment answers on http:// as well as
     https://, so a client (or a user typing the bare hostname) can send a
     login POST in the clear and get a 200 back. Nothing signals that anything
     is wrong.
  2. Tell browsers never to try plaintext again (HSTS). This is the only part
     that actually protects the *first* request, which is the one a sniffer on
     shared Wi-Fi is waiting for. A redirect does not: by the time Flask sees
     an http:// POST and answers 308, the password is already on the wire and
     in the attacker's capture. The redirect fixes the client's next attempt;
     HSTS fixes every attempt after the first successful https one.
  3. Stop *handing out* http:// URLs. `/v1/activate` and the installer builder
     bake `request.host_url` into node configs. One request that arrives over
     http and a node is permanently configured to push attendance records over
     plaintext. See require_https_base_url().

Configuration
-------------
FORCE_HTTPS        auto (default) | 1 | 0
                   "auto" enables enforcement when a RAILWAY_* environment
                   variable is present, i.e. on the cloud deployment, and
                   leaves it off elsewhere. That default matters: an on-prem
                   LAN node legitimately serves http:// over the local
                   network, and redirecting it to a scheme it has no
                   certificate for would take the branch offline. Set
                   FORCE_HTTPS=1 there once it is behind TLS.
HTTPS_STRICT       0 (default) | 1 — reject plaintext writes with 403 instead
                   of redirecting them. See _handle_plaintext() for why the
                   default is the gentler one.
HSTS_MAX_AGE       seconds, default 31536000 (1 year). Set to 0 to disable.
HSTS_INCLUDE_SUBDOMAINS  1 (default) | 0
HSTS_PRELOAD       0 (default) | 1 — opt-in only; see _hsts_value().
HTTPS_EXEMPT_PATHS comma-separated path prefixes that stay reachable over
                   plaintext (health checks are exempt already).
"""

from __future__ import annotations

import ipaddress
import os
from urllib.parse import urlsplit, urlunsplit

from flask import jsonify, redirect, request

__all__ = ["init_app", "enforcement_enabled", "require_https_base_url", "status"]


def _flag(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on"}


# Health checks come from inside the container over loopback (see the
# Dockerfile HEALTHCHECK and railway.json healthcheckPath). They never touch
# the network, and redirecting them to https would fail the check and put the
# service into a restart loop -- which is how a "security fix" becomes an
# outage.
_DEFAULT_EXEMPT = ("/api/health",)


def _exempt_paths() -> tuple[str, ...]:
    extra = tuple(
        p.strip()
        for p in os.environ.get("HTTPS_EXEMPT_PATHS", "").split(",")
        if p.strip()
    )
    return _DEFAULT_EXEMPT + extra


def enforcement_enabled() -> bool:
    """Should plaintext requests be blocked in this process?"""
    setting = os.environ.get("FORCE_HTTPS", "auto").strip().lower()
    if setting in {"1", "true", "yes", "on"}:
        return True
    if setting in {"0", "false", "no", "off"}:
        return False
    # auto: on for the cloud deployment, off for LAN nodes and laptops.
    return any(key.startswith("RAILWAY_") for key in os.environ)


def _is_loopback(addr: str | None) -> bool:
    if not addr:
        return False
    try:
        return ipaddress.ip_address(addr.split("%")[0]).is_loopback
    except ValueError:
        return False


def _is_internal_request() -> bool:
    """A request that never crossed the network, so nothing can sniff it.

    ProxyFix leaves X-Forwarded-Proto in the headers even after rewriting
    wsgi.url_scheme from it, so its absence is a reliable signal that no
    proxy was involved -- combined with a loopback peer, that is the
    container talking to itself.
    """
    return (
        request.headers.get("X-Forwarded-Proto") is None
        and _is_loopback(request.remote_addr)
    )


def _hsts_value() -> str | None:
    max_age = int(os.environ.get("HSTS_MAX_AGE", "31536000"))
    if max_age <= 0:
        return None
    value = f"max-age={max_age}"
    if _flag("HSTS_INCLUDE_SUBDOMAINS", "1"):
        value += "; includeSubDomains"
    if _flag("HSTS_PRELOAD"):
        # Opt-in because preload is effectively irreversible: once the host is
        # on the browsers' baked-in list, removal takes months to propagate,
        # and combined with includeSubDomains it will break any subdomain you
        # ever want to serve over plaintext. Do not enable it until the
        # certificate story is settled for every subdomain.
        value += "; preload"
    return value


def _handle_plaintext():
    """Called for every request that arrived over http while enforcement is on."""
    target = urlunsplit(("https",) + urlsplit(request.url)[1:])

    if request.method in {"GET", "HEAD", "OPTIONS"}:
        # 308, not 301/302: those let a client downgrade the method to GET on
        # replay. This codebase has already been bitten by exactly that -- see
        # the ProxyFix comment in app.py about heartbeats dying on redirect.
        return redirect(target, code=308)

    if _flag("HTTPS_STRICT"):
        return (
            jsonify(
                success=False,
                error="https_required",
                message="This endpoint refuses plaintext HTTP. Use https://.",
            ),
            403,
        )

    # Default: redirect writes too. A 403 here is the more principled answer
    # -- the body has already leaked, so "try again over TLS" is closing the
    # door after the fact -- but it hard-breaks any node or integration still
    # configured with an http:// base URL, with no warning. The redirect keeps
    # them running while the log below tells you who needs reconfiguring.
    # Fix the callers, then set HTTPS_STRICT=1.
    return redirect(target, code=308)


def init_app(app, logger=None) -> dict:
    """Register the before/after hooks. Safe to call once per app."""

    enabled = enforcement_enabled()
    exempt = _exempt_paths()

    @app.before_request
    def _require_https():  # noqa: ANN202
        if not enabled or request.is_secure or _is_internal_request():
            return None
        if any(request.path.startswith(prefix) for prefix in exempt):
            return None

        if logger is not None:
            # Deliberately does not log the body. The point of the warning is
            # to name the caller that needs reconfiguring, not to write the
            # credentials that just travelled in the clear into your log
            # aggregator, where they would outlive the packet capture.
            logger.warning(
                "Plaintext HTTP request rejected: %s %s from %s (ua=%s). "
                "Anything in that request body was sent unencrypted.",
                request.method,
                request.path,
                request.remote_addr,
                request.headers.get("User-Agent", "?")[:80],
            )
        return _handle_plaintext()

    @app.after_request
    def _add_hsts(response):  # noqa: ANN202
        # Only over TLS. A browser ignores HSTS received over plaintext (RFC
        # 6797 §8.1) precisely because an attacker sitting on that connection
        # could otherwise forge or strip it.
        if request.is_secure:
            value = _hsts_value()
            if value:
                response.headers.setdefault("Strict-Transport-Security", value)
        return response

    state = status()
    if logger is not None:
        logger.info("HTTPS enforcement: %s", state)
    return state


# ---------------------------------------------------------------------------
# Outbound URLs
# ---------------------------------------------------------------------------

_PRIVATE_HOST_SUFFIXES = (".local", ".lan", ".internal")


def _is_private_host(host: str) -> bool:
    host = (host or "").split(":")[0].lower()
    if host in {"localhost", ""} or host.endswith(_PRIVATE_HOST_SUFFIXES):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback


def require_https_base_url(url: str, *, logger=None) -> str:
    """Upgrade an http:// API base URL to https:// before it is stored.

    These values get written into node config files and installer bundles,
    so a single request that arrives over plaintext -- or one operator who
    types the http:// form into the packaging call -- pins a branch to
    unencrypted push-attendance traffic until someone reinstalls it. That is
    the machine-to-machine half of this finding, and no browser-facing
    redirect touches it.

    LAN and loopback hosts are left alone: an on-prem node on 192.168.x.x
    usually has no certificate, and silently rewriting it to https would
    hand out a config that cannot connect at all.
    """
    raw = (url or "").strip().rstrip("/")
    if not raw:
        return raw

    parts = urlsplit(raw)
    if parts.scheme != "http":
        return raw
    if _is_private_host(parts.netloc):
        return raw

    upgraded = urlunsplit(("https",) + parts[1:]).rstrip("/")
    if logger is not None:
        logger.warning(
            "Upgraded plaintext api_base_url %s -> %s before storing it; "
            "a node configured with the http:// form would push attendance "
            "data unencrypted.",
            raw,
            upgraded,
        )
    return upgraded


def status() -> dict:
    return {
        "enforcing": enforcement_enabled(),
        "mode": "strict(403)" if _flag("HTTPS_STRICT") else "redirect(308)",
        "hsts": _hsts_value() or "disabled",
        "exempt": list(_exempt_paths()),
    }
