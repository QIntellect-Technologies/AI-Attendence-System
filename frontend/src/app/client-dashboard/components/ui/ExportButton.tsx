/**
 * ExportButton.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Single "Export ▾" trigger with a format dropdown (CSV / PDF Report),
 * replacing two separate buttons in the toolbar. Reuses the pure, headless
 * build/download functions already exported by ExportCsvButton.tsx and
 * ExportPdfButton.tsx — this file adds no new export logic, only the menu
 * chrome that picks which one to run.
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
import { formatDisplayDateTime } from "../../utils/formatDate";
import {
  buildCsv,
  downloadCsv,
  type CsvPrimitive,
  type ExportCsvColumn,
} from "./ExportCsvButton";
import {
  buildPdfDoc,
  downloadPdf,
  resolveImageAsDataUrl,
  type PdfPrimitive,
  type ExportPdfColumn,
  type ExportPdfSummaryItem,
  type ExportPdfOrganization,
} from "./ExportPdfButton";

// ─────────────────────────────────────────────────────────────────────────────
// PROPS
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportButtonCsvOptions<T> {
  columns: ExportCsvColumn<T>[];
  filters?: Record<string, CsvPrimitive>;
  includeFilterMeta?: boolean;
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
 * formats: rendered in the PDF's header band (name + logo) and as a
 * leading meta row in the CSV, which has no header band to put it in.
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
  csv: ExportButtonCsvOptions<T>;
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
    csv,
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

  const handleExportCsv = () => {
    if (isEmpty) {
      window.alert(emptyMessage);
      return;
    }
    // CSV has no header band, so "Organization" rides along as a leading
    // meta row instead, and "Exported On" is always appended — both
    // independent of (and always shown regardless of) the caller's own
    // opt-in `csv.filters` / `includeFilterMeta`, which keeps its original
    // behavior for every other module already using this button.
    const reportInfo: Record<string, CsvPrimitive> = {
      ...(organization?.name ? { Organization: organization.name } : {}),
      ...(csv.includeFilterMeta ? csv.filters : undefined),
      "Exported On": formatDisplayDateTime(new Date()),
    };
    const csvString = buildCsv(data, csv.columns, reportInfo, true);
    downloadCsv(filename, csvString);
    setOpen(false);
  };

  const handleExportPdf = async () => {
    if (isEmpty) {
      window.alert(emptyMessage);
      return;
    }
    const exportedAt = new Date();
    const logoDataUrl = await resolveImageAsDataUrl(organization?.logoUrl);
    const organizationForPdf: ExportPdfOrganization | undefined =
      organization?.name || logoDataUrl
        ? { name: organization?.name, logoDataUrl }
        : undefined;

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
                label="Export as CSV"
                sublabel="Raw rows for spreadsheets"
                onClick={handleExportCsv}
              />
              <ExportMenuRow
                icon={<FileText size={14} color={T.teal600} />}
                label="Export as PDF"
                sublabel="Formatted report with summary"
                onClick={handleExportPdf}
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
}> = ({ icon, label, sublabel, onClick }) => (
  <div
    data-dropdown-row
    onClick={onClick}
    style={{
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "10px 14px",
      cursor: "pointer",
      transition: "background .1s",
    }}
    onMouseEnter={(e) => {
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
        {label}
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
