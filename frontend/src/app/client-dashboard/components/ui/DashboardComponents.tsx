/**
 * DashboardComponents.tsx — v4
 * ─────────────────────────────────────────────────────────────────────────────
 * All shared dashboard widgets.
 * Colors: imports T + SEMI_COLORS from theme.ts — zero internal color definitions.
 * Works inside AdminLayout <Outlet /> — no sidebar, no topbar.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useEffect, type ReactNode } from "react";
import {
  CheckCircle,
  AlertCircle,
  Info,
  TrendingUp,
  TrendingDown,
  Package,
  Users,
  CheckSquare,
  FileText,
  DollarSign,
  BookOpen,
  Bus,
  Calendar,
  MessageSquare,
  Activity,
  CalendarCheck,
  Pill,
  Receipt,
  Microscope,
  Bed,
  Stethoscope,
  Banknote,
  Umbrella,
  Target,
  Briefcase,
  Monitor,
  Cpu,
  CheckCircle2,
  Wrench,
  Truck,
  Heart,
  UserPlus,
  Volume2,
  Users2,
  ShoppingBag,
  LayoutGrid,
  TrendingUp as TrUp,
  Landmark,
  type LucideIcon,
} from "lucide-react";
import { T, SEMI_COLORS } from "./theme";
type ActivityItem = {
  text: string;
  time: string;
  type: "success" | "warning" | "info" | "error";
};
// ─── ANIMATION HOOK ───────────────────────────────────────────────────────────
// ─── ANIMATION HOOK ───────────────────────────────────────────────────────────
function useEnterProgress(duration = 750): number {
  const [p, setP] = useState(0);

  useEffect(() => {
    let frameId = 0;
    let start: number | null = null;
    let cancelled = false;

    setP(0);

    const safeDuration = Math.max(0, duration);

    if (safeDuration === 0) {
      setP(1);
      return () => {
        cancelled = true;
      };
    }

    const tick = (ts: number) => {
      if (cancelled) return;

      if (start === null) start = ts;

      const elapsed = Math.min((ts - start) / safeDuration, 1);
      const nextProgress = 1 - Math.pow(1 - elapsed, 3); // ease-out cubic

      setP(nextProgress);

      if (elapsed < 1) {
        frameId = requestAnimationFrame(tick);
      }
    };

    frameId = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
    };
  }, [duration]);

  return p;
}

// ─── CARD ─────────────────────────────────────────────────────────────────────
export const Card: React.FC<{
  children: ReactNode;
  style?: React.CSSProperties;
  hover?: boolean;
  onClick?: () => void;
  padding?: number | string;
}> = ({ children, style, hover, onClick, padding = "20px 22px" }) => {
  const [hov, setHov] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => hover && setHov(true)}
      onMouseLeave={() => hover && setHov(false)}
      style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: 12,
        padding,
        boxShadow: hov
          ? "0 6px 20px rgba(17,141,151,0.10)"
          : "0 1px 3px rgba(0,0,0,0.05)",
        transform: hov ? "translateY(-2px)" : "none",
        transition: "box-shadow .2s, transform .2s",
        cursor: onClick ? "pointer" : "default",
        ...style,
      }}
    >
      {children}
    </div>
  );
};

// ─── SECTION HEADER ───────────────────────────────────────────────────────────
export const SH: React.FC<{
  title: string;
  sub?: string;
  right?: ReactNode;
}> = ({ title, sub, right }) => (
  <div
    style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-start",
      marginBottom: 16,
    }}
  >
    <div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: T.head,
          letterSpacing: "-0.2px",
        }}
      >
        {title}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>{sub}</div>
      )}
    </div>
    {right}
  </div>
);

// ─── BADGE ────────────────────────────────────────────────────────────────────
export const Badge: React.FC<{
  children: ReactNode;
  variant?: "teal" | "amber" | "navy";
}> = ({ children, variant = "teal" }) => {
  const map = {
    teal: { bg: T.teal100, color: T.teal600 },
    amber: { bg: T.amberBg, color: T.amber },
    navy: { bg: T.teal50, color: T.navy600 },
  };
  const s = map[variant];
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        background: s.bg,
        color: s.color,
        padding: "2px 9px",
        borderRadius: 20,
        display: "inline-block",
      }}
    >
      {children}
    </span>
  );
};

// ─── STAT CARD ────────────────────────────────────────────────────────────────
export const StatCard: React.FC<{
  label: string;
  value: string | number;
  sub?: string;
  Icon: LucideIcon;
  iconBg?: string;
  iconColor?: string;
  trend?: { value: number; label: string };
}> = ({
  label,
  value,
  sub,
  Icon,
  iconBg = T.teal100,
  iconColor = T.teal600,
  trend,
}) => (
  <Card>
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: T.muted,
            textTransform: "uppercase",
            letterSpacing: "0.09em",
            marginBottom: 8,
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: 26,
            fontWeight: 800,
            color: T.head,
            letterSpacing: "-0.5px",
            lineHeight: 1,
          }}
        >
          {value}
        </div>
        {sub && (
          <div style={{ fontSize: 11, color: T.muted, marginTop: 5 }}>
            {sub}
          </div>
        )}
      </div>
      <div
        style={{
          width: 42,
          height: 42,
          borderRadius: 10,
          flexShrink: 0,
          background: iconBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon size={19} color={iconColor} strokeWidth={1.8} />
      </div>
    </div>
    {trend && (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginTop: 12,
        }}
      >
        {trend.value >= 0 ? (
          <TrendingUp size={12} color={T.teal600} />
        ) : (
          <TrendingDown size={12} color={T.amber} />
        )}
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: trend.value >= 0 ? T.teal600 : T.amber,
            background: trend.value >= 0 ? T.teal100 : T.amberBg,
            padding: "1px 8px",
            borderRadius: 20,
          }}
        >
          {trend.value >= 0 ? "+" : ""}
          {trend.value}%
        </span>
        <span style={{ fontSize: 11, color: T.muted }}>{trend.label}</span>
      </div>
    )}
  </Card>
);

// ─── ISSUE BANNER ─────────────────────────────────────────────────────────────
export const IssueBanner: React.FC<{ count: number }> = ({ count }) =>
  count > 0 ? (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: T.amberBg,
        border: `1px solid ${T.amberBd}`,
        borderRadius: 10,
        padding: "10px 16px",
      }}
    >
      <AlertCircle size={15} color={T.amber} />
      <span style={{ fontSize: 13, color: T.amber, fontWeight: 600 }}>
        {count} open issue{count !== 1 ? "s" : ""} require attention
      </span>
      <button
        style={{
          marginLeft: "auto",
          fontSize: 12,
          color: T.amber,
          background: "none",
          border: `1px solid ${T.amberBd}`,
          borderRadius: 6,
          padding: "3px 12px",
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        View All
      </button>
    </div>
  ) : null;

// ─── ANIMATED LINE CHART ──────────────────────────────────────────────────────
export const LineChart: React.FC<{
  data: { label: string; value: number }[];
  color?: string;
  height?: number;
  isPercent?: boolean;
  formatY?: (v: number) => string;
}> = ({
  data,
  color = T.teal600,
  height = 140,
  isPercent = false,
  formatY,
}) => {
  const progress = useEnterProgress(800);
  const fmt =
    formatY ??
    ((v: number) =>
      isPercent
        ? `${v}%`
        : v >= 1000
          ? `${(v / 1000).toFixed(1)}k`
          : String(Math.round(v)));

  const W = 500,
    H = height;
  const PAD = { t: 14, b: 28, l: 44, r: 10 };
  const iW = W - PAD.l - PAD.r;
  const iH = H - PAD.t - PAD.b;

  const vals = data.map((d) => d.value);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals, 1);
  const range = maxV - minV || 1;

  const allPts = data.map((d, i) => ({
    x: PAD.l + (i / Math.max(data.length - 1, 1)) * iW,
    y: PAD.t + iH - ((d.value - minV) / range) * iH,
    ...d,
  }));

  // Build animated path up to progress fraction
  const cutIdx = Math.min(
    Math.ceil(progress * (allPts.length - 1)),
    allPts.length - 1,
  );
  const drawnPts = allPts.slice(0, cutIdx + 1);

  const pathD = drawnPts
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`)
    .join(" ");
  const areaD =
    drawnPts.length > 1
      ? `${pathD} L${drawnPts[drawnPts.length - 1].x} ${PAD.t + iH} L${drawnPts[0].x} ${PAD.t + iH}Z`
      : "";

  const uid = `lc${color.replace(/[^a-z0-9]/gi, "")}${height}`;
  const gridVals = [minV, Math.round(minV + range * 0.5), maxV];
  const step = Math.ceil(data.length / 7);

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      style={{ overflow: "visible", fontFamily: "inherit", display: "block" }}
    >
      <defs>
        <linearGradient id={uid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.15" />
          <stop offset="100%" stopColor={color} stopOpacity="0.01" />
        </linearGradient>
      </defs>

      {gridVals.map((v, i) => {
        const y = PAD.t + iH - ((v - minV) / range) * iH;
        return (
          <g key={i}>
            <line
              x1={PAD.l}
              y1={y}
              x2={W - PAD.r}
              y2={y}
              stroke={T.border}
              strokeWidth={1}
              strokeDasharray="4 3"
            />
            <text
              x={PAD.l - 6}
              y={y + 4}
              textAnchor="end"
              fontSize={9}
              fill={T.muted}
              fontFamily="inherit"
            >
              {fmt(v)}
            </text>
          </g>
        );
      })}

      {areaD && <path d={areaD} fill={`url(#${uid})`} />}
      {pathD && (
        <path
          d={pathD}
          fill="none"
          stroke={color}
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}

      {allPts.map((p, i) => (
        <g key={i}>
          {i % step === 0 && (
            <text
              x={p.x}
              y={H - 5}
              textAnchor="middle"
              fontSize={9}
              fill={T.muted}
              fontFamily="inherit"
            >
              {p.label}
            </text>
          )}
          {i <= cutIdx && (
            <circle
              cx={p.x}
              cy={p.y}
              r={3.5}
              fill={T.card}
              stroke={color}
              strokeWidth={2}
            />
          )}
        </g>
      ))}
    </svg>
  );
};

// ─── ANIMATED BAR CHART ───────────────────────────────────────────────────────
export const BarChart: React.FC<{
  data: { label: string; value: number; subLabel?: string }[];
  color?: string;
  height?: number;
  formatV?: (v: number) => string;
}> = ({
  data,
  color = T.teal600,
  height = 160,
  formatV = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)),
}) => {
  const progress = useEnterProgress(700);

  const W = 500,
    H = height;
  const PAD = { t: 24, b: 36, l: 6, r: 6 };
  const iW = W - PAD.l - PAD.r;
  const iH = H - PAD.t - PAD.b;
  const maxV = Math.max(...data.map((d) => d.value), 1);
  const bW = Math.min(52, iW / data.length - 12);
  const gap = (iW - bW * data.length) / (data.length + 1);

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      style={{ overflow: "visible", fontFamily: "inherit", display: "block" }}
    >
      {data.map((d, i) => {
        const fullH = Math.max(4, (d.value / maxV) * iH);
        const bH = fullH * progress;
        const x = PAD.l + gap * (i + 1) + bW * i;
        const y = PAD.t + iH - bH;

        return (
          <g key={i}>
            <rect
              x={x}
              y={PAD.t}
              width={bW}
              height={iH}
              rx={7}
              fill={T.teal50}
            />
            <rect
              x={x}
              y={y}
              width={bW}
              height={bH}
              rx={7}
              fill={color}
              opacity={0.88}
            />
            <text
              x={x + bW / 2}
              y={PAD.t + iH - fullH - 7}
              textAnchor="middle"
              fontSize={11}
              fontWeight="700"
              fill={color}
              fontFamily="inherit"
            >
              {formatV(d.value)}
            </text>
            <text
              x={x + bW / 2}
              y={H - 20}
              textAnchor="middle"
              fontSize={10}
              fill={T.muted}
              fontFamily="inherit"
            >
              {d.label.length > 10 ? d.label.split(" ")[0] : d.label}
            </text>
            {d.subLabel && (
              <text
                x={x + bW / 2}
                y={H - 7}
                textAnchor="middle"
                fontSize={9}
                fill={T.muted}
                fontFamily="inherit"
              >
                {d.subLabel}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

// ─── ANIMATED FULL DONUT ──────────────────────────────────────────────────────
interface DonutSlice {
  label: string;
  count: number;
  color?: string;
}

export const DonutChart: React.FC<{
  slices: DonutSlice[];
  centerLabel?: string;
  centerSub?: string;
  size?: number;
}> = ({ slices, centerLabel, centerSub, size = 130 }) => {
  const progress = useEnterProgress(900);

  const total = slices.reduce((s, v) => s + v.count, 0) || 1;
  const CX = size / 2,
    CY = size / 2;
  const R = size * 0.4,
    r = size * 0.25;

  let angle = -Math.PI / 2;
  const paths = slices.map((sl, idx) => {
    const pct = sl.count / total;
    const drawn = pct * progress;
    const start = angle;
    const end = angle + drawn * 2 * Math.PI;
    angle = angle + pct * 2 * Math.PI;

    if (drawn < 0.001) return null;
    const large = drawn > 0.5 ? 1 : 0;
    const x1 = CX + R * Math.cos(start),
      y1 = CY + R * Math.sin(start);
    const x2 = CX + R * Math.cos(end),
      y2 = CY + R * Math.sin(end);
    const ix1 = CX + r * Math.cos(end),
      iy1 = CY + r * Math.sin(end);
    const ix2 = CX + r * Math.cos(start),
      iy2 = CY + r * Math.sin(start);
    const d = `M${x1} ${y1} A${R} ${R} 0 ${large} 1 ${x2} ${y2} L${ix1} ${iy1} A${r} ${r} 0 ${large} 0 ${ix2} ${iy2}Z`;

    return {
      d,
      color: sl.color ?? SEMI_COLORS[idx % SEMI_COLORS.length],
    };
  });

  return (
    <svg width={size} height={size} style={{ display: "block", flexShrink: 0 }}>
      {paths.map((p, i) => p && <path key={i} d={p.d} fill={p.color} />)}
      {centerLabel && (
        <>
          <text
            x={CX}
            y={CY - 5}
            textAnchor="middle"
            fontSize={size * 0.14}
            fontWeight="800"
            fill={T.head}
            fontFamily="inherit"
          >
            {centerLabel}
          </text>
          {centerSub && (
            <text
              x={CX}
              y={CY + size * 0.1}
              textAnchor="middle"
              fontSize={size * 0.08}
              fill={T.muted}
              fontFamily="inherit"
            >
              {centerSub}
            </text>
          )}
        </>
      )}
    </svg>
  );
};

// ─── ANIMATED SEMI-DONUT (reference image style) ──────────────────────────────
export const SemiDonut: React.FC<{
  slices: DonutSlice[];
  centerLabel?: string;
  centerSub?: string;
  size?: number;
}> = ({ slices, centerLabel, centerSub, size = 160 }) => {
  const progress = useEnterProgress(900);

  const total = slices.reduce((s, v) => s + v.count, 0) || 1;
  const CX = size / 2;
  const CY = size * 0.62;
  const R = size * 0.42,
    r = size * 0.26;

  let angle = -Math.PI;
  const paths = slices.map((sl, idx) => {
    const pct = sl.count / total;
    const drawn = pct * progress;
    const start = angle;
    const end = angle + drawn * Math.PI;
    angle = angle + pct * Math.PI;

    if (drawn < 0.001) return null;
    const large = drawn > 0.5 ? 1 : 0;
    const x1 = CX + R * Math.cos(start),
      y1 = CY + R * Math.sin(start);
    const x2 = CX + R * Math.cos(end),
      y2 = CY + R * Math.sin(end);
    const ix1 = CX + r * Math.cos(end),
      iy1 = CY + r * Math.sin(end);
    const ix2 = CX + r * Math.cos(start),
      iy2 = CY + r * Math.sin(start);
    const d = `M${x1} ${y1} A${R} ${R} 0 ${large} 1 ${x2} ${y2} L${ix1} ${iy1} A${r} ${r} 0 ${large} 0 ${ix2} ${iy2}Z`;

    return {
      d,
      color: sl.color ?? SEMI_COLORS[idx % SEMI_COLORS.length],
    };
  });

  return (
    <svg
      width={size}
      height={size * 0.66}
      style={{ display: "block", flexShrink: 0 }}
    >
      {paths.map((p, i) => p && <path key={i} d={p.d} fill={p.color} />)}
      {centerLabel && (
        <>
          <text
            x={CX}
            y={CY - 4}
            textAnchor="middle"
            fontSize={size * 0.13}
            fontWeight="800"
            fill={T.head}
            fontFamily="inherit"
          >
            {centerLabel}
          </text>
          {centerSub && (
            <text
              x={CX}
              y={CY + size * 0.1}
              textAnchor="middle"
              fontSize={size * 0.075}
              fill={T.muted}
              fontFamily="inherit"
            >
              {centerSub}
            </text>
          )}
        </>
      )}
    </svg>
  );
};

// ─── ROLE DISTRIBUTION (Semi-donut + legend) ──────────────────────────────────
// Level → color from SEMI_COLORS, matching the donut segments exactly
const LEVEL_COLORS: Record<number, string> = {
  1: SEMI_COLORS[0], // navy700 — top level
  2: SEMI_COLORS[1], // navy600 — senior
  3: SEMI_COLORS[2], // teal600 — middle
  4: SEMI_COLORS[3], // teal500 — staff
  5: SEMI_COLORS[4], // teal200 — external
};
const LEVEL_LABELS: Record<number, string> = {
  1: "Top Level",
  2: "Senior",
  3: "Middle",
  4: "Staff",
  5: "External",
};

export const RoleDistribution: React.FC<{
  roles: { name: string; count: number; level: number }[];
  title?: string;
  sub?: string;
}> = ({ roles, title, sub }) => {
  const byLevel = roles.reduce<Record<number, number>>((acc, r) => {
    acc[r.level] = (acc[r.level] ?? 0) + r.count;
    return acc;
  }, {});
  const total = Object.values(byLevel).reduce((s, v) => s + v, 0) || 1;
  const levels = Object.keys(byLevel).map(Number).sort();
  const slices = levels.map((lvl) => ({
    label: LEVEL_LABELS[lvl] ?? `L${lvl}`,
    count: byLevel[lvl],
    color: LEVEL_COLORS[lvl] ?? T.teal600,
  }));

  return (
    <div>
      {title && <SH title={title} sub={sub} />}
      <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
        <SemiDonut
          slices={slices}
          centerLabel={String(total)}
          centerSub="Staff"
          size={150}
        />
        <div style={{ flex: 1, paddingTop: 6 }}>
          {slices.map((s) => {
            const pct = Math.round((s.count / total) * 100);
            return (
              <div key={s.label} style={{ marginBottom: 10 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: 4,
                  }}
                >
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 7 }}
                  >
                    <div
                      style={{
                        width: 9,
                        height: 9,
                        borderRadius: 2,
                        background: s.color,
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{ fontSize: 12, fontWeight: 600, color: T.body }}
                    >
                      {s.label}
                    </span>
                  </div>
                  <span
                    style={{ fontSize: 12, fontWeight: 700, color: s.color }}
                  >
                    {s.count}
                  </span>
                </div>
                <div
                  style={{ height: 4, background: T.slate200, borderRadius: 2 }}
                >
                  <div
                    style={{
                      width: `${pct}%`,
                      height: "100%",
                      background: s.color,
                      borderRadius: 2,
                      transition: "width .6s",
                    }}
                  />
                </div>
              </div>
            );
          })}
          {/* Role pills */}
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 10 }}
          >
            {roles.map((r) => {
              const c = LEVEL_COLORS[r.level] ?? T.teal600;
              return (
                <span
                  key={r.name}
                  style={{
                    fontSize: 10,
                    fontWeight: 500,
                    padding: "2px 8px",
                    borderRadius: 20,
                    color: c,
                    background: T.teal50,
                    border: `1px solid ${T.teal200}`,
                  }}
                >
                  {r.name}
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── MODULE USAGE GRID ────────────────────────────────────────────────────────
const MODULE_ICON: Record<string, LucideIcon> = {
  students: Users,
  attendance: CheckSquare,
  examination: FileText,
  fees: DollarSign,
  library: BookOpen,
  transport: Bus,
  timetable: Calendar,
  communication: MessageSquare,
  patients: Activity,
  appointments: CalendarCheck,
  pharmacy: Pill,
  billing: Receipt,
  laboratory: Microscope,
  wards: Bed,
  doctors: Stethoscope,
  employees: Users,
  payroll: Banknote,
  leave: Umbrella,
  crm: Target,
  projects: Briefcase,
  assets: Monitor,
  inventory: Package,
  production: Cpu,
  quality: CheckCircle2,
  maintenance: Wrench,
  suppliers: Truck,
  donors: Heart,
  volunteers: UserPlus,
  campaigns: Volume2,
  beneficiaries: Users2,
  orders: ShoppingBag,
  tables: LayoutGrid,
  menu: BookOpen,
  finance: Landmark,
  reports: TrUp,
  staff: Users,
};
const MODULE_LABEL: Record<string, string> = {
  students: "Students",
  attendance: "Attendance",
  examination: "Exams",
  fees: "Fees",
  library: "Library",
  transport: "Transport",
  timetable: "Timetable",
  communication: "Comms",
  patients: "Patients",
  appointments: "Appts",
  pharmacy: "Pharmacy",
  billing: "Billing",
  laboratory: "Lab",
  wards: "Wards",
  doctors: "Doctors",
  employees: "Employees",
  payroll: "Payroll",
  leave: "Leave",
  crm: "CRM",
  projects: "Projects",
  assets: "Assets",
  inventory: "Inventory",
  production: "Production",
  quality: "QC",
  maintenance: "Maint.",
  suppliers: "Suppliers",
  donors: "Donors",
  volunteers: "Volunteers",
  campaigns: "Campaigns",
  beneficiaries: "Beneficiaries",
  orders: "Orders",
  tables: "Tables",
  menu: "Menu",
  finance: "Finance",
  reports: "Reports",
  staff: "Staff",
};

const modMeta = (score: number) => {
  if (score >= 80) return { color: T.teal700, bg: T.teal100, label: "High" };
  if (score >= 55) return { color: T.teal600, bg: T.teal50, label: "Med" };
  if (score >= 30) return { color: T.amber, bg: T.amberBg, label: "Low" };
  return { color: T.muted, bg: T.slate100, label: "Idle" };
};

export const ModuleUsageGrid: React.FC<{
  modules: string[];
  moduleActivity: Record<string, number>;
}> = ({ modules, moduleActivity }) => (
  <div
    style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))",
      gap: 8,
    }}
  >
    {modules.map((key) => {
      const score = moduleActivity[key] ?? 0;
      const { color, bg, label } = modMeta(score);
      const Icon = MODULE_ICON[key] ?? Package;
      return (
        <div
          key={key}
          style={{
            background: bg,
            borderRadius: 10,
            padding: "10px 6px",
            textAlign: "center",
            border: `1px solid ${T.teal200}`,
            transition: "transform .15s",
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.transform = "scale(1.04)")
          }
          onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
        >
          <Icon
            size={15}
            color={color}
            strokeWidth={1.8}
            style={{ marginBottom: 4 }}
          />
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              color,
              marginBottom: 3,
              lineHeight: 1.2,
            }}
          >
            {MODULE_LABEL[key] ?? key}
          </div>
          <div style={{ height: 3, background: T.teal200, borderRadius: 2 }}>
            <div
              style={{
                height: "100%",
                width: `${score}%`,
                background: color,
                borderRadius: 2,
              }}
            />
          </div>
          <div style={{ fontSize: 9, color, marginTop: 3, fontWeight: 700 }}>
            {label}
          </div>
        </div>
      );
    })}
  </div>
);

// ─── ACTIVITY FEED ────────────────────────────────────────────────────────────

// Derive key union from ActivityItem directly — stays in sync automatically.
type ActivityType = ActivityItem["type"];

const ACT_CFG: Record<
  ActivityType,
  { Icon: LucideIcon; color: string; bg: string }
> = {
  success: { Icon: CheckCircle, color: T.teal600, bg: T.teal100 },
  warning: { Icon: AlertCircle, color: T.amber, bg: T.amberBg },
  info: { Icon: Info, color: T.navy600, bg: T.teal50 },
  error: { Icon: AlertCircle, color: "#E11D48", bg: "#FFF1F2" },
};

const DEFAULT_ACT = ACT_CFG.info;

export const ActivityFeed: React.FC<{
  items: ActivityItem[];
  compact?: boolean;
}> = ({ items, compact = false }) => (
  <div>
    {items.map((item, i) => {
      const { Icon, color, bg } = ACT_CFG[item.type] ?? DEFAULT_ACT;
      return (
        <div
          key={i}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            padding: compact ? "7px 0" : "9px 0",
            borderBottom:
              i < items.length - 1 ? `1px solid ${T.teal50}` : "none",
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              background: bg,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Icon size={13} color={color} strokeWidth={2} />
          </div>
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontSize: compact ? 12 : 13,
                color: T.head,
                fontWeight: 500,
                lineHeight: 1.4,
              }}
            >
              {item.text}
            </div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>
              {item.time}
            </div>
          </div>
        </div>
      );
    })}
  </div>
);

// ─── DEPT TABLE ───────────────────────────────────────────────────────────────
export const DeptTable: React.FC<{
  depts: { name: string; count: number }[];
}> = ({ depts }) => {
  const max = Math.max(...depts.map((d) => d.count), 1);
  return (
    <div>
      {depts.map((d, i) => (
        <div
          key={d.name}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "8px 0",
            borderBottom:
              i < depts.length - 1 ? `1px solid ${T.teal50}` : "none",
          }}
        >
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: SEMI_COLORS[i % SEMI_COLORS.length],
              flexShrink: 0,
            }}
          />
          <span
            style={{
              flex: 1,
              fontSize: 12,
              color: T.head,
              fontWeight: 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {d.name}
          </span>
          <div
            style={{
              width: 80,
              height: 4,
              background: T.teal100,
              borderRadius: 2,
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: `${(d.count / max) * 100}%`,
                height: "100%",
                background: SEMI_COLORS[i % SEMI_COLORS.length],
                borderRadius: 2,
                transition: "width .6s",
              }}
            />
          </div>
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: SEMI_COLORS[i % SEMI_COLORS.length],
              width: 26,
              textAlign: "right",
              flexShrink: 0,
            }}
          >
            {d.count}
          </span>
        </div>
      ))}
    </div>
  );
};

// ─── FINANCE SUMMARY ──────────────────────────────────────────────────────────
export const FinanceSummary: React.FC<{
  revenue: number;
  revenueLabel: string;
  primaryCount: number;
  primaryLabel: string;
}> = ({ revenue, revenueLabel, primaryCount, primaryLabel }) => {
  const collected = Math.round(revenue * 0.78);
  const pending = Math.round(revenue * 0.15);
  const overdue = Math.round(revenue * 0.07);
  const pct = Math.round((collected / revenue) * 100);

  const rows = [
    {
      label: "Collected",
      val: `${collected}K`,
      color: T.teal600,
      bg: T.teal100,
    },
    { label: "Pending", val: `${pending}K`, color: T.navy600, bg: T.teal50 },
    { label: "Overdue", val: `${overdue}K`, color: T.amber, bg: T.amberBg },
  ];

  return (
    <div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 800,
          color: T.teal600,
          letterSpacing: "-0.5px",
        }}
      >
        {revenue}K{" "}
        <span style={{ fontSize: 13, fontWeight: 500, color: T.muted }}>
          PKR
        </span>
      </div>
      <div style={{ fontSize: 12, color: T.muted, marginBottom: 14 }}>
        {primaryCount.toLocaleString()} {primaryLabel} · {revenueLabel}
      </div>
      <div
        style={{
          height: 8,
          display: "flex",
          borderRadius: 4,
          overflow: "hidden",
          gap: 2,
          marginBottom: 16,
        }}
      >
        <div style={{ flex: collected, background: T.teal600 }} />
        <div style={{ flex: pending, background: T.navy600 }} />
        <div style={{ flex: overdue, background: T.amber }} />
      </div>
      {rows.map((row) => (
        <div
          key={row.label}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "7px 0",
            borderBottom: `1px solid ${T.teal50}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: row.color,
              }}
            />
            <span style={{ fontSize: 13, color: T.body }}>{row.label}</span>
          </div>
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: row.color,
              background: row.bg,
              padding: "2px 10px",
              borderRadius: 20,
            }}
          >
            {row.val} PKR
          </span>
        </div>
      ))}
      <div style={{ marginTop: 10, fontSize: 12, color: T.muted }}>
        Collection rate: <strong style={{ color: T.teal600 }}>{pct}%</strong>
      </div>
    </div>
  );
};

// ─── STATUS BADGE ─────────────────────────────────────────────────────────────
// Shared status pill for any entity with an approval workflow (overtime, leave,
// and any future module using the same Pending/Approved/Rejected lifecycle).
// Single source of truth for status colors/labels — do not reimplement locally.
export type ApprovalStatus = "Pending" | "Approved" | "Rejected" | string;

const STATUS_CFG: Record<
  "Pending" | "Approved" | "Rejected",
  { color: string; bg: string; border: string }
> = {
  Pending: { color: "#c2410c", bg: "#fff7ed", border: "#fed7aa" },
  Approved: { color: "#15803d", bg: "#f0fdf4", border: "#bbf7d0" },
  Rejected: { color: "#dc2626", bg: "#fff1f2", border: "#fecaca" },
};

const DEFAULT_STATUS_CFG = { color: T.muted, bg: T.slate100, border: T.border };

export const StatusBadge: React.FC<{ status: ApprovalStatus }> = ({
  status,
}) => {
  const cfg =
    STATUS_CFG[status as "Pending" | "Approved" | "Rejected"] ??
    DEFAULT_STATUS_CFG;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: 11,
        fontWeight: 800,
        color: cfg.color,
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
        padding: "3px 10px",
        borderRadius: 20,
        whiteSpace: "nowrap",
      }}
    >
      {status}
    </span>
  );
};
