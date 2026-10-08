// import 'dart:convert';
// import 'package:http/http.dart' as http;
// import '../config/app_config.dart';

// /// Thrown by [ApiService._decodeOrThrow] for any non-2xx response. Carries
// /// the parsed error text separately from Dart's default toString() noise
// /// (unlike the dart:io HttpException this replaces, whose toString() is
// /// 'HttpException: <message>' -- every screen that wanted a clean message
// /// to show a person had to string-strip that prefix itself; see
// /// visit_plan_screen.dart's now-redundant _readableError). Also carries
// /// the optional machine-readable `code` the backend's err() helper sends
// /// (client_routes_helpers.py) for callers -- like OfflineQueueService --
// /// that need to branch on *why* a call failed rather than pattern-match
// /// the human-readable message, which is free to change or localize.
// class ApiException implements Exception {
//   final String message;
//   final String? code;
//   final int statusCode;
//   const ApiException(this.message, this.statusCode, {this.code});

//   @override
//   String toString() => message;
// }

// class ApiService {
//   static const String baseUrl = AppConfig.baseUrl;

//   static Map<String, String> _headers(String token) => {
//         'Content-Type': 'application/json',
//         'Authorization': 'Bearer $token',
//       };

//   /// Decode a response body only after confirming it's actually JSON from
//   /// a successful call. Without this, a 404/500/HTML-error-page response
//   /// either throws deep inside jsonDecode (fine) or -- worse -- decodes
//   /// into a Map missing the key a caller expects, which callers like
//   /// getOfficeAttendance were defaulting to `[]`/`{}` for. That default is
//   /// indistinguishable from "genuinely zero records today," which is
//   /// exactly how a broken /history route silently reset _todayPresent to
//   /// false after every successful mark. Every list/status endpoint below
//   /// should decode through this, not call jsonDecode(res.body) directly.
//   static dynamic _decodeOrThrow(http.Response res) {
//     if (res.statusCode < 200 || res.statusCode >= 300) {
//       // Try to pull the real reason out of the response body -- most of
//       // this backend's routes return {"error": "..."} or {"message": "..."}
//       // via a shared `handle()`/`ok()` helper. Falling back to the raw
//       // body (truncated) beats a bare status code when that shape doesn't
//       // match, which is what was happening before: every failure surfaced
//       // as an undiagnosable "Could not load..." with no way to tell a
//       // missing DB table apart from an expired token apart from a 404
//       // from a route that was never registered on the deployed server.
//       String detail = 'HTTP ${res.statusCode}';
//       String? code;
//       try {
//         final body = jsonDecode(res.body);
//         if (body is Map) {
//           final msg = body['error'] ?? body['message'] ?? body['detail'];
//           if (msg != null) detail = msg.toString();
//           code = body['code'] as String?;
//         }
//       } catch (_) {
//         if (res.body.isNotEmpty) {
//           detail = res.body.length > 200
//               ? '${res.body.substring(0, 200)}…'
//               : res.body;
//         }
//       }
//       throw ApiException(detail, res.statusCode, code: code);
//     }
//     return jsonDecode(res.body);
//   }

//   // ===== AUTH =====

//   /// Mobile portal login (client_staff_auth.py) — returns a signed bearer
//   /// token, unlike /api/login (Client Dashboard admin/HR + desktop staff
//   /// login), which never issues one. identifier accepts email OR phone,
//   /// matching whatever Staff Management recorded at creation.
//   static Future<Map<String, dynamic>> login(
//       String identifier, String password) async {
//     final res = await http
//         .post(
//           Uri.parse('$baseUrl/api/staff/login'),
//           headers: {'Content-Type': 'application/json'},
//           body: jsonEncode({'identifier': identifier, 'password': password}),
//         )
//         .timeout(const Duration(seconds: 15));
//     return jsonDecode(res.body);
//   }

//   static Future<void> logout(String token) async {
//     final res = await http
//         .post(
//           Uri.parse('$baseUrl/api/staff/logout'),
//           headers: _headers(token),
//         )
//         .timeout(const Duration(seconds: 15));
//     _decodeOrThrow(res);
//   }

//   /// Refreshes the logged-in staff member's full profile — department,
//   /// access_modules, shift, etc. Called right after login (see
//   /// LoginScreen) because the JWT deliberately omits these fields; call
//   /// again on app resume if access_modules needs to stay current within
//   /// the 30-day token lifetime.
//   static Future<Map<String, dynamic>> getMe(String token) async {
//     final res = await http
//         .get(
//           Uri.parse('$baseUrl/api/staff/me'),
//           headers: _headers(token),
//         )
//         .timeout(const Duration(seconds: 15));
//     return jsonDecode(res.body);
//   }

//   // ===== FIELD STAFF =====

//   /// [geofence] is the on-device GeofenceService.evaluateGeofence result --
//   /// sent along purely so the server has the same "what did the employee's
//   /// own screen show them" context an admin reviewing the mark would want,
//   /// but it is NOT trusted as the verdict any more. mark_field_attendance
//   /// now recomputes the geofence itself server-side (support_db.
//   /// evaluate_field_geofence, from [lat]/[lng] and the staff row) and that
//   /// recomputed result -- not this one -- is what actually gets stored and
//   /// decides whether the mark needs admin review. See that route's
//   /// docstring for why a client-asserted "inside": true can no longer be
//   /// taken at face value.
//   ///
//   /// [isMocked] is Geolocator's own mock-location signal (Position.isMocked
//   /// on Android; see field_attendance_screen.dart's `_startAttendanceFlow`,
//   /// which already refuses to proceed past step 1 when this is true). It's
//   /// sent through anyway, and unconditionally, as a second, independent
//   /// defense-in-depth signal for the server to act on -- a patched/rooted
//   /// client that skips the on-device block could still lie about this
//   /// field, so the server never *relies* on isMocked being honest, but a
//   /// stock client reporting it honestly still gives the server one more
//   /// thing to flag on top of its own recomputed geofence distance.
//   ///
//   /// [faceVerified]/[faceSimilarity] should be omitted on the normal live
//   /// path -- verify-face already ran synchronously right before this call,
//   /// and the route treats a missing face_verified as "nothing new to
//   /// record" (see mark_field_attendance's docstring). Only
//   /// OfflineQueueService's 'field_attendance_offline' sync-time replay
//   /// passes these -- the result of the deferred [verifyFace] call it makes
//   /// once connectivity returns.
//   static Future<Map<String, dynamic>> markFieldAttendance(
//     String token,
//     String userId,
//     String userName,
//     double lat,
//     double lng,
//     Map<String, dynamic> geofence, {
//     bool isMocked = false,
//     bool syncedAfterOffline = false,
//     String? clientActionId,
//     bool? faceVerified,
//     double? faceSimilarity,
//   }) async {
//     final res = await http
//         .post(
//           Uri.parse('$baseUrl/api/field/mark-attendance'),
//           headers: _headers(token),
//           body: jsonEncode({
//             'user_id': userId,
//             'user_name': userName,
//             'lat': lat,
//             'lng': lng,
//             'is_mocked': isMocked,
//             'geofence': {
//               'configured': geofence['configured'],
//               'inside': geofence['inside'],
//               'distance': geofence['distance'],
//               'radius': geofence['radius'],
//               'label': geofence['label'],
//             },
//             'synced_after_offline': syncedAfterOffline,
//             if (clientActionId != null) 'client_action_id': clientActionId,
//             if (faceVerified != null) 'face_verified': faceVerified,
//             if (faceSimilarity != null) 'face_similarity': faceSimilarity,
//           }),
//         )
//         .timeout(const Duration(seconds: 15));
//     return _decodeOrThrow(res) as Map<String, dynamic>;
//   }

//   /// client_field_attendance_routes.verify_face -- 1:1 match against the
//   /// caller's own enrolled embeddings, decided server-side (see that
//   /// route's docstring for why this can't become a client-asserted bool
//   /// the way geofence/WiFi are). [userId] is accepted for readability at
//   /// call sites only; the route ignores it and always matches against
//   /// g.client_staff from the bearer token.
//   ///
//   /// Single implementation shared by FaceVerificationScreen's live path
//   /// and OfflineQueueService's sync-time replay of a queued selfie, so the
//   /// two can never drift on headers, timeout, or response shape.
//   ///
//   /// Always returns the decoded response body, even for verified=false --
//   /// "no face"/"no match"/"not enrolled" are normal outcomes the route
//   /// returns with HTTP 200 (see verify_face's docstring), not something
//   /// this throws on. This only throws on an actual transport failure
//   /// (timeout, connection refused, non-2xx), which is exactly the signal
//   /// callers need to distinguish "face didn't match" from "couldn't reach
//   /// the server."
//   /// client_field_attendance_routes.liveness_challenge -- ask the server
//   /// which head movement to demand for THIS attempt.
//   ///
//   /// The direction is chosen server-side with secrets.choice and travels
//   /// only inside a signed, single-use, 120s token. The app must not cache
//   /// the result or reuse a token across attempts: the whole replay
//   /// defence rests on the client being unable to predict or pick the
//   /// challenge, so call this fresh immediately before every capture.
//   ///
//   /// Returns {challenge, prompt, challenge_token, expires_at,
//   /// frames_expected}. Show `prompt` to the employee verbatim; pass
//   /// `challenge_token` straight back to [verifyFaceBurst] untouched.
//   static Future<Map<String, dynamic>> getLivenessChallenge(
//     String token,
//   ) async {
//     final res = await http
//         .post(
//           Uri.parse('$baseUrl/api/field/liveness-challenge'),
//           headers: _headers(token),
//           body: jsonEncode({}),
//         )
//         .timeout(const Duration(seconds: 15));
//     return _decodeOrThrow(res) as Map<String, dynamic>;
//   }

//   /// client_field_attendance_routes.verify_face, LIVE path -- posts the
//   /// whole burst plus the challenge token in ONE request.
//   ///
//   /// One request, not one per frame, because liveness is a property of
//   /// the trajectory rather than of any single frame: the server needs the
//   /// full yaw series to see a turn AND a return to centre. Uploading
//   /// frames individually would also let a client cherry-pick which ones
//   /// it sends after seeing intermediate responses.
//   ///
//   /// [frames] must be in capture order and already un-mirrored (see
//   /// FaceVerificationScreen._normaliseForUpload) -- the server reads head
//   /// direction from these pixels, so a horizontally flipped burst inverts
//   /// left and right and fails a genuine employee.
//   static Future<Map<String, dynamic>> verifyFaceBurst(
//     String token,
//     String userId,
//     List<String> frames,
//     String challengeToken,
//   ) async {
//     final res = await http
//         .post(
//           Uri.parse('$baseUrl/api/field/verify-face'),
//           headers: _headers(token),
//           body: jsonEncode({
//             'user_id': userId,
//             'frames': frames,
//             'challenge_token': challengeToken,
//           }),
//         )
//         // Longer than the single-frame call: the server runs an
//         // InsightFace forward pass per frame, serialised behind
//         // detect_and_extract's process-wide inference lock.
//         .timeout(const Duration(seconds: 45));
//     return _decodeOrThrow(res) as Map<String, dynamic>;
//   }

//   static Future<Map<String, dynamic>> verifyFace(
//     String token,
//     String userId,
//     String base64Image,
//   ) async {
//     final res = await http
//         .post(
//           Uri.parse('$baseUrl/api/field/verify-face'),
//           headers: _headers(token),
//           body: jsonEncode({'user_id': userId, 'image': base64Image}),
//         )
//         .timeout(const Duration(seconds: 20));
//     return _decodeOrThrow(res) as Map<String, dynamic>;
//   }

//   static Future<List<dynamic>> getFieldAttendanceLogs(String token) async {
//     final res = await http
//         .get(
//           Uri.parse('$baseUrl/api/field/attendance-logs'),
//           headers: _headers(token),
//         )
//         .timeout(const Duration(seconds: 15));
//     final data = jsonDecode(res.body);
//     if (data is List) return data;
//     return data['logs'] ?? [];
//   }

//   static Future<void> sendGeoAlert(
//       String token, Map<String, dynamic> alertData) async {
//     try {
//       await http
//           .post(
//             Uri.parse('$baseUrl/api/field/geo-alert'),
//             headers: _headers(token),
//             body: jsonEncode(alertData),
//           )
//           .timeout(const Duration(seconds: 10));
//     } catch (_) {}
//   }

//   // ===== OFFICE STAFF =====

//   /// Self-service check-in/check-out (backend: client_staff_attendance_routes.py
//   /// -> support_db.mark_client_staff_attendance). org/branch/staff come from
//   /// the bearer token server-side, never from this payload.
//   ///
//   /// [wifiVerified] flags whether the device confirmed it's on the office
//   /// SSID/BSSID before calling; pass false for the manual "no WiFi match"
//   /// fallback path -- either way the mark still succeeds, just without the
//   /// WiFi-confirmed flag recorded in metadata.
//   ///
//   /// [syncedAfterOffline] must be true only when this call is retrying a
//   /// mark that was cached locally after a prior real-time attempt failed
//   /// (see OfflineQueueService.dart's 'attendance_mark_office' case) -- the
//   /// backend records it as source='mobile_fallback' instead of
//   /// 'mobile_office' so the Client Dashboard can tell a live mark from a
//   /// delayed sync.
//   ///
//   /// [clientActionId] is the offline queue's idempotency key -- same
//   /// contract as markFieldAttendance's parameter of the same name. Pass
//   /// it on every call the queue makes (not just retries) so a dropped
//   /// response can never be replayed as the opposite action; a live,
//   /// never-queued call can safely omit it.
//   static Future<Map<String, dynamic>> markAttendance(
//     String token, {
//     String? ssid,
//     String? bssid,
//     bool wifiVerified = false,
//     bool syncedAfterOffline = false,
//     String? clientActionId,
//   }) async {
//     final res = await http
//         .post(
//           Uri.parse('$baseUrl/api/staff/attendance/mark'),
//           headers: _headers(token),
//           body: jsonEncode({
//             if (ssid != null) 'ssid': ssid,
//             if (bssid != null) 'bssid': bssid,
//             'wifi_verified': wifiVerified,
//             'synced_after_offline': syncedAfterOffline,
//             if (clientActionId != null) 'client_action_id': clientActionId,
//           }),
//         )
//         .timeout(const Duration(seconds: 15));
//     return _decodeOrThrow(res) as Map<String, dynamic>;
//   }

//   /// Own-attendance history — backs both the Attendance tab and the
//   /// "already marked today?" check on the home screen. Reads the same
//   /// Supabase `attendance` table [markAttendance] above writes to, unlike
//   /// the old /get_attendance_by_name (legacy SQLite, name-keyed, and
//   /// unauthenticated -- any caller could search any name across tenants).
//   /// `name` param dropped: org/staff scope now comes from the bearer token
//   /// server-side, same as every other /api/staff/attendance/* route.
//   /// Today's status + checkout-eligibility (capture_check_out). Call on
//   /// load/refresh -- not just right after a mark -- so the Check Out
//   /// button appears correctly even for a check-in made in an earlier app
//   /// session on the same day.
//   static Future<Map<String, dynamic>> getTodayAttendanceStatus(
//       String token) async {
//     final res = await http
//         .get(
//           Uri.parse('$baseUrl/api/staff/attendance/today'),
//           headers: _headers(token),
//         )
//         .timeout(const Duration(seconds: 15));
//     return _decodeOrThrow(res) as Map<String, dynamic>;
//   }

//   /// Own-attendance history. Throws on any non-2xx response (see
//   /// _decodeOrThrow) instead of returning `[]` -- callers like
//   /// _fetchStats() rely on catching that throw to leave _todayPresent
//   /// untouched on failure, rather than reading an empty list as "no
//   /// attendance today" and clobbering an already-confirmed check-in.
//   static Future<List<dynamic>> getOfficeAttendance(
//       String token, String name) async {
//     final res = await http
//         .get(
//           Uri.parse('$baseUrl/api/staff/attendance/history'),
//           headers: _headers(token),
//         )
//         .timeout(const Duration(seconds: 15));
//     final data = _decodeOrThrow(res);
//     if (data is List) return data;
//     return (data as Map<String, dynamic>)['logs'] ?? [];
//   }

//   // ===== LEAVE =====

//   // Backend: client_staff_leave_routes.py -> support_db.create_client_leave_request
//   // / list_client_leave_requests -- the SAME Supabase leave_requests table
//   // the web dashboard's Leave Management screen reads (leaveApi.ts). This
//   // replaces the old /apply_leave + /get_my_leaves calls, which hit routes
//   // that never existed server-side (grepped: not in app.py) -- every
//   // mobile leave request was silently posting into a 404 and was never
//   // visible on the dashboard, to a manager, or to an admin. staffName/
//   // department/staff_id are no longer sent -- org_id/branch_id/staff_id
//   // are read server-side from the bearer token, never trusted from this
//   // payload, so a mobile caller can't file leave for anyone else by
//   // editing the request body.
//   //
//   // [halfDay]: true if the half-day toggle was on. [halfDayPeriod]:
//   // 'morning' | 'afternoon' (server normalizes to its own first_half/
//   // second_half vocabulary). [halfDayStartTime]/[halfDayEndTime]: 'HH:mm'
//   // strings for the exact window the user picked -- the server folds the
//   // originally chosen leave category and this time range into the stored
//   // reason (since the backend's gated half-day model only has room for a
//   // first_half/second_half bucket, not arbitrary times, as a first-class
//   // field) so nothing typed in the app is lost.
//   static Future<Map<String, dynamic>> applyLeave(
//     String token,
//     String leaveType,
//     String startDate,
//     String endDate,
//     String reason, {
//     bool halfDay = false,
//     String? halfDayPeriod,
//     String? halfDayStartTime,
//     String? halfDayEndTime,
//   }) async {
//     final res = await http
//         .post(
//           Uri.parse('$baseUrl/api/staff/leaves'),
//           headers: _headers(token),
//           body: jsonEncode({
//             'leave_type': leaveType,
//             'start_date': startDate,
//             'end_date': endDate,
//             'reason': reason,
//             'half_day': halfDay,
//             if (halfDayPeriod != null) 'half_day_period': halfDayPeriod,
//             if (halfDayStartTime != null) 'half_day_start_time': halfDayStartTime,
//             if (halfDayEndTime != null) 'half_day_end_time': halfDayEndTime,
//           }),
//         )
//         .timeout(const Duration(seconds: 15));
//     return _decodeOrThrow(res) as Map<String, dynamic>;
//   }

//   /// Effective, org+branch-scoped leave-type paid/unpaid map for the
//   /// caller's own tenant (client_staff_leave_routes.py's /types route,
//   /// itself a thin read over support_db_payroll's PayrollPolicy). Drives
//   /// the "Apply for Leave" dropdown so the app always offers exactly the
//   /// categories this org (and, if set, this branch) has configured,
//   /// instead of a fixed list baked into the app build. org_id/branch_id
//   /// are resolved server-side from the bearer token -- there is no way to
//   /// ask for another tenant's leave types through this call.
//   static Future<Map<String, dynamic>> getLeaveTypes(String token) async {
//     final res = await http
//         .get(
//           Uri.parse('$baseUrl/api/staff/leaves/types'),
//           headers: _headers(token),
//         )
//         .timeout(const Duration(seconds: 15));
//     final data = _decodeOrThrow(res);
//     if (data is Map<String, dynamic>) {
//       return (data['leaveTypeRules'] as Map?)?.cast<String, dynamic>() ?? {};
//     }
//     return {};
//   }

//   /// Own leave history only -- the server pins this to the bearer token's
//   /// staff id, so it structurally can't return anyone else's leave, even
//   /// for a caller who is also someone's manager (that team-wide view is a
//   /// separate, dashboard-only surface with its own token).
//   static Future<List<dynamic>> getMyLeaves(String token) async {
//     final res = await http
//         .get(
//           Uri.parse('$baseUrl/api/staff/leaves'),
//           headers: _headers(token),
//         )
//         .timeout(const Duration(seconds: 15));
//     final data = _decodeOrThrow(res);
//     if (data is List) return data;
//     return (data as Map<String, dynamic>)['leaves'] ?? [];
//   }

//   /// Cancels a leave request the caller submitted themselves. Backend-
//   /// enforced (client_staff_leave_routes.py cancel_leave), not just
//   /// hidden in the UI: only the owning staff member can cancel, and only
//   /// while status is still 'pending' -- the server returns a non-2xx
//   /// (caught by _decodeOrThrow) if either check fails, e.g. if another
//   /// device already got it approved/rejected between load and tap. An
//   /// approved/rejected leave requires a manager/admin action on the
//   /// Client Dashboard instead (PUT/DELETE /api/leaves/<id>), same as
//   /// before this existed.
//   static Future<Map<String, dynamic>> cancelLeave(
//       String token, String leaveId) async {
//     final res = await http
//         .delete(
//           Uri.parse('$baseUrl/api/staff/leaves/$leaveId'),
//           headers: _headers(token),
//         )
//         .timeout(const Duration(seconds: 15));
//     return _decodeOrThrow(res) as Map<String, dynamic>;
//   }

//   // ===== OVERTIME =====

//   // Backend: client_staff_overtime_routes.py -> support_db.
//   // create_client_overtime_request / list_client_overtime_requests -- the
//   // SAME Supabase overtime_requests table the web dashboard's Overtime
//   // Management screen reads (overtime.ts / OvertimeManagement.tsx). This
//   // replaces the old /api/overtime/request + /api/overtime/my calls, which
//   // hit routes that never existed server-side (grepped: not in app.py) --
//   // every mobile overtime request was silently posting into a 404 and was
//   // never visible on the dashboard, to a manager, or to an admin, exactly
//   // the same failure mode applyLeave/getMyLeaves had before their fix.
//   //
//   // userId is intentionally NOT a parameter here (unlike the old
//   // signature) -- org_id/branch_id/staff_id are all read server-side from
//   // the bearer token, never trusted from the request, so a mobile caller
//   // can't file or read overtime for anyone else by editing the call site.
//   // staff_id/org_id/branch_id are UUID strings end-to-end on the backend;
//   // nothing here parses them as int.
//   static Future<Map<String, dynamic>> requestOvertime(
//       String token, String date, double hours, String reason) async {
//     final res = await http
//         .post(
//           Uri.parse('$baseUrl/api/staff/overtime'),
//           headers: _headers(token),
//           body: jsonEncode({
//             'date': date,
//             'hours': hours,
//             'reason': reason,
//           }),
//         )
//         .timeout(const Duration(seconds: 15));
//     return _decodeOrThrow(res) as Map<String, dynamic>;
//   }

//   /// Own overtime history only -- the server pins this to the bearer
//   /// token's staff id. A manager or admin's team-/org-wide view of the
//   /// same records lives on the Client Dashboard's Overtime Management
//   /// screen (a separate, token-scoped surface); this mobile portal never
//   /// exposes a teammate's overtime, even if the caller manages them.
//   static Future<List<dynamic>> getMyOvertime(String token) async {
//     final res = await http
//         .get(
//           Uri.parse('$baseUrl/api/staff/overtime'),
//           headers: _headers(token),
//         )
//         .timeout(const Duration(seconds: 15));
//     final data = _decodeOrThrow(res);
//     if (data is List) return data;
//     return (data as Map<String, dynamic>)['overtime'] ?? [];
//   }

//   // ===== TODAY STATUS =====

//   static Future<Map<String, dynamic>?> getTodayStatus(
//       String token, String name) async {
//     try {
//       final res = await http
//           .get(
//             Uri.parse('$baseUrl/api/staff/attendance/history'),
//             headers: _headers(token),
//           )
//           .timeout(const Duration(seconds: 15));
//       final data = jsonDecode(res.body);
//       final List records = data is List ? data : (data['logs'] ?? []);
//       if (records.isEmpty) return null;

//       final today = DateTime.now();
//       final todayStr =
//           '${today.year}-${today.month.toString().padLeft(2, '0')}-${today.day.toString().padLeft(2, '0')}';

//       for (final r in records) {
//         if ((r['date'] ?? '').toString().startsWith(todayStr)) {
//           return Map<String, dynamic>.from(r);
//         }
//       }
//       return null;
//     } catch (_) {
//       return null;
//     }
//   }

//   // ===== VISIT PLANS (Scenario 2 — activity layer) =====
//   // Mirrors client_field_visits_routes.py exactly. None of these ever
//   // touch attendance -- a staff member can have zero visits logged and
//   // still be marked Present off their normal check-in/check-out. See
//   // support_db_visits.py's module docstring for why the two are kept
//   // separate.

//   /// Raw { plan, stops, visits } for one date (defaults to today, server
//   /// UTC). No computed status/summary here -- see get_plan_raw's
//   /// docstring on the backend; VisitPlanService.computeStopStatuses/
//   /// computeSummary do that on-device from this response.
//   static Future<Map<String, dynamic>> getTodayVisitPlan(
//     String token, {
//     String? date,
//   }) async {
//     final qs = date != null ? '?date=$date' : '';
//     final res = await http
//         .get(
//           Uri.parse('$baseUrl/api/field/visits/today$qs'),
//           headers: _headers(token),
//         )
//         .timeout(const Duration(seconds: 15));
//     final data = _decodeOrThrow(res);
//     return Map<String, dynamic>.from(data as Map);
//   }

//   /// Employee self-planning -- idempotent. If an admin already created a
//   /// plan for this date, this just returns it (never overwrites).
//   static Future<Map<String, dynamic>> createOwnVisitPlan(
//     String token, {
//     String? date,
//   }) async {
//     final res = await http
//         .post(
//           Uri.parse('$baseUrl/api/field/visits/plan'),
//           headers: _headers(token),
//           body: jsonEncode({if (date != null) 'date': date}),
//         )
//         .timeout(const Duration(seconds: 15));
//     final data = _decodeOrThrow(res);
//     return Map<String, dynamic>.from(data['plan'] ?? data);
//   }

//   static Future<Map<String, dynamic>> addOwnVisitStop(
//     String token,
//     String planId, {
//     required String locationLabel,
//     required double lat,
//     required double lng,
//     int radiusMeters = 150,
//     String? purpose,
//     String? windowStart,
//     String? windowEnd,
//     String? clientActionId,
//   }) async {
//     final res = await http
//         .post(
//           Uri.parse('$baseUrl/api/field/visits/plan/$planId/stops'),
//           headers: _headers(token),
//           body: jsonEncode({
//             'location_label': locationLabel,
//             'lat': lat,
//             'lng': lng,
//             'radius_meters': radiusMeters,
//             if (purpose != null) 'purpose': purpose,
//             if (windowStart != null) 'window_start': windowStart,
//             if (windowEnd != null) 'window_end': windowEnd,
//             if (clientActionId != null) 'client_action_id': clientActionId,
//           }),
//         )
//         .timeout(const Duration(seconds: 15));
//     final data = _decodeOrThrow(res);
//     return Map<String, dynamic>.from(data['stop'] ?? data);
//   }

//   static Future<Map<String, dynamic>> updateOwnVisitStop(
//     String token,
//     String stopId,
//     Map<String, dynamic> patch,
//   ) async {
//     final res = await http
//         .patch(
//           Uri.parse('$baseUrl/api/field/visits/stops/$stopId'),
//           headers: _headers(token),
//           body: jsonEncode(patch),
//         )
//         .timeout(const Duration(seconds: 15));
//     final data = _decodeOrThrow(res);
//     return Map<String, dynamic>.from(data['stop'] ?? data);
//   }

//   static Future<void> deleteOwnVisitStop(String token, String stopId) async {
//     await http
//         .delete(
//           Uri.parse('$baseUrl/api/field/visits/stops/$stopId'),
//           headers: _headers(token),
//         )
//         .timeout(const Duration(seconds: 15));
//   }

//   /// Always 200/201 -- a visit is never rejected server-side for missing
//   /// evidence, distance, or anything else (see log_visit's docstring in
//   /// support_db_visits.py). [distanceFromStopMeters] should come from
//   /// VisitPlanService.evaluateStopDistance, computed on-device the same
//   /// way shift geofence is.
//   static Future<Map<String, dynamic>> logVisit(
//     String token, {
//     required double latitude,
//     required double longitude,
//     String? planStopId,
//     double? distanceFromStopMeters,
//     String? photoUrl,
//     String? note,
//     String evidenceMode = 'gps_only',
//     String? clientActionId,
//   }) async {
//     final res = await http
//         .post(
//           Uri.parse('$baseUrl/api/field/visits/log'),
//           headers: _headers(token),
//           body: jsonEncode({
//             'latitude': latitude,
//             'longitude': longitude,
//             if (planStopId != null) 'plan_stop_id': planStopId,
//             if (distanceFromStopMeters != null)
//               'distance_from_stop_meters': distanceFromStopMeters,
//             if (photoUrl != null) 'photo_url': photoUrl,
//             if (note != null) 'note': note,
//             'evidence_mode': evidenceMode,
//             if (clientActionId != null) 'client_action_id': clientActionId,
//           }),
//         )
//         .timeout(const Duration(seconds: 20));
//     final data = _decodeOrThrow(res);
//     return Map<String, dynamic>.from(data['visit'] ?? data);
//   }

//   /// Closes out a visit opened by [logVisit] -- the "leaving the stop"
//   /// half. Unlike logVisit, the server DOES reject this (already checked
//   /// out / not found / not yours) since there's no "missing evidence"
//   /// judgment call to defer -- see check_out_visit's docstring in
//   /// support_db_visits.py.
//   static Future<Map<String, dynamic>> checkOutVisit(
//     String token,
//     String visitId, {
//     required double latitude,
//     required double longitude,
//     String? clientActionId,
//   }) async {
//     final res = await http
//         .post(
//           Uri.parse('$baseUrl/api/field/visits/log/$visitId/checkout'),
//           headers: _headers(token),
//           body: jsonEncode({
//             'latitude': latitude,
//             'longitude': longitude,
//             if (clientActionId != null) 'client_action_id': clientActionId,
//           }),
//         )
//         .timeout(const Duration(seconds: 20));
//     final data = _decodeOrThrow(res);
//     return Map<String, dynamic>.from(data['visit'] ?? data);
//   }

//   static Future<List<dynamic>> getVisitHistory(String token,
//       {int limit = 100}) async {
//     final res = await http
//         .get(
//           Uri.parse('$baseUrl/api/field/visits/history?limit=$limit'),
//           headers: _headers(token),
//         )
//         .timeout(const Duration(seconds: 15));
//     final data = _decodeOrThrow(res);
//     if (data is List) return data;
//     return (data as Map<String, dynamic>)['visits'] ?? [];
//   }

//   // ===== HR ASSISTANT =====

//   static Future<Map<String, dynamic>> sendHrAssistantMessage(
//       String token, String message) async {
//     final res = await http
//         .post(
//           Uri.parse('$baseUrl/api/staff/hr-assistant/message'),
//           headers: _headers(token),
//           body: jsonEncode({'message': message}),
//         )
//         .timeout(const Duration(seconds: 30));
//     return _decodeOrThrow(res) as Map<String, dynamic>;
//   }
// }


import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config/app_config.dart';

/// Thrown by [ApiService._decodeOrThrow] for any non-2xx response. Carries
/// the parsed error text separately from Dart's default toString() noise
/// (unlike the dart:io HttpException this replaces, whose toString() is
/// 'HttpException: <message>' -- every screen that wanted a clean message
/// to show a person had to string-strip that prefix itself; see
/// visit_plan_screen.dart's now-redundant _readableError). Also carries
/// the optional machine-readable `code` the backend's err() helper sends
/// (client_routes_helpers.py) for callers -- like OfflineQueueService --
/// that need to branch on *why* a call failed rather than pattern-match
/// the human-readable message, which is free to change or localize.
class ApiException implements Exception {
  final String message;
  final String? code;
  final int statusCode;
  const ApiException(this.message, this.statusCode, {this.code});

  @override
  String toString() => message;
}

class ApiService {
  static const String baseUrl = AppConfig.baseUrl;

  /// Registered once by main.dart at startup. _decodeOrThrow invokes this
  /// whenever a response means the current session is dead — any 401 from
  /// require_client_staff_auth (expired token, invalid token, or killed by
  /// session_registry — e.g. password changed / logged in elsewhere), or a
  /// 403 with code ORG_ACCESS_BLOCKED / MOBILE_ACCESS_REVOKED (org status
  /// or Organization.enabled_mobile_people_types changed mid-session; see
  /// client_staff_auth.py). Kept as an injected callback, not a direct
  /// Navigator/BuildContext reference, so this file stays a plain HTTP
  /// layer with no UI-layer import — every one of this class's ~20 call
  /// sites gets the same forced-logout behavior for free, instead of each
  /// screen needing its own duplicate check on e.code.
  static void Function(String message)? onSessionInvalidated;

  static Map<String, String> _headers(String token) => {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $token',
      };

  /// Decode a response body only after confirming it's actually JSON from
  /// a successful call. Without this, a 404/500/HTML-error-page response
  /// either throws deep inside jsonDecode (fine) or -- worse -- decodes
  /// into a Map missing the key a caller expects, which callers like
  /// getOfficeAttendance were defaulting to `[]`/`{}` for. That default is
  /// indistinguishable from "genuinely zero records today," which is
  /// exactly how a broken /history route silently reset _todayPresent to
  /// false after every successful mark. Every list/status endpoint below
  /// should decode through this, not call jsonDecode(res.body) directly.
  static dynamic _decodeOrThrow(http.Response res) {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      // Try to pull the real reason out of the response body -- most of
      // this backend's routes return {"error": "..."} or {"message": "..."}
      // via a shared `handle()`/`ok()` helper. Falling back to the raw
      // body (truncated) beats a bare status code when that shape doesn't
      // match, which is what was happening before: every failure surfaced
      // as an undiagnosable "Could not load..." with no way to tell a
      // missing DB table apart from an expired token apart from a 404
      // from a route that was never registered on the deployed server.
      String detail = 'HTTP ${res.statusCode}';
      String? code;
      try {
        final body = jsonDecode(res.body);
        if (body is Map) {
          final msg = body['error'] ?? body['message'] ?? body['detail'];
          if (msg != null) detail = msg.toString();
          code = body['code'] as String?;
        }
      } catch (_) {
        if (res.body.isNotEmpty) {
          detail = res.body.length > 200
              ? '${res.body.substring(0, 200)}…'
              : res.body;
        }
      }
      if (res.statusCode == 401 ||
          code == 'ORG_ACCESS_BLOCKED' ||
          code == 'MOBILE_ACCESS_REVOKED') {
        onSessionInvalidated?.call(detail);
      }

      throw ApiException(detail, res.statusCode, code: code);
    }
    return jsonDecode(res.body);
  }

  // ===== AUTH =====

  /// Mobile portal login (client_staff_auth.py) — returns a signed bearer
  /// token, unlike /api/login (Client Dashboard admin/HR + desktop staff
  /// login), which never issues one. identifier accepts email OR phone,
  /// matching whatever Staff Management recorded at creation.
  static Future<Map<String, dynamic>> login(
      String identifier, String password) async {
    final res = await http
        .post(
          Uri.parse('$baseUrl/api/staff/login'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'identifier': identifier, 'password': password}),
        )
        .timeout(const Duration(seconds: 15));
    return jsonDecode(res.body);
  }

  static Future<void> logout(String token) async {
    final res = await http
        .post(
          Uri.parse('$baseUrl/api/staff/logout'),
          headers: _headers(token),
        )
        .timeout(const Duration(seconds: 15));
    _decodeOrThrow(res);
  }

  /// Refreshes the logged-in staff member's full profile — department,
  /// access_modules, shift, etc. Called right after login (see
  /// LoginScreen) because the JWT deliberately omits these fields; call
  /// again on app resume if access_modules needs to stay current within
  /// the 30-day token lifetime.
  static Future<Map<String, dynamic>> getMe(String token) async {
    final res = await http
        .get(
          Uri.parse('$baseUrl/api/staff/me'),
          headers: _headers(token),
        )
        .timeout(const Duration(seconds: 15));
    return jsonDecode(res.body);
  }

  // ===== FIELD STAFF =====

  /// [geofence] is the on-device GeofenceService.evaluateGeofence result --
  /// sent along purely so the server has the same "what did the employee's
  /// own screen show them" context an admin reviewing the mark would want,
  /// but it is NOT trusted as the verdict any more. mark_field_attendance
  /// now recomputes the geofence itself server-side (support_db.
  /// evaluate_field_geofence, from [lat]/[lng] and the staff row) and that
  /// recomputed result -- not this one -- is what actually gets stored and
  /// decides whether the mark needs admin review. See that route's
  /// docstring for why a client-asserted "inside": true can no longer be
  /// taken at face value.
  ///
  /// [isMocked] is Geolocator's own mock-location signal (Position.isMocked
  /// on Android; see field_attendance_screen.dart's `_startAttendanceFlow`,
  /// which already refuses to proceed past step 1 when this is true). It's
  /// sent through anyway, and unconditionally, as a second, independent
  /// defense-in-depth signal for the server to act on -- a patched/rooted
  /// client that skips the on-device block could still lie about this
  /// field, so the server never *relies* on isMocked being honest, but a
  /// stock client reporting it honestly still gives the server one more
  /// thing to flag on top of its own recomputed geofence distance.
  ///
  /// [faceVerified]/[faceSimilarity] should be omitted on the normal live
  /// path -- verify-face already ran synchronously right before this call,
  /// and the route treats a missing face_verified as "nothing new to
  /// record" (see mark_field_attendance's docstring). Only
  /// OfflineQueueService's 'field_attendance_offline' sync-time replay
  /// passes these -- the result of the deferred [verifyFace] call it makes
  /// once connectivity returns.
  static Future<Map<String, dynamic>> markFieldAttendance(
    String token,
    String userId,
    String userName,
    double lat,
    double lng,
    Map<String, dynamic> geofence, {
    bool isMocked = false,
    bool syncedAfterOffline = false,
    String? clientActionId,
    bool? faceVerified,
    double? faceSimilarity,
  }) async {
    final res = await http
        .post(
          Uri.parse('$baseUrl/api/field/mark-attendance'),
          headers: _headers(token),
          body: jsonEncode({
            'user_id': userId,
            'user_name': userName,
            'lat': lat,
            'lng': lng,
            'is_mocked': isMocked,
            'geofence': {
              'configured': geofence['configured'],
              'inside': geofence['inside'],
              'distance': geofence['distance'],
              'radius': geofence['radius'],
              'label': geofence['label'],
            },
            'synced_after_offline': syncedAfterOffline,
            if (clientActionId != null) 'client_action_id': clientActionId,
            if (faceVerified != null) 'face_verified': faceVerified,
            if (faceSimilarity != null) 'face_similarity': faceSimilarity,
          }),
        )
        .timeout(const Duration(seconds: 15));
    return _decodeOrThrow(res) as Map<String, dynamic>;
  }

  /// client_field_attendance_routes.verify_face -- 1:1 match against the
  /// caller's own enrolled embeddings, decided server-side (see that
  /// route's docstring for why this can't become a client-asserted bool
  /// the way geofence/WiFi are). [userId] is accepted for readability at
  /// call sites only; the route ignores it and always matches against
  /// g.client_staff from the bearer token.
  ///
  /// Single implementation shared by FaceVerificationScreen's live path
  /// and OfflineQueueService's sync-time replay of a queued selfie, so the
  /// two can never drift on headers, timeout, or response shape.
  ///
  /// Always returns the decoded response body, even for verified=false --
  /// "no face"/"no match"/"not enrolled" are normal outcomes the route
  /// returns with HTTP 200 (see verify_face's docstring), not something
  /// this throws on. This only throws on an actual transport failure
  /// (timeout, connection refused, non-2xx), which is exactly the signal
  /// callers need to distinguish "face didn't match" from "couldn't reach
  /// the server."
  /// client_field_attendance_routes.liveness_challenge -- ask the server
  /// which head movement to demand for THIS attempt.
  ///
  /// The direction is chosen server-side with secrets.choice and travels
  /// only inside a signed, single-use, 120s token. The app must not cache
  /// the result or reuse a token across attempts: the whole replay
  /// defence rests on the client being unable to predict or pick the
  /// challenge, so call this fresh immediately before every capture.
  ///
  /// Returns {challenge, prompt, challenge_token, expires_at,
  /// frames_expected}. Show `prompt` to the employee verbatim; pass
  /// `challenge_token` straight back to [verifyFaceBurst] untouched.
  static Future<Map<String, dynamic>> getLivenessChallenge(
    String token,
  ) async {
    final res = await http
        .post(
          Uri.parse('$baseUrl/api/field/liveness-challenge'),
          headers: _headers(token),
          body: jsonEncode({}),
        )
        .timeout(const Duration(seconds: 15));
    return _decodeOrThrow(res) as Map<String, dynamic>;
  }

  /// client_field_attendance_routes.verify_face, LIVE path -- posts the
  /// whole burst plus the challenge token in ONE request.
  ///
  /// One request, not one per frame, because liveness is a property of
  /// the trajectory rather than of any single frame: the server needs the
  /// full yaw series to see a turn AND a return to centre. Uploading
  /// frames individually would also let a client cherry-pick which ones
  /// it sends after seeing intermediate responses.
  ///
  /// [frames] must be in capture order and already un-mirrored (see
  /// FaceVerificationScreen._normaliseForUpload) -- the server reads head
  /// direction from these pixels, so a horizontally flipped burst inverts
  /// left and right and fails a genuine employee.
  static Future<Map<String, dynamic>> verifyFaceBurst(
    String token,
    String userId,
    List<String> frames,
    String challengeToken,
  ) async {
    final res = await http
        .post(
          Uri.parse('$baseUrl/api/field/verify-face'),
          headers: _headers(token),
          body: jsonEncode({
            'user_id': userId,
            'frames': frames,
            'challenge_token': challengeToken,
          }),
        )
        // Longer than the single-frame call: the server runs an
        // InsightFace forward pass per frame, serialised behind
        // detect_and_extract's process-wide inference lock.
        .timeout(const Duration(seconds: 45));
    return _decodeOrThrow(res) as Map<String, dynamic>;
  }

  static Future<Map<String, dynamic>> verifyFace(
    String token,
    String userId,
    String base64Image,
  ) async {
    final res = await http
        .post(
          Uri.parse('$baseUrl/api/field/verify-face'),
          headers: _headers(token),
          body: jsonEncode({'user_id': userId, 'image': base64Image}),
        )
        .timeout(const Duration(seconds: 20));
    return _decodeOrThrow(res) as Map<String, dynamic>;
  }

  static Future<List<dynamic>> getFieldAttendanceLogs(String token) async {
    final res = await http
        .get(
          Uri.parse('$baseUrl/api/field/attendance-logs'),
          headers: _headers(token),
        )
        .timeout(const Duration(seconds: 15));
    final data = jsonDecode(res.body);
    if (data is List) return data;
    return data['logs'] ?? [];
  }

  static Future<void> sendGeoAlert(
      String token, Map<String, dynamic> alertData) async {
    try {
      await http
          .post(
            Uri.parse('$baseUrl/api/field/geo-alert'),
            headers: _headers(token),
            body: jsonEncode(alertData),
          )
          .timeout(const Duration(seconds: 10));
    } catch (_) {}
  }

  // ===== OFFICE STAFF =====

  /// Self-service check-in/check-out (backend: client_staff_attendance_routes.py
  /// -> support_db.mark_client_staff_attendance). org/branch/staff come from
  /// the bearer token server-side, never from this payload.
  ///
  /// [wifiVerified] flags whether the device confirmed it's on the office
  /// SSID/BSSID before calling; pass false for the manual "no WiFi match"
  /// fallback path -- either way the mark still succeeds, just without the
  /// WiFi-confirmed flag recorded in metadata.
  ///
  /// [syncedAfterOffline] must be true only when this call is retrying a
  /// mark that was cached locally after a prior real-time attempt failed
  /// (see OfflineQueueService.dart's 'attendance_mark_office' case) -- the
  /// backend records it as source='mobile_fallback' instead of
  /// 'mobile_office' so the Client Dashboard can tell a live mark from a
  /// delayed sync.
  ///
  /// [clientActionId] is the offline queue's idempotency key -- same
  /// contract as markFieldAttendance's parameter of the same name. Pass
  /// it on every call the queue makes (not just retries) so a dropped
  /// response can never be replayed as the opposite action; a live,
  /// never-queued call can safely omit it.
  static Future<Map<String, dynamic>> markAttendance(
    String token, {
    String? ssid,
    String? bssid,
    bool wifiVerified = false,
    bool syncedAfterOffline = false,
    String? clientActionId,
  }) async {
    final res = await http
        .post(
          Uri.parse('$baseUrl/api/staff/attendance/mark'),
          headers: _headers(token),
          body: jsonEncode({
            if (ssid != null) 'ssid': ssid,
            if (bssid != null) 'bssid': bssid,
            'wifi_verified': wifiVerified,
            'synced_after_offline': syncedAfterOffline,
            if (clientActionId != null) 'client_action_id': clientActionId,
          }),
        )
        .timeout(const Duration(seconds: 15));
    return _decodeOrThrow(res) as Map<String, dynamic>;
  }

  /// Own-attendance history — backs both the Attendance tab and the
  /// "already marked today?" check on the home screen. Reads the same
  /// Supabase `attendance` table [markAttendance] above writes to, unlike
  /// the old /get_attendance_by_name (legacy SQLite, name-keyed, and
  /// unauthenticated -- any caller could search any name across tenants).
  /// `name` param dropped: org/staff scope now comes from the bearer token
  /// server-side, same as every other /api/staff/attendance/* route.
  /// Today's status + checkout-eligibility (capture_check_out). Call on
  /// load/refresh -- not just right after a mark -- so the Check Out
  /// button appears correctly even for a check-in made in an earlier app
  /// session on the same day.
  static Future<Map<String, dynamic>> getTodayAttendanceStatus(
      String token) async {
    final res = await http
        .get(
          Uri.parse('$baseUrl/api/staff/attendance/today'),
          headers: _headers(token),
        )
        .timeout(const Duration(seconds: 15));
    return _decodeOrThrow(res) as Map<String, dynamic>;
  }

  /// Own-attendance history. Throws on any non-2xx response (see
  /// _decodeOrThrow) instead of returning `[]` -- callers like
  /// _fetchStats() rely on catching that throw to leave _todayPresent
  /// untouched on failure, rather than reading an empty list as "no
  /// attendance today" and clobbering an already-confirmed check-in.
  static Future<List<dynamic>> getOfficeAttendance(
      String token, String name) async {
    final res = await http
        .get(
          Uri.parse('$baseUrl/api/staff/attendance/history'),
          headers: _headers(token),
        )
        .timeout(const Duration(seconds: 15));
    final data = _decodeOrThrow(res);
    if (data is List) return data;
    return (data as Map<String, dynamic>)['logs'] ?? [];
  }

  // ===== LEAVE =====

  // Backend: client_staff_leave_routes.py -> support_db.create_client_leave_request
  // / list_client_leave_requests -- the SAME Supabase leave_requests table
  // the web dashboard's Leave Management screen reads (leaveApi.ts). This
  // replaces the old /apply_leave + /get_my_leaves calls, which hit routes
  // that never existed server-side (grepped: not in app.py) -- every
  // mobile leave request was silently posting into a 404 and was never
  // visible on the dashboard, to a manager, or to an admin. staffName/
  // department/staff_id are no longer sent -- org_id/branch_id/staff_id
  // are read server-side from the bearer token, never trusted from this
  // payload, so a mobile caller can't file leave for anyone else by
  // editing the request body.
  //
  // [halfDay]: true if the half-day toggle was on. [halfDayPeriod]:
  // 'morning' | 'afternoon' (server normalizes to its own first_half/
  // second_half vocabulary). [halfDayStartTime]/[halfDayEndTime]: 'HH:mm'
  // strings for the exact window the user picked -- the server folds the
  // originally chosen leave category and this time range into the stored
  // reason (since the backend's gated half-day model only has room for a
  // first_half/second_half bucket, not arbitrary times, as a first-class
  // field) so nothing typed in the app is lost.
  static Future<Map<String, dynamic>> applyLeave(
    String token,
    String leaveType,
    String startDate,
    String endDate,
    String reason, {
    bool halfDay = false,
    String? halfDayPeriod,
    String? halfDayStartTime,
    String? halfDayEndTime,
  }) async {
    final res = await http
        .post(
          Uri.parse('$baseUrl/api/staff/leaves'),
          headers: _headers(token),
          body: jsonEncode({
            'leave_type': leaveType,
            'start_date': startDate,
            'end_date': endDate,
            'reason': reason,
            'half_day': halfDay,
            if (halfDayPeriod != null) 'half_day_period': halfDayPeriod,
            if (halfDayStartTime != null) 'half_day_start_time': halfDayStartTime,
            if (halfDayEndTime != null) 'half_day_end_time': halfDayEndTime,
          }),
        )
        .timeout(const Duration(seconds: 15));
    return _decodeOrThrow(res) as Map<String, dynamic>;
  }

  /// Effective, org+branch-scoped leave-type paid/unpaid map for the
  /// caller's own tenant (client_staff_leave_routes.py's /types route,
  /// itself a thin read over support_db_payroll's PayrollPolicy). Drives
  /// the "Apply for Leave" dropdown so the app always offers exactly the
  /// categories this org (and, if set, this branch) has configured,
  /// instead of a fixed list baked into the app build. org_id/branch_id
  /// are resolved server-side from the bearer token -- there is no way to
  /// ask for another tenant's leave types through this call.
  static Future<Map<String, dynamic>> getLeaveTypes(String token) async {
    final res = await http
        .get(
          Uri.parse('$baseUrl/api/staff/leaves/types'),
          headers: _headers(token),
        )
        .timeout(const Duration(seconds: 15));
    final data = _decodeOrThrow(res);
    if (data is Map<String, dynamic>) {
      return (data['leaveTypeRules'] as Map?)?.cast<String, dynamic>() ?? {};
    }
    return {};
  }

  /// Own leave history only -- the server pins this to the bearer token's
  /// staff id, so it structurally can't return anyone else's leave, even
  /// for a caller who is also someone's manager (that team-wide view is a
  /// separate, dashboard-only surface with its own token).
  static Future<List<dynamic>> getMyLeaves(String token) async {
    final res = await http
        .get(
          Uri.parse('$baseUrl/api/staff/leaves'),
          headers: _headers(token),
        )
        .timeout(const Duration(seconds: 15));
    final data = _decodeOrThrow(res);
    if (data is List) return data;
    return (data as Map<String, dynamic>)['leaves'] ?? [];
  }

  /// Own-leave quota/taken/remaining summary for the Leave screen's
  /// balance breakdown (client_staff_leave_routes.py's /summary route,
  /// itself a thin wrapper over support_db.get_client_staff_leave_summary
  /// -- the same list_client_leave_requests + get_leave_type_allocations
  /// reads the Client Dashboard's Leave History tab makes, so this can
  /// never disagree with what the same employee's row shows there).
  ///
  /// period='year': returns quotaConfigured (false means render every
  /// total/remaining figure as "not configured", never as 0),
  /// totalLeaves/totalPaidLeaves/totalUnpaidLeaves, takenPaidLeaves/
  /// takenUnpaidLeaves for [year], and remainingPaidLeaves/
  /// remainingUnpaidLeaves/remainingLeaves -- NOT clamped at 0, an
  /// overage is shown as a real negative number, same as the dashboard.
  ///
  /// period='month': returns only takenPaidLeaves/takenUnpaidLeaves/
  /// takenThisMonth for [month] ("YYYY-MM") -- no total/remaining keys,
  /// since there's no monthly quota concept anywhere in this system.
  static Future<Map<String, dynamic>> getLeaveSummary(
    String token, {
    required String period, // 'year' | 'month'
    int? year,
    String? month, // 'YYYY-MM', only used when period == 'month'
  }) async {
    final query = <String, String>{'period': period};
    if (period == 'year' && year != null) query['year'] = '$year';
    if (period == 'month' && month != null) query['month'] = month;

    final uri = Uri.parse('$baseUrl/api/staff/leaves/summary')
        .replace(queryParameters: query);
    final res =
        await http.get(uri, headers: _headers(token)).timeout(const Duration(seconds: 15));
    final data = _decodeOrThrow(res);
    return (data as Map<String, dynamic>);
  }

  /// Cancels a leave request the caller submitted themselves. Backend-
  /// enforced (client_staff_leave_routes.py cancel_leave), not just
  /// hidden in the UI: only the owning staff member can cancel, and only
  /// while status is still 'pending' -- the server returns a non-2xx
  /// (caught by _decodeOrThrow) if either check fails, e.g. if another
  /// device already got it approved/rejected between load and tap. An
  /// approved/rejected leave requires a manager/admin action on the
  /// Client Dashboard instead (PUT/DELETE /api/leaves/<id>), same as
  /// before this existed.
  static Future<Map<String, dynamic>> cancelLeave(
      String token, String leaveId) async {
    final res = await http
        .delete(
          Uri.parse('$baseUrl/api/staff/leaves/$leaveId'),
          headers: _headers(token),
        )
        .timeout(const Duration(seconds: 15));
    return _decodeOrThrow(res) as Map<String, dynamic>;
  }

  // ===== OVERTIME =====

  // Backend: client_staff_overtime_routes.py -> support_db.
  // create_client_overtime_request / list_client_overtime_requests -- the
  // SAME Supabase overtime_requests table the web dashboard's Overtime
  // Management screen reads (overtime.ts / OvertimeManagement.tsx). This
  // replaces the old /api/overtime/request + /api/overtime/my calls, which
  // hit routes that never existed server-side (grepped: not in app.py) --
  // every mobile overtime request was silently posting into a 404 and was
  // never visible on the dashboard, to a manager, or to an admin, exactly
  // the same failure mode applyLeave/getMyLeaves had before their fix.
  //
  // userId is intentionally NOT a parameter here (unlike the old
  // signature) -- org_id/branch_id/staff_id are all read server-side from
  // the bearer token, never trusted from the request, so a mobile caller
  // can't file or read overtime for anyone else by editing the call site.
  // staff_id/org_id/branch_id are UUID strings end-to-end on the backend;
  // nothing here parses them as int.
  static Future<Map<String, dynamic>> requestOvertime(
      String token, String date, double hours, String reason) async {
    final res = await http
        .post(
          Uri.parse('$baseUrl/api/staff/overtime'),
          headers: _headers(token),
          body: jsonEncode({
            'date': date,
            'hours': hours,
            'reason': reason,
          }),
        )
        .timeout(const Duration(seconds: 15));
    return _decodeOrThrow(res) as Map<String, dynamic>;
  }

  /// Own overtime history only -- the server pins this to the bearer
  /// token's staff id. A manager or admin's team-/org-wide view of the
  /// same records lives on the Client Dashboard's Overtime Management
  /// screen (a separate, token-scoped surface); this mobile portal never
  /// exposes a teammate's overtime, even if the caller manages them.
  static Future<List<dynamic>> getMyOvertime(String token) async {
    final res = await http
        .get(
          Uri.parse('$baseUrl/api/staff/overtime'),
          headers: _headers(token),
        )
        .timeout(const Duration(seconds: 15));
    final data = _decodeOrThrow(res);
    if (data is List) return data;
    return (data as Map<String, dynamic>)['overtime'] ?? [];
  }

  // ===== TODAY STATUS =====

  static Future<Map<String, dynamic>?> getTodayStatus(
      String token, String name) async {
    try {
      final res = await http
          .get(
            Uri.parse('$baseUrl/api/staff/attendance/history'),
            headers: _headers(token),
          )
          .timeout(const Duration(seconds: 15));
      final data = jsonDecode(res.body);
      final List records = data is List ? data : (data['logs'] ?? []);
      if (records.isEmpty) return null;

      final today = DateTime.now();
      final todayStr =
          '${today.year}-${today.month.toString().padLeft(2, '0')}-${today.day.toString().padLeft(2, '0')}';

      for (final r in records) {
        if ((r['date'] ?? '').toString().startsWith(todayStr)) {
          return Map<String, dynamic>.from(r);
        }
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  // ===== VISIT PLANS (Scenario 2 — activity layer) =====
  // Mirrors client_field_visits_routes.py exactly. None of these ever
  // touch attendance -- a staff member can have zero visits logged and
  // still be marked Present off their normal check-in/check-out. See
  // support_db_visits.py's module docstring for why the two are kept
  // separate.

  /// Raw { plan, stops, visits } for one date (defaults to today, server
  /// UTC). No computed status/summary here -- see get_plan_raw's
  /// docstring on the backend; VisitPlanService.computeStopStatuses/
  /// computeSummary do that on-device from this response.
  static Future<Map<String, dynamic>> getTodayVisitPlan(
    String token, {
    String? date,
  }) async {
    final qs = date != null ? '?date=$date' : '';
    final res = await http
        .get(
          Uri.parse('$baseUrl/api/field/visits/today$qs'),
          headers: _headers(token),
        )
        .timeout(const Duration(seconds: 15));
    final data = _decodeOrThrow(res);
    return Map<String, dynamic>.from(data as Map);
  }

  /// Employee self-planning -- idempotent. If an admin already created a
  /// plan for this date, this just returns it (never overwrites).
  static Future<Map<String, dynamic>> createOwnVisitPlan(
    String token, {
    String? date,
  }) async {
    final res = await http
        .post(
          Uri.parse('$baseUrl/api/field/visits/plan'),
          headers: _headers(token),
          body: jsonEncode({if (date != null) 'date': date}),
        )
        .timeout(const Duration(seconds: 15));
    final data = _decodeOrThrow(res);
    return Map<String, dynamic>.from(data['plan'] ?? data);
  }

  static Future<Map<String, dynamic>> addOwnVisitStop(
    String token,
    String planId, {
    required String locationLabel,
    required double lat,
    required double lng,
    int radiusMeters = 150,
    String? purpose,
    String? windowStart,
    String? windowEnd,
    String? clientActionId,
  }) async {
    final res = await http
        .post(
          Uri.parse('$baseUrl/api/field/visits/plan/$planId/stops'),
          headers: _headers(token),
          body: jsonEncode({
            'location_label': locationLabel,
            'lat': lat,
            'lng': lng,
            'radius_meters': radiusMeters,
            if (purpose != null) 'purpose': purpose,
            if (windowStart != null) 'window_start': windowStart,
            if (windowEnd != null) 'window_end': windowEnd,
            if (clientActionId != null) 'client_action_id': clientActionId,
          }),
        )
        .timeout(const Duration(seconds: 15));
    final data = _decodeOrThrow(res);
    return Map<String, dynamic>.from(data['stop'] ?? data);
  }

  static Future<Map<String, dynamic>> updateOwnVisitStop(
    String token,
    String stopId,
    Map<String, dynamic> patch,
  ) async {
    final res = await http
        .patch(
          Uri.parse('$baseUrl/api/field/visits/stops/$stopId'),
          headers: _headers(token),
          body: jsonEncode(patch),
        )
        .timeout(const Duration(seconds: 15));
    final data = _decodeOrThrow(res);
    return Map<String, dynamic>.from(data['stop'] ?? data);
  }

  static Future<void> deleteOwnVisitStop(String token, String stopId) async {
    await http
        .delete(
          Uri.parse('$baseUrl/api/field/visits/stops/$stopId'),
          headers: _headers(token),
        )
        .timeout(const Duration(seconds: 15));
  }

  /// Always 200/201 -- a visit is never rejected server-side for missing
  /// evidence, distance, or anything else (see log_visit's docstring in
  /// support_db_visits.py). [distanceFromStopMeters] should come from
  /// VisitPlanService.evaluateStopDistance, computed on-device the same
  /// way shift geofence is.
  static Future<Map<String, dynamic>> logVisit(
    String token, {
    required double latitude,
    required double longitude,
    String? planStopId,
    double? distanceFromStopMeters,
    String? photoUrl,
    String? note,
    String evidenceMode = 'gps_only',
    String? clientActionId,
  }) async {
    final res = await http
        .post(
          Uri.parse('$baseUrl/api/field/visits/log'),
          headers: _headers(token),
          body: jsonEncode({
            'latitude': latitude,
            'longitude': longitude,
            if (planStopId != null) 'plan_stop_id': planStopId,
            if (distanceFromStopMeters != null)
              'distance_from_stop_meters': distanceFromStopMeters,
            if (photoUrl != null) 'photo_url': photoUrl,
            if (note != null) 'note': note,
            'evidence_mode': evidenceMode,
            if (clientActionId != null) 'client_action_id': clientActionId,
          }),
        )
        .timeout(const Duration(seconds: 20));
    final data = _decodeOrThrow(res);
    return Map<String, dynamic>.from(data['visit'] ?? data);
  }

  /// Closes out a visit opened by [logVisit] -- the "leaving the stop"
  /// half. Unlike logVisit, the server DOES reject this (already checked
  /// out / not found / not yours) since there's no "missing evidence"
  /// judgment call to defer -- see check_out_visit's docstring in
  /// support_db_visits.py.
  static Future<Map<String, dynamic>> checkOutVisit(
    String token,
    String visitId, {
    required double latitude,
    required double longitude,
    String? clientActionId,
  }) async {
    final res = await http
        .post(
          Uri.parse('$baseUrl/api/field/visits/log/$visitId/checkout'),
          headers: _headers(token),
          body: jsonEncode({
            'latitude': latitude,
            'longitude': longitude,
            if (clientActionId != null) 'client_action_id': clientActionId,
          }),
        )
        .timeout(const Duration(seconds: 20));
    final data = _decodeOrThrow(res);
    return Map<String, dynamic>.from(data['visit'] ?? data);
  }

  static Future<List<dynamic>> getVisitHistory(String token,
      {int limit = 100}) async {
    final res = await http
        .get(
          Uri.parse('$baseUrl/api/field/visits/history?limit=$limit'),
          headers: _headers(token),
        )
        .timeout(const Duration(seconds: 15));
    final data = _decodeOrThrow(res);
    if (data is List) return data;
    return (data as Map<String, dynamic>)['visits'] ?? [];
  }

  // ===== HR ASSISTANT =====

  static Future<Map<String, dynamic>> sendHrAssistantMessage(
      String token, String message) async {
    final res = await http
        .post(
          Uri.parse('$baseUrl/api/staff/hr-assistant/message'),
          headers: _headers(token),
          body: jsonEncode({'message': message}),
        )
        .timeout(const Duration(seconds: 30));
    return _decodeOrThrow(res) as Map<String, dynamic>;
  }
}