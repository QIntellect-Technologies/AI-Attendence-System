/**
 * modules/branches/index.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Global Branches page backed by Flask.
 *
 * This page is admin-only from routes.tsx. It reads live branch metrics from
 * /api/branches/summary instead of deriving business metrics from dummy data.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertCircle,
  Building2,
  CalendarClock,
  DollarSign,
  MapPin,
  RefreshCcw,
  Users,
  type LucideIcon,
} from "lucide-react";
import { T } from "../../components/ui/theme";
import OverviewStatCard from "../../components/dashboard/overview/StatCard";
import { useAuth } from "../../contexts/useAuth";
import { useOrg } from "../../contexts/OrgConfigContext";
import { ModuleShell } from "../engine/ModuleShell";
import BranchCompareChart from "./BranchCompareChart";
import DateFilterBar from "../../components/ui/DateFilterBar";
import JellyButton from "../../components/ui/JellyButton";
import ModernSelect from "../../components/ui/ModernSelect";
import RefreshButton from "../../components/ui/RefreshButton";
import { useDateFilter } from "../../hooks/useDateFilter";
import {
  getAttendanceToday,
  type TodayAttendanceRecord,
} from "../attendance_temp/api/attendanceApi";
import { getPaidPayrollMonthlyTrends } from "../Payroll/api/payrollApi";
import {
  fetchBranchSummary,
  type BranchSummaryResponse,
  type BranchSummaryRow,
} from "./api/branchApi";
import { resolveTemplateRenderingModel } from "../../utils/templateColumns";
import {
  peopleLabelForType,
  resolveActivePeopleTypes,
  resolveModulePeopleTypes,
} from "../../utils/templateRendering";

type AuthUserLike = {
  id?: number | string;
  organization_id?: number | string | null;
  organizationId?: number | string | null;
  allowedModules?: string[] | string | null;
  accessModules?: string[] | string | null;
  access_modules?: string[] | string | null;
};

type BranchRowWithAliases = BranchSummaryRow & {
  branch_id?: number | string | null;
  branchId?: number | string | null;
  id?: number | string | null;
  name?: string | null;
  branchName?: string | null;
};

type TemplateModel = ReturnType<typeof resolveTemplateRenderingModel>;

function monthKeysBetween(startDate: string, endDate: string): string[] {
  const [startYear, startMonth] = startDate.split("-").map(Number);
  const [endYear, endMonth] = endDate.split("-").map(Number);
  const start = startYear * 12 + startMonth - 1;
  const end = endYear * 12 + endMonth - 1;
  const months: string[] = [];

  for (let month = start; month <= end; month += 1) {
    const year = Math.floor(month / 12);
    const monthOfYear = (month % 12) + 1;
    months.push(`${year}-${String(monthOfYear).padStart(2, "0")}`);
  }
  return months;
}

function toPositiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toTenantId(value: unknown): string {
  const text = String(value ?? "").trim();
  return text && text !== "null" && text !== "undefined" ? text : "";
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim().toLowerCase())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => String(item).trim().toLowerCase())
          .filter(Boolean);
      }
    } catch {
      return value
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
    }
  }
  return [];
}

function hasModule(modules: string[], key: string): boolean {
  const normalized = key.toLowerCase();
  return modules.some(
    (item) => item.replace(/[_-]/g, "") === normalized.replace(/[_-]/g, ""),
  );
}

function getBranchLocation(branch: BranchSummaryRow): string {
  const row = branch as BranchRowWithAliases;
  return String(row.branchCity ?? row.city ?? "");
}

function getBranchDashboardId(branch: BranchSummaryRow): number | null {
  const row = branch as BranchRowWithAliases;
  return toPositiveNumber(row.branchId ?? row.id ?? row.branch_id);
}

function getBranchDashboardPath(branch: BranchSummaryRow): string | null {
  const branchId = getBranchDashboardId(branch);
  return branchId ? `/admin/branch/${branchId}` : null;
}

function getBranchDisplayName(branch: BranchSummaryRow): string {
  const row = branch as BranchRowWithAliases;
  return String(row.branchName ?? row.name ?? "Branch");
}

function branchMetricKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function getBranchMetricKey(branch: BranchSummaryRow): string {
  return branchMetricKey(
    branch.backendBranchId ??
      branch.backend_branch_id ??
      branch.branchUuid ??
      branch.branch_uuid ??
      branch.branchId ??
      branch.id,
  );
}

function getAttendanceBranchMetricKey(record: TodayAttendanceRecord): string {
  return branchMetricKey(
    record.backendBranchId ??
      record.backend_branch_id ??
      record.branchId ??
      record.branch_id,
  );
}

function formatMoney(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(Math.round(value));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function readTemplateLabel(
  model: TemplateModel,
  key: string,
  fallback: string,
): string {
  const labels = asRecord(asRecord(model).labels);
  const value = labels[key];

  return typeof value === "string" && value.trim() ? value : fallback;
}

function templateItemKeys(items: unknown): string[] {
  if (!Array.isArray(items)) return [];

  return items
    .flatMap((item) => {
      const record = asRecord(item);
      return [record.key, record.dataKey, record.field, record.name];
    })
    .map((item) =>
      String(item ?? "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

function templateFeatureEnabled(
  model: TemplateModel,
  featureKey: string,
): boolean | null {
  const features = asRecord(asRecord(model).features);
  const value = features[featureKey];

  if (typeof value === "boolean") return value;

  return null;
}

function templateSupportsPayroll(model: TemplateModel): boolean {
  const explicit =
    templateFeatureEnabled(model, "payroll") ??
    templateFeatureEnabled(model, "salary") ??
    templateFeatureEnabled(model, "compensation");

  if (explicit !== null) return explicit;

  const record = asRecord(model);
  const keys = new Set([
    ...templateItemKeys(record.peopleColumns),
    ...templateItemKeys(record.formFields),
  ]);

  return [
    "salary",
    "payroll",
    "compensation",
    "basicsalary",
    "basic_salary",
    "benefits",
  ].some((key) => keys.has(key));
}

function templateSupportsBiometrics(model: TemplateModel): boolean {
  const explicit =
    templateFeatureEnabled(model, "biometrics") ??
    templateFeatureEnabled(model, "media") ??
    templateFeatureEnabled(model, "attendanceMedia");

  if (explicit !== null) return explicit;

  return true;
}

function lowerLabel(value: string): string {
  return value.trim().toLowerCase();
}

function pluralCountLabel(
  count: number,
  singular: string,
  plural: string,
): string {
  return count === 1 ? singular : plural;
}

const BRANCH_SUMMARY_CACHE_PREFIX = "branchSummary:";

function branchSummaryCacheKey(orgId: string, peopleType: string): string {
  const normalizedPeopleType = peopleType?.trim() || "staff";
  return `${BRANCH_SUMMARY_CACHE_PREFIX}${orgId}:${normalizedPeopleType}`;
}

function readCachedBranchSummary(
  orgId: string,
  peopleType: string,
): BranchSummaryResponse | null {
  if (!orgId || typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(
      branchSummaryCacheKey(orgId, peopleType),
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BranchSummaryResponse;
    return parsed?.branches ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedBranchSummary(
  orgId: string,
  summary: BranchSummaryResponse,
  peopleType: string,
): void {
  if (!orgId || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      branchSummaryCacheKey(orgId, peopleType),
      JSON.stringify(summary),
    );
  } catch {
    // Ignore storage errors. Cache is only for instant paint.
  }
}

function statCard(
  label: string,
  value: string | number,
  sub: string,
  Icon: LucideIcon,
  tone: "blue" | "green" | "amber" | "red" | "teal" = "teal",
): React.ReactNode {
  const tones = {
    blue: { bg: "#E0F2FE", fg: "#0369A1" },
    green: { bg: "#DCFCE7", fg: "#16A34A" },
    amber: { bg: "#FEF3C7", fg: "#D97706" },
    red: { bg: "#FFE4E6", fg: "#E11D48" },
    teal: { bg: T.teal50, fg: T.teal600 },
  }[tone];

  return (
    <OverviewStatCard
      title={label}
      value={value}
      sub={sub}
      icon={Icon}
      iconBg={tones.bg}
      iconColor={tones.fg}
    />
  );
}

const BranchesModule: React.FC = () => {
  const { user: rawUser } = useAuth() as { user?: AuthUserLike | null };
  const { organizationId, cfg } = useOrg();

  const activePeopleTypes = useMemo(
    () => resolveActivePeopleTypes(cfg as unknown as Record<string, unknown>),
    [cfg],
  );

  const defaultPeopleType = useMemo(
    () =>
      activePeopleTypes.includes("staff")
        ? "staff"
        : (activePeopleTypes[0] ?? "staff"),
    [activePeopleTypes],
  );

  const [selectedPeopleType, setSelectedPeopleType] = useState(
    () => defaultPeopleType,
  );

  useEffect(() => {
    if (!activePeopleTypes.includes(selectedPeopleType)) {
      setSelectedPeopleType(defaultPeopleType);
    }
  }, [activePeopleTypes, defaultPeopleType, selectedPeopleType]);

  const templateModel = useMemo(
    () =>
      resolveTemplateRenderingModel(
        cfg as unknown as Record<string, unknown>,
        selectedPeopleType,
      ),
    [cfg, selectedPeopleType],
  );

  const peopleSingular = readTemplateLabel(templateModel, "singular", "Staff");
  const peoplePlural = readTemplateLabel(templateModel, "plural", "Staff");
  const branchSingular = readTemplateLabel(templateModel, "branch", "Branch");
  const branchPlural = readTemplateLabel(
    templateModel,
    "branchPlural",
    `${branchSingular}es`,
  );

  const payrollPeopleTypes = useMemo(
    () => resolveModulePeopleTypes(cfg, "payroll", null),
    [cfg],
  );
  const showPayroll =
    templateModel.features.payroll &&
    payrollPeopleTypes.includes(selectedPeopleType);

  const user = rawUser ?? null;
  const resolvedOrgId =
    toTenantId(organizationId) ||
    toTenantId(user?.organization_id) ||
    toTenantId(user?.organizationId);

  const [summary, setSummary] = useState<BranchSummaryResponse | null>(() =>
    readCachedBranchSummary(resolvedOrgId, selectedPeopleType),
  );
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>("");
  const dateFilter = useDateFilter("monthly");
  const [periodAttendance, setPeriodAttendance] = useState<{
    totalDailyPresent: number;
    dayCount: number;
    branches: Map<string, { totalDailyPresent: number; totalDailyLate: number }>;
  } | null>(null);
  const [attendancePeriodError, setAttendancePeriodError] = useState("");
  const [periodPayroll, setPeriodPayroll] = useState<{
    total: number;
    branches: Map<string, number>;
  } | null>(null);
  const [payrollPeriodError, setPayrollPeriodError] = useState("");

  useEffect(() => {
    let active = true;
    const { startDate, endDate } = dateFilter.range;

    setPeriodAttendance(null);
    setAttendancePeriodError("");
    setPeriodPayroll(null);
    setPayrollPeriodError("");
    if (!resolvedOrgId) {
      return () => {
        active = false;
      };
    }

    void getAttendanceToday({
      start: startDate,
      end: endDate,
      peopleType: selectedPeopleType,
      limit: 20000,
    }).then(
      (records) => {
        if (!active) return;
        if (records.length >= 20000) {
          setAttendancePeriodError(
            "Attendance results exceeded the supported range limit. Narrow the selected dates and try again.",
          );
          return;
        }

        const peopleByDay = new Map<string, Set<string>>();
        const peopleByBranchAndDay = new Map<string, Set<string>>();
        const latePeopleByBranchAndDay = new Map<string, Set<string>>();
        for (const record of records) {
          const day = record.logDate || String(record.timestamp ?? "").slice(0, 10);
          const personId = record.userId ?? record.staffId;
          if (!day || personId == null) continue;
          const people = peopleByDay.get(day) ?? new Set<string>();
          people.add(String(personId));
          peopleByDay.set(day, people);

          const branchKey = getAttendanceBranchMetricKey(record);
          if (!branchKey) continue;
          const branchDayKey = `${branchKey}\u001f${day}`;
          const branchPeople = peopleByBranchAndDay.get(branchDayKey) ?? new Set<string>();
          branchPeople.add(String(personId));
          peopleByBranchAndDay.set(branchDayKey, branchPeople);

          const isLate =
            String(record.checkInStatus ?? record.check_in_status ?? "")
              .toLowerCase() === "late" ||
            String(record.dayStatus ?? record.day_status ?? "")
              .toLowerCase() === "late" ||
            String(record.status ?? "").toLowerCase().includes("late");
          if (isLate) {
            const latePeople =
              latePeopleByBranchAndDay.get(branchDayKey) ?? new Set<string>();
            latePeople.add(String(personId));
            latePeopleByBranchAndDay.set(branchDayKey, latePeople);
          }
        }
        const branchAttendance = new Map<
          string,
          { totalDailyPresent: number; totalDailyLate: number }
        >();
        for (const [branchDayKey, people] of peopleByBranchAndDay) {
          const [branchKey] = branchDayKey.split("\u001f");
          const metric = branchAttendance.get(branchKey) ?? {
            totalDailyPresent: 0,
            totalDailyLate: 0,
          };
          metric.totalDailyPresent += people.size;
          metric.totalDailyLate +=
            latePeopleByBranchAndDay.get(branchDayKey)?.size ?? 0;
          branchAttendance.set(branchKey, metric);
        }
        setPeriodAttendance({
          totalDailyPresent: Array.from(peopleByDay.values()).reduce(
            (total, people) =>
              total + Math.min(people.size, summary?.totals.staff ?? people.size),
            0,
          ),
          dayCount: dateFilter.dates.length,
          branches: branchAttendance,
        });
      },
      (err: unknown) => {
        if (!active) return;
        setAttendancePeriodError(
          err instanceof Error
            ? err.message
            : "Failed to load attendance for the selected period.",
        );
      },
    );

    if (!showPayroll) {
      return () => {
        active = false;
      };
    }

    if (!resolvedOrgId || Number.isFinite(Number(resolvedOrgId))) {
      setPayrollPeriodError(
        "Paid payroll history is unavailable for this organization.",
      );
      return () => {
        active = false;
      };
    }

    const months = monthKeysBetween(startDate, endDate);
    const selectedMonths = new Set(months);
    const monthChunks = Array.from(
      { length: Math.ceil(months.length / 12) },
      (_, index) => months.slice(index * 12, index * 12 + 12),
    );

    void Promise.all(
      monthChunks.map((chunk) =>
        getPaidPayrollMonthlyTrends({
          organizationId: resolvedOrgId,
          anchorMonth: chunk[chunk.length - 1],
          peopleType: selectedPeopleType,
        }),
      ),
    ).then(
      (trends) => {
        if (!active) return;
        const branchPayroll = new Map<string, number>();
        for (const trend of trends) {
          for (const row of trend.rows) {
            if (!selectedMonths.has(row.month)) continue;
            const branchKey = branchMetricKey(row.branch_id);
            if (!branchKey) continue;
            branchPayroll.set(
              branchKey,
              (branchPayroll.get(branchKey) ?? 0) + (Number(row.payroll) || 0),
            );
          }
        }
        setPeriodPayroll({
          total: Array.from(branchPayroll.values()).reduce(
            (total, amount) => total + amount,
            0,
          ),
          branches: branchPayroll,
        });
      },
      (err: unknown) => {
        if (!active) return;
        setPayrollPeriodError(
          err instanceof Error
            ? err.message
            : "Failed to load paid payroll for the selected period.",
        );
      },
    );

    return () => {
      active = false;
    };
  }, [
    dateFilter.range,
    dateFilter.dates.length,
    selectedPeopleType,
    resolvedOrgId,
    summary?.totals.staff,
    showPayroll,
  ]);

  useEffect(() => {
    setSummary(readCachedBranchSummary(resolvedOrgId, selectedPeopleType));
  }, [resolvedOrgId, selectedPeopleType]);

  const load = useCallback(async () => {
    if (!resolvedOrgId) {
      setSummary(null);
      setError("Organization is not loaded yet.");
      return;
    }

    try {
      setRefreshing(true);
      setError("");
      const result = await fetchBranchSummary({
        organizationId: resolvedOrgId,
        userId: user?.id ?? null,
        peopleType: selectedPeopleType,
      });
      writeCachedBranchSummary(resolvedOrgId, result, selectedPeopleType);
      setSummary(result);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load branch summary.",
      );
    } finally {
      setRefreshing(false);
    }
  }, [resolvedOrgId, selectedPeopleType, user?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const handler = () => {
      void load();
    };
    window.addEventListener("orgDataChanged", handler);
    return () => window.removeEventListener("orgDataChanged", handler);
  }, [load]);

  const branches = useMemo<BranchSummaryRow[]>(() => {
    if (summary?.branches) {
      return summary.branches.map((branch) => {
        const staffCount = Math.max(
          0,
          Number(branch.staffCount ?? branch.staff) || 0,
        );
        const presentToday = Math.min(
          staffCount,
          Math.max(0, Number(branch.presentToday) || 0),
        );
        const attendanceRate = staffCount
          ? Math.min(100, (presentToday / staffCount) * 100)
          : 0;

        return {
          ...branch,
          staff: staffCount,
          staffCount,
          presentToday,
          absentToday: Math.max(0, staffCount - presentToday),
          attendance: attendanceRate,
          attendanceRate,
        };
      });
    }

    // Very small UI fallback while backend is still loading.
    return cfg.branches.map((branch) => ({
      id: Number(branch.id),
      branchId: Number(branch.id),
      backendBranchId:
        (branch as { backendBranchId?: string; backend_branch_id?: string })
          .backendBranchId ??
        (branch as { backendBranchId?: string; backend_branch_id?: string })
          .backend_branch_id ??
        undefined,
      backend_branch_id:
        (branch as { backendBranchId?: string; backend_branch_id?: string })
          .backendBranchId ??
        (branch as { backendBranchId?: string; backend_branch_id?: string })
          .backend_branch_id ??
        undefined,
      name: branch.name,
      branchName: branch.name,
      city: branch.city ?? "",
      branchCity: branch.city ?? "",
      staff: 0,
      staffCount: 0,
      activeStaff: 0,
      enrolledStaff: 0,
      presentToday: 0,
      absentToday: 0,
      attendance: 0,
      attendanceRate: 0,
      payroll: 0,
      revenue: 0,
      late: 0,
      lateCount: 0,
      pendingLeaves: 0,
      overtimeHours: 0,
    }));
  }, [cfg.branches, summary?.branches]);

  const totals = summary?.totals ?? {
    branches: branches.length,
    staff: 0,
    activeStaff: 0,
    enrolledStaff: 0,
    presentToday: 0,
    absentToday: 0,
    payroll: 0,
    late: 0,
    pendingLeaves: 0,
    overtimeHours: 0,
    attendanceRate: 0,
  };

  const attendancePeriodStats = useMemo(() => {
    if (!periodAttendance || periodAttendance.dayCount <= 0) return null;
    const averagePresent = Math.min(
      totals.staff,
      periodAttendance.totalDailyPresent / periodAttendance.dayCount,
    );
    const averageAbsent = Math.max(0, totals.staff - averagePresent);
    return {
      averagePresent,
      averageAbsent,
      attendanceRate: totals.staff
        ? (averagePresent / totals.staff) * 100
        : 0,
    };
  }, [periodAttendance, totals.staff]);

  const descriptionItems = useMemo(
    () => [
      `${lowerLabel(peoplePlural)} coverage`,
      "attendance",
      ...(showPayroll ? ["payroll"] : []),
      "lateness",
      "leaves",
      "overtime",
    ],
    [peoplePlural, showPayroll],
  );

  const tableGridTemplate = useMemo(
    () =>
      [
        "1.35fr",
        ".9fr",
        ".8fr",
        ".9fr",
        ...(showPayroll ? [".9fr"] : []),
        ".8fr",
        "210px",
      ].join(" "),
    [showPayroll],
  );

  const tableMinWidth = showPayroll ? 980 : 820;

  return (
    <div
      className="branches-page"
      style={{
        background: "#f5f6fa",
        minWidth: 0,
        width: "100%",
        boxSizing: "border-box",
        overflowX: "hidden",
        padding: "24px",
        fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
      }}
    >
      <ModuleShell
        title={branchPlural}
        Icon={Building2}
        total={totals.branches}
        actions={
          <>
            <DateFilterBar filter={dateFilter} compact />
            {activePeopleTypes.length > 1 ? (
              <ModernSelect
                value={selectedPeopleType}
                options={activePeopleTypes.map((type) => ({
                  value: type,
                  label: peopleLabelForType(type, cfg as any).plural,
                }))}
                onChange={(value) => setSelectedPeopleType(value)}
                ariaLabel="People type"
                minWidth={160}
              />
            ) : null}
            <RefreshButton
              variant="secondary"
              size="md"
              loading={refreshing}
              onClick={() => void load()}
            />
          </>
        }
        stats={
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 14,
                minWidth: 0,
                width: "100%",
                marginBottom: 16,
              }}
            >
              {statCard(
                `Total ${branchPlural}`,
                totals.branches,
                "Configured locations",
                Building2,
                "teal",
              )}
              {statCard(
                `Total ${peoplePlural}`,
                totals.staff,
                `${totals.activeStaff} active ${lowerLabel(
                  pluralCountLabel(
                    totals.activeStaff,
                    peopleSingular,
                    peoplePlural,
                  ),
                )}`,
                Users,
                "blue",
              )}
              {statCard(
                "Average Attendance",
                attendancePeriodStats
                  ? `${Math.round(attendancePeriodStats.attendanceRate)}%`
                  : "—",
                attendancePeriodStats
                  ? `${attendancePeriodStats.averagePresent.toLocaleString(
                      undefined,
                      { maximumFractionDigits: 1 },
                    )} avg present · ${attendancePeriodStats.averageAbsent.toLocaleString(
                      undefined,
                      { maximumFractionDigits: 1 },
                    )} avg absent · ${dateFilter.label}`
                  : attendancePeriodError
                    ? `Unavailable · ${dateFilter.label}`
                    : `Loading attendance · ${dateFilter.label}`,
                Activity,
                "green",
              )}
              {showPayroll &&
                statCard(
                  "Paid Payroll",
                  periodPayroll === null ? "—" : formatMoney(periodPayroll.total),
                  periodPayroll === null
                    ? payrollPeriodError
                      ? "Paid history unavailable"
                      : "Loading paid payroll"
                    : "Selected calendar month(s)",
                  DollarSign,
                  "amber",
                )}
            </div>
          </>
        }
      >
        {(error || attendancePeriodError || payrollPeriodError) && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: 14,
              borderRadius: 12,
              background: "#FFF1F2",
              border: "1px solid #FECDD3",
              color: "#BE123C",
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            <AlertCircle size={17} />
            {error || attendancePeriodError || payrollPeriodError}
          </div>
        )}

        <section
          style={{
            background: T.card,
            border: `1px solid ${T.border}`,
            borderRadius: 16,
            padding: 18,
            overflow: "hidden",
          }}
        >
          <BranchCompareChart
            branches={branches}
            templateModel={templateModel}
            showPayroll={showPayroll}
            filter={dateFilter}
          />
        </section>

        <section
          style={{
            background: T.card,
            border: `1px solid ${T.border}`,
            borderRadius: 16,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "16px 18px",
              borderBottom: `1px solid ${T.border}`,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
            }}
          >
            <div>
              <div style={{ fontSize: 15, fontWeight: 900, color: T.head }}>
                {branchSingular} Directory
              </div>
              <div style={{ fontSize: 12, color: T.muted, marginTop: 3 }}>
                Click a branch to open its scoped dashboard.
              </div>
            </div>
            <div style={{ fontSize: 12, color: T.muted }}>
              {branches.length}{" "}
              {lowerLabel(
                pluralCountLabel(branches.length, branchSingular, branchPlural),
              )}
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: tableGridTemplate,
                minWidth: tableMinWidth,
                padding: "10px 18px",
                background: T.teal50,
                borderBottom: `1px solid ${T.border}`,
                fontSize: 10,
                fontWeight: 900,
                color: T.muted,
                textTransform: "uppercase",
                letterSpacing: ".08em",
              }}
            >
              <div>{branchSingular}</div>
              <div>{peoplePlural}</div>
              <div>Attendance</div>
              <div>Avg. Present</div>
              {showPayroll && <div>Payroll</div>}
              <div>Avg. Late</div>
              <div>Action</div>
            </div>

            {branches.map((branch, index) => {
              const branchDashboardId = getBranchDashboardId(branch);
              const branchDashboardPath = getBranchDashboardPath(branch);
              const branchName = getBranchDisplayName(branch);
              const branchAttendance = periodAttendance?.branches.get(
                getBranchMetricKey(branch),
              );
              const averagePresent =
                periodAttendance?.dayCount
                  ? Math.min(
                      branch.staffCount,
                      (branchAttendance?.totalDailyPresent ?? 0) /
                        periodAttendance.dayCount,
                    )
                  : null;
              const averageLate =
                periodAttendance?.dayCount
                  ? (branchAttendance?.totalDailyLate ?? 0) /
                    periodAttendance.dayCount
                  : null;
              const attendanceRate =
                averagePresent !== null && branch.staffCount
                  ? (averagePresent / branch.staffCount) * 100
                  : 0;
              const branchPayroll = periodPayroll?.branches.get(
                getBranchMetricKey(branch),
              );

              return (
                <div
                  key={branchDashboardId ?? `${branchName}-${index}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: tableGridTemplate,
                    minWidth: tableMinWidth,
                    padding: "13px 18px",
                    borderBottom: `1px solid ${T.teal50}`,
                    alignItems: "center",
                    fontSize: 12,
                    color: T.head,
                  }}
                >
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 10 }}
                  >
                    <div
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 10,
                        background: T.teal50,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      <MapPin size={16} color={T.teal600} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 900, color: T.head }}>
                        {getBranchDisplayName(branch)}
                      </div>
                      <div
                        style={{ color: T.muted, fontSize: 11, marginTop: 2 }}
                      >
                        {getBranchLocation(branch) || "No city set"}
                      </div>
                    </div>
                  </div>
                  <div>
                    <strong>{branch.staffCount}</strong>
                    <span style={{ color: T.muted }}>
                      {" "}
                      {lowerLabel(
                        pluralCountLabel(
                          branch.staffCount,
                          peopleSingular,
                          peoplePlural,
                        ),
                      )}
                    </span>
                  </div>
                  <div style={{ fontWeight: 900, color: T.teal600 }}>
                    {averagePresent === null ? "—" : `${Math.round(attendanceRate)}%`}
                  </div>
                  <div>
                    <strong>
                      {averagePresent === null
                        ? "—"
                        : averagePresent.toLocaleString(undefined, {
                            maximumFractionDigits: 1,
                          })}
                    </strong>
                    <span style={{ color: T.muted }}>
                      {" "}
                      / {branch.staffCount}
                    </span>
                  </div>
                  {showPayroll && (
                    <div style={{ fontWeight: 900, color: T.navy600 }}>
                      {periodPayroll === null
                        ? "—"
                        : formatMoney(branchPayroll ?? 0)}
                    </div>
                  )}
                  <div
                    style={{
                      color: averageLate ? "#D97706" : T.muted,
                    }}
                  >
                    {averageLate === null
                      ? "—"
                      : averageLate.toLocaleString(undefined, {
                          maximumFractionDigits: 1,
                        })}
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {branchDashboardPath ? (
                      <Link
                        to={branchDashboardPath}
                        aria-label={`Open ${branchName} dashboard`}
                        onClick={(event) => event.stopPropagation()}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 6,
                          height: 30,
                          minWidth: 82,
                          padding: "0 12px",
                          borderRadius: 8,
                          border: "1px solid transparent",
                          background: T.teal600,
                          color: "#ffffff",
                          fontSize: 12,
                          fontWeight: 800,
                          textDecoration: "none",
                          cursor: "pointer",
                          fontFamily: "inherit",
                          lineHeight: 1,
                          whiteSpace: "nowrap",
                        }}
                      >
                        <CalendarClock size={13} />
                        Open
                      </Link>
                    ) : (
                      <button
                        type="button"
                        disabled
                        title={`${branchSingular} id missing`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 6,
                          height: 30,
                          minWidth: 82,
                          padding: "0 12px",
                          borderRadius: 8,
                          border: `1px solid ${T.border}`,
                          background: T.slate50,
                          color: T.muted,
                          fontSize: 12,
                          fontWeight: 800,
                          fontFamily: "inherit",
                          lineHeight: 1,
                          whiteSpace: "nowrap",
                          cursor: "not-allowed",
                          opacity: 0.65,
                        }}
                      >
                        <CalendarClock size={13} />
                        Open
                      </button>
                    )}

                  </div>
                </div>
              );
            })}

            {branches.length === 0 && (
              <div style={{ padding: 24, textAlign: "center", color: T.muted }}>
                No {lowerLabel(branchPlural)} found for this organization.
              </div>
            )}
          </div>
        </section>
      </ModuleShell>
    </div>
  );
};

export default BranchesModule;
