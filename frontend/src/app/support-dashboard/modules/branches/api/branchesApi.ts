import { supportApiClient } from "../../../api/supportApiClient";
import type { InstallTokenResult } from "../../../hooks/useInstallToken";

export interface GlobalBranchRow { id: string; branch_id: string; org_id: string; organization_id: string; organization_name: string; organization_email?: string | null; organization_status?: string | null; name: string; location?: string | null; max_staff_capacity?: number | null; fallback_active?: boolean; attendance_mode?: string | null; status?: string }
export interface PageMeta { page: number; page_size: number; total: number; total_pages: number; has_more: boolean }
interface Envelope { success: boolean; branches: GlobalBranchRow[]; page: PageMeta }
interface InstallTokenEnvelope { success: boolean; install_token: InstallTokenResult }
export interface BranchQuery { page?: number; page_size?: number; search?: string; status?: string }

const buildQuery = (query: BranchQuery) => { const p = new URLSearchParams(); Object.entries(query).forEach(([k, v]) => { if (v !== undefined && String(v).trim()) p.set(k, String(v)); }); const s = p.toString(); return s ? `?${s}` : ""; };

export const branchesPageApi = {
    list: (query: BranchQuery) =>
        supportApiClient.get<Envelope>(`/v1/support/branches${buildQuery(query)}`).then((r) => ({ rows: r.data.branches || [], page: r.data.page })),

    createInstallToken: (orgId: string, branchId: string, ttlDays = 7) =>
        supportApiClient
            .post<InstallTokenEnvelope>(
                `/v1/support/organizations/${encodeURIComponent(orgId)}/branches/${encodeURIComponent(branchId)}/install-token`,
                { ttl_days: ttlDays },
            )
            .then((r) => r.data.install_token),
};