/**
 * src/modules/overtime/components/OvertimeDetailPanel.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Slide-over detail panel for a single overtime request.
 * Pure presentational component — all data and callbacks come from props.
 */

import React from "react";
import { X } from "lucide-react";
import { T } from "../../../components/ui/theme";
import { StatusBadge } from "../../../components/ui/DashboardComponents";
import type { OvertimeRequest } from "../../../contexts/ModuleContext";
import type { OvertimePolicy } from "../types/overtime";
import { calculateOvertimePay, formatDate } from "../utils/overtime.utils";

export interface OvertimeDetailPanelProps {
  request: OvertimeRequest;
  policy: OvertimePolicy;
  monthlySalary?: number;
  personCode?: string;
  onClose: () => void;
  onApprove: (id: string) => void;
  onReject: (request: OvertimeRequest) => void;
}

export default function OvertimeDetailPanel({
  request,
  policy,
  monthlySalary,
  personCode,
  onClose,
  onApprove,
  onReject,
}: OvertimeDetailPanelProps) {
  const pay = calculateOvertimePay(request.hours, policy, monthlySalary);

  const rows: [string, React.ReactNode][] = [
    ["Employee", `${request.staffName} · ${personCode || request.staffId}`],
    ["Branch", request.branchName],
    ["Department", request.department],
    ["Date", formatDate(request.date)],
    ["Hours", `${request.hours.toFixed(1)}h`],
    ["Estimated Pay", `${policy.currencyLabel} ${pay.toLocaleString()}`],
    ["Status", <StatusBadge key="status" status={request.status} />],
    ["Applied On", formatDate(request.appliedOn)],
    ["Task", request.task || "—"],
    ["Rejection Note", request.rejectionNote || "—"],
  ];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.45)",
        zIndex: 1200,
        display: "flex",
        justifyContent: "flex-end",
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          width: 430,
          maxWidth: "100%",
          height: "100%",
          background: T.card,
          boxShadow: "-8px 0 28px rgba(15,23,42,0.18)",
          overflow: "auto",
        }}
      >
        <div
          style={{
            padding: "18px 20px",
            borderBottom: `1px solid ${T.border}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            background: T.teal50,
          }}
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 950, color: T.head }}>
              Overtime Request
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer" }}
          >
            <X size={18} color={T.muted} />
          </button>
        </div>

        <div style={{ padding: 20, display: "grid", gap: 14 }}>
          {rows.map(([label, value]) => (
            <div
              key={label}
              style={{
                borderBottom: `1px solid ${T.teal50}`,
                paddingBottom: 10,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: T.muted,
                  fontWeight: 900,
                  textTransform: "uppercase",
                  letterSpacing: ".07em",
                }}
              >
                {label}
              </div>
              <div
                style={{
                  marginTop: 4,
                  color: T.head,
                  fontSize: 13,
                  fontWeight: 700,
                  lineHeight: 1.5,
                }}
              >
                {value}
              </div>
            </div>
          ))}

          {request.status === "Pending" && (
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button
                type="button"
                onClick={() => onApprove(request.id)}
                style={{
                  height: 30,
                  borderRadius: 9,
                  border: `1px solid ${T.border}`,
                  background: T.card,
                  cursor: "pointer",
                  flex: 1,
                  fontWeight: 900,
                  fontSize: 11,
                  color: "#16a34a",
                }}
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => onReject(request)}
                style={{
                  height: 30,
                  borderRadius: 9,
                  border: `1px solid ${T.border}`,
                  background: T.card,
                  cursor: "pointer",
                  flex: 1,
                  fontWeight: 900,
                  fontSize: 11,
                  color: "#e11d48",
                }}
              >
                Reject
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
