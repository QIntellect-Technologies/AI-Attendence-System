"""
support_invoice_message.py
──────────────────────────────────────────────────────────────────────────────
Build invoice subject/message from real support-owned organization deal data.

No DB calls. Caller passes org, invoice, modules, branches.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence


def _clean(value: Any, fallback: str = "Not specified") -> str:
    text = str(value or "").strip()
    return text or fallback


def _title(value: Any) -> str:
    return _clean(value).replace("_", " ").replace("-", " ").title()


def _money(value: Any) -> str:
    try:
        amount = float(value or 0)
    except (TypeError, ValueError):
        return _clean(value)
    if amount.is_integer():
        return f"Rs. {int(amount):,}"
    return f"Rs. {amount:,.2f}"


def _cfg(org: Mapping[str, Any]) -> Mapping[str, Any]:
    cfg = org.get("vertical_config")
    return cfg if isinstance(cfg, Mapping) else {}


def _labels(org: Mapping[str, Any]) -> Mapping[str, str]:
    labels = _cfg(org).get("labels")
    return labels if isinstance(labels, Mapping) else {}


def _people_label(org: Mapping[str, Any], people_type: Any) -> str:
    key = str(people_type or "").strip().lower()
    return str(_labels(org).get(key) or key.replace("_", " ").title() or "Not specified")


def _people_list_label(org: Mapping[str, Any], values: Any) -> str:
    if isinstance(values, str):
        items = [x.strip() for x in values.split(",") if x.strip()]
    elif isinstance(values, Sequence):
        items = [str(x).strip() for x in values if str(x).strip()]
    else:
        items = []
    return ", ".join(_people_label(org, item) for item in items) or "Not specified"


def _business_label(org: Mapping[str, Any]) -> str:
    business_type = org.get("business_type") or org.get("biz_type") or org.get("org_type") or "company"
    labels = {
        "company": "Company / Software House",
        "school": "School / College",
        "factory": "Factory",
        "hospital": "Hospital / Clinic",
        "ngo": "NGO / Non-Profit",
    }
    return labels.get(str(business_type).lower(), _title(business_type))


def _structure_summary(org: Mapping[str, Any]) -> str:
    structures = _cfg(org).get("structures")
    if not isinstance(structures, Mapping) or not structures:
        return "Not specified"
    lines = []
    for people_type, structure in structures.items():
        if not isinstance(structure, Mapping):
            continue
        units = [_title(value) for _, value in sorted(structure.items()) if str(value or "").strip()]
        if units:
            lines.append(f"{_people_label(org, people_type)}: {' → '.join(units)}")
    return "\n".join(lines) or "Not specified"


def _module_summary(modules: Sequence[Mapping[str, Any]] | Sequence[str] | None) -> str:
    if not modules:
        return "No purchased modules listed"
    labels = []
    for item in modules:
        if isinstance(item, Mapping):
            if str(item.get("status") or "active").lower() not in {"active", "purchased"}:
                continue
            key = item.get("module_name") or item.get("name")
        else:
            key = item
        if key:
            labels.append(_title(key))
    return "\n".join(f"- {label}" for label in labels) or "No purchased modules listed"


def _branch_summary(branches: Sequence[Mapping[str, Any]] | None) -> str:
    if not branches:
        return "No branches configured yet"
    return "\n".join(
        f"- {_clean(b.get('name'), 'Branch')} — {_clean(b.get('location'), 'No location')} — Max size: {_clean(b.get('max_staff_capacity'))}"
        for b in branches
    )


def _invoice_number(invoice: Mapping[str, Any]) -> str:
    return _clean(invoice.get("invoice_number") or invoice.get("number") or invoice.get("id"), "Not specified")


def build_invoice_subject(org: Mapping[str, Any], invoice: Mapping[str, Any]) -> str:
    return f"QIntellect AttendAI Invoice {_invoice_number(invoice)} — {_clean(org.get('name'), 'Organization')}"


def build_invoice_message(
    *,
    org: Mapping[str, Any],
    invoice: Mapping[str, Any],
    modules: Sequence[Mapping[str, Any]] | Sequence[str] | None = None,
    branches: Sequence[Mapping[str, Any]] | None = None,
    support_contact: str = "QIntellect Support Team",
    payment_instructions: str | None = None,
) -> str:
    cfg = _cfg(org)
    enabled_types = org.get("enabled_people_types") or cfg.get("enabled_people_types")
    attendance_types = org.get("attendance_people_types") or cfg.get("attendance_people_types") or enabled_types
    return "\n".join([
        f"Dear {_clean(org.get('name'), 'Client')},",
        "",
        "Please find your QIntellect AttendAI invoice details below.",
        "",
        "Invoice Details",
        f"Invoice Number: {_invoice_number(invoice)}",
        f"Amount: {_money(invoice.get('amount'))}",
        f"Due Date: {_clean(invoice.get('due_date'))}",
        f"Grace Period: {_clean(invoice.get('grace_period_days'), '0')} days",
        f"Status: {_title(invoice.get('status') or 'pending')}",
        "",
        "Applied Deal Settings",
        f"Organization Type: {_business_label(org)}",
        f"Attendance Mode: {_title(org.get('attendance_mode') or 'cloud')}",
        f"Maximum Branches: {_clean(org.get('max_branches'))}",
        f"Enabled People Types: {_people_list_label(org, enabled_types)}",
        f"Attendance Enabled For: {_people_list_label(org, attendance_types)}",
        "",
        "Structure Configuration",
        _structure_summary(org),
        "",
        "Purchased Modules",
        _module_summary(modules),
        "",
        "Branch Configuration",
        _branch_summary(branches),
        "",
        "Payment Instructions",
        payment_instructions or "Please complete payment using the payment method agreed with QIntellect Support. After payment, share payment proof with our team so the invoice can be marked as paid.",
        "",
        "Regards,",
        "QIntellect Support Team",
        _clean(support_contact, ""),
    ])
