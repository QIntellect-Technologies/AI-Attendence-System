/// <reference types="vite/client" />

/**
 * liveStreamApi.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Backend-only API layer for live attendance, live CCTV, cameras, detections,
 * profile photos, and live-tracking view models.
 *
 * Rules:
 * - No React import.
 * - No JSX.
 * - No component code.
 * - No mock data.
 * - No direct UI logic.
 */

export type CameraStatus = "Online" | "Normal" | "Alert" | "Offline";
export type LiveSourceStatus = "ready" | "loading" | "error";

export interface LiveCamera {
  id: string;
  branchId: number | string;
  backendBranchId?: string | null;
  branchName: string;
  name: string;
  cameraName: string;
  location: string;
  status: CameraStatus;
  lastSeen: string | null;

  /**
   * Backend MJPEG URL used directly in <img src>.
   * Example: /api/stream/cam_1_main
   */
  streamUrl: string;
  streamPath: string;

  /**
   * Optional only for legacy compatibility.
   * Production UI should not depend on RTSP URLs.
   */
  rtspUrl?: string | null;
}

export interface LiveDetection {
  key: string;
  name: string;
  confidence: number;
  timestamp: string | null;
  source: string | null;
  userId: string | number | null;
  department: string | null;
  cameraId: string | null;
  branchId: number | string | null;
  branchName: string | null;
  faceCrop?: string | null;
}

export interface LiveStats {
  enrolledCount: number | null;
  presentCount: number | null;
  totalLogs: number | null;
}

export interface LiveTrackingPerson {
  id: string;
  name: string;
  personType?: string | null;
  personCode?: string | null;
  employeeId?: string | null;
  location: string;
  cameraName: string;
  building: string;
  pose: string;
  lastSeen: string;
  timestamp?: string | null;
  detectedAt?: string | null;
  confidence?: number | null;
  status: "Active" | "Idle";
  duty: string;
  groupName?: string | null;
  subGroupName?: string | null;
  className?: string | null;
  sectionName?: string | null;
  department?: string | null;
  position?: string | null;
  designation?: string | null;
  branchId: number | string;
  backendBranchId?: string | null;
  branchName: string;
  cameraId: string;
  fallbackMarker?: boolean;
}

export type LiveTrackingEmployee = LiveTrackingPerson;

export interface LiveTrackingCamera {
  id: string;
  cameraName: string;
  location: string;
  branchId: number | string;
  branchName: string;
  /** "Unknown" = the camera has not reported recently enough to trust any
   *  of the fields below. Never collapse it into "Online": an unreported
   *  camera and an empty room are indistinguishable at the UI otherwise. */
  status: "Online" | "Alert" | "Offline" | "Unknown";
  /** null when there is no live detection feed for this camera, so the
   *  count is not a measurement and must not be rendered as one. */
  activeDetections: number | null;
  localNodeOffline?: boolean;
  lastHeartbeat?: string | null;
}

export interface LiveCCTVViewModel {
  employees: LiveTrackingPerson[];
  persons?: LiveTrackingPerson[];
  cameras: LiveTrackingCamera[];
  registeredCount: number;
  activeFeedCount: number;
  activeNowCount: number;
  sourceStatus: LiveSourceStatus;
  sourceLabel: string;
  localNodeStatus?: {
    online: boolean;
    lastHeartbeat?: string | null;
    thresholdSeconds?: number;
  };
}

interface RawStatsResponse {
  total_users?: number;
  total_staff?: number;
  enrolled_users?: number;
  today_attendance?: number;
  unique_users_today?: number;
  total_logs?: number;
}

interface RawCamera {
  organization_id?: string | number;
  organizationId?: string | number;
  org_id?: string | number;
  backend_branch_id?: string | null;
  backendBranchId?: string | null;
  id?: string;
  camera_id?: string;
  branch_id?: number | string;
  branchId?: number | string;
  branch_name?: string;
  branchName?: string;
  name?: string;
  camera_name?: string;
  cameraName?: string;
  location?: string;
  status?: string;
  last_seen?: string | null;
  lastSeen?: string | null;
  stream_url?: string;
  streamUrl?: string;
  stream_path?: string;
  streamPath?: string;
  rtsp_url?: string | null;
  rtspUrl?: string | null;
}

interface RawDetection {
  backend_branch_id?: string | null;
  backendBranchId?: string | null;
  name?: string;
  confidence?: number;
  timestamp?: string;
  source?: string;
  user_id?: number | string;
  userId?: number | string;
  department?: string;
  camera_id?: string;
  cameraId?: string;
  branch_id?: number | string;
  branchId?: number | string;
  branch_name?: string;
  branchName?: string;
  face_crop?: string;
  faceCrop?: string;
}

interface RawDetectionsResponse {
  detections?: RawDetection[];
}

export interface ScopeParams {
  organizationId?: number | string | null;
  branchId?: number | string | null;
  /**
   * Optional vertical people-type filter (e.g. "student", "staff"). Cameras
   * stay type-agnostic (hardware, not people) and never filter on this —
   * only detections, stats, and CCTV tracking data do.
   */
  peopleType?: string | null;
}

export interface DetectionParams extends ScopeParams {
  cameraIds?: string[];
}

const API_BASE = (
  (import.meta.env.VITE_API_BASE_URL as string | undefined) || "/api"
).replace(/\/$/, "");

// Same storage key as apiClient.ts's AUTH_TOKEN_STORAGE_KEY — deliberately
// duplicated as a plain string constant rather than imported, matching
// that file's own stated convention for keeping modules dependency-free of
// each other. If the key ever changes, it must change in both places —
// grep "dashboardAuthToken" before renaming either one.
const AUTH_TOKEN_STORAGE_KEY = "dashboardAuthToken";

function authHeaders(): HeadersInit {
  try {
    const token = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

function hasCameraIds(
  params?: ScopeParams | DetectionParams,
): params is DetectionParams & { cameraIds: string[] } {
  return (
    Array.isArray((params as DetectionParams | undefined)?.cameraIds) &&
    (params as DetectionParams).cameraIds!.length > 0
  );
}

function buildQuery(params?: ScopeParams | DetectionParams): string {
  const query = new URLSearchParams();

  if (params?.organizationId !== undefined && params.organizationId !== null) {
    query.set("organization_id", String(params.organizationId));
  }

  if (params?.branchId !== undefined && params.branchId !== null) {
    query.set("branch_id", String(params.branchId));
  }

  if (params?.peopleType) {
    query.set("people_type", params.peopleType);
  }

  if (hasCameraIds(params)) {
    query.set("camera_ids", params.cameraIds.join(","));
  }

  return query.toString();
}

async function requestJson<T>(
  path: string,
  signal?: AbortSignal,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  Object.entries(authHeaders()).forEach(([key, value]) => {
    headers.set(key, value as string);
  });

  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    signal,
    credentials: "same-origin",
    cache: "no-store",
    headers,
  });

  if (!response.ok) {
    throw new Error(
      `Live CCTV request failed: ${response.status} ${response.statusText}`,
    );
  }

  return response.json() as Promise<T>;
}

function toNumberOrString(value: unknown): number | string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;

  const text = String(value).trim();
  if (!text) return null;

  const numeric = Number(text);
  if (Number.isFinite(numeric) && String(numeric) === text) return numeric;

  return text;
}

function toUiBranchId(value: unknown): number | string {
  return toNumberOrString(value) ?? 0;
}

function isSupabaseLikeId(value: unknown): boolean {
  return typeof value === "string" && /[a-f0-9-]{16,}/i.test(value);
}

function normalizeStatus(value: string | undefined): CameraStatus {
  const raw = String(value ?? "Online").toLowerCase();

  if (raw.includes("offline")) return "Offline";
  if (raw.includes("alert")) return "Alert";
  if (raw.includes("normal")) return "Normal";

  return "Online";
}

function normalizeCamera(raw: RawCamera): LiveCamera {
  const id = String(raw.id ?? raw.camera_id ?? "");
  const branchId = toUiBranchId(raw.branchId ?? raw.branch_id ?? 0);
  const backendBranchId =
    raw.backendBranchId ??
    raw.backend_branch_id ??
    (isSupabaseLikeId(raw.branch_id)
      ? String(raw.branch_id)
      : typeof raw.branchId === "string" && isSupabaseLikeId(raw.branchId)
        ? String(raw.branchId)
        : null);

  const organizationId =
    raw.organizationId ?? raw.organization_id ?? raw.org_id;

  const generatedStreamPath = `/stream/${encodeURIComponent(id)}`;
  const streamPath = raw.streamPath ?? raw.stream_path ?? generatedStreamPath;
  const streamUrl = new URL(`${API_BASE}${streamPath}`, window.location.origin);

  if (organizationId !== undefined && organizationId !== null) {
    streamUrl.searchParams.set("organization_id", String(organizationId));
  }

  const backendStreamUrl =
    raw.streamUrl ??
    raw.stream_url ??
    `${streamUrl.pathname}${streamUrl.search}`;

  return {
    id,
    branchId,
    backendBranchId,
    branchName:
      raw.branchName ??
      raw.branch_name ??
      (branchId ? `Branch ${branchId}` : ""),
    name: raw.name ?? raw.cameraName ?? raw.camera_name ?? "Camera",
    cameraName: raw.cameraName ?? raw.camera_name ?? raw.name ?? "Camera",
    location: raw.location ?? "Unassigned",
    status: normalizeStatus(raw.status),
    lastSeen: raw.lastSeen ?? raw.last_seen ?? null,
    streamPath,
    streamUrl: backendStreamUrl,
    rtspUrl: raw.rtspUrl ?? raw.rtsp_url ?? null,
  };
}

function mapStats(raw: RawStatsResponse): LiveStats {
  return {
    enrolledCount: raw.enrolled_users ?? 0,
    presentCount: raw.unique_users_today ?? raw.today_attendance ?? 0,
    totalLogs: raw.total_logs ?? 0,
  };
}

function mapDetection(raw: RawDetection, index: number): LiveDetection {
  const userId = toNumberOrString(raw.userId ?? raw.user_id);
  const timestamp = raw.timestamp ?? null;
  const source = raw.source ?? null;
  const cameraId = raw.cameraId ?? raw.camera_id ?? null;
  const branchId = toNumberOrString(raw.branchId ?? raw.branch_id);

  const key =
    userId !== null && timestamp
      ? `${userId}_${timestamp}_${cameraId ?? source ?? index}`
      : `${raw.name ?? "unknown"}_${cameraId ?? source ?? "camera"}_${index}`;

  return {
    key,
    name: raw.name ?? "Unknown",
    confidence: Number(raw.confidence ?? 0),
    timestamp,
    source,
    userId,
    department: raw.department ?? null,
    cameraId,
    branchId,
    branchName: raw.branchName ?? raw.branch_name ?? null,
    faceCrop: raw.faceCrop ?? raw.face_crop ?? null,
  };
}

export async function fetchLiveCameras(
  params: ScopeParams,
  signal?: AbortSignal,
): Promise<LiveCamera[]> {
  const query = buildQuery(params);

  const raw = await requestJson<RawCamera[]>(
    `/cameras${query ? `?${query}` : ""}`,
    signal,
  );

  return raw.map(normalizeCamera).filter((camera) => camera.id);
}

export async function fetchLiveStats(
  params: ScopeParams = {},
  signal?: AbortSignal,
): Promise<LiveStats> {
  const query = buildQuery(params);

  const raw = await requestJson<RawStatsResponse>(
    `/stats${query ? `?${query}` : ""}`,
    signal,
  );

  return mapStats(raw);
}

export async function fetchLiveDetections(
  params: DetectionParams = {},
  signal?: AbortSignal,
): Promise<LiveDetection[]> {
  const query = buildQuery(params);

  const raw = await requestJson<RawDetectionsResponse>(
    `/live-detections${query ? `?${query}` : ""}`,
    signal,
  );

  return (raw.detections ?? []).map(mapDetection);
}

export async function fetchLiveCCTVTracking(
  params: ScopeParams,
  signal?: AbortSignal,
): Promise<LiveCCTVViewModel> {
  const query = buildQuery(params);

  return requestJson<LiveCCTVViewModel>(
    `/cctv/live-tracking${query ? `?${query}` : ""}`,
    signal,
  );
}

export async function initAiEngine(signal?: AbortSignal): Promise<void> {
  await requestJson<{ status: string }>("/init", signal, {
    method: "POST",
  });
}

export function getCameraStreamUrl(camera: LiveCamera): string {
  return (
    camera.streamUrl || `${API_BASE}/stream/${encodeURIComponent(camera.id)}`
  );
}

/**
 * Mints a short-lived (~60s) stream_token for one camera via an
 * authenticated fetch — the Bearer header this call sends is the only
 * proof-of-org-membership the backend accepts for that camera, since the
 * <img> tag that actually opens the MJPEG connection can't send one
 * itself. Call this immediately before first setting img.src, and again
 * periodically (~45s) to keep a fresh token on hand in case the browser
 * needs to reopen the connection (e.g. after a network blip).
 *
 * Throws on failure (404 = camera not in this org, 401 = session expired)
 * — callers should treat that the same as any other stream error rather
 * than silently leaving the tile on a stale/missing token.
 */
export async function fetchStreamToken(
  cameraId: string,
  signal?: AbortSignal,
): Promise<string> {
  const raw = await requestJson<{ success: boolean; stream_token: string }>(
    "/stream/token",
    signal,
    {
      method: "POST",
      body: JSON.stringify({ camera_id: cameraId }),
    },
  );
  return raw.stream_token;
}

/**
 * Builds the <img>-ready URL for a camera tile, given a freshly minted
 * stream_token. Distinct from getCameraStreamUrl (which returns the bare
 * path/URL with no token) so callers can't accidentally point an <img> at
 * the stream without one — GET /api/stream/<camera_id> 401s without a
 * valid stream_token query param.
 */
export function getAuthenticatedStreamUrl(
  camera: LiveCamera,
  streamToken: string,
): string {
  const base = getCameraStreamUrl(camera);
  const joiner = base.includes("?") ? "&" : "?";
  return `${base}${joiner}stream_token=${encodeURIComponent(streamToken)}`;
}

export function getUserPhotoUrl(userId: number | string): string;
export function getUserPhotoUrl(userId: null | undefined): undefined;
export function getUserPhotoUrl(
  userId: number | string | null | undefined,
): string | undefined {
  if (userId == null) return undefined;
  return `${API_BASE}/users/${encodeURIComponent(String(userId))}/photo`;
}

export const profilePhotoUrl = getUserPhotoUrl;

/**
 * Backward-compatible aliases for older imports.
 */
function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    "addEventListener" in value
  );
}

/**
 * Backward-compatible typed wrappers.
 *
 * Supported:
 *   getLiveStats(signal)
 *   getLiveStats(params, signal)
 */
export function getLiveStats(signal?: AbortSignal): Promise<LiveStats>;
export function getLiveStats(
  params?: ScopeParams,
  signal?: AbortSignal,
): Promise<LiveStats>;
export function getLiveStats(
  first?: ScopeParams | AbortSignal,
  second?: AbortSignal,
): Promise<LiveStats> {
  if (isAbortSignal(first)) {
    return fetchLiveStats({}, first);
  }

  return fetchLiveStats(first ?? {}, second);
}

/**
 * Supported:
 *   getLiveDetections(signal)
 *   getLiveDetections(params, signal)
 */
export function getLiveDetections(
  signal?: AbortSignal,
): Promise<LiveDetection[]>;
export function getLiveDetections(
  params?: DetectionParams,
  signal?: AbortSignal,
): Promise<LiveDetection[]>;
export function getLiveDetections(
  first?: DetectionParams | AbortSignal,
  second?: AbortSignal,
): Promise<LiveDetection[]> {
  if (isAbortSignal(first)) {
    return fetchLiveDetections({}, first);
  }

  return fetchLiveDetections(first ?? {}, second);
}
