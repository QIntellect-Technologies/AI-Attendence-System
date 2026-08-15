/**
 * ExportCsvButton.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Domain-specific CSV export button. Visual behaviour comes entirely from
 * JellyButton. This file owns only the CSV logic:
 *   buildCsv()      → generates CSV string from rows + column definitions
 *   downloadCsv()   → triggers browser download with BOM for Excel compat
 *   ExportCsvButton → thin wrapper: computes isDisabled, calls handleExport
 *
 * Exported utilities (buildCsv, downloadCsv, CsvPrimitive, ExportCsvColumn)
 * remain importable independently for headless export flows.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback } from "react";
import { Download } from "lucide-react";
import { JellyButton } from "./JellyButton";
import type { JellyButtonAsButton } from "./JellyButton";

// ─────────────────────────────────────────────────────────────────────────────
// PURE CSV UTILITIES  (no React, fully tree-shakable)
// ─────────────────────────────────────────────────────────────────────────────

export type CsvPrimitive = string | number | boolean | null | undefined | Date;

export interface ExportCsvColumn<T> {
  /** Column heading in the generated CSV */
  header: string;
  /** Simple key access — use when the value lives directly on the row object. */
  key?: keyof T;
  /** Custom accessor — use for nested, computed, or formatted values. */
  accessor?: (row: T, index: number) => CsvPrimitive;
}

const formatCell = (value: CsvPrimitive): string => {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
};

const escapeCsvCell = (value: CsvPrimitive): string => {
  const raw = formatCell(value);
  const escaped = raw.replace(/"/g, '""');
  return /[",\n\r]/.test(raw) ? `"${escaped}"` : escaped;
};

const sanitizeFilename = (filename: string): string => {
  const cleaned = filename
    .trim()
    .replace(/\.csv$/i, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "_");
  return `${cleaned || "export"}.csv`;
};

/**
 * Generates a CSV string from rows and column definitions.
 * Optionally prepends filter metadata as commented lines for audit trails.
 */
export function buildCsv<T>(
  data: T[],
  columns: ExportCsvColumn<T>[],
  filters?: Record<string, CsvPrimitive>,
  includeFilterMeta = false,
): string {
  const metaRows =
    includeFilterMeta && filters
      ? Object.entries(filters)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => `# ${k},${escapeCsvCell(v)}`)
      : [];

  const headerRow = columns.map((c) => escapeCsvCell(c.header)).join(",");

  const dataRows = data.map((row, i) =>
    columns
      .map((col) => {
        const value = col.accessor
          ? col.accessor(row, i)
          : col.key !== undefined
            ? (row[col.key] as CsvPrimitive)
            : "";
        return escapeCsvCell(value);
      })
      .join(","),
  );

  return [...metaRows, headerRow, ...dataRows].join("\n");
}

/**
 * Triggers a browser download for the given CSV string.
 * Prepends a UTF-8 BOM so Excel correctly renders Urdu/PKR and other
 * non-ASCII characters without an import wizard.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8;" });
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
// COMPONENT TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportCsvButtonProps<T> extends Omit<
  JellyButtonAsButton,
  "onClick" | "loading" | "disabled" | "leftIcon" | "children" | "as" | "type"
> {
  /** Already-filtered rows — pass the same data visible in the page/table. */
  data: T[];
  columns: ExportCsvColumn<T>[];
  filename: string;
  label?: string;
  /** Extra filter info prepended as commented CSV lines (for audit trails). */
  filters?: Record<string, CsvPrimitive>;
  includeFilterMeta?: boolean;
  /** Alert message when export is triggered with an empty dataset. */
  emptyMessage?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

function ExportCsvButtonInner<T>(
  {
    data,
    columns,
    filename,
    label = "Export CSV",
    filters,
    includeFilterMeta = false,
    emptyMessage = "No records available to export.",
    variant = "ghost",
    size = "md",
    ...jellyProps
  }: ExportCsvButtonProps<T>,
  ref: React.ForwardedRef<HTMLButtonElement>,
) {
  const isEmpty = data.length === 0 || columns.length === 0;

  const handleExport = useCallback(() => {
    if (isEmpty) {
      window.alert(emptyMessage);
      return;
    }
    const csv = buildCsv(data, columns, filters, includeFilterMeta);
    downloadCsv(filename, csv);
  }, [
    data,
    columns,
    filename,
    filters,
    includeFilterMeta,
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
      leftIcon={<Download />}
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
export const ExportCsvButton = React.forwardRef(ExportCsvButtonInner) as <T>(
  props: ExportCsvButtonProps<T> & {
    ref?: React.ForwardedRef<HTMLButtonElement>;
  },
) => React.ReactElement;

Object.defineProperty(ExportCsvButton, "displayName", {
  value: "ExportCsvButton",
});

export default ExportCsvButton;
