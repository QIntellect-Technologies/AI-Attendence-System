/**
 * TodayStatusCard.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders department- or class/section-level attendance ratios as a donut chart.
 *
 * Default view: each donut slice is a configured department or student
 * class/section, sized by its total roster count.
 *
 * Selecting a group via the three-dot dropdown switches to its Present / Late /
 * Absent breakdown.
 */

import React, { useMemo, useState, useRef, useEffect } from "react";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from "recharts";
import DashboardCard from "./DashboardCard";
import { T } from "../../ui/theme";
import { useOrg } from "../../../contexts/OrgConfigContext";
import type {
  TodayStatusItem,
} from "../../../hooks/useDashboardOverviewData";
import { MoreHorizontal, ChevronDown, Building2, Users } from "lucide-react";
import {
  buildPresence,
  staffDepartment,
  staffStateOnDay,
  toDateKey,
} from "../../../utils/attendanceAnalytics";
import {
  configItemClassName,
  configItemFamily,
  configItemSectionName,
} from "../../../utils/templateRendering";

// ─── Department colours ────────────────────────────────────────────────────────
const DEPT_COLORS = [
  "#0f766e",
  "#1a699f",
  "#7c3aed",
  "#d97706",
  "#e11d48",
  "#059669",
  "#6366f1",
  "#ea580c",
  "#0891b2",
  "#be185d",
];

// Status colours when viewing a single department
const STATUS_COLOR: Record<string, string> = {
  Present: "#0f766e",
  Late: "#1a699f",
  Absent: "#E11D48",
};

function statusColor(name: string): string {
  return STATUS_COLOR[name] ?? T.muted;
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface DeptStats {
  name: string;
  total: number;
  present: number;
  late: number;
  absent: number;
}

interface TodayStatusCardProps {
  data?: TodayStatusItem[];
  presentToday: number;
  totalStaff?: number;
  peopleType?: string | null;
  isStudent?: boolean;
  groupLabel?: string;
  groupPlural?: string;
  subgroupLabel?: string;
  subgroupPlural?: string;
  /** Active staff roster. When given, absent = roster members with no attended row today. */
  staff?: any[];
  /** Today's attendance rows for the same scope as `staff`. */
  records?: any[];
}

// ─── Component ────────────────────────────────────────────────────────────────
const TodayStatusCard: React.FC<TodayStatusCardProps> = ({
  data,
  presentToday,
  totalStaff = 0,
  peopleType,
  isStudent = false,
  groupLabel = "Department",
  groupPlural = "Departments",
  subgroupLabel = "Section",
  subgroupPlural = "Sections",
  staff,
  records,
}) => {
  const items = data ?? [];
  const { cfg } = useOrg();
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelectedGroup(null);
  }, [peopleType]);

  // ── Configured grouping names (source of truth) ───────────────────────────
  const cfgGroupNames = useMemo<string[]>(() => {
    const names = new Set<string>();
    Object.values(cfg.departments).forEach((groups) => {
      groups.forEach((group) => {
        if (!isStudent) {
          if (group.name) names.add(group.name);
          return;
        }
        if (configItemFamily(group) !== "student") return;
        const className = configItemClassName(group).trim();
        const sectionName = configItemSectionName(group).trim();
        const name = [className, sectionName].filter(Boolean).join(" · ");
        if (name) names.add(name);
      });
    });
    return Array.from(names).sort();
  }, [cfg.departments, isStudent]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  // Build grouping stats. Configured groups seed the list; counts come from the
  // roster (so people with no row today are Absent) when `staff` is provided,
  // otherwise from the attendance rows alone (legacy behaviour).
  const deptStats = useMemo<DeptStats[]>(() => {
    const map = new Map<string, { total: number; present: number; late: number; absent: number }>(
      cfgGroupNames.map((name) => [name, { total: 0, present: 0, late: 0, absent: 0 }]),
    );
    const bucketFor = (dept: string) => {
      const matched =
        cfgGroupNames.find((n) => n.toLowerCase() === dept.toLowerCase()) ?? dept;
      if (!map.has(matched)) map.set(matched, { total: 0, present: 0, late: 0, absent: 0 });
      return map.get(matched)!;
    };

    const groupNameFor = (person: Record<string, unknown>) => {
      if (!isStudent) return staffDepartment(person);
      const className = String(
        person.className ??
          person.class_name ??
          person.groupName ??
          person.group_name ??
          person.department ??
          person.dept ??
          "",
      ).trim();
      const sectionName = String(
        person.sectionName ??
          person.section_name ??
          person.subgroupName ??
          person.subgroup_name ??
          "",
      ).trim();
      return [className, sectionName].filter(Boolean).join(" · ") || "Unassigned";
    };

    if (staff) {
      const todayMap = buildPresence(records ?? []).get(toDateKey(new Date()));
      for (const member of staff) {
        const b = bucketFor(groupNameFor(member));
        const state = staffStateOnDay(member, todayMap);
        b.total++;
        b[state]++;
      }
    } else {
      const seenStaff = new Set<string>();
      for (const entry of records ?? []) {
        const dept = groupNameFor(entry);
        if (!dept) continue;
        const identity = String(entry.staffId ?? entry.userId ?? entry.id);
        if (seenStaff.has(identity)) continue;
        seenStaff.add(identity);
        const b = bucketFor(dept);
        const status = (entry.status || "").toLowerCase();
        if (status === "absent") b.absent++;
        else if (status === "late") b.late++;
        else b.present++;
        b.total++;
      }
    }

    return Array.from(map.entries())
      .map(([name, counts]) => ({ name, ...counts }))
      .sort((a, b) => b.total - a.total);
  }, [records, staff, cfgGroupNames, isStudent]);

  const hasDeptData = deptStats.length > 0;

  // Determine what to show in the donut
  const { donutData, legendItems, centerValue, centerLabel } = useMemo(() => {
    if (!hasDeptData || selectedGroup === null) {
      if (hasDeptData) {
        return {
          donutData: deptStats.map((d, i) => ({
            id: d.name,
            name: d.name,
            value: d.total,
            color: DEPT_COLORS[i % DEPT_COLORS.length],
          })),
          legendItems: deptStats.map((d, i) => ({
            name: d.name,
            value: d.total,
            color: DEPT_COLORS[i % DEPT_COLORS.length],
            pct:
              (staff ? staff.length : totalStaff) > 0
                ? Math.round((d.total / (staff ? staff.length : totalStaff)) * 100)
                : 0,
            sub: `${d.present + d.late} present${d.late ? ` (${d.late} late)` : ""} · ${d.absent} absent`,
          })),
          centerValue: String(deptStats.length),
          centerLabel: isStudent ? "Groups" : groupPlural,
        };
      }

      // Fallback to old Present/Late/Absent data
      return {
        donutData: items.map((item) => ({
          id: item.name,
          name: item.name,
          value: item.value,
          color: statusColor(item.name),
        })),
        legendItems: items.map((item) => {
          const total = items.reduce((s, i) => s + i.value, 0);
          return {
            name: item.name,
            value: item.value,
            color: statusColor(item.name),
            pct: total > 0 ? Math.round((item.value / total) * 100) : 0,
            sub: "",
          };
        }),
        centerValue: String(presentToday),
        centerLabel: "Present",
      };
    }

    // Single department view
    const dept = deptStats.find((d) => d.name === selectedGroup);
    if (!dept) {
      return {
        donutData: [],
        legendItems: [],
        centerValue: "0",
        centerLabel: selectedGroup,
      };
    }

    const slices = [
      { name: "Present", value: dept.present, color: STATUS_COLOR.Present },
      { name: "Late", value: dept.late, color: STATUS_COLOR.Late },
      { name: "Absent", value: dept.absent, color: STATUS_COLOR.Absent },
    ];

    return {
      donutData: slices.map((s) => ({
        id: s.name,
        name: s.name,
        value: s.value,
        color: s.color,
      })),
      legendItems: slices.map((s) => ({
        name: s.name,
        value: s.value,
        color: s.color,
        pct:
          dept.total > 0 ? Math.round((s.value / dept.total) * 100) : 0,
        sub: "",
      })),
      centerValue: String(dept.present),
      centerLabel: "Present",
    };
  }, [
    hasDeptData,
    selectedGroup,
    deptStats,
    items,
    presentToday,
    totalStaff,
    staff,
    isStudent,
    groupPlural,
  ]);

  // SVG Donut Generator
  const svgDonut = useMemo(() => {
    const total = donutData.reduce((sum, d) => sum + d.value, 0);
    const radius = 105;
    const circumference = 2 * Math.PI * radius;
    const strokeWidth = 40;

    if (total === 0) {
      return (
        <circle
          cx="125" cy="125" r={radius}
          fill="none" stroke={T.slate200} strokeWidth={strokeWidth}
        />
      );
    }

    const activeSlices = donutData.filter((d) => d.value > 0);
    const gap = activeSlices.length > 1 ? 6 : 0;

    let currentOffset = 0;
    return activeSlices.map((slice, i) => {
      const sliceLength = (slice.value / total) * circumference;
      const strokeDasharray = `${Math.max(0, sliceLength - gap)} ${circumference}`;
      const strokeDashoffset = -currentOffset;
      currentOffset += sliceLength;

      return (
        <circle
          key={i}
          cx="125"
          cy="125"
          r={radius}
          fill="none"
          stroke={slice.color}
          strokeWidth={strokeWidth}
          strokeDasharray={strokeDasharray}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          style={{ transition: "stroke-dasharray 0.3s ease, stroke-dashoffset 0.3s ease" }}
          transform="rotate(-90 125 125)"
        />
      );
    });
  }, [donutData]);

  // Three-dots dropdown
  const menuAction = (
    <div ref={menuRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setMenuOpen(!menuOpen)}
        style={{
          background: menuOpen ? T.teal50 : "transparent",
          border: `1px solid ${menuOpen ? T.teal200 : "transparent"}`,
          cursor: "pointer",
          padding: "4px 8px",
          borderRadius: 8,
          lineHeight: 0,
          display: "flex",
          alignItems: "center",
          gap: 4,
          transition: "all 0.2s",
        }}
        onMouseEnter={(e) => {
          if (!menuOpen) {
            e.currentTarget.style.background = T.slate50;
            e.currentTarget.style.borderColor = T.border;
          }
        }}
        onMouseLeave={(e) => {
          if (!menuOpen) {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.borderColor = "transparent";
          }
        }}
      >
        <MoreHorizontal size={15} color={menuOpen ? T.teal700 : T.muted} />
        <ChevronDown
          size={10}
          color={menuOpen ? T.teal700 : T.muted}
          style={{
            transition: "transform 0.2s",
            transform: menuOpen ? "rotate(180deg)" : "rotate(0)",
          }}
        />
      </button>

      {menuOpen && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            background: T.card,
            border: `1px solid ${T.border}`,
            borderRadius: 14,
            boxShadow:
              "0 12px 40px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)",
            minWidth: 200,
            maxHeight: 300,
            overflowY: "auto",
            zIndex: 100,
            animation: "fadeInScale 0.15s ease-out",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "10px 14px 8px",
              fontSize: 10,
              fontWeight: 700,
              color: T.muted,
              textTransform: "uppercase",
              letterSpacing: "0.8px",
              fontFamily: "'DM Sans', sans-serif",
            }}
          >
            Filter by {isStudent ? `${groupLabel} / ${subgroupLabel}` : groupLabel}
          </div>

          {/* All groups */}
          <div
            onClick={() => {
              setSelectedGroup(null);
              setMenuOpen(false);
            }}
            style={{
              padding: "10px 14px",
              fontSize: 12.5,
              fontWeight: selectedGroup === null ? 700 : 500,
              color: selectedGroup === null ? T.teal700 : T.head,
              background: selectedGroup === null ? T.teal50 : "transparent",
              cursor: "pointer",
              borderTop: `1px solid ${T.border}`,
              fontFamily: "'DM Sans', sans-serif",
              transition: "background 0.15s",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
            onMouseEnter={(e) => {
              if (selectedGroup !== null)
                e.currentTarget.style.background = T.slate50;
            }}
            onMouseLeave={(e) => {
              if (selectedGroup !== null)
                e.currentTarget.style.background = "transparent";
            }}
          >
            <Building2 size={13} />
            All {isStudent ? `${groupPlural} / ${subgroupPlural}` : groupPlural}
          </div>

          {/* Individual groups */}
          {deptStats.map((dept, i) => (
            <div
              key={dept.name}
              onClick={() => {
                setSelectedGroup(dept.name);
                setMenuOpen(false);
              }}
              style={{
                padding: "10px 14px",
                fontSize: 12.5,
                fontWeight: selectedGroup === dept.name ? 700 : 500,
                color: selectedGroup === dept.name ? T.teal700 : T.head,
                background:
                  selectedGroup === dept.name ? T.teal50 : "transparent",
                cursor: "pointer",
                borderTop: `1px solid ${T.border}`,
                fontFamily: "'DM Sans', sans-serif",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => {
                if (selectedGroup !== dept.name)
                  e.currentTarget.style.background = T.slate50;
              }}
              onMouseLeave={(e) => {
                if (selectedGroup !== dept.name)
                  e.currentTarget.style.background = "transparent";
              }}
            >
              <div
                style={{ display: "flex", alignItems: "center", gap: 8 }}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: DEPT_COLORS[i % DEPT_COLORS.length],
                    flexShrink: 0,
                    boxShadow: `0 0 0 2px ${DEPT_COLORS[i % DEPT_COLORS.length]}30`,
                  }}
                />
                {dept.name}
              </div>
              <span
                style={{
                  fontSize: 11,
                  color: T.muted,
                  fontWeight: 600,
                  background: T.slate50,
                  padding: "2px 8px",
                  borderRadius: 20,
                }}
              >
                {dept.total}
              </span>
            </div>
          ))}

          {deptStats.length === 0 && (
            <div
              style={{
                padding: "16px",
                fontSize: 12,
                color: T.muted,
                textAlign: "center",
              }}
            >
              No department data
            </div>
          )}
        </div>
      )}

      {/* Inline CSS animation for the dropdown */}
      <style>{`
        @keyframes fadeInScale {
          from { opacity: 0; transform: translateY(-4px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );

  // Active filter chip (shown when a group is selected)
  const filterChip = selectedGroup ? (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px 4px 8px",
        background: `${T.teal600}12`,
        border: `1px solid ${T.teal200}`,
        borderRadius: 20,
        fontSize: 11,
        fontWeight: 600,
        color: T.teal700,
        fontFamily: "'DM Sans', sans-serif",
        marginBottom: 6,
      }}
    >
      <Users size={11} />
      {selectedGroup}
      <span
        onClick={() => setSelectedGroup(null)}
        style={{
          cursor: "pointer",
          marginLeft: 2,
          fontWeight: 800,
          fontSize: 13,
          lineHeight: 1,
          opacity: 0.6,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
        onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.6")}
      >
        ×
      </span>
    </div>
  ) : null;

  const cardTitle = selectedGroup
    ? selectedGroup
    : `${groupLabel}${isStudent ? ` / ${subgroupLabel}` : ""} Attendance`;

  return (
    <DashboardCard title={cardTitle} height="100%" action={menuAction}>
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          position: "relative",
        }}
      >
        {/* Filter chip */}
        {filterChip}

        {/* ── Donut Chart (Top) ── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "12px 0 6px",
            position: "relative",
            minHeight: 180,
          }}
        >
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie
                data={donutData}
                cx="50%"
                cy="50%"
                innerRadius={55}
                outerRadius={75}
                paddingAngle={4}
                dataKey="value"
                nameKey="name"
                isAnimationActive={true}
                animationDuration={900}
                animationEasing="ease-out"
              >
                {donutData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} stroke="none" />
                ))}
              </Pie>
              <RechartsTooltip
                content={({ active, payload }) => {
                  if (!active || !payload || !payload.length) return null;
                  const d = payload[0].payload;
                  return (
                    <div
                      style={{
                        background: "#1e293b",
                        color: "#fff",
                        padding: "6px 12px",
                        borderRadius: 8,
                        fontSize: 12,
                        fontWeight: 700,
                        boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
                      }}
                    >
                      {d.name}: {d.value} ({Math.round((d.value / (donutData.reduce((a, b) => a + b.value, 0) || 1)) * 100)}%)
                    </div>
                  );
                }}
              />
            </PieChart>
          </ResponsiveContainer>

          {/* Inner Cutout Readout */}
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              width: 96,
              height: 96,
              borderRadius: "50%",
              background: "#ffffff",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "inset 0 2px 6px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04)",
              pointerEvents: "none",
            }}
          >
            <span
              style={{
                fontSize: 26,
                fontWeight: 800,
                color: "#102a3f",
                fontFamily: "'DM Sans', sans-serif",
                lineHeight: 1,
              }}
            >
              {centerValue}
            </span>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: "#64748b",
                fontFamily: "'DM Sans', sans-serif",
                marginTop: 3,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              {centerLabel}
            </span>
          </div>
        </div>

        {/* ── Legend rows (Bottom) ── */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            overflowY: "auto",
            paddingRight: 4,
          }}
        >
          {legendItems.map((item) => (
            <div
              key={item.name}
              onClick={() => {
                if (!selectedGroup && hasDeptData) {
                  setSelectedGroup(item.name);
                }
              }}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 14px",
                background: T.slate50,
                borderRadius: 10,
                border: `1px solid ${T.border}`,
                cursor:
                  !selectedGroup && hasDeptData ? "pointer" : "default",
                transition: "all 0.2s ease",
              }}
              onMouseEnter={(e) => {
                if (!selectedGroup && hasDeptData) {
                  e.currentTarget.style.background = `${item.color}10`;
                  e.currentTarget.style.borderColor = `${item.color}40`;
                  e.currentTarget.style.transform = "translateX(4px)";
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = T.slate50;
                e.currentTarget.style.borderColor = T.border;
                e.currentTarget.style.transform = "translateX(0)";
              }}
            >
              {/* Left: dot + label + sub */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: item.color,
                    flexShrink: 0,
                    display: "inline-block",
                    boxShadow: `0 0 0 3px ${item.color}20`,
                  }}
                />
                <div>
                  <span
                    style={{
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: T.head,
                      fontFamily: "'DM Sans', sans-serif",
                    }}
                  >
                    {item.name}
                  </span>
                  {item.sub && (
                    <div
                      style={{
                        fontSize: 10.5,
                        color: T.muted,
                        fontFamily: "'DM Sans', sans-serif",
                        marginTop: 1,
                      }}
                    >
                      {item.sub}
                    </div>
                  )}
                </div>
              </div>

              {/* Right: value + percentage pill */}
              <div
                style={{ display: "flex", alignItems: "center", gap: 8 }}
              >
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 800,
                    color: T.head,
                    fontFamily: "'DM Sans', sans-serif",
                  }}
                >
                  {item.value.toLocaleString()}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: item.color,
                    background: `${item.color}15`,
                    padding: "3px 8px",
                    borderRadius: 20,
                    fontFamily: "'DM Sans', sans-serif",
                    minWidth: 36,
                    textAlign: "center",
                  }}
                >
                  {item.pct}%
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </DashboardCard>
  );
};

export default React.memo(TodayStatusCard);