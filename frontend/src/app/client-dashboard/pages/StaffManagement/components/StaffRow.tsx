import React, { type FC, useState } from "react";
import {
  Building2,
  Clock,
  Edit2,
  Eye,
  KeyRound,
  MapPin,
  Trash2,
} from "lucide-react";
import { T } from "../../../components/ui/theme";
import { Spinner } from "../../../components/ui/Spinner";
import { useAuthenticatedImageUrl } from "../../../hooks/useAuthenticatedImageUrl";
import { type PeopleRenderingModel } from "../../../utils/templateRendering";
import { type StaffMember } from "../types/staffTypes";
import { staffAvatarUrl, staffInitial } from "../utils/staffMember";
import { STATUS_META, statusIcon } from "../utils/staffStatus";
import {
  getColumnAlign,
  staffColumnText,
  type StaffTemplateColumn,
} from "../utils/staffTable";
import { TABLE_THEME } from "../../../components/ui/DataTable";

export const iconBtn: React.CSSProperties = {
  background: "#ffffff",
  border: `1px solid #d2dce4`,
  borderRadius: 7,
  width: 28,
  height: 28,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "all 0.15s ease",
};

export const StaffRow: FC<{
  member: StaffMember;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onGenerateCredentials: () => void;
  onOverride?: () => void;
  canDelete: boolean;
  branchName: (id: number) => string;
  highlighted?: boolean;
  domId?: string;
  peopleModel: PeopleRenderingModel;
  columns: StaffTemplateColumn[];
  gridTemplateColumns: string;
  editLoading?: boolean;
  generatingCredentials?: boolean;
}> = ({
  member,
  onView,
  onEdit,
  onDelete,
  onGenerateCredentials,
  canDelete,
  branchName,
  highlighted = false,
  domId,
  peopleModel,
  columns,
  gridTemplateColumns,
  editLoading = false,
  generatingCredentials = false,
}) => {
  const [hov, setHov] = useState(false);
  const sm = STATUS_META[member.status];
  const authedAvatarUrl = useAuthenticatedImageUrl(staffAvatarUrl(member));

  const renderCell = (column: StaffTemplateColumn): React.ReactNode => {
    const rawVal = staffColumnText(member, column, branchName);

    if (column.key === "id" || column.key === "code" || column.key === "employeeId") {
      return (
        <div style={{ display: "flex", alignItems: "center" }}>
          <span
            style={{
              display: "inline-block",
              padding: "2px 7px",
              borderRadius: 6,
              background: "#f1f5f9",
              border: "1px solid #e2e8f0",
              color: "#334155",
              fontSize: 11,
              fontFamily: "'DM Mono', monospace, sans-serif",
              fontWeight: 700,
              letterSpacing: "0.02em",
            }}
          >
            {rawVal || "—"}
          </span>
        </div>
      );
    }

    if (column.key === "name") {
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              background: `linear-gradient(135deg, ${TABLE_THEME.teal600}, ${TABLE_THEME.navy600})`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 800,
              color: "#fff",
              flexShrink: 0,
              overflow: "hidden",
              boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
            }}
          >
            {authedAvatarUrl ? (
              <img
                src={authedAvatarUrl}
                alt={member.name}
                style={{
                  width: "100%",
                  height: "100%",
                  borderRadius: "50%",
                  objectFit: "cover",
                }}
              />
            ) : (
              staffInitial(member)
            )}
          </div>
          <div style={{ minWidth: 0, overflow: "hidden" }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: TABLE_THEME.textHeading,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {member.name}
            </div>
          </div>
        </div>
      );
    }

    if (column.key === "cnic") {
      return (
        <div
          style={{
            fontSize: 12,
            fontFamily: "'DM Mono', monospace, sans-serif",
            color: "#475569",
            fontWeight: 500,
            whiteSpace: "nowrap",
          }}
          title={rawVal}
        >
          {rawVal || "—"}
        </div>
      );
    }

    if (column.key === "status") {
      const isAct = member.status === "active";
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "100%",
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "3px 9px",
              borderRadius: 999,
              background: isAct ? "#f0fdf4" : "#fff1f2",
              border: `1px solid ${isAct ? "#bbf7d0" : "#fecdd3"}`,
              color: isAct ? "#15803d" : "#e11d48",
              fontSize: 11,
              fontWeight: 700,
              whiteSpace: "nowrap",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: isAct ? "#22c55e" : "#ef4444",
              }}
            />
            {sm?.label ?? member.status}
          </span>
        </div>
      );
    }

    if (column.key === "staffType") {
      const isField = member.staffType === "field";
      return (
        <div style={{ display: "flex", alignItems: "center" }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "2px 8px",
              borderRadius: 999,
              background: isField ? "#fff7ed" : "#f0fdfa",
              border: `1px solid ${isField ? "#fed7aa" : "#ccfbf1"}`,
              color: isField ? "#c2410c" : "#0f766e",
              fontSize: 11,
              fontWeight: 700,
              whiteSpace: "nowrap",
            }}
          >
            {isField ? <MapPin size={11} /> : <Building2 size={11} />}
            {isField ? "Field" : "Office"}
          </span>
        </div>
      );
    }

    if (column.key === "shift") {
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 12,
              color: "#334155",
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
            title={rawVal}
          >
            <Clock size={12} color="#64748b" />
            {rawVal || "—"}
          </span>
        </div>
      );
    }

    if (column.key === "salary") {
      return (
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: TABLE_THEME.navy600,
            whiteSpace: "nowrap",
          }}
        >
          {rawVal || "—"}
        </div>
      );
    }

    const align = getColumnAlign(column);
    const isCentered = align === "center";

    return (
      <div
        style={{
          fontSize: 12,
          color: column.key === "branch" ? TABLE_THEME.navy600 : TABLE_THEME.textHeading,
          fontWeight: column.key === "branch" ? 700 : 500,
          textAlign: align,
          justifySelf: isCentered ? "center" : "start",
          width: "100%",
          paddingLeft: isCentered ? 8 : 4,
          paddingRight: isCentered ? 8 : 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        title={rawVal}
      >
        {rawVal || "—"}
      </div>
    );
  };

  return (
    <div
      className="staff-directory-table-grid"
      id={domId}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: "grid",
        gridTemplateColumns,
        minWidth: 1120,
        width: "100%",
        boxSizing: "border-box",
        gap: 12,
        padding: "11px 16px",
        alignItems: "center",
        background: highlighted ? "#fff7ed" : hov ? "#f8fafc" : "#ffffff",
        borderBottom: highlighted ? "1px solid #fed7aa" : "1px solid #f1f5f9",
        boxShadow: highlighted ? "inset 3px 0 0 #f97316" : hov ? "inset 2px 0 0 #0f766e" : "none",
        cursor: "pointer",
        transition: "all 0.12s ease",
      }}
      onClick={onView}
    >
      {columns.map((column) => (
        <React.Fragment key={column.key}>{renderCell(column)}</React.Fragment>
      ))}

      <div
        style={{ display: "flex", gap: 6, alignItems: "center" }}
        onClick={(e) => e.stopPropagation()}
        aria-label={`${peopleModel.personSingular} row actions`}
      >
        <button
          type="button"
          onClick={onView}
          style={iconBtn}
          title="View profile"
        >
          <Eye size={13} color={TABLE_THEME.teal600} />
        </button>
        <button
          type="button"
          onClick={onEdit}
          disabled={editLoading}
          title={editLoading ? "Loading details…" : "Edit"}
          style={{
            ...iconBtn,
            opacity: editLoading ? 0.5 : 1,
            cursor: editLoading ? "not-allowed" : "pointer",
          }}
        >
          <Edit2 size={13} color={TABLE_THEME.navy600} />
        </button>
        {peopleModel.shouldGenerateCredentials && (
          <button
            type="button"
            onClick={onGenerateCredentials}
            disabled={generatingCredentials}
            title={
              generatingCredentials
                ? "Generating credentials…"
                : "Generate Credentials"
            }
            style={{
              ...iconBtn,
              opacity: generatingCredentials ? 0.5 : 1,
              cursor: generatingCredentials ? "not-allowed" : "pointer",
            }}
          >
            {generatingCredentials ? (
              <Spinner size={13} color={TABLE_THEME.teal600} />
            ) : (
              <KeyRound size={13} color={TABLE_THEME.teal600} />
            )}
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            onClick={onDelete}
            title="Delete member"
            style={{
              ...iconBtn,
              background: "#fff1f2",
              borderColor: "#fecdd3",
            }}
          >
            <Trash2 size={13} color="#e11d48" />
          </button>
        )}
      </div>
    </div>
  );
};