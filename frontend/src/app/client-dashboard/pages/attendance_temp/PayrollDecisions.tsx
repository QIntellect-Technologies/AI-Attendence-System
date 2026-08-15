/**
 * PayrollDecisions.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 3 admin screen: local-node rows already classified (half_day /
 * short_leave / late / overtime) awaiting an include/exclude payroll
 * decision. This is the destination "attendance.payroll_decision.pending"
 * notifications link to via target_route ("/admin/attendance/payroll-
 * decisions") — register this component at that route.
 *
 * Deliberately NOT the same screen as AttendanceExceptions.tsx — that
 * queue handles rows still awaiting CLASSIFICATION (a hold_reason is set);
 * this one handles rows already classified, still awaiting a PAYROLL
 * decision. See client_payroll_decision_routes.py's module docstring.
 */

import React, { useCallback, useEffect, useState } from "react";
import { DollarSign, Clock } from "lucide-react";

import { useAuth } from "../../contexts/useAuth";
import { useOrgReady } from "../../hooks/useOrgReady";
import { T } from "../../components/ui/theme";
import { JellyButton } from "../../components/ui/JellyButton";
import RefreshButton from "../../components/ui/RefreshButton";
import {
  listLocalNodePayrollPending,
  setPayrollDecision,
  type PayrollPendingRow,
} from "./api/attendanceExceptionsApi";
import { DAY_STATUS_LABELS } from "./utils/dayStatusLabels";

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10) || "—";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function staffLabel(row: PayrollPendingRow): string {
  return row.staff_name || row.name || "Staff member";
}

function dayStatusBadge(dayStatus: string | null | undefined) {
  const key = (dayStatus ?? "").toLowerCase();
  return DAY_STATUS_LABELS[key as keyof typeof DAY_STATUS_LABELS] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROW
// ─────────────────────────────────────────────────────────────────────────────

const PayrollDecisionRow: React.FC<{
  row: PayrollPendingRow;
  onDecide: (attendanceId: string, decision: "include" | "exclude", note: string) => Promise<void>;
}> = ({ row, onDecide }) => {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"include" | "exclude" | null>(null);
  const badge = dayStatusBadge(row.day_status);

  const handleDecision = async (decision: "include" | "exclude") => {
    setBusy(decision);
    try {
      await onDecide(row.id, decision, note);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "34px minmax(0, 1fr) auto",
        gap: 12,
        padding: "14px 18px",
        borderBottom: `1px solid ${T.teal50}`,
        alignItems: "center",
      }}
    >
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: 10,
          background: `${T.amber}18`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <DollarSign size={16} color={T.amber} />
      </div>

      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <strong style={{ color: T.head, fontSize: 13 }}>{staffLabel(row)}</strong>
          {badge ? (
            <span
              style={{
                background: `${T.amber}18`,
                color: T.amber,
                borderRadius: 20,
                padding: "2px 8px",
                fontSize: 10,
                fontWeight: 800,
              }}
            >
              {badge.label}
            </span>
          ) : null}
        </div>
        <div
          style={{
            marginTop: 4,
            color: T.muted,
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Clock size={12} />
          {formatDate(row.timestamp)}
          {row.notes ? <span style={{ marginLeft: 6 }}>· {row.notes}</span> : null}
        </div>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note for this decision…"
          style={{
            marginTop: 8,
            width: "100%",
            maxWidth: 360,
            fontSize: 12,
            padding: "6px 10px",
            borderRadius: 8,
            border: `1px solid ${T.border}`,
            background: T.card,
            color: T.head,
          }}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
        <JellyButton
          variant="primary"
          size="sm"
          disabled={busy !== null}
          onClick={() => void handleDecision("include")}
        >
          {busy === "include" ? "Saving…" : "Include in Payroll"}
        </JellyButton>
        <JellyButton
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={() => void handleDecision("exclude")}
        >
          {busy === "exclude" ? "Saving…" : "Exclude from Payroll"}
        </JellyButton>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// PAGE COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

type AuthUser = { id?: number | string };

export default function PayrollDecisions() {
  const { user: rawUser } = useAuth() as { user?: AuthUser | null };
  const { isReady, organizationId } = useOrgReady();

  const [rows, setRows] = useState<PayrollPendingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isReady || !organizationId) return;
    try {
      setRefreshing(true);
      setError(null);
      const pending = await listLocalNodePayrollPending({ organizationId });
      setRows(pending);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load payroll decisions.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isReady, organizationId]);

  useEffect(() => {
    if (!isReady) return;
    void load();
  }, [isReady, load]);

  const handleDecide = useCallback(
    async (attendanceId: string, decision: "include" | "exclude", note: string) => {
      if (!organizationId) return;
      try {
        await setPayrollDecision({
          organizationId,
          attendanceId,
          decision,
          note: note || undefined,
          decidedBy: rawUser?.id ? String(rawUser.id) : null,
        });
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save payroll decision.");
      }
    },
    [organizationId, rawUser?.id, load],
  );

  if (!isReady) {
    return (
      <div style={{ fontFamily: "'DM Sans','Inter',sans-serif", padding: 38, color: T.muted, textAlign: "center" }}>
        Initializing dashboard...
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'DM Sans','Inter',sans-serif", display: "grid", gap: 18 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 900, color: T.head, letterSpacing: "-.4px" }}>
            Payroll Decisions
          </h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: T.muted }}>
            Classified half-day, short leave, and overtime entries awaiting a payroll include/exclude call ·{" "}
            {rows.length} pending
          </p>
        </div>
        <RefreshButton variant="secondary" size="md" loading={refreshing} onClick={() => void load()} />
      </div>

      <div
        style={{
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: 16,
          boxShadow: "0 1px 3px rgba(15,45,74,0.06)",
        }}
      >
        {loading ? (
          <div style={{ padding: 38, color: T.muted, textAlign: "center" }}>Loading payroll decisions...</div>
        ) : error ? (
          <div style={{ padding: 24, color: "#e11d48", fontWeight: 800 }}>{error}</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 46, color: T.muted, textAlign: "center" }}>
            <DollarSign size={30} color={T.teal600} style={{ opacity: 0.45 }} />
            <div style={{ marginTop: 10, fontWeight: 800 }}>Nothing pending</div>
            <div style={{ marginTop: 4, fontSize: 12 }}>
              Classified local-node attendance days will show up here once they need a payroll decision.
            </div>
          </div>
        ) : (
          <div style={{ display: "grid" }}>
            {rows.map((row) => (
              <PayrollDecisionRow key={row.id} row={row} onDecide={handleDecide} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}