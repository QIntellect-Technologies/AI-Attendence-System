import React, {
  type FC,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  confirmDialog,
  toastError,
  toastSuccess,
} from "../../../utils/notifications";
import { CalendarClock, Check, Pencil, TimerReset, X } from "lucide-react";
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
import { staffAvatarUrl, staffInitial } from "../utils/staffMember";
import { useAuthenticatedImageUrl } from "../../../hooks/useAuthenticatedImageUrl";
import { formatShiftWindow } from "../utils/shiftOverlap";
import { ShiftTimingsModal } from "./ShiftTimingsModal";
import { BranchDefaultShiftCard } from "./BranchDefaultShiftCard";
import { FastPagination } from "../../../components/common/FastPagination";
import "./ShiftAllocationTab.css";

// ─── Summary table (same visual language as the Staff Member Directory) ──────

const SummaryRow: FC<{
  member: StaffMember;
  showBranch: boolean;
  branchLabel: string;
  selectable: boolean;
  selected: boolean;
  onSelect: () => void;
  gridTemplateColumns: string;
  shifts: ShiftRecord[];
  editing: boolean;
  editingShiftId: string;
  saving: boolean;
  onEdit: () => void;
  onShiftChange: (shiftId: string) => void;
  onSave: () => void;
  onCancel: () => void;
}> = ({
  member,
  showBranch,
  branchLabel,
  selectable,
  selected,
  onSelect,
  gridTemplateColumns,
  shifts,
  editing,
  editingShiftId,
  saving,
  onEdit,
  onShiftChange,
  onSave,
  onCancel,
}) => {
    const [hov, setHov] = useState(false);
    const avatarUrl = useAuthenticatedImageUrl(staffAvatarUrl(member));
    const cell: React.CSSProperties = {
      fontSize: 12,
      color: T.head,
      fontWeight: 500,
      whiteSpace: "nowrap",
      paddingLeft: 4,
      minWidth: 0,
      overflow: "hidden",
      textOverflow: "ellipsis",
    };

    return (
      <div
        className="shift-allocation-tab__summary-row"
        onMouseEnter={() => setHov(true)}
        onMouseLeave={() => setHov(false)}
        onClick={selectable ? onSelect : undefined}
        style={{
          display: "grid",
          gridTemplateColumns,
          minWidth: 900,
          width: "100%",
          boxSizing: "border-box",
          gap: 12,
          padding: "11px 16px",
          alignItems: "center",
          background: selected ? T.teal50 : hov && selectable ? "#fafcfc" : "transparent",
          borderBottom: `1px solid ${T.teal50}`,
          boxShadow: selected ? `inset 3px 0 0 ${T.teal600}` : "none",
          cursor: selectable ? "pointer" : "default",
          transition: "background .1s",
        }}
      >
        <div style={cell}>
          <span
            style={{
              display: "inline-block",
              padding: "2px 7px",
              borderRadius: 6,
              background: "#f1f5f9",
              border: "1px solid #e2e8f0",
              color: "#334155",
              fontSize: 11,
              fontFamily: "'DM Mono', monospace, sans-serif",
              fontWeight: 700,
            }}
          >
            {member.personCode ||
              member.registrationNumber ||
              member.employeeId ||
              "—"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              background: "linear-gradient(135deg, #118d97, #173f67)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 800,
              color: "#fff",
              flexShrink: 0,
              overflow: "hidden",
              boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
            }}
          >
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={member.name}
                style={{
                  width: "100%",
                  height: "100%",
                  borderRadius: "50%",
                  objectFit: "cover",
                }}
              />
            ) : (
              staffInitial(member)
            )}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#102a3f" }}>
              {member.name}
            </div>
          </div>
        </div>
        {showBranch && (
          <div style={{ ...cell, color: T.navy600, fontWeight: 700 }}>
            {branchLabel}
          </div>
        )}
        <div style={cell}>{member.department || "—"}</div>
        <div style={cell}>
          {member.designationName || member.role || member.position || "—"}
        </div>
        <div
          onClick={editing ? (event) => event.stopPropagation() : undefined}
          style={{ ...cell, overflow: "visible" }}
        >
          {editing ? (
            <ModernSelect
              value={editingShiftId}
              onChange={onShiftChange}
              options={[
                { value: "", label: "Select shift" },
                ...shifts.map((shift) => ({
                  value: shift.id,
                  label: `${shift.name} · ${shift.check_in_time}${shift.check_out_time ? `–${shift.check_out_time}` : ""}`,
                })),
              ]}
              ariaLabel={`Select shift for ${member.name}`}
              disabled={saving || shifts.length === 0}
              width="100%"
            />
          ) : (
            shiftText(member)
          )}
        </div>
        <div
          onClick={(event) => event.stopPropagation()}
          style={{ display: "flex", justifyContent: "flex-start", gap: 6, paddingLeft: 4 }}
        >
          {editing ? (
            <>
              <button
                type="button"
                onClick={onSave}
                disabled={saving || !editingShiftId}
                aria-label={`Save shift for ${member.name}`}
                title="Save shift"
                style={rowActionStyle}
              >
                <Check size={15} />
                <span>Save</span>
              </button>
              <button
                type="button"
                onClick={onCancel}
                disabled={saving}
                aria-label={`Cancel shift edit for ${member.name}`}
                title="Cancel"
                style={rowActionStyle}
              >
                <X size={15} />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onEdit}
              aria-label={`Edit shift for ${member.name}`}
              title="Edit shift"
              style={rowActionStyle}
            >
              <Pencil size={15} />
              <span>Edit</span>
            </button>
          )}
        </div>
      </div>
    );
  };

const rowActionStyle: React.CSSProperties = {
  minWidth: 34,
  height: 30,
  padding: "0 8px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  border: `1px solid ${T.border}`,
  borderRadius: 8,
  background: T.card,
  color: T.teal600,
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 11,
  fontWeight: 700,
};

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
    apiBranchId: string;
    department?: string;
    staffId?: string;
    shiftId: string;
  }) => Promise<number>;
  onStaffRefresh?: () => void;
  /** Staff id to pre-select for an individual shift override. */
  overrideStaffId?: string | number | null;
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
  onStaffRefresh,
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
    const [editingStaffId, setEditingStaffId] = useState<string | null>(null);
    const [editingShiftId, setEditingShiftId] = useState("");
    const [savingStaffId, setSavingStaffId] = useState<string | null>(null);

    useEffect(() => {
      if (overrideStaffId == null || overrideStaffId === "") return;
      const target = staffRows.find(
        (m) => String(m.id) === String(overrideStaffId),
      );
      setScope("individual");
      setSelectedStaffId(String(overrideStaffId));
      if (target?.branchId && isGlobalDashboard) {
        setSelectedBranchId(target.branchId);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [overrideStaffId]);

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
      return [...list]
        .sort((a, b) => a.name.localeCompare(b.name));
    }, [branchStaff, selectedDepartment]);

    const selectedShift = liveShifts.find(
      (shift) => shift.id === selectedShiftId,
    );

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
      !!scopedApiBranchId &&
      !!selectedShiftId &&
      !isApplying &&
      (scope === "branch" ||
        (scope === "department" && selectedDepartment !== "all") ||
        (scope === "individual" && selectedStaffId));

    // Who among the targets already holds a DIFFERENT shift. A person holds
    // exactly one shift (client_staff.shift_id_ref), so applying a second one
    // replaces the first — it does not add to it. That replacement used to be
    // silent: both applies reported success and nothing said which shift the
    // person ended up on, which is how one employee appeared to hold both a
    // Morning and an Evening shift at once (Ticket #20).
    const replacements = useMemo(() => {
      const targets =
        scope === "individual"
          ? branchStaff.filter((member) => member.id === selectedStaffId)
          : scope === "department"
            ? branchStaff.filter(
              (member) =>
                selectedDepartment !== "all" &&
                member.department === selectedDepartment,
            )
            : branchStaff;

      return targets.filter((member) => {
        const current = String((member as any).shiftIdRef ?? "");
        return current && current !== selectedShiftId;
      });
    }, [
      branchStaff,
      scope,
      selectedDepartment,
      selectedStaffId,
      selectedShiftId,
    ]);

    // Use the same branch/department selection for the summary and allocation.
    const summarySource = useMemo(
      () =>
        scope === "individual"
          ? branchStaff
            .filter(
              (member) =>
                selectedDepartment === "all" ||
                member.department === selectedDepartment,
            )
          : selectedDepartment === "all"
            ? branchStaff
            : branchStaff.filter(
              (member) => member.department === selectedDepartment,
            ),
      [branchStaff, scope, selectedDepartment],
    );
    const summaryRows = summarySource;

    const [shiftPage, setShiftPage] = useState(1);
    const [shiftPageSize, setShiftPageSize] = useState(25);

    useEffect(() => {
      setShiftPage(1);
    }, [scopedBranchId, selectedDepartment, scope]);

    const paginatedSummaryRows = useMemo(
      () =>
        summaryRows.slice(
          (shiftPage - 1) * shiftPageSize,
          shiftPage * shiftPageSize,
        ),
      [summaryRows, shiftPage, shiftPageSize],
    );
    const summaryHeaders = [
      "Staff ID",
      "Name",
      ...(isGlobalDashboard ? ["Branch"] : []),
      peopleModel.groupLabel,
      "Designation",
      "Shift",
      "Actions",
    ];
    const summaryGridTemplate = isGlobalDashboard
      ? "minmax(100px, 0.8fr) minmax(180px, 1.4fr) minmax(110px, 1fr) minmax(110px, 1fr) minmax(110px, 1fr) minmax(160px, 1.2fr) minmax(112px, 0.7fr)"
      : "minmax(100px, 0.8fr) minmax(180px, 1.4fr) minmax(110px, 1fr) minmax(110px, 1fr) minmax(160px, 1.2fr) minmax(112px, 0.7fr)";

    const saveRowShift = async (member: StaffMember) => {
      if (!scopedApiBranchId || !editingShiftId) return;
      const currentShiftId = String(member.shiftIdRef ?? "");
      if (currentShiftId && currentShiftId !== editingShiftId) {
        const confirmation = await confirmDialog({
          title: "Replace current shift?",
          text: `Applying ${liveShifts.find((shift) => shift.id === editingShiftId)?.name ?? "the selected shift"} will replace ${shiftText(member)} for ${member.name}. Continue?`,
          confirmButtonText: "Save shift",
        });
        if (!confirmation.isConfirmed) return;
      }

      setSavingStaffId(member.id);
      try {
        const assignedCount = await onApplyShift({
          scope: "individual",
          branchId: member.branchId,
          apiBranchId: scopedApiBranchId,
          staffId: member.id,
          shiftId: editingShiftId,
        });
        toastSuccess(`Shift saved for ${assignedCount} staff member.`);
        setEditingStaffId(null);
        setEditingShiftId("");
      } catch (error) {
        toastError(
          error instanceof Error ? error.message : "Failed to save shift.",
        );
      } finally {
        setSavingStaffId(null);
      }
    };

    const handleApply = async () => {
      if (!canApply) return;
      if (!scopedApiBranchId) {
        toastError("The selected branch could not be resolved.");
        return;
      }

      // One confirm for the whole apply, not one per person — a branch-wide
      // apply can target hundreds.
      if (replacements.length > 0 && selectedShift) {
        const incoming = `${selectedShift.name} (${formatShiftWindow(selectedShift)})`;
        const summary =
          replacements.length === 1
            ? `${replacements[0].name} is currently on ${shiftText(replacements[0])}.`
            : `${replacements.length} people are currently on a different shift.`;

        const confirmation = await confirmDialog({
          title: "Replace current shift?",
          text: `${summary}\n\nApplying ${incoming} replaces their current shift. Nobody holds two shifts at once. Continue?`,
          confirmButtonText: "Apply shift",
        });
        if (!confirmation.isConfirmed) {
          return;
        }
      }

      setIsApplying(true);
      setApplyError(null);
      try {
        const appliedCount = await onApplyShift({
          scope,
          branchId: scopedBranchId,
          apiBranchId: scopedApiBranchId,
          department:
            selectedDepartment === "all" ? undefined : selectedDepartment,
          staffId: selectedStaffId || undefined,
          shiftId: selectedShiftId,
        });
        toastSuccess(
          selectedShift
            ? `${selectedShift.name} (${formatShiftWindow(selectedShift)}) applied to ${appliedCount} ${appliedCount === 1
              ? peopleModel.personSingular.toLowerCase()
              : peopleModel.personPlural.toLowerCase()
            }.`
            : "Shift applied successfully.",
        );
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
      <div className="shift-allocation-tab" style={{ display: "grid", gap: 16 }}>
        <div
          className="shift-allocation-tab__page-header"
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
        <BranchDefaultShiftCard
          apiBranchId={scopedApiBranchId}
          organizationId={organizationId}
          peopleType={peopleModel.peopleType}
          personPlural={peopleModel.personPlural.toLowerCase()}
          shifts={liveShifts}
          isLoadingShifts={isLoadingShifts}
          onForceOverrideComplete={onStaffRefresh}
        />

        <div
          className="shift-allocation-tab__allocation-card"
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
            className="shift-allocation-tab__form"
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
                onChange={(value) => {
                  setSelectedStaffId(value);
                  const member = branchStaff.find((m) => m.id === value);
                  if (member?.department && selectedDepartment === "all") {
                    setSelectedDepartment(member.department);
                  }
                }}
                options={[
                  { value: "", label: `Select ${peopleModel.personSingular}` },
                  ...individualOptions.map((member) => ({
                    value: member.id,
                    label: `${member.name} · ${member.department}`,
                  })),
                ]}
                ariaLabel={`Select ${peopleModel.personSingular.toLowerCase()}`}
                searchable={scope === "individual"}
                searchPlaceholder={`Search ${peopleModel.personPlural.toLowerCase()}...`}
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
                      label: `${shift.name} · ${shift.check_in_time}${shift.check_out_time ? `–${shift.check_out_time}` : ""
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

            <div className="shift-allocation-tab__apply-button">
              <JellyButton
                type="button"
                variant="primary"
                disabled={!canApply}
                onClick={() => void handleApply()}
              >
                {isApplying ? "Applying…" : "Apply Shift"}
              </JellyButton>
            </div>
          </div>

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
            className="shift-allocation-tab__selection-summary"
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
          className="shift-allocation-tab__summary-card"
          style={{
            background: T.card,
            border: `1px solid ${T.border}`,
            borderRadius: 16,
            overflow: "hidden",
          }}
        >
          <div
            className="shift-allocation-tab__summary-header"
            style={{
              padding: "14px 18px",
              borderBottom: `1px solid ${T.border}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              fontSize: 13,
              fontWeight: 800,
              color: T.head,
            }}
          >
            <span>Current Shift Summary</span>
            {summaryRows.length > 0 && (
              <span style={{ fontSize: 11, fontWeight: 600, color: T.muted }}>
                {summaryRows.length}{" "}
                {peopleModel.personPlural.toLowerCase()}
              </span>
            )}
          </div>

          {summaryRows.length === 0 ? (
            <div
              style={{
                padding: "28px 18px",
                textAlign: "center",
                fontSize: 12,
                color: T.muted,
              }}
            >
              No {peopleModel.personPlural.toLowerCase()} match your search.
            </div>
          ) : (
            <div
              className="staff-directory-table-scroll shift-allocation-tab__table-scroll"
              style={{ overflowX: "auto", overflowY: "hidden", minWidth: 0 }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: summaryGridTemplate,
                  minWidth: 900,
                  width: "100%",
                  boxSizing: "border-box",
                  gap: 12,
                  padding: "11px 16px",
                  background: "#f8fafc",
                  borderBottom: "1px solid #e2e8f0",
                }}
              >
                {summaryHeaders.map((label) => (
                  <div
                    key={label}
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: T.muted,
                      textTransform: "uppercase",
                      letterSpacing: ".07em",
                      paddingLeft: 4,
                      userSelect: "none",
                    }}
                  >
                    {label}
                  </div>
                ))}
              </div>

              {paginatedSummaryRows.map((member) => (
                <SummaryRow
                  key={member.id}
                  member={member}
                  showBranch={isGlobalDashboard}
                  branchLabel={branchName(member.branchId)}
                  gridTemplateColumns={summaryGridTemplate}
                  shifts={liveShifts}
                  editing={editingStaffId === member.id}
                  editingShiftId={editingShiftId}
                  saving={savingStaffId === member.id}
                  onEdit={() => {
                    setEditingStaffId(member.id);
                    setEditingShiftId(String(member.shiftIdRef ?? ""));
                  }}
                  onShiftChange={setEditingShiftId}
                  onSave={() => void saveRowShift(member)}
                  onCancel={() => {
                    setEditingStaffId(null);
                    setEditingShiftId("");
                  }}
                  selectable={scope === "individual"}
                  selected={scope === "individual" && member.id === selectedStaffId}
                  onSelect={() => {
                    if (isGlobalDashboard) setSelectedBranchId(member.branchId);
                    if (member.department && (selectedDepartment === "all" || member.department !== selectedDepartment)) {
                      setSelectedDepartment(member.department);
                    }
                    setSelectedStaffId(member.id);
                  }}
                />
              ))}
            </div>
          )}
          {summaryRows.length > 0 && (
            <div
              className="shift-allocation-tab__pagination"
              style={{ padding: "0 16px 8px 16px" }}
            >
              <FastPagination
                page={shiftPage}
                pageSize={shiftPageSize}
                total={summaryRows.length}
                onPageChange={setShiftPage}
                onPageSizeChange={(s) => {
                  setShiftPageSize(s);
                  setShiftPage(1);
                }}
              />
            </div>
          )}
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