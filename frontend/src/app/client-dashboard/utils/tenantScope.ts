/**
 * src/app/utils/tenantScope.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Central UUID-safe tenant and branch identity helpers.
 *
 * Rules:
 * - organization_id is the tenant boundary and must be present for tenant data.
 * - UI branch ids (1, 2, 3) are route/display ids only.
 * - Supabase/backend branch UUIDs are used for API calls for UUID tenants.
 * - Legacy numeric tenants keep numeric branch ids for old SQLite routes.
 */

export type TenantId = number | string;
export type MaybeTenantId = TenantId | null | undefined;

export interface BranchIdentity {
  id?: number | string | null;
  branchId?: number | string | null;
  branch_id?: number | string | null;
  branchUiId?: number | string | null;
  branch_ui_id?: number | string | null;
  backendBranchId?: number | string | null;
  backend_branch_id?: number | string | null;
  branchUuid?: number | string | null;
  branch_uuid?: number | string | null;
  name?: string | null;
  branchName?: string | null;
  branch_name?: string | null;
}

export interface TenantScopeInput {
  organizationId?: MaybeTenantId;
  organization_id?: MaybeTenantId;
  org_id?: MaybeTenantId;
  branchId?: MaybeTenantId;
  branch_id?: MaybeTenantId;
  backendBranchId?: MaybeTenantId;
  backend_branch_id?: MaybeTenantId;
  branchUuid?: MaybeTenantId;
  branch_uuid?: MaybeTenantId;
}

export interface ResolvedTenantScope {
  organizationId: string;
  uiBranchId: number | null;
  backendBranchId: string | null;
  apiBranchId: string | number | null;
  isUuidTenant: boolean;
}

const EMPTY_WORDS = new Set(["", "null", "none", "undefined", "all", "all_branches"]);

export function cleanId(value: unknown): string {
  const text = String(value ?? "").trim();
  return EMPTY_WORDS.has(text.toLowerCase()) ? "" : text;
}

export function toPositiveNumber(value: unknown): number | null {
  const text = cleanId(value);
  if (!text) return null;
  const numberValue = Number(text);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

export function isPositiveNumericId(value: unknown): boolean {
  const text = cleanId(value);
  if (!text) return false;
  const numberValue = Number(text);
  return Number.isInteger(numberValue) && numberValue > 0 && String(numberValue) === text;
}

export function isUuidLike(value: unknown): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanId(value));
}

export function isUuidTenant(value: unknown): boolean {
  const text = cleanId(value);
  return Boolean(text && !isPositiveNumericId(text));
}

export function readStoredOrganizationId(): string {
  try {
    const raw = localStorage.getItem("currentUser");
    if (!raw) return "";
    const user = JSON.parse(raw) as Record<string, unknown>;
    return cleanId(user.organization_id ?? user.organizationId ?? user.org_id ?? user.orgId);
  } catch {
    return "";
  }
}

export function getOrganizationId(input: TenantScopeInput = {}): string {
  return cleanId(input.organization_id ?? input.organizationId ?? input.org_id) || readStoredOrganizationId();
}

export function branchIdentityValues(branch: BranchIdentity | null | undefined): string[] {
  if (!branch) return [];
  return [
    branch.id,
    branch.branchId,
    branch.branch_id,
    branch.branchUiId,
    branch.branch_ui_id,
    branch.backendBranchId,
    branch.backend_branch_id,
    branch.branchUuid,
    branch.branch_uuid,
  ]
    .map(cleanId)
    .filter(Boolean);
}

export function getBackendBranchId(branch: BranchIdentity | null | undefined): string | null {
  if (!branch) return null;
  const candidates = [
    branch.backendBranchId,
    branch.backend_branch_id,
    branch.branchUuid,
    branch.branch_uuid,
  ];
  for (const candidate of candidates) {
    const text = cleanId(candidate);
    if (text && !isPositiveNumericId(text)) return text;
  }
  return null;
}

export function getUiBranchId(branch: BranchIdentity | null | undefined): number | null {
  if (!branch) return null;
  return (
    toPositiveNumber(branch.branchUiId) ??
    toPositiveNumber(branch.branch_ui_id) ??
    toPositiveNumber(branch.id) ??
    toPositiveNumber(branch.branchId) ??
    toPositiveNumber(branch.branch_id)
  );
}

export function resolveBranchFromList(
  branches: BranchIdentity[] = [],
  rawBranchId?: MaybeTenantId,
): BranchIdentity | null {
  const wanted = cleanId(rawBranchId);
  if (!wanted) return null;

  return (
    branches.find((branch) => branchIdentityValues(branch).includes(wanted)) ??
    branches.find((branch) => String(getUiBranchId(branch) ?? "") === wanted) ??
    null
  );
}

export function resolveTenantScope(
  input: TenantScopeInput = {},
  branches: BranchIdentity[] = [],
): ResolvedTenantScope {
  const organizationId = getOrganizationId(input);
  if (!organizationId) {
    throw new Error("organization_id is required for tenant-scoped requests.");
  }

  const rawBranch =
    input.backend_branch_id ??
    input.backendBranchId ??
    input.branch_uuid ??
    input.branchUuid ??
    input.branch_id ??
    input.branchId ??
    null;

  const branch = resolveBranchFromList(branches, rawBranch);
  const uiBranchId = getUiBranchId(branch) ?? toPositiveNumber(rawBranch);
  const backendBranchId =
    getBackendBranchId(branch) ??
    (isPositiveNumericId(rawBranch) ? null : cleanId(rawBranch) || null);

  const uuidTenant = isUuidTenant(organizationId);

  return {
    organizationId,
    uiBranchId,
    backendBranchId,
    apiBranchId: uuidTenant ? backendBranchId : uiBranchId,
    isUuidTenant: uuidTenant,
  };
}

/**
 * Resolves a UI ordinal branch id (1, 2, 3…) to the identifier a
 * branch-scoped backend endpoint actually accepts for this tenant -- the
 * real Supabase branch UUID for UUID tenants, the same ordinal for legacy
 * numeric tenants. This is the single canonical resolver for that
 * translation (wraps resolveTenantScope) -- every branch-scoped write
 * path (staff, shifts, departments, capture settings, visit plans) must
 * go through this rather than sending branch.id straight from UI state,
 * because that id is never a valid value on the backend for UUID
 * tenants.
 *
 * Returns null (never a guessed/raw fallback) when the branch can't be
 * resolved, so a caller can show "not available" / disable the action
 * instead of silently sending a broken id that the backend will reject.
 */
export function resolveApiBranchId(
  organizationId: MaybeTenantId,
  uiBranchId: MaybeTenantId,
  branches: BranchIdentity[] = [],
): string | null {
  if (!cleanId(organizationId) || toPositiveNumber(uiBranchId) === null) {
    return null;
  }

  const scope = resolveTenantScope({ organizationId, branchId: uiBranchId }, branches);
  return scope.apiBranchId !== null && scope.apiBranchId !== undefined
    ? String(scope.apiBranchId)
    : null;
}

export function appendTenantQuery(
  query: URLSearchParams,
  input: TenantScopeInput = {},
  branches: BranchIdentity[] = [],
): URLSearchParams {
  const scope = resolveTenantScope(input, branches);
  query.set("organization_id", scope.organizationId);

  if (scope.apiBranchId !== null && scope.apiBranchId !== undefined && cleanId(scope.apiBranchId)) {
    query.set("branch_id", String(scope.apiBranchId));
  }

  return query;
}

export function scopedQueryString(
  input: TenantScopeInput = {},
  branches: BranchIdentity[] = [],
): string {
  return appendTenantQuery(new URLSearchParams(), input, branches).toString();
}