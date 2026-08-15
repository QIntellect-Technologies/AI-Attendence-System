/**
 * src/app/support-dashboard/modules/organizations/components/BusinessTemplateSelect.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Reusable, stateless business-template selector.
 *
 * It does not fetch on its own. Parent passes cached templates from
 * useVerticalTemplates(), preventing duplicate API calls across modal/detail UI.
 */

import React, { useMemo } from "react";
import type { SupportVerticalTemplateOption } from "../../../packages/shared-types/src/organization";

type BusinessTemplateSelectProps = {
  value: string;
  templates: SupportVerticalTemplateOption[];
  onChange: (businessType: string) => void;
  disabled?: boolean;
  label?: string;
  helper?: string;
  required?: boolean;
};

export default function BusinessTemplateSelect({
  value,
  templates,
  onChange,
  disabled = false,
  label = "Business Template",
  helper,
  required = false,
}: BusinessTemplateSelectProps) {
  const safeTemplates = templates.length
    ? templates
    : [
        { business_type: "company", label: "Company / Software House", primary_people_type: "staff" },
        { business_type: "school", label: "School / College", primary_people_type: "student" },
        { business_type: "factory", label: "Factory", primary_people_type: "worker" },
      ];

  const selectedTemplate = useMemo(
    () => safeTemplates.find((template) => template.business_type === value),
    [safeTemplates, value],
  );

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
        {label}{required ? " *" : ""}
      </span>

      <select
        value={value || "company"}
        disabled={disabled}
        required={required}
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
        {safeTemplates.map((template) => (
          <option key={template.business_type} value={template.business_type}>
            {template.label}
          </option>
        ))}
      </select>

      <span
        style={{
          display: "block",
          marginTop: 5,
          color: "#94a3b8",
          fontSize: 10,
          lineHeight: 1.4,
        }}
      >
        {helper ||
          (selectedTemplate
            ? `Primary people type: ${selectedTemplate.primary_people_type}`
            : "Support-owned template used by tenant rendering.")}
      </span>
    </label>
  );
}
