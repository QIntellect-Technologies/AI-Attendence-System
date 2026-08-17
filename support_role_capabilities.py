"""
support_role_capabilities.py
───────────────────────────────────────────────────────────────────────────────
Support Dashboard role capabilities.

Two roles only. Anything not listed for a role is denied.

  super_admin — full control of the support platform
  billing     — invoices, plus read access to organizations for context

Billing deliberately gets orgs:read but not orgs:write/lifecycle: an invoice
is meaningless without knowing which customer it belongs to, but marking an
invoice paid already restores a suspended org, so billing never needs
archive/restore to unblock a client.

Mirrors role_permissions.py on the client side. The nav gate in
SupportLayout.tsx echoes this map for display; THIS FILE is the enforcement
point — a hidden nav item is a UX nicety, the capability check is the control.
"""

SUPPORT_ROLES = ('super_admin', 'billing')

_CAPABILITIES = {
    'super_admin': {
        'orgs:read', 'orgs:write', 'orgs:lifecycle', 'orgs:delete',
        'branches:read', 'branches:write',
        'invoices:read', 'invoices:write',
        'modules:read', 'modules:write',
        'nodes:read',
        'internal_users:read', 'internal_users:write',
    },
    'billing': {
        'orgs:read',
        'invoices:read', 'invoices:write',
    },
}


def capabilities_for(role) -> set:
    """Return the capability set for a role. Unknown role -> empty set."""
    return set(_CAPABILITIES.get(str(role or '').strip().lower(), set()))


def role_has(role, capability: str) -> bool:
    return capability in capabilities_for(role)