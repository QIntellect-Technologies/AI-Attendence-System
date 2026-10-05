import React from "react";
import { Activity } from "lucide-react";
import { SupportPageShell } from "../../components/SupportPageShell";
import { SupportToolbar } from "../../components/SupportToolbar";
import { SupportTable, type SupportColumn } from "../../components/SupportTable";
import { SupportPagination } from "../../components/SupportPagination";
import { SupportStatusBadge } from "../../components/SupportStatusBadge";
import { SupportErrorBanner } from "../../components/SupportErrorBanner";
import { useNodeHealthPage } from "./hooks/useNodeHealthPage";
import type { GlobalNodeHealthRow } from "./api/nodehealthApi";

const since = (m?: number | null) => m == null ? "—" : m < 1 ? "just now" : `${Math.round(m)} min ago`;
export default function NodeHealthPage() {
  const state = useNodeHealthPage();
  const columns: SupportColumn<GlobalNodeHealthRow>[] = [
    { key: "node", header: "Node", render: (r) => <><strong>{r.node_label || r.node_id || "Not activated"}</strong><div style={{ color: "#64748b", fontSize: 11 }}>{r.hostname || r.branch_name}</div></> },
    { key: "org", header: "Organization / Branch", render: (r) => <><strong>{r.organization_name}</strong><div style={{ color: "#64748b", fontSize: 11 }}>{r.branch_name}</div></> },
    { key: "status", header: "Status", render: (r) => <SupportStatusBadge value={r.status} /> },
    { key: "last", header: "Last Seen", render: (r) => since(r.minutes_since_seen) },
    { key: "fallback", header: "Fallback", render: (r) => <SupportStatusBadge value={r.fallback_active ? "active" : "inactive"} /> },
    { key: "error", header: "Last Error", render: (r) => r.last_error || "—" },
  ];
  return <SupportPageShell title="Node Health" icon={<Activity size={20} color="#0d9488" />} subtitle="Global local-node monitoring. The page is branch scoped and does not call every organization detail endpoint.">
    <SupportToolbar search={state.search} onSearchChange={state.setSearch} searchPlaceholder="Search node, branch, organization, error…" filters={[{ value: state.status, onChange: state.setStatus, label: "Status", options: [{ value: "all", label: "All" }, { value: "online", label: "Online" }, { value: "offline", label: "Offline" }, { value: "never_connected", label: "Never Connected" }] }]} />
    <SupportErrorBanner message={state.error} />
    <SupportTable columns={columns} rows={state.rows} getRowKey={(r) => r.id} isLoading={state.isLoading} emptyText="No node health rows found." />
    <SupportPagination page={state.page} onPageChange={state.setPage} disabled={state.isLoading} />
  </SupportPageShell>;
}
