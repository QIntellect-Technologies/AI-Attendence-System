/**
 * pages/StaffManagement/components/StaffStats.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Stat bar above the directory table — styled identically to Overview StatCard.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { type FC } from "react";
import { Users, UserCheck, UserX, Wallet, type LucideIcon } from "lucide-react";
import StatCard from "../../../components/dashboard/overview/StatCard";
import { T } from "../../../components/ui/theme";
import { type PeopleRenderingModel } from "../../../utils/templateRendering";
import { type StaffMember } from "../types/staffTypes";
import { staffSalary } from "../utils/staffMember";

export const StaffStats: FC<{
  staff: StaffMember[];
  counts?: {
    total: number;
    active: number;
    inactiveOrPending: number;
    averageSalary: number;
  } | null;
  peopleModel: PeopleRenderingModel;
  purchasedModules: string[];
}> = ({ staff, counts, peopleModel, purchasedModules }) => {
  const pageActive = staff.filter((s) => s.status === "active").length;
  const pageInactive = staff.filter((s) => s.status === "inactive").length;
  const pagePending = staff.filter((s) => s.status === "pending").length;

  const total = counts ? counts.total : staff.length;
  const active = counts ? counts.active : pageActive;
  const inactiveOrPending = counts
    ? counts.inactiveOrPending
    : pageInactive + pagePending;
  const payrollEnabled = purchasedModules
    .map((moduleKey) => String(moduleKey).trim().toLowerCase())
    .includes("payroll");
  const showPayrollStats = payrollEnabled && !peopleModel.isStudent;

  const cards: {
    label: string;
    val: number | string;
    sub: string;
    icon: LucideIcon;
    iconBg: string;
    iconColor: string;
  }[] = [
    {
      label: peopleModel.statsTotalLabel,
      val: total,
      sub: "Total Directory",
      icon: Users,
      iconBg: "#E0F2FE",
      iconColor: "#1A699F",
    },
    {
      label: "Active Members",
      val: active,
      sub: "Currently active",
      icon: UserCheck,
      iconBg: "#ECFDF5",
      iconColor: "#16A34A",
    },
    {
      label: "Inactive / Pending",
      val: inactiveOrPending,
      sub: "Requires review",
      icon: UserX,
      iconBg: "#FFF1F2",
      iconColor: "#E11D48",
    },
  ];

  if (showPayrollStats) {
    const avgSal = Math.round(
      counts
        ? counts.averageSalary
        : staff.length
          ? staff.reduce((acc, member) => acc + staffSalary(member), 0) /
            staff.length
          : 0,
    );
    cards.push({
      label: "Avg Salary",
      val: `PKR ${Math.round(avgSal / 1000)}K`,
      sub: "Monthly avg",
      icon: Wallet,
      iconBg: "#CCFBF1",
      iconColor: "#0D9488",
    });
  }

  return (
    <div
      className="staff-management-stats"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fit, minmax(220px, 1fr))`,
        gap: 14,
        minWidth: 0,
        width: "100%",
        marginBottom: 16,
      }}
    >
      {cards.map((card) => (
        <StatCard
          key={card.label}
          title={card.label}
          value={card.val}
          sub={card.sub}
          icon={card.icon}
          iconBg={card.iconBg}
          iconColor={card.iconColor}
        />
      ))}
    </div>
  );
};