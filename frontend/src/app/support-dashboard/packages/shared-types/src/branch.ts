/**
 * packages/shared-types/src/branch.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Branch types shared across Client Dashboard and Support Dashboard.
 *
 * Design doc ref — Section 8:
 *   branches table: id, org_id, max_staff_capacity, fallback_active
 *   node_api_keys table: last_seen_at determines node online/offline status
 */

export type NodeStatus = "online" | "offline" | "never_connected";

export interface Branch {
  id: string;
  org_id: string;
  name: string;
  location: string;
  max_staff_capacity: number;
  /* True when local node has been offline past node_offline_threshold_seconds */
  fallback_active: boolean;
  /** Derived from node_api_keys.last_seen_at */
  node_status: NodeStatus;
  last_seen_at: string | null;
  created_at: string;
}

export interface CreateBranchPayload {
  org_id: string;
  name: string;
  location: string;
  max_staff_capacity: number;
}

export interface UpdateBranchPayload extends Partial<
  Omit<CreateBranchPayload, "org_id">
> {
  id: string;
}

/** Returned by /v1/support/branches/:id/install-token */
export interface InstallToken {
  token: string;
  expires_at: string;
  branch_id: string;
  org_id: string;
}
