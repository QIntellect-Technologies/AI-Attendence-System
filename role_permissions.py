"""
role_permissions.py
──────────────────────────────────────────────────────────────────────────────
Single source of truth for what a Client Dashboard account role can do.

Consumed by BOTH login paths in client_dashboard_auth.mint_dashboard_token —
client_users (admin-only, Support-provisioned owner seat) and client_staff
(staff/admin, self-service directory accounts promoted via Staff
Management). The two tables stay separate (different provisioning,
different lifecycle owners) but a given role name means the same thing,
carries the same is_admin/access_modules grant, regardless of which table
the caller's row lives in.

Two-tier by design: 'admin' is the only account-lifecycle tier (can manage
other accounts — create/delete/restore staff, reset passwords, grant admin
to others) and gets every purchased module ('*'). Everyone else is 'staff'
— a person's actual job title (free text, see client_staff.role_name) and
their specific module access (client_staff.access_modules, picked directly
per person in Staff Management) are deliberately NOT derived from role.
There used to be hr/manager/employee tiers standing in for preset module
bundles; that coupling is what made per-org custom roles (e.g. a "Finance"
staffer with only Payroll access) impossible, so it was removed in favor of
picking modules explicitly.

Do not duplicate this mapping elsewhere (AuthContext.tsx's normaliseUser
should read dashboard_scope/access_modules the backend already derived from
here, not re-hardcode per-role branches) — one place decides what a role can
do; every consumer just reads the result off the token/session payload.
"""

from typing import TypedDict


class RoleCapabilities(TypedDict):
    is_admin: bool
    # '*' means every module the org has enabled; otherwise an explicit list
    # of module keys (see moduleRegistry.ts for the canonical key set).
    access_modules: object


# Ordered roughly by privilege, most to least — used by _ROLE_RANK below.
ROLE_CAPABILITIES: dict[str, RoleCapabilities] = {
    "admin": {
        "is_admin": True,
        "access_modules": "*",
    },
    "staff": {
        "is_admin": False,
        # No implied modules — a staff row's real access comes from its own
        # access_modules column (set explicitly per person in Staff
        # Management), not from this role-level default. This stays [] as
        # a safe "nothing until explicitly granted" floor for rows that
        # somehow have neither an explicit grant nor a role match.
        "access_modules": [],
    },
}

DEFAULT_ROLE = "staff"

# Roles a caller must already hold to grant a given target role to someone
# else. Only an existing admin may mint a new admin — this is the one
# account-lifecycle boundary in the system. 'staff' requires no special
# grantor tier (matches the actual runtime gate in
# support_db_staff.create_client_staff/update_client_staff, which only
# special-cases account_role == 'admin'). Keep this in lockstep with
# ROLE_CAPABILITIES: every key in ROLE_CAPABILITIES must have an entry here.
_GRANTABLE_BY: dict[str, set[str]] = {
    "admin": {"admin"},
    "staff": {"admin", "staff"},
}


def normalize_role(value: object, fallback: str = DEFAULT_ROLE) -> str:
    role = str(value or fallback).strip().lower()
    return role if role in ROLE_CAPABILITIES else fallback


def capabilities_for(role: object) -> RoleCapabilities:
    return ROLE_CAPABILITIES[normalize_role(role)]


def can_grant_role(*, granter_role: object, target_role: object) -> bool:
    """True if an account holding granter_role may set someone else's role
    to target_role. Used when creating/updating a client_staff row's
    account_role, and when inviting/changing a client_users role.

    An unrecognized target_role normalizes to the default ('staff'), which
    every eligible granter can assign — unknown input never accidentally
    requires admin.
    """
    granter = normalize_role(granter_role)
    target = normalize_role(target_role)
    return granter in _GRANTABLE_BY[target]
