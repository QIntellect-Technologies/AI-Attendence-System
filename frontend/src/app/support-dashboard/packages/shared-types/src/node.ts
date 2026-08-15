/**
 * packages/shared-types/src/node.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Node health + incident types.
 *
 * Design doc ref — Section 7 (Support Dashboard → Node Health):
 *   Per-branch node status: online/offline, last_seen_at,
 *   fallback_active flag, manual fallback override.
 */

import type { NodeStatus } from "./branch";

export interface NodeHealth {
  node_id: string;
  org_id: string;
  branch_id: string;
  branch_name: string;
  org_name: string;
  status: NodeStatus;
  last_seen_at: string | null;
  fallback_active: boolean;
}

export interface ManualFallbackPayload {
  branch_id: string;
  fallback_active: boolean;
}

export type IncidentSeverity = "low" | "medium" | "high" | "critical";
export type IncidentStatus = "open" | "in_progress" | "resolved";

export interface ModuleIncident {
  id: string;
  org_id: string;
  org_name?: string;
  module_name: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  description: string;
  assigned_to: string | null;
  created_at: string;
  resolved_at: string | null;
}
