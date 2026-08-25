"""
client_routes_helpers.py
──────────────────────────────────────────────────────────────────────────────
Shared Flask response/error/org-id helpers for client-facing blueprints.

Extracted out of client_shift_routes.py (which originally defined these
inline) so client_attendance_settings_routes.py doesn't redefine the same
~20 lines. Both blueprints import from here — this module has no Flask
route registration of its own, just plain functions, so importing it never
creates a second blueprint or route collision.
"""
from __future__ import annotations

from flask import g, jsonify, request

from support_db_shift_overlap import ShiftConflictError


def ok(data: dict, status: int = 200):
    """Uniform success envelope: {"success": true, ...data}."""
    return jsonify({"success": True, **data}), status


def err(message: str, status: int = 400):
    """Uniform error envelope. Both 'error' and 'message' are populated
    since existing frontend call sites read either key."""
    return jsonify({"success": False, "error": message, "message": message}), status


def conflict(message: str, conflicts: list[dict]):
    """409 for a request that is well-formed but collides with existing
    state. Carries the machine-readable `conflicts` list alongside the same
    error/message keys every other response uses, so a client that doesn't
    know about conflicts still shows a sensible message."""
    return (
        jsonify({
            "success": False,
            "error": message,
            "message": message,
            "conflicts": conflicts,
        }),
        409,
    )


def handle(fn):
    """Run a route's inner _run() closure with consistent error mapping.

    ShiftConflictError -> 409 (well-formed but collides with an existing
                  shift; carries a structured `conflicts` list). Checked
                  before ValueError because it subclasses it — a bare
                  `except ValueError` first would swallow it into a 400 and
                  drop the payload.
    ValueError -> 400 (validation / not-found-scoped-to-org, raised
                  deliberately by support_db_* functions)
    RuntimeError -> 500 (Supabase write returned no data)
    anything else -> 500, generic message (never leak internals to the client)
    """
    try:
        return fn()
    except ShiftConflictError as e:
        return conflict(str(e), e.to_payload())
    except ValueError as e:
        return err(str(e), 400)
    except RuntimeError as e:
        return err(str(e), 500)
    except Exception:
        return err("Internal server error", 500)


def dashboard_org_id() -> str:
    """org_id for every /api/client/* route, resolved from the verified
    Client Dashboard token (g.dashboard_user, set by
    @require_client_dashboard_auth) — never from a client-supplied query
    param or JSON body.

    Replaces the former require_org_id()/require_org_id_from_payload()
    pair, which read organization_id straight off the request with no
    identity check behind it: any caller could name any org and reach
    this file family's business logic (including shift-overlap conflict
    detection) unauthenticated, surfacing as a stray 409/400 instead of
    the 401 an unauthenticated request should get. Every route in this
    file family must carry @require_client_dashboard_auth so
    g.dashboard_user is populated before this is called.
    """
    return str(g.dashboard_user["org_id"])