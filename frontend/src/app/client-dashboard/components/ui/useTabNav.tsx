/**
 * useTabNav.tsx
 * Standalone tab navigation hook + TabBar component.
 * active is typed as `string` so comparisons active === "overview" never
 * trigger ts(2367) regardless of the tab id union type.
 */

import React, { useState, useCallback } from "react";
import { T } from "./theme";
import type { LucideIcon } from "lucide-react";

export interface TabDef {
  id: string;
  label: string;
  Icon: LucideIcon;
}

export function useTabNav(tabs: TabDef[], initial: string) {
  const [active, setActive] = useState<string>(initial);

  // Re-validate if tabs list changes (e.g. module tabs loaded async)
  // and active is no longer in the list — fall back to initial.
  const ids = tabs.map((t) => t.id);
  const safeActive = ids.includes(active) ? active : initial;

  const TabBar = useCallback(
    () => (
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 2,
          background: T.slate50,
          border: `1px solid ${T.border}`,
          borderRadius: 10,
          padding: 3,
          width: "fit-content",
          marginBottom: 22,
        }}
      >
        {tabs.map((t) => {
          const isA = safeActive === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "7px 14px",
                borderRadius: 7,
                border: "none",
                background: isA ? T.card : "transparent",
                color: isA ? T.teal600 : T.muted,
                fontWeight: isA ? 700 : 500,
                fontSize: 12,
                cursor: "pointer",
                fontFamily: "inherit",
                boxShadow: isA ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
                transition: "all .15s",
                whiteSpace: "nowrap",
              }}
            >
              <t.Icon size={13} strokeWidth={isA ? 2.2 : 1.8} />
              {t.label}
            </button>
          );
        })}
      </div>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [safeActive, tabs],
  );

  return { active: safeActive, setActive, TabBar };
}