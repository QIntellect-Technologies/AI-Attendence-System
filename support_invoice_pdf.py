"""
support_invoice_pdf.py
──────────────────────────────────────────────────────────────────────────────
Programmatic invoice PDF builder using ReportLab.

Install dependency in the backend venv:
    pip install reportlab
and add it to requirements.txt:
    reportlab>=4.2.0

No DB calls. Caller passes org, invoice, modules, branches.
"""

from __future__ import annotations

from io import BytesIO
from typing import Any, Mapping, Sequence

from support_invoice_message import (
    build_invoice_subject,
    _business_label,
    _people_list_label,
    _structure_summary,
    _module_summary,
    _branch_summary,
    _money,
    _clean,
)


def _load_reportlab():
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
        from reportlab.lib.units import mm
        from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    except ImportError as exc:
        raise RuntimeError(
            "ReportLab is required for invoice PDF generation. Run: pip install reportlab"
        ) from exc

    return {
        "colors": colors,
        "A4": A4,
        "ParagraphStyle": ParagraphStyle,
        "getSampleStyleSheet": getSampleStyleSheet,
        "mm": mm,
        "Paragraph": Paragraph,
        "SimpleDocTemplate": SimpleDocTemplate,
        "Spacer": Spacer,
        "Table": Table,
        "TableStyle": TableStyle,
    }


def _invoice_number(invoice: Mapping[str, Any]) -> str:
    return _clean(invoice.get("invoice_number") or invoice.get("number") or invoice.get("id"), "Not specified")


def build_invoice_pdf_bytes(
    *,
    org: Mapping[str, Any],
    invoice: Mapping[str, Any],
    modules: Sequence[Mapping[str, Any]] | Sequence[str] | None = None,
    branches: Sequence[Mapping[str, Any]] | None = None,
    support_contact: str = "QIntellect Support Team",
    payment_instructions: str | None = None,
) -> bytes:
    rl = _load_reportlab()
    colors = rl["colors"]
    A4 = rl["A4"]
    ParagraphStyle = rl["ParagraphStyle"]
    getSampleStyleSheet = rl["getSampleStyleSheet"]
    mm = rl["mm"]
    Paragraph = rl["Paragraph"]
    SimpleDocTemplate = rl["SimpleDocTemplate"]
    Spacer = rl["Spacer"]
    Table = rl["Table"]
    TableStyle = rl["TableStyle"]

    def _p(text: Any, style: Any):
        safe = str(text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br/>")
        return Paragraph(safe, style)

    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=16 * mm,
        leftMargin=16 * mm,
        topMargin=16 * mm,
        bottomMargin=16 * mm,
        title=build_invoice_subject(org, invoice),
    )

    styles = getSampleStyleSheet()
    title = ParagraphStyle("Title", parent=styles["Title"], fontSize=20, leading=24, textColor=colors.HexColor("#134471"))
    h2 = ParagraphStyle("H2", parent=styles["Heading2"], fontSize=12, leading=15, textColor=colors.HexColor("#0d9488"), spaceBefore=8, spaceAfter=6)
    body = ParagraphStyle("Body", parent=styles["BodyText"], fontSize=9, leading=12, textColor=colors.HexColor("#334155"))
    small = ParagraphStyle("Small", parent=body, fontSize=8, leading=10, textColor=colors.HexColor("#64748b"))

    story: list[Any] = []
    story.append(_p("QIntellect AttendAI", title))
    story.append(_p("Professional Attendance and HR Platform", small))
    story.append(Spacer(1, 8))

    invoice_data = [
        ["Invoice Number", _invoice_number(invoice)],
        ["Organization", _clean(org.get("name"))],
        ["Amount", _money(invoice.get("amount"))],
        ["Due Date", _clean(invoice.get("due_date"))],
        ["Grace Period", f"{_clean(invoice.get('grace_period_days'), '0')} days"],
        ["Status", _clean(invoice.get("status"), "pending").title()],
    ]
    table = Table(invoice_data, colWidths=[42 * mm, 120 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f8fafc")),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#64748b")),
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("PADDING", (0, 0), (-1, -1), 7),
    ]))
    story.append(table)
    story.append(Spacer(1, 8))

    cfg = org.get("vertical_config") if isinstance(org.get("vertical_config"), dict) else {}
    enabled_types = org.get("enabled_people_types") or cfg.get("enabled_people_types")
    attendance_types = org.get("attendance_people_types") or cfg.get("attendance_people_types") or enabled_types

    story.append(_p("Applied Deal Settings", h2))
    deal_data = [
        ["Organization Type", _business_label(org)],
        ["Attendance Mode", _clean(org.get("attendance_mode"), "cloud").title()],
        ["Maximum Branches", _clean(org.get("max_branches"))],
        ["Enabled People Types", _people_list_label(org, enabled_types)],
        ["Attendance Enabled For", _people_list_label(org, attendance_types)],
    ]
    deal_table = Table(deal_data, colWidths=[42 * mm, 120 * mm])
    deal_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f0fdfa")),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("PADDING", (0, 0), (-1, -1), 7),
    ]))
    story.append(deal_table)

    story.append(_p("Structure Configuration", h2))
    story.append(_p(_structure_summary(org), body))
    story.append(_p("Purchased Modules", h2))
    story.append(_p(_module_summary(modules), body))
    story.append(_p("Branch Configuration", h2))
    story.append(_p(_branch_summary(branches), body))
    story.append(_p("Payment Instructions", h2))
    story.append(_p(payment_instructions or "Please complete payment using the payment method agreed with QIntellect Support. After payment, share the payment proof with our team so your invoice can be marked as paid.", body))
    story.append(Spacer(1, 10))
    story.append(_p(f"Regards,<br/>QIntellect Support Team<br/>{support_contact or ''}", small))

    doc.build(story)
    return buffer.getvalue()
