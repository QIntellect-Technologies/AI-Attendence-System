/**
 * LiveLogCard.tsx
 */

import React from "react";
import { Clock, Activity, ArrowRight } from "lucide-react";
import DashboardCard from "./DashboardCard";
import { T } from "../../ui/theme";
import type { DashboardLiveLogItem } from "../../../hooks/useDashboardOverviewData";

interface LiveLogCardProps {
  items: DashboardLiveLogItem[];
  showBranchName?: boolean;
  height?: number | string;
  listHeight?: number | string;
  action?: React.ReactNode;
  onViewAll?: () => void;
}

function getStatusBadgeStyle(status: string) {
  const lower = (status || "").toLowerCase();
  if (lower === "present" || lower === "checked_in") {
    return {
      bg: "#ECFDF5",
      color: "#047857",
      border: "#A7F3D0",
      dot: "#10B981",
    };
  }
  if (lower === "late" || lower === "half_day") {
    return {
      bg: "#FFFBEB",
      color: "#B45309",
      border: "#FDE68A",
      dot: "#F59E0B",
    };
  }
  return {
    bg: "#FEF2F2",
    color: "#B91C1C",
    border: "#FECACA",
    dot: "#EF4444",
  };
}

const LiveLogCard: React.FC<LiveLogCardProps> = ({
  items,
  showBranchName = true,
  height = "100%",
  listHeight = "100%",
  action,
  onViewAll,
}) => {
  const effectiveAction = action || (onViewAll ? (
    <button
      onClick={onViewAll}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "5px 12px",
        borderRadius: 8,
        background: "#ECFDF5",
        border: "1px solid #A7F3D0",
        color: "#047857",
        fontSize: 12,
        fontWeight: 700,
        cursor: "pointer",
        transition: "all 0.15s ease",
      }}
    >
      <span>View All</span>
      <ArrowRight size={13} />
    </button>
  ) : undefined);
  const titleNode = (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span>Live Log</span>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "2px 8px",
          borderRadius: 12,
          background: "#ECFDF5",
          border: "1px solid #A7F3D0",
          fontSize: 10,
          fontWeight: 700,
          color: "#047857",
          textTransform: "uppercase",
          letterSpacing: "0.5px",
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "#10B981",
            boxShadow: "0 0 0 2px rgba(16, 185, 129, 0.2)",
            animation: "pulseDot 1.5s infinite",
          }}
        />
        Live
      </span>
      <style>{`
        @keyframes pulseDot {
          0% { transform: scale(0.95); boxShadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
          70% { transform: scale(1); boxShadow: 0 0 0 6px rgba(16, 185, 129, 0); }
          100% { transform: scale(0.95); boxShadow: 0 0 0 0 rgba(16, 185, 129, 0); }
        }
      `}</style>
    </div>
  );

  return (
    <DashboardCard title={titleNode} height={height} action={effectiveAction}>
      <div
        className="hide-scrollbar"
        style={{
          height: listHeight,
          maxHeight: listHeight,
          overflowY: "auto",
          paddingRight: 4,
        }}
      >
        {items.length > 0 ? (
          items.map((item, index) => {
            const badge = getStatusBadgeStyle(item.status);
            const deptText = item.department || "General";
            const branchText = showBranchName && item.branchName ? item.branchName : null;

            return (
              <div
                key={`${item.id}-${index}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "10px 8px",
                  borderRadius: 10,
                  marginBottom: 4,
                  background: index % 2 === 0 ? "#F8FAFC" : "#FFFFFF",
                  border: "1px solid #F1F5F9",
                  transition: "background-color 0.15s ease",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    minWidth: 0,
                  }}
                >
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: "50%",
                      background: "linear-gradient(135deg, #0F766E, #0D9488)",
                      color: "#ffffff",
                      fontWeight: 800,
                      fontSize: 13,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                      boxShadow: "0 2px 4px rgba(15, 118, 110, 0.15)",
                    }}
                  >
                    {item.name.charAt(0).toUpperCase()}
                  </div>

                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <p
                        style={{
                          margin: 0,
                          fontSize: 13,
                          fontWeight: 700,
                          color: T.head,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {item.name}
                      </p>
                    </div>

                    <p
                      style={{
                        margin: "2px 0 0 0",
                        fontSize: 11,
                        color: T.muted,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {[deptText, branchText].filter(Boolean).join(" • ")}
                    </p>
                  </div>
                </div>

                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-end",
                    gap: 4,
                    flexShrink: 0,
                  }}
                >
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 8px",
                      borderRadius: 12,
                      background: badge.bg,
                      border: `1px solid ${badge.border}`,
                      color: badge.color,
                      fontSize: 10,
                      fontWeight: 700,
                    }}
                  >
                    <span
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: "50%",
                        background: badge.dot,
                      }}
                    />
                    {item.status}
                  </span>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 3,
                      color: T.muted,
                      fontSize: 10,
                      fontWeight: 500,
                    }}
                  >
                    <Clock size={10} />
                    <span>{item.time}</span>
                  </div>
                </div>
              </div>
            );
          })
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: "40px 16px",
              color: T.muted,
            }}
          >
            <Activity size={24} style={{ marginBottom: 8, opacity: 0.4 }} />
            <p style={{ margin: 0, fontSize: 13, fontWeight: 500 }}>
              No punch activity recorded today yet
            </p>
          </div>
        )}
      </div>
    </DashboardCard>
  );
};

export default React.memo(LiveLogCard);
