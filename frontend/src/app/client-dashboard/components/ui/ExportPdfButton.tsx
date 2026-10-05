/**
 * ExportPdfButton.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Domain-specific PDF export button, sibling to ExportCsvButton.tsx.
 * Visual behaviour comes entirely from JellyButton. This file owns only the
 * PDF logic:
 *   buildPdfDoc()    → generates a formatted jsPDF document from rows +
 *                       column definitions (header band, meta line, summary
 *                       cards, data table, footer)
 *   downloadPdf()    → triggers a browser download of the built document
 *   ExportPdfButton  → thin wrapper: computes isDisabled, calls handleExport
 *
 * Exported utilities (buildPdfDoc, downloadPdf, PdfPrimitive,
 * ExportPdfColumn) remain importable independently for headless export
 * flows (e.g. "email this report" actions).
 *
 * Requires "jspdf" and "jspdf-autotable" — see package.json.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback } from "react";
import { FileText } from "lucide-react";
import jsPDF from "jspdf";
import autoTable, { type Color as AutoTableColor } from "jspdf-autotable";
import { JellyButton } from "./JellyButton";
import type { JellyButtonAsButton } from "./JellyButton";
import {
  formatDisplayDate,
  formatDisplayDateTime,
} from "../../utils/formatDate";

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN TOKENS (RGB tuples — jsPDF's canvas API takes numeric channels,
// not CSS strings). Mirrors the dashboard's T theme object.
// ─────────────────────────────────────────────────────────────────────────────

type Rgb = [number, number, number];

const PDF_COLORS: Record<string, Rgb> = {
  navy700: [19, 68, 113],
  teal600: [13, 148, 136],
  slate50: [248, 250, 252],
  slate200: [226, 232, 240],
  textBody: [51, 65, 85],
  textMuted: [100, 116, 139],
  textLight: [148, 163, 184],
  white: [255, 255, 255],
};

// ─────────────────────────────────────────────────────────────────────────────
// PURE PDF UTILITIES (no React, fully tree-shakable)
// ─────────────────────────────────────────────────────────────────────────────

export type PdfPrimitive = string | number | boolean | null | undefined | Date;

export interface ExportPdfColumn<T> {
  /** Column heading in the generated table */
  header: string;
  /** Simple key access — use when the value lives directly on the row object. */
  key?: keyof T;
  /** Custom accessor — use for nested, computed, or formatted values. */
  accessor?: (row: T, index: number) => PdfPrimitive;
  /** Right-align numeric/currency columns. Defaults to left. */
  align?: "left" | "right" | "center";
}

export interface ExportPdfSummaryItem {
  label: string;
  value: string;
}

export interface ExportPdfOrganization {
  /** Organization / company name rendered in the header band. */
  name?: string;
  /**
   * Logo image already resolved to a data: URI (e.g.
   * "data:image/png;base64,..."). jsPDF can only embed decoded image
   * bytes, not a bare remote URL — resolve those first with
   * `resolveImageAsDataUrl()`. Keeping `buildPdfDoc` synchronous (no
   * fetches inside it) is what keeps it a pure, headless-testable builder.
   */
  logoDataUrl?: string | null;
}

export interface BuildPdfOptions<T> {
  /** Report title in the header band, e.g. "Payroll Report". */
  title: string;
  /** Sub-line under the title, e.g. branch + period. */
  subtitle?: string;
  /** Report period rendered on the right side of the header band. */
  reportPeriod?: string;
  /**
   * Short badge rendered directly under the title in the header band, e.g.
   * the reporting month ("January 2026"). Distinct from `reportPeriod`
   * (a left-aligned "from – to" range) and `subtitle` (free-text line that
   * renders below this tag when both are present).
   */
  titleTag?: string;
  /** Organization identity (name + logo) rendered in the header band. */
  organization?: ExportPdfOrganization;
  /**
   * Moment the export was generated. Recorded as the first meta entry
   * ("Exported On") and reused in the footer, so both stay in sync even
   * though autotable rendering below can take a beat. Defaults to
   * `new Date()` — pass it explicitly when a PDF and a CSV from the same
   * click need byte-identical timestamps.
   */
  exportedAt?: Date;
  /** Key/value pairs rendered as a meta line under the header band
   *  (period, filters, generated-by, etc). "Exported On" is added
   *  automatically — don't include it here. */
  meta?: Record<string, PdfPrimitive>;
  /** Stat cards rendered above the table (total payout, employee count…). */
  summary?: ExportPdfSummaryItem[];
  /**
   * Overtime rate used for this period, in currency/hour. Shown as its own
   * meta entry so the reader can see the rate that produced every OT Pay
   * figure in the table without hunting through Payroll Rules.
   */
  otRatePerHour?: number;
  otRateLabel?: string; // e.g. "Rs." — defaults to "Rs."
  data: T[];
  columns: ExportPdfColumn<T>[];
}

const formatCell = (value: PdfPrimitive): string => {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return formatDisplayDate(value);
  return String(value);
};

const sanitizeFilename = (filename: string): string => {
  const cleaned = filename
    .trim()
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "_");
  return `${cleaned || "export"}.pdf`;
};

/** jsPDF's addImage() needs an explicit format hint — sniff it from the
 *  data: URI's mime type instead of trusting the caller to pass it. */
const imageFormatFromDataUrl = (dataUrl: string): "PNG" | "JPEG" | "WEBP" => {
  const mime = /^data:image\/(png|jpe?g|webp)/i
    .exec(dataUrl)?.[1]
    ?.toLowerCase();
  if (mime === "jpg" || mime === "jpeg") return "JPEG";
  if (mime === "webp") return "WEBP";
  return "PNG";
};

/**
 * Resolves any image URL (remote http(s), relative, or already a data:
 * URI) to a data: URI, so it can be embedded in a jsPDF document. Never
 * throws — a broken/CORS-blocked/missing logo should never block an
 * export, it should just render without one.
 */
export async function resolveImageAsDataUrl(
  url: string | null | undefined,
): Promise<string | null> {
  if (!url) return null;
  if (url.startsWith("data:")) return url;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () =>
        resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Builds a formatted, multi-section jsPDF document:
 *   1. Navy header band with title + subtitle
 *   2. Meta line (branch, period, filters, OT rate…)
 *   3. Summary stat cards
 *   4. Striped data table (jspdf-autotable)
 *   5. Footer with generated timestamp + page numbers on every page
 */
export function buildPdfDoc<T>(options: BuildPdfOptions<T>): jsPDF {
  const {
    title,
    subtitle,
    reportPeriod,
    titleTag,
    organization,
    exportedAt = new Date(),
    meta,
    summary,
    otRatePerHour,
    otRateLabel = "Rs.",
    data,
    columns,
  } = options;

  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 32;
  let cursorY = margin;

  // ── 1. Header band ──────────────────────────────────────────────────────
  // Organization name + report period appear on the left edge, while the
  // report title sits on the right. Subtitle remains right-aligned below the
  // title.
  const hasOrgName = !!organization?.name;
  const hasLogo = !!organization?.logoDataUrl;
  const logoSize = 30;
  const textX = margin + (hasLogo ? logoSize + 12 : 0);
  const bandHeight =
    48 +
    (hasOrgName ? 20 : 0) +
    (reportPeriod ? 14 : 0) +
    (titleTag ? 16 : 0) +
    (subtitle ? 14 : 0);

  doc.setFillColor(...PDF_COLORS.navy700);
  doc.rect(0, 0, pageWidth, bandHeight, "F");

  if (hasLogo) {
    try {
      doc.addImage(
        organization!.logoDataUrl as string,
        imageFormatFromDataUrl(organization!.logoDataUrl as string),
        margin,
        (bandHeight - logoSize) / 2,
        logoSize,
        logoSize,
      );
    } catch {
      // Corrupt/unsupported image bytes — skip the logo, never fail the export.
    }
  }

  doc.setTextColor(...PDF_COLORS.white);
  let leftTextY = hasOrgName ? 22 : 30;

  if (hasOrgName) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(organization!.name as string, textX, leftTextY);
  }

  if (reportPeriod) {
    if (hasOrgName) leftTextY += 18;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text(reportPeriod, textX, leftTextY);
  }

  const titleY = hasOrgName ? 22 : 30;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(title, pageWidth - margin, titleY, { align: "right" });

  // Title tag (e.g. reporting month) renders as a small pill directly under
  // the title, right-aligned to match it. `belowTitleY` tracks where the
  // next right-aligned line (the tag, then subtitle) should start.
  let belowTitleY = titleY;
  if (titleTag) {
    const tagPaddingX = 8;
    const tagHeight = 14;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    const tagTextWidth = doc.getTextWidth(titleTag);
    const tagWidth = tagTextWidth + tagPaddingX * 2;
    const tagX = pageWidth - margin - tagWidth;
    const tagY = titleY + 8;

    doc.setFillColor(...PDF_COLORS.teal600);
    doc.roundedRect(tagX, tagY, tagWidth, tagHeight, 7, 7, "F");
    doc.setTextColor(...PDF_COLORS.white);
    doc.text(titleTag, tagX + tagWidth / 2, tagY + tagHeight / 2 + 3, {
      align: "center",
    });

    belowTitleY = tagY + tagHeight;
  }

  if (subtitle) {
    const subtitleY = titleTag ? belowTitleY + 12 : titleY + 18;
    doc.setTextColor(...PDF_COLORS.white);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text(subtitle, pageWidth - margin, subtitleY, { align: "right" });
  }

  cursorY = bandHeight + 22;

  // ── 2. Meta line — "Exported On" always leads, then the OT rate always
  //      folds in as its own entry ─────────────────────────────────────
  const metaEntries: [string, string][] = [
    ["Exported On", formatDisplayDateTime(exportedAt)],
    ...Object.entries(meta ?? {})
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => [k, formatCell(v)] as [string, string]),
  ];

  if (otRatePerHour !== undefined && otRatePerHour !== null) {
    metaEntries.push([
      "OT Rate",
      `${otRateLabel} ${otRatePerHour.toLocaleString()}/hr`,
    ]);
  }

  if (metaEntries.length) {
    doc.setTextColor(...PDF_COLORS.textBody);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const metaLine = metaEntries
      .map(([k, v]) => `${k}: ${v}`)
      .join("    ·    ");
    doc.text(metaLine, margin, cursorY);
    cursorY += 20;
  }

  // ── 3. Summary stat cards ───────────────────────────────────────────────
  if (summary && summary.length) {
    const gap = 10;
    const cardWidth =
      (pageWidth - margin * 2 - gap * (summary.length - 1)) / summary.length;
    const cardHeight = 42;
    let x = margin;

    summary.forEach((item) => {
      doc.setDrawColor(...PDF_COLORS.slate200);
      doc.setFillColor(...PDF_COLORS.slate50);
      doc.roundedRect(x, cursorY, cardWidth, cardHeight, 6, 6, "FD");

      doc.setTextColor(...PDF_COLORS.textMuted);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7.5);
      doc.text(item.label.toUpperCase(), x + 10, cursorY + 16);

      doc.setTextColor(...PDF_COLORS.navy700);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.text(item.value, x + 10, cursorY + 32);

      x += cardWidth + gap;
    });

    cursorY += cardHeight + 18;
  }

  // ── 4. Data table ────────────────────────────────────────────────────────
  const columnStyles: Record<number, { halign: "left" | "right" | "center" }> =
    {};
  columns.forEach((col, i) => {
    if (col.align) columnStyles[i] = { halign: col.align };
  });

  autoTable(doc, {
    startY: cursorY,
    margin: { left: margin, right: margin, bottom: 40 },
    head: [columns.map((c) => c.header)],
    body: data.map((row, i) =>
      columns.map((col) => {
        const value = col.accessor
          ? col.accessor(row, i)
          : col.key !== undefined
            ? (row[col.key] as PdfPrimitive)
            : "";
        return formatCell(value);
      }),
    ),
    styles: {
      fontSize: 8,
      cellPadding: 5,
      textColor: PDF_COLORS.textBody as AutoTableColor,
      lineColor: PDF_COLORS.slate200 as AutoTableColor,
      lineWidth: 0.5,
    },
    headStyles: {
      fillColor: PDF_COLORS.teal600 as AutoTableColor,
      textColor: PDF_COLORS.white as AutoTableColor,
      fontStyle: "bold",
      fontSize: 8,
    },
    alternateRowStyles: {
      fillColor: PDF_COLORS.slate50 as AutoTableColor,
    },
    columnStyles,
  });

  // ── 5. Footer — generated timestamp + page numbers on every page ───────
  const pageCount = doc.getNumberOfPages();
  const pageHeight = doc.internal.pageSize.getHeight();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...PDF_COLORS.textLight);
    doc.text(
      `Generated ${formatDisplayDateTime(exportedAt)}`,
      margin,
      pageHeight - 16,
    );
    doc.text(
      `Page ${page} of ${pageCount}`,
      pageWidth - margin,
      pageHeight - 16,
      { align: "right" },
    );
  }

  return doc;
}

/** Triggers a browser download for the given jsPDF document. */
export function downloadPdf(filename: string, doc: jsPDF): void {
  doc.save(sanitizeFilename(filename));
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportPdfButtonProps<T> extends Omit<
  JellyButtonAsButton,
  "onClick" | "loading" | "disabled" | "leftIcon" | "children" | "as" | "type"
> {
  /** Already-filtered rows — pass the same data visible in the page/table. */
  data: T[];
  columns: ExportPdfColumn<T>[];
  filename: string;
  /** Report title shown in the PDF header band. */
  title: string;
  subtitle?: string;
  reportPeriod?: string;
  /** Short badge rendered under the title — see `BuildPdfOptions.titleTag`. */
  titleTag?: string;
  meta?: Record<string, PdfPrimitive>;
  summary?: ExportPdfSummaryItem[];
  /** Overtime rate for the period — rendered in the meta line as "OT Rate". */
  otRatePerHour?: number;
  otRateLabel?: string;
  label?: string;
  /** Alert message when export is triggered with an empty dataset. */
  emptyMessage?: string;
}

function ExportPdfButtonInner<T>(
  {
    data,
    columns,
    filename,
    title,
    subtitle,
    reportPeriod,
    titleTag,
    meta,
    summary,
    otRatePerHour,
    otRateLabel,
    label = "Export PDF",
    emptyMessage = "No records available to export.",
    variant = "ghost",
    size = "md",
    ...jellyProps
  }: ExportPdfButtonProps<T>,
  ref: React.ForwardedRef<HTMLButtonElement>,
) {
  const isEmpty = data.length === 0 || columns.length === 0;

  const handleExport = useCallback(() => {
    if (isEmpty) {
      window.alert(emptyMessage);
      return;
    }
    const doc = buildPdfDoc({
      title,
      subtitle,
      reportPeriod,
      titleTag,
      meta,
      summary,
      otRatePerHour,
      otRateLabel,
      data,
      columns,
    });
    downloadPdf(filename, doc);
  }, [
    data,
    columns,
    filename,
    title,
    subtitle,
    reportPeriod,
    titleTag,
    meta,
    summary,
    otRatePerHour,
    otRateLabel,
    isEmpty,
    emptyMessage,
  ]);

  return (
    <JellyButton
      ref={ref}
      {...jellyProps}
      type="button"
      variant={variant}
      size={size}
      leftIcon={<FileText />}
      disabled={isEmpty}
      onClick={handleExport}
      title={isEmpty ? emptyMessage : label}
    >
      {label}
    </JellyButton>
  );
}

// Generic forwardRef requires a manual cast because TypeScript does not support
// generic components directly inside forwardRef's callback signature.
export const ExportPdfButton = React.forwardRef(ExportPdfButtonInner) as <T>(
  props: ExportPdfButtonProps<T> & {
    ref?: React.ForwardedRef<HTMLButtonElement>;
  },
) => React.ReactElement;

Object.defineProperty(ExportPdfButton, "displayName", {
  value: "ExportPdfButton",
});

export default ExportPdfButton;
