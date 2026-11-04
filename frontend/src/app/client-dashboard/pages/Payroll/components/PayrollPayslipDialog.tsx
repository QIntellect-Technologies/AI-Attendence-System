import { useEffect, useMemo, useState } from "react";
import { Download, X } from "lucide-react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  downloadPdf,
  resolveImageAsDataUrl,
} from "../../../components/ui/ExportPdfButton";
import type { PayrollRow } from "../hooks/usePayrollData";

interface PayrollPayslipDialogProps {
  row: PayrollRow;
  companyName: string;
  companyAddress: string;
  logoUrl: string | null;
  branchLocation: string;
  period: string;
  formatCurrency: (amount: number) => string;
  onClose: () => void;
}

type PayslipData = Omit<PayrollPayslipDialogProps, "onClose">;

interface GeneratedPayslip {
  doc: jsPDF;
  url: string;
}

const PAGE_MARGIN = 42;
const NAVY: [number, number, number] = [19, 68, 113];
const TEAL: [number, number, number] = [13, 148, 136];
const SLATE: [number, number, number] = [71, 85, 105];

function addImage(doc: jsPDF, dataUrl: string, x: number, y: number) {
  const format = dataUrl.startsWith("data:image/png")
    ? "PNG"
    : dataUrl.startsWith("data:image/webp")
      ? "WEBP"
      : "JPEG";
  doc.addImage(dataUrl, format, x, y, 52, 52);
}

function buildPayslip(props: PayslipData, logoDataUrl: string | null): jsPDF {
  const {
    row,
    companyName,
    companyAddress,
    branchLocation,
    period,
    formatCurrency,
  } = props;
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const contentWidth = pageWidth - PAGE_MARGIN * 2;
  const location = companyAddress || branchLocation || "—";

  doc.setFillColor(...NAVY);
  doc.rect(0, 0, pageWidth, 116, "F");
  if (logoDataUrl) {
    try {
      addImage(doc, logoDataUrl, PAGE_MARGIN, 28);
    } catch {
      // Invalid/unsupported organization logos should not prevent payslip creation.
    }
  }
  const companyX = PAGE_MARGIN + (logoDataUrl ? 66 : 0);
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.text(companyName || "Company", companyX, 48, {
    maxWidth: contentWidth - (companyX - PAGE_MARGIN),
  });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(location, companyX, 66, {
    maxWidth: contentWidth - (companyX - PAGE_MARGIN),
  });
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text("SALARY PAYSLIP", pageWidth - PAGE_MARGIN, 48, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(period, pageWidth - PAGE_MARGIN, 68, { align: "right" });

  doc.setTextColor(...NAVY);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("EMPLOYEE INFORMATION", PAGE_MARGIN, 143);
  autoTable(doc, {
    startY: 151,
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN },
    theme: "grid",
    body: [
      ["Employee Name", row.name, "Employee ID", row.empId || "—"],
      ["CNIC", row.cnic || "—", "Department", row.department || "—"],
      ["Branch", row.branchName || "—", "Location", branchLocation || location],
      [
        "Present / Working Days",
        `${row.presentDays} / ${row.totalWorkingDays || "—"}`,
        "Status",
        row.status,
      ],
    ],
    styles: {
      font: "helvetica",
      fontSize: 9,
      cellPadding: 8,
      textColor: SLATE,
    },
    columnStyles: {
      0: { fontStyle: "bold", textColor: NAVY, cellWidth: 100 },
      1: { cellWidth: 160 },
      2: { fontStyle: "bold", textColor: NAVY, cellWidth: 100 },
      3: { cellWidth: "auto" },
    },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    tableLineColor: [226, 232, 240],
    tableLineWidth: 0.5,
  });

  const earnings: Array<[string, string]> = [
    ["Basic Salary", formatCurrency(row.baseSalary)],
  ];
  const allowanceLines = row.allowancesBreakdown.filter(
    ({ amount }) => amount > 0,
  );
  if (allowanceLines.length > 0) {
    earnings.push(
      ...allowanceLines.map(
        ({ label, amount }) =>
          [label, formatCurrency(amount)] as [string, string],
      ),
    );
    const namedAllowanceTotal = allowanceLines.reduce(
      (total, { amount }) => total + amount,
      0,
    );
    const otherAllowance = Math.max(0, row.allowances - namedAllowanceTotal);
    if (otherAllowance > 0)
      earnings.push(["Other allowance", formatCurrency(otherAllowance)]);
  } else if (row.allowances > 0) {
    earnings.push(["Allowances", formatCurrency(row.allowances)]);
  }
  if (row.overtimeAmount > 0)
    earnings.push(["Overtime", formatCurrency(row.overtimeAmount)]);

  const deductions: Array<[string, number]> = [];
  const breakdown = row.breakdown;
  if (breakdown) {
    const absentDays = breakdown.absentDays || row.absentDays;
    if (absentDays > 0 || breakdown.absenceDeductionAmount > 0)
      deductions.push([
        `Absent days (${absentDays})`,
        breakdown.absenceDeductionAmount,
      ]);
    const lateCount = breakdown.lateCount || row.lateCount;
    if (lateCount > 0 || breakdown.lateDeductionAmount > 0)
      deductions.push([
        `Late comings (${lateCount})`,
        breakdown.lateDeductionAmount,
      ]);
    if (breakdown.halfDayDeductionAmount > 0)
      deductions.push(["Half days", breakdown.halfDayDeductionAmount]);
    if (breakdown.shortLeaveDeductionAmount > 0)
      deductions.push(["Short leave", breakdown.shortLeaveDeductionAmount]);
    if (breakdown.unpaidLeaveDeductionAmount > 0)
      deductions.push(["Unpaid leave", breakdown.unpaidLeaveDeductionAmount]);
    if (breakdown.incomeTaxAmount > 0)
      deductions.push(["Income tax", breakdown.incomeTaxAmount]);
  }
  const itemizedDeductions = deductions.reduce(
    (total, [, amount]) => total + amount,
    0,
  );
  const otherDeductions = Math.max(0, row.deductions - itemizedDeductions);
  if (otherDeductions > 0 || deductions.length === 0)
    deductions.push(["Other deductions", otherDeductions || row.deductions]);

  const tableStartY = (doc as jsPDF & { lastAutoTable?: { finalY: number } })
    .lastAutoTable?.finalY;
  const bodyRows = Array.from(
    { length: Math.max(earnings.length, deductions.length) },
    (_, index) => [
      earnings[index]?.[0] ?? "",
      earnings[index]?.[1] ?? "",
      deductions[index]?.[0] ?? "",
      deductions[index] ? formatCurrency(deductions[index][1]) : "",
    ],
  );
  const totalEarnings = row.baseSalary + row.allowances + row.overtimeAmount;
  bodyRows.push([
    "Total Salary",
    formatCurrency(totalEarnings),
    "Total Deductions",
    formatCurrency(row.deductions),
  ]);

  const financialStartY = (tableStartY ?? 300) + 26;
  autoTable(doc, {
    startY: financialStartY,
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN },
    head: [["EARNINGS", "AMOUNT", "DEDUCTIONS", "AMOUNT"]],
    body: bodyRows,
    theme: "grid",
    styles: {
      font: "helvetica",
      fontSize: 9,
      cellPadding: 8,
      textColor: SLATE,
    },
    headStyles: {
      fillColor: NAVY,
      textColor: [255, 255, 255],
      fontStyle: "bold",
    },
    columnStyles: {
      0: { cellWidth: 164 },
      1: { cellWidth: 88, halign: "right" },
      2: { cellWidth: 164 },
      3: { cellWidth: "auto", halign: "right" },
    },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    tableLineColor: [226, 232, 240],
    tableLineWidth: 0.5,
    didParseCell: (data) => {
      if (data.section === "body" && data.row.index === bodyRows.length - 1) {
        data.cell.styles.fillColor = [240, 253, 250];
        data.cell.styles.textColor = NAVY;
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  const finalY =
    (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable
      ?.finalY ?? financialStartY + 80;
  const netY = finalY + 38;
  doc.setFillColor(...TEAL);
  doc.roundedRect(PAGE_MARGIN, netY, contentWidth, 46, 7, 7, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("NET PAYABLE", PAGE_MARGIN + 16, netY + 28);
  doc.setFontSize(16);
  doc.text(
    formatCurrency(row.netPay),
    pageWidth - PAGE_MARGIN - 16,
    netY + 29,
    {
      align: "right",
    },
  );

  doc.setTextColor(...SLATE);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text(
    "This is a system-generated payslip.",
    pageWidth / 2,
    Math.min(netY + 76, doc.internal.pageSize.getHeight() - 34),
    { align: "center" },
  );
  return doc;
}

export default function PayrollPayslipDialog(props: PayrollPayslipDialogProps) {
  const {
    row,
    companyName,
    companyAddress,
    logoUrl,
    branchLocation,
    period,
    formatCurrency,
  } = props;
  const [generated, setGenerated] = useState<GeneratedPayslip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filename = useMemo(
    () =>
      `Payslip_${row.empId || row.staffId}_${period.replace(/\s+/g, "_")}.pdf`,
    [period, row.empId, row.staffId],
  );

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setGenerated(null);
    setError(null);
    void resolveImageAsDataUrl(logoUrl)
      .then((logo) => {
        if (cancelled) return;
        const doc = buildPayslip(
          {
            row,
            companyName,
            companyAddress,
            branchLocation,
            period,
            formatCurrency,
            logoUrl,
          },
          logo,
        );
        objectUrl = URL.createObjectURL(doc.output("blob"));
        setGenerated({ doc, url: objectUrl });
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not generate payslip.",
          );
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [
    branchLocation,
    companyAddress,
    companyName,
    formatCurrency,
    logoUrl,
    period,
    row,
  ]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Payslip for ${row.name}`}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        padding: 20,
        background: "rgba(12, 35, 64, 0.55)",
        display: "grid",
        placeItems: "center",
      }}
      onClick={props.onClose}
    >
      <section
        style={{
          width: "min(900px, 96vw)",
          height: "min(850px, 94vh)",
          background: "#fff",
          borderRadius: 14,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 20px 60px rgba(15, 23, 42, .24)",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <header
          style={{
            minHeight: 58,
            padding: "10px 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            borderBottom: "1px solid #e2e8f0",
          }}
        >
          <div>
            <strong style={{ color: "#134471" }}>Employee Payslip</strong>
            <div style={{ fontSize: 12, color: "#64748b" }}>
              {row.name} · {period}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={() => generated && downloadPdf(filename, generated.doc)}
              disabled={!generated}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                padding: "9px 12px",
                border: 0,
                borderRadius: 8,
                background: "#0d9488",
                color: "#fff",
                fontWeight: 700,
                cursor: generated ? "pointer" : "wait",
                opacity: generated ? 1 : 0.6,
              }}
            >
              <Download size={15} /> Download PDF
            </button>
            <button
              type="button"
              onClick={props.onClose}
              aria-label="Close payslip"
              style={{
                border: 0,
                background: "transparent",
                color: "#64748b",
                padding: 8,
                cursor: "pointer",
              }}
            >
              <X size={18} />
            </button>
          </div>
        </header>
        {error ? (
          <div role="alert" style={{ padding: 24, color: "#b91c1c" }}>
            {error}
          </div>
        ) : generated ? (
          <iframe
            title={`Payslip PDF for ${row.name}`}
            src={generated.url}
            style={{ flex: 1, width: "100%", border: 0 }}
          />
        ) : (
          <div style={{ padding: 24, color: "#64748b" }}>
            Preparing payslip…
          </div>
        )}
      </section>
    </div>
  );
}
