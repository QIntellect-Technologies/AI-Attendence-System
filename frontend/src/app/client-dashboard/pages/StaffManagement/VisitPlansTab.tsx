/**
 * VisitPlansTab.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Client Dashboard admin UI for Scenario 2 (Visit Plan / Beat Plan). Sits
 * alongside the existing "Shift Allocation" / "Archived" tabs in
 * StaffManagement.tsx — see that file's `tabItems` / `activeTab` rendering
 * for how this plugs in.
 *
 * Two-pane layout:
 *   Left  — roster of field staff for the selected branch + date, each row
 *           showing whether a plan exists yet and a quick completed/total
 *           badge.
 *   Right — the selected staff member's plan for that date: add / edit /
 *           delete stops, and a read-only list of that day's logged visits.
 *
 * Talks only to the admin-side routes (client_visit_plans_routes.py via
 * staffApi.ts) — never touches attendance. A staff member can have zero
 * visits logged and still be marked Present off their normal
 * check-in/check-out; this tab is purely the "activity layer."
 *
 * Compliance (completed / pending / unplanned) is computed here on the
 * client from the raw { plan, stops, visits } response — the backend
 * deliberately does not compute it (see support_db_visits.get_plan_raw's
 * docstring). computeVisitPlanSummary in staffApi.ts is the mirror of
 * visit_plan_service.dart's on-device logic used by the mobile app — keep
 * the two in sync if the stop/visit shape ever changes.
 *
 * NOTE on "Failed to create visit plan": that message is the generic
 * fallback support_db_visits.py raises whenever the underlying insert
 * throws for ANY reason — most commonly because the visit_plans /
 * visit_plan_stops / visits tables don't exist yet in Supabase. See
 * visit_plans_migration.sql. This component surfaces whatever text the
 * backend actually sent (staffJson already unwraps body.error/message),
 * so once the tables exist you'll see the real reason here if something
 * else goes wrong, instead of just the generic string.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  MapPin,
  Plus,
  Trash2,
  Edit2,
  X,
  Save,
  CheckCircle,
  Clock,
  Loader2,
  AlertTriangle,
  Navigation,
  ListChecks,
  ChevronLeft,
  ChevronRight,
  History,
  CalendarDays,
} from "lucide-react";
import { toast } from "react-toastify";
import {
  toastSuccess,
  toastError,
  confirmDialog,
} from "../../utils/notifications";
import { T } from "../../components/ui/theme";
import JellyButton from "../../components/ui/JellyButton";
import ModernSelect from "../../components/ui/ModernSelect";
import {
  resolveApiBranchId,
  type BranchIdentity,
} from "../../utils/tenantScope";
import {
  getStaffVisitPlan,
  createStaffVisitPlan,
  addVisitPlanStop,
  updateVisitPlanStop,
  deleteVisitPlanStop,
  computeVisitPlanSummary,
  computeStopVerification,
  getStaffVisitPlansHistory,
  type VisitPlanRaw,
  type VisitPlanStopRecord,
  type VisitPlanDay,
} from "./api/staffApi";

interface RosterStaff {
  id: string;
  name: string;
  branchId: number;
  branchName: string;
  staffType: string;
}

interface OrgBranchLite extends BranchIdentity {
  id: number | string;
  name: string;
}

interface VisitPlansTabProps {
  staffRows: RosterStaff[];
  visibleBranches: OrgBranchLite[];
  organizationId: number | string | null;
  effectiveBranchId?: number | string;
  currentAdminId?: string | null;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0][0]!.toUpperCase();
  return (parts[0][0]! + parts[parts.length - 1][0]!).toUpperCase();
}

// Small stable set of avatar gradients keyed off name hash, so the same
// person always gets the same color without needing a server field for it.
const AVATAR_GRADIENTS = [
  ["#0f2d4a", "#155e75"],
  ["#0d9488", "#0f766e"],
  ["#7c3aed", "#5b21b6"],
  ["#b45309", "#92400e"],
  ["#be123c", "#9f1239"],
];
function avatarGradient(name: string): [string, string] {
  let hash = 0;
  for (let i = 0; i < name.length; i++)
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length] as [string, string];
}

const emptyStopForm = {
  locationLabel: "",
  lat: "",
  lng: "",
  radiusMeters: "150",
  purpose: "",
  windowStart: "",
  windowEnd: "",
};

type StopFormState = typeof emptyStopForm;

// ─── Shared bits ────────────────────────────────────────────────────────────

const Spinner: React.FC<{ size?: number; color?: string }> = ({
  size = 14,
  color = T.muted,
}) => (
  <Loader2
    size={size}
    color={color}
    style={{ animation: "vp-spin 0.8s linear infinite" }}
  />
);

const ErrorBanner: React.FC<{ message: string }> = ({ message }) => (
  <div
    style={{
      display: "flex",
      alignItems: "flex-start",
      gap: 8,
      background: "#fff1f2",
      border: "1px solid #fecdd3",
      color: "#e11d48",
      borderRadius: 10,
      padding: "10px 12px",
      fontSize: 12.5,
      fontWeight: 600,
      lineHeight: 1.4,
    }}
  >
    <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
    <span>{message}</span>
  </div>
);

const Avatar: React.FC<{ name: string; size?: number }> = ({
  name,
  size = 34,
}) => {
  const [from, to] = avatarGradient(name);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: `linear-gradient(135deg, ${from}, ${to})`,
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.38,
        fontWeight: 800,
        flexShrink: 0,
      }}
    >
      {initialsOf(name)}
    </div>
  );
};

// ─── Main tab ───────────────────────────────────────────────────────────────

export interface VisitPlansTabHandle {
  /** Reloads the roster's plan badges AND the currently open staff
   * member's detail panel. Exposed so the shared header "Refresh" button
   * in StaffManagement.tsx can refresh this tab the same way it already
   * refreshes Staff Directory/Shift Allocation via refreshStaff() and
   * Archived Staff via refreshArchivedStaff() -- this tab has its own
   * data source (visit_plans/visit_plan_stops/visits, not the staff
   * table), so it needed its own hook into that button rather than
   * piggybacking on refreshStaff. */
  refresh: () => Promise<void>;
}

const VisitPlansTab = React.forwardRef<VisitPlansTabHandle, VisitPlansTabProps>(
  (
    {
      staffRows,
      visibleBranches,
      organizationId,
      effectiveBranchId,
      currentAdminId,
    },
    ref,
  ) => {
    // Bumped on every imperative refresh() call -- included in
    // PlanDetailPanel's `key` below so a remount forces it to re-fetch,
    // rather than plumbing a second ref down into that child component.
    const [refreshToken, setRefreshToken] = useState(0);

    // Inject the spinner keyframe once — this component may render before
    // any other part of the app has defined one.
    useEffect(() => {
      if (document.getElementById("vp-spin-keyframes")) return;
      const style = document.createElement("style");
      style.id = "vp-spin-keyframes";
      style.textContent =
        "@keyframes vp-spin { to { transform: rotate(360deg); } }";
      document.head.appendChild(style);
    }, []);

    const fieldStaff = useMemo(
      () => staffRows.filter((s) => s.staffType === "field"),
      [staffRows],
    );

    const [branchId, setBranchId] = useState<string>(
      effectiveBranchId !== undefined ? String(effectiveBranchId) : "all",
    );
    const [planDate, setPlanDate] = useState<string>(todayIso());
    const [selectedStaffId, setSelectedStaffId] = useState<string | null>(null);

    const rosterForBranch = useMemo(() => {
      if (branchId === "all") return fieldStaff;
      return fieldStaff.filter((s) => String(s.branchId) === branchId);
    }, [fieldStaff, branchId]);

    const [rosterPlans, setRosterPlans] = useState<
      Record<string, VisitPlanRaw>
    >({});
    const [rosterLoading, setRosterLoading] = useState(false);
    const [rosterError, setRosterError] = useState<string | null>(null);

    const loadRoster = useCallback(async () => {
      if (
        organizationId === null ||
        organizationId === undefined ||
        rosterForBranch.length === 0
      ) {
        setRosterPlans({});
        return;
      }
      const orgId = organizationId; // narrowed non-null const for the closure below
      setRosterLoading(true);
      setRosterError(null);
      try {
        const entries = await Promise.all(
          rosterForBranch.map(async (staff) => {
            try {
              const data = await getStaffVisitPlan(staff.id, orgId, planDate);
              return [staff.id, data] as const;
            } catch {
              return [staff.id, { plan: null, stops: [], visits: [] }] as const;
            }
          }),
        );
        setRosterPlans(Object.fromEntries(entries));
      } catch (e) {
        setRosterError(
          e instanceof Error ? e.message : "Could not load the roster.",
        );
      } finally {
        setRosterLoading(false);
      }
    }, [organizationId, rosterForBranch, planDate]);

    React.useImperativeHandle(
      ref,
      () => ({
        refresh: async () => {
          setRefreshToken((n) => n + 1);
          await loadRoster();
        },
      }),
      [loadRoster],
    );

    useEffect(() => {
      loadRoster();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [organizationId, branchId, planDate]);

    useEffect(() => {
      if (
        selectedStaffId &&
        !rosterForBranch.some((s) => s.id === selectedStaffId)
      ) {
        setSelectedStaffId(null);
      }
    }, [rosterForBranch, selectedStaffId]);

    const selectedStaff =
      rosterForBranch.find((s) => s.id === selectedStaffId) ?? null;

    // Roster-wide summary strip (mirrors the "Total / Active / ..." stat
    // cards used elsewhere in Staff Management, so this tab doesn't feel
    // visually orphaned from the rest of the module).
    const rosterStats = useMemo(() => {
      const withPlan = rosterForBranch.filter(
        (s) => rosterPlans[s.id]?.plan,
      ).length;
      let totalStops = 0;
      let totalCompleted = 0;
      rosterForBranch.forEach((s) => {
        const data = rosterPlans[s.id];
        if (!data) return;
        const summary = computeVisitPlanSummary(data.stops, data.visits);
        totalStops += summary.plannedTotal;
        totalCompleted += summary.completed;
      });
      return {
        totalStaff: rosterForBranch.length,
        withPlan,
        completionPct:
          totalStops > 0
            ? Math.round((totalCompleted / totalStops) * 100)
            : null,
      };
    }, [rosterForBranch, rosterPlans]);

    if (organizationId === null || organizationId === undefined) {
      return (
        <div
          style={{
            background: T.card,
            border: `1px dashed ${T.border}`,
            borderRadius: 14,
            padding: "40px 24px",
            textAlign: "center",
            color: T.muted,
            fontSize: 12.5,
          }}
        >
          Loading organization details…
        </div>
      );
    }

    return (
      <div>
        {/* ── Stat strip ───────────────────────────────────────────────── */}
        <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
          <StatCard
            label="Field Staff"
            value={rosterStats.totalStaff}
            color={T.navy600}
          />
          <StatCard
            label="Plans Created Today"
            value={rosterStats.withPlan}
            color={T.teal600}
          />
          <StatCard
            label="Overall Completion"
            value={
              rosterStats.completionPct !== null
                ? `${rosterStats.completionPct}%`
                : "—"
            }
            color={T.amber}
          />
        </div>

        <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
          {/* ── Left: roster ─────────────────────────────────────────── */}
          <div
            style={{
              flex: "0 0 320px",
              background: T.card,
              border: `1px solid ${T.border}`,
              borderRadius: 14,
              overflow: "hidden",
              boxShadow:
                "0 1px 3px rgba(15,45,74,0.06),0 1px 2px rgba(15,45,74,0.04)",
            }}
          >
            <div
              style={{
                padding: "14px 16px",
                borderBottom: `1px solid ${T.border}`,
                display: "flex",
                flexDirection: "column",
                gap: 10,
                background: T.slate50,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 8,
                    background: T.teal100,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <MapPin size={13} color={T.teal600} />
                </div>
                <span style={{ fontSize: 13, fontWeight: 900, color: T.head }}>
                  Field Staff Roster
                </span>
              </div>
              <ModernSelect
                value={branchId}
                onChange={(value) => setBranchId(value)}
                options={[
                  { value: "all", label: "All branches" },
                  ...visibleBranches.map((b) => ({
                    value: String(b.id),
                    label: b.name,
                  })),
                ]}
                ariaLabel="Filter by branch"
                width="100%"
              />
              <input
                type="date"
                value={planDate}
                onChange={(e) => setPlanDate(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: `1px solid ${T.border}`,
                  fontSize: 12.5,
                  color: T.head,
                  background: T.card,
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div style={{ maxHeight: 540, overflowY: "auto" }}>
              {rosterError && (
                <div style={{ padding: 14 }}>
                  <ErrorBanner message={rosterError} />
                </div>
              )}
              {!rosterError && rosterForBranch.length === 0 && (
                <div style={{ padding: "28px 16px", textAlign: "center" }}>
                  <div style={{ color: T.muted, fontSize: 12.5 }}>
                    No field staff in this branch yet.
                  </div>
                </div>
              )}
              {rosterForBranch.map((staff) => {
                const data = rosterPlans[staff.id];
                const summary = data
                  ? computeVisitPlanSummary(data.stops, data.visits)
                  : null;
                const isActive = staff.id === selectedStaffId;
                return (
                  <button
                    key={staff.id}
                    type="button"
                    onClick={() => setSelectedStaffId(staff.id)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: "11px 16px",
                      borderBottom: `1px solid ${T.border}`,
                      cursor: "pointer",
                      background: isActive ? T.teal100 : "transparent",
                      border: "none",
                      borderBottomColor: T.border,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      transition: "background 0.12s ease",
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive)
                        e.currentTarget.style.background = T.slate50;
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive)
                        e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        minWidth: 0,
                      }}
                    >
                      <Avatar name={staff.name} />
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 12.5,
                            fontWeight: 700,
                            color: T.head,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {staff.name}
                        </div>
                        <div style={{ fontSize: 11, color: T.muted }}>
                          {staff.branchName}
                        </div>
                      </div>
                    </div>
                    {!data && rosterLoading ? (
                      <Spinner size={13} />
                    ) : !data?.plan ? (
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 700,
                          color: T.muted,
                          background: T.slate50,
                          border: `1px solid ${T.border}`,
                          padding: "3px 8px",
                          borderRadius: 999,
                          whiteSpace: "nowrap",
                        }}
                      >
                        No plan
                      </span>
                    ) : (
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 800,
                          color: T.teal600,
                          background: T.teal100,
                          padding: "3px 8px",
                          borderRadius: 999,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {summary?.completed ?? 0}/{summary?.plannedTotal ?? 0}
                        {summary && summary.unplanned > 0
                          ? ` +${summary.unplanned}`
                          : ""}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Right: plan detail ───────────────────────────────────── */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {selectedStaff ? (
              <PlanDetailPanel
                key={`${selectedStaff.id}:${planDate}:${refreshToken}`}
                staff={selectedStaff}
                organizationId={organizationId}
                visibleBranches={visibleBranches}
                planDate={planDate}
                currentAdminId={currentAdminId}
                onPlanChanged={loadRoster}
              />
            ) : (
              <div
                style={{
                  background: T.card,
                  border: `1px dashed ${T.border}`,
                  borderRadius: 14,
                  padding: "56px 24px",
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 12,
                    background: T.slate50,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    margin: "0 auto 14px",
                  }}
                >
                  <ListChecks size={20} color={T.muted} />
                </div>
                <div
                  style={{
                    fontSize: 13.5,
                    fontWeight: 700,
                    color: T.head,
                    marginBottom: 4,
                  }}
                >
                  Select a field staff member
                </div>
                <div style={{ color: T.muted, fontSize: 12.5 }}>
                  Choose someone from the roster to view or build their visit
                  plan for {planDate}.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  },
);

VisitPlansTab.displayName = "VisitPlansTab";

const StatCard: React.FC<{
  label: string;
  value: string | number;
  color: string;
}> = ({ label, value, color }) => (
  <div
    style={{
      flex: 1,
      background: T.card,
      border: `1px solid ${T.border}`,
      borderRadius: 12,
      padding: "12px 16px",
      boxShadow: "0 1px 3px rgba(15,45,74,0.06),0 1px 2px rgba(15,45,74,0.04)",
    }}
  >
    <div
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        color: T.muted,
        textTransform: "uppercase",
        letterSpacing: 0.4,
      }}
    >
      {label}
    </div>
    <div style={{ fontSize: 22, fontWeight: 800, color, marginTop: 4 }}>
      {value}
    </div>
  </div>
);

// ─── Plan detail panel ──────────────────────────────────────────────────────

const PlanDetailPanel: React.FC<{
  staff: RosterStaff;
  organizationId: number | string;
  visibleBranches: OrgBranchLite[];
  planDate: string;
  currentAdminId?: string | null;
  onPlanChanged: () => void;
}> = ({
  staff,
  organizationId,
  visibleBranches,
  planDate,
  currentAdminId,
  onPlanChanged,
}) => {
  const [data, setData] = useState<VisitPlanRaw | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creatingPlan, setCreatingPlan] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [showStopForm, setShowStopForm] = useState(false);
  const [editingStop, setEditingStop] = useState<VisitPlanStopRecord | null>(
    null,
  );
  const [stopForm, setStopForm] = useState<StopFormState>(emptyStopForm);
  const [savingStop, setSavingStop] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"day" | "history">("day");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getStaffVisitPlan(
        staff.id,
        organizationId,
        planDate,
      );
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load visit plan.");
    } finally {
      setLoading(false);
    }
  }, [staff.id, organizationId, planDate]);

  useEffect(() => {
    load();
  }, [load]);

  const summary = data
    ? computeVisitPlanSummary(data.stops, data.visits)
    : null;
  const completedStopIds = new Set(
    (data?.visits ?? [])
      .filter((v) => v.plan_stop_id)
      .map((v) => String(v.plan_stop_id)),
  );
  // Server-verified (not client-submitted) distance check -- see
  // computeStopVerification's docstring in staffApi.ts.
  const stopVerification = data
    ? computeStopVerification(data.stops, data.visits)
    : new Map();

  // staff.branchId is the UI ordinal (1, 2, 3…), never a valid branch_id
  // for a UUID tenant -- see support_db_visits.get_or_create_plan, which
  // inserts branch_id straight into visit_plans' UUID column. Resolve it
  // to the real backend branch id the same way every other branch-scoped
  // write in StaffManagement.tsx does, via the one canonical resolver.
  // Recomputed only when its inputs actually change, not on every render.
  const apiBranchId = useMemo(
    () => resolveApiBranchId(organizationId, staff.branchId, visibleBranches),
    [organizationId, staff.branchId, visibleBranches],
  );

  const handleCreatePlan = async () => {
    if (apiBranchId === null) {
      setCreateError(
        `Could not resolve ${staff.branchName || "this staff member's branch"} to a valid branch id. Refresh the page or re-select the branch, then try again.`,
      );
      return;
    }
    setCreatingPlan(true);
    setCreateError(null);
    try {
      await createStaffVisitPlan(staff.id, {
        organizationId,
        branchId: apiBranchId,
        date: planDate,
        createdBy: currentAdminId ?? null,
      });
      await load();
      onPlanChanged();
    } catch (e) {
      setCreateError(
        e instanceof Error
          ? e.message
          : "Failed to create visit plan. Check that the required database tables exist.",
      );
    } finally {
      setCreatingPlan(false);
    }
  };

  const openAddStop = () => {
    setEditingStop(null);
    setStopForm(emptyStopForm);
    setStopError(null);
    setShowStopForm(true);
  };

  const openEditStop = (stop: VisitPlanStopRecord) => {
    setEditingStop(stop);
    setStopForm({
      locationLabel: stop.location_label,
      lat: String(stop.lat),
      lng: String(stop.lng),
      radiusMeters: String(stop.radius_meters ?? 150),
      purpose: stop.purpose ?? "",
      windowStart: stop.window_start ?? "",
      windowEnd: stop.window_end ?? "",
    });
    setStopError(null);
    setShowStopForm(true);
  };

  const handleSaveStop = async () => {
    if (!data?.plan) return;
    const lat = Number(stopForm.lat);
    const lng = Number(stopForm.lng);
    if (!stopForm.locationLabel.trim()) {
      setStopError("Location label is required.");
      return;
    }
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      setStopError("Latitude and longitude must be valid numbers.");
      return;
    }
    setSavingStop(true);
    setStopError(null);
    try {
      if (editingStop) {
        await updateVisitPlanStop(editingStop.id, organizationId, {
          locationLabel: stopForm.locationLabel.trim(),
          lat,
          lng,
          radiusMeters: Number(stopForm.radiusMeters) || 150,
          purpose: stopForm.purpose.trim() || undefined,
          windowStart: stopForm.windowStart || null,
          windowEnd: stopForm.windowEnd || null,
        });
        toastSuccess("Stop updated.");
      } else {
        await addVisitPlanStop(data.plan.id, {
          organizationId,
          createdBy: currentAdminId ?? null,
          locationLabel: stopForm.locationLabel.trim(),
          lat,
          lng,
          radiusMeters: Number(stopForm.radiusMeters) || 150,
          purpose: stopForm.purpose.trim() || undefined,
          windowStart: stopForm.windowStart || null,
          windowEnd: stopForm.windowEnd || null,
        });
        toastSuccess("Stop added.");
      }
      setShowStopForm(false);
      await load();
      onPlanChanged();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to save stop.";
      setStopError(msg);
      toastError(msg);
    } finally {
      setSavingStop(false);
    }
  };

  const handleDeleteStop = async (stop: VisitPlanStopRecord) => {
    const result = await confirmDialog({
      title: `Remove \"${stop.location_label}\"?`,
      text: "This will remove the stop from the plan.",
      confirmButtonText: "Remove",
      cancelButtonText: "Cancel",
      icon: "warning",
    });
    if (!result.isConfirmed) return;
    try {
      await deleteVisitPlanStop(stop.id, organizationId);
      await load();
      onPlanChanged();
      toastSuccess("Stop removed.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to remove stop.";
      setError(msg);
      toastError(msg);
    }
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      setStopForm((f) => ({
        ...f,
        lat: pos.coords.latitude.toFixed(6),
        lng: pos.coords.longitude.toFixed(6),
      }));
    });
  };

  const closePanel = () => {
    setShowStopForm(false);
  };

  return (
    <div
      style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: 14,
        overflow: "hidden",
        boxShadow:
          "0 1px 3px rgba(15,45,74,0.06),0 1px 2px rgba(15,45,74,0.04)",
      }}
    >
      <div
        style={{
          padding: "16px 20px",
          borderBottom: `1px solid ${T.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 14,
          background: T.slate50,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            minWidth: 0,
          }}
        >
          <Avatar name={staff.name} size={38} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 900, color: T.head }}>
              {staff.name}
            </div>
            <div style={{ fontSize: 12, color: T.muted, marginTop: 2 }}>
              {planDate} ·{" "}
              {loading
                ? "Loading…"
                : summary
                  ? `${summary.completed} of ${summary.plannedTotal} stops completed${
                      summary.unplanned
                        ? `, +${summary.unplanned} unplanned`
                        : ""
                    }`
                  : "No plan yet"}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              display: "flex",
              border: `1px solid ${T.border}`,
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            <button
              type="button"
              onClick={() => setViewMode("day")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                fontSize: 11.5,
                fontWeight: 700,
                padding: "7px 10px",
                border: "none",
                cursor: "pointer",
                background: viewMode === "day" ? T.teal600 : T.card,
                color: viewMode === "day" ? "#fff" : T.muted,
              }}
            >
              <CalendarDays size={13} />
              Day
            </button>
            <button
              type="button"
              onClick={() => setViewMode("history")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                fontSize: 11.5,
                fontWeight: 700,
                padding: "7px 10px",
                border: "none",
                borderLeft: `1px solid ${T.border}`,
                cursor: "pointer",
                background: viewMode === "history" ? T.teal600 : T.card,
                color: viewMode === "history" ? "#fff" : T.muted,
              }}
            >
              <History size={13} />
              History
            </button>
          </div>
          {viewMode === "day" && data?.plan && (
            <JellyButton
              type="button"
              variant="primary"
              size="sm"
              leftIcon={<Plus size={13} />}
              onClick={openAddStop}
            >
              Add Stop
            </JellyButton>
          )}
        </div>
      </div>

      {viewMode === "history" ? (
        <StaffHistoryPanel staff={staff} organizationId={organizationId} />
      ) : (
        <div style={{ padding: 20 }}>
          {error && (
            <div style={{ marginBottom: 14 }}>
              <ErrorBanner message={error} />
            </div>
          )}

          {loading ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: T.muted,
                fontSize: 13,
                padding: "24px 0",
              }}
            >
              <Spinner />
              Loading plan…
            </div>
          ) : !data?.plan ? (
            <div style={{ textAlign: "center", padding: "32px 12px" }}>
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 12,
                  background: T.teal100,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 14px",
                }}
              >
                <MapPin size={22} color={T.teal600} />
              </div>
              <div
                style={{
                  fontSize: 13.5,
                  fontWeight: 700,
                  color: T.head,
                  marginBottom: 4,
                }}
              >
                No visit plan yet
              </div>
              <div style={{ color: T.muted, fontSize: 12.5, marginBottom: 16 }}>
                {staff.name} has no assigned stops for {planDate}.
              </div>
              {createError && (
                <div style={{ maxWidth: 420, margin: "0 auto 14px" }}>
                  <ErrorBanner message={createError} />
                </div>
              )}
              <JellyButton
                type="button"
                variant="primary"
                size="sm"
                leftIcon={<Plus size={13} />}
                loading={creatingPlan}
                onClick={handleCreatePlan}
              >
                Create Visit Plan
              </JellyButton>
            </div>
          ) : (
            <>
              {/* Stop form (add / edit) */}
              {showStopForm && (
                <div
                  style={{
                    border: `1px solid ${T.border}`,
                    borderRadius: 12,
                    padding: 16,
                    marginBottom: 20,
                    background: T.slate50,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 12,
                    }}
                  >
                    <span
                      style={{ fontSize: 14, fontWeight: 800, color: T.head }}
                    >
                      {editingStop ? "Edit Stop" : "New Stop"}
                    </span>
                    <button
                      type="button"
                      onClick={closePanel}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        color: T.muted,
                        padding: 4,
                        display: "flex",
                      }}
                      aria-label="Close"
                    >
                      <X size={15} />
                    </button>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 12,
                    }}
                  >
                    <label style={fieldLabelStyle}>
                      Location label
                      <input
                        value={stopForm.locationLabel}
                        onChange={(e) =>
                          setStopForm((f) => ({
                            ...f,
                            locationLabel: e.target.value,
                          }))
                        }
                        placeholder="e.g. Sheikh Zaid Hospital"
                        style={inputStyle}
                      />
                    </label>
                    <label style={fieldLabelStyle}>
                      Purpose (optional)
                      <input
                        value={stopForm.purpose}
                        onChange={(e) =>
                          setStopForm((f) => ({
                            ...f,
                            purpose: e.target.value,
                          }))
                        }
                        placeholder="e.g. Follow-up delivery"
                        style={inputStyle}
                      />
                    </label>

                    <label style={fieldLabelStyle}>
                      Latitude
                      <input
                        value={stopForm.lat}
                        onChange={(e) =>
                          setStopForm((f) => ({ ...f, lat: e.target.value }))
                        }
                        placeholder="24.860000"
                        style={inputStyle}
                      />
                    </label>
                    <label style={fieldLabelStyle}>
                      Longitude
                      <input
                        value={stopForm.lng}
                        onChange={(e) =>
                          setStopForm((f) => ({ ...f, lng: e.target.value }))
                        }
                        placeholder="67.010000"
                        style={inputStyle}
                      />
                    </label>

                    <label style={fieldLabelStyle}>
                      Radius (meters)
                      <input
                        value={stopForm.radiusMeters}
                        onChange={(e) =>
                          setStopForm((f) => ({
                            ...f,
                            radiusMeters: e.target.value,
                          }))
                        }
                        style={inputStyle}
                      />
                    </label>
                    <div style={{ display: "flex", alignItems: "flex-end" }}>
                      <button
                        type="button"
                        onClick={useMyLocation}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          fontSize: 11.5,
                          fontWeight: 600,
                          color: T.teal600,
                          background: T.card,
                          border: `1px solid ${T.border}`,
                          borderRadius: 8,
                          padding: "8px 12px",
                          cursor: "pointer",
                          width: "100%",
                          justifyContent: "center",
                        }}
                      >
                        <Navigation size={12} />
                        Use my current location
                      </button>
                    </div>

                    <label style={fieldLabelStyle}>
                      Window start (optional)
                      <input
                        type="time"
                        value={stopForm.windowStart}
                        onChange={(e) =>
                          setStopForm((f) => ({
                            ...f,
                            windowStart: e.target.value,
                          }))
                        }
                        style={inputStyle}
                      />
                    </label>
                    <label style={fieldLabelStyle}>
                      Window end (optional)
                      <input
                        type="time"
                        value={stopForm.windowEnd}
                        onChange={(e) =>
                          setStopForm((f) => ({
                            ...f,
                            windowEnd: e.target.value,
                          }))
                        }
                        style={inputStyle}
                      />
                    </label>
                  </div>

                  {stopError && (
                    <div style={{ marginTop: 12 }}>
                      <ErrorBanner message={stopError} />
                    </div>
                  )}

                  <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                    <JellyButton
                      type="button"
                      variant="primary"
                      size="sm"
                      leftIcon={<Save size={13} />}
                      loading={savingStop}
                      onClick={handleSaveStop}
                    >
                      {editingStop ? "Save Changes" : "Add Stop"}
                    </JellyButton>
                    <JellyButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={closePanel}
                    >
                      Cancel
                    </JellyButton>
                  </div>
                </div>
              )}

              {/* Stops list */}
              <SectionLabel>Planned Stops</SectionLabel>
              {data.stops.length === 0 ? (
                <div
                  style={{
                    color: T.muted,
                    fontSize: 12.5,
                    marginBottom: 20,
                    padding: "14px 0",
                  }}
                >
                  No stops yet — click "Add Stop" above to build{" "}
                  {staff.name.split(" ")[0]}'s beat plan for {planDate}.
                </div>
              ) : (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    marginBottom: 20,
                  }}
                >
                  {data.stops.map((stop) => {
                    const isDone = completedStopIds.has(String(stop.id));
                    const verification = stopVerification.get(String(stop.id));
                    const outOfRange = verification?.outOfRange ?? false;
                    return (
                      <div
                        key={stop.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 10,
                          border: outOfRange
                            ? "1px solid #fecdd3"
                            : `1px solid ${T.border}`,
                          borderRadius: 10,
                          padding: "11px 14px",
                          background: outOfRange
                            ? "rgba(225,29,72,0.04)"
                            : isDone
                              ? "rgba(13,148,136,0.04)"
                              : "transparent",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 11,
                            minWidth: 0,
                          }}
                        >
                          {outOfRange ? (
                            <AlertTriangle
                              size={17}
                              color="#e11d48"
                              style={{ flexShrink: 0 }}
                            />
                          ) : isDone ? (
                            <CheckCircle
                              size={17}
                              color={T.teal600}
                              style={{ flexShrink: 0 }}
                            />
                          ) : (
                            <Clock
                              size={17}
                              color={T.muted}
                              style={{ flexShrink: 0 }}
                            />
                          )}
                          <div style={{ minWidth: 0 }}>
                            <div
                              style={{
                                fontSize: 12.5,
                                fontWeight: 700,
                                color: T.head,
                              }}
                            >
                              {stop.location_label}
                            </div>
                            <div
                              style={{
                                fontSize: 11,
                                color: T.muted,
                                marginTop: 1,
                              }}
                            >
                              {stop.purpose ? `${stop.purpose} · ` : ""}
                              {stop.lat.toFixed(4)}, {stop.lng.toFixed(4)} ·{" "}
                              {stop.radius_meters}m
                              {stop.window_start || stop.window_end
                                ? ` · ${stop.window_start ?? "--:--"}–${stop.window_end ?? "--:--"}`
                                : ""}
                            </div>
                            {outOfRange && (
                              <div
                                style={{
                                  fontSize: 11,
                                  color: "#e11d48",
                                  marginTop: 3,
                                  fontWeight: 700,
                                }}
                              >
                                Checked in{" "}
                                {verification?.visit.server_distance_meters ??
                                  "?"}
                                m away — outside the {stop.radius_meters}m
                                geofence
                              </div>
                            )}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                          <button
                            type="button"
                            onClick={() => openEditStop(stop)}
                            style={iconButtonStyle}
                            aria-label="Edit stop"
                          >
                            <Edit2 size={13} color={T.muted} />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteStop(stop)}
                            style={iconButtonStyle}
                            aria-label="Delete stop"
                          >
                            <Trash2 size={13} color="#e11d48" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Logged visits (read-only) */}
              <SectionLabel>Logged Visits Today</SectionLabel>
              {data.visits.length === 0 ? (
                <div
                  style={{ color: T.muted, fontSize: 12.5, padding: "6px 0" }}
                >
                  No visits logged yet.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {data.visits.map((visit, idx) => {
                    const flagged = visit.plan_stop_id
                      ? visit.verified_inside_geofence === false
                      : false;
                    return (
                      <div
                        key={visit.id}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 2,
                          fontSize: 12,
                          color: T.head,
                          padding: "8px 0",
                          borderBottom:
                            idx === data.visits.length - 1
                              ? "none"
                              : `1px solid ${T.border}`,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <span
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              minWidth: 0,
                            }}
                          >
                            {flagged && (
                              <AlertTriangle
                                size={13}
                                color="#e11d48"
                                style={{ flexShrink: 0 }}
                              />
                            )}
                            <span>
                              {visit.plan_stop_id
                                ? (data.stops.find(
                                    (s) => s.id === visit.plan_stop_id,
                                  )?.location_label ?? "Planned stop")
                                : "Unplanned visit"}
                              {visit.note ? ` — ${visit.note}` : ""}
                            </span>
                          </span>
                          <span
                            style={{
                              color: T.muted,
                              flexShrink: 0,
                              marginLeft: 12,
                            }}
                          >
                            {visit.timestamp
                              ? new Date(visit.timestamp).toLocaleTimeString(
                                  [],
                                  {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  },
                                )
                              : ""}
                          </span>
                        </div>
                        {flagged && (
                          <div
                            style={{
                              fontSize: 11,
                              color: "#e11d48",
                              fontWeight: 700,
                              marginLeft: 19,
                            }}
                          >
                            {visit.server_distance_meters ?? "?"}m from the stop
                            — outside the geofence
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

const StaffHistoryPanel: React.FC<{
  staff: RosterStaff;
  organizationId: number | string;
}> = ({ staff, organizationId }) => {
  const now = new Date();
  const [month, setMonth] = useState<{ year: number; month: number }>({
    year: now.getFullYear(),
    month: now.getMonth() + 1,
  });
  const [days, setDays] = useState<VisitPlanDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<
    "all" | "completed" | "incomplete" | "unplanned"
  >("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const monthParam = `${month.year}-${String(month.month).padStart(2, "0")}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getStaffVisitPlansHistory(staff.id, organizationId, {
        month: monthParam,
      });
      setDays(result);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to load visit history.",
      );
    } finally {
      setLoading(false);
    }
  }, [staff.id, organizationId, monthParam]);

  useEffect(() => {
    load();
  }, [load]);

  const isCurrentMonth =
    month.year === now.getFullYear() && month.month === now.getMonth() + 1;
  const changeMonth = (delta: number) => {
    setMonth((m) => {
      const total = m.year * 12 + (m.month - 1) + delta;
      return { year: Math.floor(total / 12), month: (total % 12) + 1 };
    });
  };

  const entries = days
    .map((day) => ({
      day,
      summary: computeVisitPlanSummary(day.stops, day.visits),
    }))
    .filter(({ summary }) => {
      if (filter === "completed")
        return summary.plannedTotal > 0 && summary.pending === 0;
      if (filter === "incomplete") return summary.pending > 0;
      if (filter === "unplanned") return summary.unplanned > 0;
      return true;
    });

  const monthLabel = new Date(
    month.year,
    month.month - 1,
    1,
  ).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  const toggleExpanded = (date: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(date) ? next.delete(date) : next.add(date);
      return next;
    });

  return (
    <div style={{ padding: 20 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <button
          type="button"
          onClick={() => changeMonth(-1)}
          style={{ ...iconButtonStyle, border: `1px solid ${T.border}` }}
          aria-label="Previous month"
        >
          <ChevronLeft size={14} color={T.head} />
        </button>
        <span style={{ fontSize: 13.5, fontWeight: 800, color: T.head }}>
          {monthLabel}
        </span>
        <button
          type="button"
          onClick={() => changeMonth(1)}
          disabled={isCurrentMonth}
          style={{
            ...iconButtonStyle,
            border: `1px solid ${T.border}`,
            opacity: isCurrentMonth ? 0.4 : 1,
            cursor: isCurrentMonth ? "default" : "pointer",
          }}
          aria-label="Next month"
        >
          <ChevronRight size={14} color={T.head} />
        </button>
      </div>

      <div
        style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}
      >
        {(["all", "completed", "incomplete", "unplanned"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            style={{
              fontSize: 11.5,
              fontWeight: 700,
              padding: "6px 12px",
              borderRadius: 999,
              border: `1px solid ${filter === f ? T.teal600 : T.border}`,
              background: filter === f ? T.teal600 : T.card,
              color: filter === f ? "#fff" : T.muted,
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {f}
          </button>
        ))}
      </div>

      {error && (
        <div style={{ marginBottom: 14 }}>
          <ErrorBanner message={error} />
        </div>
      )}

      {loading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: T.muted,
            fontSize: 13,
            padding: "24px 0",
          }}
        >
          <Spinner />
          Loading history…
        </div>
      ) : entries.length === 0 ? (
        <div
          style={{
            color: T.muted,
            fontSize: 12.5,
            textAlign: "center",
            padding: "32px 0",
          }}
        >
          No visits match this filter for {monthLabel}.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {entries.map(({ day, summary }) => {
            const isOpen = expanded.has(day.date);
            const verification = computeStopVerification(day.stops, day.visits);
            const stopVisit = new Map(
              day.visits
                .filter((v) => v.plan_stop_id)
                .map((v) => [String(v.plan_stop_id), v]),
            );
            const unplannedVisits = day.visits.filter((v) => !v.plan_stop_id);
            return (
              <div
                key={day.date}
                style={{
                  border: `1px solid ${T.border}`,
                  borderRadius: 10,
                  overflow: "hidden",
                }}
              >
                <button
                  type="button"
                  onClick={() => toggleExpanded(day.date)}
                  style={{
                    width: "100%",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "10px 14px",
                    background: T.slate50,
                    border: "none",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span
                    style={{ fontSize: 12.5, fontWeight: 700, color: T.head }}
                  >
                    {day.date}
                  </span>
                  <span style={{ fontSize: 11.5, color: T.muted }}>
                    {day.plan
                      ? `${summary.completed} of ${summary.plannedTotal} completed${
                          summary.unplanned
                            ? `, +${summary.unplanned} unplanned`
                            : ""
                        }`
                      : `${summary.unplanned} unplanned, no plan`}
                    {summary.outOfRange > 0 && (
                      <span style={{ color: "#e11d48", fontWeight: 700 }}>
                        {" "}
                        · {summary.outOfRange} flagged
                      </span>
                    )}
                  </span>
                </button>
                {isOpen && (
                  <div style={{ padding: "10px 14px 14px" }}>
                    {day.stops.length === 0 && unplannedVisits.length === 0 ? (
                      <div style={{ fontSize: 12, color: T.muted }}>
                        Nothing logged this day.
                      </div>
                    ) : (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                        }}
                      >
                        {day.stops.map((stop) => {
                          const visit = stopVisit.get(String(stop.id));
                          const outOfRange =
                            verification.get(String(stop.id))?.outOfRange ??
                            false;
                          const isDone = Boolean(visit);
                          return (
                            <div
                              key={stop.id}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                              }}
                            >
                              {outOfRange ? (
                                <AlertTriangle size={14} color="#e11d48" />
                              ) : isDone ? (
                                <CheckCircle size={14} color={T.teal600} />
                              ) : (
                                <Clock size={14} color={T.muted} />
                              )}
                              <span style={{ fontSize: 12, color: T.head }}>
                                {stop.location_label}
                                {outOfRange && (
                                  <span
                                    style={{
                                      color: "#e11d48",
                                      fontWeight: 700,
                                    }}
                                  >
                                    {" "}
                                    — {visit?.server_distance_meters ?? "?"}m
                                    away, outside geofence
                                  </span>
                                )}
                              </span>
                            </div>
                          );
                        })}
                        {unplannedVisits.map((v) => (
                          <div
                            key={v.id}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                            }}
                          >
                            <MapPin size={14} color={T.amber} />
                            <span style={{ fontSize: 12, color: T.head }}>
                              {v.note || "Unplanned visit"}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <div
    style={{
      fontSize: 11,
      fontWeight: 800,
      color: T.muted,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginBottom: 10,
    }}
  >
    {children}
  </div>
);

const fieldLabelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  fontSize: 11,
  fontWeight: 600,
  color: T.muted,
};

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  border: `1px solid ${T.border}`,
  fontSize: 12.5,
  color: T.head,
  background: T.card,
  boxSizing: "border-box",
};

const iconButtonStyle: React.CSSProperties = {
  background: T.card,
  border: `1px solid ${T.border}`,
  borderRadius: 7,
  padding: 6,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

export default VisitPlansTab;
