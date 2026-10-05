/**
 * ChartTooltip.tsx
 * Shared Recharts tooltip.
 */

import React from "react";
import { T } from "../../ui/theme";

const ChartTooltip: React.FC<any> = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;

  return (
    <div
      style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: 10,
        padding: "8px 12px",
        fontSize: 12,
        boxShadow: "0 4px 12px rgba(15,45,74,0.1)",
        fontFamily: "'DM Sans', sans-serif",
      }}
    >
      {label && (
        <p style={{ color: T.muted, marginBottom: 2, fontSize: 11 }}>{label}</p>
      )}

      {payload.map((item: any, index: number) => (
        <p
          key={`${item.name}-${index}`}
          style={{
            color: item.color,
            fontWeight: 600,
            fontSize: 12,
          }}
        >
          {item.name}: {item.value}
          {String(item.name).toLowerCase().includes("rate") ? "%" : ""}
        </p>
      ))}
    </div>
  );
};

export default React.memo(ChartTooltip);
