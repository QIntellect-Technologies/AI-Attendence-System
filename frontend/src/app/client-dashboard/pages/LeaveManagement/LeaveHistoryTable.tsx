/**
 * modules/leave/LeaveHistoryTable.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Presentation component for the "Leave History" tab — one row per
 * employee: staff ID, name, department, total/taken/remaining paid
 * leaves, taken unpaid leaves. Pure presentation; all data comes from
 * useLeaveHistory via LeaveManagement.tsx (year filter, department/search
 * filters, and pagination are all owned by the parent, same split as the
 * "Leaves" tab's table).
 */
import React from "react";
import { CalendarClock } from "lucide-react";
import { T } from "./theme";
import JellyButton from "../../components/ui/JellyButton";
import ModernSelect from "../../components/ui/ModernSelect";
import type { LeaveHistoryRow } from "./types/leave";

export interface LeaveHistoryTableProps {
  rows: LeaveHistoryRow[];
  loading: boolean;
  showBranch: boolean;
  year: number;
  yearOptions: number[];
  onYearChange: (year: number) => void;
  quotaConfigured: boolean;
  page: number;
  totalPages: number;
  totalItems: number;
  goToPage: (page: number) => void;
}

const thStyle: React.CSSProperties = {
  padding: "12px 16px",
  fontSize: 10,
  fontWeight: 900,
  color: T.textLight,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  borderBottom: `1px solid ${T.border}`,
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "13px 16px",
  fontSize: 13,
  color: T.textBody,
};

/** Renders a numeric cell as "—" when the underlying quota isn't
 * configured yet, so "0" (a real, meaningful value once quotas exist)
 * is never confused with "unknown". */
function QuotaCell({
  value,
  configured,
  warnIfNegative = false,
}: {
  value: number;
  configured: boolean;
  warnIfNegative?: boolean;
}) {
  if (!configured) {
    return <span style={{ color: T.textLight }}>—</span>;
  }
  const isNegative = warnIfNegative && value < 0;
  return (
    <span
      style={{
        color: isNegative ? T.red600 : T.textBody,
        fontWeight: isNegative ? 800 : 400,
      }}
    >
      {value}
    </span>
  );
}

export function LeaveHistoryTable({
  rows,
  loading,
  showBranch,
  year,
  yearOptions,
  onYearChange,
  quotaConfigured,
  page,
  totalPages,
  totalItems,
  goToPage,
}: LeaveHistoryTableProps): React.ReactElement {
  const yearSelectOptions = yearOptions.map((y) => ({
    value: String(y),
    label: String(y),
  }));

  return (
    <div
      style={{
        background: T.bgCard,
        border: `1px solid ${T.border}`,
        borderRadius: 16,
        boxShadow: T.shadow,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "15px 20px",
          borderBottom: `1px solid ${T.border}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h2
            style={{
              margin: 0,
              fontSize: 14,
              fontWeight: 900,
              color: T.textHeading,
            }}
          >
            Leave History
          </h2>
          <p style={{ margin: "2px 0 0", fontSize: 11, color: T.textMuted }}>
            Per-employee leave balance for {year}
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <ModernSelect
            value={String(year)}
            options={yearSelectOptions}
            onChange={(value) => onYearChange(Number(value))}
            ariaLabel="Leave history year"
            leadingIcon={<CalendarClock size={14} />}
            width={110}
          />
          <span
            style={{
              background: T.teal50,
              border: `1px solid ${T.teal100}`,
              color: T.teal600,
              borderRadius: 999,
              padding: "4px 10px",
              fontSize: 11,
              fontWeight: 800,
            }}
          >
            {totalItems} employee{totalItems !== 1 ? "s" : ""}
            {totalPages > 1 && ` · Page ${page} of ${totalPages}`}
          </span>
        </div>
      </div>

      {/* "No quota configured" banner — Total/Remaining columns are
          rendering "—" everywhere because Payroll Rules has no annual
          quota set for any paid leave type yet. */}
      {!quotaConfigured && (
        <div
          style={{
            padding: "10px 20px",
            background: T.amber100,
            borderBottom: `1px solid ${T.border}`,
            fontSize: 12,
            color: T.amber600,
            fontWeight: 700,
          }}
        >
          No annual paid-leave quota is configured yet. Set one per leave type
          in Payroll Rules to see Total and Remaining paid leaves.
        </div>
      )}

      {/* Table */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: T.slate50 }}>
              <th style={{ ...thStyle, textAlign: "left" }}>Staff ID</th>
              <th style={{ ...thStyle, textAlign: "left" }}>Name</th>
              {showBranch && (
                <th style={{ ...thStyle, textAlign: "left" }}>Branch</th>
              )}
              <th style={{ ...thStyle, textAlign: "left" }}>Department</th>
              <th style={{ ...thStyle, textAlign: "center" }}>Total Leaves</th>
              <th style={{ ...thStyle, textAlign: "center" }}>
                Remaining Leaves
              </th>
              <th style={{ ...thStyle, textAlign: "center" }}>
                Total Paid Leaves
              </th>
              <th style={{ ...thStyle, textAlign: "center" }}>
                Availed Paid Leaves
              </th>

              <th style={{ ...thStyle, textAlign: "center" }}>
                Remaining Paid Leaves
              </th>
              <th style={{ ...thStyle, textAlign: "center" }}>
                Total Unpaid Leaves
              </th>
              <th style={{ ...thStyle, textAlign: "center" }}>
                Availed Unpaid Leaves
              </th>
              <th style={{ ...thStyle, textAlign: "center" }}>
                Remaining Unpaid Leaves
              </th>
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={showBranch ? 8 : 7}
                  style={{
                    padding: 48,
                    textAlign: "center",
                    color: T.textLight,
                    fontSize: 13,
                  }}
                >
                  Loading leave history…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  colSpan={showBranch ? 8 : 7}
                  style={{
                    padding: 48,
                    textAlign: "center",
                    color: T.textLight,
                    fontSize: 13,
                  }}
                >
                  <CalendarClock
                    size={32}
                    style={{
                      opacity: 0.2,
                      display: "block",
                      margin: "0 auto 10px",
                    }}
                  />
                  No employees match the current filters.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.staffId}
                  style={{ borderBottom: `1px solid ${T.slate100}` }}
                >
                  <td style={tdStyle}>{row.staffId}</td>
                  <td style={{ ...tdStyle, fontWeight: 700 }}>{row.name}</td>
                  {showBranch && (
                    <td style={tdStyle}>{row.branchName || "—"}</td>
                  )}
                  <td style={tdStyle}>{row.department}</td>
                  <td style={{ ...tdStyle, textAlign: "center" }}>
                    <QuotaCell
                      value={row.totalLeaves}
                      configured={row.quotaConfigured}
                    />
                  </td>
                  <td style={{ ...tdStyle, textAlign: "center" }}>
                    <QuotaCell
                      value={row.remainingLeaves}
                      configured={row.quotaConfigured}
                      warnIfNegative
                    />
                  </td>
                  <td style={{ ...tdStyle, textAlign: "center" }}>
                    <QuotaCell
                      value={row.totalPaidLeaves}
                      configured={row.quotaConfigured}
                    />
                  </td>
                  <td style={{ ...tdStyle, textAlign: "center" }}>
                    {row.takenPaidLeaves}
                  </td>

                  <td style={{ ...tdStyle, textAlign: "center" }}>
                    <QuotaCell
                      value={row.remainingPaidLeaves}
                      configured={row.quotaConfigured}
                      warnIfNegative
                    />
                  </td>
                  <td style={{ ...tdStyle, textAlign: "center" }}>
                    <QuotaCell
                      value={row.totalUnpaidLeaves}
                      configured={row.quotaConfigured}
                    />
                  </td>
                  <td style={{ ...tdStyle, textAlign: "center" }}>
                    {row.takenUnpaidLeaves}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "center" }}>
                    <QuotaCell
                      value={row.remainingUnpaidLeaves}
                      configured={row.quotaConfigured}
                      warnIfNegative
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && rows.length > 0 && (
        <div
          style={{
            padding: "12px 20px",
            borderTop: `1px solid ${T.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
          }}
        >
          <JellyButton
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => goToPage(page - 1)}
            disabled={page === 1}
          >
            ← Previous
          </JellyButton>

          <span style={{ fontSize: 11, color: T.textMuted, fontWeight: 600 }}>
            Page {page} of {totalPages}
          </span>

          <JellyButton
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => goToPage(page + 1)}
            disabled={page === totalPages}
          >
            Next →
          </JellyButton>
        </div>
      )}
    </div>
  );
}

export default LeaveHistoryTable;
