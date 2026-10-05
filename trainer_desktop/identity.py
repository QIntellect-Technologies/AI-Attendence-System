from __future__ import annotations

import re

_UNSAFE_CHARS = re.compile(r"[^A-Za-z0-9\-_.]")


def normalize_identity_component(value: str) -> str:
    """
    Canonical form of a people_type/person_code component for both:
    - duplicate-detection during CSV validation
    - filesystem-safe filename generation during packaging

    These two use sites must never diverge — a value that collides
    under one must collide under the other, since a dedup pass that's
    more permissive than the filename sanitizer causes silent embedding
    file overwrites for two operator-distinct identities.
    """
    cleaned = _UNSAFE_CHARS.sub("_", str(value or "").strip())
    return cleaned.strip("._").lower()


def identity_key(people_type: str, person_code: str) -> tuple[str, str]:
    return (
        normalize_identity_component(people_type),
        normalize_identity_component(person_code),
    )