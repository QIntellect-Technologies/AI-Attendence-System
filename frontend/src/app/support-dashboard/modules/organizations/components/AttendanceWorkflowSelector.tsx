/**
 * src/app/support-dashboard/modules/organizations/components/AttendanceWorkflowSelector.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Reusable controlled selector for Support-owned local-node attendance
 * workflow — scenario-based (hold-for-review) vs simple (auto-confirm).
 * See local_node.attendance_marking_scenario / attendance_marking_simple.
 *
 * Rules (same as AttendanceScopeSelector):
 * - No API calls here.
 * - Parent fetches the current value and passes it down.
 * - Backend remains the source of truth after save.
 */

import React from "react";

type AttendanceWorkflow = "scenario_based" | "simple";

type AttendanceWorkflowSelectorProps = {
    value: AttendanceWorkflow;
    onChange: (next: AttendanceWorkflow) => void;
    disabled?: boolean;
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

const OPTIONS: Array<{
    key: AttendanceWorkflow;
    label: string;
    description: string;
}> = [
        {
            key: "scenario_based",
            label: "Scenario-based",
            description:
                "A late check-in or an early/late checkout holds locally for an operator to resolve on the node.",
        },
        {
            key: "simple",
            label: "Simple",
            description:
                "Every detection confirms immediately as on-time/late/early — nothing waits for an operator decision.",
        },
    ];

export default function AttendanceWorkflowSelector({
    value,
    onChange,
    disabled = false,
}: AttendanceWorkflowSelectorProps) {
    return (
        <div style={{ display: "grid", gap: 8 }}>
            <div
                role="radiogroup"
                aria-label="Local node attendance workflow"
                style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(155px, 1fr))",
                    gap: 8,
                }}
            >
                {OPTIONS.map((option) => {
                    const active = option.key === value;

                    return (
                        <button
                            key={option.key}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            disabled={disabled}
                            onClick={() => {
                                if (!disabled) onChange(option.key);
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
                This is controlled by QIntellect Support. The Client Dashboard cannot change this.
            </div>
        </div>
    );
}