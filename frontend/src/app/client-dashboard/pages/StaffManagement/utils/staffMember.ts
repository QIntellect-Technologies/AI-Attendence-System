/**
 * modules/staff/utils/staffMember.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Small read-only accessors over a StaffMember — avatar URL, initial,
 * salary, module list. Shared by StaffRow, ProfileDrawer and StaffStats so
 * each surface renders the same value from the same rule.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { type StaffMember } from "../types/staffTypes";
import { resolveProfileImageUrl } from "./staffMedia";

// Replace the existing staffAvatarUrl helper:
export const staffAvatarUrl = (member: StaffMember): string | undefined =>
  resolveProfileImageUrl(member.profileImageUrl) || undefined;

export const staffInitial = (member: StaffMember): string =>
  member.name.trim().charAt(0).toUpperCase() || "?";

export const staffSalary = (member: StaffMember): number =>
  Number(member.salary || 0);

export const staffModules = (member: StaffMember): string[] =>
  member.moduleAccess.length ? member.moduleAccess : member.accessModules;
