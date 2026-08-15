/**
 * src/app/support-dashboard/modules/organizations/components/AttendanceScopeSelector.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Reusable controlled selector for Support-owned biometric attendance scope.
 *
 * Purpose:
 * - Create Organization modal: choose who biometric attendance is enabled for.
 * - Org Detail template editor: change the same setting later.
 *
 * Rules:
 * - No API calls here.
 * - No hardcoded business template logic here.
 * - Parent passes the enabled people types from backend template data.
 * - Backend remains the source of truth after save.
 */

import React, { useMemo } from "react";
import type { PeopleType } from "../../../packages/shared-types/src/organization";

type AttendanceScopeSelectorProps = {
  availablePeopleTypes: PeopleType[];
  value: PeopleType[];
  onChange: (next: PeopleType[]) => void;
  labels?: Record<string, string>;
  disabled?: boolean;
  required?: boolean;
};

type ScopeOption = {
  key: string;
  label: string;
  description: string;
  value: PeopleType[];
};

const COLORS = {
  teal600: "#0d9488",
  teal700: "#0f766e",
  teal50: "#f0fdfa",
  border: "#e2e8f0",
  white: "#ffffff",
  textBody: "#334155",
  textMuted: "#64748b",
  textLight: "#94a3b8",
} as const;

const DEFAULT_LABELS: Record<string, string> = {
  student: "Students",
  staff: "Staff",
  worker: "Workers",
  employee: "Employees",
  volunteer: "Volunteers",
  member: "Members",
  patient: "Patients",
};

function titleCase(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizePeopleTypes(values: unknown[]): PeopleType[] {
  const seen = new Set<string>();
  const output: PeopleType[] = [];

  for (const value of values) {
    const key = String(value ?? "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(key as PeopleType);
  }

  return output;
}

function displayLabel(labels: Record<string, string> | undefined, peopleType: PeopleType): string {
  const key = String(peopleType || "").trim().toLowerCase();
  return labels?.[key] || DEFAULT_LABELS[key] || titleCase(key);
}

function sameScope(a: PeopleType[], b: PeopleType[]): boolean {
  const left = normalizePeopleTypes(a).sort().join("|");
  const right = normalizePeopleTypes(b).sort().join("|");
  return left === right;
}

function buildScopeOptions(
  available: PeopleType[],
  labels?: Record<string, string>,
): ScopeOption[] {
  if (available.length === 0) return [];

  if (available.length === 1) {
    const only = available[0];
    return [
      {
        key: String(only),
        label: `${displayLabel(labels, only)} only`,
        description: `Biometric attendance will be enabled for ${displayLabel(labels, only)}.`,
        value: [only],
      },
    ];
  }

  const singleOptions: ScopeOption[] = available.map((peopleType) => ({
    key: String(peopleType),
    label: `${displayLabel(labels, peopleType)} only`,
    description: `Only ${displayLabel(labels, peopleType)} will use biometric attendance.`,
    value: [peopleType],
  }));

  return [
    ...singleOptions,
    {
      key: "all",
      label: available.map((peopleType) => displayLabel(labels, peopleType)).join(" + "),
      description: "Biometric attendance will be enabled for all selected template people types.",
      value: available,
    },
  ];
}

/**
 * This selector intentionally behaves like a radio group of valid scopes:
 * - Students only
 * - Staff only
 * - Students + Staff
 *
 * For other future templates it derives the same options from availablePeopleTypes.
 */
export default function AttendanceScopeSelector({
  availablePeopleTypes,
  value,
  onChange,
  labels,
  disabled = false,
  required = true,
}: AttendanceScopeSelectorProps) {
  const available = useMemo(
    () => normalizePeopleTypes(availablePeopleTypes),
    [availablePeopleTypes],
  );

  const selected = useMemo(
    () => normalizePeopleTypes(value).filter((peopleType) => available.includes(peopleType)),
    [available, value],
  );

  const options = useMemo(
    () => buildScopeOptions(available, labels),
    [available, labels],
  );

  if (!available.length) {
    return (
      <div style={{ color: COLORS.textLight, fontSize: 12, fontWeight: 700 }}>
        No people types are available for this template.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div
        role="radiogroup"
        aria-required={required}
        aria-label="Attendance enabled for"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(155px, 1fr))",
          gap: 8,
        }}
      >
        {options.map((option) => {
          const active = sameScope(selected, option.value);

          return (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => {
                if (!disabled) onChange(option.value);
              }}
              style={{
                minHeight: 62,
                borderRadius: 12,
                border: `1px solid ${active ? COLORS.teal600 : COLORS.border}`,
                background: active ? COLORS.teal50 : COLORS.white,
                color: active ? COLORS.teal700 : COLORS.textBody,
                padding: "10px 12px",
                textAlign: "left",
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled ? 0.65 : 1,
                display: "grid",
                gap: 4,
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 900 }}>
                {active ? "✓ " : ""}
                {option.label}
              </span>
              <span style={{ fontSize: 10, color: COLORS.textMuted, lineHeight: 1.35 }}>
                {option.description}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ fontSize: 10, color: COLORS.textLight, fontWeight: 700, lineHeight: 1.45 }}>
        This is controlled by QIntellect Support. The Client Dashboard cannot change this commercial attendance scope.
      </div>
    </div>
  );
}
