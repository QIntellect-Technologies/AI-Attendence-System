import React, { useState } from "react";
import { Download, GitBranch, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useInstallToken } from "../../hooks/useInstallToken";
import InstallTokenModal from "../../components/InstallTokenModal";
import {
  SupportPageShell,
  supportTheme,
} from "../../components/SupportPageShell";
import { SupportToolbar } from "../../components/SupportToolbar";
import {
  SupportTable,
  type SupportColumn,
} from "../../components/SupportTable";
import { SupportPagination } from "../../components/SupportPagination";
import { SupportStatusBadge } from "../../components/SupportStatusBadge";
import { SupportErrorBanner } from "../../components/SupportErrorBanner";
import { useBranchesPage } from "./hooks/useBranchesPage";
import { branchesPageApi, type GlobalBranchRow } from "./api/branchesApi";

const isLocalAttendance = (value?: string | null): boolean =>
  String(value || "")
    .trim()
    .toLowerCase() === "local";

export default function BranchesPage() {
  const nav = useNavigate();
  const state = useBranchesPage();
  const {
    token,
    isGenerating,
    error: tokenError,
    generate,
    clear,
  } = useInstallToken((orgId, branchId) =>
    branchesPageApi.createInstallToken(orgId, branchId),
  );
  const [generatingBranchId, setGeneratingBranchId] = useState<string | null>(
    null,
  );

  const handleGenerateToken = async (branch: GlobalBranchRow) => {
    if (!isLocalAttendance(branch.attendance_mode)) return;
    setGeneratingBranchId(branch.id);
    await generate(branch.org_id, branch.branch_id || branch.id);
    setGeneratingBranchId(null);
  };

  const actionStyle: React.CSSProperties = {
    border: "1px solid #dbe4ef",
    background: "#fff",
    borderRadius: 9,
    padding: "7px 10px",
    fontSize: 12,
    fontWeight: 800,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
  };

  const columns: SupportColumn<GlobalBranchRow>[] = [
    {
      key: "branch",
      header: "Branch",
      render: (row) => (
        <>
          <strong>{row.name}</strong>
          {row.location && (
            <div style={{ color: supportTheme.muted, fontSize: 11 }}>
              {row.location}
            </div>
          )}
        </>
      ),
    },
    {
      key: "organization",
      header: "Organization",
      render: (row) => (
        <>
          <span
            role="button"
            onClick={() => nav(`/support/organizations/${row.org_id}`)}
            style={{
              color: supportTheme.blue,
              fontWeight: 800,
              cursor: "pointer",
            }}
          >
            {row.organization_name}
          </span>
          {row.organization_email && (
            <div style={{ color: supportTheme.muted, fontSize: 11 }}>
              {row.organization_email}
            </div>
          )}
        </>
      ),
    },
    {
      key: "attendance_mode",
      header: "Mode",
      render: (row) => <SupportStatusBadge value={row.attendance_mode} />,
    },
    {
      key: "capacity",
      header: "Max Staff",
      render: (row) =>
        row.max_staff_capacity === null || row.max_staff_capacity === undefined
          ? "—"
          : row.max_staff_capacity,
    },
    {
      key: "fallback",
      header: "Fallback",
      render: (row) => (
        <SupportStatusBadge
          value={row.fallback_active ? "active" : "inactive"}
        />
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row) => <SupportStatusBadge value={row.status} />,
    },
    {
      key: "actions",
      header: "Actions",
      render: (row) =>
        isLocalAttendance(row.attendance_mode) ? (
          <button
            type="button"
            style={actionStyle}
            disabled={isGenerating && generatingBranchId === row.id}
            onClick={() => void handleGenerateToken(row)}
          >
            <Download size={13} />
            {isGenerating && generatingBranchId === row.id
              ? "Generating…"
              : "Install Token"}
          </button>
        ) : (
          "—"
        ),
    },
  ];

  return (
    <SupportPageShell
      title="Branches"
      icon={<GitBranch size={20} color={supportTheme.teal} />}
      subtitle="All branches across every organization, with attendance mode, fallback status, and local node install tokens."
    >
      <SupportToolbar
        search={state.search}
        onSearchChange={(value) => {
          state.setPage(1);
          state.setSearch(value);
        }}
        searchPlaceholder="Search branch, location, organization…"
        filters={[
          {
            value: state.status,
            onChange: (value) => {
              state.setPage(1);
              state.setStatus(value);
            },
            label: "Status",
            options: [
              { value: "all", label: "All" },
              { value: "active", label: "Active" },
              { value: "archived", label: "Archived" },
              { value: "dropped", label: "Dropped" },
            ],
          },
        ]}
      />
      <SupportErrorBanner message={state.error} />
      <SupportTable
        columns={columns}
        rows={state.rows}
        getRowKey={(row) => row.id}
        isLoading={state.isLoading}
        emptyText="No branches found."
      />
      <SupportPagination
        page={state.page}
        onPageChange={state.setPage}
        disabled={state.isLoading}
      />
      <div
        style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}
      >
        <button
          type="button"
          onClick={() => void state.refresh()}
          style={actionStyle}
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>
      {token && <InstallTokenModal token={token} onClose={clear} />}
      {tokenError && <SupportErrorBanner message={tokenError} />}
    </SupportPageShell>
  );
}
