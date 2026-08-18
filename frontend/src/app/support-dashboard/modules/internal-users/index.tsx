import React, { useState } from "react";
import {
  KeyRound,
  Pencil,
  Power,
  RefreshCw,
  UserPlus,
  Users,
} from "lucide-react";
import { SupportPageShell } from "../../components/SupportPageShell";
import { SupportToolbar } from "../../components/SupportToolbar";
import {
  SupportTable,
  type SupportColumn,
} from "../../components/SupportTable";
import { SupportPagination } from "../../components/SupportPagination";
import { SupportStatusBadge } from "../../components/SupportStatusBadge";
import { SupportErrorBanner } from "../../components/SupportErrorBanner";
import { useSupportAuth } from "../../contexts/SupportAuthContext";
import InternalUserModal from "./components/InternalUserModal";
import ResetPasswordModal from "./components/ResetPasswordModal";
import { useInternalUsers } from "./hooks/useInternalUsers";
import type {
  CreateInternalUserPayload,
  InternalUserRow,
  UpdateInternalUserPayload,
} from "./api/internalUsersApi";

const T = {
  border: "#dbe4ef",
  teal: "#0d9488",
  muted: "#64748b",
  text: "#334155",
  teal50: "#ecfdf5",
} as const;

const isSuperAdminRole = (role?: string | null) =>
  String(role || "")
    .trim()
    .toLowerCase() === "super_admin";

export default function InternalUsersPage() {
  const auth = useSupportAuth();
  const state = useInternalUsers();
  const [editing, setEditing] = useState<InternalUserRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<InternalUserRow | null>(null);

  const canManage = isSuperAdminRole(auth.user?.role);

  const columns: SupportColumn<InternalUserRow>[] = [
    {
      key: "user",
      header: "User",
      render: (row) => (
        <>
          <strong>{row.full_name || row.email}</strong>
          <div style={{ color: T.muted, fontSize: 11 }}>{row.email}</div>
        </>
      ),
    },
    {
      key: "role",
      header: "Role",
      render: (row) => <SupportStatusBadge value={row.role} />,
    },
    {
      key: "active",
      header: "Access",
      render: (row) => (
        <SupportStatusBadge value={row.is_active ? "active" : "inactive"} />
      ),
    },
    {
      key: "last",
      header: "Last Login",
      render: (row) =>
        row.last_login_at ? new Date(row.last_login_at).toLocaleString() : "—",
    },
    {
      key: "created",
      header: "Created",
      render: (row) =>
        row.created_at ? new Date(row.created_at).toLocaleDateString() : "—",
    },
    {
      key: "actions",
      header: "Actions",
      render: (row) =>
        canManage ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              style={actionStyle}
              onClick={() => setEditing(row)}
            >
              <Pencil size={13} /> Edit
            </button>
            <button
              type="button"
              style={actionStyle}
              onClick={() => setResetting(row)}
            >
              <KeyRound size={13} /> Reset
            </button>
            <button
              type="button"
              style={actionStyle}
              onClick={() =>
                void state.updateUser(row.id, { is_active: !row.is_active })
              }
            >
              <Power size={13} /> {row.is_active ? "Deactivate" : "Activate"}
            </button>
          </div>
        ) : (
          "—"
        ),
    },
  ];

  const createUser = async (
    payload: CreateInternalUserPayload | UpdateInternalUserPayload,
  ) => {
    await state.createUser(payload as CreateInternalUserPayload);
    setCreating(false);
  };

  const updateUser = async (
    payload: CreateInternalUserPayload | UpdateInternalUserPayload,
  ) => {
    if (!editing) return;
    await state.updateUser(editing.id, payload as UpdateInternalUserPayload);
    setEditing(null);
  };

  const resetPassword = async (password: string) => {
    if (!resetting) return;
    await state.resetPassword(resetting.id, password);
    setResetting(null);
  };

  if (!canManage) {
    return (
      <SupportPageShell
        title="Internal Users"
        icon={<Users size={20} color={T.teal} />}
        subtitle="QIntellect support team accounts."
      >
        <SupportErrorBanner message="Super admin access is required to manage internal users." />
      </SupportPageShell>
    );
  }

  return (
    <SupportPageShell
      title="Internal Users"
      icon={<Users size={20} color={T.teal} />}
      subtitle="Manage QIntellect support accounts, role-based access, activation, and password resets."
    >
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginBottom: 12,
        }}
      >
        <button
          type="button"
          onClick={() => setCreating(true)}
          style={primaryButton}
        >
          <UserPlus size={14} /> New Internal User
        </button>
      </div>
      <SupportToolbar
        search={state.search}
        onSearchChange={(value) => {
          state.setPage(1);
          state.setSearch(value);
        }}
        searchPlaceholder="Search name, email, role…"
        filters={[
          {
            value: state.role,
            onChange: (value) => {
              state.setPage(1);
              state.setRole(value);
            },
            label: "Role",
            options: [
              { value: "all", label: "All Roles" },
              { value: "super_admin", label: "Super Admin" },
              { value: "billing", label: "Billing" },
            ],
          },
          {
            value: state.active,
            onChange: (value) => {
              state.setPage(1);
              state.setActive(value);
            },
            label: "Access",
            options: [
              { value: "all", label: "All" },
              { value: "active", label: "Active" },
              { value: "inactive", label: "Inactive" },
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
        emptyText="No internal users found."
      />
      <SupportPagination
        page={
          state.pageMeta ?? {
            page: state.page,
            page_size: 25,
            total: 0,
            total_pages: 1,
            has_more: false,
          }
        }
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
      <InternalUserModal
        open={creating}
        mode="create"
        isSaving={state.isMutating}
        onClose={() => setCreating(false)}
        onSubmit={createUser}
      />
      <InternalUserModal
        open={Boolean(editing)}
        mode="edit"
        user={editing}
        isSaving={state.isMutating}
        onClose={() => setEditing(null)}
        onSubmit={updateUser}
      />
      <ResetPasswordModal
        open={Boolean(resetting)}
        user={resetting}
        isSaving={state.isMutating}
        onClose={() => setResetting(null)}
        onSubmit={resetPassword}
      />
    </SupportPageShell>
  );
}

const actionStyle: React.CSSProperties = {
  border: `1px solid ${T.border}`,
  background: "#fff",
  borderRadius: 9,
  padding: "7px 10px",
  fontSize: 12,
  fontWeight: 800,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  color: T.text,
};
const primaryButton: React.CSSProperties = {
  ...actionStyle,
  borderColor: "#99f6e4",
  background: T.teal,
  color: "white",
};
