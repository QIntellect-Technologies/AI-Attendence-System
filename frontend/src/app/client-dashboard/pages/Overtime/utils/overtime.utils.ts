/**
 * src/modules/overtime/utils/overtime.utils.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Overtime management utility functions.
 *
 * Pure functions only — no React, no hooks. Mirrors the role of
 * leave/utils/leave.utils.ts for the leave module: normalizers,
 * calculations, formatting, and other helpers used across the overtime
 * feature (component, hooks, modal).
 */

import type { OvertimeRequest } from "../../../contexts/ModuleContext";
import type {
  BranchOption,
  HoursFilter,
  OvertimePolicy,
  PeriodFilter,
} from "../types/overtime";

type OvertimeRecordLike = OvertimeRequest & {
  staffId?: string | number | null;
  userId?: string | number | null;
  user_id?: string | number | null;
  staffName?: string | null;
  userName?: string | null;
  user_name?: string | null;
  name?: string | null;
  date?: string | null;
  otDate?: string | null;
  ot_date?: string | null;
  appliedOn?: string | null;
  createdAt?: string | null;
  created_at?: string | null;
  task?: string | null;
  reason?: string | null;
  rejectionNote?: string | null;
  rejection_note?: string | null;
};

function asOvertimeRecord(row: OvertimeRequest): OvertimeRecordLike {
  return row as OvertimeRecordLike;
}

function text(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function overtimeStaffName(row: OvertimeRequest): string {
  const r = asOvertimeRecord(row);
  return text(
    r.staffName ?? r.userName ?? r.user_name ?? r.name,
    "Unknown Employee",
  );
}

function overtimeStaffId(row: OvertimeRequest): string {
  const r = asOvertimeRecord(row);
  return text(r.staffId ?? r.userId ?? r.user_id ?? "");
}

function overtimeDate(row: OvertimeRequest): string {
  const r = asOvertimeRecord(row);
  return text(r.date ?? r.otDate ?? r.ot_date ?? "");
}

function overtimeAppliedOn(row: OvertimeRequest): string {
  const r = asOvertimeRecord(row);
  return text(r.appliedOn ?? r.createdAt ?? r.created_at ?? "");
}

function overtimeTask(row: OvertimeRequest): string {
  const r = asOvertimeRecord(row);
  return text(r.task ?? r.reason ?? "");
}

function overtimeRejectionNote(row: OvertimeRequest): string {
  const r = asOvertimeRecord(row);
  return text(r.rejectionNote ?? r.rejection_note ?? "");
}

// ─── Date helpers ────────────────────────────────────────────────────────────

export function parseDate(value: string): Date {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

export function formatDate(value: string): string {
  const date = parseDate(value);
  if (date.getTime() === 0) return value || "—";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

export function isWithinPeriod(
  request: OvertimeRequest,
  period: PeriodFilter,
  customFrom: string,
  customTo: string,
): boolean {
  if (period === "all") return true;
  const requestDate = parseDate(overtimeDate(request));
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const start = new Date(today);

  if (period === "today")
    return overtimeDate(request) === today.toISOString().slice(0, 10);
  if (period === "7d") start.setDate(today.getDate() - 6);
  if (period === "30d") start.setDate(today.getDate() - 29);
  if (period === "month") {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
  }
  if (period === "custom") {
    const from = parseDate(customFrom);
    const to = parseDate(customTo);
    const min = from <= to ? from : to;
    const max = from <= to ? to : from;
    min.setHours(0, 0, 0, 0);
    max.setHours(23, 59, 59, 999);
    return requestDate >= min && requestDate <= max;
  }

  start.setHours(0, 0, 0, 0);
  return requestDate >= start && requestDate <= today;
}

export function matchesHoursFilter(
  request: OvertimeRequest,
  hoursFilter: HoursFilter,
): boolean {
  if (hoursFilter === "all") return true;
  if (hoursFilter === "lt2") return request.hours < 2;
  if (hoursFilter === "2to4") return request.hours >= 2 && request.hours <= 4;
  return request.hours > 4;
}

// ─── Branch helpers ──────────────────────────────────────────────────────────

export function safeBranchName(
  branchId: number,
  branches: BranchOption[],
  fallback?: string,
): string {
  return (
    branches.find((branch) => branch.id === branchId)?.name ||
    fallback ||
    `Branch ${branchId}`
  );
}

// ─── Pay calculation ──────────────────────────────────────────────────────────

export function roundHours(hours: number, roundToHours: number): number {
  if (roundToHours <= 0) return hours;
  return Math.ceil(hours / roundToHours) * roundToHours;
}

export function calculateOvertimePay(
  hours: number,
  policy: OvertimePolicy,
  monthlySalary?: number,
): number {
  const billableHours = Math.max(
    policy.minBillableHours,
    roundHours(hours, policy.roundToHours),
  );

  if (policy.calculationMethod === "salary_multiplier") {
    const hourlyRate =
      monthlySalary && monthlySalary > 0
        ? monthlySalary / Math.max(policy.standardMonthlyHours, 1)
        : policy.fixedRatePerHour;
    return Math.round(billableHours * hourlyRate * policy.salaryMultiplier);
  }

  if (policy.calculationMethod === "tiered_hours") {
    let remaining = billableHours;
    let previousCap = 0;
    let total = 0;
    [...policy.tiers]
      .sort((a, b) => a.upToHours - b.upToHours)
      .forEach((tier) => {
        if (remaining <= 0) return;
        const tierSpan = Math.max(tier.upToHours - previousCap, 0);
        const billableInTier = Math.min(remaining, tierSpan);
        total += billableInTier * tier.ratePerHour;
        remaining -= billableInTier;
        previousCap = tier.upToHours;
      });
    if (remaining > 0) {
      const lastRate =
        policy.tiers[policy.tiers.length - 1]?.ratePerHour ??
        policy.fixedRatePerHour;
      total += remaining * lastRate;
    }
    return Math.round(total);
  }

  return Math.round(billableHours * policy.fixedRatePerHour);
}

export function policyMethodLabel(policy: OvertimePolicy): string {
  if (policy.calculationMethod === "salary_multiplier")
    return `${policy.salaryMultiplier}× salary hourly rate`;
  if (policy.calculationMethod === "tiered_hours") return "Tiered hourly slabs";
  return `${policy.currencyLabel} ${policy.fixedRatePerHour.toLocaleString()}/hr`;
}

// ─── Misc ──────────────────────────────────────────────────────────────────

export function uniqueOptions(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

// ─── Policy persistence (localStorage — policy is a local UI preference,
// not entity data, so this intentionally does NOT go through ModuleContext) ──

const POLICY_STORAGE_KEY = "overtimePolicy";

function policyStorageKey(scopeKey?: string | null): string {
  const scope = String(scopeKey || "global").trim() || "global";
  return `${POLICY_STORAGE_KEY}:${scope}`;
}

export function loadPolicy(
  defaultPolicy: OvertimePolicy,
  scopeKey?: string | null,
): OvertimePolicy {
  try {
    const raw = localStorage.getItem(policyStorageKey(scopeKey));
    if (!raw) return defaultPolicy;
    return { ...defaultPolicy, ...JSON.parse(raw) };
  } catch {
    return defaultPolicy;
  }
}

export function persistPolicy(
  policy: OvertimePolicy,
  scopeKey?: string | null,
): void {
  try {
    localStorage.setItem(policyStorageKey(scopeKey), JSON.stringify(policy));
  } catch {
    // Non-fatal — policy simply won't persist across reloads.
  }
}

// ─── CSV export ────────────────────────────────────────────────────────────

export function exportOvertimeCsv(
  filename: string,
  rows: OvertimeRequest[],
  policy: OvertimePolicy,
): void {
  const headers = [
    "ID",
    "Employee",
    "Staff ID",
    "Branch",
    "Department",
    "Date",
    "Hours",
    "Estimated Pay",
    "Status",
    "Applied On",
    "Task",
    "Rejection Note",
  ];
  const escape = (value: unknown) =>
    `"${String(value ?? "").replace(/"/g, '""')}"`;
  const body = rows.map((r) =>
    [
      r.id,
      overtimeStaffName(r),
      overtimeStaffId(r),
      r.branchName,
      r.department,
      overtimeDate(r),
      r.hours,
      calculateOvertimePay(r.hours, policy),
      r.status,
      overtimeAppliedOn(r),
      overtimeTask(r),
      overtimeRejectionNote(r),
    ]
      .map(escape)
      .join(","),
  );
  const blob = new Blob([[headers.join(","), ...body].join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.replace(/[\\/:*?"<>|]+/g, "-");
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
