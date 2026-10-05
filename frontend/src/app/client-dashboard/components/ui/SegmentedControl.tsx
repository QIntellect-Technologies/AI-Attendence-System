/**
 * components/ui/SegmentedControl.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Generic, reusable segmented control. Local, controlled state only — the
 * parent owns the selected value, this component just renders the buttons.
 *
 * Used by both the dashboard People Type selector (multi-people-type orgs)
 * and the manager portal My Team / Whole Branch toggle, so the same
 * interaction pattern and styling only has to be built/maintained once.
 */

import React from "react";
import { T } from "./theme";

export interface SegmentedControlOption<TValue extends string = string> {
  value: TValue;
  label: string;
}

export interface SegmentedControlProps<TValue extends string = string> {
  options: SegmentedControlOption<TValue>[];
  value: TValue;
  onChange: (value: TValue) => void;
  ariaLabel: string;
  size?: "sm" | "md";
}

export function SegmentedControl<TValue extends string = string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = "md",
}: SegmentedControlProps<TValue>): React.ReactElement | null {
  if (options.length <= 1) return null;

  const padding = size === "sm" ? "6px 12px" : "8px 16px";
  const fontSize = size === "sm" ? 12 : 13;

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      style={{
        display: "inline-flex",
        background: T.muted ?? "#F1F5F9",
        borderRadius: 10,
        padding: 3,
        gap: 2,
        fontFamily: "'DM Sans', sans-serif",
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => {
              if (!selected) onChange(option.value);
            }}
            style={{
              border: "none",
              cursor: selected ? "default" : "pointer",
              borderRadius: 8,
              padding,
              fontSize,
              fontWeight: 600,
              fontFamily: "'DM Sans', sans-serif",
              color: selected ? (T.head ?? "#0F172A") : (T.muted ?? "#64748B"),
              background: selected ? "#FFFFFF" : "transparent",
              boxShadow: selected ? "0 1px 2px rgba(15, 23, 42, 0.08)" : "none",
              transition: "background 0.15s ease, color 0.15s ease",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedControl;
