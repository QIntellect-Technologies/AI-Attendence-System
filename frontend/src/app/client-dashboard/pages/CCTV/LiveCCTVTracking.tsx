import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Activity,
  Camera,
  Clock,
  MapPin,
  ShieldCheck,
  UserCheck,
} from "lucide-react";
import DynamicFilterToolbar from "../../components/ui/DynamicFilterToolbar";
import JellyButton from "../../components/ui/JellyButton";
import RefreshButton from "../../components/ui/RefreshButton";
import { T } from "../../components/ui/theme";
import { useOrg } from "../../contexts/OrgConfigContext";
import { useLiveCctvTracking } from "./hooks/useLiveCCTVTracking";
import {
  resolveActivePeopleTypes,
  normalizePeopleType,
  peopleLabelForType,
  getModulePeopleTypesForBranch,
} from "../../utils/templateRendering";
import type {
  LiveTrackingCamera,
  LiveTrackingPerson,
} from "../LiveAttendance/api/liveStreamApi";

type StatColor = "teal" | "navy" | "success" | "amber";

interface StatCardProps {
  title: string;
  value: string | number;
  sub: string;
  icon: React.ElementType;
  color: StatColor;
}

interface CameraBoxProps {
  camera: LiveTrackingCamera;
  terminology: LiveTerminology;
}

const cardStyle: React.CSSProperties = {
  background: T.card,
  borderRadius: 14,
  border: `1px solid ${T.border}`,
  boxShadow: "0 1px 4px rgba(15, 45, 74, 0.06)",
};

const liveDotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: T.success,
  boxShadow: `0 0 6px ${T.success}`,
  display: "inline-block",
};

function useClock(): string {
  const [time, setTime] = useState(() => new Date().toLocaleTimeString());

  useEffect(() => {
    const timer = window.setInterval(
      () => setTime(new Date().toLocaleTimeString()),
      1_000,
    );

    return () => window.clearInterval(timer);
  }, []);

  return time;
}

function matchesSearch(person: LiveTrackingPerson, search: string): boolean {
  const normalized = search.trim().toLowerCase();
  if (!normalized) return true;

  return [
    person.name,
    person.id,
    person.personCode,
    person.employeeId,
    person.location,
    person.cameraName,
    person.building,
    person.branchName,
    person.groupName,
    person.subGroupName,
    person.className,
    person.sectionName,
    person.department,
    person.position,
    person.designation,
    person.duty,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(normalized));
}

interface LiveTerminology {
  personSingular: string;
  personPlural: string;
  groupLabel: string;
  subGroupLabel: string;
  roleLabel: string;
  codeLabel: string;
}

function firstLabel(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function buildLiveTerminology(
  cfg: unknown,
  activePeopleTypes: string[],
): LiveTerminology {
  // Use the first enabled people type for terminology, not student defaults
  const primaryPeopleType =
    activePeopleTypes.length > 0 ? activePeopleTypes[0] : "staff";

  // Get labels with guaranteed fallback
  const labels = peopleLabelForType(primaryPeopleType, cfg as any);

  // Ensure labels always have valid strings (never undefined)
  const safeSingular = labels?.singular || "Person";
  const safePlural = labels?.plural || "People";
  const safeCode = labels?.code || "ID";

  const raw = (cfg ?? {}) as Record<string, unknown>;
  const verticalConfig = ((raw.verticalConfig ?? raw.vertical_config ?? {}) ||
    {}) as Record<string, unknown>;
  const overrides = ((raw.terminologyOverrides ??
    raw.terminology_overrides ??
    verticalConfig.terminologyOverrides ??
    verticalConfig.terminology_overrides ??
    {}) ||
    {}) as Record<string, unknown>;

  const isStudent = primaryPeopleType.includes("student");

  return {
    personSingular: safeSingular,
    personPlural: safePlural,
    groupLabel:
      firstLabel(
        overrides.groupLabel,
        overrides.departmentLabel,
        overrides.classLabel,
        verticalConfig.groupLabel,
        isStudent ? "Class" : "Department",
      ) || (isStudent ? "Class" : "Department"),
    subGroupLabel:
      firstLabel(
        overrides.subGroupLabel,
        overrides.sectionLabel,
        verticalConfig.subGroupLabel,
        isStudent ? "Section" : "Team",
      ) || (isStudent ? "Section" : "Team"),
    roleLabel:
      firstLabel(
        overrides.roleLabel,
        overrides.designationLabel,
        verticalConfig.roleLabel,
        "Designation",
      ) || "Designation",
    codeLabel: safeCode,
  };
}

function displayGroupValue(
  person: LiveTrackingPerson,
  terminology: LiveTerminology,
): string {
  const primary = firstLabel(
    person.groupName,
    person.className,
    person.department,
  );
  const secondary = firstLabel(person.subGroupName, person.sectionName);
  if (primary && secondary)
    return `${terminology.groupLabel}: ${primary} • ${terminology.subGroupLabel}: ${secondary}`;
  if (primary) return `${terminology.groupLabel}: ${primary}`;
  if (secondary) return `${terminology.subGroupLabel}: ${secondary}`;
  return "";
}

function displayRoleValue(person: LiveTrackingPerson): string {
  return firstLabel(person.designation, person.position, person.duty);
}

function formatDetectionTime(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "—";
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return text;
  return new Date(timestamp).toLocaleString();
}

export default function LiveCCTVTracking() {
  const { branchId: routeBranchId } = useParams<{ branchId?: string }>();
  const { cfg, activeBranchId, allCameras } = useOrg();
  const clock = useClock();
  const [searchTerm, setSearchTerm] = useState("");

  // The route itself pins the scope to one branch (e.g. a branch admin's
  // /branches/:branchId/cctv page). Only when there is no such route param
  // are we in "global scope" (an org-wide view across every branch) — that
  // is the only case where a branch selector makes sense.
  const isGlobalRoute = !routeBranchId;

  // Branch scope filter — UUID-safe. Values are always the UI branch id
  // (OrgBranch.id, a plain number/string), never a raw backend UUID. The
  // same id is fed to useLiveCctvTracking's routeBranchId option, which
  // resolves it through resolveTenantScope/tenantScope.ts — that's what
  // maps a UI branch id to the correct backend branch UUID for UUID
  // tenants, or keeps it numeric for legacy SQLite tenants.
  const [branchFilter, setBranchFilter] = useState<string>("all");

  useEffect(() => {
    // A branch-scoped route always wins; reset any stale in-page selection
    // so re-entering a global route doesn't resurrect an old pick.
    if (!isGlobalRoute) setBranchFilter("all");
  }, [isGlobalRoute]);

  const branchOptions = useMemo(
    () => [
      { value: "all", label: "All Branches" },
      ...cfg.branches.map((branch) => ({
        value: String(branch.id),
        label: branch.name,
      })),
    ],
    [cfg.branches],
  );

  // Effective branch actually driving the fetch: the route param takes
  // priority (branch scope); otherwise it's whatever was picked in the
  // global-scope selector, or null for "All Branches".
  const effectiveBranchId = useMemo(() => {
    if (routeBranchId) return routeBranchId;
    if (branchFilter === "all") return null;
    return branchFilter;
  }, [routeBranchId, branchFilter]);

  // Numeric UI branch id used only for deriving the local camera fallback
  // list from OrgConfigContext (cfg.cameras is keyed by UI id, never a
  // backend UUID). In branch scope we keep relying on activeBranchId, same
  // as before this change.
  const uiBranchIdForCameraFallback = useMemo(() => {
    if (!isGlobalRoute) return activeBranchId;
    if (branchFilter === "all") return null;
    const parsed = Number(branchFilter);
    return Number.isFinite(parsed) ? parsed : null;
  }, [isGlobalRoute, activeBranchId, branchFilter]);

  // Resolve active people types from config
  const activePeopleTypes = useMemo(() => resolveActivePeopleTypes(cfg), [cfg]);
  const modulePeopleTypes = useMemo(
    () => getModulePeopleTypesForBranch(cfg, activeBranchId, "cctv"),
    [cfg, activeBranchId],
  );
  const visiblePeopleTypes = useMemo(
    () =>
      modulePeopleTypes.length
        ? modulePeopleTypes.filter((type) => activePeopleTypes.includes(type))
        : activePeopleTypes,
    [activePeopleTypes, modulePeopleTypes],
  );

  // People-type filter (dropdown). No aggregate "All Staff" / "All People"
  // option — only the specific, currently-active people types are ever
  // offered, and the filter always holds one of them (never "all").
  const [peopleTypeFilter, setPeopleTypeFilter] = useState<string>("");

  useEffect(() => {
    if (!peopleTypeFilter || !visiblePeopleTypes.includes(peopleTypeFilter)) {
      setPeopleTypeFilter(visiblePeopleTypes[0] ?? "");
    }
  }, [peopleTypeFilter, visiblePeopleTypes]);

  const tracking = useLiveCctvTracking({
    routeBranchId: effectiveBranchId,
    peopleType: peopleTypeFilter || null,
  });
  const { data } = tracking;

  const handleClearFilters = useCallback(() => {
    setBranchFilter("all");
    setPeopleTypeFilter(visiblePeopleTypes[0] ?? "");
    setSearchTerm("");
  }, [visiblePeopleTypes]);

  // Build terminology based on enabled people types, not defaults
  const terminology = useMemo(
    () => buildLiveTerminology(cfg, activePeopleTypes),
    [cfg, activePeopleTypes],
  );

  const peopleTypeOptions = useMemo(
    () =>
      visiblePeopleTypes.length <= 1
        ? []
        : visiblePeopleTypes.map((type) => ({
            value: type,
            label: peopleLabelForType(type, cfg).plural,
          })),
    [visiblePeopleTypes, cfg],
  );

  // Filter employees: only show those matching enabled people types
  const enabledPeopleTypeSet = useMemo(
    () =>
      new Set(
        visiblePeopleTypes.map((pt) => normalizePeopleType(pt).toLowerCase()),
      ),
    [visiblePeopleTypes],
  );

  // Defense-in-depth: the server already scopes to peopleTypeFilter (see
  // useLiveCctvTracking's peopleType option), but re-apply it client-side
  // too — same "server derives default, client still filters" pattern used
  // to close the original staff/student leak in this codebase.
  const filteredByPeopleType = useMemo(() => {
    return data.employees.filter((employee) => {
      const employeePeopleType = normalizePeopleType(
        employee.personType || "staff",
      ).toLowerCase();
      if (!enabledPeopleTypeSet.has(employeePeopleType)) return false;
      if (peopleTypeFilter && employeePeopleType !== peopleTypeFilter) {
        return false;
      }
      return true;
    });
  }, [data.employees, enabledPeopleTypeSet, peopleTypeFilter]);

  // Further filter by search term
  const filteredEmployees = useMemo(
    () =>
      filteredByPeopleType.filter((employee) =>
        matchesSearch(employee, searchTerm),
      ),
    [filteredByPeopleType, searchTerm],
  );

  // Use cameras from OrgConfigContext if backend returns empty
  // This is branch-scope aware and dynamically responsive
  const displayCameras = useMemo(() => {
    const ensureActiveDetections = (cam: any) => ({
      ...cam,
      activeDetections:
        typeof cam.activeDetections === "number" ? cam.activeDetections : 0,
    });

    if (data.cameras && data.cameras.length > 0) {
      return data.cameras.map(ensureActiveDetections);
    }

    // Fallback: derive cameras from OrgConfigContext only if backend has no cameras
    const getBranchName = (branchId: number | string): string => {
      const branches = Array.isArray(cfg?.branches) ? cfg.branches : [];
      const branch = branches.find(
        (b: any) => b.id === branchId || String(b.id) === String(branchId),
      );
      return branch?.name || `Branch ${branchId}`;
    };

    // Filter cameras by scope (branch or global), branch-aware via the
    // in-page selector when this is a global route.
    const scopedCameras = allCameras.filter((cam) => {
      if (
        uiBranchIdForCameraFallback === null ||
        uiBranchIdForCameraFallback === undefined
      ) {
        // Global scope: include all cameras
        return true;
      }
      // Branch-scoped: only include cameras for this branch
      return (
        cam.branchId === uiBranchIdForCameraFallback ||
        String(cam.branchId) === String(uiBranchIdForCameraFallback)
      );
    });

    // Transform cameras to match expected structure
    return scopedCameras.map((cam) => ({
      id: String(cam.id),
      cameraName: cam.name || "Camera",
      location: cam.location || cam.name || "Unconfigured",
      branchId: cam.branchId,
      branchName: getBranchName(cam.branchId),
      status: cam.status || ("Online" as const),
      activeDetections: 0,
    }));
  }, [data.cameras, allCameras, uiBranchIdForCameraFallback, cfg?.branches]);

  const systemOnline = data.sourceStatus !== "error";
  const nodeStatus = data.localNodeStatus;
  const isNodeOffline = nodeStatus && !nodeStatus.online;

  return (
    <div
      style={{
        padding: "24px 24px 48px",
        fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
        background: T.bgPage,
        minHeight: "100%",
      }}
    >
      <div style={{ padding: "24px 28px" }}>
        <Header
          clock={clock}
          scopeLabel={tracking.scopeLabel}
          sourceLabel={data.sourceLabel}
          systemOnline={systemOnline}
          isNodeOffline={isNodeOffline}
          refreshing={tracking.refreshing}
          onRefresh={tracking.refresh}
          terminology={terminology}
        />

        {tracking.error && (
          <div
            role="alert"
            style={{
              ...cardStyle,
              marginBottom: 16,
              padding: "12px 14px",
              color: T.amber,
              background: T.amberBg,
              borderColor: T.amberBd,
              fontSize: 12,
              fontWeight: 800,
            }}
          >
            {tracking.error}
          </div>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
            gap: 16,
            marginBottom: 24,
          }}
        >
          <StatCard
            title="Active Feeds"
            value={displayCameras.length.toString().padStart(2, "0")}
            sub="Cameras Configured"
            icon={Camera}
            color="teal"
          />
          <StatCard
            title="Active Now"
            value={filteredEmployees.length}
            sub={`${terminology?.personPlural || "People"} Detected`}
            icon={Activity}
            color="success"
          />
          <StatCard
            title="Registered"
            value={data.registeredCount}
            sub={`${terminology?.personPlural || "People"} in Scope`}
            icon={UserCheck}
            color="navy"
          />
          <StatCard
            title="System Link"
            value={systemOnline ? "Stable" : "Offline"}
            sub="Backend Adapter"
            icon={ShieldCheck}
            color="amber"
          />
        </div>

        <DynamicFilterToolbar
          bordered
          style={{ marginBottom: 24 }}
          sections={[
            {
              id: "cctv-branch-scope",
              type: "select",
              label: "Branch",
              hidden: !(isGlobalRoute && branchOptions.length > 1),
              value: branchFilter,
              minWidth: 200,
              options: branchOptions,
              onChange: setBranchFilter,
            },
            {
              id: "cctv-people-type",
              type: "select",
              label: "People Type",
              hidden: peopleTypeOptions.length === 0,
              value: peopleTypeFilter,
              minWidth: 180,
              options: peopleTypeOptions,
              onChange: setPeopleTypeFilter,
            },
            {
              id: "cctv-search",
              type: "search",
              value: searchTerm,
              placeholder: `Search ${(terminology?.personSingular || "person").toLowerCase()} name, ID, ${(terminology?.groupLabel || "group").toLowerCase()}, branch, camera, location...`,
              onChange: setSearchTerm,
              minWidth: 300,
              grow: true,
            },
            {
              id: "cctv-clear-filters",
              type: "reset",
              label: "Clear",
              onClick: handleClearFilters,
            },
          ]}
        />

        <section style={{ marginBottom: 24 }} aria-labelledby="cctv-cameras">
          <h3
            id="cctv-cameras"
            style={{
              margin: "0 0 12px",
              fontSize: 11,
              fontWeight: 900,
              color: T.navy600,
              textTransform: "uppercase",
              letterSpacing: 1,
            }}
          >
            Camera Infrastructure
          </h3>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: 12,
            }}
          >
            {displayCameras.length > 0 &&
              displayCameras.map((camera) => (
                <CameraBox
                  key={`${camera.branchId}-${camera.id}`}
                  camera={camera}
                  terminology={terminology}
                />
              ))}

            {displayCameras.length === 0 && (
              <EmptyCard
                message={
                  tracking.isGlobalScope
                    ? "No cameras configured globally. Add cameras in Settings to enable live CCTV tracking."
                    : `No cameras configured for ${tracking.scopeLabel}. Add cameras in Settings to enable live streaming.`
                }
              />
            )}
          </div>
        </section>

        <MovementLogs
          persons={filteredEmployees}
          sourceStatus={data.sourceStatus}
          terminology={terminology}
        />
      </div>
    </div>
  );
}

function Header({
  clock,
  scopeLabel,
  sourceLabel,
  systemOnline,
  refreshing,
  onRefresh,
  terminology,
}: {
  clock: string;
  scopeLabel: string;
  sourceLabel: string;
  systemOnline: boolean;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
  terminology: LiveTerminology;
}) {
  return (
    <div
      style={{
        marginBottom: 20,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
      }}
    >
      <div>
        <h1
          style={{
            margin: 0,
            fontSize: 22,
            fontWeight: 800,
            color: T.navy600,
          }}
        >
          Live CCTV Tracking
        </h1>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: T.muted,
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          <Clock size={13} />
          {clock}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: systemOnline ? T.successBg : T.amberBg,
            border: `1px solid ${systemOnline ? T.teal200 : T.amberBd}`,
            borderRadius: 20,
            padding: "6px 14px",
          }}
        >
          <span
            style={{
              ...liveDotStyle,
              background: systemOnline ? T.success : T.amber,
              boxShadow: systemOnline ? `0 0 6px ${T.success}` : "none",
            }}
          />
          <span
            style={{
              color: systemOnline ? T.success : T.amber,
              fontSize: 11,
              fontWeight: 900,
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            {systemOnline ? "System Online" : "Source Offline"}
          </span>
        </div>

        <RefreshButton
          size="md"
          variant="secondary"
          loading={refreshing}
          onClick={() => void onRefresh()}
        />
      </div>
    </div>
  );
}

function MovementLogs({
  persons,
  sourceStatus,
  terminology,
}: {
  persons: LiveTrackingPerson[];
  sourceStatus: "ready" | "loading" | "error";
  terminology: LiveTerminology;
}) {
  return (
    <section style={{ ...cardStyle, overflow: "hidden", marginBottom: 20 }}>
      <div
        style={{
          padding: "16px 20px",
          borderBottom: `1px solid ${T.border}`,
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 14,
            fontWeight: 800,
            color: T.navy600,
          }}
        >
          Movement Logs
        </h2>
        <p
          style={{
            margin: "2px 0 0",
            fontSize: 11,
            color: T.muted,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            fontWeight: 800,
          }}
        >
          Backend-sourced detection trail with person, camera, branch, and time
        </p>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr
              style={{
                background: T.slate50,
                borderBottom: `1px solid ${T.border}`,
              }}
            >
              {[
                `${terminology?.personSingular || "Person"} Info`,
                "Camera",
                "Location",
                "Detection",
                "Detected At",
                "Status",
                terminology?.roleLabel || "Role",
              ].map((header) => (
                <th
                  key={header}
                  style={{
                    padding: "12px 20px",
                    fontSize: 10,
                    fontWeight: 900,
                    color: T.muted,
                    textTransform: "uppercase",
                    letterSpacing: 0.8,
                    textAlign: "left",
                    whiteSpace: "nowrap",
                  }}
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {persons.map((person) => (
              <MovementRow
                key={`${person.cameraId}-${person.id}`}
                person={person}
                terminology={terminology}
              />
            ))}

            {persons.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  style={{
                    padding: 28,
                    textAlign: "center",
                    color: T.muted,
                    fontSize: 13,
                    fontWeight: 700,
                  }}
                >
                  {sourceStatus === "error"
                    ? "Unable to load live CCTV data from the backend source."
                    : `No authorized ${(terminology?.personSingular || "person").toLowerCase()} detection found for this scope.`}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MovementRow({
  person,
  terminology,
}: {
  person: LiveTrackingPerson;
  terminology: LiveTerminology;
}) {
  const isActive = person.status === "Active";
  const groupValue = displayGroupValue(person, terminology);
  const roleValue = displayRoleValue(person);
  const personCode = person.personCode || person.employeeId || person.id;

  return (
    <tr style={{ borderBottom: `1px solid ${T.slate100}` }}>
      <td style={{ padding: "14px 20px" }}>
        <p
          style={{
            margin: 0,
            fontSize: 13,
            fontWeight: 800,
            color: T.navy600,
            textTransform: "uppercase",
          }}
        >
          {person.name}
        </p>
        <p
          style={{
            margin: "2px 0 0",
            fontSize: 10,
            color: T.muted,
            fontWeight: 700,
          }}
        >
          {personCode} • {person.branchName}
        </p>
      </td>

      <td style={{ padding: "14px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 32,
              height: 32,
              background: T.teal50,
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: T.teal600,
              flexShrink: 0,
            }}
          >
            <Camera size={14} />
          </div>
          <p
            style={{
              margin: 0,
              fontSize: 12,
              fontWeight: 800,
              color: T.head,
              textTransform: "uppercase",
            }}
          >
            {person.cameraName}
          </p>
        </div>
      </td>

      <td style={{ padding: "14px 20px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: T.muted,
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          <MapPin size={13} color={T.teal600} />
          {person.location}
        </div>
        <p style={{ margin: "2px 0 0", fontSize: 10, color: T.muted }}>
          {groupValue || person.building}
        </p>
      </td>

      <td style={{ padding: "14px 20px" }}>
        <span
          style={{
            padding: "4px 12px",
            borderRadius: 20,
            fontSize: 10,
            fontWeight: 900,
            textTransform: "uppercase",
            background: isActive ? T.teal600 : T.slate100,
            color: isActive ? "#fff" : T.muted,
          }}
        >
          {person.pose}
        </span>
      </td>

      <td style={{ padding: "14px 20px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: T.body,
            fontSize: 12,
            fontWeight: 700,
            whiteSpace: "nowrap",
          }}
        >
          <Clock size={12} color={T.muted} />
          {formatDetectionTime(person.lastSeen)}
        </div>
      </td>

      <td style={{ padding: "14px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: isActive ? T.success : T.slate300,
              boxShadow: isActive ? `0 0 6px ${T.success}` : "none",
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: 11,
              fontWeight: 900,
              textTransform: "uppercase",
              color: isActive ? T.success : T.muted,
            }}
          >
            {person.status}
          </span>
        </div>
      </td>

      <td style={{ padding: "14px 20px" }}>
        <span
          style={{
            padding: "5px 12px",
            background: `linear-gradient(135deg, ${T.teal600}, ${T.navy600})`,
            color: "#fff",
            borderRadius: 7,
            fontSize: 10,
            fontWeight: 900,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            whiteSpace: "nowrap",
          }}
        >
          {roleValue || person.duty || "On Duty"}
        </span>
      </td>
    </tr>
  );
}

function StatCard({ title, value, sub, icon: Icon, color }: StatCardProps) {
  const palette: Record<
    StatColor,
    { icon: string; bg: string; border: string }
  > = {
    teal: { icon: T.teal600, bg: T.teal50, border: T.teal200 },
    navy: { icon: T.navy600, bg: T.slate50, border: T.slate200 },
    success: { icon: T.success, bg: T.successBg, border: T.teal200 },
    amber: { icon: T.amber, bg: T.amberBg, border: T.amberBd },
  };

  const selectedColor = palette[color];

  return (
    <div
      style={{
        ...cardStyle,
        padding: "18px 20px",
        display: "flex",
        alignItems: "center",
        gap: 14,
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          background: selectedColor.bg,
          border: `1px solid ${selectedColor.border}`,
          borderRadius: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: selectedColor.icon,
          flexShrink: 0,
        }}
      >
        <Icon size={22} />
      </div>

      <div>
        <p
          style={{
            margin: 0,
            fontSize: 10,
            fontWeight: 900,
            color: T.muted,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {title}
        </p>
        <p
          style={{
            margin: "2px 0",
            fontSize: 20,
            fontWeight: 900,
            color: T.head,
          }}
        >
          {value}
        </p>
        <p
          style={{
            margin: 0,
            fontSize: 10,
            color: T.muted,
            fontWeight: 700,
            textTransform: "uppercase",
          }}
        >
          {sub}
        </p>
      </div>
    </div>
  );
}

function CameraBox({ camera, terminology }: CameraBoxProps) {
  const online = camera.status !== "Offline";
  const alert = camera.status === "Alert";

  // Ensure activeDetections is always a number, never undefined
  const safeDetectionCount =
    typeof camera.activeDetections === "number" ? camera.activeDetections : 0;

  // Ensure terminology has safe values with fallbacks
  const safePeoplePlural = terminology?.personPlural || "People";

  return (
    <div
      style={{
        ...cardStyle,
        padding: "14px 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          style={{
            width: 38,
            height: 38,
            background: alert ? T.amberBg : online ? T.teal50 : T.slate50,
            borderRadius: 9,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: alert ? T.amber : online ? T.teal600 : T.muted,
          }}
        >
          <Camera size={17} />
        </div>

        <div>
          <p
            style={{
              margin: 0,
              fontSize: 12,
              fontWeight: 800,
              color: T.head,
              textTransform: "uppercase",
            }}
          >
            {camera.cameraName || "Camera"}
          </p>
          <p
            style={{
              margin: "2px 0 0",
              fontSize: 11,
              fontWeight: 700,
              color: T.muted,
            }}
          >
            {camera.location || "Unconfigured"} •{" "}
            {camera.branchName || "Branch"}
          </p>
          <p
            style={{
              margin: "1px 0 0",
              fontSize: 11,
              fontWeight: 800,
              color: online ? T.teal600 : alert ? T.amber : T.muted,
            }}
          >
            {online
              ? `${safeDetectionCount} ${safePeoplePlural} Detected`
              : alert
                ? "⚠️ Connection Alert"
                : "📵 Offline - Fallback Enabled"}
          </p>
        </div>
      </div>

      <span
        style={{
          ...liveDotStyle,
          background: alert ? T.amber : online ? T.success : T.slate300,
          boxShadow: online ? `0 0 6px ${alert ? T.amber : T.success}` : "none",
        }}
      />
    </div>
  );
}

function EmptyCard({ message }: { message: string }) {
  return (
    <div
      style={{
        ...cardStyle,
        padding: 22,
        color: T.muted,
        fontSize: 13,
        fontWeight: 700,
        textAlign: "center",
      }}
    >
      {message}
    </div>
  );
}
