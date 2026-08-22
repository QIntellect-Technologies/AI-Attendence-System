/**
 * modules/staff/components/StaffAttendanceOverridesPanel.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-person manual attendance instructions, rendered inside the profile
 * drawer. Reads and writes the same manual_attendance_instructions table as
 * the branch-wide Settings list, which stays a read-only audit view.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, {
  type FC,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useOrg } from "../../../contexts/OrgConfigContext";
import { T } from "../../../components/ui/theme";
import { resolveApiBranchId } from "../../../utils/tenantScope";
import {
  createManualInstruction,
  deleteManualInstruction,
  listManualInstructions,
  type ManualInstruction,
} from "../api/attendanceSettingsApi";
import { type StaffMember } from "../types/staffTypes";

// ─── Profile Drawer ───────────────────────────────────────────────────────────
// department, role, joinDate are plain strings — no lookup callbacks needed.

// ─── Staff Attendance Overrides (People Management manual instructions) ───
// Lives on the staff Profile Drawer rather than the branch-wide Settings
// page: an override is staff+date scoped by construction, so starting from
// "this person's profile" (id/person_code/people_type already resolved by
// the drawer) skips the person-code lookup step the Settings screen's
// generic form needs before it can save anything. The branch-wide Settings
// screen keeps its own list as a read-only/audit view for admins who need
// to see every active override across a branch at once — this panel is the
// per-person create/manage surface, not a replacement for that, and both
// read from/write to the same manual_attendance_instructions table via the
// same API, so nothing here is a second source of truth.
// UX-only guard; support_db_attendance_settings.py's NOTES_MAX_LENGTH check
// in create_manual_instruction is the real boundary that stops an oversized
// paste from being persisted.
const NOTES_MAX_LENGTH = 500;

export const OVERRIDE_REASON_OPTIONS: Array<{ value: string; label: string }> =
  [
    { value: "manual", label: "Manual" },
    { value: "half_day", label: "Half-Day" },
    { value: "overtime", label: "Overtime" },
  ];

export const StaffAttendanceOverridesPanel: FC<{ member: StaffMember }> = ({
  member,
}) => {
  const { cfg, organizationId } = useOrg();
  const apiBranchId = useMemo(
    () => resolveApiBranchId(organizationId, member.branchId, cfg.branches),
    [organizationId, member.branchId, cfg.branches],
  );

  const [instructions, setInstructions] = useState<ManualInstruction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const branchLocalToday = () => {
    try {
      const branch = (cfg?.branches || []).find(
        (b: any) => b.id === member.branchId,
      );
      const tz =
        (branch && branch.timezone) ||
        Intl.DateTimeFormat().resolvedOptions().timeZone ||
        "UTC";
      // en-CA -> YYYY-MM-DD format
      return new Date().toLocaleDateString("en-CA", { timeZone: tz });
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  };

  const [attendanceDate, setAttendanceDate] = useState<string>(() =>
    branchLocalToday(),
  );
  const [checkInTime, setCheckInTime] = useState<string | null>(null);
  const [checkOutTime, setCheckOutTime] = useState<string | null>(null);
  const [checkInGrace, setCheckInGrace] = useState<number | null>(null);
  const [checkOutGrace, setCheckOutGrace] = useState<number | null>(null);
  const [reason, setReason] = useState("manual");
  const [notes, setNotes] = useState("");

  const load = useCallback(async () => {
    if (!organizationId || !apiBranchId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const rows = await listManualInstructions(
        apiBranchId,
        organizationId,
        member.peopleType,
        member.userId,
      );
      setInstructions(rows);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load overrides.",
      );
    } finally {
      setLoading(false);
    }
  }, [organizationId, apiBranchId, member.peopleType, member.userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    if (!organizationId || !apiBranchId) return;
    setIsSaving(true);
    setError(null);
    try {
      await createManualInstruction(apiBranchId, organizationId, {
        staff_id: member.userId,
        person_code: member.personCode || null,
        people_type: member.peopleType,
        attendance_date: attendanceDate,
        check_in_time: checkInTime || null,
        check_in_grace_minutes: checkInTime ? checkInGrace : null,
        check_out_time: checkOutTime || null,
        check_out_grace_minutes: checkOutTime ? checkOutGrace : null,
        reason,
        notes: notes || null,
      });
      setCheckInTime(null);
      setCheckOutTime(null);
      setCheckInGrace(null);
      setCheckOutGrace(null);
      setNotes("");
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save override.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!organizationId) return;
    setIsSaving(true);
    setError(null);
    try {
      await deleteManualInstruction(id, organizationId);
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to delete override.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "7px 9px",
    borderRadius: 8,
    border: `1px solid ${T.border}`,
    fontSize: 12,
    fontFamily: "inherit",
  };
  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: 10,
    fontWeight: 700,
    color: T.muted,
    textTransform: "uppercase",
    letterSpacing: ".05em",
    marginBottom: 4,
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: T.muted,
            textTransform: "uppercase",
            letterSpacing: ".07em",
          }}
        >
          Attendance Overrides
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          disabled={!apiBranchId}
          title={
            !apiBranchId
              ? "Branch could not be resolved for attendance overrides"
              : undefined
          }
          style={{
            border: "none",
            color: apiBranchId ? T.teal600 : T.muted,
            fontSize: 13,
            fontWeight: 900,
            cursor: apiBranchId ? "pointer" : "not-allowed",
            padding: "8px 12px",
            borderRadius: 10,
            background: apiBranchId ? T.teal50 : "transparent",
          }}
        >
          {showForm ? "Cancel" : "+ Add Override"}
        </button>
      </div>

      {showForm && (
        <div
          style={{
            border: `1px solid ${T.border}`,
            borderRadius: 10,
            padding: 12,
            marginBottom: 10,
            display: "grid",
            gap: 8,
            background: T.slate50,
          }}
        >
          <div>
            <label style={labelStyle}>Date</label>
            <input
              type="date"
              style={inputStyle}
              value={attendanceDate}
              onChange={(e) => setAttendanceDate(e.target.value)}
            />
          </div>
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}
          >
            <div>
              <label style={labelStyle}>Check-in</label>
              <input
                type="time"
                style={inputStyle}
                value={checkInTime ?? ""}
                onChange={(e) => setCheckInTime(e.target.value || null)}
              />
            </div>
            <div>
              <label style={labelStyle}>Check-out</label>
              <input
                type="time"
                style={inputStyle}
                value={checkOutTime ?? ""}
                onChange={(e) => setCheckOutTime(e.target.value || null)}
              />
            </div>
          </div>
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}
          >
            <div>
              <label style={labelStyle}>Check-in Grace (min)</label>
              <input
                type="number"
                min="0"
                style={inputStyle}
                value={checkInGrace ?? ""}
                disabled={!checkInTime}
                placeholder={checkInTime ? "0" : "—"}
                onChange={(e) =>
                  setCheckInGrace(
                    e.target.value === "" ? null : Number(e.target.value),
                  )
                }
              />
            </div>
            <div>
              <label style={labelStyle}>Check-out Grace (min)</label>
              <input
                type="number"
                min="0"
                style={inputStyle}
                value={checkOutGrace ?? ""}
                disabled={!checkOutTime}
                placeholder={checkOutTime ? "0" : "—"}
                onChange={(e) =>
                  setCheckOutGrace(
                    e.target.value === "" ? null : Number(e.target.value),
                  )
                }
              />
            </div>
          </div>
          <div>
            <label style={labelStyle}>Reason</label>
            <select
              style={inputStyle}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            >
              {OVERRIDE_REASON_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Notes (optional)</label>
            <input
              style={inputStyle}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={NOTES_MAX_LENGTH}
            />
          </div>
          {error && (
            <div style={{ fontSize: 11, color: "#e11d48", fontWeight: 600 }}>
              {error}
            </div>
          )}
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={isSaving || (!checkInTime && !checkOutTime)}
            title={
              !checkInTime && !checkOutTime
                ? "Set at least a check-in or check-out time"
                : undefined
            }
            style={{
              border: "none",
              borderRadius: 8,
              background: T.teal600,
              color: "#fff",
              fontSize: 12,
              fontWeight: 800,
              padding: "8px 12px",
              cursor:
                isSaving || (!checkInTime && !checkOutTime)
                  ? "not-allowed"
                  : "pointer",
              opacity: isSaving || (!checkInTime && !checkOutTime) ? 0.6 : 1,
            }}
          >
            {isSaving ? "Saving…" : "Save Override"}
          </button>
        </div>
      )}

      {!showForm && error && (
        <div
          style={{
            fontSize: 11,
            color: "#e11d48",
            fontWeight: 600,
            marginBottom: 8,
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ fontSize: 12, color: T.muted }}>Loading…</div>
      ) : instructions.length === 0 ? (
        <div style={{ fontSize: 12, color: T.muted }}>
          No overrides for this{" "}
          {member.name.split(" ")[0] ? "person" : "person"}.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {instructions.map((inst) => (
            <div
              key={inst.id}
              style={{
                border: `1px solid ${T.teal50}`,
                borderRadius: 8,
                padding: "8px 10px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.head }}>
                  {inst.attendance_date}
                </div>
                <div style={{ fontSize: 11, color: T.muted }}>
                  {inst.check_in_time ?? "—"} → {inst.check_out_time ?? "—"}
                  {inst.reason ? ` · ${inst.reason}` : ""}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleDelete(inst.id)}
                disabled={isSaving}
                style={{
                  border: "1px solid #fecaca",
                  background: "#fff1f2",
                  color: "#e11d48",
                  borderRadius: 8,
                  padding: "5px 8px",
                  fontSize: 11,
                  fontWeight: 800,
                  cursor: isSaving ? "not-allowed" : "pointer",
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};