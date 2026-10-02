/**
 * TodayStatusCard.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders department-level attendance ratios as a donut chart.
 *
 * Default view ("All Departments"): each donut slice = one department,
 * sized by its total staff count.
 *
 * When a specific department is selected via the three-dot dropdown,
 * the donut switches to that department's Present / Late / Absent breakdown.
 */

import React, { useMemo, useState, useRef, useEffect } from "react";
import DashboardCard from "./DashboardCard";
import { T } from "../../ui/theme";
import { useOrg } from "../../../contexts/OrgConfigContext";
import type {
  DashboardLiveLogItem,
  TodayStatusItem,
} from "../../../hooks/useDashboardOverviewData";
import { getAttendanceLogs } from "../../../pages/attendance_temp/api/attendanceApi";
import { MoreHorizontal, ChevronDown, Building2, Users } from "lucide-react";

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
  liveLog?: DashboardLiveLogItem[];
  totalStaff?: number;
}

// ─── Component ────────────────────────────────────────────────────────────────
const TodayStatusCard: React.FC<TodayStatusCardProps> = ({
  data,
  presentToday,
  liveLog = [],
  totalStaff = 0,
}) => {
  const items = data ?? [];
  const { cfg } = useOrg();
  const [selectedDept, setSelectedDept] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [fetchedLogs, setFetchedLogs] = useState<any[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (liveLog.length === 0) {
      getAttendanceLogs(500)
        .then((logs) => setFetchedLogs(logs))
        .catch(() => {});
    } else {
      setFetchedLogs(liveLog);
    }
  }, [liveLog]);

  // ── All configured department names (source of truth) ─────────────────────
  const cfgDeptNames = useMemo<string[]>(() => {
    const names = new Set<string>();
    Object.values(cfg.departments).forEach((depts) =>
      depts.forEach((d) => { if (d.name) names.add(d.name); })
    );
    return Array.from(names).sort();
  }, [cfg.departments]);

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

  // Build department stats — cfg departments are the base, attendance counts are overlaid
  const deptStats = useMemo<DeptStats[]>(() => {
    // Seed map with all configured departments (ensures HR, Sales, etc show even with 0 attendance)
    const map = new Map<string, { present: number; late: number; absent: number }>(
      cfgDeptNames.map((name) => [name, { present: 0, late: 0, absent: 0 }])
    );

    for (const entry of fetchedLogs) {
      const dept = entry.department;
      if (!dept) continue; // skip entries with no department (don't bucket as Unassigned)
      // Case-insensitive match to cfg dept names
      const matched = cfgDeptNames.find(
        (n) => n.toLowerCase() === dept.toLowerCase()
      ) ?? dept; // if not in cfg, use as-is
      if (!map.has(matched)) map.set(matched, { present: 0, late: 0, absent: 0 });
      const bucket = map.get(matched)!;
      const status = (entry.status || "").toLowerCase();
      if (status === "present" || status === "late" || status === "checked_in" || status === "checked_out" || status === "half_day") bucket.present++;
      else if (status === "absent") bucket.absent++;
    }

    return Array.from(map.entries())
      .map(([name, counts]) => ({
        name,
        total: counts.present + counts.late + counts.absent,
        ...counts,
      }))
      .sort((a, b) => b.total - a.total);
  }, [fetchedLogs, cfgDeptNames]);

  const hasDeptData = deptStats.length > 0;

  // Determine what to show in the donut
  const { donutData, legendItems, centerValue, centerLabel } = useMemo(() => {
    if (!hasDeptData || selectedDept === null) {
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
              totalStaff > 0
                ? Math.round((d.total / totalStaff) * 100)
                : 0,
            sub: `${d.present} present · ${d.absent} absent`,
          })),
          centerValue: String(deptStats.length),
          centerLabel: "Departments",
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
    const dept = deptStats.find((d) => d.name === selectedDept);
    if (!dept) {
      return {
        donutData: [],
        legendItems: [],
        centerValue: "0",
        centerLabel: selectedDept,
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
  }, [hasDeptData, selectedDept, deptStats, items, presentToday, totalStaff]);

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
            Filter by Department
          </div>

          {/* All Departments */}
          <div
            onClick={() => {
              setSelectedDept(null);
              setMenuOpen(false);
            }}
            style={{
              padding: "10px 14px",
              fontSize: 12.5,
              fontWeight: selectedDept === null ? 700 : 500,
              color: selectedDept === null ? T.teal700 : T.head,
              background: selectedDept === null ? T.teal50 : "transparent",
              cursor: "pointer",
              borderTop: `1px solid ${T.border}`,
              fontFamily: "'DM Sans', sans-serif",
              transition: "background 0.15s",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
            onMouseEnter={(e) => {
              if (selectedDept !== null)
                e.currentTarget.style.background = T.slate50;
            }}
            onMouseLeave={(e) => {
              if (selectedDept !== null)
                e.currentTarget.style.background = "transparent";
            }}
          >
            <Building2 size={13} />
            All Departments
          </div>

          {/* Individual departments */}
          {deptStats.map((dept, i) => (
            <div
              key={dept.name}
              onClick={() => {
                setSelectedDept(dept.name);
                setMenuOpen(false);
              }}
              style={{
                padding: "10px 14px",
                fontSize: 12.5,
                fontWeight: selectedDept === dept.name ? 700 : 500,
                color: selectedDept === dept.name ? T.teal700 : T.head,
                background:
                  selectedDept === dept.name ? T.teal50 : "transparent",
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
                if (selectedDept !== dept.name)
                  e.currentTarget.style.background = T.slate50;
              }}
              onMouseLeave={(e) => {
                if (selectedDept !== dept.name)
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

  // Active filter chip (shown when a department is selected)
  const filterChip = selectedDept ? (
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
      {selectedDept}
      <span
        onClick={() => setSelectedDept(null)}
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

  const cardTitle = selectedDept
    ? `${selectedDept}`
    : "Department Attendance";

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

        {/* ── CSS Donut (Top) ── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px 0",
            marginBottom: 20,
            position: "relative",
          }}
        >
          {/* Outer SVG Donut */}
          <svg 
            width="250" 
            height="250" 
            viewBox="0 0 250 250" 
            style={{ filter: "drop-shadow(0 8px 12px rgba(0,0,0,0.06))" }}
          >
            {svgDonut}
          </svg>

          {/* Inner Cutout */}
          <div
            style={{
              position: "absolute",
              width: 165,
              height: 165,
              borderRadius: "50%",
              background: T.card,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "inset 0 4px 12px rgba(0,0,0,0.04)",
            }}
          >
              <span
                style={{
                  fontSize: 36,
                  fontWeight: 800,
                  color: T.head,
                  fontFamily: "'DM Sans', sans-serif",
                  lineHeight: 1,
                  letterSpacing: "-1px",
                }}
              >
                {centerValue}
              </span>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: T.muted,
                  fontFamily: "'DM Sans', sans-serif",
                  marginTop: 6,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
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
                if (!selectedDept && hasDeptData) {
                  setSelectedDept(item.name);
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
                  !selectedDept && hasDeptData ? "pointer" : "default",
                transition: "all 0.2s ease",
              }}
              onMouseEnter={(e) => {
                if (!selectedDept && hasDeptData) {
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
