/**
 * modules/staff/components/ShiftAllocationTab.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Bulk assignment of staff to the branch's configured shifts.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, {
  type FC,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { toastError, toastSuccess } from "../../../utils/notifications";
import { CalendarClock, TimerReset } from "lucide-react";
import {
  type OrgBranch,
  type OrgDepartment,
} from "../../../contexts/OrgConfigContext";
import { ActionButton } from "../../engine/ModuleShell";
import { T } from "../../../components/ui/theme";
import JellyButton from "../../../components/ui/JellyButton";
import ModernSelect from "../../../components/ui/ModernSelect";
import { resolveApiBranchId } from "../../../utils/tenantScope";
import { type PeopleRenderingModel } from "../../../utils/templateRendering";
import {
  listBranchShifts,
  type ShiftRecord,
} from "../api/attendanceSettingsApi";
import { type StaffMember } from "../types/staffTypes";
import { shiftText } from "../utils/staffShifts";
import { ShiftTimingsModal } from "./ShiftTimingsModal";
import { StaffAttendanceOverridesPanel } from "./StaffAttendanceOverridesPanel";

export const ShiftAllocationTab: FC<{
  staffRows: StaffMember[];
  // Full branch objects (this always receives cfg.branches at runtime) —
  // typed loosely here only for the fields this component itself reads;
  // backendBranchId/backend_branch_id ride along so branch-scoped shift
  // endpoints can resolve the real UUID instead of the UI ordinal id.
  visibleBranches: OrgBranch[];
  departmentsByBranch: Record<number, OrgDepartment[]>;
  organizationId: number | string | null;
  branchName: (id: number) => string;
  isGlobalDashboard: boolean;
  effectiveBranchId?: number;
  peopleModel: PeopleRenderingModel;
  onApplyShift: (target: {
    scope: "branch" | "department" | "individual";
    branchId: number;
    department?: string;
    staffId?: string;
    shiftId: string;
  }) => Promise<void>;
  overrideStaffId?: string;
}> = ({
  staffRows,
  visibleBranches,
  departmentsByBranch,
  organizationId,
  branchName,
  isGlobalDashboard,
  effectiveBranchId,
  peopleModel,
  onApplyShift,
  overrideStaffId,
}) => {
  const defaultBranchId =
    effectiveBranchId ?? visibleBranches[0]?.id ?? staffRows[0]?.branchId ?? 0;

  const [scope, setScope] = useState<"branch" | "department" | "individual">(
    isGlobalDashboard ? "branch" : "department",
  );
  const [selectedBranchId, setSelectedBranchId] = useState(defaultBranchId);
  const [selectedDepartment, setSelectedDepartment] = useState<string>("all");
  const [selectedStaffId, setSelectedStaffId] = useState<string>("");
  const [selectedShiftId, setSelectedShiftId] = useState<string>("");
  const [isApplying, setIsApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [showOverridePanel, setShowOverridePanel] = useState(false);

  const scopedBranchId = isGlobalDashboard
    ? selectedBranchId
    : (effectiveBranchId ?? selectedBranchId);

  // The real Supabase branch UUID for scopedBranchId — every shift endpoint
  // (list/create/update/delete) requires this, not the UI ordinal id. See
  // resolveApiBranchId's own comment for why this translation is mandatory.
  const scopedApiBranchId = useMemo(
    () => resolveApiBranchId(organizationId, scopedBranchId, visibleBranches),
    [organizationId, scopedBranchId, visibleBranches],
  );

  // Real, per-branch shifts (support_db_shifts.py's `shifts` table) — the
  // sole owner of check-in/check-out time in this codebase. Replaces the
  // old org-wide, 4-row-max `ShiftDefinition` list, which could never
  // represent more than one "Custom" shift for the whole organization.
  const [liveShifts, setLiveShifts] = useState<ShiftRecord[]>([]);
  const [isLoadingShifts, setIsLoadingShifts] = useState(false);
  const [shiftsError, setShiftsError] = useState<string | null>(null);
  const [isShiftTimingsOpen, setIsShiftTimingsOpen] = useState(false);

  const scopedBranchTimezone = useMemo(() => {
    try {
      const branch = visibleBranches.find(
        (b) => String(b.id) === String(scopedBranchId),
      );
      return (
        branch?.timezone ||
        Intl.DateTimeFormat().resolvedOptions().timeZone ||
        "UTC"
      );
    } catch {
      return "UTC";
    }
  }, [visibleBranches, scopedBranchId]);

  const reloadShifts = useCallback(() => {
    if (!organizationId || !scopedApiBranchId) {
      setLiveShifts([]);
      setShiftsError(
        scopedBranchId && organizationId
          ? "This branch isn't fully synced yet — its backend id couldn't be resolved."
          : null,
      );
      return;
    }
    setIsLoadingShifts(true);
    setShiftsError(null);
    listBranchShifts(scopedApiBranchId, organizationId, peopleModel.peopleType)
      .then((rows) => setLiveShifts(rows))
      .catch((error) => {
        setLiveShifts([]);
        setShiftsError(
          error instanceof Error ? error.message : "Failed to load shifts.",
        );
      })
      .finally(() => setIsLoadingShifts(false));
  }, [
    organizationId,
    scopedApiBranchId,
    scopedBranchId,
    peopleModel.peopleType,
  ]);

  useEffect(() => {
    reloadShifts();
  }, [reloadShifts]);

  // Keep the selection valid as the branch (and therefore the available
  // shift list) changes — default to the first real shift, or clear it
  // if this branch has none configured yet.
  useEffect(() => {
    setSelectedShiftId((current) => {
      if (liveShifts.some((shift) => shift.id === current)) return current;
      return liveShifts[0]?.id ?? "";
    });
  }, [liveShifts]);

  const branchStaff = useMemo(
    () => staffRows.filter((member) => member.branchId === scopedBranchId),
    [scopedBranchId, staffRows],
  );

  const overrideMember = useMemo(
    () =>
      overrideStaffId
        ? (staffRows.find((member) => member.id === overrideStaffId) ?? null)
        : null,
    [overrideStaffId, staffRows],
  );

  const selectedMember = useMemo(
    () =>
      selectedStaffId
        ? (branchStaff.find((member) => member.id === selectedStaffId) ?? null)
        : null,
    [branchStaff, selectedStaffId],
  );

  useEffect(() => {
    if (scope !== "individual" || !selectedStaffId) {
      setShowOverridePanel(false);
    }
  }, [scope, selectedStaffId]);

  const departmentOptions = useMemo(() => {
    // Departments are organization master-data, so the shift-allocation dropdown
    // must read from cfg.departments instead of deriving options from staff rows.
    // This keeps configured departments visible even before employees are assigned.
    const configuredDepartments = (departmentsByBranch[scopedBranchId] ?? [])
      .map((department) => department.name)
      .filter((name): name is string => Boolean(name?.trim()));

    if (configuredDepartments.length > 0) {
      return [...new Set(configuredDepartments)].sort((a, b) =>
        a.localeCompare(b),
      );
    }

    // Legacy fallback for older localStorage data that may not have department config.
    return Array.from(
      new Set(
        branchStaff
          .map((member) => String(member.department ?? ""))
          .filter((department) => Boolean(department.trim())),
      ),
    ).sort((a, b) => a.localeCompare(b));
  }, [branchStaff, departmentsByBranch, scopedBranchId]);

  const individualOptions = useMemo(() => {
    const list =
      selectedDepartment === "all"
        ? branchStaff
        : branchStaff.filter(
            (member) => member.department === selectedDepartment,
          );
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [branchStaff, selectedDepartment]);

  const selectedShift = liveShifts.find(
    (shift) => shift.id === selectedShiftId,
  );

  useEffect(() => {
    if (!overrideMember) return;
    if (isGlobalDashboard) {
      setSelectedBranchId(overrideMember.branchId);
    }
    setScope("individual");
    setSelectedDepartment("all");
    setSelectedStaffId(overrideMember.id);
    setShowOverridePanel(true);
  }, [isGlobalDashboard, overrideMember]);

  const targetCount = useMemo(() => {
    if (scope === "branch") return branchStaff.length;
    if (scope === "department") {
      if (selectedDepartment === "all") return 0;
      return branchStaff.filter(
        (member) => member.department === selectedDepartment,
      ).length;
    }
    return selectedStaffId ? 1 : 0;
  }, [branchStaff, scope, selectedDepartment, selectedStaffId]);

  const inputStyle: React.CSSProperties = {
    width: "100%",
    height: 38,
    border: `1px solid ${T.border}`,
    borderRadius: 10,
    background: T.card,
    color: T.head,
    padding: "0 12px",
    fontSize: 12,
    fontWeight: 700,
    fontFamily: "inherit",
    outline: "none",
  };

  const labelStyle: React.CSSProperties = {
    display: "block",
    marginBottom: 6,
    color: T.muted,
    fontSize: 10,
    fontWeight: 800,
    letterSpacing: ".07em",
    textTransform: "uppercase",
  };

  const canApply =
    scopedBranchId > 0 &&
    !!selectedShiftId &&
    !isApplying &&
    (scope === "branch" ||
      (scope === "department" && selectedDepartment !== "all") ||
      (scope === "individual" && selectedStaffId));

  const handleApply = async () => {
    if (!canApply) return;
    setIsApplying(true);
    setApplyError(null);
    try {
      await onApplyShift({
        scope,
        branchId: scopedBranchId,
        department:
          selectedDepartment === "all" ? undefined : selectedDepartment,
        staffId: selectedStaffId || undefined,
        shiftId: selectedShiftId,
      });
      toastSuccess("Shift applied successfully.");
      setApplyError(null);
    } catch (error) {
      setApplyError(
        error instanceof Error ? error.message : "Failed to apply shift.",
      );
      toastError(
        error instanceof Error ? error.message : "Failed to apply shift.",
      );
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div
        style={{
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: 16,
          padding: 18,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 16,
          boxShadow:
            "0 1px 3px rgba(15,45,74,0.06),0 1px 2px rgba(15,45,74,0.04)",
        }}
      >
        <div>
          <div style={{ fontSize: 15, fontWeight: 900, color: T.head }}>
            Shift Allocation
          </div>
          <div style={{ fontSize: 12, color: T.muted, marginTop: 3 }}>
            {isGlobalDashboard
              ? "Admin can allocate shifts branch-wise, department-wise, or individually."
              : `Branch dashboard is locked to ${branchName(scopedBranchId)} and can allocate by department or individual.`}
          </div>
        </div>
        <ActionButton
          label="Shift Timings"
          Icon={TimerReset}
          onClick={() => setIsShiftTimingsOpen(true)}
          variant="ghost"
          disabled={!scopedApiBranchId}
        />
      </div>
      {!scopedApiBranchId && scopedBranchId > 0 && (
        <div
          style={{
            fontSize: 12,
            color: "#e11d48",
            marginTop: -8,
          }}
        >
          {branchName(scopedBranchId)}'s backend id couldn't be resolved, so
          shifts can't be loaded or edited for it right now. Try reselecting the
          branch, or refresh the dashboard.
        </div>
      )}

      <div
        style={{
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: 16,
          padding: 16,
          boxShadow:
            "0 1px 3px rgba(15,45,74,0.06),0 1px 2px rgba(15,45,74,0.04)",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(5, minmax(150px, 1fr)) auto",
            gap: 12,
            alignItems: "end",
          }}
        >
          <div>
            <label style={labelStyle}>Allocation Level</label>
            <ModernSelect
              value={scope}
              onChange={(value) => {
                setScope(value as "branch" | "department" | "individual");
                setSelectedDepartment("all");
                setSelectedStaffId("");
              }}
              options={[
                ...(isGlobalDashboard
                  ? [{ value: "branch", label: "Branch Wise" }]
                  : []),
                {
                  value: "department",
                  label: `${peopleModel.groupLabel} Wise`,
                },
                { value: "individual", label: "Individual" },
              ]}
              ariaLabel="Select allocation level"
              width="100%"
            />
          </div>

          <div>
            <label style={labelStyle}>Branch</label>
            {isGlobalDashboard ? (
              <ModernSelect
                value={String(selectedBranchId)}
                onChange={(value) => {
                  setSelectedBranchId(Number(value));
                  setSelectedDepartment("all");
                  setSelectedStaffId("");
                }}
                options={visibleBranches.map((branch) => ({
                  value: String(branch.id),
                  label: branch.name,
                }))}
                ariaLabel="Select branch"
                width="100%"
              />
            ) : (
              <div
                style={{
                  ...inputStyle,
                  display: "flex",
                  alignItems: "center",
                  background: T.teal50,
                  color: T.teal600,
                }}
              >
                {branchName(scopedBranchId)}
              </div>
            )}
          </div>

          <div>
            <label style={labelStyle}>{peopleModel.groupLabel}</label>
            <ModernSelect
              value={selectedDepartment}
              disabled={scope === "branch"}
              onChange={(value) => {
                setSelectedDepartment(value);
                setSelectedStaffId("");
              }}
              options={[
                {
                  value: "all",
                  label:
                    scope === "department"
                      ? `Select ${peopleModel.groupLabel}`
                      : peopleModel.groupFilterAllLabel,
                },
                ...departmentOptions.map((department) => ({
                  value: department,
                  label: department,
                })),
              ]}
              ariaLabel={`Select ${peopleModel.groupLabel.toLowerCase()}`}
              width="100%"
            />
          </div>

          <div>
            <label style={labelStyle}>Employee</label>
            <ModernSelect
              value={selectedStaffId}
              disabled={scope !== "individual"}
              onChange={(value) => setSelectedStaffId(value)}
              options={[
                { value: "", label: `Select ${peopleModel.personSingular}` },
                ...individualOptions.map((member) => ({
                  value: member.id,
                  label: `${member.name} · ${member.department}`,
                })),
              ]}
              ariaLabel={`Select ${peopleModel.personSingular.toLowerCase()}`}
              width="100%"
            />
          </div>

          <div>
            <label style={labelStyle}>Shift</label>
            <ModernSelect
              value={selectedShiftId}
              disabled={isLoadingShifts || liveShifts.length === 0}
              onChange={(value) => setSelectedShiftId(value)}
              options={
                liveShifts.length > 0
                  ? liveShifts.map((shift) => ({
                      value: shift.id,
                      label: `${shift.name} · ${shift.check_in_time}${
                        shift.check_out_time ? `–${shift.check_out_time}` : ""
                      }`,
                    }))
                  : [
                      {
                        value: "",
                        label: isLoadingShifts
                          ? "Loading shifts…"
                          : "No shifts configured for this branch",
                      },
                    ]
              }
              ariaLabel="Select shift"
              width="100%"
            />
          </div>

          <JellyButton
            type="button"
            variant="primary"
            disabled={!canApply}
            onClick={() => void handleApply()}
          >
            {isApplying ? "Applying…" : "Apply Shift"}
          </JellyButton>
        </div>

        <div
          style={{
            marginTop: 12,
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            alignItems: "center",
          }}
        >
          {scope === "individual" ? (
            <JellyButton
              type="button"
              variant="secondary"
              disabled={!selectedMember}
              onClick={() => setShowOverridePanel((v) => !v)}
              style={{ minWidth: 180, padding: "12px 16px", fontSize: 13 }}
            >
              {showOverridePanel ? "Hide override" : "Override timing"}
            </JellyButton>
          ) : (
            <div style={{ fontSize: 12, color: T.muted }}>
              Select an individual to create a manual attendance override.
            </div>
          )}

          {selectedMember && (
            <div style={{ fontSize: 12, color: T.muted }}>
              Override target: <strong>{selectedMember.name}</strong>
            </div>
          )}
        </div>

        {showOverridePanel && selectedMember && (
          <StaffAttendanceOverridesPanel member={selectedMember} />
        )}

        {liveShifts.length === 0 && !isLoadingShifts && (
          <div style={{ marginTop: 10, fontSize: 12, color: T.muted }}>
            No shifts exist for {branchName(scopedBranchId)} yet. Add one under{" "}
            <strong>Shift Timings</strong> before allocating — including a
            dedicated shift for anyone who needs their own custom timing.
          </div>
        )}

        {shiftsError && (
          <div style={{ marginTop: 10, fontSize: 12, color: "#e11d48" }}>
            {shiftsError}
          </div>
        )}

        {applyError && (
          <div style={{ marginTop: 10, fontSize: 12, color: "#e11d48" }}>
            {applyError}
          </div>
        )}

        <div
          style={{
            marginTop: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: T.muted,
          }}
        >
          <CalendarClock size={14} color={T.teal600} />
          {selectedShift ? (
            <>
              Selected:{" "}
              <strong style={{ color: T.head }}>{selectedShift.name}</strong>
              <span>·</span>
              <span>
                {selectedShift.check_in_time}
                {selectedShift.check_out_time
                  ? `–${selectedShift.check_out_time}`
                  : ""}
              </span>
              <span>·</span>
            </>
          ) : (
            <span>No shift selected ·</span>
          )}
          <span>{targetCount} staff will be affected</span>
        </div>
      </div>

      <div
        style={{
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: 16,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "14px 18px",
            borderBottom: `1px solid ${T.border}`,
            fontSize: 13,
            fontWeight: 800,
            color: T.head,
          }}
        >
          Current Shift Summary
        </div>
        {staffRows.slice(0, 12).map((member) => (
          <div
            key={member.id}
            style={{
              display: "grid",
              gridTemplateColumns: "1.5fr 1fr 1fr 1fr",
              gap: 12,
              padding: "11px 18px",
              borderBottom: `1px solid ${T.teal50}`,
              alignItems: "center",
              fontSize: 12,
            }}
          >
            <strong style={{ color: T.head }}>{member.name}</strong>
            <span style={{ color: T.muted }}>
              {branchName(member.branchId)}
            </span>
            <span style={{ color: T.muted }}>{member.department}</span>
            <span style={{ color: T.teal600, fontWeight: 800 }}>
              {shiftText(member)}
            </span>
          </div>
        ))}
      </div>

      {isShiftTimingsOpen && organizationId && scopedApiBranchId && (
        <ShiftTimingsModal
          branchId={scopedApiBranchId}
          organizationId={organizationId}
          peopleType={peopleModel.peopleType}
          branchTimezone={scopedBranchTimezone}
          onClose={() => setIsShiftTimingsOpen(false)}
          onSaved={reloadShifts}
        />
      )}
    </div>
  );
};
