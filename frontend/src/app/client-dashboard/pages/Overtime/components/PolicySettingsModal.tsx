/**
 * src/modules/overtime/components/PolicySettingsModal.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Overtime pay policy editor — method switch, all policy fields, and a
 * dynamic tiers array editor (add/remove/edit rows) for tiered_hours.
 *
 * Local to the overtime module — OvertimePolicy is overtime-specific, not a
 * shared cross-module concern, so this is NOT in DashboardComponents.tsx.
 *
 * Editing model: local draft state, committed to the parent only via onSave.
 * Cancel or backdrop click discards edits. Tiers are saved as-is —
 * calculateOvertimePay() sorts by upToHours at read time, so no sort-on-save
 * is required here.
 */

import React, { useCallback, useState } from "react";
import { Save, X } from "lucide-react";
import { T } from "../../../components/ui/theme";
import {
  CALC_METHOD_OPTIONS,
  type OvertimeCalculationMethod,
  type OvertimePolicy,
  type OvertimeTier,
} from "../types/overtime";

export interface PolicySettingsModalProps {
  policy: OvertimePolicy;
  onSave: (policy: OvertimePolicy) => void;
  onClose: () => void;
  saving?: boolean;
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 10,
  fontWeight: 900,
  color: T.muted,
  textTransform: "uppercase",
  letterSpacing: ".07em",
  marginBottom: 5,
};

const fieldInputStyle: React.CSSProperties = {
  height: 38,
  width: "100%",
  border: `1px solid ${T.border}`,
  borderRadius: 10,
  background: T.card,
  color: T.head,
  padding: "0 10px",
  fontSize: 13,
  fontWeight: 700,
  fontFamily: "inherit",
  boxSizing: "border-box",
};

export default function PolicySettingsModal({
  policy,
  onSave,
  onClose,
  saving = false,
}: PolicySettingsModalProps) {
  const [draft, setDraft] = useState<OvertimePolicy>(policy);

  const updateField = useCallback(
    <K extends keyof OvertimePolicy>(key: K, value: OvertimePolicy[K]) => {
      setDraft((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const updateTier = useCallback(
    (index: number, patch: Partial<OvertimeTier>) => {
      setDraft((prev) => ({
        ...prev,
        tiers: prev.tiers.map((tier, i) =>
          i === index ? { ...tier, ...patch } : tier,
        ),
      }));
    },
    [],
  );

  const addTier = useCallback(() => {
    setDraft((prev) => {
      const lastTier = prev.tiers[prev.tiers.length - 1];
      return {
        ...prev,
        tiers: [
          ...prev.tiers,
          {
            upToHours: (lastTier?.upToHours ?? 0) + 2,
            ratePerHour: lastTier?.ratePerHour ?? prev.fixedRatePerHour,
          },
        ],
      };
    });
  }, []);

  const removeTier = useCallback((index: number) => {
    setDraft((prev) => ({
      ...prev,
      tiers: prev.tiers.filter((_, i) => i !== index),
    }));
  }, []);

  const renderNumberField = (
    key: keyof OvertimePolicy,
    label: string,
    step = 1,
    min = 0,
  ) => (
    <div key={key}>
      <label style={labelStyle}>{label}</label>
      <input
        type="number"
        step={step}
        min={min}
        value={draft[key] as number}
        onChange={(e) => updateField(key, Number(e.target.value) as never)}
        style={fieldInputStyle}
      />
    </div>
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1500,
        background: "rgba(15,23,42,0.48)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        pointerEvents: saving ? "none" : undefined,
        opacity: saving ? 0.6 : undefined,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      aria-disabled={saving}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 560,
          maxHeight: "90vh",
          background: T.card,
          borderRadius: 16,
          boxShadow: "0 20px 70px rgba(15,23,42,0.25)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "18px 22px",
            borderBottom: `1px solid ${T.border}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          <h3 style={{ margin: 0, color: T.head, fontSize: 16 }}>
            Overtime Pay Policy
          </h3>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer" }}
          >
            <X size={18} color={T.muted} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 22, overflowY: "auto", flex: 1 }}>
          <div style={{ display: "grid", gap: 14 }}>
            {/* Calculation method */}
            <div>
              <label style={labelStyle}>Calculation Method</label>
              <select
                value={draft.calculationMethod}
                onChange={(e) =>
                  updateField(
                    "calculationMethod",
                    e.target.value as OvertimeCalculationMethod,
                  )
                }
                style={fieldInputStyle}
              >
                {CALC_METHOD_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Currency label — always relevant */}
            <div>
              <label style={labelStyle}>Currency Label</label>
              <input
                value={draft.currencyLabel}
                onChange={(e) => updateField("currencyLabel", e.target.value)}
                style={fieldInputStyle}
                maxLength={10}
              />
            </div>

            {/* Fixed rate / salary multiplier — conditional on method */}
            {(draft.calculationMethod === "fixed_hourly_rate" ||
              draft.calculationMethod === "salary_multiplier") && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 10,
                }}
              >
                {renderNumberField("fixedRatePerHour", "Fixed Rate / Hour", 10)}
                {draft.calculationMethod === "salary_multiplier" &&
                  renderNumberField(
                    "salaryMultiplier",
                    "Salary Multiplier",
                    0.1,
                  )}
              </div>
            )}

            {draft.calculationMethod === "salary_multiplier" &&
              renderNumberField(
                "standardMonthlyHours",
                "Standard Monthly Hours",
                1,
              )}

            {/* Tiers — only for tiered_hours */}
            {draft.calculationMethod === "tiered_hours" && (
              <div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 8,
                  }}
                >
                  <label style={labelStyle}>Hourly Tiers</label>
                  <button
                    type="button"
                    onClick={addTier}
                    style={{
                      height: 28,
                      borderRadius: 8,
                      border: `1px solid ${T.border}`,
                      background: T.card,
                      cursor: "pointer",
                      padding: "0 10px",
                      fontSize: 11,
                      fontWeight: 800,
                      color: T.teal600,
                    }}
                  >
                    + Add Tier
                  </button>
                </div>

                <div style={{ display: "grid", gap: 8 }}>
                  {draft.tiers.map((tier, index) => (
                    <div
                      key={index}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr 32px",
                        gap: 8,
                        alignItems: "center",
                        background: T.teal50,
                        border: `1px solid ${T.border}`,
                        borderRadius: 10,
                        padding: 8,
                      }}
                    >
                      <div>
                        <label
                          style={{
                            display: "block",
                            fontSize: 9,
                            fontWeight: 800,
                            color: T.muted,
                            marginBottom: 3,
                          }}
                        >
                          Up To (hrs)
                        </label>
                        <input
                          type="number"
                          min={0}
                          step={0.5}
                          value={tier.upToHours}
                          onChange={(e) =>
                            updateTier(index, {
                              upToHours: Number(e.target.value),
                            })
                          }
                          style={{
                            height: 32,
                            width: "100%",
                            border: `1px solid ${T.border}`,
                            borderRadius: 8,
                            background: T.card,
                            color: T.head,
                            padding: "0 8px",
                            fontSize: 12,
                            fontWeight: 700,
                            fontFamily: "inherit",
                            boxSizing: "border-box",
                          }}
                        />
                      </div>
                      <div>
                        <label
                          style={{
                            display: "block",
                            fontSize: 9,
                            fontWeight: 800,
                            color: T.muted,
                            marginBottom: 3,
                          }}
                        >
                          Rate / Hour
                        </label>
                        <input
                          type="number"
                          min={0}
                          step={10}
                          value={tier.ratePerHour}
                          onChange={(e) =>
                            updateTier(index, {
                              ratePerHour: Number(e.target.value),
                            })
                          }
                          style={{
                            height: 32,
                            width: "100%",
                            border: `1px solid ${T.border}`,
                            borderRadius: 8,
                            background: T.card,
                            color: T.head,
                            padding: "0 8px",
                            fontSize: 12,
                            fontWeight: 700,
                            fontFamily: "inherit",
                            boxSizing: "border-box",
                          }}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => removeTier(index)}
                        disabled={draft.tiers.length <= 1}
                        title={
                          draft.tiers.length <= 1
                            ? "At least one tier is required"
                            : "Remove tier"
                        }
                        style={{
                          height: 32,
                          width: 32,
                          borderRadius: 8,
                          border: `1px solid ${T.border}`,
                          background: T.card,
                          cursor:
                            draft.tiers.length <= 1 ? "not-allowed" : "pointer",
                          opacity: draft.tiers.length <= 1 ? 0.4 : 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          marginTop: 16,
                        }}
                      >
                        <X size={14} color="#dc2626" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Shared fields — apply to every calculation method */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
              }}
            >
              {renderNumberField("minBillableHours", "Min Billable Hours", 0.5)}
              {renderNumberField("roundToHours", "Round To (hrs)", 0.5)}
            </div>
            {renderNumberField(
              "maxHoursPerRequest",
              "Max Hours / Request",
              0.5,
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "14px 22px",
            borderTop: `1px solid ${T.border}`,
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              height: 38,
              borderRadius: 9,
              border: `1px solid ${T.border}`,
              background: T.card,
              cursor: "pointer",
              padding: "0 16px",
              fontSize: 12,
              fontWeight: 900,
              color: T.head,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(draft)}
            style={{
              height: 38,
              border: "none",
              background: T.teal600,
              color: "#fff",
              borderRadius: 9,
              padding: "0 16px",
              cursor: "pointer",
              fontWeight: 900,
              fontSize: 12,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Save size={14} color="#fff" /> Save Policy
          </button>
        </div>
      </div>
    </div>
  );
}
