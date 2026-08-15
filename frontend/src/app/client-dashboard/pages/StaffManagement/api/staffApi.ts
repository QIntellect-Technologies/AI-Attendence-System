// /**
//  * modules/staff/api/staffApi.ts
//  * ─────────────────────────────────────────────────────────────────────────────
//  * Staff-specific API client.
//  *
//  * StaffDirectory and staff hooks should use this file instead of importing
//  * generic user CRUD methods from src/api.ts. The generic file can keep shared
//  * endpoints such as retention policy, salary, attendance, etc.
//  *
//  * ── Row-scope note ──────────────────────────────────────────────────────
//  * organization_id/branch_id/user_id below are still sent as query params —
//  * kept for backwards compatibility with routes that haven't been wrapped
//  * in @require_client_dashboard_auth yet, and because they're still useful
//  * as a *display* filter (e.g. "show branch X's roster") even for a
//  * server-trusted caller. They are NOT what makes a 'team'-scoped manager
//  * only see their reports — that's enforced server-side, from the Bearer
//  * token below, and cannot be widened by editing these params. Treat
//  * anything sent here as advisory, never as the security boundary.
//  */

// import { BASE_URL, type User } from "../../../api/api";
// import { handleSessionExpired } from "../../../api/sessionExpired";

// const AUTH_TOKEN_STORAGE_KEY = "dashboardAuthToken";

// export function getDashboardAuthToken(): string | null {
//   try {
//     return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
//   } catch {
//     return null;
//   }
// }

// export function setDashboardAuthToken(token: string | null): void {
//   try {
//     if (token) {
//       localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
//     } else {
//       localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
//     }
//   } catch {
//     // Ignore storage access errors (private browsing, quota, etc.) —
//     // requests will simply go out unauthenticated and the backend will
//     // 401, same failure mode as today for a missing/expired session.
//   }
// }

// function authHeaders(): HeadersInit {
//   const token = getDashboardAuthToken();
//   return token ? { Authorization: `Bearer ${token}` } : {};
// }

// async function staffJson<T>(path: string, options?: RequestInit): Promise<T> {
//   const res = await fetch(`${BASE_URL}${path}`, {
//     cache: "no-store",
//     credentials: "same-origin",
//     headers: {
//       "Content-Type": "application/json",
//       Accept: "application/json",
//       ...authHeaders(),
//       ...(options?.headers || {}),
//     },
//     ...options,
//   });

//   if (res.status === 401) {
//     // Session expired or missing — surface a distinct, catchable error so
//     // callers (e.g. StaffManagement) can redirect to /login instead of
//     // rendering a generic "failed to load" state for what is actually an
//     // auth problem.
//     let message = "Session expired. Please log in again.";
//     try {
//       const body = await res.json();
//       message = body.error ?? body.message ?? message;
//     } catch {
//       // Ignore non-JSON error bodies.
//     }
//     handleSessionExpired(message);
//     const err = new Error(message) as Error & { isAuthError?: boolean };
//     err.isAuthError = true;
//     throw err;
//   }

//   if (!res.ok) {
//     let message = res.statusText;

//     try {
//       const body = await res.json();
//       message = body.error ?? body.message ?? message;
//     } catch {
//       // Ignore non-JSON error bodies.
//     }

//     throw new Error(message);
//   }

//   return res.json() as Promise<T>;
// }

// function hasTenantId(value: unknown): boolean {
//   return (
//     value !== undefined && value !== null && String(value).trim().length > 0
//   );
// }

// async function staffForm<T>(path: string, formData: FormData): Promise<T> {
//   const res = await fetch(`${BASE_URL}${path}`, {
//     method: "POST",
//     credentials: "same-origin",
//     cache: "no-store",
//     headers: { ...authHeaders() },
//     body: formData,
//   });

//   if (res.status === 401) {
//     const message = "Session expired. Please log in again.";
//     handleSessionExpired(message);
//     const err = new Error(message) as Error & {
//       isAuthError?: boolean;
//     };
//     err.isAuthError = true;
//     throw err;
//   }

//   if (!res.ok) {
//     let message = res.statusText;

//     try {
//       const body = await res.json();
//       message = body.error ?? body.message ?? message;
//     } catch {
//       // Ignore non-JSON error bodies.
//     }

//     throw new Error(message);
//   }

//   return res.json() as Promise<T>;
// }

// export type StaffStatus = "active" | "inactive" | "pending";
// export type StaffWorkType = "office" | "field";

// export interface StaffListParams {
//   /**
//    * Account/access role. Keep this database-safe (for example: staff/admin/hr).
//    * Business template identity such as student/worker/teacher belongs in
//    * peopleType/people_type, not in role.
//    */
//   role?: "staff" | "admin" | string | null;
//   /** Business/template people scope: student, teacher, staff, worker, etc. */
//   peopleType?: string | null;
//   /** Snake-case alias accepted by backend and older call sites. */
//   people_type?: string | null;
//   /** Generic aliases for future person-based modules. */
//   personType?: string | null;
//   person_type?: string | null;
//   organizationId?: number | string | null;
//   branchId?: number | string | null;
//   userId?: number | string | null;
//   status?: StaffStatus | "all" | string | null;
//   department?: string | null;
//   designation?: string | null;
// }

// export type StaffPayload = Partial<User> & {
//   password?: string;
//   created_by_user_id?: number | string | null;

//   organization_id?: number | string | null;
//   organizationId?: number | string | null;
//   org_id?: number | string | null;
//   branch_id?: number | string | null;
//   branch_ui_id?: number | null;
//   backend_branch_id?: number | string | null;
//   branch_name?: string | null;

//   account_role?: string | null;
//   peopleType?: string | null;
//   people_type?: string | null;
//   personType?: string | null;
//   person_type?: string | null;

//   employee_id?: string | null;
//   person_code?: string | null;
//   personCode?: string | null;
//   registration_number?: string | null;
//   registrationNumber?: string | null;
//   employee_number?: string | null;
//   employeeNumber?: string | null;
//   worker_id?: string | null;
//   workerId?: string | null;
//   teacher_code?: string | null;
//   teacherCode?: string | null;
//   status?: StaffStatus;
//   benefits?: string[];

//   shift_id?: string | null;
//   shift_label?: string | null;

//   /**
//    * Field-staff attendance geofence — a single "static location" site
//    * (lat/lng + radius) this person is checked in against. This is the
//    * first, simplest scenario of the open/dynamic field-attendance model;
//    * visiting-plan and route scenarios are additive layers on top of this
//    * per-staff record, not a replacement for it (someone can have a base
//    * geofence AND a visit plan).
//    */
//   geofence_lat?: number | null;
//   geofenceLat?: number | null;
//   geofence_lng?: number | null;
//   geofenceLng?: number | null;
//   /** Meters. Falls back to a sane server default (e.g. 100m) if omitted. */
//   geofence_radius_meters?: number | null;
//   geofenceRadiusMeters?: number | null;
//   /** Human label shown to the employee before they punch in, e.g.
//    * "Sheikh Zaid Hospital". Purely descriptive — the check itself uses
//    * lat/lng/radius. */
//   geofence_label?: string | null;
//   geofenceLabel?: string | null;

//   /**
//    * Office-staff WiFi attendance config — per-organization/branch/staff,
//    * replacing the old app-side hardcoded SSID/BSSID constants. A branch
//    * can have multiple access points (mesh) broadcasting the same SSID,
//    * so BSSIDs are a list, not a single value.
//    */
//   office_ssid?: string | null;
//   officeSsid?: string | null;
//   office_bssid_list?: string[] | null;
//   officeBssidList?: string[] | null;

//   /** 'branch' (see everything in scope, today's default) | 'team' (see
//    * only self + direct/indirect reports). Only meaningful for staff rows
//    * that are themselves given dashboard access (a manager logging into
//    * the desktop dashboard under their "Manager" hat) — irrelevant for
//    * client_users (admin/HR) accounts, which are always branch/org-wide. */
//   dashboard_scope?: "branch" | "team" | null;
//   dashboardScope?: "branch" | "team" | null;

//   profile_image_url?: string | null;
//   profile_image_name?: string | null;

//   /**
//    * Identity documents. cnic is required for every non-student people
//    * type; father_name/father_cnic/father_phone are required for students
//    * instead (guardian details, not the student's own CNIC).
//    */
//   cnic?: string | null;
//   father_name?: string | null;
//   fatherName?: string | null;
//   father_cnic?: string | null;
//   fatherCnic?: string | null;
//   father_phone?: string | null;
//   fatherPhone?: string | null;
// };

// export interface StaffMutationResponse {
//   success: boolean;
//   message?: string;
//   user: User;
//   credentials?: {
//     email: string;
//     password: string;
//   };
// }

// export interface StaffArchiveOptions {
//   retentionYears?: number | null;
//   reason?: string;
//   archivedBy?: number | string | null;
//   organizationId?: number | string | null;
// }

// export interface StaffArchiveResponse {
//   success: boolean;
//   message: string;
//   archive: {
//     user_id: number | string;
//     name: string;
//     organization_id: number | string | null;
//     retention_years: number;
//     deleted_embeddings: number;
//     deleted_at: string | null;
//     retention_until: string | null;
//   };
// }

// export interface StaffPermanentDeleteResponse {
//   success: boolean;
//   message: string;
//   deleted_user_id?: number | string;
//   deleted_user_ids?: Array<number | string>;
//   skipped_user_ids?: Array<number | string>;
//   deleted_count?: number;
// }

// export interface StaffMediaUploadError {
//   phase: "photo" | "media-sync";
//   message: string;
// }

// export interface StaffPhotoUploadResponse {
//   success: boolean;
//   photo_url?: string;
//   profile_image_url?: string;
//   profileImageUrl?: string;
//   profile_image_name?: string;
//   profileImageName?: string;
// }

// export const staffProfilePhotoUrl = (userId: number | string) =>
//   `${BASE_URL}/api/staff/${encodeURIComponent(String(userId))}/photo`;

// export interface StaffPageResponse {
//   success: boolean;
//   cached?: boolean;
//   entity?: string;
//   rows: User[];
//   total: number;
//   page: number;
//   pageSize: number;
//   offset?: number;
//   hasMore?: boolean;
//   /** Echoed back by a team-scoped backend so the UI can show "Showing
//    * your team (N)" vs "Showing branch (N)" without re-deriving it from
//    * the stored user object. Absent on routes not yet scope-aware. */
//   dashboardScope?: "branch" | "team";
// }

// export interface StaffPageParams extends StaffListParams {
//   page?: number;
//   pageSize?: number;
//   search?: string;
//   sortBy?: string;
//   sortDir?: "asc" | "desc";
// }

// export async function listStaffPage(
//   params: StaffPageParams,
// ): Promise<StaffPageResponse> {
//   if (!hasTenantId(params?.organizationId)) {
//     throw new Error("organization_id is required to load staff records.");
//   }

//   const qs = new URLSearchParams();
//   qs.set("orgId", String(params.organizationId));
//   qs.set("page", String(Math.max(1, Number(params.page || 1))));
//   qs.set(
//     "pageSize",
//     String(Math.max(1, Math.min(250, Number(params.pageSize || 50)))),
//   );

//   if (hasTenantId(params.branchId)) qs.set("branchId", String(params.branchId));
//   if (params.search && params.search.trim())
//     qs.set("search", params.search.trim());
//   if (params.sortBy) qs.set("sortBy", params.sortBy);
//   if (params.sortDir) qs.set("sortDir", params.sortDir);

//   const peopleType =
//     params.peopleType ??
//     params.people_type ??
//     params.personType ??
//     params.person_type;
//   if (peopleType && String(peopleType).trim()) {
//     qs.set("people_type", String(peopleType).trim());
//   }

//   if (params.role && String(params.role).trim()) {
//     qs.set("role", String(params.role).trim());
//   }

//   if (params.status && params.status !== "all") {
//     qs.set("status", String(params.status));
//   }

//   if (params.department && params.department !== "all") {
//     qs.set("department", String(params.department));
//   }

//   if (params.designation && params.designation !== "all") {
//     qs.set("designation", String(params.designation));
//   }

//   const body = await staffJson<StaffPageResponse>(
//     `/api/v2/staff/page?${qs.toString()}`,
//     {
//       method: "GET",
//     },
//   );

//   return {
//     success: body.success !== false,
//     cached: body.cached,
//     entity: body.entity,
//     rows: Array.isArray(body.rows) ? body.rows : [],
//     total: Number(body.total || 0),
//     page: Number(body.page || params.page || 1),
//     pageSize: Number(body.pageSize || params.pageSize || 50),
//     offset: Number(body.offset || 0),
//     hasMore: Boolean(body.hasMore),
//     dashboardScope: body.dashboardScope,
//   };
// }

// export async function listStaffRecords(params?: StaffListParams) {
//   if (!hasTenantId(params?.organizationId)) {
//     throw new Error("organization_id is required to load staff records.");
//   }

//   const qs = new URLSearchParams();

//   if (params?.role) qs.set("role", params.role);

//   if (
//     params?.organizationId !== undefined &&
//     params.organizationId !== null &&
//     String(params.organizationId).trim()
//   ) {
//     qs.set("organization_id", String(params.organizationId));
//   }

//   if (
//     params?.branchId !== undefined &&
//     params.branchId !== null &&
//     String(params.branchId).trim()
//   ) {
//     qs.set("branch_id", String(params.branchId));
//   }

//   if (
//     params?.userId !== undefined &&
//     params.userId !== null &&
//     String(params.userId).trim()
//   ) {
//     qs.set("user_id", String(params.userId));
//   }

//   return staffJson<User[]>(`/api/staff${qs.toString() ? `?${qs}` : ""}`);
// }

// export async function getStaffRecord(userId: number | string) {
//   return staffJson<User>(`/api/staff/${encodeURIComponent(String(userId))}`);
// }

// export async function createStaffRecord(payload: StaffPayload) {
//   if (
//     !hasTenantId(
//       payload.organization_id ?? payload.organizationId ?? payload.org_id,
//     )
//   ) {
//     throw new Error("organization_id is required to create staff records.");
//   }

//   return staffJson<StaffMutationResponse>("/api/staff", {
//     method: "POST",
//     body: JSON.stringify(payload),
//   });
// }

// export async function updateStaffRecord(
//   userId: number | string,
//   payload: StaffPayload,
// ) {
//   return staffJson<StaffMutationResponse>(
//     `/api/staff/${encodeURIComponent(String(userId))}`,
//     {
//       method: "PUT",
//       body: JSON.stringify(payload),
//     },
//   );
// }

// /**
//  * Sets a staff member's dashboard row-scope: 'branch' (sees everything in
//  * their branch/org, today's default) or 'team' (sees only themself + their
//  * reporting chain). Separate endpoint from updateStaffRecord rather than a
//  * field on the general PATCH, so flipping scope is an explicit,
//  * individually-auditable action — not something that can slip through as
//  * a side effect of an unrelated profile edit.
//  */
// export async function setStaffDashboardScope(
//   userId: number | string,
//   organizationId: number | string,
//   scope: "branch" | "team",
// ) {
//   return staffJson<StaffMutationResponse>(
//     `/api/staff/${encodeURIComponent(String(userId))}/dashboard-scope`,
//     {
//       method: "PATCH",
//       body: JSON.stringify({
//         organization_id: organizationId,
//         dashboard_scope: scope,
//       }),
//     },
//   );
// }

// /**
//  * One level of direct reports (everyone whose manager_id points at
//  * `userId`) — used to decide whether a 'branch'-scoped dashboard session
//  * is eligible to see the "My Team" toggle at all (a manager with zero
//  * reports has nothing to narrow to). Mirrors
//  * client_staff_hierarchy_routes.py's GET /staff/<id>/reports exactly;
//  * does not affect what the dashboard overview endpoint itself returns —
//  * that's still gated server-side by get_effective_scope_ids off the
//  * verified token, this call is purely for the UI's "should I show the
//  * toggle" decision.
//  */
// export async function getStaffDirectReports(
//   userId: number | string,
//   organizationId: number | string,
// ): Promise<{ success: boolean; reports: Array<Record<string, unknown>> }> {
//   return staffJson<{
//     success: boolean;
//     reports: Array<Record<string, unknown>>;
//   }>(
//     `/api/client/staff/${encodeURIComponent(String(userId))}/reports?organization_id=${encodeURIComponent(String(organizationId))}`,
//   );
// }

// export async function archiveStaffRecord(
//   userId: number | string,
//   payload: {
//     reason?: string;
//     archivedBy?: number | string | null;
//     retentionYears?: number | null;
//     organizationId?: number | string | null;
//   } = {},
// ): Promise<StaffArchiveResponse> {
//   return staffJson<StaffArchiveResponse>(
//     `/api/staff/${encodeURIComponent(String(userId))}`,
//     {
//       method: "DELETE",
//       body: JSON.stringify({
//         reason: payload.reason ?? "Archived from Staff Management",
//         archived_by: payload.archivedBy ?? null,
//         retention_years: payload.retentionYears ?? null,
//         organization_id: payload.organizationId ?? null,
//       }),
//     },
//   );
// }

// export async function uploadStaffPhoto(userId: number | string, file: File) {
//   const fd = new FormData();
//   fd.append("photo", file);

//   return staffForm<StaffPhotoUploadResponse>(
//     `/api/staff/${encodeURIComponent(String(userId))}/photo`,
//     fd,
//   );
// }

// export async function getArchivedStaffRecords(params?: {
//   organizationId?: number | string | null;
//   branchId?: number | string | null;
//   peopleType?: string | null;
// }) {
//   if (!hasTenantId(params?.organizationId)) {
//     throw new Error(
//       "organization_id is required to load archived staff records.",
//     );
//   }

//   const query = new URLSearchParams();

//   if (params?.organizationId != null) {
//     query.set("organization_id", String(params.organizationId));
//   }

//   if (params?.branchId != null) {
//     query.set("branch_id", String(params.branchId));
//   }

//   if (params?.peopleType && String(params.peopleType).trim()) {
//     query.set("people_type", String(params.peopleType).trim());
//   }

//   const path = query.toString()
//     ? `/api/staff/archived?${query.toString()}`
//     : "/api/staff/archived";

//   return staffJson<User[]>(path, { method: "GET" });
// }

// export async function restoreStaffRecord(
//   userId: number | string,
//   payload: {
//     organizationId?: number | string | null;
//     restoredBy?: number | string | null;
//   } = {},
// ) {
//   return staffJson<{
//     success: boolean;
//     message: string;
//     restore?: unknown;
//     user?: User;
//   }>(`/api/staff/${encodeURIComponent(String(userId))}/restore`, {
//     method: "POST",
//     body: JSON.stringify({
//       organization_id: payload.organizationId ?? null,
//       restored_by: payload.restoredBy ?? null,
//     }),
//   });
// }

// export async function deleteArchivedStaffRecord(
//   userId: number | string,
//   payload: {
//     organizationId?: number | string | null;
//     deletedBy?: number | string | null;
//   } = {},
// ): Promise<StaffPermanentDeleteResponse> {
//   return staffJson<StaffPermanentDeleteResponse>(
//     `/api/staff/archived/${encodeURIComponent(String(userId))}/delete`,
//     {
//       method: "POST",
//       body: JSON.stringify({
//         organization_id: payload.organizationId ?? null,
//         deleted_by: payload.deletedBy ?? null,
//       }),
//     },
//   );
// }

// // ─── Visit Plans (Scenario 2 — admin side) ─────────────────────────────────
// // Mirrors client_visit_plans_routes.py exactly. Same underlying
// // visit_plans/visit_plan_stops/visits tables the mobile self-service
// // endpoints (client_field_visits_routes.py) use — an admin-created stop and
// // an employee-created one are indistinguishable in storage except for
// // created_by_role. Raw shape only, no server-computed status/summary — see
// // support_db_visits.get_plan_raw's docstring; compliance (completed/
// // pending/unplanned counts) is computed here on the client, the same way
// // visit_plan_service.dart computes it on-device for the mobile app. Keep
// // computeVisitPlanSummary below in sync with that file if the shape of a
// // stop/visit ever changes.

// export interface VisitPlanRecord {
//   id: string;
//   org_id: string;
//   branch_id?: string | null;
//   staff_id: string;
//   plan_date: string;
//   origin: "admin" | "self";
//   created_by?: string | null;
//   created_by_role?: string | null;
// }

// export interface VisitPlanStopRecord {
//   id: string;
//   plan_id: string;
//   location_label: string;
//   lat: number;
//   lng: number;
//   radius_meters: number;
//   purpose?: string | null;
//   window_start?: string | null;
//   window_end?: string | null;
//   display_order?: number;
//   created_by_role?: string | null;
//   is_deleted?: boolean;
// }

// export interface VisitRecord {
//   id: string;
//   org_id: string;
//   staff_id: string;
//   plan_stop_id?: string | null;
//   latitude: number;
//   longitude: number;
//   distance_from_stop_meters?: number | null;
//   /** Server-computed (log_visit), NOT client-submitted -- distance from
//    * the stop's real lat/lng to the GPS fix at log time, and whether that
//    * fell within the stop's radius_meters. Null on unplanned visits and on
//    * rows logged before this field existed. This -- not
//    * distance_from_stop_meters -- is what compliance display should
//    * trust; distance_from_stop_meters is on-device and unverified. */
//   server_distance_meters?: number | null;
//   verified_inside_geofence?: boolean | null;
//   photo_url?: string | null;
//   note?: string | null;
//   evidence_mode_recorded?: string;
//   source?: string;
//   timestamp?: string;
// }

// export interface VisitPlanRaw {
//   plan: VisitPlanRecord | null;
//   stops: VisitPlanStopRecord[];
//   visits: VisitRecord[];
// }

// export interface VisitPlanSummary {
//   plannedTotal: number;
//   completed: number;
//   pending: number;
//   unplanned: number;
//   /** Stops with a logged visit that the server verified was OUTSIDE the
//    * stop's geofence at log time. Counted within `completed` (a visit was
//    * logged) but broken out separately so admins can see it needs review. */
//   outOfRange: number;
// }

// /** Maps each stop to its visit (if any) and whether that visit was
//  * server-verified inside the stop's geofence. Mirrors
//  * visit_plan_service.dart's computeStopStatuses. */
// export function computeStopVerification(
//   stops: VisitPlanStopRecord[],
//   visits: VisitRecord[],
// ): Map<string, { visit: VisitRecord; outOfRange: boolean }> {
//   const visitByStopId = new Map<string, VisitRecord>();
//   for (const v of visits) {
//     if (v.plan_stop_id) visitByStopId.set(String(v.plan_stop_id), v);
//   }
//   const result = new Map<string, { visit: VisitRecord; outOfRange: boolean }>();
//   for (const s of stops) {
//     const visit = visitByStopId.get(String(s.id));
//     if (!visit) continue;
//     // verified_inside_geofence === false is an explicit server verdict.
//     // null/undefined (unplanned visits, or rows logged before this field
//     // existed) is treated as "not flagged" -- no regression on old data.
//     result.set(String(s.id), {
//       visit,
//       outOfRange: visit.verified_inside_geofence === false,
//     });
//   }
//   return result;
// }

// /** Pure client-side diff — mirrors visit_plan_service.dart's
//  * computeStopStatuses/computeSummary so the dashboard and the mobile app
//  * never disagree about what "6 of 8 completed" means. Completion is keyed
//  * off a visit existing for the stop (same as before); outOfRange is a new,
//  * separate signal read from verified_inside_geofence -- the server-computed
//  * field, not the client-submitted distance_from_stop_meters -- so a
//  * spoofed/out-of-range check-in still counts as "logged" but is flagged
//  * for review instead of silently showing as a clean green completion. */
// export function computeVisitPlanSummary(
//   stops: VisitPlanStopRecord[],
//   visits: VisitRecord[],
// ): VisitPlanSummary {
//   const verification = computeStopVerification(stops, visits);
//   const completedStopIds = new Set(
//     visits.filter((v) => v.plan_stop_id).map((v) => String(v.plan_stop_id)),
//   );
//   const completed = stops.filter((s) =>
//     completedStopIds.has(String(s.id)),
//   ).length;
//   const outOfRange = stops.filter(
//     (s) => verification.get(String(s.id))?.outOfRange,
//   ).length;
//   const unplanned = visits.filter((v) => !v.plan_stop_id).length;
//   return {
//     plannedTotal: stops.length,
//     completed,
//     pending: stops.length - completed,
//     unplanned,
//     outOfRange,
//   };
// }

// export interface VisitPlanDay {
//   date: string;
//   plan: VisitPlanRecord | null;
//   stops: VisitPlanStopRecord[];
//   visits: VisitRecord[];
// }

// export async function getStaffVisitPlan(
//   staffId: string,
//   organizationId: number | string,
//   planDate: string,
// ): Promise<VisitPlanRaw> {
//   const qs = new URLSearchParams({
//     organization_id: String(organizationId),
//     date: planDate,
//   });
//   return staffJson<VisitPlanRaw>(
//     `/api/client/staff/${encodeURIComponent(staffId)}/visit-plan?${qs.toString()}`,
//   );
// }

// /** Admin dashboard History view — one call for a whole month, each entry
//  * shaped like getStaffVisitPlan's response so computeVisitPlanSummary/
//  * computeStopVerification run unmodified per day. Mirrors the mobile
//  * app's ApiService.getVisitPlansHistory. */
// export async function getStaffVisitPlansHistory(
//   staffId: string,
//   organizationId: number | string,
//   opts: { month?: string; startDate?: string; endDate?: string } = {},
// ): Promise<VisitPlanDay[]> {
//   const qs = new URLSearchParams({ organization_id: String(organizationId) });
//   if (opts.month) qs.set("month", opts.month);
//   if (opts.startDate) qs.set("start_date", opts.startDate);
//   if (opts.endDate) qs.set("end_date", opts.endDate);
//   const result = await staffJson<{ days: VisitPlanDay[] }>(
//     `/api/client/staff/${encodeURIComponent(staffId)}/visit-plans-history?${qs.toString()}`,
//   );
//   return result.days ?? [];
// }

// export async function createStaffVisitPlan(
//   staffId: string,
//   payload: {
//     organizationId: number | string;
//     branchId?: number | string | null;
//     date: string;
//     createdBy?: string | null;
//   },
// ): Promise<{ plan: VisitPlanRecord }> {
//   if (!hasTenantId(payload.organizationId)) {
//     throw new Error("organization_id is required to create a visit plan.");
//   }
//   return staffJson<{ plan: VisitPlanRecord }>(
//     `/api/client/staff/${encodeURIComponent(staffId)}/visit-plan`,
//     {
//       method: "POST",
//       body: JSON.stringify({
//         organization_id: payload.organizationId,
//         branch_id: payload.branchId ?? null,
//         date: payload.date,
//         created_by: payload.createdBy ?? null,
//       }),
//     },
//   );
// }

// export async function listBranchVisitPlans(
//   branchId: number | string,
//   organizationId: number | string,
//   planDate: string,
// ): Promise<{ plans: VisitPlanRecord[] }> {
//   const qs = new URLSearchParams({
//     organization_id: String(organizationId),
//     date: planDate,
//   });
//   return staffJson<{ plans: VisitPlanRecord[] }>(
//     `/api/client/branches/${encodeURIComponent(String(branchId))}/visit-plans?${qs.toString()}`,
//   );
// }

// export interface VisitPlanStopPayload {
//   organizationId: number | string;
//   createdBy?: string | null;
//   locationLabel: string;
//   lat: number;
//   lng: number;
//   radiusMeters?: number;
//   purpose?: string;
//   windowStart?: string | null;
//   windowEnd?: string | null;
//   displayOrder?: number;
// }

// export async function addVisitPlanStop(
//   planId: string,
//   payload: VisitPlanStopPayload,
// ): Promise<{ stop: VisitPlanStopRecord }> {
//   if (!hasTenantId(payload.organizationId)) {
//     throw new Error("organization_id is required to add a stop.");
//   }
//   return staffJson<{ stop: VisitPlanStopRecord }>(
//     `/api/client/visit-plans/${encodeURIComponent(planId)}/stops`,
//     {
//       method: "POST",
//       body: JSON.stringify({
//         organization_id: payload.organizationId,
//         created_by: payload.createdBy ?? null,
//         location_label: payload.locationLabel,
//         lat: payload.lat,
//         lng: payload.lng,
//         radius_meters: payload.radiusMeters ?? 150,
//         purpose: payload.purpose ?? null,
//         window_start: payload.windowStart ?? null,
//         window_end: payload.windowEnd ?? null,
//         display_order: payload.displayOrder ?? 0,
//       }),
//     },
//   );
// }

// export async function updateVisitPlanStop(
//   stopId: string,
//   organizationId: number | string,
//   patch: Partial<{
//     locationLabel: string;
//     lat: number;
//     lng: number;
//     radiusMeters: number;
//     purpose: string;
//     windowStart: string | null;
//     windowEnd: string | null;
//     displayOrder: number;
//   }>,
// ): Promise<{ stop: VisitPlanStopRecord }> {
//   const body: Record<string, unknown> = { organization_id: organizationId };
//   if (patch.locationLabel !== undefined)
//     body.location_label = patch.locationLabel;
//   if (patch.lat !== undefined) body.lat = patch.lat;
//   if (patch.lng !== undefined) body.lng = patch.lng;
//   if (patch.radiusMeters !== undefined) body.radius_meters = patch.radiusMeters;
//   if (patch.purpose !== undefined) body.purpose = patch.purpose;
//   if (patch.windowStart !== undefined) body.window_start = patch.windowStart;
//   if (patch.windowEnd !== undefined) body.window_end = patch.windowEnd;
//   if (patch.displayOrder !== undefined) body.display_order = patch.displayOrder;

//   return staffJson<{ stop: VisitPlanStopRecord }>(
//     `/api/client/visit-plan-stops/${encodeURIComponent(stopId)}`,
//     { method: "PATCH", body: JSON.stringify(body) },
//   );
// }

// export async function deleteVisitPlanStop(
//   stopId: string,
//   organizationId: number | string,
// ): Promise<{ deleted: boolean }> {
//   return staffJson<{ deleted: boolean }>(
//     `/api/client/visit-plan-stops/${encodeURIComponent(stopId)}`,
//     {
//       method: "DELETE",
//       body: JSON.stringify({ organization_id: organizationId }),
//     },
//   );
// }

// export async function bulkDeleteArchivedStaffRecords(
//   userIds: Array<number | string>,
//   payload: {
//     organizationId?: number | string | null;
//     deletedBy?: number | string | null;
//   } = {},
// ): Promise<StaffPermanentDeleteResponse> {
//   return staffJson<StaffPermanentDeleteResponse>(
//     "/api/staff/archived/bulk-delete",
//     {
//       method: "POST",
//       body: JSON.stringify({
//         user_ids: userIds.map((id) => String(id)).filter(Boolean),
//         organization_id: payload.organizationId ?? null,
//         deleted_by: payload.deletedBy ?? null,
//       }),
//     },
//   );
// }

/**
 * modules/staff/api/staffApi.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Staff-specific API client.
 *
 * StaffDirectory and staff hooks should use this file instead of importing
 * generic user CRUD methods from src/api.ts. The generic file can keep shared
 * endpoints such as retention policy, salary, attendance, etc.
 *
 * ── Row-scope note ──────────────────────────────────────────────────────
 * organization_id/branch_id/user_id below are still sent as query params —
 * kept for backwards compatibility with routes that haven't been wrapped
 * in @require_client_dashboard_auth yet, and because they're still useful
 * as a *display* filter (e.g. "show branch X's roster") even for a
 * server-trusted caller. They are NOT what makes a 'team'-scoped manager
 * only see their reports — that's enforced server-side, from the Bearer
 * token below, and cannot be widened by editing these params. Treat
 * anything sent here as advisory, never as the security boundary.
 */

import { BASE_URL, type User } from "../../../api/api";
import { handleSessionExpired } from "../../../api/sessionExpired";

const AUTH_TOKEN_STORAGE_KEY = "dashboardAuthToken";

export function getDashboardAuthToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setDashboardAuthToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage access errors (private browsing, quota, etc.) —
    // requests will simply go out unauthenticated and the backend will
    // 401, same failure mode as today for a missing/expired session.
  }
}

function authHeaders(): HeadersInit {
  const token = getDashboardAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function staffJson<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...authHeaders(),
      ...(options?.headers || {}),
    },
    ...options,
  });

  if (res.status === 401) {
    // Session expired or missing — surface a distinct, catchable error so
    // callers (e.g. StaffManagement) can redirect to /login instead of
    // rendering a generic "failed to load" state for what is actually an
    // auth problem.
    let message = "Session expired. Please log in again.";
    try {
      const body = await res.json();
      message = body.error ?? body.message ?? message;
    } catch {
      // Ignore non-JSON error bodies.
    }
    handleSessionExpired(message);
    const err = new Error(message) as Error & { isAuthError?: boolean };
    err.isAuthError = true;
    throw err;
  }

  if (!res.ok) {
    let message = res.statusText;

    try {
      const body = await res.json();
      message = body.error ?? body.message ?? message;
    } catch {
      // Ignore non-JSON error bodies.
    }

    throw new Error(message);
  }

  return res.json() as Promise<T>;
}

function hasTenantId(value: unknown): boolean {
  return (
    value !== undefined && value !== null && String(value).trim().length > 0
  );
}

async function staffForm<T>(path: string, formData: FormData): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { ...authHeaders() },
    body: formData,
  });

  if (res.status === 401) {
    const message = "Session expired. Please log in again.";
    handleSessionExpired(message);
    const err = new Error(message) as Error & {
      isAuthError?: boolean;
    };
    err.isAuthError = true;
    throw err;
  }

  if (!res.ok) {
    let message = res.statusText;

    try {
      const body = await res.json();
      message = body.error ?? body.message ?? message;
    } catch {
      // Ignore non-JSON error bodies.
    }

    throw new Error(message);
  }

  return res.json() as Promise<T>;
}

export type StaffStatus = "active" | "inactive" | "pending";
export type StaffWorkType = "office" | "field";

export interface StaffListParams {
  /**
   * Account/access role. Keep this database-safe (for example: staff/admin/hr).
   * Business template identity such as student/worker/teacher belongs in
   * peopleType/people_type, not in role.
   */
  role?: "staff" | "admin" | string | null;
  /** Business/template people scope: student, teacher, staff, worker, etc. */
  peopleType?: string | null;
  /** Snake-case alias accepted by backend and older call sites. */
  people_type?: string | null;
  /** Generic aliases for future person-based modules. */
  personType?: string | null;
  person_type?: string | null;
  organizationId?: number | string | null;
  branchId?: number | string | null;
  userId?: number | string | null;
  status?: StaffStatus | "all" | string | null;
  department?: string | null;
  designation?: string | null;
}

export type StaffPayload = Partial<User> & {
  password?: string;
  created_by_user_id?: number | string | null;

  organization_id?: number | string | null;
  organizationId?: number | string | null;
  org_id?: number | string | null;
  branch_id?: number | string | null;
  branch_ui_id?: number | null;
  backend_branch_id?: number | string | null;
  branch_name?: string | null;

  account_role?: string | null;
  peopleType?: string | null;
  people_type?: string | null;
  personType?: string | null;
  person_type?: string | null;

  employee_id?: string | null;
  person_code?: string | null;
  personCode?: string | null;
  registration_number?: string | null;
  registrationNumber?: string | null;
  employee_number?: string | null;
  employeeNumber?: string | null;
  worker_id?: string | null;
  workerId?: string | null;
  teacher_code?: string | null;
  teacherCode?: string | null;
  status?: StaffStatus;
  benefits?: string[];

  shift_id?: string | null;
  shift_label?: string | null;

  /**
   * Field-staff attendance geofence — a single "static location" site
   * (lat/lng + radius) this person is checked in against. This is the
   * first, simplest scenario of the open/dynamic field-attendance model;
   * visiting-plan and route scenarios are additive layers on top of this
   * per-staff record, not a replacement for it (someone can have a base
   * geofence AND a visit plan).
   */
  geofence_lat?: number | null;
  geofenceLat?: number | null;
  geofence_lng?: number | null;
  geofenceLng?: number | null;
  /** Meters. Falls back to a sane server default (e.g. 100m) if omitted. */
  geofence_radius_meters?: number | null;
  geofenceRadiusMeters?: number | null;
  /** Human label shown to the employee before they punch in, e.g.
   * "Sheikh Zaid Hospital". Purely descriptive — the check itself uses
   * lat/lng/radius. */
  geofence_label?: string | null;
  geofenceLabel?: string | null;

  /**
   * Office-staff WiFi attendance config — per-organization/branch/staff,
   * replacing the old app-side hardcoded SSID/BSSID constants. A branch
   * can have multiple access points (mesh) broadcasting the same SSID,
   * so BSSIDs are a list, not a single value.
   */
  office_ssid?: string | null;
  officeSsid?: string | null;
  office_bssid_list?: string[] | null;
  officeBssidList?: string[] | null;

  /** 'branch' (see everything in scope, today's default) | 'team' (see
   * only self + direct/indirect reports). Only meaningful for staff rows
   * that are themselves given dashboard access (a manager logging into
   * the desktop dashboard under their "Manager" hat) — irrelevant for
   * client_users (admin/HR) accounts, which are always branch/org-wide. */
  dashboard_scope?: "branch" | "team" | null;
  dashboardScope?: "branch" | "team" | null;

  profile_image_url?: string | null;
  profile_image_name?: string | null;

  /**
   * Identity documents. cnic is required for every non-student people
   * type; father_name/father_cnic/father_phone are required for students
   * instead (guardian details, not the student's own CNIC).
   */
  cnic?: string | null;
  father_name?: string | null;
  fatherName?: string | null;
  father_cnic?: string | null;
  fatherCnic?: string | null;
  father_phone?: string | null;
  fatherPhone?: string | null;
};

export interface StaffMutationResponse {
  success: boolean;
  message?: string;
  user: User;
  credentials?: {
    email: string;
    password: string;
  };
}

export interface StaffArchiveOptions {
  retentionYears?: number | null;
  reason?: string;
  archivedBy?: number | string | null;
  organizationId?: number | string | null;
}

export interface StaffArchiveResponse {
  success: boolean;
  message: string;
  archive: {
    user_id: number | string;
    name: string;
    organization_id: number | string | null;
    retention_years: number;
    deleted_embeddings: number;
    deleted_at: string | null;
    retention_until: string | null;
  };
}

export interface StaffPermanentDeleteResponse {
  success: boolean;
  message: string;
  deleted_user_id?: number | string;
  deleted_user_ids?: Array<number | string>;
  skipped_user_ids?: Array<number | string>;
  deleted_count?: number;
}

export interface StaffMediaUploadError {
  phase: "photo" | "media-sync";
  message: string;
}

export interface StaffPhotoUploadResponse {
  success: boolean;
  photo_url?: string;
  profile_image_url?: string;
  profileImageUrl?: string;
  profile_image_name?: string;
  profileImageName?: string;
}

export const staffProfilePhotoUrl = (userId: number | string) =>
  `${BASE_URL}/api/staff/${encodeURIComponent(String(userId))}/photo`;

export interface StaffPageResponse {
  success: boolean;
  cached?: boolean;
  entity?: string;
  rows: User[];
  total: number;
  page: number;
  pageSize: number;
  offset?: number;
  hasMore?: boolean;
  /** Echoed back by a team-scoped backend so the UI can show "Showing
   * your team (N)" vs "Showing branch (N)" without re-deriving it from
   * the stored user object. Absent on routes not yet scope-aware. */
  dashboardScope?: "branch" | "team";
}

export interface StaffPageParams extends StaffListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
}

export async function listStaffPage(
  params: StaffPageParams,
): Promise<StaffPageResponse> {
  if (!hasTenantId(params?.organizationId)) {
    throw new Error("organization_id is required to load staff records.");
  }

  const qs = new URLSearchParams();
  qs.set("orgId", String(params.organizationId));
  qs.set("page", String(Math.max(1, Number(params.page || 1))));
  qs.set(
    "pageSize",
    String(Math.max(1, Math.min(250, Number(params.pageSize || 50)))),
  );

  if (hasTenantId(params.branchId)) qs.set("branchId", String(params.branchId));
  if (params.search && params.search.trim())
    qs.set("search", params.search.trim());
  if (params.sortBy) qs.set("sortBy", params.sortBy);
  if (params.sortDir) qs.set("sortDir", params.sortDir);

  const peopleType =
    params.peopleType ??
    params.people_type ??
    params.personType ??
    params.person_type;
  if (peopleType && String(peopleType).trim()) {
    qs.set("people_type", String(peopleType).trim());
  }

  if (params.role && String(params.role).trim()) {
    qs.set("role", String(params.role).trim());
  }

  if (params.status && params.status !== "all") {
    qs.set("status", String(params.status));
  }

  if (params.department && params.department !== "all") {
    qs.set("department", String(params.department));
  }

  if (params.designation && params.designation !== "all") {
    qs.set("designation", String(params.designation));
  }

  const body = await staffJson<StaffPageResponse>(
    `/api/v2/staff/page?${qs.toString()}`,
    {
      method: "GET",
    },
  );

  return {
    success: body.success !== false,
    cached: body.cached,
    entity: body.entity,
    rows: Array.isArray(body.rows) ? body.rows : [],
    total: Number(body.total || 0),
    page: Number(body.page || params.page || 1),
    pageSize: Number(body.pageSize || params.pageSize || 50),
    offset: Number(body.offset || 0),
    hasMore: Boolean(body.hasMore),
    dashboardScope: body.dashboardScope,
  };
}

export async function listStaffRecords(params?: StaffListParams) {
  if (!hasTenantId(params?.organizationId)) {
    throw new Error("organization_id is required to load staff records.");
  }

  const qs = new URLSearchParams();

  if (params?.role) qs.set("role", params.role);

  if (
    params?.organizationId !== undefined &&
    params.organizationId !== null &&
    String(params.organizationId).trim()
  ) {
    qs.set("organization_id", String(params.organizationId));
  }

  if (
    params?.branchId !== undefined &&
    params.branchId !== null &&
    String(params.branchId).trim()
  ) {
    qs.set("branch_id", String(params.branchId));
  }

  if (
    params?.userId !== undefined &&
    params.userId !== null &&
    String(params.userId).trim()
  ) {
    qs.set("user_id", String(params.userId));
  }

  return staffJson<User[]>(`/api/staff${qs.toString() ? `?${qs}` : ""}`);
}

export async function getStaffRecord(userId: number | string) {
  return staffJson<User>(`/api/staff/${encodeURIComponent(String(userId))}`);
}

/** Minimal display-only lookup (name/email/role) for a Client Dashboard
 * user — an org admin/manager account, distinct from a client_staff row.
 * Used to resolve identities (e.g. a leave request's approver) that don't
 * exist in the staff directory because the approver is an admin without
 * an employee record. See the backend's get_client_user_basic docstring. */
export async function getClientUserBasic(userId: number | string) {
  return staffJson<{
    id: string;
    name: string | null;
    full_name: string | null;
    email: string | null;
    role: string | null;
  }>(`/api/client-users/${encodeURIComponent(String(userId))}/basic`);
}

export async function createStaffRecord(payload: StaffPayload) {
  if (
    !hasTenantId(
      payload.organization_id ?? payload.organizationId ?? payload.org_id,
    )
  ) {
    throw new Error("organization_id is required to create staff records.");
  }

  return staffJson<StaffMutationResponse>("/api/staff", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateStaffRecord(
  userId: number | string,
  payload: StaffPayload,
) {
  return staffJson<StaffMutationResponse>(
    `/api/staff/${encodeURIComponent(String(userId))}`,
    {
      method: "PUT",
      body: JSON.stringify(payload),
    },
  );
}

/**
 * Sets a staff member's dashboard row-scope: 'branch' (sees everything in
 * their branch/org, today's default) or 'team' (sees only themself + their
 * reporting chain). Separate endpoint from updateStaffRecord rather than a
 * field on the general PATCH, so flipping scope is an explicit,
 * individually-auditable action — not something that can slip through as
 * a side effect of an unrelated profile edit.
 */
export async function setStaffDashboardScope(
  userId: number | string,
  organizationId: number | string,
  scope: "branch" | "team",
) {
  return staffJson<StaffMutationResponse>(
    `/api/staff/${encodeURIComponent(String(userId))}/dashboard-scope`,
    {
      method: "PATCH",
      body: JSON.stringify({
        organization_id: organizationId,
        dashboard_scope: scope,
      }),
    },
  );
}

/**
 * One level of direct reports (everyone whose manager_id points at
 * `userId`) — used to decide whether a 'branch'-scoped dashboard session
 * is eligible to see the "My Team" toggle at all (a manager with zero
 * reports has nothing to narrow to). Mirrors
 * client_staff_hierarchy_routes.py's GET /staff/<id>/reports exactly;
 * does not affect what the dashboard overview endpoint itself returns —
 * that's still gated server-side by get_effective_scope_ids off the
 * verified token, this call is purely for the UI's "should I show the
 * toggle" decision.
 */
export async function getStaffDirectReports(
  userId: number | string,
  organizationId: number | string,
): Promise<{ success: boolean; reports: Array<Record<string, unknown>> }> {
  return staffJson<{
    success: boolean;
    reports: Array<Record<string, unknown>>;
  }>(
    `/api/client/staff/${encodeURIComponent(String(userId))}/reports?organization_id=${encodeURIComponent(String(organizationId))}`,
  );
}

export async function archiveStaffRecord(
  userId: number | string,
  payload: {
    reason?: string;
    archivedBy?: number | string | null;
    retentionYears?: number | null;
    organizationId?: number | string | null;
  } = {},
): Promise<StaffArchiveResponse> {
  return staffJson<StaffArchiveResponse>(
    `/api/staff/${encodeURIComponent(String(userId))}`,
    {
      method: "DELETE",
      body: JSON.stringify({
        reason: payload.reason ?? "Archived from Staff Management",
        archived_by: payload.archivedBy ?? null,
        retention_years: payload.retentionYears ?? null,
        organization_id: payload.organizationId ?? null,
      }),
    },
  );
}

export async function uploadStaffPhoto(userId: number | string, file: File) {
  const fd = new FormData();
  fd.append("photo", file);

  return staffForm<StaffPhotoUploadResponse>(
    `/api/staff/${encodeURIComponent(String(userId))}/photo`,
    fd,
  );
}

export async function getArchivedStaffRecords(params?: {
  organizationId?: number | string | null;
  branchId?: number | string | null;
  peopleType?: string | null;
}) {
  if (!hasTenantId(params?.organizationId)) {
    throw new Error(
      "organization_id is required to load archived staff records.",
    );
  }

  const query = new URLSearchParams();

  if (params?.organizationId != null) {
    query.set("organization_id", String(params.organizationId));
  }

  if (params?.branchId != null) {
    query.set("branch_id", String(params.branchId));
  }

  if (params?.peopleType && String(params.peopleType).trim()) {
    query.set("people_type", String(params.peopleType).trim());
  }

  const path = query.toString()
    ? `/api/staff/archived?${query.toString()}`
    : "/api/staff/archived";

  return staffJson<User[]>(path, { method: "GET" });
}

export async function restoreStaffRecord(
  userId: number | string,
  payload: {
    organizationId?: number | string | null;
    restoredBy?: number | string | null;
  } = {},
) {
  return staffJson<{
    success: boolean;
    message: string;
    restore?: unknown;
    user?: User;
  }>(`/api/staff/${encodeURIComponent(String(userId))}/restore`, {
    method: "POST",
    body: JSON.stringify({
      organization_id: payload.organizationId ?? null,
      restored_by: payload.restoredBy ?? null,
    }),
  });
}

export async function deleteArchivedStaffRecord(
  userId: number | string,
  payload: {
    organizationId?: number | string | null;
    deletedBy?: number | string | null;
  } = {},
): Promise<StaffPermanentDeleteResponse> {
  return staffJson<StaffPermanentDeleteResponse>(
    `/api/staff/archived/${encodeURIComponent(String(userId))}/delete`,
    {
      method: "POST",
      body: JSON.stringify({
        organization_id: payload.organizationId ?? null,
        deleted_by: payload.deletedBy ?? null,
      }),
    },
  );
}

// ─── Visit Plans (Scenario 2 — admin side) ─────────────────────────────────
// Mirrors client_visit_plans_routes.py exactly. Same underlying
// visit_plans/visit_plan_stops/visits tables the mobile self-service
// endpoints (client_field_visits_routes.py) use — an admin-created stop and
// an employee-created one are indistinguishable in storage except for
// created_by_role. Raw shape only, no server-computed status/summary — see
// support_db_visits.get_plan_raw's docstring; compliance (completed/
// pending/unplanned counts) is computed here on the client, the same way
// visit_plan_service.dart computes it on-device for the mobile app. Keep
// computeVisitPlanSummary below in sync with that file if the shape of a
// stop/visit ever changes.

export interface VisitPlanRecord {
  id: string;
  org_id: string;
  branch_id?: string | null;
  staff_id: string;
  plan_date: string;
  origin: "admin" | "self";
  created_by?: string | null;
  created_by_role?: string | null;
}

export interface VisitPlanStopRecord {
  id: string;
  plan_id: string;
  location_label: string;
  lat: number;
  lng: number;
  radius_meters: number;
  purpose?: string | null;
  window_start?: string | null;
  window_end?: string | null;
  display_order?: number;
  created_by_role?: string | null;
  is_deleted?: boolean;
}

export interface VisitRecord {
  id: string;
  org_id: string;
  staff_id: string;
  plan_stop_id?: string | null;
  latitude: number;
  longitude: number;
  distance_from_stop_meters?: number | null;
  /** Server-computed (log_visit), NOT client-submitted -- distance from
   * the stop's real lat/lng to the GPS fix at log time, and whether that
   * fell within the stop's radius_meters. Null on unplanned visits and on
   * rows logged before this field existed. This -- not
   * distance_from_stop_meters -- is what compliance display should
   * trust; distance_from_stop_meters is on-device and unverified. */
  server_distance_meters?: number | null;
  verified_inside_geofence?: boolean | null;
  photo_url?: string | null;
  note?: string | null;
  evidence_mode_recorded?: string;
  source?: string;
  timestamp?: string;
}

export interface VisitPlanRaw {
  plan: VisitPlanRecord | null;
  stops: VisitPlanStopRecord[];
  visits: VisitRecord[];
}

export interface VisitPlanSummary {
  plannedTotal: number;
  completed: number;
  pending: number;
  unplanned: number;
  /** Stops with a logged visit that the server verified was OUTSIDE the
   * stop's geofence at log time. Counted within `completed` (a visit was
   * logged) but broken out separately so admins can see it needs review. */
  outOfRange: number;
}

/** Maps each stop to its visit (if any) and whether that visit was
 * server-verified inside the stop's geofence. Mirrors
 * visit_plan_service.dart's computeStopStatuses. */
export function computeStopVerification(
  stops: VisitPlanStopRecord[],
  visits: VisitRecord[],
): Map<string, { visit: VisitRecord; outOfRange: boolean }> {
  const visitByStopId = new Map<string, VisitRecord>();
  for (const v of visits) {
    if (v.plan_stop_id) visitByStopId.set(String(v.plan_stop_id), v);
  }
  const result = new Map<string, { visit: VisitRecord; outOfRange: boolean }>();
  for (const s of stops) {
    const visit = visitByStopId.get(String(s.id));
    if (!visit) continue;
    // verified_inside_geofence === false is an explicit server verdict.
    // null/undefined (unplanned visits, or rows logged before this field
    // existed) is treated as "not flagged" -- no regression on old data.
    result.set(String(s.id), {
      visit,
      outOfRange: visit.verified_inside_geofence === false,
    });
  }
  return result;
}

/** Pure client-side diff — mirrors visit_plan_service.dart's
 * computeStopStatuses/computeSummary so the dashboard and the mobile app
 * never disagree about what "6 of 8 completed" means. Completion is keyed
 * off a visit existing for the stop (same as before); outOfRange is a new,
 * separate signal read from verified_inside_geofence -- the server-computed
 * field, not the client-submitted distance_from_stop_meters -- so a
 * spoofed/out-of-range check-in still counts as "logged" but is flagged
 * for review instead of silently showing as a clean green completion. */
export function computeVisitPlanSummary(
  stops: VisitPlanStopRecord[],
  visits: VisitRecord[],
): VisitPlanSummary {
  const verification = computeStopVerification(stops, visits);
  const completedStopIds = new Set(
    visits.filter((v) => v.plan_stop_id).map((v) => String(v.plan_stop_id)),
  );
  const completed = stops.filter((s) =>
    completedStopIds.has(String(s.id)),
  ).length;
  const outOfRange = stops.filter(
    (s) => verification.get(String(s.id))?.outOfRange,
  ).length;
  const unplanned = visits.filter((v) => !v.plan_stop_id).length;
  return {
    plannedTotal: stops.length,
    completed,
    pending: stops.length - completed,
    unplanned,
    outOfRange,
  };
}

export interface VisitPlanDay {
  date: string;
  plan: VisitPlanRecord | null;
  stops: VisitPlanStopRecord[];
  visits: VisitRecord[];
}

export async function getStaffVisitPlan(
  staffId: string,
  organizationId: number | string,
  planDate: string,
): Promise<VisitPlanRaw> {
  const qs = new URLSearchParams({
    organization_id: String(organizationId),
    date: planDate,
  });
  return staffJson<VisitPlanRaw>(
    `/api/client/staff/${encodeURIComponent(staffId)}/visit-plan?${qs.toString()}`,
  );
}

/** Admin dashboard History view — one call for a whole month, each entry
 * shaped like getStaffVisitPlan's response so computeVisitPlanSummary/
 * computeStopVerification run unmodified per day. Mirrors the mobile
 * app's ApiService.getVisitPlansHistory. */
export async function getStaffVisitPlansHistory(
  staffId: string,
  organizationId: number | string,
  opts: { month?: string; startDate?: string; endDate?: string } = {},
): Promise<VisitPlanDay[]> {
  const qs = new URLSearchParams({ organization_id: String(organizationId) });
  if (opts.month) qs.set("month", opts.month);
  if (opts.startDate) qs.set("start_date", opts.startDate);
  if (opts.endDate) qs.set("end_date", opts.endDate);
  const result = await staffJson<{ days: VisitPlanDay[] }>(
    `/api/client/staff/${encodeURIComponent(staffId)}/visit-plans-history?${qs.toString()}`,
  );
  return result.days ?? [];
}

export async function createStaffVisitPlan(
  staffId: string,
  payload: {
    organizationId: number | string;
    branchId?: number | string | null;
    date: string;
    createdBy?: string | null;
  },
): Promise<{ plan: VisitPlanRecord }> {
  if (!hasTenantId(payload.organizationId)) {
    throw new Error("organization_id is required to create a visit plan.");
  }
  return staffJson<{ plan: VisitPlanRecord }>(
    `/api/client/staff/${encodeURIComponent(staffId)}/visit-plan`,
    {
      method: "POST",
      body: JSON.stringify({
        organization_id: payload.organizationId,
        branch_id: payload.branchId ?? null,
        date: payload.date,
        created_by: payload.createdBy ?? null,
      }),
    },
  );
}

export async function listBranchVisitPlans(
  branchId: number | string,
  organizationId: number | string,
  planDate: string,
): Promise<{ plans: VisitPlanRecord[] }> {
  const qs = new URLSearchParams({
    organization_id: String(organizationId),
    date: planDate,
  });
  return staffJson<{ plans: VisitPlanRecord[] }>(
    `/api/client/branches/${encodeURIComponent(String(branchId))}/visit-plans?${qs.toString()}`,
  );
}

export interface VisitPlanStopPayload {
  organizationId: number | string;
  createdBy?: string | null;
  locationLabel: string;
  lat: number;
  lng: number;
  radiusMeters?: number;
  purpose?: string;
  windowStart?: string | null;
  windowEnd?: string | null;
  displayOrder?: number;
}

export async function addVisitPlanStop(
  planId: string,
  payload: VisitPlanStopPayload,
): Promise<{ stop: VisitPlanStopRecord }> {
  if (!hasTenantId(payload.organizationId)) {
    throw new Error("organization_id is required to add a stop.");
  }
  return staffJson<{ stop: VisitPlanStopRecord }>(
    `/api/client/visit-plans/${encodeURIComponent(planId)}/stops`,
    {
      method: "POST",
      body: JSON.stringify({
        organization_id: payload.organizationId,
        created_by: payload.createdBy ?? null,
        location_label: payload.locationLabel,
        lat: payload.lat,
        lng: payload.lng,
        radius_meters: payload.radiusMeters ?? 150,
        purpose: payload.purpose ?? null,
        window_start: payload.windowStart ?? null,
        window_end: payload.windowEnd ?? null,
        display_order: payload.displayOrder ?? 0,
      }),
    },
  );
}

export async function updateVisitPlanStop(
  stopId: string,
  organizationId: number | string,
  patch: Partial<{
    locationLabel: string;
    lat: number;
    lng: number;
    radiusMeters: number;
    purpose: string;
    windowStart: string | null;
    windowEnd: string | null;
    displayOrder: number;
  }>,
): Promise<{ stop: VisitPlanStopRecord }> {
  const body: Record<string, unknown> = { organization_id: organizationId };
  if (patch.locationLabel !== undefined)
    body.location_label = patch.locationLabel;
  if (patch.lat !== undefined) body.lat = patch.lat;
  if (patch.lng !== undefined) body.lng = patch.lng;
  if (patch.radiusMeters !== undefined) body.radius_meters = patch.radiusMeters;
  if (patch.purpose !== undefined) body.purpose = patch.purpose;
  if (patch.windowStart !== undefined) body.window_start = patch.windowStart;
  if (patch.windowEnd !== undefined) body.window_end = patch.windowEnd;
  if (patch.displayOrder !== undefined) body.display_order = patch.displayOrder;

  return staffJson<{ stop: VisitPlanStopRecord }>(
    `/api/client/visit-plan-stops/${encodeURIComponent(stopId)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
}

export async function deleteVisitPlanStop(
  stopId: string,
  organizationId: number | string,
): Promise<{ deleted: boolean }> {
  return staffJson<{ deleted: boolean }>(
    `/api/client/visit-plan-stops/${encodeURIComponent(stopId)}`,
    {
      method: "DELETE",
      body: JSON.stringify({ organization_id: organizationId }),
    },
  );
}

export async function bulkDeleteArchivedStaffRecords(
  userIds: Array<number | string>,
  payload: {
    organizationId?: number | string | null;
    deletedBy?: number | string | null;
  } = {},
): Promise<StaffPermanentDeleteResponse> {
  return staffJson<StaffPermanentDeleteResponse>(
    "/api/staff/archived/bulk-delete",
    {
      method: "POST",
      body: JSON.stringify({
        user_ids: userIds.map((id) => String(id)).filter(Boolean),
        organization_id: payload.organizationId ?? null,
        deleted_by: payload.deletedBy ?? null,
      }),
    },
  );
}
