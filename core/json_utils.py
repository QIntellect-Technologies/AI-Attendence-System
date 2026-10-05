"""
JSON helpers for SQLite/Postgres compatibility.

SQLite may store JSON as TEXT.
Supabase/Postgres may return JSON as dict/list.
These helpers keep route/service code clean.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List


def safe_json_loads(value: Any, fallback: Any = None) -> Any:
    if fallback is None:
        fallback = {}

    if value is None:
        return fallback

    if isinstance(value, (dict, list)):
        return value

    if isinstance(value, str):
        text = value.strip()
        if not text:
            return fallback

        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return fallback

    return fallback


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def ensure_list(value: Any) -> List[Any]:
    if isinstance(value, list):
        return value

    if isinstance(value, str):
        parsed = safe_json_loads(value, [])
        return parsed if isinstance(parsed, list) else []

    return []


def ensure_dict(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value

    parsed = safe_json_loads(value, {})
    return parsed if isinstance(parsed, dict) else {}