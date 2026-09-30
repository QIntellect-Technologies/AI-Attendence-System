"""
support_db_licenses.py
─────────────────────────────────────────────────────────────────────────────
On-prem org license tokens.

Deliberately independent of invoices and of support_db_core._compute_org_status
(see the Sep 2026 design decision): an invoice being paid a day late, or
support wanting to grant a non-standard grace window, must never require
touching this table's issuance rule, and vice versa. The only relationship
between a license and an invoice is the optional invoice_id kept for audit
trail — expiry is never derived from it.

Signing itself lives in license_token.py (shared with the local install).
This file is Supabase persistence plus the support-facing operations.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from supabase_client import get_supabase
from support_db_core import _execute_supabase, require_deployment
from support_db_organizations import get_organization
from license_token import issue_license_token, load_private_key
from logger_config import get_logger

logger = get_logger(__name__)

_ARCHIVED_OR_DELETED = {"archived", "deleted"}


def _signing_key():
    pem = os.environ.get("LICENSE_SIGNING_PRIVATE_KEY", "").strip()
    if not pem:
        raise RuntimeError(
            "LICENSE_SIGNING_PRIVATE_KEY is not set. Generate a keypair "
            "(see license_token.py's module docstring) and set the "
            "private half in Railway."
        )
    if "\\n" in pem:
        pem = pem.replace("\\n", "\n")
    return load_private_key(pem)


def issue_org_license(
    org_id: str,
    expires_at: datetime,
    issued_by: str,
    invoice_id: Optional[str] = None,
) -> dict:
    """Mint and persist a new license for an org.

    Support-facing action — deliberately does NOT gate on
    support_db_core._org_access_allows_client: issuing a fresh license to
    a currently-suspended org is exactly how it gets un-suspended, so that
    check would be backwards here. It does still refuse archived/deleted
    orgs, since there is nothing left to license.

    Returns the stored row plus the one-time signed token string under
    "token" — that string is never persisted (org_licenses stores the
    verifiable claims, not the JWT itself) and is not retrievable again
    after this call returns, so the caller (the support route) must hand
    it back to the operator immediately.
    """
    org_key = str(org_id or "").strip()
    if not org_key:
        raise ValueError("org_id is required")

    org = get_organization(org_key)
    status = str(org.get("status") or "").strip().lower()
    if status in _ARCHIVED_OR_DELETED:
        raise ValueError(f"Cannot issue a license for a {status} organization.")
    require_deployment(org, on_prem=True, action="License issuing")

    if expires_at.tzinfo is None:
        raise ValueError("expires_at must be timezone-aware")
    now = datetime.now(timezone.utc)
    if expires_at <= now:
        raise ValueError("expires_at must be in the future")

    jti = str(uuid.uuid4())
    token = issue_license_token(
        _signing_key(),
        org_id=org_key,
        expires_at=int(expires_at.timestamp()),
        jti=jti,
        api_base_url=os.environ.get("RAILWAY_API_BASE_URL") or None,
    )

    # Supersede any currently-active license for this org before inserting
    # the new one, so list_org_licenses/list_licenses_expiring_within never
    # have to reconcile more than one "active" row per org.
    _execute_supabase(
        "supersede_previous_org_licenses",
        lambda: get_supabase()
        .table("org_licenses")
        .update({"status": "superseded"})
        .eq("org_id", org_key)
        .eq("status", "active"),
    )

    payload = {
        "org_id": org_key,
        "jti": jti,
        "expires_at": expires_at.isoformat(),
        "issued_at": now.isoformat(),
        "issued_by": issued_by,
        "invoice_id": invoice_id,
        "status": "active",
    }
    result = _execute_supabase(
        "issue_org_license",
        lambda: get_supabase().table("org_licenses").insert(payload),
    )
    if not result.data:
        raise RuntimeError("Failed to create org license")

    row = result.data[0]
    row["token"] = token
    return row


def list_licenses_expiring_within(days: int) -> list[dict]:
    """Support Dashboard's expiry-alert list. Only ever looks at 'active'
    licenses — a superseded/revoked one expiring soon isn't anyone's
    problem anymore."""
    days = max(0, int(days or 0))
    cutoff = datetime.now(timezone.utc) + timedelta(days=days)

    result = _execute_supabase(
        "list_licenses_expiring_within",
        lambda: get_supabase()
        .table("org_licenses")
        .select("*, organizations(name)")
        .eq("status", "active")
        .lte("expires_at", cutoff.isoformat())
        .order("expires_at", desc=False),
    )
    return result.data or []


def revoke_org_license(license_id: str, revoked_by: str) -> dict:
    """Marks a license row 'revoked' server-side for your own audit
    trail. NOTE: this cannot invalidate a copy of the token already
    sitting on a client's machine — verification is fully offline by
    design (see license_token.py), so a previously-issued token stays
    valid on the local install until its own embedded expiry regardless
    of this call. This is bookkeeping ("we consider this one dead"), not
    a remote kill switch; real revocation would require the local side
    to make a network call, which is the opposite of what this design
    was chosen for."""
    result = _execute_supabase(
        "revoke_org_license",
        lambda: get_supabase()
        .table("org_licenses")
        .update({
            "status": "revoked",
            "revoked_by": revoked_by,
            "revoked_at": datetime.now(timezone.utc).isoformat(),
        })
        .eq("id", license_id)
        .eq("status", "active"),
    )
    if not result.data:
        raise RuntimeError("License not found or already inactive")
    return result.data[0]


def get_active_license_token(org_id: str) -> Optional[str]:
    """Freshly-signed token for the org's current active license, or None
    if none has been issued yet (fail-open — every existing customer,
    until support issues their first license) or the active row has
    already lapsed (support hasn't run an expiry sweep yet; a token
    minted with a past exp would fail verify_license_token() locally
    anyway, so there's nothing useful to hand the node).

    Re-signs from the persisted claims rather than storing the JWT
    itself — org_licenses never persists a raw token (see
    issue_org_license's docstring) — so this reconstructs an equivalent,
    independently-verifiable token on every activation/heartbeat with no
    manual step on either side.
    """
    org_key = str(org_id or "").strip()
    if not org_key:
        return None

    result = _execute_supabase(
        "get_active_license_token",
        lambda: get_supabase()
        .table("org_licenses")
        .select("jti, expires_at")
        .eq("org_id", org_key)
        .eq("status", "active")
        .limit(1),
    )
    if not result.data:
        return None

    row = result.data[0]
    expires_at = datetime.fromisoformat(row["expires_at"])
    if expires_at <= datetime.now(timezone.utc):
        return None

    return issue_license_token(
        _signing_key(),
        org_id=org_key,
        expires_at=int(expires_at.timestamp()),
        jti=row["jti"],
    )


_ACTIVATION_DB_PATH = os.environ.get("LICENSE_ACTIVATION_DB_PATH", os.path.join("data", "license_activations.db"))


def _init_activation_db():
    import sqlite3
    os.makedirs(os.path.dirname(_ACTIVATION_DB_PATH) or ".", exist_ok=True)
    with sqlite3.connect(_ACTIVATION_DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS license_activations (
                jti TEXT PRIMARY KEY,
                node_id TEXT NOT NULL,
                hostname TEXT,
                activated_at TEXT NOT NULL
            )
        """)


def _get_fallback_activation(jti: str) -> Optional[dict]:
    try:
        import sqlite3
        _init_activation_db()
        with sqlite3.connect(_ACTIVATION_DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.execute("SELECT * FROM license_activations WHERE jti = ?", (str(jti).strip(),))
            row = cur.fetchone()
            if row:
                return dict(row)
    except Exception as exc:
        logger.warning("Could not read fallback activation DB: %s", exc)
    return None


def _save_fallback_activation(jti: str, node_id: str, hostname: Optional[str], activated_at: str) -> None:
    try:
        import sqlite3
        _init_activation_db()
        with sqlite3.connect(_ACTIVATION_DB_PATH) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO license_activations (jti, node_id, hostname, activated_at) VALUES (?, ?, ?, ?)",
                (str(jti).strip(), str(node_id).strip(), hostname, activated_at),
            )
    except Exception as exc:
        logger.warning("Could not write fallback activation DB: %s", exc)


def _reset_fallback_activation(jti: str) -> None:
    try:
        import sqlite3
        _init_activation_db()
        with sqlite3.connect(_ACTIVATION_DB_PATH) as conn:
            conn.execute("DELETE FROM license_activations WHERE jti = ?", (str(jti).strip(),))
    except Exception as exc:
        logger.warning("Could not delete from fallback activation DB: %s", exc)


def reset_org_license_activation(license_id: str, reset_by: str) -> dict:
    """Reset the machine claim on a license so it can be re-activated on a new/replacement machine."""
    clean_id = str(license_id or "").strip()
    if not clean_id:
        raise ValueError("license_id is required")

    # Fetch row first to know JTI for fallback reset
    lookup = _execute_supabase(
        "lookup_for_reset_activation",
        lambda: get_supabase().table("org_licenses").select("*").eq("id", clean_id).limit(1),
    )
    jti = lookup.data[0].get("jti") if (lookup.data and len(lookup.data) > 0) else None
    if jti:
        _reset_fallback_activation(jti)

    try:
        result = _execute_supabase(
            "reset_org_license_activation",
            lambda: get_supabase()
            .table("org_licenses")
            .update({
                "activated_node_id": None,
                "activated_at": None,
                "activated_hostname": None,
            })
            .eq("id", clean_id),
        )
        if result.data:
            return result.data[0]
    except Exception as exc:
        logger.warning("Could not clear activation columns on Supabase: %s", exc)

    return lookup.data[0] if (lookup.data and len(lookup.data) > 0) else {"id": clean_id, "status": "active"}


def _resolve_org_single_branch(org_id: str) -> dict:
    """Resolve "the" branch for an org under the current single-branch-per-org
    licensing model. Raises ValueError if none exists yet.

    TODO(multi-branch): see build_node_config_payload / claim_org_license —
    once licenses can be issued per-branch, this resolution goes away and
    the branch_id comes from the license row itself instead of being
    inferred here.
    """
    from support_db_branches import list_branches
    branches = list_branches(org_id)
    if not branches:
        raise ValueError(
            "This organization has no branch configured yet. "
            "Create a branch in Support before issuing/activating a license."
        )
    if len(branches) > 1:
        logger.warning(
            "_resolve_org_single_branch: org %s has %d branches but licensing "
            "is still single-branch-per-org — binding to the earliest-created "
            "branch (%s). Multi-branch licensing is not implemented yet.",
            org_id, len(branches), branches[0].get("id"),
        )
    return branches[0]


def claim_org_license(
    jti: str,
    node_id: str,
    hostname: Optional[str] = None,
    org_id: Optional[str] = None,
) -> dict:
    """One-time machine claim for a signed license token.

    Binds the license (by JTI) to the specific machine's node_id on first activation.
    If already claimed by this node_id, succeeds (idempotent for the same machine).
    If already claimed by a different node_id, raises ValueError preventing multiple machines
    from using the same token.
    """
    jti_clean = str(jti or "").strip()
    node_id_clean = str(node_id or "").strip()
    if not jti_clean:
        raise ValueError("jti is required")
    if not node_id_clean:
        raise ValueError("node_id is required")

    def _query():
        q = get_supabase().table("org_licenses").select("*").eq("jti", jti_clean)
        if org_id:
            q = q.eq("org_id", str(org_id).strip())
        return q.limit(1)

    result = _execute_supabase("claim_org_license_lookup", _query)
    if not result.data:
        raise ValueError("License not found")

    row = result.data[0]
    require_deployment(get_organization(str(row["org_id"])), on_prem=True, action="License activation")
    status = str(row.get("status") or "").strip().lower()
    if status == "revoked":
        raise ValueError("This license has been revoked by Support.")
    if status == "superseded":
        raise ValueError("This license has been superseded by a newer license.")

    expires_at_str = row.get("expires_at")
    if expires_at_str:
        exp_dt = datetime.fromisoformat(str(expires_at_str).replace("Z", "+00:00"))
        if exp_dt <= datetime.now(timezone.utc):
            raise ValueError("This license has expired.")

    # Check activation state from Supabase or fallback store
    fallback_act = _get_fallback_activation(jti_clean) or {}
    existing_claimed_node = str(row.get("activated_node_id") or fallback_act.get("node_id") or "").strip()
    existing_hostname = str(row.get("activated_hostname") or fallback_act.get("hostname") or "").strip()
    now_iso = datetime.now(timezone.utc).isoformat()

    # If already claimed by another machine:
    if existing_claimed_node and existing_claimed_node != node_id_clean:
        host_msg = f" (Host: {existing_hostname})" if existing_hostname else ""
        raise ValueError(
            f"This license token has already been activated on another machine{host_msg}. "
            "Contact Support to transfer this license."
        )

    # Save to fallback activation store
    _save_fallback_activation(jti_clean, node_id_clean, hostname, row.get("activated_at") or now_iso)

    # Attempt Supabase update
    update_payload = {
        "activated_node_id": node_id_clean,
        "activated_at": row.get("activated_at") or now_iso,
        "activated_hostname": hostname or row.get("activated_hostname") or None,
    }

    try:
        update_res = _execute_supabase(
            "claim_org_license_update",
            lambda: get_supabase()
            .table("org_licenses")
            .update(update_payload)
            .eq("id", row["id"]),
        )
        if update_res.data:
            row = update_res.data[0]
    except Exception as exc:
        logger.warning("Could not persist activation columns on org_licenses: %s", exc)

    org_id_val = str(row.get("org_id") or org_id_clean or "").strip()
    org_details: dict = {}
    branch: dict = {}
    if org_id_val:
        try:
            org_details = get_organization(org_id_val)
        except Exception:
            pass
        branch = _resolve_org_single_branch(org_id_val)

    from support_db_organizations import build_node_config_payload
    payload = build_node_config_payload(org_details, branch)

    return {
        "success": True,
        "message": "License successfully activated on this node.",
        "license_id": row.get("id"),
        "org_id": org_id_val,
        "organization_id": org_id_val,
        **payload,
        "jti": row.get("jti"),
        "activated_node_id": node_id_clean,
        "activated_hostname": hostname,
        "activated_at": row.get("activated_at") or now_iso,
    }


def check_license_status(jti: str, org_id: Optional[str] = None) -> dict:
    """Check the status of a specific license by its JTI and optional org_id.
    Returns status: 'active', 'revoked', 'superseded', 'expired', or 'not_found'.

    This is the ONE network round-trip an activated node already makes on
    every dashboard request (local_node/license_check.py's
    check_remote_revocation, called from current_status()). Rather than add
    a second mechanism (heartbeat + node_api_key) just to refresh org/branch
    config, this response also carries the current config bundle — the node
    re-persists it locally whenever this call succeeds. See
    local_node/license_check.py for the throttling that keeps this from
    hitting the backend on literally every request.
    """
    jti_clean = str(jti or "").strip()
    if not jti_clean:
        return {"status": "not_found", "is_revoked": False, "is_active": False}

    def _query():
        q = get_supabase().table("org_licenses").select("*").eq("jti", jti_clean)
        if org_id:
            q = q.eq("org_id", str(org_id).strip())
        return q.limit(1)

    result = _execute_supabase("check_license_status", _query)
    if not result.data:
        return {"status": "not_found", "is_revoked": False, "is_active": False}

    row = result.data[0]
    status = str(row.get("status") or "").strip().lower()
    is_revoked = status == "revoked"
    is_active = status == "active"

    fallback_act = _get_fallback_activation(jti_clean) or {}
    act_node = row.get("activated_node_id") or fallback_act.get("node_id")
    act_host = row.get("activated_hostname") or fallback_act.get("hostname")
    act_at = row.get("activated_at") or fallback_act.get("activated_at")

    response = {
        "status": status,
        "is_revoked": is_revoked,
        "is_active": is_active,
        "org_id": row.get("org_id"),
        "jti": row.get("jti"),
        "expires_at": row.get("expires_at"),
        "revoked_at": row.get("revoked_at"),
        "revoked_by": row.get("revoked_by"),
        "activated_node_id": act_node,
        "activated_hostname": act_host,
        "activated_at": act_at,
    }

    org_id_val = str(row.get("org_id") or "").strip()
    if is_active and org_id_val:
        try:
            from support_db_organizations import get_organization, build_node_config_payload
            org_details = get_organization(org_id_val)
            branch = _resolve_org_single_branch(org_id_val)
            response["config"] = build_node_config_payload(org_details, branch)
        except Exception as exc:
            # Config refresh is a bonus riding on this call — never let it
            # turn a valid, active license into a failed status check.
            logger.warning("check_license_status: could not refresh config for org %s: %s", org_id_val, exc)

    return response


def list_org_licenses(org_id: str) -> list[dict]:
    org_key = str(org_id or "").strip()
    if not org_key:
        raise ValueError("org_id is required")
    result = _execute_supabase(
        "list_org_licenses",
        lambda: get_supabase()
        .table("org_licenses")
        .select("*")
        .eq("org_id", org_key)
        .order("issued_at", desc=True),
    )
    rows = result.data or []
    for row in rows:
        jti = str(row.get("jti") or "").strip()
        if jti:
            fb = _get_fallback_activation(jti) or {}
            if fb:
                if not row.get("activated_node_id"):
                    row["activated_node_id"] = fb.get("node_id")
                if not row.get("activated_hostname"):
                    row["activated_hostname"] = fb.get("hostname")
                if not row.get("activated_at"):
                    row["activated_at"] = fb.get("activated_at")
    return rows