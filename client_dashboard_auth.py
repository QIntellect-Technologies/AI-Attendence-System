"""
client_dashboard_auth.py
──────────────────────────────────────────────────────────────────────────────
JWT auth for the desktop Client Dashboard (org-admin/HR/manager audience).

Two tables can log into this dashboard today — client_users (admin/HR
accounts) and client_staff (e.g. a manager given dashboard access under
their "Manager" hat, per StaffManagement's dashboard toggle). Both go
through this ONE module so a route enforcing team-scope doesn't need to
know which table the caller came from — it just reads g.dashboard_user.

Deliberately separate from:
  client_staff_auth.py   -> mobile employee/field-staff portal (different
                             audience, different secret: CLIENT_STAFF_JWT_SECRET)
  support_auth.py         -> internal Support Dashboard (internal_users)

  Token                  Signed with                  Identifies
  --------------------   --------------------------   ---------------------
  Client Dashboard       CLIENT_DASHBOARD_JWT_SECRET   client_users OR
  token                                                client_staff, desktop
                                                        audience, org+branch
                                                        scoped
  Client staff (mobile)  CLIENT_STAFF_JWT_SECRET       client_staff, mobile
  token                                                audience only
  Support token          SUPPORT_JWT_SECRET            internal_users

Three separate secrets on purpose — a leaked token from one surface must
never be replayable against another. Never reuse one of these envs for
another module.

Row-scope contract this token exists to enforce:
  dashboard_scope == 'branch' -> route sees everything in org_id/branch_id,
                                  same as today, no filtering added.
  dashboard_scope == 'team'   -> route MUST intersect its result set against
                                  get_team_scope_ids(payload) before
                                  returning anything. The token carries
                                  staff_id (sub) + manager tree membership
                                  is resolved server-side per request via
                                  support_db_hierarchy.get_subordinate_ids —
                                  never trust a client-supplied staff/user id
                                  list for this.
  Payroll / salary routes ignore dashboard_scope entirely (unscoped) even
  for 'team' accounts — a manager's reporting-hierarchy visibility is not
  the same grant as compensation visibility. Enforce that at the route,
  not here; this module only tells you WHO is asking.

Flow:
  POST /api/login                  -> verify credentials (client_users OR
                                       client_staff) -> signed JWT, returned
                                       alongside the existing user payload.
  @require_client_dashboard_auth   -> decorator validating JWT on every
                                       subsequent dashboard request, sets
                                       g.dashboard_user.

Rollout note: existing sessions have no token (pre-migration localStorage).
Routes wrapped with @require_client_dashboard_auth will 401 those sessions
until they re-login — this was the agreed trade (forced one-time re-login),
not a bug.
"""

import os
from datetime import datetime, timedelta, timezone
from functools import wraps
from typing import Optional

import jwt
from flask import request, jsonify, g

from logger_config import get_logger
from role_permissions import capabilities_for

logger = get_logger(__name__)

_JWT_SECRET = None
_JWT_ALGORITHM = 'HS256'

# Desktop dashboard sessions are short relative to the mobile portal's 30
# days (client_staff_auth.py) — an admin/manager screen left open on a
# shared office machine is a bigger blast-radius risk than a field worker's
# phone. Matches the Support Dashboard's posture (support_auth.py: 8h),
# widened slightly since dashboard users aren't re-authenticating against a
# VPN/SSO layer the way internal Support staff are.
_TOKEN_TTL_HOURS = 12

_VALID_SCOPES = {"branch", "team"}
_VALID_ACCOUNT_TYPES = {"client_user", "client_staff", "legacy"}


def _get_jwt_secret() -> str:
    global _JWT_SECRET
    if _JWT_SECRET is None:
        secret = os.environ.get('CLIENT_DASHBOARD_JWT_SECRET', '').strip()
        if not secret or len(secret) < 32:
            raise RuntimeError(
                'CLIENT_DASHBOARD_JWT_SECRET must be set in env and be at least 32 '
                'characters, and must NOT equal CLIENT_STAFF_JWT_SECRET or '
                'SUPPORT_JWT_SECRET. Generate one with: '
                'python -c "import secrets; print(secrets.token_hex(32))"'
            )
        _JWT_SECRET = secret
    return _JWT_SECRET


def _normalize_scope(value) -> str:
    text = str(value or "").strip().lower()
    return text if text in _VALID_SCOPES else "branch"


def mint_dashboard_token(
    user: dict,
    *,
    account_type: str,
    access_modules: Optional[list] = None,
    dashboard_scope: Optional[str] = None,
    manager_id: Optional[str] = None,
    is_admin: Optional[bool] = None,
) -> str:
    """Sign a JWT for an authenticated Client Dashboard user.

    account_type: 'client_user' | 'client_staff' — which table `user` came
    from. Callers (the /api/login route) pass this explicitly rather than
    this function guessing from the row shape, so a client_staff row that
    happens to have every client_users column populated can never be
    misclassified.

    dashboard_scope defaults to 'branch' (today's behavior — sees
    everything in org_id/branch_id) so accounts that have never had scope
    explicitly set keep working unchanged after this migration lands.

    manager_id is only meaningful for account_type='client_staff' with
    dashboard_scope='team' — it's the anchor get_team_scope_ids walks down
    from. Omit/None for client_users (always admin) and for 'branch' scope.

    is_admin / access_modules: when omitted (None), BOTH are derived from
    role_permissions.capabilities_for(user.get('role')) — this is the one
    source of truth for what a role can do, shared by client_users and
    client_staff alike (see role_permissions.py). This means a client_staff
    row promoted to role='admin' via Staff Management now genuinely gets
    is_admin=True here, same as a Support-invited client_users admin.
    Account-lifecycle routes (delete/restore/purge/reset-another-user's-
    password) gate on this via @require_client_dashboard_admin — write-time
    enforcement of WHO may promote someone to 'admin' lives in
    role_permissions.can_grant_role, checked before the row is ever saved,
    not here. Pass an explicit is_admin/access_modules only for the
    'legacy' SQLite path, whose role vocabulary predates role_permissions.
    """
    if account_type not in _VALID_ACCOUNT_TYPES:
        raise ValueError(f"account_type must be one of {sorted(_VALID_ACCOUNT_TYPES)}")

    org_id = user.get('org_id') or user.get('organization_id')
    if not org_id:
        raise ValueError("Cannot mint a dashboard token for a user with no org_id")

    role_caps = capabilities_for(user.get('role'))
    resolved_is_admin = role_caps['is_admin'] if is_admin is None else bool(is_admin)

    # access_modules stays a plain list on the wire, never role_caps' '*'
    # sentinel literally — an admin's unrestricted access already comes
    # from is_admin/is_admin-gated routes and the org's purchased-module
    # list (moduleAccess.ts), which this JWT claim was never meant to
    # replace. The role default below only fills in when the row itself
    # has no explicit access_modules configured (e.g. a brand-new staff
    # row before anyone has hand-picked their modules in Staff
    # Management) — an explicitly configured list on the row always wins.
    if access_modules is not None:
        resolved_access_modules = access_modules
    elif user.get('access_modules') is not None:
        resolved_access_modules = user.get('access_modules')
    elif role_caps['access_modules'] == '*':
        resolved_access_modules = []
    else:
        resolved_access_modules = role_caps['access_modules']

    now = datetime.now(timezone.utc)
    payload = {
        'sub':              str(user['id']),
        'account_type':     account_type,
        'org_id':           str(org_id),
        'branch_id':        str(user['branch_id']) if user.get('branch_id') else None,
        'access_modules':   resolved_access_modules,
        'dashboard_scope':  _normalize_scope(dashboard_scope if dashboard_scope is not None
                                              else user.get('dashboard_scope')),
        'manager_id':       str(manager_id) if manager_id else None,
        'is_admin':         resolved_is_admin,
        'iat':              now,
        'exp':              now + timedelta(hours=_TOKEN_TTL_HOURS),
    }
    return jwt.encode(payload, _get_jwt_secret(), algorithm=_JWT_ALGORITHM)


def _decode_token(token: str) -> dict:
    return jwt.decode(token, _get_jwt_secret(), algorithms=[_JWT_ALGORITHM])


# Commercial/lifecycle gate. Deliberately *not* imported at module top:
# support_db_core imports the supabase client which pulls in config, and
# this module is imported by app.py before that chain is ready — same
# circular-import reason the hierarchy_db imports below are function-local.
#
# Enforced per-request, not just at login, because dashboard tokens live
# 12h: archiving an org must lock out sessions already in flight, not only
# block the next login. _compute_org_status is TTL-cached (60s) and
# archive/restore invalidate that cache, so this costs one dict lookup on
# the hot path.
def _org_access_blocked_response():
    """Return a 403 tuple if the caller's org may not use the client
    dashboard, else None."""
    from support_db_core import _compute_org_status, _org_access_allows_client

    org_id = (g.dashboard_user or {}).get('org_id')
    if not org_id:
        return None

    try:
        status = _compute_org_status(str(org_id))
    except Exception:
        # Fail open on a transient Supabase error: a lookup failure must
        # not lock every tenant out of their dashboard. The org-scoping
        # guarantees above still hold regardless of commercial status.
        logger.exception('Org status lookup failed for org_id=%s', org_id)
        return None

    if _org_access_allows_client(status):
        return None

    messages = {
        'archived': 'This organization has been archived. Contact QIntellect Support.',
        'deleted': 'This organization no longer exists. Contact QIntellect Support.',
        'suspended': 'Access is suspended due to an unpaid invoice. Contact QIntellect Support.',
    }
    return jsonify({
        'success': False,
        'error': messages.get(status, 'This organization is not active.'),
        'code': 'ORG_ACCESS_BLOCKED',
        'organization_status': status,
    }), 403


# ─── Auth decorator ───────────────────────────────────────────────────────────

def require_client_dashboard_auth(f):
    """
    Decorator for every scope-sensitive Client Dashboard route (Staff
    Management list, attendance list, /api/leaves, /api/overtime, and any
    future route where "team" scope must be enforceable).

    Reads Bearer token from Authorization header. Sets g.dashboard_user =
    { id, account_type, org_id, branch_id, access_modules, dashboard_scope,
    manager_id } for the request lifecycle.

    Critically: org_id/branch_id/user_id read from a query string are NEVER
    trusted for scoping once a route wears this decorator — the route must
    read those three from g.dashboard_user instead. A token minted for one
    org can never be used to read another org's data by editing the query
    string, the same guarantee client_staff_auth.py already gives the
    mobile portal.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            return jsonify({'success': False, 'error': 'Authorization header required'}), 401

        token = auth_header[7:]
        try:
            payload = _decode_token(token)
        except jwt.ExpiredSignatureError:
            return jsonify({'success': False, 'error': 'Session expired. Please log in again.'}), 401
        except jwt.PyJWTError:
            return jsonify({'success': False, 'error': 'Invalid session token.'}), 401

        g.dashboard_user = {
            'id':               payload['sub'],
            'account_type':     payload.get('account_type'),
            'org_id':           payload['org_id'],
            'branch_id':        payload.get('branch_id'),
            'access_modules':   payload.get('access_modules') or [],
            'dashboard_scope':  _normalize_scope(payload.get('dashboard_scope')),
            'manager_id':       payload.get('manager_id'),
            'is_admin':         bool(payload.get('is_admin', False)),
        }

        blocked = _org_access_blocked_response()
        if blocked is not None:
            return blocked

        return f(*args, **kwargs)

    return decorated


def require_client_dashboard_admin(f):
    """Same contract as @require_client_dashboard_auth, plus: the caller's
    token must carry is_admin=True (baked in at login — see
    mint_dashboard_token). Composes the base decorator rather than
    re-parsing the Authorization header, so there is exactly one place
    that ever decodes this JWT.

    Use this for account-lifecycle actions with org-wide blast radius:
    delete/restore/permanent-purge of a staff or user record, resetting
    another user's password, bulk operations. Do NOT use it for routes
    that only read data scoped to the caller's own org/branch/team — those
    stay on the plain @require_client_dashboard_auth.
    """
    @require_client_dashboard_auth
    @wraps(f)
    def decorated(*args, **kwargs):
        if not g.dashboard_user.get('is_admin'):
            return jsonify({
                'success': False,
                'error': 'Admin privileges required for this action.',
            }), 403
        return f(*args, **kwargs)

    return decorated


# ─── Scope resolution ─────────────────────────────────────────────────────────

def get_team_scope_ids(dashboard_user: dict) -> Optional[set]:
    """Returns the set of client_staff ids a 'team'-scoped caller may see,
    or None if the caller is unscoped ('branch' scope, or a client_user —
    admin/HR accounts are always org/branch-wide, dashboard_scope only
    applies to client_staff-as-manager accounts).

    None means "do not filter" — callers must treat None as "no
    restriction", never as "empty result". An empty team (manager with zero
    reports) is a real, distinct value: set() — and must filter results
    down to nothing, not fall through to unscoped.

    Deliberately EXCLUDES the caller's own id. A 'team'-scoped desktop
    session is a management view of other people's records, not a personal
    self-service surface — that already exists separately, on the mobile
    client_staff portal (client_staff_auth.py: /api/staff/me, /attendance/*).
    Including the caller's own row here would let a manager view/edit their
    own client_staff row (access_modules, salary, dashboard_scope, ...)
    through the same Staff Management screen they use to manage their
    reports — a privilege-escalation surface, not a feature. A manager's
    own record is visible to whoever manages *them* (their own manager,
    resolved the same way one level up) or to an org/branch admin
    (client_user, always unscoped) — never to themselves in 'team' mode.

    Deliberately takes g.dashboard_user (already-decoded, server-trusted)
    rather than staff_id from a query param — this is the one function
    every scope-sensitive route calls, so keeping its input shape locked to
    "decoded token" makes it structurally impossible for a route to
    accidentally pass through a client-supplied id here instead.
    """
    if dashboard_user.get('account_type') != 'client_staff':
        return None
    if dashboard_user.get('dashboard_scope') != 'team':
        return None

    # Anchor on the CALLER's own id, not dashboard_user['manager_id'] (that
    # field is who the caller themself reports to — using it here would
    # compute the caller's peer group under their own boss instead of the
    # caller's own reports, for anyone who has a manager assigned).
    caller_id = dashboard_user.get('id')
    if not caller_id:
        return set()

    # Imported here, not at module top, to avoid a circular import: this
    # module has no other dependency on support_db_hierarchy today, and
    # that module doesn't need to know about JWTs.
    import support_db_hierarchy as hierarchy_db

    org_id = dashboard_user['org_id']
    subordinate_ids = hierarchy_db.get_subordinate_ids(org_id, caller_id)
    return set(subordinate_ids)


_VALID_REQUESTED_VIEWS = {"team", "branch"}


def _normalize_requested_view(value) -> Optional[str]:
    text = str(value or "").strip().lower()
    return text if text in _VALID_REQUESTED_VIEWS else None


def get_effective_scope_ids(
    dashboard_user: dict,
    requested_view: Optional[str] = None,
) -> Optional[set]:
    """Resolves the id set a route should filter rows against, folding the
    mandatory dashboard_scope='team' restriction (get_team_scope_ids)
    together with an OPTIONAL, additive "My Team" convenience toggle for
    'branch'-scoped managers.

    This is the single call every scope-sensitive route should now make in
    place of a bare get_team_scope_ids(dashboard_user) call — it is a
    strict superset of that function's contract (dashboard_scope='team'
    behaves identically to before, byte-for-byte), so existing callers can
    switch over with no behavior change unless they also start passing
    requested_view.

    requested_view is a display-preference HINT ONLY ('team' | 'branch' |
    None) — typically read straight from request.args.get('view'). It is
    NEVER used to select whose ids get returned; the id set itself always
    comes from get_subordinate_ids(org_id, dashboard_user['id']), the
    caller's own verified identity, exactly like get_team_scope_ids. A
    caller cannot use this argument to see anyone else's team: passing
    view=team for an account with zero direct reports simply yields an
    empty result set (their own, real, empty team), never another
    manager's.

    Resolution:
      dashboard_scope == 'team'  -> ALWAYS the mandatory team_scope_ids,
                                     regardless of requested_view. A
                                     'team'-scoped account has no
                                     'branch'-wide state to opt back into;
                                     requesting view=branch is silently
                                     ignored (fail closed to the narrower
                                     view, not fail open to unscoped).
      dashboard_scope == 'branch'
        + requested_view == 'team' -> voluntary self-anchored narrowing:
                                     get_subordinate_ids(org_id, caller_id).
                                     Safe because it can only ever return a
                                     subset of what this caller already
                                     sees unscoped.
      otherwise                    -> None (unscoped — today's behavior,
                                     unchanged).
    """
    mandatory_team_scope = get_team_scope_ids(dashboard_user)
    if mandatory_team_scope is not None:
        return mandatory_team_scope

    if dashboard_user.get('account_type') != 'client_staff':
        return None
    if _normalize_requested_view(requested_view) != 'team':
        return None

    caller_id = dashboard_user.get('id')
    if not caller_id:
        return set()

    import support_db_hierarchy as hierarchy_db

    org_id = dashboard_user['org_id']
    subordinate_ids = hierarchy_db.get_subordinate_ids(org_id, caller_id)
    return set(subordinate_ids)


def filter_rows_by_scope(rows: list, scope_ids: Optional[set], *id_keys: str) -> list:
    """Shared post-filter for routes whose underlying query can't easily
    push team-scope down into Supabase itself (mixed id-key shapes across
    /api/leaves, /api/overtime, attendance, staff-list).

    scope_ids=None -> rows returned unchanged (unscoped caller).
    id_keys are tried in order per row; first present non-empty key wins —
    e.g. filter_rows_by_scope(rows, ids, "staff_id", "user_id", "id").

    A row matching none of id_keys is EXCLUDED, not passed through — a
    scope-sensitive route must never leak a row it couldn't classify.
    """
    if scope_ids is None:
        return rows
    filtered = []
    for row in rows:
        row_id = None
        for key in id_keys:
            value = row.get(key)
            if value:
                row_id = str(value)
                break
        if row_id is not None and row_id in scope_ids:
            filtered.append(row)
    return filtered