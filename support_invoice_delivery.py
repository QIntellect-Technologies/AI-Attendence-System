"""
support_invoice_delivery.py
──────────────────────────────────────────────────────────────────────────────
Support Dashboard invoice delivery service.

Purpose:
- Build invoice preview message from real deal data.
- Build invoice PDF bytes.
- Mark invoice as manually sent.

No automatic email sending is implemented here. A real email provider can be
added later without changing the message/PDF builder contract.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from support_invoice_message import build_invoice_message, build_invoice_subject
from support_invoice_pdf import build_invoice_pdf_bytes


def _get_invoice(sb: Any, invoice_id: str) -> dict:
    result = sb.table("invoices").select("*").eq("id", invoice_id).limit(1).execute()
    if not result.data:
        raise ValueError("Invoice not found")
    return result.data[0]


def _list_modules(sb: Any, org_id: str) -> list[dict]:
    try:
        result = (
            sb.table("organization_modules")
            .select("*")
            .eq("org_id", org_id)
            .order("module_name")
            .execute()
        )
        return result.data or []
    except Exception:
        return []


def _list_branches(sb: Any, org_id: str) -> list[dict]:
    try:
        result = (
            sb.table("branches")
            .select("*")
            .eq("org_id", org_id)
            .order("created_at")
            .execute()
        )
        return result.data or []
    except Exception:
        return []


def get_invoice_delivery_context(sb: Any, get_organization_func: Any, invoice_id: str) -> dict:
    invoice = _get_invoice(sb, invoice_id)
    org_id = str(invoice.get("org_id") or "")
    if not org_id:
        raise ValueError("Invoice is missing organization id")

    org = get_organization_func(org_id)
    modules = _list_modules(sb, org_id)
    branches = _list_branches(sb, org_id)
    return {
        "organization": org,
        "invoice": invoice,
        "modules": modules,
        "branches": branches,
    }


def build_invoice_delivery_message(sb: Any, get_organization_func: Any, invoice_id: str, *, support_contact: str = "QIntellect Support Team", payment_instructions: str | None = None) -> dict:
    ctx = get_invoice_delivery_context(sb, get_organization_func, invoice_id)
    subject = build_invoice_subject(ctx["organization"], ctx["invoice"])
    message = build_invoice_message(
        org=ctx["organization"],
        invoice=ctx["invoice"],
        modules=ctx["modules"],
        branches=ctx["branches"],
        support_contact=support_contact,
        payment_instructions=payment_instructions,
    )
    return {
        "subject": subject,
        "message": message,
        "to": ctx["organization"].get("contact_email") or "",
        "invoice": ctx["invoice"],
        "organization": ctx["organization"],
    }


def build_invoice_pdf(sb: Any, get_organization_func: Any, invoice_id: str, *, support_contact: str = "QIntellect Support Team", payment_instructions: str | None = None) -> tuple[bytes, str]:
    ctx = get_invoice_delivery_context(sb, get_organization_func, invoice_id)
    pdf = build_invoice_pdf_bytes(
        org=ctx["organization"],
        invoice=ctx["invoice"],
        modules=ctx["modules"],
        branches=ctx["branches"],
        support_contact=support_contact,
        payment_instructions=payment_instructions,
    )
    raw_number = ctx["invoice"].get("invoice_number") or ctx["invoice"].get("id") or "invoice"
    filename = f"qintellect-invoice-{str(raw_number).replace('/', '-')}.pdf"
    return pdf, filename


def mark_invoice_sent_manually(sb: Any, invoice_id: str, *, sent_by: str, sent_to: str | None = None, subject: str | None = None, message: str | None = None) -> dict:
    payload = {
        "sent_at": datetime.now(timezone.utc).isoformat(),
        "sent_by": sent_by,
        "sent_method": "manual",
        "sent_to": sent_to,
        "sent_subject": subject,
        "sent_message_snapshot": message,
    }

    # Remove blank optional fields so existing non-null restrictions are not affected.
    payload = {k: v for k, v in payload.items() if v is not None}

    result = (
        sb.table("invoices")
        .update(payload)
        .eq("id", invoice_id)
        .execute()
    )
    if not result.data:
        raise ValueError("Invoice not found")
    return result.data[0]
