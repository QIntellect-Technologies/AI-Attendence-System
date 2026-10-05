"""
Consistent API responses.
"""

from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

from flask import jsonify


def success_response(
    data: Optional[Dict[str, Any]] = None,
    message: str = "Success",
    status_code: int = 200,
):
    payload: Dict[str, Any] = {
        "success": True,
        "message": message,
    }

    if data:
        payload.update(data)

    return jsonify(payload), status_code


def error_response(
    message: str,
    status_code: int = 400,
    details: Optional[Any] = None,
):
    payload: Dict[str, Any] = {
        "success": False,
        "message": message,
        "error": message,
    }

    if details is not None:
        payload["details"] = details

    return jsonify(payload), status_code