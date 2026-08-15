// modules/staff/types.ts
// ─────────────────────────────────────────────────────────────────────────────
// Shared people-directory helpers for template-aware person code rendering.
// Biometric video training is intentionally not handled from Client Dashboard.
// Enrollment videos are prepared outside the dashboard using exported CSV files
// and imported into the Local Node through an embeddings package.
// ─────────────────────────────────────────────────────────────────────────────

export type PeopleType =
  | "student"
  | "staff"
  | "employee"
  | "teacher"
  | "worker"
  | "personnel"
  | "member"
  | "volunteer";

export type PersonStatus = "active" | "inactive" | "pending";

export interface PeopleCodeModel {
  fieldKey: "personCode";
  backendKey: "person_code";
  label: string;
  placeholder: string;
  exportLabel: string;
}

export function normalizePeopleType(value: unknown): PeopleType {
  const key = String(value || "staff")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (key === "student" || key === "students") return "student";
  if (key === "teacher" || key === "teachers" || key === "faculty")
    return "teacher";
  if (
    key === "worker" ||
    key === "workers" ||
    key === "operator" ||
    key === "operators"
  )
    return "worker";
  if (key === "employee" || key === "employees") return "employee";
  if (key === "personnel") return "personnel";
  if (key === "member" || key === "members") return "member";
  if (key === "volunteer" || key === "volunteers") return "volunteer";

  return "staff";
}

export function peopleCodeModel(peopleType: unknown): PeopleCodeModel {
  const normalized = normalizePeopleType(peopleType);

  if (normalized === "student") {
    return {
      fieldKey: "personCode",
      backendKey: "person_code",
      label: "Registration Number",
      placeholder: "REG-001",
      exportLabel: "Registration Number",
    };
  }

  if (normalized === "teacher") {
    return {
      fieldKey: "personCode",
      backendKey: "person_code",
      label: "Teacher Code",
      placeholder: "TCH-001",
      exportLabel: "Teacher Code",
    };
  }

  if (normalized === "worker") {
    return {
      fieldKey: "personCode",
      backendKey: "person_code",
      label: "Worker ID",
      placeholder: "WRK-001",
      exportLabel: "Worker ID",
    };
  }

  if (normalized === "employee") {
    return {
      fieldKey: "personCode",
      backendKey: "person_code",
      label: "Employee ID",
      placeholder: "EMP-001",
      exportLabel: "Employee ID",
    };
  }

  return {
    fieldKey: "personCode",
    backendKey: "person_code",
    label: "Staff ID",
    placeholder: "STF-001",
    exportLabel: "Staff ID",
  };
}

export function peopleCodeLabel(peopleType: unknown): string {
  return peopleCodeModel(peopleType).label;
}

export function peopleCodePlaceholder(peopleType: unknown): string {
  return peopleCodeModel(peopleType).placeholder;
}
