/**
 * modules/staff/utils/staffCoercions.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Unknown -> typed value coercions used when reading loosely-typed backend
 * rows and ModuleContext records. No React, no domain logic — just the
 * narrow "make this unknown safe to use" primitives.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { type StaffWorkType } from "../../../contexts/OrgConfigContext";
import { type StaffStatus } from "../types/staffTypes";

export type LooseRecord = Record<string, unknown>;

export function asRecord(value: unknown): LooseRecord {
  return value && typeof value === "object" ? (value as LooseRecord) : {};
}

export function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function asNumberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function asStatus(value: unknown): StaffStatus {
  const raw = asString(value, "active").toLowerCase();

  if (raw === "inactive") return "inactive";
  if (raw === "pending") return "pending";

  return "active";
}

export function asStaffWorkType(value: unknown): StaffWorkType {
  return asString(value, "office").toLowerCase() === "field"
    ? "field"
    : "office";
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => asString(item).trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => asString(item).trim()).filter(Boolean);
      }
    } catch {
      return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }

  return [];
}
