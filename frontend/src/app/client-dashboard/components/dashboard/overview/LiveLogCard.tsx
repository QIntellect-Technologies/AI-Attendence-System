/**
 * LiveLogCard.tsx
 */

import React from "react";
import { Clock } from "lucide-react";
import DashboardCard from "./DashboardCard";
import { T } from "../../ui/theme";
import type { DashboardLiveLogItem } from "../../../hooks/useDashboardOverviewData";

interface LiveLogCardProps {
  items: DashboardLiveLogItem[];
  showBranchName?: boolean;
  height?: number | string;
  listHeight?: number | string;
  action?: React.ReactNode;
}

function statusColor(status: string) {
  if (status === "Present") return T.teal600;
  if (status === "Late") return T.amber;
  return "#E11D48";
}

const LiveLogCard: React.FC<LiveLogCardProps> = ({
  items,
  showBranchName = true,
  height = "100%",
  listHeight = "100%",
  action,
}) => {
  return (
    <DashboardCard title="Live Log" height={height} action={action}>
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
            const metaParts = [
              item.status,
              showBranchName ? item.branchName : null,
              item.department,
            ].filter(Boolean);

            return (
              <div
                key={`${item.id}-${index}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "8px 0",
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
                      width: 30,
                      height: 30,
                      borderRadius: "50%",
                      background: T.teal600,
                      color: "#fff",
                      fontWeight: 700,
                      fontSize: 12,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                      fontFamily: "'DM Sans', sans-serif",
                    }}
                  >
                    {item.name.charAt(0).toUpperCase()}
                  </div>

                  <div style={{ minWidth: 0 }}>
                    <p
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: T.head,
                        fontFamily: "'DM Sans', sans-serif",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {item.name}
                    </p>

                    <p
                      style={{
                        fontSize: 10,
                        color: statusColor(item.status),
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

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    color: T.muted,
                    fontSize: 11,
                    flexShrink: 0,
                    fontFamily: "'DM Sans', sans-serif",
                  }}
                >
                  <Clock size={11} />
                  <span>{item.time}</span>
                </div>
              </div>
            );
          })
        ) : (
          <p
            style={{
              fontSize: 12,
              color: T.muted,
              textAlign: "center",
              padding: "20px 0",
              fontFamily: "'DM Sans', sans-serif",
            }}
          >
            No records yet today
          </p>
        )}
      </div>
    </DashboardCard>
  );
};

export default React.memo(LiveLogCard);
