/**
 * src/modules/overtime/types/overtime.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for all overtime-related types and shared constants.
 *
 * OvertimeRequest itself is NOT defined here — it's ModuleContext's
 * DummyOvertimeRequest (re-exported as OvertimeRequest), since ModuleContext
 * owns the entity store. This file only owns types that are local to the
 * overtime UI/feature layer: policy shape, filter unions, sort keys.
 */

import type { OvertimeRequest } from "../../../contexts/ModuleContext";

// ─── Status (derived from the entity type — stays in sync automatically) ─────

export type OvertimeStatus = OvertimeRequest["status"];
export type DecidableStatus = "Approved" | "Rejected";

// ─── Filter / sort unions ──────────────────────────────────────────────────

export type PeriodFilter = "all" | "today" | "7d" | "30d" | "month" | "custom";
export type HoursFilter = "all" | "lt2" | "2to4" | "gt4";
export type SortKey =
  | "date"
  | "employee"
  | "hours"
  | "status"
  | "appliedOn"
  | "branch";
export type SortDir = "asc" | "desc";

// ─── Filter state (mirrors LeaveFilterState's shape/role) ────────────────────

export interface OvertimeFilterState {
  branch: "all" | string;
  status: OvertimeStatus | "all";
  department: string;
  period: PeriodFilter;
  hours: HoursFilter;
  customFrom: string;
  customTo: string;
}

export const OVERTIME_FILTER_DEFAULTS: OvertimeFilterState = {
  branch: "all",
  status: "all",
  department: "all",
  period: "all",
  hours: "all",
  customFrom: new Date().toISOString().slice(0, 10),
  customTo: new Date().toISOString().slice(0, 10),
};

export interface OvertimeFilterOption {
  value: string;
  label: string;
  count: number;
}

// ─── Pay policy ────────────────────────────────────────────────────────────

export type OvertimeCalculationMethod =
  | "fixed_hourly_rate"
  | "salary_multiplier"
  | "tiered_hours";

export interface OvertimeTier {
  upToHours: number;
  ratePerHour: number;
}

export interface OvertimePolicy {
  calculationMethod: OvertimeCalculationMethod;
  currencyLabel: string;
  fixedRatePerHour: number;
  salaryMultiplier: number;
  standardMonthlyHours: number;
  minBillableHours: number;
  roundToHours: number;
  maxHoursPerRequest: number;
  tiers: OvertimeTier[];
}

export const DEFAULT_OVERTIME_POLICY: OvertimePolicy = {
  calculationMethod: "fixed_hourly_rate",
  currencyLabel: "PKR",
  fixedRatePerHour: 500,
  salaryMultiplier: 1.5,
  standardMonthlyHours: 208,
  minBillableHours: 0.5,
  roundToHours: 0.5,
  maxHoursPerRequest: 6,
  tiers: [
    { upToHours: 2, ratePerHour: 500 },
    { upToHours: 4, ratePerHour: 650 },
    { upToHours: 24, ratePerHour: 800 },
  ],
};

export const CALC_METHOD_OPTIONS: {
  value: OvertimeCalculationMethod;
  label: string;
}[] = [
  { value: "fixed_hourly_rate", label: "Fixed Hourly Rate" },
  { value: "salary_multiplier", label: "Salary Multiplier" },
  { value: "tiered_hours", label: "Tiered Hourly Slabs" },
];

export const API_STATUS_MAP: Record<DecidableStatus, "approved" | "rejected"> =
  {
    Approved: "approved",
    Rejected: "rejected",
  };

// ─── Misc view types ───────────────────────────────────────────────────────

export interface BranchOption {
  id: number;
  name: string;
}
