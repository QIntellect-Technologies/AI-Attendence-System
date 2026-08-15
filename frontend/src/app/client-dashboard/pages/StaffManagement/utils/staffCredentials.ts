/**
 * modules/staff/utils/staffCredentials.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Login credential generation for dashboard-created staff, and the
 * downloadable credentials file. Identity source priority (email local-part,
 * then raw phone, then person code) lives here so the modal and any future
 * caller can't disagree about it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  type OrgUserRecord,
  type StaffWorkType,
} from "../../../contexts/OrgConfigContext";
import { type StaffFormData } from "../types/staffForm";
import { type StaffMember } from "../types/staffTypes";

// ─── Login credential helpers ────────────────────────────────────────────────
// Dashboard-created employees receive branch-scoped credentials.
// The same credentials can log in to the dashboard, but staff users should only
// see the branch and modules granted by Admin in Staff Management.

export interface StaffLoginCredentials {
  userId: string;
  staffId: string;
  employeeName: string;
  email: string;
  username: string;
  password: string;
  branchId: number;
  branchName: string;
  staffType: StaffWorkType;
  allowedModules: string[];
  desktopDashboardEnabled: boolean;
  flutterPortalEnabled: boolean;
  createdAt: string;
}

export const safeSlug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "") || "staff";

// Priority: email local-part, then the raw phone number exactly as entered,
// then personCode/name as a last resort for the rare case neither contact
// field was provided (the Save button already blocks that in the modal,
// but this stays defensive in case buildStaffCredentials is ever called
// from elsewhere). The phone value is used as-is — not reformatted — so it
// matches character-for-character what the backend stores on client_staff
// and matches against at mobile login time.
export const staffIdentitySource = (data: StaffFormData): string => {
  const emailLocalPart = data.email?.trim().split("@")[0];
  if (emailLocalPart) return emailLocalPart;

  const phone = data.phone?.trim();
  if (phone) return phone;

  return data.personCode || data.name;
};

export const buildStaffCredentials = (
  data: StaffFormData,
  staffId: string,
  userId: string,
  branchName: string,
): StaffLoginCredentials => {
  const username = staffIdentitySource(data);
  const now = new Date().toISOString();

  return {
    userId,
    staffId,
    employeeName: data.name,
    email: data.email ?? "",
    username,
    // Placeholder only — the create-staff request never sends a password
    // (see the "new" branch of the submit handler below), so the backend
    // always generates one with a cryptographically secure generator
    // (secrets.choice, not Math.random) and returns it in
    // result.credentials.password. That value always overwrites this
    // field before the credentials are shown to the admin; nothing should
    // ever read this placeholder.
    password: "",
    branchId: data.branchId,
    branchName,
    staffType: data.staffType,
    allowedModules: data.moduleAccess,
    desktopDashboardEnabled: true,
    flutterPortalEnabled: true,
    createdAt: now,
  };
};

export const credentialsToUserRecord = (
  credentials: StaffLoginCredentials,
  status: StaffMember["status"],
): OrgUserRecord => ({
  id: credentials.userId,
  staffId: credentials.staffId,
  name: credentials.employeeName,
  email: credentials.email,
  username: credentials.username,
  password: credentials.password,
  role: "staff",
  status,
  branchId: credentials.branchId,
  branchName: credentials.branchName,
  staffType: credentials.staffType,
  allowedBranchIds: [credentials.branchId],
  allowedModules: credentials.allowedModules,
  portalAccess: {
    desktopDashboard: credentials.desktopDashboardEnabled,
    flutterStaffPortal: credentials.flutterPortalEnabled,
  },
  dashboardScope: "branch",
  createdAt: credentials.createdAt,
  updatedAt: credentials.createdAt,
});

export const buildCredentialsFile = (
  credentials: StaffLoginCredentials,
): string => {
  return [
    "Staff Login Credentials",
    "------------------------------------------------",
    `Employee: ${credentials.employeeName}`,
    `Staff ID: ${credentials.staffId}`,
    `Branch: ${credentials.branchName}`,
    `Staff Type: ${credentials.staffType === "field" ? "Field Staff" : "Office Staff"}`,
    "",
    "Login Details",
    `Username / Number: ${credentials.username}`,
    `Password: ${credentials.password}`,
    "",
    "Portal Access",
    "Staff Portal: Enabled",
    "Dashboard: Enabled — branch-scoped limited module access",
    `Dashboard Branch: ${credentials.branchName}`,
    `Dashboard Modules: ${credentials.allowedModules.length ? credentials.allowedModules.join(", ") : "No dashboard modules selected"}`,
    "",
    "Share these credentials privately with the employee.",
    "The employee should only see the selected modules for the assigned branch.",
  ].join("\n");
};

export const downloadTextFile = (filename: string, content: string): void => {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.replace(/[\\/:*?"<>|]+/g, "-");
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};
