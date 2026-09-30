/**
 * modules/organizations/deployment.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for an organization's deployment model.
 *
 *   Cloud       saas    + cloud   recognition and reporting in the cloud
 *   Hybrid      saas    + local   recognition on a local node, reporting in the cloud
 *   On-Premise  on_prem + local   recognition and reporting local, under a license
 *
 * Stored as client_category + attendance_mode (no new column); the UI works in
 * terms of DeploymentModel so the two fields can never contradict each other.
 */

import type {
  AttendanceMode,
  ClientCategory,
} from "../../packages/shared-types/src/organization";

export type DeploymentModel = "cloud" | "hybrid" | "on_premise";

export interface DeploymentFields {
  client_category?: ClientCategory | string | null;
  attendance_mode?: AttendanceMode | string | null;
}

export const DEPLOYMENT_LABELS: Record<DeploymentModel, string> = {
  cloud: "Cloud",
  hybrid: "Hybrid",
  on_premise: "On-Premise (Licensed)",
};

/** The stored fields each deployment model maps to. */
export const DEPLOYMENT_FIELDS: Record<
  DeploymentModel,
  { client_category: ClientCategory; attendance_mode: AttendanceMode }
> = {
  cloud: { client_category: "saas", attendance_mode: "cloud" },
  hybrid: { client_category: "saas", attendance_mode: "local" },
  on_premise: { client_category: "on_prem", attendance_mode: "local" },
};

export const isOnPremOrg = (org?: DeploymentFields | null): boolean =>
  String(org?.client_category || "").toLowerCase() === "on_prem";

export const getDeploymentModel = (
  org?: DeploymentFields | null,
): DeploymentModel => {
  if (isOnPremOrg(org)) return "on_premise";
  return String(org?.attendance_mode || "").toLowerCase() === "local"
    ? "hybrid"
    : "cloud";
};