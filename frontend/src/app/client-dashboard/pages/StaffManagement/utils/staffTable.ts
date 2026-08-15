/**
 * modules/staff/utils/staffTable.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * People-table column model: which template columns are shown, how wide the
 * grid tracks are, how a column maps to a sort key, and how a cell's text
 * and alignment are derived. Header row and StaffRow both read alignment
 * from getColumnAlign here, which is what keeps them from drifting apart.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  readColumnValue,
  type TemplateColumn,
} from "../../../utils/templateColumns";
import { normalizePeopleType } from "../types/types";
import { type StaffMember } from "../types/staffTypes";
import { staffSalary } from "./staffMember";
import { shiftText } from "./staffShifts";
import { STATUS_META } from "./staffStatus";

export type StaffTemplateColumn = TemplateColumn<Record<string, unknown>>;

export const PEOPLE_TABLE_ACTION_WIDTH = 112;

export function getPeopleTableColumns(
  columns: StaffTemplateColumn[],
  showBranch: boolean,
  peopleType: string,
  purchasedModules: string[],
): StaffTemplateColumn[] {
  const normalizedPeopleType = normalizePeopleType(peopleType);
  const purchased = new Set(
    purchasedModules.map((moduleKey) => String(moduleKey).trim().toLowerCase()),
  );

  const filtered = columns.filter((column) => {
    const key = String(column.key);

    if (key === "training" || key === "trainingVideo") return false;
    if (key === "email") return false;
    if (key === "phone") return false;
    if (!showBranch && key === "branch") return false;

    if (key === "salary" || key === "payroll") {
      return normalizedPeopleType !== "student" && purchased.has("payroll");
    }

    return true;
  });

  // Staff Type (Office / Field) — shows at a glance which attendance flow
  // (WiFi vs geofence) applies to each person, without opening their
  // profile. Not part of the org's per-vertical template column config
  // (`columns` above comes from there, and staff_type is an attendance-
  // module concept, not something every vertical's template knows about),
  // so it's injected here instead of expected to already be in the list.
  // Skipped for students — the student template has no staff_type/
  // attendance-mode concept at all.
  if (normalizedPeopleType !== "student") {
    const staffTypeColumn = {
      key: "staffType",
      dataKey: "staffType",
      label: "Staff Type",
      align: "left",
      exportable: true,
      sortable: true,
    } as unknown as StaffTemplateColumn;

    const statusIndex = filtered.findIndex((column) => column.key === "status");
    const insertAt = statusIndex >= 0 ? statusIndex + 1 : filtered.length;
    filtered.splice(insertAt, 0, staffTypeColumn);
  }

  // CNIC (employee/staff-side identity document) — same "inject here"
  // reasoning as staffType above: it's not part of the per-vertical
  // template's own column config, but every non-student person now has
  // one on their record, so the Directory should show it at a glance.
  // Placed right after Name (before Branch) rather than appended at the
  // end, so identity fields stay grouped together near the person's name.
  if (normalizedPeopleType !== "student") {
    const cnicColumn = {
      key: "cnic",
      dataKey: "cnic",
      label: "CNIC",
      align: "left",
      exportable: true,
      sortable: false,
    } as unknown as StaffTemplateColumn;
    const nameIndex = filtered.findIndex((column) => column.key === "name");
    const insertAt = nameIndex >= 0 ? nameIndex + 1 : 0;
    filtered.splice(insertAt, 0, cnicColumn);
  }

  // Guardian (father) details — students only. Three separate columns
  // rather than one combined column so each is independently sortable/
  // exportable and lines up with the three separate required fields in
  // the Add/Edit modal.
  if (normalizedPeopleType === "student") {
    filtered.push(
      {
        key: "fatherName",
        dataKey: "fatherName",
        label: "Father Name",
        align: "left",
        exportable: true,
        sortable: true,
      } as unknown as StaffTemplateColumn,
      {
        key: "fatherPhone",
        dataKey: "fatherPhone",
        label: "Father Number",
        align: "left",
        exportable: true,
        sortable: false,
      } as unknown as StaffTemplateColumn,
      {
        key: "fatherCnic",
        dataKey: "fatherCnic",
        label: "Father CNIC",
        align: "left",
        exportable: true,
        sortable: false,
      } as unknown as StaffTemplateColumn,
    );
  }

  return filtered;
}

export function staffGridTemplate(columns: StaffTemplateColumn[]): string {
  const widths = columns.map((column) => {
    if (column.key === "name") return "1.7fr";
    if (column.key === "code" || column.key === "personCode") return "1.1fr";
    if (column.key === "cnic" || column.key === "fatherCnic") return "1.2fr";
    if (column.key === "status") return ".8fr";
    if (column.key === "salary") return ".8fr";
    if (column.key === "shift") return "1.1fr";
    if (column.key === "staffType") return ".9fr";
    if (column.key === "fatherName") return "1.2fr";
    if (column.key === "fatherPhone") return "1fr";
    return "1fr";
  });

  return `${widths.join(" ")} ${PEOPLE_TABLE_ACTION_WIDTH}px`;
}

export function columnSortKey(column: StaffTemplateColumn): keyof StaffMember {
  const key = String(column.dataKey || column.key);
  const allowed = new Set<keyof StaffMember>([
    "id",
    "name",
    "personCode",
    "registrationNumber",
    "employeeId",
    "phone",
    "branchId",
    "branchName",
    "department",
    "role",
    "position",
    "status",
    "salary",
    "staffType",
    "shift",
    "shiftLabel",
    "joinDate",
    "cnic",
    "fatherName",
    "fatherPhone",
    "fatherCnic",
  ]);

  return allowed.has(key as keyof StaffMember)
    ? (key as keyof StaffMember)
    : "name";
}

export function staffColumnText(
  member: StaffMember,
  column: StaffTemplateColumn,
  branchName: (id: number) => string,
): string {
  if (column.key === "code" || column.key === "personCode") {
    return (
      member.personCode || member.registrationNumber || member.employeeId || "—"
    );
  }
  if (column.key === "branch") return branchName(member.branchId);
  if (column.key === "class" || column.key === "department") {
    return member.department || "—";
  }
  if (column.key === "section" || column.key === "designation") {
    return member.role || member.position || "—";
  }
  if (column.key === "shift") return shiftText(member);
  if (column.key === "salary")
    return `PKR ${staffSalary(member).toLocaleString()}`;
  if (column.key === "status") return STATUS_META[member.status].label;
  if (column.key === "staffType")
    return member.staffType === "field" ? "Field Staff" : "Office Staff";

  const value = readColumnValue(
    member as unknown as Record<string, unknown>,
    column,
  );
  return value === undefined || value === null || value === ""
    ? "—"
    : String(value);
}

export type ColumnAlign = "left" | "center" | "right";

// Single source of truth for column alignment, shared by the header row
// (~line 7168) and the data row (StaffRow.renderCell, ~line 4131). Some
// columns render a fixed-layout widget rather than plain text -- e.g.
// "status" is always an icon+label centered in the cell, and can never
// legitimately be left/right aligned no matter what the template config
// says. Those cases are pinned here so the header can never drift out of
// sync with how the cell actually renders (which is exactly what caused
// the Status column header/value misalignment previously).
export function getColumnAlign(column: StaffTemplateColumn): ColumnAlign {
  if (column.key === "status") return "center";
  if (column.align === "right") return "right";
  if (column.align === "center") return "center";
  return "left";
}
