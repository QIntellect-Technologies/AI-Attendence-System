"""Tenant config builder read by Client Dashboard."""

from __future__ import annotations

from typing import Any, Dict

from core.json_utils import ensure_dict, ensure_list
from core.vertical_templates import build_vertical_config


def _clean_people_types(value: Any) -> list[str]:
    return [str(item).strip().lower() for item in ensure_list(value) if str(item).strip()]


def build_tenant_config_from_org(org: Dict[str, Any]) -> Dict[str, Any]:
    business_type = org.get("business_type") or org.get("biz_type") or "company"

    stored_vertical_config = ensure_dict(org.get("vertical_config"))
    default_vertical_config = build_vertical_config(
        business_type,
        _clean_people_types(org.get("attendance_people_types")),
    )

    vertical_config = {**default_vertical_config, **stored_vertical_config}

    enabled_people_types = (
        _clean_people_types(org.get("enabled_people_types"))
        or _clean_people_types(vertical_config.get("enabled_people_types"))
        or ["staff"]
    )

    attendance_people_types = (
        _clean_people_types(org.get("attendance_people_types"))
        or _clean_people_types(vertical_config.get("attendance_people_types"))
        or enabled_people_types
    )
    attendance_people_types = [value for value in attendance_people_types if value in enabled_people_types] or enabled_people_types

    primary_people_type = (
        org.get("primary_people_type")
        or vertical_config.get("primary_people_type")
        or enabled_people_types[0]
    )

    vertical_config["enabled_people_types"] = enabled_people_types
    vertical_config["attendance_people_types"] = attendance_people_types

    return {
        "organization": {
            "id": org.get("id"),
            "name": org.get("name") or org.get("organization_name"),
            "business_type": business_type,
            "primary_people_type": primary_people_type,
            "enabled_people_types": enabled_people_types,
            "attendance_people_types": attendance_people_types,
            "vertical_config": vertical_config,
            "attendance_mode": org.get("attendance_mode"),
            "max_branches": org.get("max_branches"),
            "status": org.get("status"),
        },
        "permissions": {
            "can_change_business_type": False,
            "can_change_attendance_mode": False,
            "can_change_modules": False,
            "can_add_branch_beyond_limit": False,
        },
    }
