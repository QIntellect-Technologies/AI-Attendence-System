/**
 * src/app/support-dashboard/modules/organizations/components/TimezoneSelect.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Stateless IANA timezone selector, following the same pattern as
 * BusinessTemplateSelect: no fetching, no internal state, parent-controlled.
 */

import React, { useMemo } from "react";

type TimezoneSelectProps = {
  value: string;
  onChange: (timezone: string) => void;
  disabled?: boolean;
  label?: string;
};

const FALLBACK_TIMEZONES = [
  "UTC",
  "Asia/Karachi",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Europe/London",
  "America/New_York",
] as const;

function listIanaTimezones(): string[] {
  // Intl.supportedValuesOf is supported in all evergreen browsers this
  // dashboard targets (Chrome/Edge 99+, Safari 16.4+, Firefox 111+).
  // Falling back to a short static list keeps older engines from crashing,
  // at the cost of a smaller selection.
  if (typeof Intl !== "undefined" && typeof Intl.supportedValuesOf === "function") {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return [...FALLBACK_TIMEZONES];
    }
  }
  return [...FALLBACK_TIMEZONES];
}

export default function TimezoneSelect({
  value,
  onChange,
  disabled = false,
  label = "Timezone",
}: TimezoneSelectProps) {
  const timezones = useMemo(() => listIanaTimezones(), []);

  return (
    <label style={{ display: "block" }}>
      <span
        style={{
          display: "block",
          marginBottom: 6,
          fontSize: 10,
          fontWeight: 900,
          color: "#334155",
          textTransform: "uppercase",
          letterSpacing: "0.07em",
        }}
      >
        {label}
      </span>
      <select
        value={value || "UTC"}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        style={{
          width: "100%",
          boxSizing: "border-box",
          border: "1px solid #e2e8f0",
          borderRadius: 10,
          padding: "10px 12px",
          fontSize: 12,
          color: "#334155",
          outline: "none",
          fontFamily: "inherit",
          background: disabled ? "#f1f5f9" : "#ffffff",
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        {timezones.map((tz) => (
          <option key={tz} value={tz}>
            {tz}
          </option>
        ))}
      </select>
    </label>
  );
}