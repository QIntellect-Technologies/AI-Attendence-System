/**
 * StatCard.tsx
 * Reusable top KPI card.
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
}

const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  sub,
  icon: Icon,
  iconBg = T.teal100,
  iconColor = T.teal600,
}) => {
  return (
    <div
      style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: 16,
        padding: "20px 22px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        boxShadow: "0 1px 3px rgba(15,45,74,0.06)",
      }}
    >
      <div>
        <p
          style={{
            fontSize: 12,
            color: T.muted,
            marginBottom: 6,
            fontWeight: 500,
            fontFamily: "'DM Sans', sans-serif",
          }}
        >
          {title}
        </p>

        <p
          style={{
            fontSize: 28,
            fontWeight: 700,
            color: T.head,
            lineHeight: 1,
            letterSpacing: "-0.5px",
            fontFamily: "'DM Sans', sans-serif",
          }}
        >
          {value}
        </p>

        {sub && (
          <p
            style={{
              fontSize: 11,
              color: T.success,
              marginTop: 6,
              fontWeight: 500,
              fontFamily: "'DM Sans', sans-serif",
            }}
          >
            {sub}
          </p>
        )}
      </div>

      <div
        style={{
          width: 50,
          height: 50,
          borderRadius: "50%",
          background: iconBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Icon size={22} color={iconColor} />
      </div>
    </div>
  );
};

export default React.memo(StatCard);
