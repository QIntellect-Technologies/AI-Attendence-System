/**
 * src/modules/leave/hooks/useLeaveExport.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Configure Excel/PDF export for leave management.
 *
 * TYPE FIX: UseLeaveExportOptions.filterMetadata was typed as LeaveExportMetadata
 * (a named interface with required keys). Now that LeaveExportMetadata is a
 * type alias for Record<string, string | undefined>, the assignment from
 * useLeaveFilters.exportMetadata compiles without error. No logic changed.
 *
 * Column definitions are typed as ExportExcelColumn — structurally a superset
 * of the old CSV-only column shape ({header, key?, accessor?}) plus optional
 * align/numFmt, so the same accessor functions serve both the Excel and PDF
 * export formats without duplication.
 */

import { useMemo } from "react";
import type { ExportExcelColumn } from "../../../components/ui/ExportExcelButton";
import type { PendingLeaveItem, LeaveExportMetadata } from "../types/leave";

function leaveTreatmentLabel(item: PendingLeaveItem): string {
  const mode = String(item.leaveCompensation ?? "not_configured").toLowerCase();
  if (mode === "unpaid") return "Unpaid";
  if (mode === "excluded") return "Excluded";
  if (mode === "paid") return "Paid";
  return "Not Configured";
}

// ─── Options ──────────────────────────────────────────────────────────────

export interface UseLeaveExportOptions {
  /** Leaves to export */
  items: PendingLeaveItem[];
  /** Is this a global scope view? */
  isGlobal: boolean;
  /** Current date range label (e.g., "Jan 1 – Jan 31, 2025") */
  dateLabel: string;
  /** Selected branch name (for filename) */
  branchLabel: string;
  /**
   * Filter metadata (what filters were applied).
   * Type is LeaveExportMetadata = Record<string, string | undefined> —
   * matches exactly what useLeaveFilters.exportMetadata returns.
   */
  filterMetadata: LeaveExportMetadata;
}

// ─── Return ────────────────────────────────────────────────────────────────

export interface UseLeaveExportReturn {
  columns: ExportExcelColumn<PendingLeaveItem>[];
  filename: string;
  metadata: LeaveExportMetadata;
  itemCount: number;
  canExport: boolean;
}

// ─── Column definitions ────────────────────────────────────────────────────

const LEAVE_EXPORT_COLUMNS_BRANCH: ExportExcelColumn<PendingLeaveItem>[] = [
  { header: "Employee Name", accessor: (r) => r.name },
  { header: "Department", accessor: (r) => r.dept },
  { header: "Leave Type", accessor: (r) => r.type },
  {
    header: "Paid/Unpaid",
    accessor: (r) => leaveTreatmentLabel(r),
  },
  { header: "Days", accessor: (r) => r.days },
  { header: "Status", accessor: (r) => r.status ?? "Pending" },
  {
    header: "Applied On",
    accessor: (r) => {
      if (!r.appliedOn) return "—";
      return new Date(r.appliedOn + "T00:00:00Z").toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    },
  },
];

const LEAVE_EXPORT_COLUMNS_GLOBAL: ExportExcelColumn<PendingLeaveItem>[] = [
  { header: "Employee Name", accessor: (r) => r.name },
  { header: "Department", accessor: (r) => r.dept },
  { header: "Leave Type", accessor: (r) => r.type },
  {
    header: "Paid/Unpaid",
    accessor: (r) => leaveTreatmentLabel(r),
  },
  { header: "Days", accessor: (r) => r.days },
  { header: "Status", accessor: (r) => r.status ?? "Pending" },
  {
    header: "Applied On",
    accessor: (r) => {
      if (!r.appliedOn) return "—";
      return new Date(r.appliedOn + "T00:00:00Z").toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    },
  },
];

// ─── Filename helper ──────────────────────────────────────────────────────

function generateExportFilename(
  branchLabel: string,
  dateLabel: string,
): string {
  const sanitize = (s: string) =>
    s
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
  return ["leave-requests", sanitize(branchLabel), sanitize(dateLabel)]
    .filter(Boolean)
    .join("_");
}

// ─── Hook ─────────────────────────────────────────────────────────────────

export function useLeaveExport({
  items,
  isGlobal,
  dateLabel,
  branchLabel,
  filterMetadata,
}: UseLeaveExportOptions): UseLeaveExportReturn {
  const columns = useMemo<ExportExcelColumn<PendingLeaveItem>[]>(
    () => (isGlobal ? LEAVE_EXPORT_COLUMNS_GLOBAL : LEAVE_EXPORT_COLUMNS_BRANCH),
    [isGlobal],
  );

  const filename = useMemo(
    () => generateExportFilename(branchLabel, dateLabel),
    [branchLabel, dateLabel],
  );

  return {
    columns,
    filename,
    metadata: filterMetadata, // LeaveExportMetadata = Record<string, string | undefined> — matches exactly
    itemCount: items.length,
    canExport: items.length > 0,
  };
}
