"""
license_token.py
─────────────────────────────────────────────────────────────────────────────
Signs and verifies on-prem org license tokens (Ed25519 / JWT).

Dependency-light and side-effect-free on purpose: no Supabase, no Flask, no
SQLite. This exact file is shared verbatim between the backend (which only
ever calls issue_license_token) and the on-prem local app (which only ever
calls verify_license_token) — see support_db_nodes.py for how it gets
delivered into the local node via activation/heartbeat.

Trust model:
  - One Ed25519 keypair for the whole system, not one per org/client.
  - The PRIVATE key lives only on the backend (env var). It signs tokens.
  - The PUBLIC key is a constant, safe to embed in every local install.
    Verifying a token never requires network access or the private key.
  - A token proves exactly one thing: "the holder of the private key
    vouches that <org_id> is licensed until <expires_at>". It carries no
    other authority — it is not a session token or an API key.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from typing import Optional

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

_ALGORITHM = "EdDSA"
_ISSUER = "qintellect-license"


class LicenseTokenError(Exception):
    """Base class for every failure below. Callers that only care about
    'valid or not' can catch this one type."""


class LicenseTokenExpired(LicenseTokenError):
    pass


class LicenseTokenInvalid(LicenseTokenError):
    """Bad signature, malformed token, wrong issuer, or org_id mismatch."""


@dataclass(frozen=True)
class LicenseTokenPayload:
    org_id: str
    jti: str
    issued_at: int
    expires_at: int
    api_base_url: Optional[str] = None


# ─── Key loading ────────────────────────────────────────────────────────────
# Both sides load keys from PEM text (env var on the backend, a baked-in
# constant on the local install) rather than raw bytes, so the same
# openssl/cryptography-generated PEM files work unmodified in both places.

def load_private_key(pem: str) -> Ed25519PrivateKey:
    key = serialization.load_pem_private_key(pem.encode("utf-8"), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError("Expected an Ed25519 private key")
    return key


def load_public_key(pem: str) -> Ed25519PublicKey:
    key = serialization.load_pem_public_key(pem.encode("utf-8"))
    if not isinstance(key, Ed25519PublicKey):
        raise ValueError("Expected an Ed25519 public key")
    return key


# ─── Issuing (backend only) ─────────────────────────────────────────────────

def issue_license_token(
    private_key: Ed25519PrivateKey,
    *,
    org_id: str,
    expires_at: int,
    jti: Optional[str] = None,
    api_base_url: Optional[str] = None,
) -> str:
    """Mint a signed token. expires_at is a Unix timestamp (UTC) — pass
    int(expires_at_datetime.timestamp()). The caller (support_db_licenses.py)
    is responsible for persisting jti alongside the org; this function
    never touches a database."""
    org_key = str(org_id or "").strip()
    if not org_key:
        raise ValueError("org_id is required")

    now = int(time.time())
    if expires_at <= now:
        raise ValueError("expires_at must be in the future")

    token_id = jti or str(uuid.uuid4())
    payload = {
        "iss": _ISSUER,
        "org_id": org_key,
        "jti": token_id,
        "iat": now,
        "exp": expires_at,
        "api_base_url": api_base_url,
    }
    return jwt.encode(payload, private_key, algorithm=_ALGORITHM)


# ─── Verifying (local install only) ─────────────────────────────────────────

def verify_license_token(
    token: str,
    public_key: Ed25519PublicKey,
    *,
    expected_org_id: Optional[str] = None,
) -> LicenseTokenPayload:
    """Verify signature + expiry + org binding (if expected_org_id given), fully offline.
    Raises LicenseTokenExpired or LicenseTokenInvalid on any failure — never returns a
    payload for a token that shouldn't be trusted. If expected_org_id is None, skips org-binding
    check and returns the cryptographically verified org_id from the token (used on first activation)."""
    try:
        payload = jwt.decode(
            token,
            public_key,
            algorithms=[_ALGORITHM],
            issuer=_ISSUER,
            options={"require": ["exp", "iat", "jti"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise LicenseTokenExpired("License token has expired") from exc
    except jwt.InvalidTokenError as exc:
        raise LicenseTokenInvalid(f"License token is invalid: {exc}") from exc

    token_org_id = str(payload.get("org_id") or "").strip()
    if not token_org_id:
        raise LicenseTokenInvalid("License token missing org_id")

    if expected_org_id is not None:
        expected_org_key = str(expected_org_id).strip()
        if expected_org_key and token_org_id != expected_org_key:
            # Same exception type/message as a bad signature, deliberately —
            # don't hand an attacker the distinction between "signature ok,
            # wrong org" and "signature bad"; either way the token is refused.
            raise LicenseTokenInvalid("License token is invalid")

    return LicenseTokenPayload(
        org_id=token_org_id,
        jti=str(payload["jti"]),
        issued_at=int(payload["iat"]),
        expires_at=int(payload["exp"]),
        api_base_url=payload.get("api_base_url") or None,
    )