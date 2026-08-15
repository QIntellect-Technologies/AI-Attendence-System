/**
 * modules/staff/utils/staffShifts.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Shift resolution helpers. "custom" is deliberately not a member of the
 * org-wide shift definitions, so these are the single place that knows how
 * to fall back for a per-person one-off shift.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  DEFAULT_SHIFT_DEFINITIONS,
  type ShiftDefinition,
  type StaffWorkType,
} from "../../../contexts/OrgConfigContext";
import { type StaffFormData } from "../types/staffForm";
import { type StaffMember } from "../types/staffTypes";

// ─── Shift helpers ───────────────────────────────────────────────────────────

export type StaffMemberWithShiftFields = StaffMember & {
  userId: string;
  position: string;
  accessModules: string[];
  presentDays: number;
  createdAt: string;
  updatedAt: string;
  staffType: StaffWorkType;
  shiftId: ShiftDefinition["id"];
  shiftLabel: string;
  shiftStart: string;
  shiftEnd: string;
};

// "custom" is intentionally never a member of `definitions` — it's not a
// company-wide shift (see the filtering at the shiftDefinitions call site
// below), it's a per-person one-off. getShiftDefinition/normalizeStaffShiftId
// must therefore treat it as its own case rather than falling back to
// definitions[0] ("Morning") whenever a custom-shift staff member is loaded.
export const getShiftDefinition = (
  definitions: ShiftDefinition[],
  shiftId: string,
): ShiftDefinition =>
  definitions.find(
    (definition) => definition.id === shiftId || definition.label === shiftId,
  ) ??
  definitions[0] ??
  DEFAULT_SHIFT_DEFINITIONS[0];

export const normalizeStaffShiftId = (
  definitions: ShiftDefinition[],
  member: StaffMember,
): string => {
  const raw = String(
    (member as any).shiftId ?? (member as any).shift ?? "morning",
  );
  if (raw === "custom") return "custom";
  return getShiftDefinition(definitions, raw).id;
};

/**
 * Builds the effective ShiftDefinition-shaped object for a submitted form.
 * For every real company shift this is just a lookup in `definitions`. For
 * "custom" it's synthesized entirely from the two inline time inputs the
 * staff modal reveals — a custom shift is never added to `definitions`,
 * never shown in "Company Shift Timings," and never offered to anyone else.
 */
export const resolveEffectiveShift = (
  definitions: ShiftDefinition[],
  data: StaffFormData,
): ShiftDefinition => {
  if (data.shift === "custom") {
    return {
      id: "custom",
      label: "Custom",
      start: data.customShiftStart || "09:00",
      end: data.customShiftEnd || "17:00",
    } as ShiftDefinition;
  }
  return getShiftDefinition(definitions, data.shift);
};

export const shiftText = (member: StaffMember): string => {
  const shift = String(
    (member as any).shiftLabel ?? (member as any).shift ?? "Morning",
  );
  const start = String((member as any).shiftStart ?? "09:00");
  const end = String((member as any).shiftEnd ?? "17:00");
  return `${shift} · ${start}–${end}`;
};

export const staffTypeText = (member: StaffMember): string =>
  String((member as any).staffType ?? "office") === "field"
    ? "Field"
    : "Office";
