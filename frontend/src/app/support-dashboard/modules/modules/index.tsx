import React from "react";
import { Grid3X3 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { SupportPageShell } from "../../components/SupportPageShell";
import { SupportToolbar } from "../../components/SupportToolbar";
import { SupportTable, type SupportColumn } from "../../components/SupportTable";
import { SupportPagination } from "../../components/SupportPagination";
import { SupportStatusBadge } from "../../components/SupportStatusBadge";
import { SupportErrorBanner } from "../../components/SupportErrorBanner";
import { useModuleEntitlementsPage } from "./hooks/useModuleEntitlementsPage";
import { MODULE_DEFINITIONS, type GlobalModuleEntitlementRow } from "./api/modulesApi";

const moduleOptions = [{ value: "all", label: "All Modules" }, ...MODULE_DEFINITIONS.map((m) => ({ value: m.key, label: m.label }))];
const labelForModule = (key: string) => MODULE_DEFINITIONS.find((m) => m.key === key)?.label || key;
export default function ModuleEntitlementsPage() {
  const nav = useNavigate();
  const state = useModuleEntitlementsPage();
  const columns: SupportColumn<GlobalModuleEntitlementRow>[] = [
    { key: "org", header: "Organization", render: (r) => <><strong>{r.organization_name}</strong><div style={{ color: "#64748b", fontSize: 11 }}>{r.organization_email || r.org_id}</div></> },
    { key: "module", header: "Module", render: (r) => <strong>{labelForModule(r.module_name)}</strong> },
    { key: "status", header: "Status", render: (r) => <SupportStatusBadge value={r.status} /> },
    { key: "purchased", header: "Purchased", render: (r) => r.purchased_at ? new Date(r.purchased_at).toLocaleDateString() : "—" },
    { key: "actions", header: "Actions", render: (r) => <button onClick={() => nav(`/support/organizations/${r.org_id}`)} style={actionStyle}>Edit in Org →</button> },
  ];
  return <SupportPageShell title="Module Entitlements" icon={<Grid3X3 size={20} color="#0d9488" />} subtitle="Global overview of purchased modules. Editing remains organization-scoped for tenant safety.">
    <SupportToolbar search={state.search} onSearchChange={state.setSearch} searchPlaceholder="Search organization or module…" filters={[{ value: state.module, onChange: state.setModule, label: "Module", options: moduleOptions }, { value: state.status, onChange: state.setStatus, label: "Status", options: [{ value: "all", label: "All Statuses" }, { value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }] }]} />
    <SupportErrorBanner message={state.error} />
    <SupportTable columns={columns} rows={state.rows} getRowKey={(r) => r.id} isLoading={state.isLoading} emptyText="No module entitlements found." />
    <SupportPagination page={state.page} onPageChange={state.setPage} disabled={state.isLoading} />
  </SupportPageShell>;
}
const actionStyle: React.CSSProperties = { border: "1px solid #dbe4ef", background: "#fff", borderRadius: 9, padding: "7px 10px", fontSize: 12, fontWeight: 800, cursor: "pointer" };
