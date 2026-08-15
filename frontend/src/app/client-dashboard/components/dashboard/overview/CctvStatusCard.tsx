/**
 * CctvStatusCard.tsx
 */

import React from "react";
import { ShieldAlert } from "lucide-react";
import DashboardCard from "./DashboardCard";
import { T } from "../../ui/theme";
import type { CctvDevice } from "../../../hooks/useDashboardOverviewData";

interface CctvStatusCardProps {
  items: CctvDevice[];
  height?: number | string;
  listHeight?: number | string;
  showBranchName?: boolean;
  action?: React.ReactNode;
  /**
   * Dashboard pages pass this as true so the entire CCTV widget disappears when
   * no real cameras are configured for the current scope.
   */
  hideWhenEmpty?: boolean;
}

function getStatusStyle(status: CctvDevice["status"]) {
  if (status === "Normal") {
    return {
      dot: "#22C55E",
      bg: "#F0FDF4",
      text: "#16A34A",
    };
  }

  if (status === "Alert") {
    return {
      dot: "#EF4444",
      bg: "#FFF1F2",
      text: "#E11D48",
    };
  }

  return {
    dot: "#94A3B8",
    bg: "#F8FAFC",
    text: "#64748B",
  };
}

const CctvStatusCard: React.FC<CctvStatusCardProps> = ({
  items,
  height = 350,
  listHeight = 260,
  showBranchName = true,
  action,
  hideWhenEmpty = false,
}) => {
  if (hideWhenEmpty && items.length === 0) {
    return null;
  }

  return (
    <DashboardCard
      title="CCTV Status"
      height={height}
      action={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {action}
          <ShieldAlert size={16} color={T.teal600} />
        </div>
      }
      bodyStyle={{
        minHeight: 0,
      }}
    >
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
            const cfg = getStatusStyle(item.status);

            const metaParts = [
              showBranchName ? item.branchName : null,
              item.lastSeen,
            ].filter(Boolean);

            return (
              <div
                key={item.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  paddingTop: 10,
                  paddingBottom: 10,
                  borderBottom:
                    index < items.length - 1 ? `1px solid ${T.border}` : "none",
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
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: cfg.dot,
                      flexShrink: 0,
                    }}
                  />

                  <div style={{ minWidth: 0 }}>
                    <p
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        color: T.head,
                        fontFamily: "'DM Sans', sans-serif",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                      title={item.location}
                    >
                      {item.location}
                    </p>

                    <p
                      style={{
                        fontSize: 11,
                        color: T.muted,
                        fontFamily: "'DM Sans', sans-serif",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                      title={metaParts.join(" · ")}
                    >
                      {metaParts.join(" · ")}
                    </p>
                  </div>
                </div>

                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    background: cfg.bg,
                    color: cfg.text,
                    padding: "3px 12px",
                    borderRadius: 20,
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                    fontFamily: "'DM Sans', sans-serif",
                  }}
                >
                  {item.status}
                </span>
              </div>
            );
          })
        ) : (
          <div
            style={{
              height: "100%",
              minHeight: listHeight,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
            }}
          >
            <p
              style={{
                fontSize: 12,
                color: T.muted,
                fontFamily: "'DM Sans', sans-serif",
              }}
            >
              No CCTV devices configured
            </p>
          </div>
        )}
      </div>
    </DashboardCard>
  );
};

export default React.memo(CctvStatusCard);
