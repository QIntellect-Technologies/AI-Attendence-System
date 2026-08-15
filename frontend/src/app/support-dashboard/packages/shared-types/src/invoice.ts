/**
 * packages/shared-types/src/invoice.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Invoice + Subscription types.
 *
 * Design doc ref — Section 6 (Billing Lifecycle):
 *   Access status is computed LIVE from invoice data — never stored as a flag.
 *   is_org_access_active() logic lives on Flask API, not the dashboard.
 */

import type { BillingCycle } from "./organization";

export type InvoiceStatus = "pending" | "paid" | "overdue";

export interface Invoice {
  id: string;
  org_id: string;
  invoice_number?: string | null;
  amount: number;
  due_date: string;
  grace_period_days: number;
  status: InvoiceStatus;
  paid_at: string | null;
  marked_paid_by: string | null;
  notes: string | null;
  sent_at?: string | null;
  sent_by?: string | null;
  sent_method?: "manual" | "email" | string | null;
  sent_to?: string | null;
  sent_subject?: string | null;
  sent_message_snapshot?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Subscription {
  id: string;
  org_id: string;
  billing_cycle: BillingCycle;
  current_period_start: string;
  current_period_end: string;
}

export interface MarkInvoicePaidPayload {
  invoice_id: string;
  paid_at?: string; // defaults to now() on server if omitted
}

export interface UpdateInvoiceGracePayload {
  invoice_id: string;
  grace_period_days: number;
}
