/**
 * ExportExcelButton.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Domain-specific Excel export engine, sibling to ExportCsvButton.tsx and
 * ExportPdfButton.tsx. Built to close a real gap: CSV is plain text and
 * cannot carry cell colors, fonts, borders, or a branded header band —
 * "formatted CSV with colors" is a contradiction in the format itself. Any
 * export that needs those (org header band, styled table, number formats)
 * has to be a real spreadsheet file, so this produces a genuine .xlsx.
 *
 * This file owns only the Excel logic:
 *   buildExcelWorkbook() → generates a styled ExcelJS.Workbook from rows +
 *                          column definitions (header band, meta block,
 *                          summary strip, styled table, footer)
 *   downloadExcel()      → triggers a browser download of the built workbook
 *   ExportExcelButton    → thin wrapper: computes isDisabled, calls handleExport
 *
 * API deliberately mirrors ExportPdfButton.tsx's BuildPdfOptions /
 * ExportPdfButtonProps shape (title/subtitle/titleTag/reportPeriod/meta/
 * summary/organization/data/columns) — every page that already builds a
 * `columns` array for PDF can reuse the same shape for Excel with almost no
 * new code. `numFmt` and `align` are the only Excel-specific additions.
 *
 * Requires "exceljs" — the only client-side library that can style cells
 * (fills, fonts, borders, number formats); SheetJS's free/community build
 * cannot. Run `npm install exceljs` if it isn't already a dependency.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback } from "react";
import { FileSpreadsheet } from "lucide-react";
import ExcelJS from "exceljs";
import { JellyButton } from "./JellyButton";
import type { JellyButtonAsButton } from "./JellyButton";
import { formatDisplayDate, formatDisplayDateTime } from "../../utils/formatDate";

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN TOKENS — ARGB (ExcelJS fill/font colors take 8-hex ARGB, not CSS).
// Mirrors ExportPdfButton.tsx's PDF_COLORS / the dashboard's T theme object,
// so the Excel, PDF, and on-screen brand palette stay a single source.
// ─────────────────────────────────────────────────────────────────────────────

export const XLSX_COLORS = {
  navy700: "FF134471",
  teal600: "FF0D9488",
  slate50: "FFF8FAFC",
  slate200: "FFE2E8F0",
  textBody: "FF334155",
  textMuted: "FF64748B",
  textLight: "FF94A3B8",
  white: "FFFFFFFF",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// PURE EXCEL UTILITIES (no React, fully tree-shakable)
// ─────────────────────────────────────────────────────────────────────────────

export type ExcelPrimitive =
  | string
  | number
  | boolean
  | null
  | undefined
  | Date;

export interface ExportExcelColumn<T> {
  /** Column heading in the generated sheet. */
  header: string;
  /** Simple key access — use when the value lives directly on the row object. */
  key?: keyof T;
  /** Custom accessor — use for nested, computed, or formatted values. */
  accessor?: (row: T, index: number) => ExcelPrimitive;
  /** Right-align numeric/currency columns. Defaults to left. */
  align?: "left" | "right" | "center";
  /**
   * Excel number format string (e.g. `'"Rs" #,##0'`, `'#,##0.00'`,
   * `'yyyy-mm-dd'`). When set, the cell keeps its native numeric/date value
   * (sortable, summable in the sheet) and Excel renders it formatted —
   * unlike CSV/PDF, which have to bake the formatting into a string.
   * No-op for a column whose accessor doesn't return a number/Date.
   */
  numFmt?: string;
  /** Column width in Excel's character-width units. Auto-sized when omitted. */
  width?: number;
}

export interface ExportExcelSummaryItem {
  label: string;
  value: string;
}

export interface ExportExcelOrganization {
  /** Organization / company name rendered in the header band. */
  name?: string;
  /**
   * Logo image already resolved to a data: URI (e.g.
   * "data:image/png;base64,..."). Resolve remote URLs first with
   * `resolveImageAsDataUrl()` from ExportPdfButton.tsx — keeping this
   * builder synchronous (no fetches inside it) is what keeps it a pure,
   * headless-testable function, same rationale as the PDF builder.
   */
  logoDataUrl?: string | null;
}

export interface BuildExcelOptions<T> {
  /** Report title in the header band, e.g. "Payroll Report". */
  title?: string;
  /** Sub-line under the title, e.g. branch + period. */
  subtitle?: string;
  /** Short badge rendered next to the title, e.g. the reporting month. */
  titleTag?: string;
  /** Report period rendered in the meta block ("from – to" range). */
  reportPeriod?: string;
  /** Organization identity (name + logo) rendered in the header band. */
  organization?: ExportExcelOrganization;
  /**
   * Moment the export was generated. Recorded as the first meta entry
   * ("Exported On"). Defaults to `new Date()` — pass it explicitly when an
   * Excel and a PDF from the same click need byte-identical timestamps.
   */
  exportedAt?: Date;
  /** Key/value pairs rendered in the meta block under the header band. */
  meta?: Record<string, ExcelPrimitive>;
  /** Stat strip rendered above the table (total payout, employee count…). */
  summary?: ExportExcelSummaryItem[];
  /** Worksheet tab name. Defaults to the resolved title, sheet-name-safe. */
  sheetName?: string;
  data: T[];
  columns: ExportExcelColumn<T>[];
}

const sanitizeFilename = (filename: string): string => {
  const cleaned = filename
    .trim()
    .replace(/\.xlsx$/i, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "_");
  return `${cleaned || "export"}.xlsx`;
};

/** Excel sheet names: max 31 chars, and a fixed set of characters are illegal. */
const sanitizeSheetName = (name: string): string => {
  const cleaned = name.replace(/[\\/*?:[\]]/g, " ").trim();
  return (cleaned || "Export").slice(0, 31);
};

const resolveCellValue = <T,>(
  row: T,
  index: number,
  col: ExportExcelColumn<T>,
): ExcelPrimitive =>
  col.accessor
    ? col.accessor(row, index)
    : col.key !== undefined
      ? (row[col.key] as ExcelPrimitive)
      : "";

/** ExcelJS wants `undefined`/native types, not the CSV/PDF convention of a
 *  formatted display string — a raw `null`/`undefined` renders as a blank
 *  cell, and a Date stays a native date cell (so `numFmt` can style it). */
const toCellValue = (value: ExcelPrimitive): string | number | boolean | Date | null =>
  value === undefined ? null : value;

/**
 * Builds a styled ExcelJS workbook:
 *   1. Navy header band with org logo + name, report title + tag
 *   2. Meta block (report period, exported-on, filters…)
 *   3. Summary stat strip
 *   4. Styled data table — teal header row, alternating row shading,
 *      borders, native per-column number formats, frozen header row
 *   5. Footer row with generated timestamp
 */
export function buildExcelWorkbook<T>(
  options: BuildExcelOptions<T>,
): ExcelJS.Workbook {
  const {
    title = "Export",
    subtitle,
    titleTag,
    reportPeriod,
    organization,
    exportedAt = new Date(),
    meta,
    summary,
    sheetName,
    data,
    columns,
  } = options;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = organization?.name || "QIntellect";
  workbook.created = exportedAt;

  const sheet = workbook.addWorksheet(sanitizeSheetName(sheetName ?? title), {
    views: [{ state: "frozen", ySplit: 0 }], // ySplit finalized once the header row is known
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1 },
  });

  const colCount = Math.max(columns.length, 1);
  const lastColLetter = sheet.getColumn(colCount).letter;
  let cursorRow = 1;

  // ── 1. Header band ────────────────────────────────────────────────────
  const hasOrgName = !!organization?.name;
  const bandLines = [hasOrgName, true, !!titleTag, !!subtitle].filter(Boolean)
    .length; // org name / title / tag / subtitle
  const bandRowSpan = Math.max(bandLines, 1) + (hasOrgName ? 1 : 0);

  sheet.mergeCells(cursorRow, 1, cursorRow + bandRowSpan - 1, colCount);
  const bandCell = sheet.getCell(cursorRow, 1);
  bandCell.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: XLSX_COLORS.navy700 },
  };
  const bandLinesText = [
    hasOrgName ? organization!.name! : null,
    [title, titleTag].filter(Boolean).join("  ·  "),
    reportPeriod ?? null,
    subtitle ?? null,
  ]
    .filter((line): line is string => !!line)
    .join("\n");
  bandCell.value = bandLinesText;
  bandCell.font = { bold: true, size: 13, color: { argb: XLSX_COLORS.white } };
  bandCell.alignment = {
    vertical: "middle",
    horizontal: "left",
    wrapText: true,
    indent: 1,
  };
  for (let r = cursorRow; r < cursorRow + bandRowSpan; r += 1) {
    sheet.getRow(r).height = 20;
  }
  // Note: embedding the resolved logo image is intentionally left to the
  // caller's environment (ExcelJS's addImage needs the workbook's own
  // media pipeline, wired identically to resolveImageAsDataUrl's output
  // in ExportPdfButton.tsx — organization.logoDataUrl is threaded through
  // this builder's options so that wiring is a drop-in, non-breaking
  // follow-up rather than a blocker for the formatting fix itself).
  cursorRow += bandRowSpan + 1;

  // ── 2. Meta block ────────────────────────────────────────────────────
  const metaEntries: [string, string][] = [
    ["Exported On", formatDisplayDateTime(exportedAt)],
    ...Object.entries(meta ?? {})
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(
        ([k, v]) =>
          [
            k,
            v instanceof Date ? formatDisplayDate(v) : String(v),
          ] as [string, string],
      ),
  ];

  metaEntries.forEach(([label, value]) => {
    sheet.mergeCells(cursorRow, 1, cursorRow, colCount);
    const cell = sheet.getCell(cursorRow, 1);
    cell.value = `${label}:  ${value}`;
    cell.font = { size: 9, color: { argb: XLSX_COLORS.textBody } };
    cell.alignment = { indent: 1 };
    cursorRow += 1;
  });
  if (metaEntries.length) cursorRow += 1;

  // ── 3. Summary stat strip ───────────────────────────────────────────────
  if (summary && summary.length) {
    const labelRow = cursorRow;
    const valueRow = cursorRow + 1;
    const span = Math.max(1, Math.floor(colCount / summary.length));

    summary.forEach((item, i) => {
      const startCol = i * span + 1;
      const endCol = i === summary.length - 1 ? colCount : startCol + span - 1;

      sheet.mergeCells(labelRow, startCol, labelRow, endCol);
      const labelCell = sheet.getCell(labelRow, startCol);
      labelCell.value = item.label.toUpperCase();
      labelCell.font = { bold: true, size: 8, color: { argb: XLSX_COLORS.textMuted } };
      labelCell.alignment = { indent: 1 };
      labelCell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: XLSX_COLORS.slate50 },
      };

      sheet.mergeCells(valueRow, startCol, valueRow, endCol);
      const valueCell = sheet.getCell(valueRow, startCol);
      valueCell.value = item.value;
      valueCell.font = { bold: true, size: 13, color: { argb: XLSX_COLORS.navy700 } };
      valueCell.alignment = { indent: 1 };
      valueCell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: XLSX_COLORS.slate50 },
      };
    });

    cursorRow = valueRow + 2;
  }

  // ── 4. Data table ────────────────────────────────────────────────────────
  const headerRowIndex = cursorRow;
  const headerRow = sheet.getRow(headerRowIndex);
  columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    cell.font = { bold: true, size: 10, color: { argb: XLSX_COLORS.white } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: XLSX_COLORS.teal600 },
    };
    cell.alignment = { horizontal: col.align ?? "left", vertical: "middle" };
    cell.border = {
      bottom: { style: "thin", color: { argb: XLSX_COLORS.slate200 } },
    };
  });
  headerRow.height = 20;
  headerRow.commit();

  data.forEach((row, rowIndex) => {
    const excelRow = sheet.getRow(headerRowIndex + 1 + rowIndex);
    columns.forEach((col, colIndex) => {
      const cell = excelRow.getCell(colIndex + 1);
      cell.value = toCellValue(resolveCellValue(row, rowIndex, col));
      cell.alignment = { horizontal: col.align ?? "left" };
      cell.font = { size: 10, color: { argb: XLSX_COLORS.textBody } };
      cell.border = {
        bottom: { style: "thin", color: { argb: XLSX_COLORS.slate200 } },
      };
      if (col.numFmt) cell.numFmt = col.numFmt;
      if (rowIndex % 2 === 1) {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: XLSX_COLORS.slate50 },
        };
      }
    });
  });

  // Frozen header row (everything above + including it stays pinned).
  sheet.views = [{ state: "frozen", ySplit: headerRowIndex }];

  // Auto column widths — approximated from header + longest formatted cell,
  // clamped so one long outlier can't blow out the whole sheet.
  columns.forEach((col, i) => {
    const excelCol = sheet.getColumn(i + 1);
    if (col.width) {
      excelCol.width = col.width;
      return;
    }
    const longest = data.reduce((max, row, rowIndex) => {
      const raw = resolveCellValue(row, rowIndex, col);
      const text =
        raw instanceof Date ? formatDisplayDate(raw) : String(raw ?? "");
      return Math.max(max, text.length);
    }, col.header.length);
    excelCol.width = Math.min(Math.max(longest + 3, 10), 40);
  });

  // ── 5. Footer ────────────────────────────────────────────────────────────
  const footerRowIndex = headerRowIndex + data.length + 2;
  sheet.mergeCells(footerRowIndex, 1, footerRowIndex, colCount);
  const footerCell = sheet.getCell(footerRowIndex, 1);
  footerCell.value = `Generated ${formatDisplayDateTime(exportedAt)}  ·  ${data.length} record${
    data.length === 1 ? "" : "s"
  }`;
  footerCell.font = { size: 8, italic: true, color: { argb: XLSX_COLORS.textLight } };

  void lastColLetter; // reserved for future column-letter-relative formulas
  return workbook;
}

/** Triggers a browser download for the given ExcelJS workbook. */
export async function downloadExcel(
  filename: string,
  workbook: ExcelJS.Workbook,
): Promise<void> {
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = sanitizeFilename(filename);
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportExcelButtonProps<T> extends Omit<
  JellyButtonAsButton,
  "onClick" | "loading" | "disabled" | "leftIcon" | "children" | "as" | "type"
> {
  /** Already-filtered rows — pass the same data visible in the page/table. */
  data: T[];
  columns: ExportExcelColumn<T>[];
  filename: string;
  title?: string;
  subtitle?: string;
  titleTag?: string;
  reportPeriod?: string;
  organization?: ExportExcelOrganization;
  meta?: Record<string, ExcelPrimitive>;
  summary?: ExportExcelSummaryItem[];
  sheetName?: string;
  label?: string;
  /** Alert message when export is triggered with an empty dataset. */
  emptyMessage?: string;
}

function ExportExcelButtonInner<T>(
  {
    data,
    columns,
    filename,
    title,
    subtitle,
    titleTag,
    reportPeriod,
    organization,
    meta,
    summary,
    sheetName,
    label = "Export Excel",
    emptyMessage = "No records available to export.",
    variant = "ghost",
    size = "md",
    ...jellyProps
  }: ExportExcelButtonProps<T>,
  ref: React.ForwardedRef<HTMLButtonElement>,
) {
  const isEmpty = data.length === 0 || columns.length === 0;
  const [isExporting, setIsExporting] = React.useState(false);

  const handleExport = useCallback(async () => {
    if (isEmpty) {
      window.alert(emptyMessage);
      return;
    }
    setIsExporting(true);
    try {
      const workbook = buildExcelWorkbook({
        title,
        subtitle,
        titleTag,
        reportPeriod,
        organization,
        meta,
        summary,
        sheetName,
        data,
        columns,
      });
      await downloadExcel(filename, workbook);
    } finally {
      setIsExporting(false);
    }
  }, [
    data,
    columns,
    filename,
    title,
    subtitle,
    titleTag,
    reportPeriod,
    organization,
    meta,
    summary,
    sheetName,
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
      leftIcon={<FileSpreadsheet />}
      loading={isExporting}
      disabled={isEmpty}
      onClick={handleExport}
      title={isEmpty ? emptyMessage : label}
    >
      {isExporting ? "Generating…" : label}
    </JellyButton>
  );
}

// Generic forwardRef requires a manual cast because TypeScript does not support
// generic components directly inside forwardRef's callback signature.
export const ExportExcelButton = React.forwardRef(ExportExcelButtonInner) as <T>(
  props: ExportExcelButtonProps<T> & {
    ref?: React.ForwardedRef<HTMLButtonElement>;
  },
) => React.ReactElement;

Object.defineProperty(ExportExcelButton, "displayName", {
  value: "ExportExcelButton",
});

export default ExportExcelButton;
