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

from flask import jsonify, request


def ok(data: dict, status: int = 200):
    """Uniform success envelope: {"success": true, ...data}."""
    return jsonify({"success": True, **data}), status


def err(message: str, status: int = 400):
    """Uniform error envelope. Both 'error' and 'message' are populated
    since existing frontend call sites read either key."""
    return jsonify({"success": False, "error": message, "message": message}), status


def handle(fn):
    """Run a route's inner _run() closure with consistent error mapping.

    ValueError -> 400 (validation / not-found-scoped-to-org, raised
                  deliberately by support_db_* functions)
    RuntimeError -> 500 (Supabase write returned no data)
    anything else -> 500, generic message (never leak internals to the client)
    """
    try:
        return fn()
    except ValueError as e:
        return err(str(e), 400)
    except RuntimeError as e:
        return err(str(e), 500)
    except Exception:
        return err("Internal server error", 500)


def require_org_id() -> str:
    """For GET routes: org_id travels as a query param, with a JSON-body
    fallback for clients that also send it there."""
    org_id = (
        request.args.get("organization_id")
        or request.args.get("org_id")
        or (request.get_json(silent=True) or {}).get("organization_id")
    )
    if not org_id:
        raise ValueError("organization_id is required")
    return str(org_id)


def require_org_id_from_payload(payload: dict) -> str:
    """For POST/PATCH routes: org_id travels in the already-parsed JSON body.
    Takes the payload explicitly rather than re-parsing request.get_json()
    a second time in the same request."""
    org_id = str(payload.get("organization_id") or payload.get("org_id") or "").strip()
    if not org_id:
        raise ValueError("organization_id is required")
    return org_id