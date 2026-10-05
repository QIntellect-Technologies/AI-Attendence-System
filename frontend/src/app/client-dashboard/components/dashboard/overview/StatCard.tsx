/**
 * StatCard.tsx
 * Reusable top KPI card with rich modern styling and smooth hover interactions.
 */

import React from "react";
import type { LucideIcon } from "lucide-react";
import { T } from "../../ui/theme";

interface StatCardProps {
  title: string;
  value: string | number;
  sub?: string;
  icon: LucideIcon;
  iconBg?: string;
  iconColor?: string;
  onClick?: () => void;
}

const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  sub,
  icon: Icon,
  iconBg = T.teal100,
  iconColor = T.teal600,
  onClick,
}) => {
  return (
    <div
      style={{
        background: "linear-gradient(135deg, #FFFFFF 0%, #F8FAFC 100%)",
        border: `1px solid ${T.border}`,
        borderRadius: 16,
        padding: "20px 22px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        boxShadow: "0 2px 6px rgba(15, 23, 42, 0.04), 0 1px 2px rgba(15, 23, 42, 0.02)",
        cursor: onClick ? "pointer" : "default",
        transition: "all 0.25s cubic-bezier(0.4, 0, 0.2, 1)",
        position: "relative",
        overflow: "hidden",
      }}
      onClick={onClick}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-3px)";
        e.currentTarget.style.boxShadow =
          "0 12px 24px -6px rgba(15, 23, 42, 0.08), 0 4px 8px -2px rgba(15, 23, 42, 0.04)";
        e.currentTarget.style.borderColor = "#CBD5E1";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "none";
        e.currentTarget.style.boxShadow =
          "0 2px 6px rgba(15, 23, 42, 0.04), 0 1px 2px rgba(15, 23, 42, 0.02)";
        e.currentTarget.style.borderColor = T.border;
      }}
    >
      {/* Top subtle accent bar */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          background: `linear-gradient(90deg, ${iconColor}40, ${iconColor})`,
        }}
      />

      <div style={{ minWidth: 0, zIndex: 1 }}>
        <p
          style={{
            fontSize: 12,
            color: T.muted,
            marginBottom: 6,
            fontWeight: 600,
            letterSpacing: "0.2px",
            textTransform: "uppercase",
            fontFamily: "'DM Sans', sans-serif",
          }}
        >
          {title}
        </p>

        <p
          style={{
            fontSize: 28,
            fontWeight: 800,
            color: T.head,
            lineHeight: 1.1,
            letterSpacing: "-0.7px",
            fontFamily: "'DM Sans', sans-serif",
            margin: 0,
          }}
        >
          {value}
        </p>

        {sub && (
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              marginTop: 8,
              padding: "2px 8px",
              borderRadius: 12,
              background: "#F1F5F9",
              fontSize: 11,
              fontWeight: 600,
              color: T.head,
              fontFamily: "'DM Sans', sans-serif",
            }}
          >
            {sub}
          </div>
        )}
      </div>

      <div
        style={{
          width: 52,
          height: 52,
          borderRadius: 14,
          background: iconBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          boxShadow: `0 4px 12px ${iconColor}25`,
          zIndex: 1,
          transition: "transform 0.25s ease",
        }}
      >
        <Icon size={24} color={iconColor} />
      </div>
    </div>
  );
};

export default React.memo(StatCard);
