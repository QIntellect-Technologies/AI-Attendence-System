/**
 * components/ManualAttendanceModal.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Hand-enter (or correct) one employee's attendance for a day.
 *
 * Why this exists: CCTV only ever reads a person's NEXT detection as a
 * check-out if there's already an open attendance row for them that day.
 * If the morning check-in was missed entirely (camera angle, mask, bad
 * light, employee arrived before the node was up, etc.) there is no row
 * to attach a check-out to — the evening detection gets read as a brand
 * new check-in for a fresh shift instead. This form lets an admin add the
 * missing record by hand so the next real detection resolves correctly.
 *
 * One form, two modes:
 *   - "add"  — pick an employee, set date + times, create a manual row.
 *   - "edit" — reopens with an existing row's values pre-filled; the
 *     employee and date are fixed (only times/status/notes change).
 *
 * Deliberately dumb: this component owns only its own form state. The
 * actual API call (which endpoint, which org/branch/people-type query
 * params) stays with the caller via onSubmit, matching how saveRowEdit /
 * markAsAbsent already keep that logic in AttendanceView.tsx rather than
 * scattering it across components.
 */

import React, { useEffect, useMemo, useState, type FC } from "react";
import { Calendar, Clock, User, X } from "lucide-react";
import {
  T,
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
} from "./utils/attendanceDisplay";

export interface ManualAttendanceStaffOption {
  id: string | number;
  name: string;
  code?: string | null;
  branchId?: number | null;
}

export interface ManualAttendanceRecordSeed {
  id: string | number;
  staffId: string | number;
  staffName: string;
  date: string;
  inTime: string | null;
  outTime: string | null;
  checkInStatus: string | null;
  notes: string | null;
}

export interface ManualAttendanceSubmitValues {
  staffId: string | number;
  checkIn: string | null;
  checkOut: string | null;
  arrivalStatus: string;
  notes: string;
}

const ARRIVAL_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "on_time", label: "On Time" },
  { value: "late", label: "Late" },
  { value: "early", label: "Early" },
  { value: "unscheduled", label: "Unscheduled" },
];

const fieldLabelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: T.textMuted,
  marginBottom: 6,
  textTransform: "uppercase",
  letterSpacing: 0.3,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  borderRadius: 10,
  border: `1px solid ${T.border}`,
  fontSize: 14,
  color: T.textBody,
  background: "#fff",
  outline: "none",
};

export const ManualAttendanceModal: FC<{
  open: boolean;
  mode: "add" | "edit";
  staffOptions: ManualAttendanceStaffOption[];
  /** Pre-selects an employee in "add" mode, e.g. clicking "Add" on a
   * specific person's blank row instead of the toolbar button. */
  initialStaffId?: string | number | null;
  /** YYYY-MM-DD default date for a brand-new record (usually the date
   * currently selected in the table's date filter). */
  initialDate?: string;
  /** Required in "edit" mode -- the row being corrected. */
  record?: ManualAttendanceRecordSeed | null;
  getBranchTimezoneForStaff: (staffId: string | number | undefined) => string;
  saving: boolean;
  errorMessage: string | null;
  onClose: () => void;
  onSubmit: (values: ManualAttendanceSubmitValues) => void;
}> = ({
  open,
  mode,
  staffOptions,
  initialStaffId,
  initialDate,
  record,
  getBranchTimezoneForStaff,
  saving,
  errorMessage,
  onClose,
  onSubmit,
}) => {
  const [staffId, setStaffId] = useState<string>("");
  const [checkInLocal, setCheckInLocal] = useState("");
  const [checkOutLocal, setCheckOutLocal] = useState("");
  const [arrivalStatus, setArrivalStatus] = useState("on_time");
  const [notes, setNotes] = useState("");
  const [touched, setTouched] = useState(false);

  const timeZone = getBranchTimezoneForStaff(
    mode === "edit" ? record?.staffId : staffId || undefined,
  );

  // Reset the form whenever the modal is (re)opened for a different
  // target -- add-for-a-new-person vs edit-this-row must never leak the
  // previous session's leftover values into each other.
  useEffect(() => {
    if (!open) return;
    setTouched(false);
    if (mode === "edit" && record) {
      setStaffId(String(record.staffId));
      setCheckInLocal(toDatetimeLocalValue(record.inTime, timeZone));
      setCheckOutLocal(toDatetimeLocalValue(record.outTime, timeZone));
      setArrivalStatus(record.checkInStatus || "on_time");
      setNotes(record.notes ?? "");
    } else {
      setStaffId(initialStaffId != null ? String(initialStaffId) : "");
      const seedDate = initialDate || new Date().toISOString().slice(0, 10);
      setCheckInLocal(`${seedDate}T09:00`);
      setCheckOutLocal("");
      setArrivalStatus("on_time");
      setNotes("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, record?.id, initialStaffId, initialDate]);

  const selectedStaff = useMemo(
    () => staffOptions.find((s) => String(s.id) === staffId),
    [staffOptions, staffId],
  );

  const staffMissing = mode === "add" && !staffId;
  const checkInMissing = mode === "add" && !checkInLocal;
  const checkOutBeforeCheckIn =
    checkInLocal &&
    checkOutLocal &&
    checkOutLocal < checkInLocal; // both "YYYY-MM-DDTHH:mm", lexicographic compare is safe here.

  const canSubmit =
    !saving && !staffMissing && !checkInMissing && !checkOutBeforeCheckIn;

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!canSubmit) return;
    onSubmit({
      staffId: mode === "edit" ? (record?.staffId as string | number) : staffId,
      checkIn: checkInLocal ? fromDatetimeLocalValue(checkInLocal, timeZone) : null,
      checkOut: checkOutLocal
        ? fromDatetimeLocalValue(checkOutLocal, timeZone)
        : null,
      arrivalStatus,
      notes: notes.trim(),
    });
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(15,23,42,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
      onClick={(e) => e.target === e.currentTarget && !saving && onClose()}
    >
      <div
        style={{
          background: T.bgCard,
          borderRadius: 16,
          width: "100%",
          maxWidth: 480,
          maxHeight: "90vh",
          overflow: "auto",
          boxShadow: "0 20px 60px rgba(15,45,74,0.25)",
        }}
        role="dialog"
        aria-modal="true"
        aria-label={
          mode === "edit" ? "Edit attendance record" : "Add attendance record"
        }
      >
        <form onSubmit={handleSubmit}>
          {/* Header */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "18px 24px",
              borderBottom: `1px solid ${T.border}`,
              position: "sticky",
              top: 0,
              background: T.bgCard,
              zIndex: 1,
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 700, color: T.textHeading }}>
              {mode === "edit" ? "Edit Attendance" : "Add Attendance"}
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              style={{
                background: "none",
                border: "none",
                cursor: saving ? "not-allowed" : "pointer",
                color: T.textMuted,
                padding: 4,
              }}
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>

          <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
            <p style={{ fontSize: 13, color: T.textMuted, margin: 0, lineHeight: 1.5 }}>
              {mode === "edit"
                ? "Correct this employee's check-in/check-out or add the details CCTV missed."
                : "Use this when CCTV never captured a check-in for the day, so the next detection isn't read as a fresh check-in."}
            </p>

            {/* Employee */}
            <div>
              <label style={fieldLabelStyle}>
                <User size={11} style={{ display: "inline", marginRight: 4, verticalAlign: -1 }} />
                Employee
              </label>
              {mode === "edit" ? (
                <div
                  style={{
                    ...inputStyle,
                    background: T.slate50,
                    color: T.textBody,
                    fontWeight: 600,
                  }}
                >
                  {record?.staffName || selectedStaff?.name || "—"}
                </div>
              ) : (
                <select
                  style={inputStyle}
                  value={staffId}
                  onChange={(e) => setStaffId(e.target.value)}
                  required
                >
                  <option value="">Select employee…</option>
                  {staffOptions.map((option) => (
                    <option key={String(option.id)} value={String(option.id)}>
                      {option.name}
                      {option.code ? ` (${option.code})` : ""}
                    </option>
                  ))}
                </select>
              )}
              {touched && staffMissing && (
                <p style={{ fontSize: 12, color: T.red600, margin: "6px 0 0" }}>
                  Please select an employee.
                </p>
              )}
            </div>

            {/* Check-in / Check-out */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={fieldLabelStyle}>
                  <Clock size={11} style={{ display: "inline", marginRight: 4, verticalAlign: -1 }} />
                  Check-in
                </label>
                <input
                  type="datetime-local"
                  style={inputStyle}
                  value={checkInLocal}
                  onChange={(e) => setCheckInLocal(e.target.value)}
                />
                {touched && checkInMissing && (
                  <p style={{ fontSize: 12, color: T.red600, margin: "6px 0 0" }}>
                    Check-in time is required.
                  </p>
                )}
              </div>
              <div>
                <label style={fieldLabelStyle}>
                  <Clock size={11} style={{ display: "inline", marginRight: 4, verticalAlign: -1 }} />
                  Check-out
                </label>
                <input
                  type="datetime-local"
                  style={inputStyle}
                  value={checkOutLocal}
                  onChange={(e) => setCheckOutLocal(e.target.value)}
                />
              </div>
            </div>
            {touched && checkOutBeforeCheckIn && (
              <p style={{ fontSize: 12, color: T.red600, margin: "-8px 0 0" }}>
                Check-out can't be earlier than check-in.
              </p>
            )}

            {/* Arrival status */}
            <div>
              <label style={fieldLabelStyle}>
                <Calendar size={11} style={{ display: "inline", marginRight: 4, verticalAlign: -1 }} />
                Arrival Status
              </label>
              <select
                style={inputStyle}
                value={arrivalStatus}
                onChange={(e) => setArrivalStatus(e.target.value)}
              >
                {ARRIVAL_STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Notes */}
            <div>
              <label style={fieldLabelStyle}>Notes (optional)</label>
              <textarea
                style={{ ...inputStyle, minHeight: 72, resize: "vertical", fontFamily: "inherit" }}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Forgot badge, verified manually by supervisor"
              />
            </div>

            {errorMessage && (
              <div
                style={{
                  background: T.red100,
                  color: T.red600,
                  borderRadius: 10,
                  padding: "10px 12px",
                  fontSize: 13,
                }}
                role="alert"
              >
                {errorMessage}
              </div>
            )}
          </div>

          {/* Footer */}
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 10,
              padding: "16px 24px",
              borderTop: `1px solid ${T.border}`,
              position: "sticky",
              bottom: 0,
              background: T.bgCard,
            }}
          >
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              style={{
                padding: "9px 16px",
                borderRadius: 10,
                border: `1px solid ${T.border}`,
                background: "#fff",
                color: T.textBody,
                fontSize: 13,
                fontWeight: 600,
                cursor: saving ? "not-allowed" : "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              style={{
                padding: "9px 18px",
                borderRadius: 10,
                border: "none",
                background: T.teal600,
                color: "#fff",
                fontSize: 13,
                fontWeight: 700,
                cursor: canSubmit ? "pointer" : "not-allowed",
                opacity: canSubmit ? 1 : 0.6,
              }}
            >
              {saving
                ? "Saving…"
                : mode === "edit"
                  ? "Save Changes"
                  : "Add Attendance"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ManualAttendanceModal;
