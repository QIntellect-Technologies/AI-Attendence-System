/**
 * DashboardCard.tsx
 * Shared card wrapper for Branch Overview dashboard.
 */

import React from "react";
import { MoreHorizontal } from "lucide-react";
import { T } from "../../ui/theme";

interface DashboardCardProps {
  title?: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  height?: number | string;
  style?: React.CSSProperties;
  bodyStyle?: React.CSSProperties;
}

const DashboardCard: React.FC<DashboardCardProps> = ({
  title,
  subtitle,
  action,
  children,
  height,
  style,
  bodyStyle,
}) => {
  return (
    <div
      style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: 16,
        padding: 22,
        height,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        boxShadow: "0 1px 3px rgba(15,45,74,0.06)",
        ...style,
      }}
    >
      {title && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 16,
            flexShrink: 0,
          }}
        >
          <div>
            <h3
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: T.head,
                margin: 0,
                fontFamily: "'DM Sans', sans-serif",
              }}
            >
              {title}
            </h3>
            {subtitle && (
              <p
                style={{
                  fontSize: 11,
                  color: T.muted,
                  marginTop: 3,
                  fontFamily: "'DM Sans', sans-serif",
                }}
              >
                {subtitle}
              </p>
            )}
          </div>

          {action ?? (
            <button
              type="button"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 4,
                borderRadius: 8,
                lineHeight: 0,
              }}
            >
              <MoreHorizontal size={15} color={T.muted} />
            </button>
          )}
        </div>
      )}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          width: "100%",
          height: "100%",
          overflow: "hidden",
          ...bodyStyle,
        }}
      >
        {children}
      </div>
    </div>
  );
};

export default React.memo(DashboardCard);
