/**
 * modules/staff/components/ProfileDrawer.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Right-side detail panel for a single staff member.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { type FC, useEffect, useState } from "react";
import {
  Briefcase,
  Building2,
  CalendarClock,
  CheckCircle,
  Clock,
  Edit2,
  MapPin,
  Phone,
  Shield,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useOrg } from "../../../contexts/OrgConfigContext";
import { ActionButton } from "../../engine/ModuleShell";
import { T } from "../../../components/ui/theme";
import { useAuthenticatedImageUrl } from "../../../hooks/useAuthenticatedImageUrl";
import { type PeopleRenderingModel } from "../../../utils/templateRendering";
import { peopleCodeModel } from "../types/types";
import {
  getSalaryConfigForStaff,
  type PayrollSalaryConfig,
} from "../../../pages/Payroll/api/payrollApi";
import { type StaffMember } from "../types/staffTypes";
import {
  staffAvatarUrl,
  staffInitial,
  staffModules,
  staffSalary,
} from "../utils/staffMember";
import { shiftText, staffTypeText } from "../utils/staffShifts";
import { STATUS_META, statusIcon } from "../utils/staffStatus";

export const ProfileDrawer: FC<{
  member: StaffMember;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  canDelete: boolean;
  branchName: (id: number) => string;
  peopleModel: PeopleRenderingModel;
}> = ({
  member,
  onClose,
  onEdit,
  onDelete,
  canDelete,
  branchName,
  peopleModel,
}) => {
  const sm = STATUS_META[member.status];
  const { organizationId } = useOrg();
  const authedAvatarUrl = useAuthenticatedImageUrl(staffAvatarUrl(member));

  // Read-only lookup — this drawer has no write path into salary_configs
  // (see StaffModal's Allowances section, which doesn't exist; allowances
  // are edited only from PayrollModule's per-staff edit modal, where
  // Base Salary/OT Rate Override already live). Shown here purely so
  // allowances are visible alongside Benefits without duplicating the edit
  // surface. Not fetched for students — payroll doesn't apply to them.
  const [salaryConfig, setSalaryConfig] = useState<PayrollSalaryConfig | null>(
    null,
  );
  const [salaryConfigLoading, setSalaryConfigLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!organizationId || peopleModel.isStudent) {
      setSalaryConfig(null);
      return undefined;
    }
    setSalaryConfigLoading(true);
    getSalaryConfigForStaff(member.id, organizationId)
      .then((config) => {
        if (!cancelled) setSalaryConfig(config);
      })
      .catch(() => {
        if (!cancelled) setSalaryConfig(null);
      })
      .finally(() => {
        if (!cancelled) setSalaryConfigLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [member.id, organizationId, peopleModel.isStudent]);

  const allowanceSummary = (() => {
    if (peopleModel.isStudent) return null;
    if (salaryConfigLoading) return "Loading…";
    const items = salaryConfig?.allowancesBreakdown ?? [];
    if (!items.length) return "—";
    return items
      .map((item) =>
        item.mode === "percent"
          ? `${item.label} (${item.value}%: PKR ${item.amount.toLocaleString()})`
          : `${item.label} (PKR ${item.amount.toLocaleString()})`,
      )
      .join(", ");
  })();

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 900,
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <div
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.3)",
        }}
      />

      <div
        style={{
          position: "relative",
          width: 380,
          height: "100%",
          background: T.card,
          boxShadow: "-8px 0 32px rgba(0,0,0,0.12)",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "18px 20px",
            borderBottom: `1px solid ${T.border}`,
            background: T.teal50,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, color: T.head }}>
            {peopleModel.personSingular} Profile
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: T.muted,
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Avatar + identity */}
        <div
          style={{
            padding: "24px 20px",
            borderBottom: `1px solid ${T.border}`,
            textAlign: "center",
          }}
        >
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: "50%",
              background: T.teal600,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 12px",
              fontSize: 26,
              fontWeight: 800,
              color: "#fff",
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
          <div
            style={{
              fontSize: 16,
              fontWeight: 800,
              color: T.head,
              marginBottom: 4,
            }}
          >
            {member.name}
          </div>
          <div style={{ fontSize: 12, color: T.muted, marginBottom: 8 }}>
            {peopleCodeModel(peopleModel.peopleType).label}:{" "}
            {member.personCode || member.employeeId || "—"}
          </div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "3px 10px",
              borderRadius: 20,
              background: sm.bg,
            }}
          >
            {statusIcon(member.status)}
            <span style={{ fontSize: 11, fontWeight: 700, color: sm.color }}>
              {sm.label}
            </span>
          </div>
        </div>

        {/* Details — all fields accessed directly, no lookup functions */}
        <div style={{ padding: "16px 20px", flex: 1 }}>
          {[
            {
              Icon: UserRound,
              label: peopleCodeModel(peopleModel.peopleType).label,
              val: member.personCode || member.employeeId,
            },
            { Icon: Phone, label: "Phone", val: member.phone },
            ...(!peopleModel.isStudent
              ? [{ Icon: Shield, label: "CNIC", val: member.cnic || "—" }]
              : []),
            ...(peopleModel.isStudent
              ? [
                  {
                    Icon: UserRound,
                    label: "Father Name",
                    val: member.fatherName || "—",
                  },
                  {
                    Icon: Phone,
                    label: "Father Number",
                    val: member.fatherPhone || "—",
                  },
                  {
                    Icon: Shield,
                    label: "Father CNIC",
                    val: member.fatherCnic || "—",
                  },
                ]
              : []),
            { Icon: MapPin, label: "Branch", val: branchName(member.branchId) },
            {
              Icon: Building2,
              label: peopleModel.groupLabel,
              val: member.department,
            },
            { Icon: Shield, label: peopleModel.roleLabel, val: member.role },
            {
              Icon: UserRound,
              label: `${peopleModel.personSingular} Type`,
              val: staffTypeText(member),
            },
            { Icon: CalendarClock, label: "Shift", val: shiftText(member) },
            ...(!peopleModel.isStudent
              ? [
                  {
                    Icon: Briefcase,
                    label: "Compensation",
                    val: `PKR ${staffSalary(member).toLocaleString()}`,
                  },
                ]
              : []),
            {
              Icon: CheckCircle,
              label: `${peopleModel.personSingular} Benefits`,
              val: member.benefits.length ? member.benefits.join(", ") : "—",
            },
            ...(!peopleModel.isStudent
              ? [
                  {
                    Icon: Briefcase,
                    label: "Allowances",
                    val: allowanceSummary ?? "—",
                  },
                ]
              : []),
            { Icon: Clock, label: "Joined", val: member.joinDate },
          ].map(({ Icon, label, val }) => (
            <div
              key={label}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                padding: "10px 0",
                borderBottom: `1px solid ${T.teal50}`,
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 7,
                  background: T.teal50,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <Icon size={13} color={T.teal600} />
              </div>
              <div>
                <div
                  style={{
                    fontSize: 10,
                    color: T.muted,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: ".06em",
                    marginBottom: 2,
                  }}
                >
                  {label}
                </div>
                <div style={{ fontSize: 13, color: T.head, fontWeight: 500 }}>
                  {val}
                </div>
              </div>
            </div>
          ))}

          {/* Module Access */}
          <div style={{ marginTop: 16 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: T.muted,
                textTransform: "uppercase",
                letterSpacing: ".07em",
                marginBottom: 8,
              }}
            >
              Dashboard Module Access
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {staffModules(member).length ? (
                staffModules(member).map((m) => (
                  <span
                    key={m}
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "3px 10px",
                      borderRadius: 20,
                      background: T.teal100,
                      color: T.teal700,
                      textTransform: "capitalize",
                    }}
                  >
                    {m}
                  </span>
                ))
              ) : (
                <span style={{ fontSize: 12, color: T.muted }}>
                  No access granted
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div
          style={{
            padding: "14px 20px",
            borderTop: `1px solid ${T.border}`,
            display: "flex",
            gap: 8,
          }}
        >
          <ActionButton label="Edit" Icon={Edit2} onClick={onEdit} />
          {canDelete && (
            <ActionButton
              label="Archive"
              Icon={Trash2}
              onClick={onDelete}
              variant="ghost"
            />
          )}
        </div>
      </div>
    </div>
  );
};
