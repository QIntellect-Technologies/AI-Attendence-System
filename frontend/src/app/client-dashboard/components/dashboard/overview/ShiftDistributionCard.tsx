/**
 * ShiftDistributionCard.tsx
 */

import React, { useState } from "react";
import { Sun, Sunset, Moon, Settings2, ChevronRight, X } from "lucide-react";
import DashboardCard from "./DashboardCard";
import { T } from "../../ui/theme";
import type { ShiftDistributionItem } from "../../../hooks/useDashboardOverviewData";

interface ShiftDistributionCardProps {
  shifts: ShiftDistributionItem[];
}

function visualForShift(shift: ShiftDistributionItem) {
  const startHour = parseInt(shift.time.match(/^(\d{1,2}):/)?.[1] ?? "", 10);
  if (Number.isNaN(startHour)) return SHIFT_VISUALS.Custom;
  if (startHour >= 6 && startHour < 14) return SHIFT_VISUALS.Morning;
  if (startHour >= 14 && startHour < 22) return SHIFT_VISUALS.Evening;
  if (startHour >= 22 || startHour < 6) return SHIFT_VISUALS.Night;
  return SHIFT_VISUALS.Custom;
}

const SHIFT_VISUALS: Record<
  string,
  {
    icon: React.ElementType;
    iconBg: string;
    iconColor: string;
  }
> = {
  Morning: {
    icon: Sun,
    iconBg: "#FEF3C7",
    iconColor: T.amber,
  },
  Evening: {
    icon: Sunset,
    iconBg: "#EDE9FE",
    iconColor: "#7C3AED",
  },
  Night: {
    icon: Moon,
    iconBg: T.teal100,
    iconColor: T.teal600,
  },
  Custom: {
    icon: Settings2,
    iconBg: "#DBEAFE",
    iconColor: "#1D4ED8",
  },
};

const DEPT_COLORS: Record<string, [string, string]> = {
  Engineering: ["#E6F1FB", "#0C447C"],
  HR: ["#FAEEDA", "#633806"],
  Finance: ["#EAF3DE", "#27500A"],
  Operations: ["#EEEDFE", "#3C3489"],
  Security: ["#FCEBEB", "#791F1F"],
  Marketing: ["#FBEAF0", "#72243E"],
  Support: ["#E1F5EE", "#085041"],
  Administration: ["#EEF6FB", "#173F67"],
  "IT Department": ["#E2F3F6", "#0F7E8B"],
};

function initials(name: string) {
  return name
    .split(" ")
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function safeDepartmentMembers(
  dept: ShiftDistributionItem["branches"][number]["departments"][number],
): ShiftDistributionItem["members"] {
  return Array.isArray(dept.members) ? dept.members : [];
}

const ShiftDistributionCard: React.FC<ShiftDistributionCardProps> = ({
  shifts,
}) => {
  const [activeShift, setActiveShift] = useState<ShiftDistributionItem | null>(
    null,
  );
  const [expandedDepts, setExpandedDepts] = useState<Record<string, boolean>>(
    {},
  );

  const toggleDept = (dept: string) => {
    setExpandedDepts((prev) => ({
      ...prev,
      [dept]: prev[dept] === false,
    }));
  };

  const isDeptOpen = (dept: string) => expandedDepts[dept] !== false;

  return (
    <>
      <DashboardCard
        title="Shift distribution"
        subtitle="Click a shift to view staff"
        height="100%"
      >
        <div
          className="hide-scrollbar"
          style={{
            overflowY: "auto",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {shifts.map((shift) => {
            const visual = visualForShift(shift);
            const Icon = visual.icon;

            return (
              <div
                key={shift.key}
                onClick={() => setActiveShift(shift)}
                style={{
                  border: `1px solid ${T.border}`,
                  borderRadius: 12,
                  padding: "12px 14px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  transition: "background .15s, border-color .15s",
                }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.background = T.slate50;
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = "transparent";
                }}
              >
                <div
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 10,
                    background: visual.iconBg,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <Icon size={18} color={visual.iconColor} />
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <p
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: T.head,
                      marginBottom: 2,
                      fontFamily: "'DM Sans', sans-serif",
                    }}
                  >
                    {shift.label}
                  </p>
                  <p style={{ fontSize: 11, color: T.muted }}>{shift.time}</p>

                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 4,
                      marginTop: 6,
                    }}
                  >
                    {shift.departments.length === 0 && (
                      <span style={{ fontSize: 10, color: T.muted }}>
                        No staff
                      </span>
                    )}

                    {shift.departments.slice(0, 2).map((dept) => {
                      const [bg, color] = DEPT_COLORS[dept.name] ?? [
                        T.slate100,
                        T.body,
                      ];

                      return (
                        <span
                          key={dept.name}
                          style={{
                            fontSize: 10,
                            padding: "2px 7px",
                            borderRadius: 20,
                            background: bg,
                            color,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {dept.count} {dept.name}
                        </span>
                      );
                    })}

                    {shift.departments.length > 2 && (
                      <span
                        style={{
                          fontSize: 10,
                          padding: "2px 7px",
                          borderRadius: 20,
                          background: T.slate100,
                          color: T.muted,
                          whiteSpace: "nowrap",
                        }}
                      >
                        +{shift.departments.length - 2} more
                      </span>
                    )}
                  </div>
                </div>

                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    flexShrink: 0,
                  }}
                >
                  <p
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      color: T.head,
                      lineHeight: 1,
                      fontFamily: "'DM Sans', sans-serif",
                    }}
                  >
                    {shift.staffCount}
                  </p>
                  <p style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>
                    staff
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </DashboardCard>

      {activeShift && (
        <div
          onClick={() => setActiveShift(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,45,74,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              background: T.card,
              border: `1px solid ${T.border}`,
              borderRadius: 20,
              padding: 24,
              width: 500,
              maxWidth: "90vw",
              maxHeight: "80vh",
              overflowY: "auto",
              boxShadow: "0 20px 60px rgba(15,45,74,0.25)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 20,
              }}
            >
              <div>
                <p
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    color: T.head,
                    fontFamily: "'DM Sans', sans-serif",
                  }}
                >
                  {activeShift.label}
                </p>
                <p style={{ fontSize: 12, color: T.muted }}>
                  {activeShift.time}
                </p>
              </div>

              <button
                onClick={() => setActiveShift(null)}
                type="button"
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  border: `1px solid ${T.border}`,
                  background: "none",
                  cursor: "pointer",
                  color: T.muted,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <X size={15} />
              </button>
            </div>

            {activeShift.staffCount === 0 ? (
              <p
                style={{
                  fontSize: 13,
                  color: T.muted,
                  textAlign: "center",
                  padding: "30px 0",
                }}
              >
                No staff assigned to this shift
              </p>
            ) : (
              <>
                <p style={{ fontSize: 12, color: T.muted, marginBottom: 16 }}>
                  {activeShift.staffCount} staff across{" "}
                  {activeShift.departments.length} department
                  {activeShift.departments.length !== 1 ? "s" : ""}
                </p>

                {activeShift.branches.map((branch) => (
                  <div key={branch.branchId} style={{ marginBottom: 14 }}>
                    <div
                      style={{
                        padding: "10px 12px",
                        borderRadius: 10,
                        background: T.teal50,
                        border: `1px solid ${T.teal100}`,
                        marginBottom: 8,
                      }}
                    >
                      <p
                        style={{
                          fontSize: 13,
                          fontWeight: 800,
                          color: T.head,
                          fontFamily: "'DM Sans', sans-serif",
                        }}
                      >
                        {branch.branchName}
                      </p>
                      <p style={{ fontSize: 11, color: T.muted }}>
                        {branch.city || "Branch"} · {branch.staffCount} staff
                      </p>
                    </div>

                    {branch.departments.map((dept) => {
                      const [bg, color] = DEPT_COLORS[dept.name] ?? [
                        T.slate100,
                        T.body,
                      ];

                      const deptKey = `${branch.branchId}-${dept.name}`;
                      const isOpen = isDeptOpen(deptKey);

                      return (
                        <div key={deptKey} style={{ marginBottom: 8 }}>
                          <div
                            onClick={() => toggleDept(deptKey)}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              padding: "10px 14px",
                              background: bg,
                              borderRadius: 10,
                              cursor: "pointer",
                              marginBottom: isOpen ? 6 : 0,
                              border: `1px solid ${color}22`,
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                              }}
                            >
                              <div
                                style={{
                                  width: 28,
                                  height: 28,
                                  borderRadius: 8,
                                  background: color,
                                  color: "#fff",
                                  fontSize: 12,
                                  fontWeight: 700,
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                }}
                              >
                                {dept.count}
                              </div>

                              <span
                                style={{
                                  fontSize: 13,
                                  fontWeight: 700,
                                  color,
                                }}
                              >
                                {dept.name}
                              </span>
                            </div>

                            <ChevronRight
                              size={14}
                              color={color}
                              style={{
                                transform: isOpen
                                  ? "rotate(90deg)"
                                  : "rotate(0deg)",
                                transition: "transform .2s",
                              }}
                            />
                          </div>

                          {isOpen &&
                            safeDepartmentMembers(dept).map((member) => (
                              <div
                                key={member.id}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 10,
                                  padding: "7px 10px",
                                  borderRadius: 8,
                                }}
                              >
                                <div
                                  style={{
                                    width: 30,
                                    height: 30,
                                    borderRadius: "50%",
                                    background: bg,
                                    color,
                                    fontSize: 11,
                                    fontWeight: 700,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                  }}
                                >
                                  {initials(member.name)}
                                </div>

                                <div style={{ flex: 1 }}>
                                  <p style={{ fontSize: 13, color: T.head }}>
                                    {member.name}
                                  </p>
                                  <p style={{ fontSize: 11, color: T.muted }}>
                                    {member.position}
                                  </p>
                                </div>

                                <span
                                  style={{
                                    fontSize: 10,
                                    padding: "2px 8px",
                                    borderRadius: 12,
                                    background: bg,
                                    color,
                                  }}
                                >
                                  {member.department}
                                </span>
                              </div>
                            ))}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
};

export default React.memo(ShiftDistributionCard);
