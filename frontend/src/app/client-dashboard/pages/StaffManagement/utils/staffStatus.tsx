/**
 * modules/staff/utils/staffStatus.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Status colour/label metadata and the matching icon. .tsx because the icon
 * helper returns JSX.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { CheckCircle, Clock, XCircle } from "lucide-react";
import { T } from "../../../components/ui/theme";
import { type StaffMember } from "../types/staffTypes";

// ─── Status helpers ───────────────────────────────────────────────────────────
// STATUS_META keys are typed to StaffMember["status"] — the union declared in
// generateOrgDummyData.ts ("active" | "inactive" | "pending").
// No runtime guard or `as any` needed: TypeScript enforces the key at every usage.

export const STATUS_META = {
  active: { label: "Active", color: T.teal600, bg: T.teal100 },
  inactive: { label: "Inactive", color: T.muted, bg: T.slate50 },
  pending: { label: "Pending", color: T.amber, bg: T.amberBg },
} satisfies Record<
  StaffMember["status"],
  { label: string; color: string; bg: string }
>;

export const statusIcon = (s: StaffMember["status"]) =>
  ({
    active: <CheckCircle size={11} color={T.teal600} />,
    inactive: <XCircle size={11} color={T.muted} />,
    pending: <Clock size={11} color={T.amber} />,
  })[s];
