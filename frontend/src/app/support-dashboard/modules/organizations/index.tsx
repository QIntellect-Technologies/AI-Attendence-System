/**
 * src/app/support-dashboard/modules/organizations/index.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Organizations list view — the home screen of the Support Dashboard.
 *
 * Design doc ref — Section 7 (Support Dashboard Feature Set):
 *   Organizations section: List all orgs, subscription status,
 *   last node heartbeat, attendance mode badge (Cloud / Local).
 *
 * Component focus: rendering only.
 * All data lives in useOrganizations hook.
 */

import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Building2,
  Plus,
  Search,
  Cloud,
  Server,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { useOrganizations } from "./hooks/useOrganizations";
import { CreateOrganizationModal } from "./components/CreateOrganizationModal";
import type { OrgStatus } from "../../packages/shared-types/src/organization";

// ─── Design tokens ────────────────────────────────────────────────────────────
const T = {
  teal600: "#0d9488",
  teal50: "#f0fdfa",
  teal100: "#ccfbf1",
  navy700: "#134471",
  slate50: "#f8fafc",
  slate100: "#f1f5f9",
  slate200: "#e2e8f0",
  green600: "#16a34a",
  green100: "#f0fdf4",
  red600: "#e11d48",
  red100: "#fff1f2",
  amber600: "#d97706",
  amber100: "#fffbeb",
  bgPage: "#f5f6fa",
  bgCard: "#ffffff",
  border: "#e2e8f0",
  textHeading: "#1a699f",
  textBody: "#334155",
  textMuted: "#64748b",
  textLight: "#94a3b8",
  shadow: "0 1px 3px rgba(15,45,74,0.07),0 1px 2px rgba(15,45,74,0.04)",
} as const;

// ─── Status badge config ──────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  string,
  { bg: string; color: string; icon: React.ReactNode; label: string }
> = {
  active: {
    bg: T.green100,
    color: T.green600,
    icon: <CheckCircle2 size={10} />,
    label: "Active",
  },
  grace_period: {
    bg: T.amber100,
    color: T.amber600,
    icon: <AlertCircle size={10} />,
    label: "Grace Period",
  },
  suspended: {
    bg: T.red100,
    color: T.red600,
    icon: <AlertCircle size={10} />,
    label: "Suspended",
  },
  archived: {
    bg: T.slate100,
    color: T.textMuted,
    icon: <AlertCircle size={10} />,
    label: "Archived",
  },
  deleted: {
    bg: T.red100,
    color: T.red600,
    icon: <AlertCircle size={10} />,
    label: "Deleted",
  },
};

// ─── Sub-components ───────────────────────────────────────────────────────────

const StatusBadge: React.FC<{ status: OrgStatus }> = ({ status }) => {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.active;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        background: cfg.bg,
        color: cfg.color,
        borderRadius: 6,
        padding: "3px 8px",
        fontSize: 10,
        fontWeight: 800,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
      }}
    >
      {cfg.icon}
      {cfg.label}
    </span>
  );
};

const AttendanceModeChip: React.FC<{ mode: "cloud" | "local" }> = ({
  mode,
}) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      background: mode === "cloud" ? "#eff6ff" : "#f5f3ff",
      color: mode === "cloud" ? "#2563eb" : "#7c3aed",
      borderRadius: 6,
      padding: "3px 8px",
      fontSize: 10,
      fontWeight: 800,
      textTransform: "uppercase",
    }}
  >
    {mode === "cloud" ? <Cloud size={10} /> : <Server size={10} />}
    {mode}
  </span>
);


type OrganizationStatusFilter = "all" | "active" | "grace_period" | "suspended" | "archived";

const STATUS_FILTERS: Array<{ key: OrganizationStatusFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "grace_period", label: "Grace Period" },
  { key: "suspended", label: "Suspended" },
  { key: "archived", label: "Archived" },
];

function normalizeStatus(status: OrgStatus | string | null | undefined): string {
  return String(status || "active").trim().toLowerCase();
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function OrganizationsPage() {
  const navigate = useNavigate();
  const { organizations, isLoading, error } = useOrganizations();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<OrganizationStatusFilter>("all");
  const [showCreateModal, setShowCreateModal] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return organizations.filter((org) => {
      const normalizedStatus = normalizeStatus(org.status);

      // Permanent/soft-deleted organizations should not appear in the list.
      // If the backend is still finishing cleanup and returns a deleted row,
      // the frontend hides it as a second safety layer.
      if (normalizedStatus === "deleted" || Boolean(org.deleted_at)) return false;

      const matchesSearch =
        !q ||
        String(org.name || "").toLowerCase().includes(q) ||
        String(org.contact_email || "").toLowerCase().includes(q) ||
        String(org.id || "").toLowerCase().includes(q);

      const matchesStatus =
        statusFilter === "all"
          ? normalizedStatus !== "archived"
          : normalizedStatus === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [organizations, search, statusFilter]);

  const visibleTotal = useMemo(
    () => organizations.filter((org) => normalizeStatus(org.status) !== "deleted" && !org.deleted_at).length,
    [organizations],
  );

  return (
    <div
      style={{
        minHeight: "100%",
        background: T.bgPage,
        padding: "24px 24px 48px",
        fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 22,
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1
            style={{
              margin: 0,
              color: T.textHeading,
              fontSize: 22,
              fontWeight: 900,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <Building2 size={20} color={T.teal600} />
            Organizations
          </h1>
          <p style={{ margin: "5px 0 0", fontSize: 12, color: T.textMuted }}>
            {visibleTotal} organization
            {visibleTotal !== 1 ? "s" : ""} · Manage clients and their
            configurations
          </p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            background: T.teal600,
            color: "#fff",
            border: "none",
            borderRadius: 10,
            padding: "9px 16px",
            fontSize: 12,
            fontWeight: 800,
            cursor: "pointer",
          }}
        >
          <Plus size={14} />
          New Organization
        </button>
      </div>

      {/* Filters */}
      <div
        style={{
          display: "flex",
          gap: 10,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <div style={{ position: "relative", flex: 1, minWidth: 240 }}>
          <Search
            size={13}
            style={{
              position: "absolute",
              left: 12,
              top: "50%",
              transform: "translateY(-50%)",
              color: T.textLight,
            }}
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or email…"
            style={{
              width: "100%",
              padding: "9px 14px 9px 34px",
              fontSize: 12,
              border: `1px solid ${T.border}`,
              borderRadius: 10,
              background: T.bgCard,
              outline: "none",
              boxSizing: "border-box",
              fontFamily: "inherit",
            }}
          />
        </div>

        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.key}
            onClick={() => setStatusFilter(filter.key)}
            style={{
              padding: "8px 14px",
              fontSize: 11,
              fontWeight: 700,
              border: `1px solid ${statusFilter === filter.key ? T.teal600 : T.border}`,
              borderRadius: 8,
              background: statusFilter === filter.key ? T.teal50 : T.bgCard,
              color: statusFilter === filter.key ? T.teal600 : T.textMuted,
              cursor: "pointer",
            }}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div
        style={{
          background: T.bgCard,
          border: `1px solid ${T.border}`,
          borderRadius: 16,
          boxShadow: T.shadow,
          overflow: "hidden",
        }}
      >
        {isLoading && (
          <div
            style={{
              padding: 48,
              textAlign: "center",
              color: T.textLight,
              fontSize: 13,
            }}
          >
            Loading organizations…
          </div>
        )}

        {error && !isLoading && (
          <div
            style={{
              padding: 24,
              color: T.red600,
              fontSize: 12,
              fontWeight: 600,
              textAlign: "center",
            }}
          >
            {error}
          </div>
        )}

        {!isLoading && !error && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: T.slate50 }}>
                  {[
                    "Organization",
                    "Contact",
                    "Mode",
                    "Branches",
                    "Status",
                    "Actions",
                  ].map((col) => (
                    <th
                      key={col}
                      style={{
                        padding: "11px 16px",
                        textAlign: "left",
                        fontSize: 10,
                        fontWeight: 900,
                        color: T.textLight,
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        borderBottom: `1px solid ${T.border}`,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {filtered.map((org) => (
                  <tr
                    key={org.id}
                    style={{ borderBottom: `1px solid ${T.slate100}` }}
                  >
                    <td style={{ padding: "13px 16px" }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                        }}
                      >
                        <div
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: 8,
                            background: T.teal50,
                            color: T.teal600,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontWeight: 900,
                            fontSize: 13,
                          }}
                        >
                          {org.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p
                            style={{
                              margin: 0,
                              fontSize: 12,
                              fontWeight: 800,
                              color: T.textBody,
                            }}
                          >
                            {org.name}
                          </p>
                          <p
                            style={{
                              margin: "2px 0 0",
                              fontSize: 10,
                              color: T.textLight,
                            }}
                          >
                            ID: {org.id}
                          </p>
                        </div>
                      </div>
                    </td>

                    <td style={{ padding: "13px 16px" }}>
                      <p style={{ margin: 0, fontSize: 11, color: T.textBody }}>
                        {org.contact_email}
                      </p>
                      {org.contact_phone && (
                        <p
                          style={{
                            margin: "2px 0 0",
                            fontSize: 10,
                            color: T.textLight,
                          }}
                        >
                          {org.contact_phone}
                        </p>
                      )}
                    </td>

                    <td style={{ padding: "13px 16px" }}>
                      <AttendanceModeChip mode={org.attendance_mode} />
                    </td>

                    <td style={{ padding: "13px 16px", textAlign: "center" }}>
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 800,
                          color: T.navy700,
                        }}
                      >
                        {org.max_branches}
                      </span>
                    </td>

                    <td style={{ padding: "13px 16px" }}>
                      <StatusBadge status={org.status} />
                    </td>

                    <td style={{ padding: "13px 16px" }}>
                      <button
                        onClick={() =>
                          navigate(`/support/organizations/${org.id}`)
                        }
                        style={{
                          background: T.slate50,
                          border: `1px solid ${T.border}`,
                          borderRadius: 7,
                          padding: "6px 12px",
                          fontSize: 11,
                          fontWeight: 700,
                          color: T.textBody,
                          cursor: "pointer",
                        }}
                      >
                        Manage →
                      </button>
                    </td>
                  </tr>
                ))}

                {filtered.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      style={{
                        padding: 48,
                        textAlign: "center",
                        color: T.textLight,
                        fontSize: 13,
                      }}
                    >
                      <Building2
                        size={28}
                        style={{
                          opacity: 0.2,
                          display: "block",
                          margin: "0 auto 10px",
                        }}
                      />
                      No organizations match your filters
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <CreateOrganizationModal
          onClose={() => setShowCreateModal(false)}
          onCreated={(org) => {
            setShowCreateModal(false);
            navigate(`/support/organizations/${org.id}`);
          }}
        />
      )}
    </div>
  );
}
