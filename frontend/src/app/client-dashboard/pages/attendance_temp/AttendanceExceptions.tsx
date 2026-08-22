/**
 * AttendanceExceptions.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin review queue for held check-ins/check-outs (support_db_attendance_
 * exceptions.py). This is the destination the "attendance.check_in.late" /
 * "attendance.check_out.early|late" notifications link to via their
 * target_route ("/attendance/exceptions") — register this component at
 * that route.
 *
 * Deliberately mirrors Notifications.tsx's structure (useAuth + useOrgReady,
 * load/loading/error state, plain inline styles via the same `T` theme
 * import) rather than LeaveManagement.tsx's heavier branch-selector/date-
 * filter/pagination apparatus — this queue is small (pending exceptions
 * only, not a historical log) and doesn't need that machinery. If this
 * screen later needs branch filtering/export, lift those hooks in then
 * rather than guessing at their internals now.
 */

import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Clock, LogIn, LogOut } from "lucide-react";

import { useAuth } from "../../contexts/useAuth";
import { useOrgReady } from "../../hooks/useOrgReady";
import { T } from "../../components/ui/theme";
import { JellyButton } from "../../components/ui/JellyButton";
import RefreshButton from "../../components/ui/RefreshButton";
import {
  listAttendanceExceptions,
  resolveAttendanceException,
  type AttendanceException,
} from "./api/attendanceExceptionsApi";

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(11, 16) || "—";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function staffLabel(row: AttendanceException): string {
  return row.staff_name || row.name || "Staff member";
}

// One row can have a pending check-in, a pending check-out, or (rarely)
// both at once — each leg is resolved independently, so this returns up to
// two entries per attendance row rather than assuming exactly one.
interface PendingLeg {
  key: string;
  leg: "check_in" | "check_out";
  label: string;
  detail: string;
  decisions: { value: string; label: string }[];
}

function legsFor(row: AttendanceException): PendingLeg[] {
  const legs: PendingLeg[] = [];
  if (row.check_in_hold_reason) {
    legs.push({
      key: `${row.id}-check_in`,
      leg: "check_in",
      label: "Late check-in",
      detail: `Checked in at ${formatTime(row.timestamp)}`,
      decisions: [
        { value: "late", label: "Confirm Late" },
        { value: "half_day", label: "Mark Half Day" },
        { value: "short_leave", label: "Mark Short Leave" },
      ],
    });
  }
  if (row.check_out_hold_reason === "early") {
    legs.push({
      key: `${row.id}-check_out`,
      leg: "check_out",
      label: "Left early",
      detail: `Checked out at ${formatTime(row.check_out_timestamp)}`,
      decisions: [
        { value: "early_leave", label: "Confirm Early Leave" },
        { value: "half_day", label: "Mark Half Day" },
        { value: "short_leave", label: "Mark Short Leave" },
      ],
    });
  } else if (row.check_out_hold_reason === "late") {
    legs.push({
      key: `${row.id}-check_out`,
      leg: "check_out",
      label: "Left late",
      detail: `Checked out at ${formatTime(row.check_out_timestamp)}`,
      // Half Day intentionally excluded here -- it only makes sense for
      // someone who left hours early, not someone who stayed past their
      // shift end. Matches support_db_attendance_exceptions.py's
      // _CHECK_OUT_DECISIONS_BY_HOLD_REASON, which now rejects it
      // server-side for a 'late' hold too -- this isn't just a UI
      // preference, the backend enforces the same rule.
      decisions: [
        { value: "late", label: "Confirm Late" },
        { value: "overtime", label: "Mark Overtime" },
      ],
    });
  }
  return legs;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

const LegRow: React.FC<{
  row: AttendanceException;
  leg: PendingLeg;
  onResolve: (
    attendanceId: string,
    leg: "check_in" | "check_out",
    decision: string,
    note: string,
  ) => Promise<void>;
}> = ({ row, leg, onResolve }) => {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const handleDecision = async (decision: string) => {
    setBusy(decision);
    try {
      await onResolve(row.id, leg.leg, decision, note);
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
        {leg.leg === "check_in" ? (
          <LogIn size={16} color={T.amber} />
        ) : (
          <LogOut size={16} color={T.amber} />
        )}
      </div>

      <div style={{ minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <strong style={{ color: T.head, fontSize: 13 }}>
            {staffLabel(row)}
          </strong>
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
            {leg.label}
          </span>
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
          {leg.detail}
          {row.notes ? (
            <span style={{ marginLeft: 6 }}>· {row.notes}</span>
          ) : null}
        </div>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note for this decision…"
          maxLength={300}
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

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          alignItems: "flex-end",
        }}
      >
        {leg.decisions.map((d) => (
          <JellyButton
            key={d.value}
            variant={d.value === "half_day" ? "ghost" : "primary"}
            size="sm"
            disabled={busy !== null}
            onClick={() => void handleDecision(d.value)}
          >
            {busy === d.value ? "Saving…" : d.label}
          </JellyButton>
        ))}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// PAGE COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

type AuthUser = {
  id?: number | string;
  organizationId?: number | string | null;
  organization_id?: number | string | null;
};

export default function AttendanceExceptions() {
  const { user: rawUser } = useAuth() as { user?: AuthUser | null };
  const { isReady, organizationId } = useOrgReady();

  const [rows, setRows] = useState<AttendanceException[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isReady || !organizationId) return;
    try {
      setRefreshing(true);
      setError(null);
      const exceptions = await listAttendanceExceptions({ organizationId });
      setRows(exceptions);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load attendance exceptions.",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isReady, organizationId]);

  useEffect(() => {
    if (!isReady) return;
    void load();
  }, [isReady, load]);

  const handleResolve = useCallback(
    async (
      attendanceId: string,
      leg: "check_in" | "check_out",
      decision: string,
      note: string,
    ) => {
      if (!organizationId) return;
      try {
        await resolveAttendanceException({
          organizationId,
          attendanceId,
          leg,
          decision,
          note: note || undefined,
          resolvedBy: rawUser?.id ? String(rawUser.id) : null,
        });
        // Re-fetch rather than patch in place — resolving one leg can
        // remove the row entirely (both legs clear) or just narrow it to
        // the other still-pending leg; re-deriving from the server is
        // simpler and safer than reimplementing that logic client-side.
        await load();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to resolve exception.",
        );
      }
    },
    [organizationId, rawUser?.id, load],
  );

  if (!isReady) {
    return (
      <div
        style={{
          fontFamily: "'DM Sans','Inter',sans-serif",
          padding: 38,
          color: T.muted,
          textAlign: "center",
        }}
      >
        Initializing dashboard...
      </div>
    );
  }

  return (
    <div
      style={{
        fontFamily: "'DM Sans','Inter',sans-serif",
        display: "grid",
        gap: 18,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div>
          <h2
            style={{
              margin: 0,
              fontSize: 22,
              fontWeight: 900,
              color: T.head,
              letterSpacing: "-.4px",
            }}
          >
            Attendance Exceptions
          </h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: T.muted }}>
            Late check-ins and early/late check-outs awaiting your decision ·{" "}
            {rows.length} pending
          </p>
        </div>
        <RefreshButton
          variant="secondary"
          size="md"
          loading={refreshing}
          onClick={() => void load()}
        />
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
          <div style={{ padding: 38, color: T.muted, textAlign: "center" }}>
            Loading exceptions...
          </div>
        ) : error ? (
          <div style={{ padding: 24, color: "#e11d48", fontWeight: 800 }}>
            {error}
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 46, color: T.muted, textAlign: "center" }}>
            <AlertTriangle
              size={30}
              color={T.teal600}
              style={{ opacity: 0.45 }}
            />
            <div style={{ marginTop: 10, fontWeight: 800 }}>
              Nothing pending
            </div>
            <div style={{ marginTop: 4, fontSize: 12 }}>
              Late check-ins and early/late check-outs will show up here for
              review.
            </div>
          </div>
        ) : (
          <div style={{ display: "grid" }}>
            {rows.flatMap((row) =>
              legsFor(row).map((leg) => (
                <LegRow
                  key={leg.key}
                  row={row}
                  leg={leg}
                  onResolve={handleResolve}
                />
              )),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
