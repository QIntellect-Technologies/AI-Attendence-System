"""
Vertical template registry.

Support Dashboard owns templates. Client Dashboard reads selected template and
attendance scope but cannot modify support-owned fields.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, List

DEFAULT_BUSINESS_TYPE = "company"

VERTICAL_TEMPLATES: Dict[str, Dict[str, Any]] = {
    "company": {
        "business_type": "company",
        "label": "Company / Software House",
        "primary_people_type": "staff",
        "enabled_people_types": ["staff"],
        "structures": {"staff": {"unit_1": "department", "unit_2": "designation"}},
        "labels": {
            "staff": "Staff",
            "staff_plural": "Staff",
            "department": "Department",
            "department_plural": "Departments",
            "designation": "Designation",
            "designation_plural": "Designations",
        },
        "client_allowed_unit_types": ["department", "designation"],
    },
    "school": {
        "business_type": "school",
        "label": "School / College",
        "primary_people_type": "student",
        "enabled_people_types": ["student", "staff"],
        "structures": {
            "student": {"unit_1": "class", "unit_2": "section"},
            "staff": {"unit_1": "department", "unit_2": "designation"},
        },
        "labels": {
            "student": "Student",
            "student_plural": "Students",
            "staff": "Staff",
            "staff_plural": "Staff",
            "class": "Class",
            "class_plural": "Classes",
            "section": "Section",
            "section_plural": "Sections",
            "department": "Department",
            "department_plural": "Departments",
            "designation": "Designation",
            "designation_plural": "Designations",
        },
        "client_allowed_unit_types": ["class", "section", "department", "designation"],
    },
    "factory": {
        "business_type": "factory",
        "label": "Factory",
        "primary_people_type": "worker",
        "enabled_people_types": ["worker", "staff"],
        "structures": {
            "worker": {"unit_1": "production_line", "unit_2": "role"},
            "staff": {"unit_1": "department", "unit_2": "designation"},
        },
        "labels": {
            "worker": "Worker",
            "worker_plural": "Workers",
            "staff": "Staff",
            "staff_plural": "Staff",
            "production_line": "Production Line",
            "production_line_plural": "Production Lines",
            "role": "Role",
            "role_plural": "Roles",
            "department": "Department",
            "department_plural": "Departments",
            "designation": "Designation",
            "designation_plural": "Designations",
        },
        "client_allowed_unit_types": ["production_line", "role", "department", "designation"],
    },
}


def _clean_people_types(values: Any, allowed: List[str] | None = None) -> List[str]:
    if not isinstance(values, list):
        return []

    allowed_set = set(allowed or [])
    seen = set()
    result: List[str] = []

    for raw in values:
        key = str(raw or "").strip().lower()
        if not key or key in seen:
            continue
        if allowed_set and key not in allowed_set:
            continue
        seen.add(key)
        result.append(key)

    return result


def list_vertical_templates() -> List[Dict[str, Any]]:
    return [
        {
            "business_type": key,
            "label": value["label"],
            "primary_people_type": value["primary_people_type"],
            "enabled_people_types": value["enabled_people_types"],
            "attendance_people_types": value["enabled_people_types"],
            "structures": value["structures"],
            "labels": value["labels"],
            "client_allowed_unit_types": value["client_allowed_unit_types"],
        }
        for key, value in VERTICAL_TEMPLATES.items()
    ]


def get_vertical_template(business_type: str | None) -> Dict[str, Any]:
    key = str(business_type or DEFAULT_BUSINESS_TYPE).strip().lower()
    template = VERTICAL_TEMPLATES.get(key, VERTICAL_TEMPLATES[DEFAULT_BUSINESS_TYPE])
    return deepcopy(template)


def build_vertical_config(
    business_type: str | None,
    attendance_people_types: List[str] | None = None,
) -> Dict[str, Any]:
    template = get_vertical_template(business_type)
    enabled = _clean_people_types(template["enabled_people_types"])
    attendance_scope = _clean_people_types(attendance_people_types, enabled) or enabled

    return {
        "business_type": template["business_type"],
        "primary_people_type": template["primary_people_type"],
        "enabled_people_types": enabled,
        "attendance_people_types": attendance_scope,
        "structures": template["structures"],
        "labels": template["labels"],
        "client_allowed_unit_types": template["client_allowed_unit_types"],
        "client_can_change_template": False,
    }


def normalize_vertical_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    payload = dict(payload or {})
    business_type = str(
        payload.get("business_type") or payload.get("biz_type") or DEFAULT_BUSINESS_TYPE
    ).strip().lower()

    template = get_vertical_template(business_type)
    enabled = _clean_people_types(template["enabled_people_types"])
    requested_attendance = payload.get("attendance_people_types")
    attendance_scope = _clean_people_types(requested_attendance, enabled) or enabled
    vertical_config = build_vertical_config(template["business_type"], attendance_scope)

    payload["business_type"] = template["business_type"]
    payload["biz_type"] = template["business_type"]
    payload["primary_people_type"] = template["primary_people_type"]
    payload["enabled_people_types"] = enabled
    payload["attendance_people_types"] = attendance_scope
    payload["vertical_config"] = vertical_config
    return payload


def is_unit_type_allowed(vertical_config: Dict[str, Any], unit_type: str) -> bool:
    if not unit_type:
        return False
    allowed = vertical_config.get("client_allowed_unit_types") or []
    return unit_type in allowed


def normalize_people_type(value: str | None, vertical_config: Dict[str, Any]) -> str:
    enabled = vertical_config.get("enabled_people_types") or ["staff"]
    primary = vertical_config.get("primary_people_type") or enabled[0]
    return value if value in enabled else primary
