import React from "react";
import { Receipt } from "lucide-react";
import { SupportPageShell } from "../../components/SupportPageShell";
import { SupportToolbar } from "../../components/SupportToolbar";
import { SupportTable, type SupportColumn } from "../../components/SupportTable";
import { SupportPagination } from "../../components/SupportPagination";
import { SupportStatusBadge } from "../../components/SupportStatusBadge";
import { SupportErrorBanner } from "../../components/SupportErrorBanner";
import { useInvoicesPage } from "./hooks/useInvoicesPage";
import type { GlobalInvoiceRow } from "./api/invoicesApi";

const money = (v: unknown) => `PKR ${Number(v || 0).toLocaleString()}`;
export default function InvoicesPage() {
  const state = useInvoicesPage();
  const columns: SupportColumn<GlobalInvoiceRow>[] = [
    { key: "org", header: "Organization", render: (r) => <><strong>{r.organization_name}</strong><div style={{ color: "#64748b", fontSize: 11 }}>{r.organization_email || r.org_id}</div></> },
    { key: "amount", header: "Amount", render: (r) => <strong>{money(r.amount)}</strong> },
    { key: "due", header: "Due Date", render: (r) => r.due_date || "—" },
    { key: "grace", header: "Grace", render: (r) => `${r.grace_period_days ?? 0} days` },
    { key: "status", header: "Status", render: (r) => <SupportStatusBadge value={r.status} /> },
    { key: "paid", header: "Paid At", render: (r) => r.paid_at ? new Date(r.paid_at).toLocaleDateString() : "—" },
  ];
  return <SupportPageShell title="Invoices" icon={<Receipt size={20} color="#0d9488" />} subtitle="Global billing center across all organizations. Organization-specific invoice actions are also available inside Organization Detail → Billing.">
    <SupportToolbar search={state.search} onSearchChange={state.setSearch} searchPlaceholder="Search organization, invoice, notes…" filters={[{ value: state.status, onChange: state.setStatus, label: "Status", options: [{ value: "all", label: "All" }, { value: "pending", label: "Pending" }, { value: "paid", label: "Paid" }, { value: "overdue", label: "Overdue" }, { value: "cancelled", label: "Cancelled" }] }]} />
    <SupportErrorBanner message={state.error} />
    <SupportTable columns={columns} rows={state.rows} getRowKey={(r) => r.id} isLoading={state.isLoading} emptyText="No invoices found." />
    <SupportPagination page={state.page} onPageChange={state.setPage} disabled={state.isLoading} />
  </SupportPageShell>;
}
