/**
 * modules/staff/components/ShiftTimingsModal.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Branch shift CRUD. Draft rows (id prefixed "draft-") exist only in local
 * state until Save, which is what tells the save handler whether a row needs
 * createShift or updateShift.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { type FC, useEffect, useState } from "react";
import { toastError, toastSuccess } from "../../../utils/notifications";
import { Plus, Save, Trash2, X } from "lucide-react";
import { ActionButton } from "../../engine/ModuleShell";
import { T } from "../../../components/ui/theme";
import {
  createShift,
  deleteShift,
  listBranchShifts,
  type ShiftRecord,
  updateShift,
} from "../api/attendanceSettingsApi";

// ─── Shift Settings + Allocation ─────────────────────────────────────────────

// A draft row can be a real backend shift (has a real UUID `id` from the
// `shifts` table) or a not-yet-saved row the admin just clicked "+ Add
// Shift" for (id starts with "draft-" and only exists in this component's
// local state until Save is pressed). This distinction is exactly what
// tells handleSaveAll whether to call createShift or updateShift for a
// given row, and tells handleDeleteRow whether it needs to hit the
// backend at all.
export interface ShiftTimingsDraftRow {
  id: string;
  isDraft: boolean;
  name: string;
  check_in_time: string;
  grace_minutes: number;
  capture_check_out: boolean;
  check_out_time: string;
  checkout_grace_minutes: number;
  /** How long after THIS shift's grace window closes (check-in or
   * check-out, whichever leg just confirmed) before it auto-syncs to the
   * cloud. 0 = sync as soon as the window closes. */
  sync_delay_minutes: number;
  is_active?: boolean;
}

export const shiftRecordToDraftRow = (
  shift: ShiftRecord,
): ShiftTimingsDraftRow => ({
  id: shift.id,
  isDraft: false,
  name: shift.name ?? "",
  check_in_time: (shift.check_in_time ?? "09:00:00").slice(0, 5),
  grace_minutes: shift.grace_minutes ?? 15,
  capture_check_out: shift.check_out_time != null,
  check_out_time: (shift.check_out_time ?? "17:00:00").slice(0, 5),
  checkout_grace_minutes: shift.checkout_grace_minutes ?? 15,
  sync_delay_minutes: shift.sync_delay_minutes ?? 0,
  is_active: shift.is_active,
});

// Starter shifts offered the first time a branch has zero shifts configured.
// These are plain local drafts (isDraft: true, id: "draft-…") — nothing is
// written to the backend until the admin presses "Save Shift Timings", and
// each row can be freely renamed, retimed, or deleted (individually, via
// handleDeleteRow) before or after that first save, exactly like any other
// row. Night is modeled as an overnight shift (22:00 → 06:00); the shifts
// table stores plain time-of-day values and the attendance gate compares
// against local clock time, so no cross-midnight date math is needed here.
export const DEFAULT_SHIFT_PRESETS: ReadonlyArray<
  Pick<ShiftTimingsDraftRow, "name" | "check_in_time" | "check_out_time">
> = [
  { name: "Morning", check_in_time: "09:00", check_out_time: "17:00" },
  { name: "Evening", check_in_time: "14:00", check_out_time: "22:00" },
  { name: "Night", check_in_time: "22:00", check_out_time: "06:00" },
];

export const buildDefaultShiftDraftRows = (): ShiftTimingsDraftRow[] =>
  DEFAULT_SHIFT_PRESETS.map((preset, index) => ({
    id: `draft-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
    isDraft: true,
    name: preset.name,
    check_in_time: preset.check_in_time,
    grace_minutes: 15,
    capture_check_out: true,
    check_out_time: preset.check_out_time,
    checkout_grace_minutes: 15,
    sync_delay_minutes: 0,
  }));

export const ShiftTimingsModal: FC<{
  branchId: number | string;
  organizationId: number | string;
  peopleType: string;
  branchTimezone: string;
  onClose: () => void;
  onSaved: () => void;
}> = ({
  branchId,
  organizationId,
  peopleType,
  branchTimezone,
  onClose,
  onSaved,
}) => {
  const [rows, setRows] = useState<ShiftTimingsDraftRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);
    listBranchShifts(branchId, organizationId, peopleType)
      .then((shifts) => {
        if (cancelled) return;
        setRows(
          shifts.length > 0
            ? shifts.map(shiftRecordToDraftRow)
            : buildDefaultShiftDraftRows(),
        );
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError(
          error instanceof Error ? error.message : "Failed to load shifts.",
        );
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [branchId, organizationId, peopleType]);

  const setRow = <K extends keyof ShiftTimingsDraftRow>(
    id: string,
    key: K,
    value: ShiftTimingsDraftRow[K],
  ) => {
    setRows((items) =>
      items.map((item) => (item.id === id ? { ...item, [key]: value } : item)),
    );
  };

  const handleAddRow = () => {
    setRows((items) => [
      ...items,
      {
        id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        isDraft: true,
        name: "",
        check_in_time: "09:00",
        grace_minutes: 15,
        capture_check_out: true,
        check_out_time: "17:00",
        checkout_grace_minutes: 15,
        sync_delay_minutes: 0,
      },
    ]);
  };

  const handleDeleteRow = async (row: ShiftTimingsDraftRow) => {
    if (row.isDraft) {
      // Never persisted — just drop it locally, no backend call needed.
      setRows((items) => items.filter((item) => item.id !== row.id));
      return;
    }
    if (
      !window.confirm(
        `Delete "${row.name || "this shift"}"? Any staff member currently assigned to it will fall back to the branch default (or be held for review if none is set).`,
      )
    ) {
      return;
    }
    setDeletingId(row.id);
    try {
      await deleteShift(branchId, row.id, organizationId);
      setRows((items) => items.filter((item) => item.id !== row.id));
      onSaved();
    } catch (error) {
      setRowErrors((prev) => ({
        ...prev,
        [row.id]:
          error instanceof Error ? error.message : "Failed to delete shift.",
      }));
    } finally {
      setDeletingId(null);
    }
  };

  const handleSaveAll = async () => {
    setIsSaving(true);
    setRowErrors({});
    const nextErrors: Record<string, string> = {};
    let anySucceeded = false;

    for (const row of rows) {
      const name = row.name.trim();
      if (!name) {
        nextErrors[row.id] = "Shift name is required.";
        continue;
      }
      const payload = {
        name,
        people_type: peopleType,
        check_in_time: row.check_in_time,
        grace_minutes: row.grace_minutes,
        capture_check_out: row.capture_check_out,
        check_out_time: row.capture_check_out ? row.check_out_time : undefined,
        checkout_grace_minutes: row.capture_check_out
          ? row.checkout_grace_minutes
          : undefined,
        sync_delay_minutes: row.sync_delay_minutes,
      };
      try {
        if (row.isDraft) {
          const created = await createShift(branchId, organizationId, payload);
          setRows((items) =>
            items.map((item) =>
              item.id === row.id ? shiftRecordToDraftRow(created) : item,
            ),
          );
        } else {
          await updateShift(branchId, row.id, organizationId, payload);
        }
        anySucceeded = true;
      } catch (error) {
        nextErrors[row.id] =
          error instanceof Error ? error.message : "Failed to save this shift.";
      }
    }

    setRowErrors(nextErrors);
    setIsSaving(false);
    if (anySucceeded) {
      toastSuccess("Shift timings saved.");
      onSaved();
    }
    if (Object.keys(nextErrors).length > 0) {
      toastError("Some shifts failed to save. Check the highlighted rows.");
    }
    if (Object.keys(nextErrors).length === 0) onClose();
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "9px 12px",
    border: `1px solid ${T.border}`,
    borderRadius: 8,
    fontSize: 13,
    color: T.head,
    background: T.card,
    fontFamily: "inherit",
    outline: "none",
    boxSizing: "border-box",
  };

  const fieldLabelStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 800,
    color: T.muted,
    textTransform: "uppercase",
    letterSpacing: ".07em",
    display: "block",
    marginBottom: 5,
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          background: T.card,
          borderRadius: 16,
          width: "100%",
          maxWidth: 820,
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 20px 60px rgba(0,0,0,0.22)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "18px 24px",
            borderBottom: `1px solid ${T.border}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: T.head }}>
              Shift Timings
            </div>
            <div style={{ fontSize: 12, color: T.muted, marginTop: 3 }}>
              Create as many named shifts as this branch needs — each one is
              saved to the real shift catalog and immediately available to
              assign from the Shift Allocation tab. Toggle{" "}
              <strong style={{ color: T.head }}>Checkout</strong> per shift to
              control whether checkout time is captured for that shift.
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: T.teal600,
                fontWeight: 700,
                marginTop: 6,
              }}
            >
              All times below are in this branch's configured timezone:{" "}
              {branchTimezone}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer" }}
          >
            <X size={18} color={T.muted} />
          </button>
        </div>

        <div style={{ padding: 24, overflowY: "auto", flex: 1 }}>
          {isLoading ? (
            <div style={{ fontSize: 13, color: T.muted, padding: "20px 0" }}>
              Loading shifts…
            </div>
          ) : loadError ? (
            <div style={{ fontSize: 13, color: "#e11d48", padding: "20px 0" }}>
              {loadError}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {rows.length === 0 && (
                <div
                  style={{
                    fontSize: 13,
                    color: T.muted,
                    padding: "12px 0",
                    textAlign: "center",
                  }}
                >
                  No shifts yet for this branch — click "Add Shift" below to
                  create the first one.
                </div>
              )}
              {rows.map((row) => (
                <div
                  key={row.id}
                  style={{
                    padding: 14,
                    border: `1px solid ${rowErrors[row.id] ? "#fecdd3" : T.border}`,
                    borderRadius: 12,
                    background: T.slate50,
                  }}
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "1.3fr 1fr 0.8fr auto 1fr 0.8fr 0.9fr auto",
                      gap: 12,
                      alignItems: "end",
                    }}
                  >
                    <div>
                      <label style={fieldLabelStyle}>Shift Name</label>
                      <input
                        value={row.name}
                        placeholder="e.g. Morning, Night, Arts Teacher Shift"
                        onChange={(e) => setRow(row.id, "name", e.target.value)}
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <label style={fieldLabelStyle}>Check-in</label>
                      <input
                        type="time"
                        value={row.check_in_time}
                        onChange={(e) =>
                          setRow(row.id, "check_in_time", e.target.value)
                        }
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <label style={fieldLabelStyle}>Grace (min)</label>
                      <input
                        type="number"
                        min={0}
                        max={240}
                        value={row.grace_minutes}
                        onChange={(e) =>
                          setRow(
                            row.id,
                            "grace_minutes",
                            Number(e.target.value) || 0,
                          )
                        }
                        style={inputStyle}
                      />
                    </div>
                    {/* ── Capture Checkout toggle ── */}
                    <div>
                      <label style={fieldLabelStyle}>Checkout</label>
                      <button
                        type="button"
                        title={
                          row.capture_check_out
                            ? "Click to disable checkout time capture for this shift"
                            : "Click to enable checkout time capture for this shift"
                        }
                        onClick={() =>
                          setRow(
                            row.id,
                            "capture_check_out",
                            !row.capture_check_out,
                          )
                        }
                        style={{
                          height: 38,
                          padding: "0 12px",
                          border: `1px solid ${
                            row.capture_check_out ? T.teal600 : T.border
                          }`,
                          borderRadius: 8,
                          background: row.capture_check_out
                            ? "#f0fdfa"
                            : T.card,
                          color: row.capture_check_out ? T.teal600 : T.muted,
                          fontSize: 11,
                          fontWeight: 800,
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                          transition: "all 0.15s",
                          fontFamily: "inherit",
                        }}
                      >
                        {row.capture_check_out ? "✓ On" : "Off"}
                      </button>
                    </div>
                    {/* ── Check-out time (grayed when capture_check_out is off) ── */}
                    <div
                      style={{
                        opacity: row.capture_check_out ? 1 : 0.3,
                        pointerEvents: row.capture_check_out ? "auto" : "none",
                        transition: "opacity 0.15s",
                      }}
                    >
                      <label style={fieldLabelStyle}>Check-out</label>
                      <input
                        type="time"
                        value={row.check_out_time}
                        onChange={(e) =>
                          setRow(row.id, "check_out_time", e.target.value)
                        }
                        style={inputStyle}
                      />
                    </div>
                    {/* ── Checkout grace (grayed when capture_check_out is off) ── */}
                    <div
                      style={{
                        opacity: row.capture_check_out ? 1 : 0.3,
                        pointerEvents: row.capture_check_out ? "auto" : "none",
                        transition: "opacity 0.15s",
                      }}
                    >
                      <label style={fieldLabelStyle}>Grace (min)</label>
                      <input
                        type="number"
                        min={0}
                        max={240}
                        value={row.checkout_grace_minutes}
                        onChange={(e) =>
                          setRow(
                            row.id,
                            "checkout_grace_minutes",
                            Number(e.target.value) || 0,
                          )
                        }
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <label style={fieldLabelStyle}>Sync Delay (min)</label>
                      <input
                        type="number"
                        min={0}
                        max={1440}
                        value={row.sync_delay_minutes}
                        onChange={(e) =>
                          setRow(
                            row.id,
                            "sync_delay_minutes",
                            Number(e.target.value) || 0,
                          )
                        }
                        style={inputStyle}
                      />
                    </div>
                    <button
                      onClick={() => void handleDeleteRow(row)}
                      disabled={deletingId === row.id}
                      title="Delete this shift"
                      style={{
                        border: "1px solid #fecdd3",
                        background: "#fff1f2",
                        color: "#e11d48",
                        borderRadius: 8,
                        padding: "9px 10px",
                        cursor:
                          deletingId === row.id ? "not-allowed" : "pointer",
                        opacity: deletingId === row.id ? 0.6 : 1,
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {rowErrors[row.id] && (
                    <div
                      style={{ fontSize: 11, color: "#e11d48", marginTop: 8 }}
                    >
                      {rowErrors[row.id]}
                    </div>
                  )}
                </div>
              ))}

              <button
                onClick={handleAddRow}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  padding: "10px 14px",
                  border: `1px dashed ${T.border}`,
                  borderRadius: 12,
                  background: "transparent",
                  color: T.head,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                <Plus size={14} /> Add Shift
              </button>
            </div>
          )}
        </div>

        <div
          style={{
            padding: "16px 24px",
            borderTop: `1px solid ${T.border}`,
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
          }}
        >
          <ActionButton label="Cancel" onClick={onClose} variant="ghost" />
          <ActionButton
            label={isSaving ? "Saving…" : "Save Shift Timings"}
            Icon={Save}
            onClick={() => void handleSaveAll()}
            disabled={isSaving || isLoading}
          />
        </div>
      </div>
    </div>
  );
};
