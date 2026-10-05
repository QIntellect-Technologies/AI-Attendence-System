import { supportApiClient } from "../../../api/supportApiClient";
import { MODULE_DEFINITIONS } from "../../organizations/api/organizationsApi";

export { MODULE_DEFINITIONS };
export interface GlobalModuleEntitlementRow { id: string; org_id: string; organization_id: string; organization_name: string; organization_email?: string | null; organization_status?: string | null; module_name: string; status: string; purchased_at?: string | null; created_at?: string | null }
export interface PageMeta { page: number; page_size: number; total: number; total_pages: number; has_more: boolean }
interface Envelope { success: boolean; entitlements: GlobalModuleEntitlementRow[]; page: PageMeta }
export interface ModuleQuery { page?: number; page_size?: number; search?: string; module?: string; status?: string }
const buildQuery = (query: ModuleQuery) => { const p = new URLSearchParams(); Object.entries(query).forEach(([k,v]) => { if (v !== undefined && String(v).trim()) p.set(k, String(v)); }); const s = p.toString(); return s ? `?${s}` : ""; };
export const modulesPageApi = { list: (query: ModuleQuery) => supportApiClient.get<Envelope>(`/v1/support/modules/entitlements${buildQuery(query)}`).then((r) => ({ rows: r.data.entitlements || [], page: r.data.page })) };
