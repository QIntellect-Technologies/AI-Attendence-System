import { supportApiClient } from "../../../api/supportApiClient";

export interface GlobalNodeHealthRow { id: string; branch_id: string; branch_name: string; org_id: string; organization_id: string; organization_name: string; organization_status?: string | null; attendance_mode?: string | null; fallback_active: boolean; node_id?: string | null; node_label?: string | null; status: string; last_seen_at?: string | null; minutes_since_seen?: number | null; configured_cameras?: number | null; last_error?: string | null; hostname?: string | null; agent_version?: string | null }
export interface PageMeta { page: number; page_size: number; total: number; total_pages: number; has_more: boolean }
interface Envelope { success: boolean; node_health: GlobalNodeHealthRow[]; page: PageMeta }
export interface NodeHealthQuery { page?: number; page_size?: number; search?: string; status?: string }
const buildQuery = (query: NodeHealthQuery) => { const p = new URLSearchParams(); Object.entries(query).forEach(([k,v]) => { if (v !== undefined && String(v).trim()) p.set(k, String(v)); }); const s = p.toString(); return s ? `?${s}` : ""; };
export const nodeHealthPageApi = { list: (query: NodeHealthQuery) => supportApiClient.get<Envelope>(`/v1/support/node-health${buildQuery(query)}`).then((r) => ({ rows: r.data.node_health || [], page: r.data.page })) };
