export interface CameraChange {
  camera_id: string;
  camera_name: string;
  change_type: "added" | "updated" | "removed";
}

export interface NodeRuntimeStatus {
  cycle_status?: string;
  configured_cameras?: number;
  training_jobs_processed?: number;
  camera_events_marked?: number;
  last_cycle_at?: string;
  last_error?: string | null;
  last_heartbeat_at?: string;
  last_heartbeat_status?: string;
  last_heartbeat_error?: string | null;
  camera_changes?: CameraChange[];
  camera_changes_at?: string | null;
  /** True while this node has no internet connectivity. Drives the
   * "lost connectivity" banner and blocks manual sync in App.tsx. */
  offline?: boolean;
}

export interface NodeStatusResponse {
  success: true;
  activated: boolean;
  node_id?: string | null;
  org_id?: string | null;
  org_name?: string | null;
  branch_id?: string | null;
  attendance_mode?: "cloud" | "local" | string | null;
  hostname?: string | null;
  runtime?: NodeRuntimeStatus;
  held_attendance_count?: number;
}

export interface LiveAttendanceEvent {
  id: string;
  type: string;
  name: string;
  staff_id?: string;
  status: string;
  confidence: number;
  message: string;
  marked_at: string;
  check_out_marked_at?: string | null;
  sync_status: "pending" | "synced" | "failed" | "held_for_review" | string;
  camera_id?: string | null;
  camera_name?: string | null;
  snapshot?: string | null;
  notes?: string | null;
}

export interface CameraInfo {
  id: string;
  name: string;
  location?: string;
}

export interface LiveEventsResponse {
  success: true;
  events: LiveAttendanceEvent[];
  attendance: LiveAttendanceEvent[];
}

export interface ImportEmbeddingsResult {
  success: true;
  branch_label: string;
  generated_at: string;
  source_csv_name?: string;
  source_csv_sha256?: string;
  package_id?: string;
  imported: number;
  skipped: number;
  errors: string[];
}

export interface SyncAttendanceResponse {
  success: true;
  synced_count: number;
  held_remaining: number;
}

export interface ClearAttendanceResponse {
  success: true;
  cleared_count: number;
  held_remaining: number;
}

export interface HeldAttendanceRow {
  id: string;
  people_type: string;
  person_code: string;
  staff_name: string;
  confidence: number;
  camera_id?: string | null;
  camera_name?: string | null;
  attendance_date: string;
  marked_at: string;
  check_out_marked_at?: string | null;
  check_in_confirmed: boolean;
  check_in_hold_reason?: "late" | null;
  check_out_hold_reason?: "early" | "late" | null;
  notes?: string | null;
  /** Decision already made by the operator ('late' | 'half_day' |
   * 'short_leave' | 'overtime'), null until resolved. */
  status?: string | null;
  /** True once the operator has picked an outcome for this row — it is
   * still sync_status='held_for_review' (not yet pushed to the cloud),
   * but no longer needs a decision, only a sync click. */
  resolved: boolean;
}

export interface HeldAttendanceResponse {
  success: true;
  held: HeldAttendanceRow[];
}

export interface SyncSelectedAttendanceResponse {
  success: true;
  synced_count: number;
  held_remaining: number;
}

export interface DeleteHeldAttendanceResponse {
  success: true;
  deleted_count: number;
  held_remaining: number;
}

/** Shared response shape for the three checkout-hold resolution actions —
 * a batch call can partially succeed (e.g. a 'late' row sent to the
 * half-day action is skipped, not an error), so callers get both counts
 * plus which ids were skipped rather than a single success/fail verdict. */
export interface ResolveHeldCheckoutsResponse {
  success: true;
  resolved_count: number;
  skipped_count: number;
  skipped_ids: string[];
  held_remaining: number;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });

  const body = await response.json().catch(() => null);

  if (!response.ok || body?.success === false) {
    throw new Error(
      body?.message || body?.error || `Request failed: ${response.status}`,
    );
  }

  return body as T;
}

// Backend exceptions occasionally leak raw OS/network internals straight
// into body.message — e.g. "[Errno 11001] getaddrinfo failed" is a Windows
// DNS-resolution failure that surfaces when this node can't reach the
// Railway API while offline. Those aren't meaningful to an operator, so
// this pattern list catches the common shapes (errno codes, socket/DNS
// failures, browser fetch-level network errors, stack traces) and swaps
// them for one plain connectivity message. Anything else — a real
// body.message/body.error the backend meant for the user, or a clean
// thrown Error — passes through unchanged.
const RAW_ERROR_PATTERNS =
  /errno|getaddrinfo|econnrefused|enotfound|etimedout|econnreset|gaierror|winerror|traceback|failed to fetch|networkerror|dns lookup/i;

export function humanizeError(err: unknown, fallback: string): string {
  if (!(err instanceof Error) || !err.message) return fallback;
  const { message } = err;
  if (RAW_ERROR_PATTERNS.test(message)) {
    return "Can't reach the server. Check this node's internet connection and try again.";
  }
  const statusMatch = /^Request failed: (\d{3})$/.exec(message);
  if (statusMatch) {
    return `The server couldn't complete that request (${statusMatch[1]}). Please try again.`;
  }
  return message;
}

function resolveHeldCheckouts(path: string, localEventIds: string[]) {
  return requestJson<ResolveHeldCheckoutsResponse>(path, {
    method: "POST",
    body: JSON.stringify({ local_event_ids: localEventIds }),
  });
}

export const localNodeApi = {
  status: () => requestJson<NodeStatusResponse>("/api/status"),

  activate: (payload: {
    api_base_url: string;
    install_token: string;
    node_label?: string;
  }) =>
    requestJson<{ success: true; config: Record<string, unknown> }>(
      "/api/activate",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),

  liveEvents: () => requestJson<LiveEventsResponse>("/api/live-events"),

  cameras: () =>
    requestJson<{ success: true; cameras: CameraInfo[] }>("/api/cameras"),

  cameraStreamUrl: (cameraId: string) =>
    `/api/camera-stream/${encodeURIComponent(cameraId)}`,

  runCycle: () =>
    requestJson<{ success: true; status: NodeRuntimeStatus }>(
      "/api/run-cycle",
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    ),

  syncAttendance: () =>
    requestJson<SyncAttendanceResponse>("/api/sync-attendance", {
      method: "POST",
      body: JSON.stringify({}),
    }),

  clearTodayAttendance: () =>
    requestJson<ClearAttendanceResponse>("/api/clear-today-attendance", {
      method: "POST",
      body: JSON.stringify({}),
    }),

  heldAttendance: () =>
    requestJson<HeldAttendanceResponse>("/api/held-attendance"),

  syncSelectedAttendance: (localEventIds: string[]) =>
    requestJson<SyncSelectedAttendanceResponse>("/api/held-attendance/sync", {
      method: "POST",
      body: JSON.stringify({ local_event_ids: localEventIds }),
    }),

  deleteHeldAttendance: (localEventIds: string[]) =>
    requestJson<DeleteHeldAttendanceResponse>("/api/held-attendance/delete", {
      method: "POST",
      body: JSON.stringify({ local_event_ids: localEventIds }),
    }),

  // The held-checkout resolution actions share one request shape (a list
  // of local_event_ids) and one response shape (ResolveHeldCheckoutsResponse)
  // — only the endpoint path differs, so they're built off one small
  // helper instead of repeating requestJson each time. There is
  // deliberately no "confirm, no decision" action and no defer/leave-open
  // option — every held checkout resolves immediately to one of its
  // hold_reason's decisions, matching the office-staff exception
  // vocabulary in support_db_attendance_exceptions.py
  // (_CHECK_OUT_DECISIONS_BY_HOLD_REASON: 'late' -> {late, overtime},
  // 'early' -> {early_leave, short_leave, half_day}).
  markHeldCheckoutsLate: (localEventIds: string[]) =>
    resolveHeldCheckouts("/api/held-attendance/mark-late", localEventIds),

  markHeldCheckoutsOvertime: (localEventIds: string[]) =>
    resolveHeldCheckouts("/api/held-attendance/mark-overtime", localEventIds),

  markHeldCheckoutsHalfDay: (localEventIds: string[]) =>
    resolveHeldCheckouts("/api/held-attendance/mark-half-day", localEventIds),

  markHeldCheckoutsShortLeave: (localEventIds: string[]) =>
    resolveHeldCheckouts(
      "/api/held-attendance/mark-short-leave",
      localEventIds,
    ),

  // Third 'early' decision alongside half-day/short-leave: the person
  // really did leave early and the operator doesn't want to classify it
  // further — accepts the sighted time as the real checkout but does NOT
  // set a day status, only a note ("Early left"), since status is the
  // arrival-side classification. See local_db.mark_held_checkouts_early_left.
  markHeldCheckoutsEarlyLeft: (localEventIds: string[]) =>
    resolveHeldCheckouts(
      "/api/held-attendance/mark-early-left",
      localEventIds,
    ),

  // Check-in-leg counterpart: a late check-in sighting held for review
  // resolves to "mark late" (a genuine late arrival, flag status='late'),
  // "mark short leave" (the late arrival reflects a manager-approved short
  // leave earlier that day — accept the sighted time, flag
  // status='short_leave'), or "mark half-day" (no real check-in that day)
  // — same {late, short_leave, half_day} trio the office-staff exception
  // vocabulary uses (_CHECK_IN_DECISIONS in
  // support_db_attendance_exceptions.py). Same request/response shape, so
  // reuses the same helper.
  markHeldCheckInsLate: (localEventIds: string[]) =>
    resolveHeldCheckouts(
      "/api/held-attendance/mark-late-checkin",
      localEventIds,
    ),

  markHeldCheckInsShortLeave: (localEventIds: string[]) =>
    resolveHeldCheckouts(
      "/api/held-attendance/mark-short-leave-checkin",
      localEventIds,
    ),

  markHeldCheckInsHalfDay: (localEventIds: string[]) =>
    resolveHeldCheckouts(
      "/api/held-attendance/mark-half-day-checkin",
      localEventIds,
    ),

  restart: () =>
    requestJson<{ success: true; message: string }>("/api/restart", {
      method: "POST",
      body: JSON.stringify({}),
    }),

  importEmbeddings: async (file: File) => {
    const formData = new FormData();
    formData.append("package", file);

    const response = await fetch("/api/import-embeddings", {
      method: "POST",
      body: formData,
    });

    const body = await response.json().catch(() => null);

    if (!response.ok || body?.success === false) {
      throw new Error(
        body?.message || body?.error || `Import failed: ${response.status}`,
      );
    }

    return body as ImportEmbeddingsResult;
  },
};