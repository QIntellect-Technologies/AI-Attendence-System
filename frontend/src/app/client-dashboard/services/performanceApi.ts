import { fetchJson, QueryParams } from "../api/apiClient";

export type FastScope = {
  clientId?: string | number | null;
  orgId?: string | number | null;
  organizationId?: string | number | null;
  organization_id?: string | number | null;
  branchId?: string | number | null;
  branch_id?: string | number | null;
  today?: string | null;
};

export type FastSummaryCards = {
  totalStaff: number;
  activeStaff: number;
  totalBranches: number;
  presentToday: number;
  absentToday: number;
  lateToday: number;
  pendingLeaves: number;
  payrollThisMonth: number;
  monthlyPayroll: number;
  attendanceRate: number;
};

export type FastSummaryResponse = {
  success: boolean;
  cached?: boolean;
  cards: Partial<FastSummaryCards>;
  totals?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  scope?: FastScope | string;
  tables?: Record<string, string | null>;
  message?: string;
  error?: string;
};

export type DashboardOverviewResponse = {
  success: boolean;
  cached?: boolean;
  scope?: "global" | "branch" | string;
  branchId?: string | number | null;
  branchName?: string | null;
  branchCity?: string | null;
  title?: string;
  subtitle?: string;
  selectedBranchId?: string | number | null;
  selectedBranchName?: string | null;
  branchFilterOptions?: Array<{ id: string | number; name: string }>;
  stats?: {
    totalBranches?: number;
    totalStaff?: number;
    presentToday?: number;
    absentToday?: number;
    avgAttendance?: number;
    lateToday?: number;
    earlyLeft?: number;
    pendingLeaves?: number;
    monthlyPayroll?: number;
    cctvAlerts?: number;
    [key: string]: unknown;
  };
  staff?: any[];
  liveLog?: any[];
  shiftDistribution?: any[];
  todayStatus?: any[];
  weeklyAttendance?: any[];
  branchWeeklyAttendance?: any[];
  pendingLeaves?: any[];
  cctvStatus?: any[];
  attendancePerformance?: any[];
  branchAttendancePerformance?: any[];
  payrollTrends?: any[];
  branchPayrollTrends?: any[];
  branchPerformance?: any[];
  source?: string;
  message?: string;
  error?: string;
};

export type FastPageEntity =
  | "staff"
  | "employees"
  | "attendance"
  | "payroll"
  | "leaves"
  | "branches";

export type FastPageRequest = FastScope & {
  entity: FastPageEntity;
  page?: number;
  pageSize?: number;
  search?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  periodStart?: string | null; // 'YYYY-MM-DD' — required for payroll's
  periodEnd?: string | null;   // real attendance/leave-derived computation
};

export type FastPageResponse<T = any> = {
  success: boolean;
  cached?: boolean;
  entity: string;
  table?: string;
  rows: T[];
  total: number;
  page: number;
  offset: number;
  pageSize: number;
  hasMore: boolean;
  message?: string;
  error?: string;
};

type RawPageResponse<T = any> = Partial<FastPageResponse<T>> & {
  data?: T[];
  count?: number;
  items?: T[];
  results?: T[];
};

function cleanParam(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;

  const text = String(value).trim();
  const lower = text.toLowerCase();

  if (
    !text ||
    lower === "all" ||
    lower === "all_branches" ||
    lower === "null" ||
    lower === "undefined" ||
    lower === "none"
  ) {
    return undefined;
  }

  return text;
}

function scopeParams(scope: FastScope): QueryParams {
  const organizationId =
    cleanParam(scope.organizationId) ??
    cleanParam(scope.organization_id) ??
    cleanParam(scope.orgId);

  const branchId = cleanParam(scope.branchId) ?? cleanParam(scope.branch_id);

  const clientId = cleanParam(scope.clientId);
  const today = cleanParam(scope.today);

  return {
    clientId,
    client_id: clientId,

    orgId: organizationId,
    org_id: organizationId,
    organizationId,
    organization_id: organizationId,

    branchId,
    branch_id: branchId,

    today,
    date: today,
  };
}

function normalizePageResponse<T>(
  entity: FastPageEntity,
  page: number,
  pageSize: number,
  payload: RawPageResponse<T>,
): FastPageResponse<T> {
  const rows = Array.isArray(payload.rows)
    ? payload.rows
    : Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.items)
        ? payload.items
        : Array.isArray(payload.results)
          ? payload.results
          : [];

  const total =
    Number(payload.total) || Number(payload.count) || rows.length || 0;

  const offset = Number(payload.offset) || Math.max(0, (page - 1) * pageSize);

  return {
    success: payload.success !== false,
    cached: Boolean(payload.cached),
    entity: String(payload.entity || entity),
    table: payload.table,
    rows,
    total,
    page: Number(payload.page || page),
    offset,
    pageSize: Number(payload.pageSize || pageSize),
    hasMore:
      typeof payload.hasMore === "boolean"
        ? payload.hasMore
        : offset + rows.length < total,
    message: payload.message,
    error: payload.error,
  };
}

export async function getTenantFastSummary(
  scope: FastScope,
): Promise<FastSummaryResponse> {
  const payload = await fetchJson<FastSummaryResponse>(
    "/api/v2/tenant/summary",
    scopeParams(scope),
  );

  if (payload.success === false) {
    throw new Error(
      payload.message || payload.error || "Failed to load tenant summary.",
    );
  }

  return {
    ...payload,
    cards: payload.cards || {},
  };
}

export async function getDashboardOverview(
  scope: FastScope & { scope?: "global" | "branch" },
): Promise<DashboardOverviewResponse> {
  const payload = await fetchJson<DashboardOverviewResponse>(
    "/api/v2/dashboard/overview",
    {
      ...scopeParams(scope),
      scope: scope.scope,
    },
  );

  if (payload.success === false) {
    throw new Error(
      payload.message || payload.error || "Failed to load dashboard overview.",
    );
  }

  return {
    ...payload,
    stats: payload.stats || {},
    staff: payload.staff || [],
    liveLog: payload.liveLog || [],
    shiftDistribution: payload.shiftDistribution || [],
    todayStatus: payload.todayStatus || [],
    weeklyAttendance: payload.weeklyAttendance || [],
    branchWeeklyAttendance: payload.branchWeeklyAttendance || [],
    pendingLeaves: payload.pendingLeaves || [],
    cctvStatus: payload.cctvStatus || [],
    attendancePerformance: payload.attendancePerformance || [],
    branchAttendancePerformance: payload.branchAttendancePerformance || [],
    payrollTrends: payload.payrollTrends || [],
    branchPayrollTrends: payload.branchPayrollTrends || [],
    branchPerformance: payload.branchPerformance || [],
  };
}

export async function getFastPage<T = any>(
  request: FastPageRequest,
): Promise<FastPageResponse<T>> {
  const {
    entity,
    page = 1,
    pageSize = 50,
    search,
    sortBy,
    sortDir = "asc",
    periodStart,
    periodEnd,
    ...scope
  } = request;

  const payload = await fetchJson<RawPageResponse<T>>(
    `/api/v2/${entity}/page`,
    {
      ...scopeParams(scope),
      page,
      pageSize,
      page_size: pageSize,
      search: cleanParam(search),
      q: cleanParam(search),
      sortBy: cleanParam(sortBy),
      sort_by: cleanParam(sortBy),
      sortDir,
      sort_dir: sortDir,
      periodStart: cleanParam(periodStart),
      period_start: cleanParam(periodStart),
      periodEnd: cleanParam(periodEnd),
      period_end: cleanParam(periodEnd),
    },
  );

  if (payload.success === false) {
    throw new Error(
      payload.message || payload.error || `Failed to load ${entity} page.`,
    );
  }

  return normalizePageResponse<T>(entity, page, pageSize, payload);
}
