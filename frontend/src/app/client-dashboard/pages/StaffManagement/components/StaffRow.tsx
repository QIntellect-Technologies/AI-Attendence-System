import React, { type FC, useState } from "react";
import {
  Building2,
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

// ─── Table row ────────────────────────────────────────────────────────────────

export const iconBtn: React.CSSProperties = {
  background: T.teal50,
  border: `1px solid ${T.teal200}`,
  borderRadius: 6,
  width: 28,
  height: 28,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

export const StaffRow: FC<{
  member: StaffMember;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** "Generate Credentials" row action — only meaningful (and only
   * rendered) when peopleModel.shouldGenerateCredentials is true. */
  onGenerateCredentials: () => void;
  /** Optional: jump to the Shifts tab with this person pre-selected.
   * Accepted so the parent type-checks; not rendered as a button yet
   * because the actions column is a fixed width. */
  onOverride?: () => void;
  canDelete: boolean;
  branchName: (id: number) => string;
  highlighted?: boolean;
  domId?: string;
  peopleModel: PeopleRenderingModel;
  columns: StaffTemplateColumn[];
  gridTemplateColumns: string;
  /** True while this row's fresh-detail fetch (see openEditModal) is in
   * flight, so the Edit button doesn't double-fire and briefly shows it's
   * busy loading the person's full saved configuration. */
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
      if (column.key === "name") {
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: T.teal600,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                fontWeight: 800,
                color: "#fff",
                flexShrink: 0,
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
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.head }}>
                {member.name}
              </div>
            </div>
          </div>
        );
      }

      if (column.key === "status") {
        const align = getColumnAlign(column); // always "center", see getColumnAlign
        return (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent:
                align === "right"
                  ? "flex-end"
                  : align === "center"
                    ? "center"
                    : "flex-start",
              gap: 5,
              width: "100%",
              paddingLeft: 8,
              paddingRight: 8,
            }}
          >
            {statusIcon(member.status)}
            <span style={{ fontSize: 11, fontWeight: 700, color: sm.color }}>
              {sm.label}
            </span>
          </div>
        );
      }

      if (column.key === "staffType") {
        const isField = member.staffType === "field";
        return (
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "3px 8px",
              borderRadius: 999,
              background: isField ? "#fff7ed" : "#f0fdfa",
              color: isField ? "#c2410c" : "#0f766e",
              fontSize: 11,
              fontWeight: 700,
              whiteSpace: "nowrap",
            }}
          >
            {isField ? <MapPin size={11} /> : <Building2 size={11} />}
            {isField ? "Field" : "Office"}
          </div>
        );
      }

      const value = staffColumnText(member, column, branchName);
      const align = getColumnAlign(column);
      const isCentered = align === "center";

      return (
        <div
          style={{
            fontSize: 12,
            color:
              column.key === "branch" || column.key === "salary"
                ? T.navy600
                : T.head,
            fontWeight:
              column.key === "branch" || column.key === "salary" ? 700 : 500,
            textAlign: align,
            justifySelf: isCentered ? "center" : "start",
            width: "100%",
            paddingLeft: isCentered ? 8 : 4,
            paddingRight: isCentered ? 8 : 0,
            whiteSpace: "nowrap",
          }}
          title={value}
        >
          {value}
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
          background: highlighted ? "#fff7ed" : hov ? "#fafcfc" : "transparent",
          borderBottom: highlighted
            ? "1px solid #fed7aa"
            : `1px solid ${T.teal50}`,
          boxShadow: highlighted ? "inset 3px 0 0 #f97316" : "none",
          cursor: "pointer",
          transition: "background .1s",
        }}
        onClick={onView}
      >
        {columns.map((column) => (
          <React.Fragment key={column.key}>{renderCell(column)}</React.Fragment>
        ))}

        <div
          style={{ display: "flex", gap: 6 }}
          onClick={(e) => e.stopPropagation()}
          aria-label={`${peopleModel.personSingular} row actions`}
        >
          <button type="button" onClick={onView} style={iconBtn}>
            <Eye size={13} color={T.teal600} />
          </button>
          <button
            type="button"
            onClick={onEdit}
            disabled={editLoading}
            title={editLoading ? "Loading latest details…" : "Edit"}
            style={{
              ...iconBtn,
              opacity: editLoading ? 0.5 : 1,
              cursor: editLoading ? "not-allowed" : "pointer",
            }}
          >
            <Edit2 size={13} color={T.navy600} />
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
                <Spinner size={13} color={T.teal600} />
              ) : (
                <KeyRound size={13} color={T.teal600} />
              )}
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={onDelete}
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