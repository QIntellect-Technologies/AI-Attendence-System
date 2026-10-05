import { supportApiClient } from "../../../api/supportApiClient";

export interface GlobalInvoiceRow { id: string; org_id: string; organization_id: string; organization_name: string; organization_email?: string | null; organization_status?: string | null; amount: number; due_date: string; grace_period_days?: number; status: string; paid_at?: string | null; notes?: string | null; created_at?: string | null }
export interface PageMeta { page: number; page_size: number; total: number; total_pages: number; has_more: boolean }
interface Envelope { success: boolean; invoices: GlobalInvoiceRow[]; page: PageMeta }
export interface InvoiceQuery { page?: number; page_size?: number; search?: string; status?: string }
const buildQuery = (query: InvoiceQuery) => { const p = new URLSearchParams(); Object.entries(query).forEach(([k,v]) => { if (v !== undefined && String(v).trim()) p.set(k, String(v)); }); const s = p.toString(); return s ? `?${s}` : ""; };
export const invoicesPageApi = { list: (query: InvoiceQuery) => supportApiClient.get<Envelope>(`/v1/support/invoices${buildQuery(query)}`).then((r) => ({ rows: r.data.invoices || [], page: r.data.page })) };
