/**
 * ExportButton.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Single "Export ▾" trigger with a format dropdown (Excel / PDF Report),
 * replacing two separate buttons in the toolbar. Reuses the pure, headless
 * build/download functions already exported by ExportExcelButton.tsx and
 * ExportPdfButton.tsx — this file adds no new export logic, only the menu
 * chrome that picks which one to run.
 *
 * NOTE: plain-CSV export was replaced with formatted Excel (.xlsx) export
 * across the app — CSV is plain text and cannot carry cell colors, fonts,
 * borders, or a branded header band, which is what made the old CSV output
 * look like a raw, unformatted database dump. ExportCsvButton.tsx itself is
 * unchanged and still available for any future headless/API export flow
 * that specifically needs raw CSV.
 *
 * Dropdown mechanics (portal + fixed positioning + expand animation) follow
 * the same pattern as BranchSelector.tsx / ModernSelect.tsx:
 *   useDropdownPosition   → viewport-fixed coordinates anchored to the trigger
 *   useDropdownTransition → expanding-card open/close animation
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Download, FileSpreadsheet, FileText } from "lucide-react";
import { JellyButton } from "./JellyButton";
import type { JellyButtonAsButton } from "./JellyButton";
import { T } from "./theme";
import { useDropdownPosition } from "../../hooks/useDropdownPosition";
import { useDropdownTransition } from "../../hooks/useDropdownTransition";
import {
  buildPdfDoc,
  downloadPdf,
  resolveImageAsDataUrl,
  type PdfPrimitive,
  type ExportPdfColumn,
  type ExportPdfSummaryItem,
  type ExportPdfOrganization,
} from "./ExportPdfButton";
import {
  buildExcelWorkbook,
  downloadExcel,
  type ExcelPrimitive,
  type ExportExcelColumn,
  type ExportExcelSummaryItem,
  type ExportExcelOrganization,
} from "./ExportExcelButton";

// ─────────────────────────────────────────────────────────────────────────────
// PROPS
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportButtonExcelOptions<T> {
  columns: ExportExcelColumn<T>[];
  /**
   * Title chrome (title/subtitle/titleTag/reportPeriod) falls back to the
   * `pdf` config below when omitted here, since both formats share the same
   * report framing. `meta` and `summary` do NOT fall back: those are filter
   * context and aggregate rows, which belong in a printed report but corrupt
   * a spreadsheet meant for sorting and pivoting. Pass them explicitly on
   * `excel` if a specific export genuinely wants them.
   */
  title?: string;
  subtitle?: string;
  titleTag?: string;
  reportPeriod?: string;
  meta?: Record<string, ExcelPrimitive>;
  summary?: ExportExcelSummaryItem[];
  /** Worksheet tab name. Defaults to the resolved title. */
  sheetName?: string;
}

export interface ExportButtonPdfOptions<T> {
  columns: ExportPdfColumn<T>[];
  title: string;
  subtitle?: string;
  /** Short badge rendered under the title in the PDF header band, e.g. the reporting month. */
  titleTag?: string;
  meta?: Record<string, PdfPrimitive>;
  summary?: ExportPdfSummaryItem[];
  otRatePerHour?: number;
  otRateLabel?: string;
  organization?: {
    name?: string;
    logoUrl?: string;
  };
  reportPeriod?: string;
}

/**
 * Organization identity for the export. Single source of truth for both
 * formats: rendered in the header band (name + logo) of both the PDF and
 * the Excel workbook.
 */
export interface ExportButtonOrganization {
  name?: string;
  /**
   * Logo URL (http(s) or data:). Resolved to a data: URI before being
   * embedded in the PDF. A failed or CORS-blocked fetch silently omits
   * the logo rather than failing the export.
   */
  logoUrl?: string | null;
}

export interface ExportButtonProps<T> extends Omit<
  JellyButtonAsButton,
  | "onClick"
  | "loading"
  | "disabled"
  | "leftIcon"
  | "rightIcon"
  | "children"
  | "as"
  | "type"
> {
  /** Already-filtered rows — pass the same data visible in the page/table. */
  data: T[];
  /** Base filename, without extension — each format appends its own. */
  filename: string;
  excel: ExportButtonExcelOptions<T>;
  pdf: ExportButtonPdfOptions<T>;
  /** Organization branding, folded into both export formats automatically. */
  organization?: ExportButtonOrganization;
  label?: string;
  emptyMessage?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

function ExportButtonInner<T>(
  {
    data,
    filename,
    excel,
    pdf,
    organization,
    label = "Export",
    emptyMessage = "No records available to export.",
    variant = "ghost",
    size = "md",
    ...jellyProps
  }: ExportButtonProps<T>,
  ref: React.ForwardedRef<HTMLButtonElement>,
) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const { shouldRender, panelRef, contentRef } = useDropdownTransition<
    HTMLDivElement,
    HTMLDivElement
  >(open);
  const position = useDropdownPosition(triggerRef, open, {
    align: "end",
    gap: 6,
    minWidth: 190,
  });

  const isEmpty = data.length === 0;

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      const clickedTrigger = triggerRef.current?.contains(target);
      // Panel is portaled to document.body, so it must be checked
      // independently of the trigger's own DOM subtree.
      const clickedPanel = panelRef.current?.contains(target);
      if (!clickedTrigger && !clickedPanel) setOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [panelRef]);

  // Shared by both PDF and Excel — resolves the org logo URL to embeddable
  // data: bytes once, rather than duplicating the fetch/try-catch in each
  // handler. Returns undefined (not just an empty object) when there's
  // nothing to show, so downstream builders can cleanly omit the header
  // band's org line instead of rendering an empty one.
  const resolveOrganizationForExport = async (): Promise<
    { name?: string; logoDataUrl: string | null } | undefined
  > => {
    const logoDataUrl = await resolveImageAsDataUrl(organization?.logoUrl);
    return organization?.name || logoDataUrl
      ? { name: organization?.name, logoDataUrl }
      : undefined;
  };

  const [isExportingExcel, setIsExportingExcel] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);

  const handleExportExcel = async () => {
    if (isEmpty) {
      window.alert(emptyMessage);
      return;
    }
    setIsExportingExcel(true);
    try {
      const exportedAt = new Date();
      const organizationForExcel: ExportExcelOrganization | undefined =
        await resolveOrganizationForExport();

      const workbook = buildExcelWorkbook({
        // Report chrome defaults to the `pdf` config — see
        // ExportButtonExcelOptions doc comment for why.
        title: excel.title ?? pdf.title,
        subtitle: excel.subtitle ?? pdf.subtitle,
        titleTag: excel.titleTag ?? pdf.titleTag,
        reportPeriod: excel.reportPeriod ?? pdf.reportPeriod,
        // Excel deliberately does NOT inherit meta/summary from the PDF config.
        // A .xlsx is a data file — users sort, filter and pivot it, and leading
        // context rows shift every column reference and break that. The PDF is
        // the presentation format and keeps the full filter context.
        meta: excel.meta,
        summary: excel.summary,
        sheetName: excel.sheetName,
        organization: organizationForExcel,
        exportedAt,
        data,
        columns: excel.columns,
      });
      await downloadExcel(filename, workbook);
      setOpen(false);
    } finally {
      setIsExportingExcel(false);
    }
  };

  const handleExportPdf = async () => {
    if (isEmpty) {
      window.alert(emptyMessage);
      return;
    }
    setIsExportingPdf(true);
    try {
      const exportedAt = new Date();
      const organizationForPdf: ExportPdfOrganization | undefined =
        await resolveOrganizationForExport();

      const doc = buildPdfDoc({
        title: pdf.title,
        subtitle: pdf.subtitle,
        titleTag: pdf.titleTag,
        organization: organizationForPdf,
        exportedAt,
        reportPeriod: pdf.reportPeriod,
        meta: pdf.meta,
        summary: pdf.summary,
        otRatePerHour: pdf.otRatePerHour,
        otRateLabel: pdf.otRateLabel,
        data,
        columns: pdf.columns,
      });
      downloadPdf(filename, doc);
      setOpen(false);
    } finally {
      setIsExportingPdf(false);
    }
  };

  return (
    <div
      ref={triggerRef}
      style={{ position: "relative", display: "inline-flex" }}
    >
      <JellyButton
        ref={ref}
        {...jellyProps}
        type="button"
        variant={variant}
        size={size}
        leftIcon={<Download />}
        rightIcon={
          <ChevronDown
            style={{
              transform: open ? "rotate(180deg)" : "none",
              transition: "transform .2s",
            }}
          />
        }
        disabled={isEmpty}
        onClick={() => setOpen((o) => !o)}
        title={isEmpty ? emptyMessage : label}
      >
        {label}
      </JellyButton>

      {shouldRender &&
        position &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: "fixed",
              top: position.top,
              right: position.right,
              minWidth: position.minWidth,
              zIndex: 100,
              background: T.card,
              border: `1px solid ${T.border}`,
              borderRadius: 10,
              boxShadow: "0 8px 24px rgba(0,0,0,0.1)",
              // overflow + height are owned imperatively by useDropdownTransition
            }}
          >
            <div ref={contentRef}>
              <ExportMenuRow
                icon={<FileSpreadsheet size={14} color={T.teal600} />}
                label="Export as Excel"
                sublabel="Formatted, branded spreadsheet"
                onClick={handleExportExcel}
                loading={isExportingExcel}
              />
              <ExportMenuRow
                icon={<FileText size={14} color={T.teal600} />}
                label="Export as PDF"
                sublabel="Formatted report with summary"
                onClick={handleExportPdf}
                loading={isExportingPdf}
              />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

const ExportMenuRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  sublabel: string;
  onClick: () => void;
  loading?: boolean;
}> = ({ icon, label, sublabel, onClick, loading = false }) => (
  <div
    data-dropdown-row
    onClick={loading ? undefined : onClick}
    aria-busy={loading || undefined}
    style={{
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "10px 14px",
      cursor: loading ? "default" : "pointer",
      opacity: loading ? 0.6 : 1,
      transition: "background .1s, opacity .1s",
    }}
    onMouseEnter={(e) => {
      if (!loading)
        (e.currentTarget as HTMLDivElement).style.background = T.teal50;
    }}
    onMouseLeave={(e) => {
      (e.currentTarget as HTMLDivElement).style.background = "transparent";
    }}
  >
    <span
      style={{
        width: 26,
        height: 26,
        borderRadius: 7,
        background: T.teal50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {icon}
    </span>
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: T.head }}>
        {loading ? "Generating…" : label}
      </div>
      <div style={{ fontSize: 10, color: T.muted }}>{sublabel}</div>
    </div>
  </div>
);

// Generic forwardRef requires a manual cast because TypeScript does not support
// generic components directly inside forwardRef's callback signature.
export const ExportButton = React.forwardRef(ExportButtonInner) as <T>(
  props: ExportButtonProps<T> & {
    ref?: React.ForwardedRef<HTMLButtonElement>;
  },
) => React.ReactElement;

Object.defineProperty(ExportButton, "displayName", {
  value: "ExportButton",
});

export default ExportButton;
