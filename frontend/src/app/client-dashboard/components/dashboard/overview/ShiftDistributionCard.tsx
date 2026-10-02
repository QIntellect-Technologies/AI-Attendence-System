import React, { useState } from "react";
import { createPortal } from "react-dom";
import { Sun, Sunset, Moon, Settings2, X } from "lucide-react";
import DashboardCard from "./DashboardCard";
import { T } from "../../ui/theme";
import type { ShiftDistributionItem } from "../../../hooks/useDashboardOverviewData";

interface ShiftDistributionCardProps {
  shifts: ShiftDistributionItem[];
  /** Called when user clicks "View all members" inside the popup. */
  onViewMore?: (shiftKey: string) => void;
}

// ─── Shift visual map ────────────────────────────────────────────────────────

function visualForShift(shift: ShiftDistributionItem) {
  const startHour = parseInt(shift.time.match(/^(\d{1,2}):/)?.[1] ?? "", 10);
  if (Number.isNaN(startHour)) return SHIFT_VISUALS.Custom;
  if (startHour >= 6 && startHour < 14) return SHIFT_VISUALS.Morning;
  if (startHour >= 14 && startHour < 22) return SHIFT_VISUALS.Evening;
  if (startHour >= 22 || startHour < 6) return SHIFT_VISUALS.Night;
  return SHIFT_VISUALS.Custom;
}

const SHIFT_VISUALS: Record<string, { icon: React.ElementType; iconBg: string; iconColor: string }> = {
  Morning: { icon: Sun, iconBg: "#FEF3C7", iconColor: T.amber },
  Evening: { icon: Sunset, iconBg: "#EDE9FE", iconColor: "#7C3AED" },
  Night: { icon: Moon, iconBg: T.teal100, iconColor: T.teal600 },
  Custom: { icon: Settings2, iconBg: "#DBEAFE", iconColor: "#1D4ED8" },
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
  return name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

// ─── Popup modal ─────────────────────────────────────────────────────────────

interface ShiftModalProps {
  shift: ShiftDistributionItem;
  onClose: () => void;
  onViewMore?: (shiftKey: string) => void;
}

const ShiftModal: React.FC<ShiftModalProps> = ({ shift, onClose, onViewMore }) => {
  const visual = visualForShift(shift);
  const Icon = visual.icon;
  const members = shift.members ?? [];
  const preview = members.slice(0, 5);
  const hasMore = shift.staffCount > 5;

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(10,30,50,0.40)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1200,
        backdropFilter: "blur(2px)",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: 20,
          width: 440,
          maxWidth: "92vw",
          maxHeight: "82vh",
          fontFamily: "'DM Sans', sans-serif",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 24px 64px rgba(10,30,60,0.22)",
          overflow: "hidden",
        }}
      >
        {/* ── Header ── */}
        <div
          style={{
            padding: "18px 20px 14px",
            borderBottom: `1px solid ${T.border}`,
            display: "flex",
            alignItems: "center",
            gap: 14,
          }}
        >
          <div
            style={{
              width: 42,
              height: 42,
              borderRadius: 12,
              background: visual.iconBg,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Icon size={20} color={visual.iconColor} />
          </div>

          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 15, fontWeight: 700, color: T.head }}>
              {shift.label}
            </p>
            <p style={{ fontSize: 12, color: T.muted }}>{shift.time}</p>
          </div>

          <div style={{ textAlign: "right", marginRight: 6 }}>
            <p style={{ fontSize: 24, fontWeight: 800, color: T.head, lineHeight: 1 }}>
              {shift.staffCount}
            </p>
            <p style={{ fontSize: 10, color: T.muted, marginTop: 1 }}>staff</p>
          </div>

          <button
            type="button"
            onClick={onClose}
            style={{
              width: 30, height: 30, borderRadius: 8,
              border: `1px solid ${T.border}`, background: "none",
              cursor: "pointer", color: T.muted,
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <X size={15} />
          </button>
        </div>

        {/* ── Dept summary pills ── */}
        {shift.departments.length > 0 && (
          <div
            style={{
              padding: "10px 20px",
              borderBottom: `1px solid ${T.border}`,
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
            }}
          >
            {shift.departments.map(dept => {
              const [bg, color] = DEPT_COLORS[dept.name] ?? [T.slate100, T.body];
              return (
                <span
                  key={dept.name}
                  style={{
                    fontSize: 11, fontWeight: 600,
                    padding: "3px 9px", borderRadius: 20,
                    background: bg, color,
                  }}
                >
                  {dept.count} {dept.name}
                </span>
              );
            })}
          </div>
        )}

        {/* ── Member list ── */}
        <div
          className="hide-scrollbar"
          style={{ overflowY: "auto", flex: 1, padding: "8px 12px" }}
        >
          {preview.length === 0 ? (
            <p style={{ fontSize: 13, color: T.muted, textAlign: "center", padding: "28px 0" }}>
              No staff assigned to this shift
            </p>
          ) : (
            preview.map(member => (
              <div
                key={member.id}
                style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "9px 8px", borderRadius: 10,
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = T.slate50; }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
              >
                {/* Avatar */}
                <div
                  style={{
                    width: 36, height: 36, borderRadius: "50%",
                    background: T.teal100, color: T.teal600,
                    fontSize: 12, fontWeight: 700,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {initials(member.name)}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{
                    fontSize: 13, fontWeight: 600, color: T.head,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {member.name}
                  </p>
                  <p style={{ fontSize: 11, color: T.muted }}>
                    {member.position || member.department}
                  </p>
                </div>

                {/* Dept badge */}
                {(() => {
                  const [bg, color] = DEPT_COLORS[member.department] ?? [T.slate100, T.muted];
                  return (
                    <span style={{
                      fontSize: 10, fontWeight: 600,
                      padding: "3px 9px", borderRadius: 20,
                      background: bg, color, whiteSpace: "nowrap", flexShrink: 0,
                    }}>
                      {member.department}
                    </span>
                  );
                })()}
              </div>
            ))
          )}
        </div>

        {/* ── View More footer ── */}
        {(hasMore || onViewMore) && preview.length > 0 && (
          <div
            onClick={() => { onClose(); onViewMore?.(shift.key); }}
            style={{
              borderTop: `1px solid ${T.border}`,
              padding: "12px 20px",
              fontSize: 12, fontWeight: 700,
              color: T.teal600, textAlign: "center",
              cursor: "pointer",
              background: T.teal50,
              transition: "background .15s",
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = T.teal100; }}
            onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = T.teal50; }}
          >
            View all {shift.staffCount} members →
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

// ─── Card ─────────────────────────────────────────────────────────────────────

const ShiftDistributionCard: React.FC<ShiftDistributionCardProps> = ({ shifts, onViewMore }) => {
  const [activeShift, setActiveShift] = useState<ShiftDistributionItem | null>(null);

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
          {shifts.map(shift => {
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
                onMouseEnter={e => { e.currentTarget.style.background = T.slate50; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
              >
                {/* Icon */}
                <div
                  style={{
                    width: 38, height: 38, borderRadius: 10,
                    background: visual.iconBg,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <Icon size={18} color={visual.iconColor} />
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{
                    fontSize: 13, fontWeight: 700, color: T.head,
                    marginBottom: 2,
                  }}>
                    {shift.label}
                  </p>
                  <p style={{ fontSize: 11, color: T.muted }}>{shift.time}</p>

                  {/* Dept pills */}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                    {shift.departments.length === 0 && (
                      <span style={{ fontSize: 10, color: T.muted }}>No staff</span>
                    )}
                    {shift.departments.slice(0, 2).map(dept => {
                      const [bg, color] = DEPT_COLORS[dept.name] ?? [T.slate100, T.body];
                      return (
                        <span key={dept.name} style={{
                          fontSize: 10, padding: "2px 7px", borderRadius: 20,
                          background: bg, color, whiteSpace: "nowrap",
                        }}>
                          {dept.count} {dept.name}
                        </span>
                      );
                    })}
                    {shift.departments.length > 2 && (
                      <span style={{
                        fontSize: 10, padding: "2px 7px", borderRadius: 20,
                        background: T.slate100, color: T.muted,
                      }}>
                        +{shift.departments.length - 2} more
                      </span>
                    )}
                  </div>
                </div>

                {/* Staff count */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                  <p style={{
                    fontSize: 22, fontWeight: 700, color: T.head,
                    lineHeight: 1,
                  }}>
                    {shift.staffCount}
                  </p>
                  <p style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>staff</p>
                </div>
              </div>
            );
          })}
        </div>
      </DashboardCard>

      {/* ── Popup modal ── */}
      {activeShift && (
        <ShiftModal
          shift={activeShift}
          onClose={() => setActiveShift(null)}
          onViewMore={onViewMore}
        />
      )}
    </>
  );
};

export default React.memo(ShiftDistributionCard);