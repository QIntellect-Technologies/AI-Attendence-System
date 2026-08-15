"""
support_invite_message.py
──────────────────────────────────────────────────────────────────────────────
Builds the full client invite message from support-owned deal settings.

No DB calls. Caller passes organization, branches, modules, latest invoice.
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
    labels = _labels(org)
    return str(labels.get(key) or key.replace("_", " ").title() or "Not specified")


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
    lines: list[str] = []
    for people_type, structure in structures.items():
        if not isinstance(structure, Mapping):
            continue
        units = [
            _title(value)
            for _, value in sorted(structure.items())
            if str(value or "").strip()
        ]
        if units:
            lines.append(f"{_people_label(org, people_type)}: {' → '.join(units)}")
    return "\n".join(lines) or "Not specified"


def _module_summary(modules: Sequence[Mapping[str, Any]] | Sequence[str] | None) -> str:
    if not modules:
        return "No purchased modules listed"
    labels: list[str] = []
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
    lines = []
    for branch in branches:
        name = _clean(branch.get("name"), "Branch")
        location = _clean(branch.get("location"), "No location")
        capacity = _clean(branch.get("max_staff_capacity"), "Not specified")
        lines.append(f"- {name} — {location} — Max size: {capacity}")
    return "\n".join(lines)


def _attendance_summary(org: Mapping[str, Any]) -> str:
    cfg = _cfg(org)
    attendance_mode = _title(org.get("attendance_mode") or "cloud")
    attendance_types = org.get("attendance_people_types") or cfg.get("attendance_people_types") or org.get("enabled_people_types") or cfg.get("enabled_people_types")
    threshold = org.get("node_offline_threshold_mins")
    lines = [
        f"Attendance Mode: {attendance_mode}",
        f"Attendance Enabled For: {_people_list_label(org, attendance_types)}",
    ]
    if str(org.get("attendance_mode") or "").lower() == "local":
        lines.append(f"Node Offline Threshold: {_clean(threshold, '10')} minutes")
    return "\n".join(lines)


def _invoice_lines(invoice: Mapping[str, Any] | None) -> list[str]:
    if not invoice:
        return [
            "Billing Cycle: Not specified",
            "First Invoice Amount: Not specified",
            "Due Date: Not specified",
            "Grace Period: Not specified",
        ]
    return [
        f"Billing Cycle: {_clean(invoice.get('billing_cycle'))}",
        f"First Invoice Amount: {_money(invoice.get('amount'))}",
        f"Due Date: {_clean(invoice.get('due_date'))}",
        f"Grace Period: {_clean(invoice.get('grace_period_days'), '0')} days",
    ]


def build_client_invite_message(
    *,
    client_name: str,
    login_url: str,
    client_email: str,
    temporary_password: str,
    organization: Mapping[str, Any],
    branches: Sequence[Mapping[str, Any]] | None = None,
    modules: Sequence[Mapping[str, Any]] | Sequence[str] | None = None,
    latest_invoice: Mapping[str, Any] | None = None,
    support_contact: str = "QIntellect Support Team",
) -> str:
    cfg = _cfg(organization)
    enabled_types = organization.get("enabled_people_types") or cfg.get("enabled_people_types")
    attendance_types = organization.get("attendance_people_types") or cfg.get("attendance_people_types") or enabled_types
    primary = organization.get("primary_people_type") or cfg.get("primary_people_type")

    billing_lines = _invoice_lines(latest_invoice)

    return "\n".join([
        f"Dear {_clean(client_name, 'Client')},",
        "",
        "Welcome to QIntellect AttendAI.",
        "",
        "Your organization dashboard has been created according to the agreed setup and commercial configuration. Please find your dashboard access details and applied settings below.",
        "",
        "Login Details",
        f"Dashboard URL: {_clean(login_url)}",
        f"Email: {_clean(client_email)}",
        f"Temporary Password: {_clean(temporary_password)}",
        "",
        "For security, please change your password after your first login.",
        "",
        "Organization Setup",
        f"Organization Name: {_clean(organization.get('name'))}",
        f"Organization Type: {_business_label(organization)}",
        f"Attendance Mode: {_title(organization.get('attendance_mode') or 'cloud')}",
        f"Maximum Branches Allowed: {_clean(organization.get('max_branches'))}",
        "Max size of each branch",
        _branch_summary(branches),
        f"Current Access Status: {_title(organization.get('status'))}",
        "",
        "Business Template Applied",
        f"Template: {_business_label(organization)}",
        f"Primary People Type: {_people_label(organization, primary)}",
        f"Enabled People Types: {_people_list_label(organization, enabled_types)}",
        f"Attendance Enabled For: {_people_list_label(organization, attendance_types)}",
        "",
        "Structure Configuration",
        _structure_summary(organization),
        "",
        "Purchased Modules",
        _module_summary(modules),
        "",
        "Branch Configuration",
        _branch_summary(branches),
        "",
        "Attendance Configuration",
        _attendance_summary(organization),
        "",
        "Important Access Rules",
        "Your dashboard has been configured according to the purchased package and agreed deal. The following settings are controlled by QIntellect Support and cannot be changed from the Client Dashboard:",
        "",
        "- Organization type and business template",
        "- Attendance mode",
        "- Purchased modules",
        "- Maximum branch limit",
        "- Branch capacity limits",
        "- Billing and subscription status",
        "- Attendance people-type scope",
        "",
        "You may configure your operational data inside the dashboard, such as organization profile details, allowed branch-level setup, cameras, departments/classes/sections where applicable, staff/student/worker records, and other enabled module data.",
        "",
        "Local Attendance Node Setup",
        "If your organization is configured in Local Attendance Mode, each branch may require a local attendance node installed on the branch machine. The installer and activation token will be provided from the dashboard or by QIntellect Support according to your branch setup.",
        "",
        "Billing Information",
        *billing_lines,
        "",
        "Your dashboard access remains active according to the invoice and grace-period policy agreed in the deal.",
        "",
        "Next Steps",
        "",
        "1. Login using the credentials above.",
        "2. Change your temporary password.",
        "3. Complete the onboarding/setup form.",
        "4. Add your operational configuration such as logo, branch setup details, cameras, and people records.",
        "5. Contact QIntellect Support if any commercial setting needs to be changed.",
        "",
        "Please keep your login credentials secure and do not share them with unauthorized users.",
        "",
        "Regards,",
        "QIntellect Support Team",
        _clean(support_contact, ""),
    ])
