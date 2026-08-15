/**
 * modules/attendance/settings/AttendanceSettingsScreens.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Branch-admin settings screens for the timing/attendance engine described in
 * support_db_attendance_gate.py's resolution precedence:
 *
 *   1. Approved half-day leave            → Half-Day Windows tab
 *   2. Staff-specific override            → Shift Allocation tab in Staff Management
 *   3. Department-specific override       → Shift Allocation tab in Staff Management
 *   4. Assigned shift (mode='shift')      → (managed in client_shift_routes.py /
 *                                            StaffManagement's live shift assignment)
 *   5. Branch + people_type baseline      → Capture Settings tab
 *   6. Unscheduled                        → nothing configured anywhere
 *
 * Departments CRUD has been removed from this screen (previously owned here
 * since department is a prerequisite for both StaffManagement's live
 * department assignment and department-scoped timing overrides). Department
 * management now lives elsewhere; this component only reads people-type
 * context, it no longer creates/edits/deletes departments.
 *
 * This component is self-contained and does not assume a specific Settings.tsx
 * shell — mount it wherever the app's settings navigation lives, passing a
 * branchId (and optionally a default peopleType). It reads organizationId
 * from OrgConfigContext itself.
 *
 * Deliberately uses plain <select>/<input> rather than the app's shared
 * ModernSelect/theme components, since this file was built without visibility
 * into those modules this session — swap them in later if you want the exact
 * same look as StaffManagement/LeaveManagement.
 */

import React, { useEffect, useMemo, useState } from "react";
import { useOrg } from "../../../contexts/OrgConfigContext";
import { useDebouncedValue } from "../../../hooks/useDebouncedValue";
import {
  normalizePeopleType,
  type PeopleType,
} from "../../StaffManagement/types/types";
import { listStaffPage } from "../../StaffManagement/api/staffApi";
import { apiUserToStaffMember } from "../../StaffManagement/api/staffMappers";
import {
  getCaptureSettings,
  upsertCaptureSettings,
  // manual instructions / branch defaults
  listManualInstructions,
  createManualInstruction,
  deleteManualInstruction,
  type CaptureSettings,
  type ManualInstruction,
} from "../../StaffManagement/api/attendanceSettingsApi";
import {
  isOvertimeEnabledForConfig,
  peopleLabelForType,
  resolvePeopleRenderingModel,
  resolveTemplateTerminology,
} from "../../../utils/templateRendering";
import OvertimeManagement from "../../Overtime/OvertimeManagement";

// ─── Shared styling (plain, dependency-free) ──────────────────────────────

const S = {
  page: { display: "flex", flexDirection: "column" as const, gap: 18 },
  card: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 14,
    padding: 18,
  },
  h3: { margin: "0 0 12px", fontSize: 14, fontWeight: 800, color: "#1a699f" },
  label: {
    display: "block",
    fontSize: 11,
    fontWeight: 700,
    color: "#64748b",
    marginBottom: 5,
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
  },
  input: {
    width: "100%",
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid #e2e8f0",
    fontSize: 13,
  },
  row: {
    display: "flex",
    gap: 10,
    alignItems: "flex-end",
    flexWrap: "wrap" as const,
  },
  button: {
    padding: "8px 14px",
    borderRadius: 8,
    border: "none",
    background: "#0d9488",
    color: "#fff",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
  buttonGhost: {
    padding: "8px 14px",
    borderRadius: 8,
    border: "1px solid #e2e8f0",
    background: "#fff",
    color: "#334155",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
  buttonDanger: {
    padding: "6px 10px",
    borderRadius: 8,
    border: "1px solid #fecaca",
    background: "#fff1f2",
    color: "#e11d48",
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
  },
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 12.5 },
  th: {
    textAlign: "left" as const,
    padding: "8px 10px",
    color: "#64748b",
    fontWeight: 700,
    fontSize: 10.5,
    textTransform: "uppercase" as const,
    borderBottom: "1px solid #e2e8f0",
  },
  td: { padding: "8px 10px", borderBottom: "1px solid #f1f5f9" },
  error: { fontSize: 12, color: "#e11d48", fontWeight: 600, marginTop: 6 },
  lookupHint: { fontSize: 11.5, color: "#64748b", marginTop: 6 },
  lookupMatch: {
    fontSize: 11.5,
    color: "#16a34a",
    fontWeight: 700,
    marginTop: 6,
  },
  lookupWarn: {
    fontSize: 11.5,
    color: "#b45309",
    fontWeight: 600,
    marginTop: 6,
  },
  tabBar: {
    display: "flex",
    gap: 6,
    borderBottom: "1px solid #e2e8f0",
    marginBottom: 4,
  },
  tab: (active: boolean) => ({
    padding: "10px 14px",
    fontSize: 12.5,
    fontWeight: 700,
    color: active ? "#0d9488" : "#64748b",
    borderBottom: active ? "2px solid #0d9488" : "2px solid transparent",
    cursor: "pointer",
    background: "none",
    border: "none",
  }),
};

// ─── Root panel ─────────────────────────────────────────────────────────────

type SettingsTab = "capture" | "overtime";

export interface AttendanceSettingsScreensProps {
  branchId: number | string;
  /** Optional starting people_type; defaults to "staff". */
  defaultPeopleType?: string;
}

export const AttendanceSettingsScreens: React.FC<
  AttendanceSettingsScreensProps
> = ({ branchId, defaultPeopleType }) => {
  const { organizationId, cfg } = useOrg();
  const terminology = useMemo(() => resolveTemplateTerminology(cfg), [cfg]);
  const activePeopleTypes = useMemo(
    () =>
      Array.from(
        new Set(
          terminology.activePeopleTypes.map((type) =>
            normalizePeopleType(type),
          ),
        ),
      ),
    [terminology.activePeopleTypes],
  );

  // Same class of bug as Settings.tsx's selectedBranchId, one level down:
  // this whole component remounts fresh every time the user navigates back
  // to Settings, so a plain useState default would silently snap the
  // Manual Instructions / Capture Settings tabs back to the org's default
  // people_type — even if the user had switched to, say, "students" before
  // saving. The saved rows are untouched in the DB; they just stop matching
  // the people_type filter once the tab quietly flips back, which looks
  // identical to the data having vanished. The URL (not localStorage, not a
  // Supabase-backed preference) is the right place to remember this: it's
  // view state, not application data, so it needs no round trip or schema,
  // and it comes with shareable/bookmarkable links and refresh-survival for
  // free. Namespaced per branchId since one URL can only hold one value per
  // key and the branch itself is also URL-driven (see Settings.tsx).
  const peopleTypeParam = `people_type_${branchId}`;

  const [tab, setTab] = useState<SettingsTab>("capture");
  const [peopleType, setPeopleType] = useState<PeopleType>(() => {
    let fromUrl: string | null = null;
    try {
      fromUrl = new URLSearchParams(window.location.search).get(
        peopleTypeParam,
      );
    } catch {
      fromUrl = null;
    }
    return normalizePeopleType(
      fromUrl ??
        defaultPeopleType ??
        terminology.defaultPeopleType ??
        activePeopleTypes[0] ??
        "staff",
    );
  });

  useEffect(() => {
    // Only fall back to the computed default when the current selection is
    // no longer valid for this org (e.g. the people type was disabled) —
    // never clobber a still-valid, deliberately chosen people_type.
    if (activePeopleTypes.length && activePeopleTypes.includes(peopleType)) {
      return;
    }
    const preferred = normalizePeopleType(
      defaultPeopleType ??
        terminology.defaultPeopleType ??
        activePeopleTypes[0] ??
        "staff",
    );
    if (peopleType !== preferred) {
      setPeopleType(preferred);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    defaultPeopleType,
    terminology.defaultPeopleType,
    activePeopleTypes.join(","),
  ]);

  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set(peopleTypeParam, peopleType);
      window.history.replaceState(window.history.state, "", url.toString());
    } catch {
      // Non-browser environment — selection just won't survive a remount.
    }
  }, [peopleTypeParam, peopleType]);

  const peopleModel = useMemo(
    () => resolvePeopleRenderingModel(cfg, peopleType),
    [cfg, peopleType],
  );
  const showOvertimeTab = useMemo(
    () => isOvertimeEnabledForConfig(cfg, peopleType),
    [cfg, peopleType],
  );

  const peopleTypeOptions =
    activePeopleTypes.length > 0
      ? activePeopleTypes.map((type) => ({
          value: type as PeopleType,
          label: peopleLabelForType(type, cfg).plural,
        }))
      : [
          {
            value: peopleType,
            label: peopleLabelForType(peopleType, cfg).plural,
          },
        ];

  if (!organizationId) {
    return null;
  }

  return (
    <div style={S.page}>
      <div style={S.tabBar}>
        <button
          style={S.tab(tab === "capture")}
          onClick={() => setTab("capture")}
        >
          Capture Settings
        </button>
        {showOvertimeTab && (
          <button
            style={S.tab(tab === "overtime")}
            onClick={() => setTab("overtime")}
          >
            Overtime
          </button>
        )}
      </div>

      {tab === "capture" && peopleTypeOptions.length > 1 && (
        <div style={{ ...S.card, paddingBottom: 12 }}>
          <label style={S.label}>People Type</label>
          <select
            style={{ ...S.input, maxWidth: 240 }}
            value={peopleType}
            onChange={(e) => setPeopleType(normalizePeopleType(e.target.value))}
          >
            {peopleTypeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {tab === "capture" && (
        <CaptureSettingsPanel
          branchId={branchId}
          organizationId={organizationId}
          peopleType={peopleType}
        />
      )}
      {/* Half-day panel removed */}
      {tab === "overtime" && showOvertimeTab && (
        <div style={S.card}>
          <h3 style={S.h3}>Overtime Requests</h3>
          <p
            style={{
              fontSize: 12,
              color: "#64748b",
              marginTop: -6,
              marginBottom: 14,
            }}
          >
            Workforce overtime requests for this branch are managed here and
            stay scoped to the same tenant and branch context as the rest of the
            dashboard.
          </p>
          <OvertimeManagement embedded branchScopeOverride={branchId} />
        </div>
      )}
    </div>
  );
};

export default AttendanceSettingsScreens;

// ─── Capture Settings (branch + people_type baseline) ─────────────────────

const CaptureSettingsPanel: React.FC<{
  branchId: number | string;
  organizationId: number | string;
  peopleType: PeopleType;
}> = ({ branchId, organizationId, peopleType }) => {
  const [settings, setSettings] = useState<CaptureSettings>({
    mode: "simple",
    check_in_grace_minutes: 10,
    capture_check_out: false,
    check_out_grace_minutes: 10,
    sync_delay_minutes: 0,
  });
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCaptureSettings(branchId, peopleType, organizationId)
      .then((row) => {
        if (cancelled) return;
        if (row) setSettings({ ...settings, ...row });
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to load capture settings.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, organizationId, peopleType]);

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    setSaved(false);
    try {
      // Save capture mode (shift), sync delay, and branch-level grace defaults.
      // Shifts themselves are assigned to staff members in Staff Management.
      await upsertCaptureSettings(branchId, peopleType, organizationId, {
        mode: "shift",
        sync_delay_minutes: settings.sync_delay_minutes ?? 0,
        check_in_grace_minutes: Number(settings.check_in_grace_minutes) || 0,
        check_out_grace_minutes: Number(settings.check_out_grace_minutes) || 0,
      });

      setSaved(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save capture settings.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={S.card}>
        <p style={{ fontSize: 12, color: "#64748b" }}>Loading…</p>
      </div>
    );
  }

  return (
    <div style={S.card}>
      <h3 style={S.h3}>
        Capture Settings —{" "}
        {peopleType.charAt(0).toUpperCase() + peopleType.slice(1)}
      </h3>

      <div
        style={{
          fontSize: 12,
          color: "#64748b",
          lineHeight: 1.5,
          marginBottom: 14,
          padding: 10,
          backgroundColor: "#f8fafc",
          borderRadius: 6,
          borderLeft: "3px solid #0d9488",
        }}
      >
        <strong style={{ color: "#0d9488" }}>How it works:</strong>
        <ul style={{ margin: "6px 0 0 18px", paddingLeft: 0 }}>
          <li>
            Shifts are assigned to staff members in{" "}
            <strong>Staff Management → Shift Allocation</strong>
          </li>
          <li>
            Attendance is automatically marked according to each person's
            assigned shift
          </li>
          <li>
            Use <strong>Manual Instructions</strong> (below) to override for
            specific dates
          </li>
        </ul>
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        <div style={S.row}>
          <div>
            <label style={S.label}>Check-in Grace (min)</label>
            <input
              type="number"
              style={{ ...S.input, width: 140 }}
              value={settings.check_in_grace_minutes ?? 0}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  check_in_grace_minutes: Number(e.target.value),
                })
              }
            />
          </div>
          <div>
            <label style={S.label}>Check-out Grace (min)</label>
            <input
              type="number"
              style={{ ...S.input, width: 140 }}
              value={settings.check_out_grace_minutes ?? 0}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  check_out_grace_minutes: Number(e.target.value),
                })
              }
            />
          </div>
          <div>
            <label style={S.label}>Sync Delay (min)</label>
            <input
              type="number"
              min="0"
              style={{ ...S.input, width: 140 }}
              value={settings.sync_delay_minutes ?? 0}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  sync_delay_minutes: Math.max(0, Number(e.target.value) || 0),
                })
              }
            />
          </div>
        </div>

        {error && <div style={S.error}>{error}</div>}
        {saved && !error && (
          <div style={{ fontSize: 12, color: "#16a34a", fontWeight: 600 }}>
            Saved.
          </div>
        )}

        <div>
          <button
            style={S.button}
            onClick={() => void handleSave()}
            disabled={isSaving}
          >
            {isSaving ? "Saving…" : "Save Capture Settings"}
          </button>
        </div>
      </div>
    </div>
  );
};

// Half-Day Windows removed — handled by cloud-side leave flow now.

// ─── Manual Instructions (admin-created attendance overrides) ─────────────

const ManualInstructionsPanel: React.FC<{
  branchId: number | string;
  organizationId: number | string;
  peopleType: PeopleType;
  peopleModel: ReturnType<typeof resolvePeopleRenderingModel>;
}> = ({ branchId, organizationId, peopleType, peopleModel }) => {
  const [instructions, setInstructions] = useState<ManualInstruction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [personCode, setPersonCode] = useState("");
  const [attendanceDate, setAttendanceDate] = useState<string>(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [reason, setReason] = useState<string>("manual");
  const [notes, setNotes] = useState<string>("");
  const [checkInTime, setCheckInTime] = useState<string | null>(null);
  const [checkInGraceMinutes, setCheckInGraceMinutes] = useState<number | null>(
    null,
  );
  const [checkOutTime, setCheckOutTime] = useState<string | null>(null);
  const [checkOutGraceMinutes, setCheckOutGraceMinutes] = useState<
    number | null
  >(null);

  // ── Person-code lookup ────────────────────────────────────────────────
  // Reuses the same listStaffPage search that already powers the Staff
  // Directory's "search by ID" box (organization + branch + people_type
  // scoped, per the app's own person_code uniqueness model), so this stays
  // a single source of truth for "does this code resolve to a real person"
  // rather than re-implementing lookup logic here.
  interface ResolvedPerson {
    id: string;
    personCode: string;
    name: string;
    department: string;
    branchName: string;
    status: string;
  }

  const [resolvedPerson, setResolvedPerson] = useState<ResolvedPerson | null>(
    null,
  );
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [lookupWarning, setLookupWarning] = useState<string | null>(null);
  const debouncedPersonCode = useDebouncedValue(personCode.trim(), 350);

  useEffect(() => {
    let cancelled = false;

    if (!debouncedPersonCode) {
      setResolvedPerson(null);
      setLookupWarning(null);
      setIsLookingUp(false);
      return;
    }

    setIsLookingUp(true);
    setLookupWarning(null);

    listStaffPage({
      organizationId,
      branchId,
      peopleType,
      search: debouncedPersonCode,
      page: 1,
      pageSize: 5,
    })
      .then((res) => {
        if (cancelled) return;
        const match = res.rows.map(apiUserToStaffMember).find(
          (row) =>
            String(row.personCode ?? "")
              .trim()
              .toLowerCase() === debouncedPersonCode.toLowerCase(),
        );

        if (match) {
          setResolvedPerson({
            id: String(match.id),
            personCode: String(match.personCode ?? ""),
            name: match.name,
            department: match.department || "—",
            branchName: match.branchName || "—",
            status: match.status ?? "active",
          });
          setLookupWarning(null);
        } else {
          setResolvedPerson(null);
          setLookupWarning(
            `No matching ${peopleModel.personCodeLabel.toLowerCase()} found for this branch/people type.`,
          );
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setResolvedPerson(null);
        setLookupWarning(
          err instanceof Error ? err.message : "Person lookup failed.",
        );
      })
      .finally(() => {
        if (!cancelled) setIsLookingUp(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    debouncedPersonCode,
    organizationId,
    branchId,
    peopleType,
    peopleModel.personCodeLabel,
  ]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listManualInstructions(
        branchId,
        organizationId,
        peopleType,
      );
      setInstructions(rows);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load manual instructions.",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, organizationId, peopleType]);

  const handleCreate = async () => {
    if (!personCode.trim() || !resolvedPerson) {
      setError(`Valid ${peopleModel.personCodeLabel} is required.`);
      return;
    }
    setIsSaving(true);
    setError(null);

    try {
      await createManualInstruction(branchId, organizationId, {
        staff_id: resolvedPerson.id,
        person_code: resolvedPerson.personCode,
        people_type: peopleType,
        attendance_date: attendanceDate,
        check_in_time: checkInTime || null,
        check_in_grace_minutes: checkInTime ? checkInGraceMinutes : null,
        check_out_time: checkOutTime || null,
        check_out_grace_minutes: checkOutTime ? checkOutGraceMinutes : null,
        reason,
        notes: notes || null,
      });

      // Clear form + refresh list
      setPersonCode("");
      setResolvedPerson(null);
      setCheckInTime(null);
      setCheckOutTime(null);
      setCheckInGraceMinutes(null);
      setCheckOutGraceMinutes(null);
      setNotes("");
      await load(); // Immediate refresh

      // Optional: show toast
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create instruction.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setIsSaving(true);
    setError(null);
    try {
      await deleteManualInstruction(id, organizationId);
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to delete instruction.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div style={S.card}>
      <h3 style={S.h3}>
        Manual Attendance Overrides —{" "}
        {peopleType.charAt(0).toUpperCase() + peopleType.slice(1)}
      </h3>

      <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
        <div style={S.row}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={S.label}>{peopleModel.personCodeLabel}</label>
            <input
              style={S.input}
              value={personCode}
              onChange={(e) => {
                setPersonCode(e.target.value);
                setResolvedPerson(null);
              }}
              placeholder={`e.g. ${peopleModel.personCodeLabel}`}
            />
            {isLookingUp && <div style={S.lookupHint}>Looking up…</div>}
            {!isLookingUp && resolvedPerson && (
              <div style={S.lookupMatch}>
                ✓ {resolvedPerson.name} — {resolvedPerson.department} —{" "}
                {resolvedPerson.branchName}
              </div>
            )}
            {!isLookingUp && !resolvedPerson && lookupWarning && (
              <div style={S.lookupWarn}>{lookupWarning}</div>
            )}
          </div>
          <div>
            <label style={S.label}>Date</label>
            <input
              type="date"
              style={S.input}
              value={attendanceDate}
              onChange={(e) => setAttendanceDate(e.target.value)}
            />
          </div>
          <div>
            <label style={S.label}>Check-in Time</label>
            <input
              type="time"
              style={S.input}
              value={checkInTime ?? ""}
              onChange={(e) => setCheckInTime(e.target.value || null)}
            />
          </div>

          <div>
            <label style={S.label}>Check-out Time</label>
            <input
              type="time"
              style={S.input}
              value={checkOutTime ?? ""}
              onChange={(e) => setCheckOutTime(e.target.value || null)}
            />
          </div>
          <div>
            <label style={S.label}>Check-in Grace (min)</label>
            <input
              type="number"
              min="0"
              style={S.input}
              value={checkInGraceMinutes ?? ""}
              disabled={!checkInTime}
              placeholder={checkInTime ? "0" : "—"}
              onChange={(e) =>
                setCheckInGraceMinutes(
                  e.target.value === "" ? null : Number(e.target.value),
                )
              }
            />
          </div>
          <div>
            <label style={S.label}>Check-out Grace (min)</label>
            <input
              type="number"
              min="0"
              style={S.input}
              value={checkOutGraceMinutes ?? ""}
              disabled={!checkOutTime}
              placeholder={checkOutTime ? "0" : "—"}
              onChange={(e) =>
                setCheckOutGraceMinutes(
                  e.target.value === "" ? null : Number(e.target.value),
                )
              }
            />
          </div>
        </div>
        <div>
          <label style={S.label}>Reason</label>
          <select
            style={{ ...S.input, maxWidth: 260 }}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          >
            <option value="manual">Manual</option>
            <option value="half_day">Half-Day</option>
            <option value="overtime">Overtime</option>
          </select>
        </div>
        <div>
          <label style={S.label}>Notes (optional)</label>
          <input
            style={S.input}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        {error && <div style={S.error}>{error}</div>}

        <div>
          <button
            style={{
              ...S.button,
              opacity: isSaving || isLookingUp || !resolvedPerson ? 0.55 : 1,
              cursor:
                isSaving || isLookingUp || !resolvedPerson
                  ? "not-allowed"
                  : "pointer",
            }}
            onClick={() => void handleCreate()}
            disabled={isSaving || isLookingUp || !resolvedPerson}
            title={
              !resolvedPerson
                ? `Enter a valid ${peopleModel.personCodeLabel.toLowerCase()} to confirm the person first`
                : undefined
            }
          >
            {isSaving ? "Saving…" : "Create Instruction"}
          </button>
        </div>
      </div>

      {loading ? (
        <p style={{ fontSize: 12, color: "#64748b" }}>Loading…</p>
      ) : instructions.length === 0 ? (
        <p style={{ fontSize: 12, color: "#64748b" }}>
          No manual instructions yet.
        </p>
      ) : (
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Person</th>
              <th style={S.th}>Date</th>
              <th style={S.th}>Check-in</th>
              <th style={S.th}>Check-out</th>
              <th style={S.th}>Check-in Grace</th>
              <th style={S.th}>Check-out Grace</th>
              <th style={S.th}>Reason</th>
              <th style={S.th}></th>
            </tr>
          </thead>
          <tbody>
            {instructions.map((inst) => (
              <tr key={inst.id}>
                <td style={S.td}>{inst.person_code ?? inst.staff_id ?? "—"}</td>
                <td style={S.td}>{inst.attendance_date}</td>
                <td style={S.td}>{inst.check_in_time ?? "—"}</td>
                <td style={S.td}>{inst.check_out_time ?? "—"}</td>
                <td style={S.td}>{inst.check_in_grace_minutes ?? "—"}</td>
                <td style={S.td}>{inst.check_out_grace_minutes ?? "—"}</td>
                <td style={S.td}>{inst.reason ?? "—"}</td>
                <td style={{ ...S.td, textAlign: "right" as const }}>
                  <button
                    style={S.buttonDanger}
                    onClick={() => void handleDelete(inst.id)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
