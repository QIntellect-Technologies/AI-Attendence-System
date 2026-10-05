/**
 * modules/staff/api/hierarchyApi.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Frontend client for the manager-hierarchy routes in
 * client_staff_hierarchy_routes.py (support_db_hierarchy.py on the backend).
 *
 * These are /api/client/* routes — a different prefix/auth convention than
 * staffApi.ts's /api/staff/* routes — so this file goes through
 * fetchClientJson (clintApi.ts), not staffJson (staffApi.ts's own fetch
 * helper). Keeping it in its own file rather than folding it into staffApi.ts
 * mirrors the "one file per concern" pattern already used across the
 * backend (support_db_hierarchy.py alongside support_db_shifts.py, etc.).
 */

import { fetchClientJson } from "../../../services/clintApi";

export interface ManagerChainLink {
  id: string;
  name: string;
  people_type: string | null;
  manager_id: string | null;
  linked_client_user_id: string | null;
  manager_label: string;
}

export interface DirectReport {
  id: string;
  name: string;
  people_type: string | null;
  department_id?: string | null;
  branch_id?: string | null;
}

export interface OrgClientUser {
  id: string;
  name: string;
  email?: string | null;
}

interface StaffEnvelope {
  success: boolean;
  message?: string;
  staff: Record<string, unknown>;
}

function qs(organizationId: string | number): string {
  return `organization_id=${encodeURIComponent(String(organizationId))}`;
}

/**
 * Assign (or clear, if managerId is null/empty) a staff member's manager.
 * Deliberately does NOT touch the linked dashboard account — see
 * setLinkedAccount below, which is a one-time-per-manager setting rather
 * than something re-sent on every report's assignment.
 */
export async function assignManager(
  organizationId: string | number,
  staffId: string | number,
  managerId: string | null,
): Promise<StaffEnvelope> {
  return fetchClientJson<StaffEnvelope>(
    `/api/client/staff/${encodeURIComponent(String(staffId))}/manager`,
    {
      method: "PATCH",
      body: JSON.stringify({
        organization_id: organizationId,
        manager_id: managerId || null,
      }),
    },
  );
}

/**
 * Set (or clear) a staff member's OWN linked dashboard account — call this
 * on a manager's profile, once, regardless of how many people report to
 * them. This is the only mutation that writes linked_client_user_id.
 */
export async function setLinkedAccount(
  organizationId: string | number,
  staffId: string | number,
  clientUserId: string | null,
): Promise<StaffEnvelope> {
  return fetchClientJson<StaffEnvelope>(
    `/api/client/staff/${encodeURIComponent(String(staffId))}/linked-account`,
    {
      method: "PATCH",
      body: JSON.stringify({
        organization_id: organizationId,
        client_user_id: clientUserId || null,
      }),
    },
  );
}

/** Ordered list from this staff member's immediate manager up to the top —
 * [] if none is assigned. */
export async function getManagerChain(
  organizationId: string | number,
  staffId: string | number,
): Promise<ManagerChainLink[]> {
  const body = await fetchClientJson<{
    success: boolean;
    manager_chain: ManagerChainLink[];
  }>(
    `/api/client/staff/${encodeURIComponent(String(staffId))}/manager-chain?${qs(organizationId)}`,
  );
  return Array.isArray(body.manager_chain) ? body.manager_chain : [];
}

/** Everyone whose manager_id points at this staff member — one level, not
 * the full subtree. */
export async function getDirectReports(
  organizationId: string | number,
  staffId: string | number,
): Promise<DirectReport[]> {
  const body = await fetchClientJson<{
    success: boolean;
    reports: DirectReport[];
  }>(
    `/api/client/staff/${encodeURIComponent(String(staffId))}/reports?${qs(organizationId)}`,
  );
  return Array.isArray(body.reports) ? body.reports : [];
}

/** Read-only list of this org's client_users (dashboard admin accounts) —
 * populates the "linked dashboard account" picker. */
export async function listOrgClientUsers(
  organizationId: string | number,
): Promise<OrgClientUser[]> {
  const body = await fetchClientJson<{
    success: boolean;
    users: OrgClientUser[];
  }>(`/api/client/org-users?${qs(organizationId)}`);
  return Array.isArray(body.users) ? body.users : [];
}