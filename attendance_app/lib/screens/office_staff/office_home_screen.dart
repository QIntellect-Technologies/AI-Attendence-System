// import 'dart:async';
// import 'package:flutter/material.dart';
// import 'package:network_info_plus/network_info_plus.dart';
// import 'package:toastification/toastification.dart';
// import '../../models/user_model.dart';
// import '../../services/api_service.dart';
// import '../../services/auth_service.dart';
// import '../../services/offline_queue_service.dart';
// import '../../utils/app_theme.dart';
// import '../../widgets/hr_chatbot_widget.dart';
// import '../../widgets/notification_widget.dart';
// import '../auth/login_screen.dart';
// import '../shared/leave_screen.dart';
// import '../shared/overtime_screen.dart';
// import '../shared/attendance_history_screen.dart';
// import '../shared/profile_screen.dart';

// class OfficeHomeScreen extends StatefulWidget {
//   final UserModel user;
//   const OfficeHomeScreen({super.key, required this.user});

//   @override
//   State<OfficeHomeScreen> createState() => _OfficeHomeScreenState();
// }

// class _OfficeHomeScreenState extends State<OfficeHomeScreen> {
//   int _currentTab = 0;
//   late Timer _clockTimer;
//   Timer? _wifiCheckTimer;
//   Timer? _syncTimer;
//   DateTime _now = DateTime.now();

//   int _presentDays = 0;
//   int _absentDays = 0;
//   int _attendanceRate = 0;
//   bool _todayPresent = false;

//   // True until the very first _fetchAll() resolves. While true, the today
//   // status card must not render "Not Marked Yet" + a CHECK IN button --
//   // that assumed state is what let a tap race the network fetch and hit
//   // the backend before it knew a check-in already existed today, turning
//   // an intended check-in into an accidental checkout (backend correctly
//   // saw an existing row and toggled it). Gating render, not just the
//   // WiFi-auto-mark timer, closes the race for the manual button too.
//   bool _initialLoading = true;

//   // Non-null only while a late check-in / early-or-late checkout is still
//   // awaiting admin resolution (support_db_attendance_exceptions.py). Drives
//   // the "Pending Review" branch, which outranks the plain Present/Checked
//   // Out display the same way the backend's own status_label priority does
//   // (get_client_staff_attendance_history's status_label comment).
//   String? _checkInHoldReason;
//   String? _checkOutHoldReason;
//   String? _todayNotes;
//   // 'early' | 'on_time' | 'late' | 'unscheduled' — the real timing
//   // classification, so the badge next to Check In can say what actually
//   // happened instead of always claiming "ON TIME".
//   String? _checkInStatus;

//   // The shift actually resolved for this person today (branch → department
//   // → staff-tier precedence chain, server-side) — previously computed by
//   // the backend and discarded except for capture_check_out, so this screen
//   // had no scheduled time to show at all. Null shift_name / empty times
//   // just mean "unscheduled" (e.g. simple mode, or no shift assigned yet).
//   String? _shiftName;
//   String _scheduledCheckInTime = '';
//   String _scheduledCheckOutTime = '';

//   // Whether TODAY's resolved shift window allows a second (checkout) mark
//   // at all — comes straight from mark_client_staff_attendance's response,
//   // the same capture_check_out flag that already gates the backend's own
//   // insert-vs-update decision. Without this the UI can't tell "checked in,
//   // nothing more to do" apart from "checked in, checkout still pending."
//   bool _captureCheckOut = false;
//   bool _checkedOut = false;

//   // ─── NEW: cached present = locally marked, not yet synced ─
//   bool _todayCachedPresent = false; // ← NAYA FLAG
//   // ─────────────────────────────────────────────────────────

//   String _todayTime = '';
//   String _todayOutTime = '';
//   String _todayDuration = '';

//   int _pendingLeaves = 0;
//   int _approvedLeaves = 0;
//   int _rejectedLeaves = 0;
//   List<dynamic> _recentLeaves = [];

//   double _totalOvertimeHours = 0;
//   int _pendingOvertimeCount = 0;

//   bool _marking = false;
//   String _markMsg = '';
//   bool _markSuccess = false;

//   // ─── Cache status ─────────────────────────────────────────
//   bool _hasPendingCache = false;
//   String _cachedTime = '';
//   // ─────────────────────────────────────────────────────────

//   // ─── WiFi Config ─────────────────────────────────────────
//   // Previously hardcoded per-build constants (_officeSSID/_officeBSSID),
//   // meaning every office employee everywhere was checked against one
//   // single network regardless of which branch they actually work at.
//   // Now read from this employee's own assigned record — set per-staff
//   // (and editable later) from the Client Dashboard's Staff Management
//   // "Assigned Office WiFi Network" field, so it varies per company/branch
//   // instead of being baked into the app build.
//   //
//   // NOTE: requires `officeSsid` (String?) and `officeBssidList` (List<
//   // String>?) fields on UserModel, populated from /api/staff/me's
//   // office_ssid / office_bssid_list. Add them there if not already
//   // present -- everything below reads through these two getters only,
//   // so that's the only place the model needs to change.
//   String get _officeSSID => widget.user.officeSsid ?? '';
//   List<String> get _officeBSSIDs => (widget.user.officeBssidList ?? const [])
//       .map((b) => b.toLowerCase())
//       .toList();

//   bool _isKnownOfficeNetwork(String ssid, String bssid) {
//     if (_officeSSID.isEmpty || _officeBSSIDs.isEmpty) return false;
//     if (ssid.isEmpty || ssid != _officeSSID) return false;
//     if (bssid.isEmpty || !_officeBSSIDs.contains(bssid.toLowerCase())) {
//       return false;
//     }
//     return true;
//   }
//   // ─────────────────────────────────────────────────────────

//   // Local aliases kept so every call site below (~60 usages) stays
//   // unchanged; only the source of truth moved to AppTheme. Do not
//   // reintroduce raw hex here -- add a new AppTheme color instead.
//   static const _bg = AppTheme.bgPage;
//   static const _card = AppTheme.cardColor;
//   static const _indigo = AppTheme.navy700; // primary/button accent
//   static const _green = AppTheme.successColor;
//   static const _red = AppTheme.error;
//   static const _amber = AppTheme.amber;
//   static const _blue = AppTheme.navy600;
//   static const _teal = AppTheme.teal600;

//   @override
//   void initState() {
//     super.initState();

//     _clockTimer = Timer.periodic(const Duration(seconds: 1), (_) {
//       if (mounted) setState(() => _now = DateTime.now());
//     });

//     _fetchAll();
//     _loadPendingStatus();

//     Future.delayed(const Duration(seconds: 3), _checkWifiAndMark);

//     _wifiCheckTimer = Timer.periodic(
//       const Duration(minutes: 5),
//       (_) => _checkWifiAndMark(),
//     );

//     _syncTimer = Timer.periodic(
//       const Duration(minutes: 2),
//       (_) => _syncPending(),
//     );
//   }

//   @override
//   void dispose() {
//     _clockTimer.cancel();
//     _wifiCheckTimer?.cancel();
//     _syncTimer?.cancel();
//     super.dispose();
//   }

//   bool _refreshing = false;

//   // Single toast entry point -- every transient (fire-and-forget) message
//   // in this screen goes through here, so styling/duration/icon choices
//   // live in one place instead of being repeated at each call site. This is
//   // NOT for state that needs to stay visible (e.g. "cached, pending
//   // sync") -- that stays an inline card in _buildTodayStatus, since a
//   // toast disappearing would misrepresent an ongoing state as resolved.
//   void _showToast(String message, {required bool isError}) {
//     if (!mounted) return;
//     toastification.show(
//       context: context,
//       type: isError ? ToastificationType.error : ToastificationType.success,
//       style: ToastificationStyle.flatColored,
//       title: Text(message),
//       icon: Icon(isError ? Icons.error_outline : Icons.check_circle_outline),
//       primaryColor: isError ? _red : _green,
//       backgroundColor: _card,
//       foregroundColor: AppTheme.headText,
//       alignment: Alignment.topCenter,
//       autoCloseDuration: const Duration(seconds: 3),
//       borderRadius: BorderRadius.circular(12),
//     );
//   }

//   // Single place that applies a successful mark/checkout API result to
//   // screen state and fires the confirmation toast. Previously this ~20-line
//   // block was copy-pasted across three call sites (WiFi-auto-mark, the
//   // manual button-tap path, and offline-cache sync) -- the manual path's
//   // copy was missing the _showToast() call entirely (why toasts never
//   // appeared when tapping MARK ATTENDANCE/CHECK OUT), and the sync-path
//   // copy never set _captureCheckOut/_checkedOut at all. One source of
//   // truth now; fixing the toast or the state shape only ever needs to
//   // happen here.
//   void _applyMarkResult(Map<String, dynamic> res, {required String timeStr}) {
//     if (!mounted) return;
//     final checkedOut = res['checked_out'] == true;
//     final pendingReview = res['pending_review'] == true;
//     setState(() {
//       _markSuccess = true;
//       _todayPresent = true;
//       _todayCachedPresent = false;
//       _hasPendingCache = false;
//       _cachedTime = '';
//       _captureCheckOut = res['capture_check_out'] == true;
//       _checkedOut = checkedOut;
//       _todayNotes = (res['notes'] as String?) ?? _todayNotes;
//       // status here is the timing classification (early/on_time/late) --
//       // for a checkout leg it's the checkout status; for check-in it's
//       // 'late' whenever pendingReview is true on the check-in leg.
//       if (checkedOut) {
//         _checkOutHoldReason = pendingReview ? (res['status'] as String?) : null;
//       } else {
//         _checkInStatus = res['status'] as String?;
//         _checkInHoldReason = pendingReview ? 'late' : null;
//       }
//       _markMsg = (res['message'] as String?)?.isNotEmpty == true
//           ? res['message']
//           : pendingReview
//               ? (checkedOut
//                   ? 'Checked out — pending admin review ($timeStr)'
//                   : 'Checked in — pending admin review ($timeStr)')
//               : (checkedOut
//                   ? 'Checked out successfully! ($timeStr)'
//                   : 'Attendance marked! ($timeStr)');
//       if (checkedOut) {
//         _todayOutTime = timeStr;
//         _todayDuration = 'Completed';
//       } else {
//         _todayTime = timeStr;
//         _todayDuration = 'In Progress';
//       }
//     });
//     _showToast(_markMsg, isError: false);
//     _fetchStats();
//   }

//   // Manual, whole-app refresh -- deliberately not on a timer. Re-runs every
//   // fetch the app makes at launch (stats/history, leaves, overtime,
//   // today's checkout-eligibility) so a tap on the header button catches
//   // anything an admin changed dashboard-side (marked absent, toggled
//   // checkout, approved a leave) without waiting on a poll interval.
//   Future<void> _refreshAll() async {
//     if (_refreshing) return;
//     setState(() => _refreshing = true);
//     try {
//       await _fetchAll();
//       _showToast('Refreshed', isError: false);
//     } catch (_) {
//       _showToast('Refresh failed — check your connection', isError: true);
//     } finally {
//       if (mounted) setState(() => _refreshing = false);
//     }
//   }

//   // ─── Pending Status Load ──────────────────────────────────
//   // Replaces the old SharedPreferences single-slot cache
//   // (`pending_attendance_${user.name}`) with OfflineQueueService, the
//   // same ordered queue field staff uses -- see that service's module
//   // docstring for why a single slot can't safely hold both a pending
//   // check-in AND a pending check-out on the same day. `is_checkout` in
//   // each queued item's payload (set at enqueue time in
//   // _saveAttendanceOrCache) is what lets this tell the two apart on
//   // reload, instead of assuming every cached item is a check-in the way
//   // the old cache implicitly did.
//   String get _todayKey => DateTime.now().toIso8601String().split('T')[0];

//   Future<void> _loadPendingStatus() async {
//     final items = await OfflineQueueService.pending(widget.user.id);
//     final today = _todayKey;
//     final todays = items.where((a) {
//       final payload = a['payload'] as Map? ?? const {};
//       return a['type'] == 'attendance_mark_office' && payload['date'] == today;
//     }).toList();
//     if (todays.isEmpty || !mounted) return;

//     final hasCheckIn = todays.any(
//         (a) => (a['payload'] as Map)['is_checkout'] != true);
//     final hasCheckOut = todays.any(
//         (a) => (a['payload'] as Map)['is_checkout'] == true);
//     final lastTimeStr = _to12Hour(_timeOfEnqueue(todays.last));

//     setState(() {
//       _hasPendingCache = true;
//       _cachedTime = lastTimeStr;
//       if (hasCheckIn) {
//         _todayCachedPresent = true;
//         _todayTime = _to12Hour(_timeOfEnqueue(
//             todays.firstWhere((a) => (a['payload'] as Map)['is_checkout'] != true)));
//       }
//       if (hasCheckOut) {
//         _checkedOut = true;
//         _todayOutTime = _to12Hour(_timeOfEnqueue(
//             todays.firstWhere((a) => (a['payload'] as Map)['is_checkout'] == true)));
//         _todayDuration = 'Completed';
//       }
//       _markMsg =
//           'Attendance cached ($lastTimeStr) — will sync automatically when the server is reachable';
//       _markSuccess = false;
//     });
//   }

//   String _timeOfEnqueue(Map<String, dynamic> action) {
//     final createdAt = DateTime.tryParse(action['created_at'] as String? ?? '');
//     if (createdAt == null) return '';
//     return '${createdAt.hour.toString().padLeft(2, '0')}:'
//         '${createdAt.minute.toString().padLeft(2, '0')}';
//   }
//   // ─────────────────────────────────────────────────────────

//   Future<void> _fetchAll() async {
//     try {
//       await Future.wait(
//           [_fetchStats(), _fetchLeaves(), _fetchOvertime(), _fetchTodayStatus()]);
//     } finally {
//       // finally, not just after await: a thrown/failed fetch must still
//       // unblock the UI, or a network hiccup on launch would leave the
//       // loading skeleton showing forever instead of falling through to
//       // "Not Marked Yet" (correct/safe once the real state is unknown-but-
//       // resolved, unlike the pre-fetch assumed-false state this guards
//       // against).
//       if (mounted && _initialLoading) setState(() => _initialLoading = false);
//     }
//   }

//   // Checkout-eligibility + checked-out state -- separate from _fetchStats
//   // because capture_check_out is a shift-level setting /history's rows
//   // don't carry, not an attendance fact. See getTodayAttendanceStatus's
//   // doc comment for why this needs its own call.
//   Future<void> _fetchTodayStatus() async {
//     try {
//       final status = await ApiService.getTodayAttendanceStatus(widget.user.token);
//       if (!mounted || status['success'] != true) return;
//         final alreadyMarked = status['marked'] == true ||
//           status['already_marked'] == true ||
//           status['checked_in'] == true ||
//           status['checked_out'] == true ||
//           status['check_in_time'] != null;
//       setState(() {
//         _todayPresent = alreadyMarked;
//         _captureCheckOut = status['capture_check_out'] == true;
//         _checkedOut = status['checked_out'] == true;
//         _checkInHoldReason = status['check_in_hold_reason'] as String?;
//         _checkOutHoldReason = status['check_out_hold_reason'] as String?;
//         _todayNotes = status['notes'] as String?;
//         _checkInStatus = status['check_in_status'] as String?;
//         _shiftName = status['shift_name'] as String?;
//         _scheduledCheckInTime = (status['scheduled_check_in_time'] as String?) ?? '';
//         _scheduledCheckOutTime = (status['scheduled_check_out_time'] as String?) ?? '';
//         // duration_label is authoritative (server-computed from the same
//         // helper the dashboard uses) and available even before checkout
//         // ("In Progress") -- prefer it over the history-derived value
//         // _fetchStats sets, when present.
//         if (status['duration_label'] != null) {
//           _todayDuration = status['duration_label'] as String;
//         }
//         // Clear the transient "you just performed this action" banner (see
//         // _applyMarkResult) on every authoritative refresh. It's never
//         // touched anywhere else in this function, so without this a stale
//         // "pending admin review" (or a stale success message) from an
//         // earlier mark keeps rendering forever -- including after an admin
//         // has since resolved it, directly contradicting the
//         // freshly-refreshed _todayNotes/_checkInHoldReason/
//         // _checkOutHoldReason pill it sits right next to. Safe to always
//         // clear here: _fetchTodayStatus is only ever called from
//         // _fetchAll (app launch + the manual refresh button), never
//         // synchronously right after a mark, so this can't wipe out a
//         // message the user just triggered in this same session.
//         _markSuccess = false;
//         _markMsg = '';
//       });
//     } catch (_) {}
//   }

//   Future<void> _fetchStats() async {
//     try {
//       final logs = await ApiService.getOfficeAttendance(
//           widget.user.token, widget.user.name);
//       if (!mounted) return;
//       final uniqueDates = <String>{};
//       for (final r in logs) {
//         if (r['date'] != null) uniqueDates.add(r['date'].toString());
//       }
//       final present = uniqueDates.length;
//       const total = 22;
//       final today = DateTime.now().toIso8601String().split('T')[0];
//       final todayRec = logs.cast<Map<String, dynamic>?>().firstWhere(
//             (r) => (r?['date'] ?? '').toString().startsWith(today),
//             orElse: () => null,
//           );
//       setState(() {
//         _presentDays = present;
//         _absentDays = (total - present).clamp(0, total);
//         _attendanceRate = total > 0 ? ((present / total) * 100).round() : 0;
//         if (todayRec != null) {
//           // Server se confirm ho gaya — cached present clear karo
//           _todayCachedPresent = false;
//           _hasPendingCache = false;
//         }
//         _todayTime = todayRec?['time'] ??
//             _todayTime; // cached time raho agar server se na mile
//         _todayOutTime = todayRec?['outTime'] ?? '';
//         _todayDuration = todayRec?['workDuration'] ?? 'In Progress';
//       });
//     } catch (_) {}
//   }

//   Future<void> _fetchLeaves() async {
//     try {
//       final leaves = await ApiService.getMyLeaves(widget.user.token);
//       if (!mounted) return;
//       String status(dynamic r) =>
//           (r['status'] ?? '').toString().trim().toLowerCase();
//       setState(() {
//         _pendingLeaves = leaves.where((r) => status(r) == 'pending').length;
//         _approvedLeaves = leaves.where((r) => status(r) == 'approved').length;
//         _rejectedLeaves = leaves.where((r) => status(r) == 'rejected').length;
//         _recentLeaves = leaves.take(3).toList();
//       });
//     } catch (_) {}
//   }

//   Future<void> _fetchOvertime() async {
//     try {

//           final records = await ApiService.getMyOvertime(widget.user.token);
//       if (!mounted) return;
//       double total = 0;
//       int pending = 0;
//       for (final r in records) {
//         if (r['status'] == 'Approved') total += (r['hours'] ?? 0).toDouble();
//         if (r['status'] == 'Pending') pending++;
//       }
//       setState(() {
//         _totalOvertimeHours = total;
//         _pendingOvertimeCount = pending;
//       });
//     } catch (_) {}
//   }

//   // ─── WiFi Attendance + Offline Cache ─────────────────────
//   Future<void> _checkWifiAndMark() async {
//     // Don't auto-mark until the initial fetch has told us whether today is
//     // already marked -- same race the manual button had, just on a timer.
//     if (_initialLoading) return;
//     // ← CHANGED: _todayPresent ke saath _todayCachedPresent bhi check karo
//     if (_todayPresent || _todayCachedPresent) return;

//     try {
//       final info = NetworkInfo();
//       final ssid = (await info.getWifiName())?.replaceAll('"', '') ?? '';
//       final bssid = await info.getWifiBSSID() ?? '';

//       if (!_isKnownOfficeNetwork(ssid, bssid)) return;

//       await _saveAttendanceOrCache(ssid, bssid, wifiVerified: true);
//     } catch (_) {}
//   }

//   // ─── Common: mark on the server, or queue it offline ─────
//   // Single implementation for BOTH check-in and check-out, and for BOTH
//   // call sites (WiFi auto-mark and the manual button) -- previously each
//   // combination had its own copy-pasted try/catch with a single-slot
//   // cache that only ever recorded a check-in, so an offline checkout was
//   // silently mis-cached as a fresh check-in on the next sync. Whether
//   // this attempt IS a checkout is read from current state
//   // (_isPresent && !_checkedOut), same distinction the backend itself
//   // makes by whichever attendance row already exists for today -- so the
//   // client's guess and the server's actual behavior can only ever agree
//   // or fall back to a harmless queued retry, never diverge silently.
//   Future<void> _saveAttendanceOrCache(
//     String ssid,
//     String bssid, {
//     required bool wifiVerified,
//   }) async {
//     final isCheckoutAttempt = _isPresent && !_checkedOut;
//     final timeStr = _to12Hour(DateTime.now().toIso8601String().substring(11, 16));

//     try {
//       final res = await ApiService.markAttendance(
//         widget.user.token,
//         ssid: ssid.isNotEmpty ? ssid : null,
//         bssid: bssid.isNotEmpty ? bssid : null,
//         wifiVerified: wifiVerified,
//       );

//       if (!mounted) return;
//       if (res['success'] == true) {
//         _applyMarkResult(res, timeStr: timeStr);
//       } else {
//         setState(() {
//           _markSuccess = false;
//           _markMsg = res['message'] ?? 'Error marking attendance';
//         });
//         _showToast(_markMsg, isError: true);
//       }
//     } catch (e) {
//       if (!OfflineQueueService.looksOffline(e)) {
//         // Not a connectivity failure (e.g. a genuine validation/auth
//         // error) -- surfacing it beats silently caching something that
//         // will just fail identically on every retry.
//         if (mounted) {
//           setState(() {
//             _markSuccess = false;
//             _markMsg = 'Error: $e';
//           });
//           _showToast(_markMsg, isError: true);
//         }
//         return;
//       }

//       await OfflineQueueService.enqueue(
//         widget.user.id,
//         type: 'attendance_mark_office',
//         payload: {
//           'ssid': ssid,
//           'bssid': bssid,
//           'wifi_verified': wifiVerified,
//           'is_checkout': isCheckoutAttempt,
//           'date': _todayKey,
//         },
//       );

//       if (!mounted) return;
//       setState(() {
//         _hasPendingCache = true;
//         _cachedTime = timeStr;
//         _markSuccess = false;
//         if (isCheckoutAttempt) {
//           _checkedOut = true;
//           _todayOutTime = timeStr;
//           _todayDuration = 'Completed';
//         } else {
//           _todayCachedPresent = true;
//           _todayTime = timeStr;
//           _todayDuration = 'In Progress';
//         }
//         _markMsg =
//             'Server not reachable — attendance cached ($timeStr)\nWill sync automatically once the server is reachable';
//       });
//     }
//   }
//   // ─────────────────────────────────────────────────────────

//   // ─── Pending Queue Sync ───────────────────────────────────
//   Future<void> _syncPending() async {
//     final result =
//         await OfflineQueueService.syncAll(widget.user.id, widget.user.token);
//     if (!mounted) return;

//     if (result.synced > 0) {
//       // syncAll() only returns counts, not each action's server response
//       // (unlike _applyMarkResult, which needs the real timestamp/status/
//       // notes) -- pull the authoritative state now that the queue drained
//       // instead of trusting the optimistic local values any further.
//       await _fetchTodayStatus();
//       await _fetchStats();
//       _showToast(
//           'Synced ${result.synced} pending action(s).', isError: false);
//     }

//     if (result.remaining == 0) {
//       setState(() {
//         _hasPendingCache = false;
//         _cachedTime = '';
//       });
//     } else {
//       await _loadPendingStatus();
//     }
//   }
//   // ─────────────────────────────────────────────────────────

//   // ─── Manual Mark Attendance Button ───────────────────────
//   Future<void> _markAttendance() async {
//     setState(() {
//       _marking = true;
//       _markMsg = '';
//     });
//     try {
//       final info = NetworkInfo();
//       final ssid = (await info.getWifiName())?.replaceAll('"', '') ?? '';
//       final bssid = await info.getWifiBSSID() ?? '';
//       await _saveAttendanceOrCache(
//         ssid,
//         bssid,
//         wifiVerified: _isKnownOfficeNetwork(ssid, bssid),
//       );
//     } catch (e) {
//       if (mounted) setState(() => _markMsg = 'Error: $e');
//     } finally {
//       if (mounted) setState(() => _marking = false);
//     }
//   }
//   // ─────────────────────────────────────────────────────────

//   String get _timeString {
//     final hour24 = _now.hour;
//     final period = hour24 >= 12 ? 'PM' : 'AM';
//     final hour12 = hour24 % 12 == 0 ? 12 : hour24 % 12;
//     final m = _now.minute.toString().padLeft(2, '0');
//     final s = _now.second.toString().padLeft(2, '0');
//     return '$hour12:$m:$s $period';
//   }

//   // Converts a 24-hour "HH:MM" (or "HH:MM:SS"/longer) string -- the shape
//   // every actualTime.substring(11, 16) call site below produces -- into
//   // 12-hour clock with AM/PM (e.g. "3:29 PM"). Keeps these locally-computed
//   // strings (used for the immediate "Attendance marked!"/cache feedback,
//   // before the server round-trip lands) visually consistent with what the
//   // backend's time/outTime fields now return via local_time_str_iso.
//   String _to12Hour(String hhmm) {
//     final parts = hhmm.split(':');
//     if (parts.length < 2) return hhmm;
//     final h = int.tryParse(parts[0]);
//     if (h == null) return hhmm;
//     final m = parts[1];
//     final period = h >= 12 ? 'PM' : 'AM';
//     final h12 = h % 12 == 0 ? 12 : h % 12;
//     return '$h12:$m $period';
//   }

//   String get _dateString {
//     const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
//     const months = [
//       'Jan',
//       'Feb',
//       'Mar',
//       'Apr',
//       'May',
//       'Jun',
//       'Jul',
//       'Aug',
//       'Sep',
//       'Oct',
//       'Nov',
//       'Dec'
//     ];
//     return '${days[_now.weekday - 1]}, ${_now.day} ${months[_now.month - 1]}';
//   }

//   // ─── Helper: aaj present hai (server ya cached) ───────────
//   bool get _isPresent => _todayPresent || _todayCachedPresent;
//   // ─────────────────────────────────────────────────────────

//   @override
//   Widget build(BuildContext context) {
//     return Scaffold(
//       backgroundColor: _bg,
//       body: SafeArea(
//         child: Stack(
//           children: [
//             Column(
//               children: [
//                 _buildHeader(),
//                 Expanded(
//                   child: IndexedStack(
//                     index: _currentTab,
//                     children: [
//                       _buildDashboard(),
//                       AttendanceHistoryScreen(user: widget.user),
//                       LeaveScreen(user: widget.user),
//                       OvertimeScreen(user: widget.user),
//                       ProfileScreen(user: widget.user),
//                     ],
//                   ),
//                 ),
//                 _buildBottomNav(),
//               ],
//             ),
//             HRChatbotWidget(user: widget.user),
//             NotificationPoller(
//               department: widget.user.department,
//               staffType: 'office',
//             ),
//           ],
//         ),
//       ),
//     );
//   }

//   Widget _buildHeader() {
//     return Container(
//       padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
//       decoration: BoxDecoration(
//         color: _card,
//         border:
//             Border(bottom: BorderSide(color: _indigo.withValues(alpha: 0.2))),
//       ),
//       child: Row(
//         children: [
//           Stack(children: [
//             Container(
//               width: 44,
//               height: 44,
//               decoration: BoxDecoration(
//                 shape: BoxShape.circle,
//                 gradient: const LinearGradient(
//                   colors: [AppTheme.navy700, AppTheme.navy600],
//                 ),
//                 boxShadow: [
//                   BoxShadow(
//                       color: _indigo.withValues(alpha: 0.4), blurRadius: 12)
//                 ],
//               ),
//               child: Center(
//                 child: Text(
//                   widget.user.name.isNotEmpty
//                       ? widget.user.name[0].toUpperCase()
//                       : 'O',
//                   style: const TextStyle(
//                       color: Colors.white,
//                       fontSize: 18,
//                       fontWeight: FontWeight.bold),
//                 ),
//               ),
//             ),
//             Positioned(
//               bottom: 1,
//               right: 1,
//               child: Container(
//                 width: 11,
//                 height: 11,
//                 decoration: BoxDecoration(
//                   color: _green,
//                   shape: BoxShape.circle,
//                   border: Border.all(color: _card, width: 2),
//                 ),
//               ),
//             ),
//           ]),
//           const SizedBox(width: 12),
//           Expanded(
//             child:
//                 Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
//               Text(widget.user.name,
//                   style: const TextStyle(
//                       color: AppTheme.headText,
//                       fontSize: 16,
//                       fontWeight: FontWeight.bold)),
//               Row(children: [
//                 const Icon(Icons.location_on, color: _indigo, size: 10),
//                 const SizedBox(width: 3),
//                 const Text('Office Staff',
//                     style: TextStyle(color: _indigo, fontSize: 11)),
//                 if (_hasPendingCache) ...[
//                   const SizedBox(width: 8),
//                   Container(
//                     padding:
//                         const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
//                     decoration: BoxDecoration(
//                       color: _amber.withValues(alpha: 0.15),
//                       borderRadius: BorderRadius.circular(6),
//                       border: Border.all(color: _amber.withValues(alpha: 0.4)),
//                     ),
//                     child: Row(mainAxisSize: MainAxisSize.min, children: [
//                       const Icon(Icons.cloud_off, color: _amber, size: 9),
//                       const SizedBox(width: 3),
//                       Text('Cached $_cachedTime',
//                           style: const TextStyle(
//                               color: _amber,
//                               fontSize: 9,
//                               fontWeight: FontWeight.w600)),
//                     ]),
//                   ),
//                 ],
//               ]),
//             ]),
//           ),
//           GestureDetector(
//             onTap: _refreshing ? null : _refreshAll,
//             child: Container(
//               padding: const EdgeInsets.all(8),
//               margin: const EdgeInsets.only(right: 8),
//               decoration: BoxDecoration(
//                 color: _indigo.withValues(alpha: 0.1),
//                 borderRadius: BorderRadius.circular(10),
//                 border: Border.all(color: _indigo.withValues(alpha: 0.2)),
//               ),
//               child: _refreshing
//                   ? const SizedBox(
//                       width: 14,
//                       height: 14,
//                       child: CircularProgressIndicator(
//                           color: _indigo, strokeWidth: 2))
//                   : const Icon(Icons.refresh_rounded, color: _indigo, size: 16),
//             ),
//           ),
//           GestureDetector(
//             onTap: () async {
//               await AuthService.logout();
//               if (context.mounted) {
//                 Navigator.pushReplacement(context,
//                     MaterialPageRoute(builder: (_) => const LoginScreen()));
//               }
//             },
//             child: Container(
//               padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
//               decoration: BoxDecoration(
//                 color: _red.withValues(alpha: 0.1),
//                 borderRadius: BorderRadius.circular(10),
//                 border: Border.all(color: _red.withValues(alpha: 0.2)),
//               ),
//               child: Row(children: [
//                 const Icon(Icons.logout, color: _red, size: 14),
//                 const SizedBox(width: 4),
//                 const Text('Out',
//                     style: TextStyle(
//                         color: _red,
//                         fontSize: 11,
//                         fontWeight: FontWeight.w600)),
//               ]),
//             ),
//           ),
//         ],
//       ),
//     );
//   }

//   Widget _buildDashboard() {
//     return SingleChildScrollView(
//       padding: const EdgeInsets.fromLTRB(14, 14, 14, 0),
//       child: Column(children: [
//         _buildClockCard(),
//         const SizedBox(height: 10),
//         _buildTodayStatus(),
//         const SizedBox(height: 10),
//         _buildStatsRow(),
//         const SizedBox(height: 10),
//         _buildLeaveStats(),
//         const SizedBox(height: 10),
//         _buildOvertimeStats(),
//         const SizedBox(height: 10),
//         _buildQuickActions(),
//         const SizedBox(height: 10),
//         _buildRecentLeaves(),
//         const SizedBox(height: 80),
//       ]),
//     );
//   }

//   Widget _buildClockCard() {
//     return Container(
//       width: double.infinity,
//       padding: const EdgeInsets.all(20),
//       decoration: BoxDecoration(
//         gradient: const LinearGradient(
//           colors: [AppTheme.navy700, AppTheme.navy600, AppTheme.navy700],
//           begin: Alignment.topLeft,
//           end: Alignment.bottomRight,
//         ),
//         borderRadius: BorderRadius.circular(20),
//         border: Border.all(color: _indigo.withValues(alpha: 0.3)),
//       ),
//       child: Stack(children: [
//         Positioned(
//           top: -20,
//           right: -20,
//           child: Container(
//             width: 100,
//             height: 100,
//             decoration: BoxDecoration(
//               shape: BoxShape.circle,
//               color: _indigo.withValues(alpha: 0.1),
//             ),
//           ),
//         ),
//         Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
//           Text(_dateString,
//               style: const TextStyle(color: Color(0x80FFFFFF), fontSize: 12)),
//           const SizedBox(height: 4),
//           Text(_timeString,
//               style: const TextStyle(
//                   color: Colors.white,
//                   fontSize: 32,
//                   fontWeight: FontWeight.w700,
//                   letterSpacing: 2)),
//           const SizedBox(height: 8),
//           Row(children: [
//             const Icon(Icons.location_on, color: _indigo, size: 12),
//             const SizedBox(width: 6),
//             Text('${widget.user.department} • Office',
//                 style: const TextStyle(color: Color(0x99FFFFFF), fontSize: 12)),
//           ]),
//         ]),
//       ]),
//     );
//   }

//   Widget _buildTodayStatus() {
//     // ─── CHANGED: _isPresent use karo (server ya cached dono) ─
//     return Container(
//       padding: const EdgeInsets.all(16),
//       decoration: BoxDecoration(
//         color: _card,
//         borderRadius: BorderRadius.circular(16),
//         border: Border.all(
//           color: (_initialLoading && !_todayCachedPresent)
//               ? AppTheme.mutedText.withValues(alpha: 0.2) // unresolved = neutral
//               : (_checkInHoldReason != null || _checkOutHoldReason != null)
//                   ? _amber.withValues(alpha: 0.4) // pending review = amber
//                   : _todayPresent
//                       ? _green.withValues(alpha: 0.3)
//                       : _todayCachedPresent
//                           ? _amber.withValues(alpha: 0.4) // cached = amber border
//                           : _hasPendingCache
//                               ? _amber.withValues(alpha: 0.3)
//                               : _red.withValues(alpha: 0.2),
//         ),
//       ),
//       child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
//         const Text("TODAY'S STATUS",
//             style: TextStyle(
//                 color: AppTheme.mutedText,
//                 fontSize: 10,
//                 fontWeight: FontWeight.w700,
//                 letterSpacing: 1.5)),
//         const SizedBox(height: 12),

//         // ─── Still resolving real state — never show an assumed status or
//         // a tappable button here. _todayCachedPresent is known instantly
//         // from local storage (no network round-trip), so it's excluded
//         // from this gate and can render right away as before.
//         if (_initialLoading && !_todayCachedPresent) ...[
//           Row(children: const [
//             SizedBox(
//               width: 18,
//               height: 18,
//               child: CircularProgressIndicator(color: _indigo, strokeWidth: 2),
//             ),
//             SizedBox(width: 10),
//             Text('Checking today\'s status…',
//                 style: TextStyle(
//                     color: AppTheme.mutedText,
//                     fontSize: 13,
//                     fontWeight: FontWeight.w600)),
//           ]),

//           // ─── Pending Review — a late check-in or an early/late checkout
//           // is recorded (per the mobile UX contract: mark right away, never
//           // block on an admin) but still awaiting resolve_attendance_exception.
//           // Outranks the plain Present/Checked-Out display, matching the
//           // backend's own status_label priority.
//         ] else if (_checkInHoldReason != null || _checkOutHoldReason != null) ...[
//           Row(children: [
//             const Icon(Icons.hourglass_top, color: _amber, size: 20),
//             const SizedBox(width: 8),
//             const Text('Pending Review',
//                 style: TextStyle(
//                     color: _amber, fontSize: 16, fontWeight: FontWeight.bold)),
//           ]),
//           const SizedBox(height: 10),
//           Row(children: [
//             _timeBox('Check In', _todayTime, _amber),
//             const SizedBox(width: 16),
//             if (_todayOutTime.isNotEmpty)
//               _timeBox('Check Out', _todayOutTime, _amber),
//             if (_todayDuration.isNotEmpty)
//               _timeBox('Duration', _todayDuration, _indigo),
//           ]),
//           const SizedBox(height: 12),
//           Container(
//             padding: const EdgeInsets.all(12),
//             decoration: BoxDecoration(
//               color: _amber.withValues(alpha: 0.08),
//               borderRadius: BorderRadius.circular(10),
//               border: Border.all(color: _amber.withValues(alpha: 0.35)),
//             ),
//             child: Row(
//               children: [
//                 const Icon(Icons.admin_panel_settings, color: _amber, size: 16),
//                 const SizedBox(width: 8),
//                 Expanded(
//                   child: Text(
//                     _todayNotes ??
//                         (_checkOutHoldReason != null
//                             ? 'Your checkout was recorded and is awaiting admin review.'
//                             : 'Your check-in was recorded and is awaiting admin review.'),
//                     style: const TextStyle(
//                         color: _amber, fontSize: 12, height: 1.4),
//                   ),
//                 ),
//               ],
//             ),
//           ),
//           // Checkout can still be offered while a LATE CHECK-IN is pending
//           // review -- the two legs are independent; only a pending
//           // checkout itself should hide the (already-used) button.
//           if (_captureCheckOut && !_checkedOut && _checkOutHoldReason == null) ...[
//             const SizedBox(height: 14),
//             GestureDetector(
//               onTap: _marking ? null : _markAttendance,
//               child: Container(
//                 width: double.infinity,
//                 padding: const EdgeInsets.symmetric(vertical: 14),
//                 decoration: BoxDecoration(
//                   gradient: LinearGradient(
//                     colors: _marking
//                         ? [Colors.grey.shade800, Colors.grey.shade700]
//                         : [AppTheme.teal700, AppTheme.teal700],
//                   ),
//                   borderRadius: BorderRadius.circular(14),
//                 ),
//                 child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
//                   if (_marking)
//                     const SizedBox(
//                         width: 16,
//                         height: 16,
//                         child: CircularProgressIndicator(
//                             color: Colors.white, strokeWidth: 2))
//                   else
//                     const Icon(Icons.logout, color: Colors.white, size: 18),
//                   const SizedBox(width: 8),
//                   Text(_marking ? 'CHECKING OUT...' : 'CHECK OUT',
//                       style: const TextStyle(
//                           color: Colors.white,
//                           fontSize: 14,
//                           fontWeight: FontWeight.w800,
//                           letterSpacing: 0.5)),
//                 ]),
//               ),
//             ),
//           ],

//           // ─── Server confirmed Present ──────────────────────
//         ] else if (_todayPresent) ...[
//           Row(children: [
//             Icon(_checkedOut ? Icons.task_alt : Icons.check_circle,
//                 color: _green, size: 20),
//             const SizedBox(width: 8),
//             Text(_checkedOut ? 'Checked Out' : 'Present',
//                 style: const TextStyle(
//                     color: _green, fontSize: 16, fontWeight: FontWeight.bold)),
//             const SizedBox(width: 8),
//             if (!_checkedOut)
//               Container(
//                 padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
//                 decoration: BoxDecoration(
//                   color: _green.withValues(alpha: 0.15),
//                   borderRadius: BorderRadius.circular(10),
//                   border: Border.all(color: _green.withValues(alpha: 0.3)),
//                 ),
//                 child: Text(
//                     _checkInStatus == 'early' ? 'EARLY' : 'ON TIME',
//                     style: const TextStyle(
//                         color: _green,
//                         fontSize: 10,
//                         fontWeight: FontWeight.bold)),
//               ),
//           ]),
//           if (_shiftName != null || _scheduledCheckInTime.isNotEmpty) ...[
//             const SizedBox(height: 6),
//             _shiftInfoLine(),
//           ],
//           const SizedBox(height: 10),
//           Row(children: [
//             _timeBox('Check In', _todayTime, _blue),
//             const SizedBox(width: 16),
//             if (_todayOutTime.isNotEmpty)
//               _timeBox('Check Out', _todayOutTime, _blue),
//             if (_todayDuration.isNotEmpty)
//               _timeBox('Duration', _todayDuration, _indigo),
//           ]),
//           // check-in-side note (e.g. "checked in earlier than shift start")
//           // survives even after checkout, since check_in_write_fields wrote
//           // it once and check_out_write_fields only appends to it.
//           if (_todayNotes != null && _todayNotes!.isNotEmpty) ...[
//             const SizedBox(height: 10),
//             Container(
//               padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
//               decoration: BoxDecoration(
//                 color: _blue.withValues(alpha: 0.08),
//                 borderRadius: BorderRadius.circular(8),
//               ),
//               child: Text(_todayNotes!,
//                   style: const TextStyle(
//                       color: AppTheme.mutedText, fontSize: 11, height: 1.3)),
//             ),
//           ],
//           // Driven by _markSuccess (a real boolean already returned by the
//           // API) rather than sniffing _markMsg for an emoji character --
//           // the emoji was both a fragile match condition and the thing the
//           // icon/toast cleanup below is removing.
//           if (_markSuccess && _markMsg.isNotEmpty) ...[
//             const SizedBox(height: 10),
//             Container(
//               padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
//               decoration: BoxDecoration(
//                 color: _green.withValues(alpha: 0.1),
//                 borderRadius: BorderRadius.circular(8),
//                 border: Border.all(color: _green.withValues(alpha: 0.3)),
//               ),
//               child: Row(mainAxisSize: MainAxisSize.min, children: [
//                 const Icon(Icons.check_circle, color: _green, size: 12),
//                 const SizedBox(width: 4),
//                 Text(_markMsg,
//                     style: const TextStyle(
//                         color: _green,
//                         fontSize: 11,
//                         fontWeight: FontWeight.w600)),
//               ]),
//             ),
//           ],

//           // ─── Check Out button — only when this shift's resolved window
//           // has capture_check_out enabled (see get_client_staff_attendance_today
//           // on the backend) and checkout hasn't happened yet. Reuses the
//           // same _markAttendance() call as check-in: the backend already
//           // decides insert-vs-update based on today's existing row, so no
//           // separate "checkout" method is needed on either side.
//           if (_captureCheckOut && !_checkedOut) ...[
//             const SizedBox(height: 14),
//             GestureDetector(
//               onTap: _marking ? null : _markAttendance,
//               child: Container(
//                 width: double.infinity,
//                 padding: const EdgeInsets.symmetric(vertical: 14),
//                 decoration: BoxDecoration(
//                   gradient: LinearGradient(
//                     colors: _marking
//                         ? [Colors.grey.shade800, Colors.grey.shade700]
//                         : [_red, Colors.red.shade700],
//                   ),
//                   borderRadius: BorderRadius.circular(14),
//                   boxShadow: _marking
//                       ? null
//                       : [
//                           BoxShadow(
//                               color: _red.withValues(alpha: 0.3),
//                               blurRadius: 16,
//                               offset: const Offset(0, 4))
//                         ],
//                 ),
//                 child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
//                   if (_marking)
//                     const SizedBox(
//                         width: 16,
//                         height: 16,
//                         child: CircularProgressIndicator(
//                             color: Colors.white, strokeWidth: 2))
//                   else
//                     const Icon(Icons.logout, color: Colors.white, size: 18),
//                   const SizedBox(width: 8),
//                   Text(_marking ? 'CHECKING OUT...' : 'CHECK OUT',
//                       style: const TextStyle(
//                           color: Colors.white,
//                           fontSize: 14,
//                           fontWeight: FontWeight.w800,
//                           letterSpacing: 0.5)),
//                 ]),
//               ),
//             ),
//           ],

//           // ─── NAYA: Cached Present (locally marked, server pending) ─
//         ] else if (_todayCachedPresent) ...[
//           Row(children: [
//             const Icon(Icons.cloud_off, color: _amber, size: 20),
//             const SizedBox(width: 8),
//             Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
//               const Text('Present (Offline)',
//                   style: TextStyle(
//                       color: _amber,
//                       fontSize: 16,
//                       fontWeight: FontWeight.bold)),
//               Text('Check-in: $_cachedTime • Syncing when server is reachable',
//                   style:
//                       const TextStyle(color: AppTheme.mutedText, fontSize: 11)),
//             ]),
//           ]),
//           const SizedBox(height: 10),
//           Row(children: [
//             _timeBox('Check In', _todayTime, _amber),
//             const SizedBox(width: 16),
//             _timeBox('Status', 'Pending Sync', _amber),
//           ]),
//           const SizedBox(height: 12),
//           // Amber banner
//           Container(
//             padding: const EdgeInsets.all(12),
//             decoration: BoxDecoration(
//               color: _amber.withValues(alpha: 0.08),
//               borderRadius: BorderRadius.circular(10),
//               border: Border.all(color: _amber.withValues(alpha: 0.35)),
//             ),
//             child: Row(
//               children: [
//                 const Icon(Icons.sync, color: _amber, size: 16),
//                 const SizedBox(width: 8),
//                 Expanded(
//                   child: Text(
//                     'Attendance saved locally. Will sync automatically when the server is reachable, or tap "RETRY SYNC NOW" below.',
//                     style: const TextStyle(
//                         color: _amber, fontSize: 12, height: 1.4),
//                   ),
//                 ),
//               ],
//             ),
//           ),
//           const SizedBox(height: 10),
//           // RETRY SYNC button
//           GestureDetector(
//             onTap: _marking ? null : _syncPending,
//             child: Container(
//               width: double.infinity,
//               padding: const EdgeInsets.symmetric(vertical: 12),
//               decoration: BoxDecoration(
//                 color: _amber,
//                 borderRadius: BorderRadius.circular(12),
//                 boxShadow: [
//                   BoxShadow(
//                       color: _amber.withValues(alpha: 0.25),
//                       blurRadius: 16,
//                       offset: const Offset(0, 4))
//                 ],
//               ),
//               child:
//                   Row(mainAxisAlignment: MainAxisAlignment.center, children: [
//                 const Icon(Icons.sync, color: Colors.white, size: 16),
//                 const SizedBox(width: 8),
//                 const Text('RETRY SYNC NOW',
//                     style: TextStyle(
//                         color: Colors.white,
//                         fontSize: 13,
//                         fontWeight: FontWeight.w800,
//                         letterSpacing: 0.5)),
//               ]),
//             ),
//           ),

//           // ─── Not marked yet ────────────────────────────────
//         ] else ...[
//           Row(children: [
//             const Icon(Icons.cancel, color: _red, size: 20),
//             const SizedBox(width: 8),
//             Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
//               const Text('Not Marked Yet',
//                   style: TextStyle(
//                       color: _red, fontSize: 15, fontWeight: FontWeight.bold)),
//               const Text('Mark your attendance below',
//                   style: TextStyle(color: AppTheme.mutedText, fontSize: 11)),
//             ]),
//           ]),
//           if (_shiftName != null || _scheduledCheckInTime.isNotEmpty) ...[
//             const SizedBox(height: 8),
//             _shiftInfoLine(),
//           ],
//           const SizedBox(height: 14),
//           if (_markMsg.isNotEmpty) ...[
//             Container(
//               margin: const EdgeInsets.only(bottom: 10),
//               padding: const EdgeInsets.all(12),
//               decoration: BoxDecoration(
//                 color: _hasPendingCache
//                     ? _amber.withValues(alpha: 0.1)
//                     : _markSuccess
//                         ? _green.withValues(alpha: 0.1)
//                         : _red.withValues(alpha: 0.1),
//                 borderRadius: BorderRadius.circular(10),
//                 border: Border.all(
//                     color: _hasPendingCache
//                         ? _amber.withValues(alpha: 0.4)
//                         : _markSuccess
//                             ? _green.withValues(alpha: 0.3)
//                             : _red.withValues(alpha: 0.3)),
//               ),
//               child: Row(
//                 crossAxisAlignment: CrossAxisAlignment.start,
//                 children: [
//                   Icon(
//                     _hasPendingCache
//                         ? Icons.cloud_off
//                         : _markSuccess
//                             ? Icons.check_circle
//                             : Icons.error_outline,
//                     color: _hasPendingCache
//                         ? _amber
//                         : _markSuccess
//                             ? _green
//                             : _red,
//                     size: 16,
//                   ),
//                   const SizedBox(width: 8),
//                   Expanded(
//                     child: Text(_markMsg,
//                         style: TextStyle(
//                             color: _hasPendingCache
//                                 ? _amber
//                                 : _markSuccess
//                                     ? _green
//                                     : _red,
//                             fontSize: 12,
//                             height: 1.4)),
//                   ),
//                 ],
//               ),
//             ),
//           ],
//           GestureDetector(
//             onTap: _marking ? null : _markAttendance,
//             child: Container(
//               width: double.infinity,
//               padding: const EdgeInsets.symmetric(vertical: 14),
//               decoration: BoxDecoration(
//                 gradient: LinearGradient(
//                   colors: _marking
//                       ? [Colors.grey.shade800, Colors.grey.shade700]
//                       : [_indigo, AppTheme.navy600],
//                 ),
//                 borderRadius: BorderRadius.circular(12),
//                 boxShadow: _marking
//                     ? []
//                     : [
//                         BoxShadow(
//                             color: _indigo.withValues(alpha: 0.3),
//                             blurRadius: 20,
//                             offset: const Offset(0, 4))
//                       ],
//               ),
//               child:
//                   Row(mainAxisAlignment: MainAxisAlignment.center, children: [
//                 if (_marking)
//                   const SizedBox(
//                     width: 18,
//                     height: 18,
//                     child: CircularProgressIndicator(
//                         color: Colors.white, strokeWidth: 2),
//                   )
//                 else
//                   const Icon(Icons.how_to_reg, color: Colors.white, size: 18),
//                 const SizedBox(width: 8),
//                 Text(_marking ? 'CHECKING IN...' : 'CHECK IN',
//                     style: const TextStyle(
//                         color: Colors.white,
//                         fontSize: 14,
//                         fontWeight: FontWeight.w800,
//                         letterSpacing: 0.5)),
//               ]),
//             ),
//           ),
//         ],
//       ]),
//     );
//   }
//   // ─────────────────────────────────────────────────────────

//   Widget _timeBox(String label, String value, Color color) {
//     return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
//       Text(label,
//           style: const TextStyle(color: AppTheme.mutedText, fontSize: 10)),
//       const SizedBox(height: 2),
//       Text(value,
//           style: TextStyle(
//               color: color, fontSize: 15, fontWeight: FontWeight.w600)),
//     ]);
//   }

//   // Small "Shift: Morning Shift · 09:00 - 17:00" subtitle, shown both
//   // before and after marking. Times are branch-local HH:MM straight from
//   // the server (get_client_staff_attendance_today's scheduled_check_in_time/
//   // scheduled_check_out_time) — never computed client-side, so this can
//   // never drift from what the backend actually enforces.
//   Widget _shiftInfoLine() {
//     final parts = <String>[];
//     if (_shiftName != null && _shiftName!.isNotEmpty) parts.add(_shiftName!);
//     if (_scheduledCheckInTime.isNotEmpty) {
//       parts.add(_scheduledCheckOutTime.isNotEmpty
//           ? '$_scheduledCheckInTime - $_scheduledCheckOutTime'
//           : _scheduledCheckInTime);
//     }
//     if (parts.isEmpty) return const SizedBox.shrink();
//     return Row(children: [
//       const Icon(Icons.schedule, color: AppTheme.mutedText, size: 13),
//       const SizedBox(width: 4),
//       Text(parts.join(' · '),
//           style: const TextStyle(color: AppTheme.mutedText, fontSize: 11)),
//     ]);
//   }

//   Widget _buildStatsRow() {
//     return Row(children: [
//       _statCard(Icons.check_circle_outline, '$_presentDays', 'Present', _green),
//       const SizedBox(width: 8),
//       _statCard(Icons.cancel_outlined, '$_absentDays', 'Absent', _red),
//       const SizedBox(width: 8),
//       _statCard(Icons.bar_chart_rounded, '$_attendanceRate%', 'Rate', _indigo),
//     ]);
//   }

//   Widget _statCard(IconData icon, String value, String label, Color color) {
//     return Expanded(
//       child: Container(
//         padding: const EdgeInsets.symmetric(vertical: 14),
//         decoration: BoxDecoration(
//           color: _card,
//           borderRadius: BorderRadius.circular(14),
//           border: Border.all(color: color.withValues(alpha: 0.22)),
//         ),
//         child: Column(children: [
//           Icon(icon, color: color, size: 20),
//           const SizedBox(height: 4),
//           Text(value,
//               style: TextStyle(
//                   color: color, fontSize: 20, fontWeight: FontWeight.w700)),
//           const SizedBox(height: 2),
//           Text(label,
//               style: const TextStyle(
//                   color: AppTheme.mutedText,
//                   fontSize: 10,
//                   fontWeight: FontWeight.w700)),
//         ]),
//       ),
//     );
//   }

//   Widget _buildLeaveStats() {
//     return Container(
//       padding: const EdgeInsets.all(16),
//       decoration: BoxDecoration(
//         color: _card,
//         borderRadius: BorderRadius.circular(16),
//         border: Border.all(color: AppTheme.borderColor),
//       ),
//       child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
//         const Text('LEAVE SUMMARY',
//             style: TextStyle(
//                 color: AppTheme.mutedText,
//                 fontSize: 10,
//                 fontWeight: FontWeight.w700,
//                 letterSpacing: 1.5)),
//         const SizedBox(height: 12),
//         Row(children: [
//           _miniStatCard('PENDING', '$_pendingLeaves', _amber),
//           const SizedBox(width: 8),
//           _miniStatCard('APPROVED', '$_approvedLeaves', _green),
//           const SizedBox(width: 8),
//           _miniStatCard('REJECTED', '$_rejectedLeaves', _red),
//           const SizedBox(width: 8),
//           _miniStatCard('TOTAL',
//               '${_pendingLeaves + _approvedLeaves + _rejectedLeaves}', _indigo),
//         ]),
//       ]),
//     );
//   }

//   Widget _miniStatCard(String label, String value, Color color) {
//     return Expanded(
//       child: Container(
//         padding: const EdgeInsets.symmetric(vertical: 12),
//         decoration: BoxDecoration(
//           color: color.withValues(alpha: 0.08),
//           borderRadius: BorderRadius.circular(12),
//           border: Border.all(color: color.withValues(alpha: 0.2)),
//         ),
//         child: Column(children: [
//           Text(value,
//               style: TextStyle(
//                   color: color, fontSize: 20, fontWeight: FontWeight.w700)),
//           const SizedBox(height: 2),
//           Text(label,
//               style: const TextStyle(
//                   color: AppTheme.mutedText,
//                   fontSize: 8,
//                   fontWeight: FontWeight.w700,
//                   letterSpacing: 0.5)),
//         ]),
//       ),
//     );
//   }

//   Widget _buildOvertimeStats() {
//     return Row(children: [
//       Expanded(
//         child: Container(
//           padding: const EdgeInsets.all(16),
//           decoration: BoxDecoration(
//             color: _card,
//             borderRadius: BorderRadius.circular(14),
//             border: Border.all(color: _indigo.withValues(alpha: 0.2)),
//           ),
//           child:
//               Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
//             Row(children: [
//               const Icon(Icons.more_time, color: _indigo, size: 16),
//               const SizedBox(width: 8),
//               const Text('TOTAL OVERTIME',
//                   style: TextStyle(
//                       color: AppTheme.mutedText,
//                       fontSize: 10,
//                       fontWeight: FontWeight.w700)),
//             ]),
//             const SizedBox(height: 6),
//             Text('${_totalOvertimeHours.toStringAsFixed(1)} hrs',
//                 style: const TextStyle(
//                     color: AppTheme.headText,
//                     fontSize: 22,
//                     fontWeight: FontWeight.w700)),
//           ]),
//         ),
//       ),
//       const SizedBox(width: 10),
//       Expanded(
//         child: Container(
//           padding: const EdgeInsets.all(16),
//           decoration: BoxDecoration(
//             color: _card,
//             borderRadius: BorderRadius.circular(14),
//             border: Border.all(color: _amber.withValues(alpha: 0.2)),
//           ),
//           child:
//               Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
//             Row(children: [
//               const Icon(Icons.pending_actions, color: _amber, size: 16),
//               const SizedBox(width: 8),
//               const Text('PENDING',
//                   style: TextStyle(
//                       color: AppTheme.mutedText,
//                       fontSize: 10,
//                       fontWeight: FontWeight.w700)),
//             ]),
//             const SizedBox(height: 6),
//             Text('$_pendingOvertimeCount',
//                 style: const TextStyle(
//                     color: _amber, fontSize: 22, fontWeight: FontWeight.w700)),
//           ]),
//         ),
//       ),
//     ]);
//   }

//   Widget _buildQuickActions() {
//     final actions = [
//       {
//         'icon': Icons.beach_access,
//         'label': 'Apply Leave',
//         'color': _indigo,
//         'onTap': () => setState(() => _currentTab = 2)
//       },
//       {
//         'icon': Icons.more_time,
//         'label': 'Overtime',
//         'color': _amber,
//         'onTap': () => setState(() => _currentTab = 3)
//       },
//       {
//         'icon': Icons.calendar_month,
//         'label': 'History',
//         'color': _teal,
//         'onTap': () => setState(() => _currentTab = 1)
//       },
//       {
//         'icon': Icons.person_outline,
//         'label': 'My Profile',
//         'color': _green,
//         'onTap': () => setState(() => _currentTab = 4)
//       },
//     ];

//     return Container(
//       padding: const EdgeInsets.all(16),
//       decoration: BoxDecoration(
//         color: _card,
//         borderRadius: BorderRadius.circular(16),
//         border: Border.all(color: AppTheme.borderColor),
//       ),
//       child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
//         const Text('QUICK ACTIONS',
//             style: TextStyle(
//                 color: AppTheme.mutedText,
//                 fontSize: 10,
//                 fontWeight: FontWeight.w700,
//                 letterSpacing: 1.5)),
//         const SizedBox(height: 12),
//         GridView.count(
//           crossAxisCount: 2,
//           shrinkWrap: true,
//           physics: const NeverScrollableScrollPhysics(),
//           crossAxisSpacing: 8,
//           mainAxisSpacing: 8,
//           childAspectRatio: 2.5,
//           children: actions.map((a) {
//             final color = a['color'] as Color;
//             return GestureDetector(
//               onTap: a['onTap'] as VoidCallback,
//               child: Container(
//                 padding:
//                     const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
//                 decoration: BoxDecoration(
//                   color: color.withValues(alpha: 0.1),
//                   borderRadius: BorderRadius.circular(12),
//                   border: Border.all(color: color.withValues(alpha: 0.25)),
//                 ),
//                 child: Row(children: [
//                   Icon(a['icon'] as IconData, color: color, size: 18),
//                   const SizedBox(width: 8),
//                   Expanded(
//                       child: Text(a['label'] as String,
//                           style: const TextStyle(
//                               color: AppTheme.headText,
//                               fontSize: 12,
//                               fontWeight: FontWeight.w600),
//                           overflow: TextOverflow.ellipsis)),
//                   Icon(Icons.chevron_right, color: color, size: 16),
//                 ]),
//               ),
//             );
//           }).toList(),
//         ),
//       ]),
//     );
//   }

//   Widget _buildRecentLeaves() {
//     return Container(
//       padding: const EdgeInsets.all(16),
//       decoration: BoxDecoration(
//         color: _card,
//         borderRadius: BorderRadius.circular(16),
//         border: Border.all(color: AppTheme.borderColor),
//       ),
//       child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
//         Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
//           const Text('RECENT LEAVES',
//               style: TextStyle(
//                   color: AppTheme.mutedText,
//                   fontSize: 10,
//                   fontWeight: FontWeight.w700,
//                   letterSpacing: 1.5)),
//           GestureDetector(
//             onTap: () => setState(() => _currentTab = 2),
//             child: const Text('View All',
//                 style: TextStyle(
//                     color: _indigo, fontSize: 11, fontWeight: FontWeight.w600)),
//           ),
//         ]),
//         const SizedBox(height: 12),
//         if (_recentLeaves.isEmpty)
//           const Center(
//             child: Padding(
//               padding: EdgeInsets.symmetric(vertical: 10),
//               child: Text('No recent leaves',
//                   style: TextStyle(color: AppTheme.mutedText, fontSize: 13)),
//             ),
//           )
//         else
//           ...List.generate(_recentLeaves.length, (i) {
//             final leave = _recentLeaves[i];
//             final status = leave['status'] ?? 'Pending';
//             Color sc = _amber;
//             if (status == 'Approved') sc = _green;
//             if (status == 'Rejected') sc = _red;
//             final leaveType = leave['type'] ?? leave['leave_type'] ?? '';
//             final startDate = leave['startDate'] ?? leave['start_date'] ?? '';
//             final endDate = leave['endDate'] ?? leave['end_date'] ?? '';
//             return Container(
//               padding: const EdgeInsets.symmetric(vertical: 10),
//               decoration: BoxDecoration(
//                 border: i < _recentLeaves.length - 1
//                     ? Border(
//                         bottom: BorderSide(
//                             color: AppTheme.borderColor.withValues(alpha: 0.6)))
//                     : null,
//               ),
//               child: Row(children: [
//                 Expanded(
//                     child: Column(
//                         crossAxisAlignment: CrossAxisAlignment.start,
//                         children: [
//                       Text(leaveType,
//                           style: const TextStyle(
//                               color: AppTheme.bodyText,
//                               fontSize: 13,
//                               fontWeight: FontWeight.w600)),
//                       const SizedBox(height: 3),
//                       Text('$startDate → $endDate',
//                           style: const TextStyle(
//                               color: AppTheme.mutedText, fontSize: 11)),
//                     ])),
//                 Container(
//                   padding:
//                       const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
//                   decoration: BoxDecoration(
//                     color: sc.withValues(alpha: 0.15),
//                     borderRadius: BorderRadius.circular(20),
//                     border: Border.all(color: sc.withValues(alpha: 0.3)),
//                   ),
//                   child: Text(status,
//                       style: TextStyle(
//                           color: sc,
//                           fontSize: 11,
//                           fontWeight: FontWeight.bold)),
//                 ),
//               ]),
//             );
//           }),
//       ]),
//     );
//   }

//   Widget _buildBottomNav() {
//     final tabs = [
//       {'icon': Icons.home_rounded, 'label': 'Home'},
//       {'icon': Icons.calendar_month, 'label': 'Attendance'},
//       {'icon': Icons.article_outlined, 'label': 'Leave'},
//       {'icon': Icons.more_time, 'label': 'Overtime'},
//       {'icon': Icons.person_outline, 'label': 'Profile'},
//     ];

//     return Container(
//       decoration: BoxDecoration(
//         color: _card,
//         border: Border(
//             top: BorderSide(color: AppTheme.borderColor)),
//       ),
//       padding: const EdgeInsets.fromLTRB(0, 8, 0, 12),
//       child: Row(
//         mainAxisAlignment: MainAxisAlignment.spaceAround,
//         children: List.generate(tabs.length, (i) {
//           final isActive = _currentTab == i;
//           return GestureDetector(
//             onTap: () => setState(() => _currentTab = i),
//             child: Container(
//               color: Colors.transparent,
//               padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
//               child: Column(mainAxisSize: MainAxisSize.min, children: [
//                 Container(
//                   width: 40,
//                   height: 32,
//                   decoration: BoxDecoration(
//                     borderRadius: BorderRadius.circular(10),
//                     gradient: isActive
//                         ? const LinearGradient(
//                             colors: [AppTheme.navy700, AppTheme.navy600])
//                         : null,
//                     boxShadow: isActive
//                         ? [
//                             BoxShadow(
//                                 color: _indigo.withValues(alpha: 0.4),
//                                 blurRadius: 12)
//                           ]
//                         : null,
//                   ),
//                   child: Icon(tabs[i]['icon'] as IconData,
//                       color: isActive ? Colors.white : AppTheme.mutedText,
//                       size: 18),
//                 ),
//                 const SizedBox(height: 3),
//                 Text(tabs[i]['label'] as String,
//                     style: TextStyle(
//                         color: isActive ? _indigo : AppTheme.mutedText,
//                         fontSize: 10,
//                         fontWeight:
//                             isActive ? FontWeight.w700 : FontWeight.w400)),
//               ]),
//             ),
//           );
//         }),
//       ),
//     );
//   }
// }

import 'dart:async';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:network_info_plus/network_info_plus.dart';
import 'package:toastification/toastification.dart';
import '../../models/user_model.dart';
import '../../services/api_service.dart';
import '../../services/auth_service.dart';
import '../../services/offline_queue_service.dart';
import '../../utils/app_theme.dart';
import '../../utils/attendance_status.dart';
import '../../utils/attendance_summary.dart';
import '../../widgets/hr_chatbot_widget.dart';
import '../../widgets/notification_widget.dart';
import '../auth/login_screen.dart';
import '../shared/leave_screen.dart';
import '../shared/overtime_screen.dart';
import '../shared/attendance_history_screen.dart';
import '../shared/profile_screen.dart';

class OfficeHomeScreen extends StatefulWidget {
  final UserModel user;
  const OfficeHomeScreen({super.key, required this.user});

  @override
  State<OfficeHomeScreen> createState() => _OfficeHomeScreenState();
}

class _OfficeHomeScreenState extends State<OfficeHomeScreen> {
  int _currentTab = 0;
  late Timer _clockTimer;
  Timer? _wifiCheckTimer;
  Timer? _syncTimer;
  DateTime _now = DateTime.now();

  int _presentDays = 0;
  int _absentDays = 0;
  int _attendanceRate = 0;
  int _lateDays = 0;
  int _totalWorkingDays = 0;
  String? _attendanceStatsError;
  bool _todayPresent = false;

  // True until the very first _fetchAll() resolves. While true, the today
  // status card must not render "Not Marked Yet" + a CHECK IN button --
  // that assumed state is what let a tap race the network fetch and hit
  // the backend before it knew a check-in already existed today, turning
  // an intended check-in into an accidental checkout (backend correctly
  // saw an existing row and toggled it). Gating render, not just the
  // WiFi-auto-mark timer, closes the race for the manual button too.
  bool _initialLoading = true;

  // Non-null only while a late check-in / early-or-late checkout is still
  // awaiting admin resolution (support_db_attendance_exceptions.py). Drives
  // the "Pending Review" branch, which outranks the plain Present/Checked
  // Out display the same way the backend's own status_label priority does
  // (get_client_staff_attendance_history's status_label comment).
  String? _checkInHoldReason;
  String? _checkOutHoldReason;
  String? _todayNotes;
  // 'early' | 'on_time' | 'late' | 'unscheduled' — the real timing
  // classification, so the badge next to Check In can say what actually
  // happened instead of always claiming "ON TIME".
  String? _checkInStatus;

  // The shift actually resolved for this person today (branch → department
  // → staff-tier precedence chain, server-side) — previously computed by
  // the backend and discarded except for capture_check_out, so this screen
  // had no scheduled time to show at all. Null shift_name / empty times
  // just mean "unscheduled" (e.g. simple mode, or no shift assigned yet).
  String? _shiftName;
  String _scheduledCheckInTime = '';
  String _scheduledCheckOutTime = '';

  // Whether TODAY's resolved shift window allows a second (checkout) mark
  // at all — comes straight from mark_client_staff_attendance's response,
  // the same capture_check_out flag that already gates the backend's own
  // insert-vs-update decision. Without this the UI can't tell "checked in,
  // nothing more to do" apart from "checked in, checkout still pending."
  bool _captureCheckOut = false;
  bool _checkedOut = false;

  // ─── NEW: cached present = locally marked, not yet synced ─
  bool _todayCachedPresent = false; // ← NAYA FLAG
  // ─────────────────────────────────────────────────────────

  String _todayTime = '';
  String _todayOutTime = '';
  String _todayDuration = '';

  int _pendingLeaves = 0;
  int _approvedLeaves = 0;
  int _rejectedLeaves = 0;
  List<dynamic> _recentLeaves = [];

  double _totalOvertimeHours = 0;
  int _pendingOvertimeCount = 0;

  bool _marking = false;
  String _markMsg = '';
  bool _markSuccess = false;

  // ─── Cache status ─────────────────────────────────────────
  bool _hasPendingCache = false;
  String _cachedTime = '';
  // ─────────────────────────────────────────────────────────

  // ─── WiFi Config ─────────────────────────────────────────
  // Previously hardcoded per-build constants (_officeSSID/_officeBSSID),
  // meaning every office employee everywhere was checked against one
  // single network regardless of which branch they actually work at.
  // Now read from this employee's own assigned record — set per-staff
  // (and editable later) from the Client Dashboard's Staff Management
  // "Assigned Office WiFi Network" field, so it varies per company/branch
  // instead of being baked into the app build.
  //
  // NOTE: requires `officeSsid` (String?) and `officeBssidList` (List<
  // String>?) fields on UserModel, populated from /api/staff/me's
  // office_ssid / office_bssid_list. Add them there if not already
  // present -- everything below reads through these two getters only,
  // so that's the only place the model needs to change.
  String get _officeSSID => widget.user.officeSsid ?? '';
  List<String> get _officeBSSIDs => (widget.user.officeBssidList ?? const [])
      .map((b) => b.toLowerCase())
      .toList();

  // True once this employee has an office network assigned at all --
  // distinct from _isKnownOfficeNetwork's verdict on a *specific*
  // network. Mirrors the server's own evaluate_office_wifi 'configured'
  // field exactly (support_db_attendance_mobile.py) -- needed because
  // "not configured yet" and "configured, but this isn't it" must be
  // treated differently by the offline-cache gate below: the server
  // never rejects the former, only the latter, so the client can't
  // collapse both into the same false the way _isKnownOfficeNetwork
  // alone did before this existed.
  bool get _officeWifiConfigured => _officeBSSIDs.isNotEmpty;

  bool _isKnownOfficeNetwork(String ssid, String bssid) {
    if (_officeSSID.isEmpty || _officeBSSIDs.isEmpty) return false;
    if (ssid.isEmpty || ssid != _officeSSID) return false;
    if (bssid.isEmpty || !_officeBSSIDs.contains(bssid.toLowerCase())) {
      return false;
    }
    return true;
  }
  // ─────────────────────────────────────────────────────────

  // Local aliases kept so every call site below (~60 usages) stays
  // unchanged; only the source of truth moved to AppTheme. Do not
  // reintroduce raw hex here -- add a new AppTheme color instead.
  static const _bg = AppTheme.bgPage;
  static const _card = AppTheme.cardColor;
  static const _indigo = AppTheme.navy700; // primary/button accent
  static const _green = AppTheme.successColor;
  static const _red = AppTheme.error;
  static const _amber = AppTheme.amber;
  static const _blue = AppTheme.navy600;
  static const _teal = AppTheme.teal600;

  @override
  void initState() {
    super.initState();

    _clockTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() => _now = DateTime.now());
    });

    _fetchAll();
    _loadPendingStatus();

    // Ask for Location up front, on screen load -- not the first time the
    // user taps Check In. network_info_plus's getWifiBSSID() is silently
    // gutted without it (returns null/empty instead of throwing, on
    // Android 8.1+), which used to reach the server as a missing bssid
    // and come back as the same "connect to office WiFi" rejection a
    // genuine wrong-network attempt gets -- indistinguishable, and
    // undiagnosable from the error alone. Asking here surfaces the real
    // cause immediately instead of after a confusing failed mark.
    _ensureLocationPermission(promptIfDenied: true);

    Future.delayed(const Duration(seconds: 3), _checkWifiAndMark);

    _wifiCheckTimer = Timer.periodic(
      const Duration(minutes: 5),
      (_) => _checkWifiAndMark(),
    );

    _syncTimer = Timer.periodic(
      const Duration(minutes: 2),
      (_) => _syncPending(),
    );
  }

  @override
  void dispose() {
    _clockTimer.cancel();
    _wifiCheckTimer?.cancel();
    _syncTimer?.cancel();
    super.dispose();
  }

  bool _refreshing = false;
  int _refreshToken = 0;

  // Single toast entry point -- every transient (fire-and-forget) message
  // in this screen goes through here, so styling/duration/icon choices
  // live in one place instead of being repeated at each call site. This is
  // NOT for state that needs to stay visible (e.g. "cached, pending
  // sync") -- that stays an inline card in _buildTodayStatus, since a
  // toast disappearing would misrepresent an ongoing state as resolved.
  void _showToast(String message, {required bool isError}) {
    if (!mounted) return;
    toastification.show(
      context: context,
      type: isError ? ToastificationType.error : ToastificationType.success,
      style: ToastificationStyle.flatColored,
      title: Text(message),
      icon: Icon(isError ? Icons.error_outline : Icons.check_circle_outline),
      primaryColor: isError ? _red : _green,
      backgroundColor: _card,
      foregroundColor: AppTheme.headText,
      alignment: Alignment.topCenter,
      autoCloseDuration: const Duration(seconds: 3),
      borderRadius: BorderRadius.circular(12),
    );
  }

  // Single place that applies a successful mark/checkout API result to
  // screen state and fires the confirmation toast. Previously this ~20-line
  // block was copy-pasted across three call sites (WiFi-auto-mark, the
  // manual button-tap path, and offline-cache sync) -- the manual path's
  // copy was missing the _showToast() call entirely (why toasts never
  // appeared when tapping MARK ATTENDANCE/CHECK OUT), and the sync-path
  // copy never set _captureCheckOut/_checkedOut at all. One source of
  // truth now; fixing the toast or the state shape only ever needs to
  // happen here.
  void _applyMarkResult(Map<String, dynamic> res, {required String timeStr}) {
    if (!mounted) return;
    final checkedOut = res['checked_out'] == true;
    final pendingReview = res['pending_review'] == true;
    setState(() {
      _markSuccess = true;
      _todayPresent = true;
      _todayCachedPresent = false;
      _hasPendingCache = false;
      _cachedTime = '';
      _captureCheckOut = res['capture_check_out'] == true;
      _checkedOut = checkedOut;
      _todayNotes = (res['notes'] as String?) ?? _todayNotes;
      // status here is the timing classification (early/on_time/late) --
      // for a checkout leg it's the checkout status; for check-in it's
      // 'late' whenever pendingReview is true on the check-in leg.
      if (checkedOut) {
        _checkOutHoldReason = pendingReview ? (res['status'] as String?) : null;
      } else {
        _checkInStatus = res['status'] as String?;
        _checkInHoldReason = pendingReview ? 'late' : null;
      }
      _markMsg = (res['message'] as String?)?.isNotEmpty == true
          ? res['message']
          : pendingReview
              ? (checkedOut
                  ? 'Checked out — pending admin review ($timeStr)'
                  : 'Checked in — pending admin review ($timeStr)')
              : (checkedOut
                  ? 'Checked out successfully! ($timeStr)'
                  : 'Attendance marked! ($timeStr)');
      if (checkedOut) {
        _todayOutTime = timeStr;
        _todayDuration = 'Completed';
      } else {
        _todayTime = timeStr;
        _todayDuration = 'In Progress';
      }
    });
    _showToast(_markMsg, isError: false);
    _fetchStats();
  }

  // Manual, whole-app refresh -- deliberately not on a timer. Re-runs every
  // fetch the app makes at launch (stats/history, leaves, overtime,
  // today's checkout-eligibility) so a tap on the header button catches
  // anything an admin changed dashboard-side (marked absent, toggled
  // checkout, approved a leave) without waiting on a poll interval.
  Future<void> _refreshAll() async {
    if (_refreshing) return;
    setState(() {
      _refreshing = true;
      _refreshToken++;
    });
    try {
      await _fetchAll();
      _showToast('Refreshed', isError: false);
    } catch (_) {
      _showToast('Refresh failed — check your connection', isError: true);
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  // ─── Pending Status Load ──────────────────────────────────
  // Replaces the old SharedPreferences single-slot cache
  // (`pending_attendance_${user.name}`) with OfflineQueueService, the
  // same ordered queue field staff uses -- see that service's module
  // docstring for why a single slot can't safely hold both a pending
  // check-in AND a pending check-out on the same day. `is_checkout` in
  // each queued item's payload (set at enqueue time in
  // _saveAttendanceOrCache) is what lets this tell the two apart on
  // reload, instead of assuming every cached item is a check-in the way
  // the old cache implicitly did.
  String get _todayKey => DateTime.now().toIso8601String().split('T')[0];

  Future<void> _loadPendingStatus() async {
    final items = await OfflineQueueService.pending(widget.user.id);
    final today = _todayKey;
    final todays = items.where((a) {
      final payload = a['payload'] as Map? ?? const {};
      return a['type'] == 'attendance_mark_office' && payload['date'] == today;
    }).toList();
    if (todays.isEmpty || !mounted) return;

    final hasCheckIn =
        todays.any((a) => (a['payload'] as Map)['is_checkout'] != true);
    final hasCheckOut =
        todays.any((a) => (a['payload'] as Map)['is_checkout'] == true);
    final lastTimeStr = _to12Hour(_timeOfEnqueue(todays.last));

    setState(() {
      _hasPendingCache = true;
      _cachedTime = lastTimeStr;
      if (hasCheckIn) {
        _todayCachedPresent = true;
        _todayTime = _to12Hour(_timeOfEnqueue(todays
            .firstWhere((a) => (a['payload'] as Map)['is_checkout'] != true)));
      }
      if (hasCheckOut) {
        _checkedOut = true;
        _todayOutTime = _to12Hour(_timeOfEnqueue(todays
            .firstWhere((a) => (a['payload'] as Map)['is_checkout'] == true)));
        _todayDuration = 'Completed';
      }
      _markMsg =
          'Attendance cached ($lastTimeStr) — will sync automatically when the server is reachable';
      _markSuccess = false;
    });
  }

  String _timeOfEnqueue(Map<String, dynamic> action) {
    final createdAt = DateTime.tryParse(action['created_at'] as String? ?? '');
    if (createdAt == null) return '';
    return '${createdAt.hour.toString().padLeft(2, '0')}:'
        '${createdAt.minute.toString().padLeft(2, '0')}';
  }
  // ─────────────────────────────────────────────────────────

  Future<void> _fetchAll() async {
    try {
      await Future.wait([
        _fetchStats(),
        _fetchLeaves(),
        _fetchOvertime(),
        _fetchTodayStatus()
      ]);
    } finally {
      // finally, not just after await: a thrown/failed fetch must still
      // unblock the UI, or a network hiccup on launch would leave the
      // loading skeleton showing forever instead of falling through to
      // "Not Marked Yet" (correct/safe once the real state is unknown-but-
      // resolved, unlike the pre-fetch assumed-false state this guards
      // against).
      if (mounted && _initialLoading) setState(() => _initialLoading = false);
    }
  }

  // Checkout-eligibility + checked-out state -- separate from _fetchStats
  // because capture_check_out is a shift-level setting /history's rows
  // don't carry, not an attendance fact. See getTodayAttendanceStatus's
  // doc comment for why this needs its own call.
  Future<void> _fetchTodayStatus() async {
    try {
      final status =
          await ApiService.getTodayAttendanceStatus(widget.user.token);
      if (!mounted || status['success'] != true) return;
      final alreadyMarked = status['marked'] == true ||
          status['already_marked'] == true ||
          status['checked_in'] == true ||
          status['checked_out'] == true ||
          status['check_in_time'] != null;
      setState(() {
        _todayPresent = alreadyMarked;
        _captureCheckOut = status['capture_check_out'] == true;
        _checkedOut = status['checked_out'] == true;
        _checkInHoldReason = status['check_in_hold_reason'] as String?;
        _checkOutHoldReason = status['check_out_hold_reason'] as String?;
        _todayNotes = status['notes'] as String?;
        _checkInStatus = status['check_in_status'] as String?;
        _shiftName = status['shift_name'] as String?;
        _scheduledCheckInTime =
            (status['scheduled_check_in_time'] as String?) ?? '';
        _scheduledCheckOutTime =
            (status['scheduled_check_out_time'] as String?) ?? '';
        // duration_label is authoritative (server-computed from the same
        // helper the dashboard uses) and available even before checkout
        // ("In Progress") -- prefer it over the history-derived value
        // _fetchStats sets, when present.
        if (status['duration_label'] != null) {
          _todayDuration = status['duration_label'] as String;
        }
        // Clear the transient "you just performed this action" banner (see
        // _applyMarkResult) on every authoritative refresh. It's never
        // touched anywhere else in this function, so without this a stale
        // "pending admin review" (or a stale success message) from an
        // earlier mark keeps rendering forever -- including after an admin
        // has since resolved it, directly contradicting the
        // freshly-refreshed _todayNotes/_checkInHoldReason/
        // _checkOutHoldReason pill it sits right next to. Safe to always
        // clear here: _fetchTodayStatus is only ever called from
        // _fetchAll (app launch + the manual refresh button), never
        // synchronously right after a mark, so this can't wipe out a
        // message the user just triggered in this same session.
        _markSuccess = false;
        _markMsg = '';
      });
    } catch (_) {}
  }

  Future<void> _fetchStats() async {
    try {
      final now = DateTime.now();
      final results = await Future.wait([
        ApiService.getOfficeAttendance(widget.user.token, widget.user.name),
        ApiService.getOfficeAttendanceWorkingDays(
          widget.user.token,
          startDate: DateTime(now.year, now.month, 1),
          endDate: DateTime(now.year, now.month + 1, 0),
        ),
      ]);
      if (!mounted) return;
      final logs = results[0] as List<dynamic>;
      final calendar = results[1] as Map<String, dynamic>;
      final workingDays = AttendanceWorkingDays.fromResponse(
        calendar,
        asOf: now,
      );
      final summary = AttendanceSummary.fromLogs(
        logs,
        workingDays.scheduledDates,
        elapsedWorkingDates: workingDays.elapsedDates,
      );
      final today = DateTime.now().toIso8601String().split('T')[0];
      final todayRec = logs.cast<Map<String, dynamic>?>().firstWhere(
            (r) => (r?['date'] ?? '').toString().startsWith(today),
            orElse: () => null,
          );
      setState(() {
        _presentDays = summary.presentDays;
        _absentDays = summary.absentDays;
        _attendanceRate = summary.elapsedWorkingDays > 0
            ? ((summary.presentDays / summary.elapsedWorkingDays) * 100).round()
            : 0;
        _lateDays = summary.lateDays;
        _totalWorkingDays = summary.totalWorkingDays;
        _attendanceStatsError = null;
        if (todayRec != null) {
          // Server se confirm ho gaya — cached present clear karo
          _todayCachedPresent = false;
          _hasPendingCache = false;
        }
        _todayTime = todayRec?['time'] ??
            _todayTime; // cached time raho agar server se na mile
        _todayOutTime = todayRec?['outTime'] ?? '';
        _todayDuration = todayRec?['workDuration'] ?? 'In Progress';
      });
    } catch (error) {
      if (mounted) {
        setState(() {
          _attendanceStatsError =
              'Could not load configured working days: $error';
        });
      }
    }
  }

  Future<void> _fetchLeaves() async {
    try {
      final leaves = await ApiService.getMyLeaves(widget.user.token);
      if (!mounted) return;
      String status(dynamic r) =>
          (r['status'] ?? '').toString().trim().toLowerCase();
      setState(() {
        _pendingLeaves = leaves.where((r) => status(r) == 'pending').length;
        _approvedLeaves = leaves.where((r) => status(r) == 'approved').length;
        _rejectedLeaves = leaves.where((r) => status(r) == 'rejected').length;
        _recentLeaves = leaves.take(3).toList();
      });
    } catch (_) {}
  }

  Future<void> _fetchOvertime() async {
    try {
      final records = await ApiService.getMyOvertime(widget.user.token);
      if (!mounted) return;
      double total = 0;
      int pending = 0;
      for (final r in records) {
        if (r['status'] == 'Approved') total += (r['hours'] ?? 0).toDouble();
        if (r['status'] == 'Pending') pending++;
      }
      setState(() {
        _totalOvertimeHours = total;
        _pendingOvertimeCount = pending;
      });
    } catch (_) {}
  }

  // ─── Location permission gate ─────────────────────────────
  // Single choke point for the Location check both attendance paths need
  // -- the auto-WiFi-scan timer and the manual Check In/Out button (all
  // three button call sites below funnel through _markAttendance, so
  // gating there covers all of them without touching each widget).
  //
  // Without this, a genuinely-in-office user got rejected with the exact
  // same message a wrong-network user gets, because getWifiBSSID() fails
  // silent (empty string, not an exception) when Location isn't granted
  // -- see the initState comment. Blocking here, with a message that
  // names Location specifically, turns an undiagnosable server 400 into
  // an actionable client-side prompt.
  bool _locationPermissionGranted = false;

  Future<bool> _ensureLocationPermission({required bool promptIfDenied}) async {
    if (!await Geolocator.isLocationServiceEnabled()) {
      if (promptIfDenied && mounted) {
        setState(() {
          _markSuccess = false;
          _markMsg = 'Location is turned off. Turn on Location in your '
              'phone\'s settings to mark attendance.';
        });
        _showToast(_markMsg, isError: true);
      }
      _locationPermissionGranted = false;
      return false;
    }

    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }

    final granted = permission == LocationPermission.always ||
        permission == LocationPermission.whileInUse;

    if (!granted && promptIfDenied && mounted) {
      setState(() {
        _markSuccess = false;
        _markMsg = permission == LocationPermission.deniedForever
            ? 'Location permission is required to mark attendance. Enable '
                'it from Settings > Apps > this app > Permissions > Location.'
            : 'Location permission is required to verify you\'re on the '
                'office network. Please allow it to continue.';
      });
      _showToast(_markMsg, isError: true);
    }

    if (mounted) setState(() => _locationPermissionGranted = granted);
    return granted;
  }
  // ─────────────────────────────────────────────────────────

  // ─── WiFi Attendance + Offline Cache ─────────────────────
  Future<void> _checkWifiAndMark() async {
    // Don't auto-mark until the initial fetch has told us whether today is
    // already marked -- same race the manual button had, just on a timer.
    if (_initialLoading) return;
    // ← CHANGED: _todayPresent ke saath _todayCachedPresent bhi check karo
    if (_todayPresent || _todayCachedPresent) return;

    try {
      // Silent here (no dialog/toast spam every 5-minute tick) -- the
      // user already saw the prompt from initState. Just don't attempt
      // a mark that we already know the server will reject.
      if (!await _ensureLocationPermission(promptIfDenied: false)) return;

      final info = NetworkInfo();
      final ssid = (await info.getWifiName())?.replaceAll('"', '') ?? '';
      final bssid = await info.getWifiBSSID() ?? '';

      if (!_isKnownOfficeNetwork(ssid, bssid)) return;

      await _saveAttendanceOrCache(ssid, bssid, wifiVerified: true);
    } catch (_) {}
  }

  // ─── Common: mark on the server, or queue it offline ─────
  // Single implementation for BOTH check-in and check-out, and for BOTH
  // call sites (WiFi auto-mark and the manual button) -- previously each
  // combination had its own copy-pasted try/catch with a single-slot
  // cache that only ever recorded a check-in, so an offline checkout was
  // silently mis-cached as a fresh check-in on the next sync. Whether
  // this attempt IS a checkout is read from current state
  // (_isPresent && !_checkedOut), same distinction the backend itself
  // makes by whichever attendance row already exists for today -- so the
  // client's guess and the server's actual behavior can only ever agree
  // or fall back to a harmless queued retry, never diverge silently.
  Future<void> _saveAttendanceOrCache(
    String ssid,
    String bssid, {
    required bool wifiVerified,
  }) async {
    final isCheckoutAttempt = _isPresent && !_checkedOut;
    final timeStr =
        _to12Hour(DateTime.now().toIso8601String().substring(11, 16));

    try {
      final res = await ApiService.markAttendance(
        widget.user.token,
        ssid: ssid.isNotEmpty ? ssid : null,
        bssid: bssid.isNotEmpty ? bssid : null,
        wifiVerified: wifiVerified,
      );

      if (!mounted) return;
      if (res['success'] == true) {
        _applyMarkResult(res, timeStr: timeStr);
      } else {
        setState(() {
          _markSuccess = false;
          _markMsg = res['message'] ?? 'Error marking attendance';
        });
        _showToast(_markMsg, isError: true);
      }
    } catch (e) {
      if (!OfflineQueueService.looksOffline(e)) {
        // Not a connectivity failure (e.g. a genuine validation/auth
        // error, including the office-WiFi rejection) -- surfacing it
        // beats silently caching something that will just fail
        // identically on every retry. ApiException's message is already
        // a complete, human-readable sentence (see api_service.dart) --
        // only prefix "Error:" for something unexpected we can't
        // describe better.
        if (mounted) {
          setState(() {
            _markSuccess = false;
            _markMsg = e is ApiException ? e.message : 'Error: $e';
          });
          _showToast(_markMsg, isError: true);
        }
        return;
      }

      if (_officeWifiConfigured && !wifiVerified) {
        // The offline cache exists for exactly one legitimate case: the
        // device IS on the configured office network but our server
        // happened to be unreachable. It is NOT a general "couldn't
        // reach the internet, mark present anyway" fallback -- if this
        // employee has an office network assigned and the current one
        // isn't it, a connectivity failure on top of that tells us
        // nothing new: this mark was never going to be valid, so it
        // must not be cached as Present. Gated on _officeWifiConfigured
        // (not just wifiVerified) so staff with no office network
        // assigned YET -- who the server never rejects for WiFi at all,
        // see evaluate_office_wifi's 'not configured = not enforced'
        // rule -- keep getting the normal offline-cache-and-sync
        // behavior on a real connectivity failure, instead of being
        // wrongly told to "connect to office WiFi" when none was ever
        // required of them.
        if (mounted) {
          setState(() {
            _markSuccess = false;
            _markMsg =
                'Not connected to office WiFi, and the server could not be '
                'reached to verify. Connect to the office network and try '
                'again.';
          });
          _showToast(_markMsg, isError: true);
        }
        return;
      }

      await OfflineQueueService.enqueue(
        widget.user.id,
        type: 'attendance_mark_office',
        payload: {
          'ssid': ssid,
          'bssid': bssid,
          'wifi_verified': wifiVerified,
          'is_checkout': isCheckoutAttempt,
          'date': _todayKey,
        },
      );

      if (!mounted) return;
      setState(() {
        _hasPendingCache = true;
        _cachedTime = timeStr;
        _markSuccess = false;
        if (isCheckoutAttempt) {
          _checkedOut = true;
          _todayOutTime = timeStr;
          _todayDuration = 'Completed';
        } else {
          _todayCachedPresent = true;
          _todayTime = timeStr;
          _todayDuration = 'In Progress';
        }
        _markMsg =
            'Server not reachable — attendance cached ($timeStr)\nWill sync automatically once the server is reachable';
      });
    }
  }
  // ─────────────────────────────────────────────────────────

  // ─── Pending Queue Sync ───────────────────────────────────
  Future<void> _syncPending() async {
    final result =
        await OfflineQueueService.syncAll(widget.user.id, widget.user.token);
    if (!mounted) return;

    if (result.synced > 0) {
      // syncAll() only returns counts, not each action's server response
      // (unlike _applyMarkResult, which needs the real timestamp/status/
      // notes) -- pull the authoritative state now that the queue drained
      // instead of trusting the optimistic local values any further.
      await _fetchTodayStatus();
      await _fetchStats();
      _showToast('Synced ${result.synced} pending action(s).', isError: false);
    }

    if (result.hasWifiRejected) {
      // A cached mark was rejected once connectivity returned -- the
      // device wasn't actually on the assigned office network at capture
      // time. Attendance was NEVER recorded for it, so the optimistic
      // "cached present" state this screen has been showing since the
      // original attempt is wrong and must be cleared, not left to imply
      // a mark that doesn't exist server-side. _fetchTodayStatus() below
      // re-pulls the real (server) status this resets against.
      setState(() {
        _todayCachedPresent = false;
        _hasPendingCache = false;
        _cachedTime = '';
        _checkedOut = false;
      });
      await _fetchTodayStatus();
      await _fetchStats();
      _showToast(
        'Attendance not recorded — you were not on office WiFi. Please '
        'connect and mark attendance again.',
        isError: true,
      );
    }

    if (result.remaining == 0) {
      setState(() {
        _hasPendingCache = false;
        _cachedTime = '';
      });
    } else {
      await _loadPendingStatus();
    }
  }
  // ─────────────────────────────────────────────────────────

  // ─── Manual Mark Attendance Button ───────────────────────
  Future<void> _markAttendance() async {
    setState(() {
      _marking = true;
      _markMsg = '';
    });
    try {
      // Blocking gate: prompt this time (promptIfDenied: true) so a tap
      // with permission missing gets an immediate, specific reason
      // instead of silently doing nothing or falling through to the
      // generic server rejection. No network_info_plus/API call happens
      // below this line until Location is actually granted.
      if (!await _ensureLocationPermission(promptIfDenied: true)) return;

      final info = NetworkInfo();
      final ssid = (await info.getWifiName())?.replaceAll('"', '') ?? '';
      final bssid = await info.getWifiBSSID() ?? '';
      await _saveAttendanceOrCache(
        ssid,
        bssid,
        wifiVerified: _isKnownOfficeNetwork(ssid, bssid),
      );
    } catch (e) {
      // Safety net for anything that escapes _saveAttendanceOrCache
      // (which already handles the ApiException/offline-queue cases
      // itself) -- a plugin failure, a bug, anything unanticipated.
      // Never surface the raw exception/type name here; that's exactly
      // the "HttpException: ... (HTTP 400)" style leak this replaced.
      if (mounted) {
        setState(() => _markMsg = e is ApiException
            ? e.message
            : 'Something went wrong while marking attendance. Please try '
                'again.');
      }
    } finally {
      if (mounted) setState(() => _marking = false);
    }
  }
  // ─────────────────────────────────────────────────────────

  String get _timeString {
    final hour24 = _now.hour;
    final period = hour24 >= 12 ? 'PM' : 'AM';
    final hour12 = hour24 % 12 == 0 ? 12 : hour24 % 12;
    final m = _now.minute.toString().padLeft(2, '0');
    final s = _now.second.toString().padLeft(2, '0');
    return '$hour12:$m:$s $period';
  }

  // Converts a 24-hour "HH:MM" (or "HH:MM:SS"/longer) string -- the shape
  // every actualTime.substring(11, 16) call site below produces -- into
  // 12-hour clock with AM/PM (e.g. "3:29 PM"). Keeps these locally-computed
  // strings (used for the immediate "Attendance marked!"/cache feedback,
  // before the server round-trip lands) visually consistent with what the
  // backend's time/outTime fields now return via local_time_str_iso.
  String _to12Hour(String hhmm) {
    final parts = hhmm.split(':');
    if (parts.length < 2) return hhmm;
    final h = int.tryParse(parts[0]);
    if (h == null) return hhmm;
    final m = parts[1];
    final period = h >= 12 ? 'PM' : 'AM';
    final h12 = h % 12 == 0 ? 12 : h % 12;
    return '$h12:$m $period';
  }

  String get _dateString {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec'
    ];
    return '${days[_now.weekday - 1]}, ${_now.day} ${months[_now.month - 1]}';
  }

  // ─── Helper: aaj present hai (server ya cached) ───────────
  bool get _isPresent => _todayPresent || _todayCachedPresent;
  // ─────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _bg,
      body: SafeArea(
        child: Stack(
          children: [
            Column(
              children: [
                _buildHeader(),
                Expanded(
                  child: IndexedStack(
                    index: _currentTab,
                    children: [
                      _buildDashboard(),
                      AttendanceHistoryScreen(user: widget.user),
                      LeaveScreen(
                        user: widget.user,
                        refreshToken: _refreshToken,
                      ),
                      OvertimeScreen(user: widget.user),
                      ProfileScreen(user: widget.user),
                    ],
                  ),
                ),
                _buildBottomNav(),
              ],
            ),
            HRChatbotWidget(user: widget.user),
            NotificationPoller(
              user: widget.user,
              onAttendanceDetected: () async {
                await Future.wait([_fetchStats(), _fetchTodayStatus()]);
              },
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildHeader() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
      decoration: BoxDecoration(
        color: _card,
        border:
            Border(bottom: BorderSide(color: _indigo.withValues(alpha: 0.2))),
      ),
      child: Row(
        children: [
          Stack(children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: const LinearGradient(
                  colors: [AppTheme.navy700, AppTheme.navy600],
                ),
                boxShadow: [
                  BoxShadow(
                      color: _indigo.withValues(alpha: 0.4), blurRadius: 12)
                ],
              ),
              child: Center(
                child: Text(
                  widget.user.name.isNotEmpty
                      ? widget.user.name[0].toUpperCase()
                      : 'O',
                  style: const TextStyle(
                      color: Colors.white,
                      fontSize: 18,
                      fontWeight: FontWeight.bold),
                ),
              ),
            ),
            Positioned(
              bottom: 1,
              right: 1,
              child: Container(
                width: 11,
                height: 11,
                decoration: BoxDecoration(
                  color: _green,
                  shape: BoxShape.circle,
                  border: Border.all(color: _card, width: 2),
                ),
              ),
            ),
          ]),
          const SizedBox(width: 12),
          Expanded(
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(widget.user.name,
                  style: const TextStyle(
                      color: AppTheme.headText,
                      fontSize: 16,
                      fontWeight: FontWeight.bold)),
              Row(children: [
                const Icon(Icons.location_on, color: _indigo, size: 10),
                const SizedBox(width: 3),
                const Text('Office Staff',
                    style: TextStyle(color: _indigo, fontSize: 11)),
                if (_hasPendingCache) ...[
                  const SizedBox(width: 8),
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                    decoration: BoxDecoration(
                      color: _amber.withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: _amber.withValues(alpha: 0.4)),
                    ),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      const Icon(Icons.cloud_off, color: _amber, size: 9),
                      const SizedBox(width: 3),
                      Text('Cached $_cachedTime',
                          style: const TextStyle(
                              color: _amber,
                              fontSize: 9,
                              fontWeight: FontWeight.w600)),
                    ]),
                  ),
                ],
              ]),
            ]),
          ),
          GestureDetector(
            onTap: _refreshing ? null : _refreshAll,
            child: Container(
              padding: const EdgeInsets.all(8),
              margin: const EdgeInsets.only(right: 8),
              decoration: BoxDecoration(
                color: _indigo.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: _indigo.withValues(alpha: 0.2)),
              ),
              child: _refreshing
                  ? const SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(
                          color: _indigo, strokeWidth: 2))
                  : const Icon(Icons.refresh_rounded, color: _indigo, size: 16),
            ),
          ),
          GestureDetector(
            onTap: () async {
              await AuthService.logout();
              if (context.mounted) {
                Navigator.pushReplacement(context,
                    MaterialPageRoute(builder: (_) => const LoginScreen()));
              }
            },
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
              decoration: BoxDecoration(
                color: _red.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: _red.withValues(alpha: 0.2)),
              ),
              child: Row(children: [
                const Icon(Icons.logout, color: _red, size: 14),
                const SizedBox(width: 4),
                const Text('Out',
                    style: TextStyle(
                        color: _red,
                        fontSize: 11,
                        fontWeight: FontWeight.w600)),
              ]),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildDashboard() {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 0),
      child: Column(children: [
        _buildClockCard(),
        const SizedBox(height: 10),
        _buildTodayStatus(),
        const SizedBox(height: 10),
        _buildStatsRow(),
        const SizedBox(height: 8),
        _buildConfiguredDaysRow(),
        if (_attendanceStatsError != null)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              _attendanceStatsError!,
              style: const TextStyle(color: AppTheme.error, fontSize: 12),
            ),
          ),
        const SizedBox(height: 10),
        _buildLeaveStats(),
        const SizedBox(height: 10),
        _buildOvertimeStats(),
        const SizedBox(height: 10),
        _buildQuickActions(),
        const SizedBox(height: 10),
        _buildRecentLeaves(),
        const SizedBox(height: 80),
      ]),
    );
  }

  Widget _buildClockCard() {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [AppTheme.navy700, AppTheme.navy600, AppTheme.navy700],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: _indigo.withValues(alpha: 0.3)),
      ),
      child: Stack(children: [
        Positioned(
          top: -20,
          right: -20,
          child: Container(
            width: 100,
            height: 100,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: _indigo.withValues(alpha: 0.1),
            ),
          ),
        ),
        Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(_dateString,
              style: const TextStyle(color: Color(0x80FFFFFF), fontSize: 12)),
          const SizedBox(height: 4),
          Text(_timeString,
              style: const TextStyle(
                  color: Colors.white,
                  fontSize: 32,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 2)),
          const SizedBox(height: 8),
          Row(children: [
            const Icon(Icons.location_on, color: _indigo, size: 12),
            const SizedBox(width: 6),
            Text('${widget.user.department} • Office',
                style: const TextStyle(color: Color(0x99FFFFFF), fontSize: 12)),
          ]),
        ]),
      ]),
    );
  }

  Widget _buildTodayStatus() {
    // ─── CHANGED: _isPresent use karo (server ya cached dono) ─
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: _card,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: (_initialLoading && !_todayCachedPresent)
              ? AppTheme.mutedText
                  .withValues(alpha: 0.2) // unresolved = neutral
              : (_checkInHoldReason != null || _checkOutHoldReason != null)
                  ? _amber.withValues(alpha: 0.4) // pending review = amber
                  : _todayPresent
                      ? _green.withValues(alpha: 0.3)
                      : _todayCachedPresent
                          ? _amber.withValues(
                              alpha: 0.4) // cached = amber border
                          : _hasPendingCache
                              ? _amber.withValues(alpha: 0.3)
                              : _red.withValues(alpha: 0.2),
        ),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text("TODAY'S STATUS",
            style: TextStyle(
                color: AppTheme.mutedText,
                fontSize: 10,
                fontWeight: FontWeight.w700,
                letterSpacing: 1.5)),
        const SizedBox(height: 12),

        // ─── Still resolving real state — never show an assumed status or
        // a tappable button here. _todayCachedPresent is known instantly
        // from local storage (no network round-trip), so it's excluded
        // from this gate and can render right away as before.
        if (_initialLoading && !_todayCachedPresent) ...[
          Row(children: const [
            SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(color: _indigo, strokeWidth: 2),
            ),
            SizedBox(width: 10),
            Text('Checking today\'s status…',
                style: TextStyle(
                    color: AppTheme.mutedText,
                    fontSize: 13,
                    fontWeight: FontWeight.w600)),
          ]),

          // ─── Pending Review — a late check-in or an early/late checkout
          // is recorded (per the mobile UX contract: mark right away, never
          // block on an admin) but still awaiting resolve_attendance_exception.
          // Outranks the plain Present/Checked-Out display, matching the
          // backend's own status_label priority.
        ] else if (_checkInHoldReason != null ||
            _checkOutHoldReason != null) ...[
          Row(children: [
            const Icon(Icons.hourglass_top, color: _amber, size: 20),
            const SizedBox(width: 8),
            const Text('Pending Review',
                style: TextStyle(
                    color: _amber, fontSize: 16, fontWeight: FontWeight.bold)),
          ]),
          const SizedBox(height: 10),
          Row(children: [
            _timeBox('Check In', _todayTime, _amber),
            const SizedBox(width: 16),
            if (_todayOutTime.isNotEmpty)
              _timeBox('Check Out', _todayOutTime, _amber),
            if (_todayDuration.isNotEmpty)
              _timeBox('Duration', _todayDuration, _indigo),
          ]),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: _amber.withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: _amber.withValues(alpha: 0.35)),
            ),
            child: Row(
              children: [
                const Icon(Icons.admin_panel_settings, color: _amber, size: 16),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    _todayNotes ??
                        (_checkOutHoldReason != null
                            ? 'Your checkout was recorded and is awaiting admin review.'
                            : 'Your check-in was recorded and is awaiting admin review.'),
                    style: const TextStyle(
                        color: _amber, fontSize: 12, height: 1.4),
                  ),
                ),
              ],
            ),
          ),
          // Checkout can still be offered while a LATE CHECK-IN is pending
          // review -- the two legs are independent; only a pending
          // checkout itself should hide the (already-used) button.
          if (_captureCheckOut &&
              !_checkedOut &&
              _checkOutHoldReason == null) ...[
            const SizedBox(height: 14),
            GestureDetector(
              onTap: _marking ? null : _markAttendance,
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(vertical: 14),
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    colors: _marking
                        ? [Colors.grey.shade800, Colors.grey.shade700]
                        : [AppTheme.teal700, AppTheme.teal700],
                  ),
                  borderRadius: BorderRadius.circular(14),
                ),
                child:
                    Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  if (_marking)
                    const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(
                            color: Colors.white, strokeWidth: 2))
                  else
                    const Icon(Icons.logout, color: Colors.white, size: 18),
                  const SizedBox(width: 8),
                  Text(_marking ? 'CHECKING OUT...' : 'CHECK OUT',
                      style: const TextStyle(
                          color: Colors.white,
                          fontSize: 14,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 0.5)),
                ]),
              ),
            ),
          ],

          // ─── Server confirmed Present ──────────────────────
        ] else if (_todayPresent) ...[
          Row(children: [
            Icon(_checkedOut ? Icons.task_alt : Icons.check_circle,
                color: _green, size: 20),
            const SizedBox(width: 8),
            Text(_checkedOut ? 'Checked Out' : 'Present',
                style: const TextStyle(
                    color: _green, fontSize: 16, fontWeight: FontWeight.bold)),
            const SizedBox(width: 8),
            if (!_checkedOut)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: _green.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: _green.withValues(alpha: 0.3)),
                ),
                child: Text(
                    checkInStatusLabel(_checkInStatus, notes: _todayNotes),
                    style: const TextStyle(
                        color: _green,
                        fontSize: 10,
                        fontWeight: FontWeight.bold)),
              ),
          ]),
          if (_shiftName != null || _scheduledCheckInTime.isNotEmpty) ...[
            const SizedBox(height: 6),
            _shiftInfoLine(),
          ],
          const SizedBox(height: 10),
          Row(children: [
            _timeBox('Check In', _todayTime, _blue),
            const SizedBox(width: 16),
            if (_todayOutTime.isNotEmpty)
              _timeBox('Check Out', _todayOutTime, _blue),
            if (_todayDuration.isNotEmpty)
              _timeBox('Duration', _todayDuration, _indigo),
          ]),
          // check-in-side note (e.g. "checked in earlier than shift start")
          // survives even after checkout, since check_in_write_fields wrote
          // it once and check_out_write_fields only appends to it.
          if (_todayNotes != null && _todayNotes!.isNotEmpty) ...[
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: _blue.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(_todayNotes!,
                  style: const TextStyle(
                      color: AppTheme.mutedText, fontSize: 11, height: 1.3)),
            ),
          ],
          // Driven by _markSuccess (a real boolean already returned by the
          // API) rather than sniffing _markMsg for an emoji character --
          // the emoji was both a fragile match condition and the thing the
          // icon/toast cleanup below is removing.
          if (_markSuccess && _markMsg.isNotEmpty) ...[
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: _green.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: _green.withValues(alpha: 0.3)),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                const Icon(Icons.check_circle, color: _green, size: 12),
                const SizedBox(width: 4),
                Text(_markMsg,
                    style: const TextStyle(
                        color: _green,
                        fontSize: 11,
                        fontWeight: FontWeight.w600)),
              ]),
            ),
          ],

          // ─── Check Out button — only when this shift's resolved window
          // has capture_check_out enabled (see get_client_staff_attendance_today
          // on the backend) and checkout hasn't happened yet. Reuses the
          // same _markAttendance() call as check-in: the backend already
          // decides insert-vs-update based on today's existing row, so no
          // separate "checkout" method is needed on either side.
          if (_captureCheckOut && !_checkedOut) ...[
            const SizedBox(height: 14),
            GestureDetector(
              onTap: _marking ? null : _markAttendance,
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(vertical: 14),
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    colors: _marking
                        ? [Colors.grey.shade800, Colors.grey.shade700]
                        : [_red, Colors.red.shade700],
                  ),
                  borderRadius: BorderRadius.circular(14),
                  boxShadow: _marking
                      ? null
                      : [
                          BoxShadow(
                              color: _red.withValues(alpha: 0.3),
                              blurRadius: 16,
                              offset: const Offset(0, 4))
                        ],
                ),
                child:
                    Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  if (_marking)
                    const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(
                            color: Colors.white, strokeWidth: 2))
                  else
                    const Icon(Icons.logout, color: Colors.white, size: 18),
                  const SizedBox(width: 8),
                  Text(_marking ? 'CHECKING OUT...' : 'CHECK OUT',
                      style: const TextStyle(
                          color: Colors.white,
                          fontSize: 14,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 0.5)),
                ]),
              ),
            ),
          ],

          // ─── NAYA: Cached Present (locally marked, server pending) ─
        ] else if (_todayCachedPresent) ...[
          Row(children: [
            const Icon(Icons.cloud_off, color: _amber, size: 20),
            const SizedBox(width: 8),
            Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('Present (Offline)',
                  style: TextStyle(
                      color: _amber,
                      fontSize: 16,
                      fontWeight: FontWeight.bold)),
              Text('Check-in: $_cachedTime • Syncing when server is reachable',
                  style:
                      const TextStyle(color: AppTheme.mutedText, fontSize: 11)),
            ]),
          ]),
          const SizedBox(height: 10),
          Row(children: [
            _timeBox('Check In', _todayTime, _amber),
            const SizedBox(width: 16),
            _timeBox('Status', 'Pending Sync', _amber),
          ]),
          const SizedBox(height: 12),
          // Amber banner
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: _amber.withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: _amber.withValues(alpha: 0.35)),
            ),
            child: Row(
              children: [
                const Icon(Icons.sync, color: _amber, size: 16),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Attendance saved locally. Will sync automatically when the server is reachable, or tap "RETRY SYNC NOW" below.',
                    style: const TextStyle(
                        color: _amber, fontSize: 12, height: 1.4),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 10),
          // RETRY SYNC button
          GestureDetector(
            onTap: _marking ? null : _syncPending,
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(vertical: 12),
              decoration: BoxDecoration(
                color: _amber,
                borderRadius: BorderRadius.circular(12),
                boxShadow: [
                  BoxShadow(
                      color: _amber.withValues(alpha: 0.25),
                      blurRadius: 16,
                      offset: const Offset(0, 4))
                ],
              ),
              child:
                  Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                const Icon(Icons.sync, color: Colors.white, size: 16),
                const SizedBox(width: 8),
                const Text('RETRY SYNC NOW',
                    style: TextStyle(
                        color: Colors.white,
                        fontSize: 13,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 0.5)),
              ]),
            ),
          ),

          // ─── Not marked yet ────────────────────────────────
        ] else ...[
          Row(children: [
            const Icon(Icons.cancel, color: _red, size: 20),
            const SizedBox(width: 8),
            Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('Not Marked Yet',
                  style: TextStyle(
                      color: _red, fontSize: 15, fontWeight: FontWeight.bold)),
              const Text('Mark your attendance below',
                  style: TextStyle(color: AppTheme.mutedText, fontSize: 11)),
            ]),
          ]),
          if (_shiftName != null || _scheduledCheckInTime.isNotEmpty) ...[
            const SizedBox(height: 8),
            _shiftInfoLine(),
          ],
          const SizedBox(height: 14),
          if (_markMsg.isNotEmpty) ...[
            Container(
              margin: const EdgeInsets.only(bottom: 10),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: _hasPendingCache
                    ? _amber.withValues(alpha: 0.1)
                    : _markSuccess
                        ? _green.withValues(alpha: 0.1)
                        : _red.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                    color: _hasPendingCache
                        ? _amber.withValues(alpha: 0.4)
                        : _markSuccess
                            ? _green.withValues(alpha: 0.3)
                            : _red.withValues(alpha: 0.3)),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    _hasPendingCache
                        ? Icons.cloud_off
                        : _markSuccess
                            ? Icons.check_circle
                            : Icons.error_outline,
                    color: _hasPendingCache
                        ? _amber
                        : _markSuccess
                            ? _green
                            : _red,
                    size: 16,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(_markMsg,
                        style: TextStyle(
                            color: _hasPendingCache
                                ? _amber
                                : _markSuccess
                                    ? _green
                                    : _red,
                            fontSize: 12,
                            height: 1.4)),
                  ),
                ],
              ),
            ),
          ],
          GestureDetector(
            onTap: _marking ? null : _markAttendance,
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(vertical: 14),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: _marking
                      ? [Colors.grey.shade800, Colors.grey.shade700]
                      : [_indigo, AppTheme.navy600],
                ),
                borderRadius: BorderRadius.circular(12),
                boxShadow: _marking
                    ? []
                    : [
                        BoxShadow(
                            color: _indigo.withValues(alpha: 0.3),
                            blurRadius: 20,
                            offset: const Offset(0, 4))
                      ],
              ),
              child:
                  Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                if (_marking)
                  const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                        color: Colors.white, strokeWidth: 2),
                  )
                else
                  const Icon(Icons.how_to_reg, color: Colors.white, size: 18),
                const SizedBox(width: 8),
                Text(_marking ? 'CHECKING IN...' : 'CHECK IN',
                    style: const TextStyle(
                        color: Colors.white,
                        fontSize: 14,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 0.5)),
              ]),
            ),
          ),
        ],
      ]),
    );
  }
  // ─────────────────────────────────────────────────────────

  Widget _timeBox(String label, String value, Color color) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(label,
          style: const TextStyle(color: AppTheme.mutedText, fontSize: 10)),
      const SizedBox(height: 2),
      Text(value,
          style: TextStyle(
              color: color, fontSize: 15, fontWeight: FontWeight.w600)),
    ]);
  }

  // Small "Shift: Morning Shift · 09:00 - 17:00" subtitle, shown both
  // before and after marking. Times are branch-local HH:MM straight from
  // the server (get_client_staff_attendance_today's scheduled_check_in_time/
  // scheduled_check_out_time) — never computed client-side, so this can
  // never drift from what the backend actually enforces.
  Widget _shiftInfoLine() {
    final parts = <String>[];
    if (_shiftName != null && _shiftName!.isNotEmpty) parts.add(_shiftName!);
    if (_scheduledCheckInTime.isNotEmpty) {
      parts.add(_scheduledCheckOutTime.isNotEmpty
          ? '$_scheduledCheckInTime - $_scheduledCheckOutTime'
          : _scheduledCheckInTime);
    }
    if (parts.isEmpty) return const SizedBox.shrink();
    return Row(children: [
      const Icon(Icons.schedule, color: AppTheme.mutedText, size: 13),
      const SizedBox(width: 4),
      Text(parts.join(' · '),
          style: const TextStyle(color: AppTheme.mutedText, fontSize: 11)),
    ]);
  }

  Widget _buildStatsRow() {
    return Row(children: [
      _statCard(Icons.check_circle_outline, '$_presentDays', 'Present', _green),
      const SizedBox(width: 8),
      _statCard(Icons.cancel_outlined, '$_absentDays', 'Absent', _red),
      const SizedBox(width: 8),
      _statCard(Icons.bar_chart_rounded, '$_attendanceRate%', 'Rate', _indigo),
    ]);
  }

  Widget _buildConfiguredDaysRow() {
    return Row(children: [
      _statCard(Icons.schedule, '$_lateDays', 'Late', _amber),
      const SizedBox(width: 8),
      _statCard(
          Icons.calendar_month, '$_totalWorkingDays', 'Work Days', _indigo),
      const SizedBox(width: 8),
      const Expanded(child: SizedBox.shrink()),
    ]);
  }

  Widget _statCard(IconData icon, String value, String label, Color color) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 14),
        decoration: BoxDecoration(
          color: _card,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: color.withValues(alpha: 0.22)),
        ),
        child: Column(children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(height: 4),
          Text(value,
              style: TextStyle(
                  color: color, fontSize: 20, fontWeight: FontWeight.w700)),
          const SizedBox(height: 2),
          Text(label,
              style: const TextStyle(
                  color: AppTheme.mutedText,
                  fontSize: 10,
                  fontWeight: FontWeight.w700)),
        ]),
      ),
    );
  }

  Widget _buildLeaveStats() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: _card,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppTheme.borderColor),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text('LEAVE SUMMARY',
            style: TextStyle(
                color: AppTheme.mutedText,
                fontSize: 10,
                fontWeight: FontWeight.w700,
                letterSpacing: 1.5)),
        const SizedBox(height: 12),
        Row(children: [
          _miniStatCard('PENDING', '$_pendingLeaves', _amber),
          const SizedBox(width: 8),
          _miniStatCard('APPROVED', '$_approvedLeaves', _green),
          const SizedBox(width: 8),
          _miniStatCard('REJECTED', '$_rejectedLeaves', _red),
          const SizedBox(width: 8),
          _miniStatCard('TOTAL',
              '${_pendingLeaves + _approvedLeaves + _rejectedLeaves}', _indigo),
        ]),
      ]),
    );
  }

  Widget _miniStatCard(String label, String value, Color color) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 12),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: color.withValues(alpha: 0.2)),
        ),
        child: Column(children: [
          Text(value,
              style: TextStyle(
                  color: color, fontSize: 20, fontWeight: FontWeight.w700)),
          const SizedBox(height: 2),
          Text(label,
              style: const TextStyle(
                  color: AppTheme.mutedText,
                  fontSize: 8,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.5)),
        ]),
      ),
    );
  }

  Widget _buildOvertimeStats() {
    return Row(children: [
      Expanded(
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: _card,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: _indigo.withValues(alpha: 0.2)),
          ),
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              const Icon(Icons.more_time, color: _indigo, size: 16),
              const SizedBox(width: 8),
              const Text('TOTAL OVERTIME',
                  style: TextStyle(
                      color: AppTheme.mutedText,
                      fontSize: 10,
                      fontWeight: FontWeight.w700)),
            ]),
            const SizedBox(height: 6),
            Text('${_totalOvertimeHours.toStringAsFixed(1)} hrs',
                style: const TextStyle(
                    color: AppTheme.headText,
                    fontSize: 22,
                    fontWeight: FontWeight.w700)),
          ]),
        ),
      ),
      const SizedBox(width: 10),
      Expanded(
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: _card,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: _amber.withValues(alpha: 0.2)),
          ),
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              const Icon(Icons.pending_actions, color: _amber, size: 16),
              const SizedBox(width: 8),
              const Text('PENDING',
                  style: TextStyle(
                      color: AppTheme.mutedText,
                      fontSize: 10,
                      fontWeight: FontWeight.w700)),
            ]),
            const SizedBox(height: 6),
            Text('$_pendingOvertimeCount',
                style: const TextStyle(
                    color: _amber, fontSize: 22, fontWeight: FontWeight.w700)),
          ]),
        ),
      ),
    ]);
  }

  Widget _buildQuickActions() {
    final actions = [
      {
        'icon': Icons.beach_access,
        'label': 'Apply Leave',
        'color': _indigo,
        'onTap': () => setState(() => _currentTab = 2)
      },
      {
        'icon': Icons.more_time,
        'label': 'Overtime',
        'color': _amber,
        'onTap': () => setState(() => _currentTab = 3)
      },
      {
        'icon': Icons.calendar_month,
        'label': 'History',
        'color': _teal,
        'onTap': () => setState(() => _currentTab = 1)
      },
      {
        'icon': Icons.person_outline,
        'label': 'My Profile',
        'color': _green,
        'onTap': () => setState(() => _currentTab = 4)
      },
    ];

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: _card,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppTheme.borderColor),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text('QUICK ACTIONS',
            style: TextStyle(
                color: AppTheme.mutedText,
                fontSize: 10,
                fontWeight: FontWeight.w700,
                letterSpacing: 1.5)),
        const SizedBox(height: 12),
        GridView.count(
          crossAxisCount: 2,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          crossAxisSpacing: 8,
          mainAxisSpacing: 8,
          childAspectRatio: 2.5,
          children: actions.map((a) {
            final color = a['color'] as Color;
            return GestureDetector(
              onTap: a['onTap'] as VoidCallback,
              child: Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: color.withValues(alpha: 0.25)),
                ),
                child: Row(children: [
                  Icon(a['icon'] as IconData, color: color, size: 18),
                  const SizedBox(width: 8),
                  Expanded(
                      child: Text(a['label'] as String,
                          style: const TextStyle(
                              color: AppTheme.headText,
                              fontSize: 12,
                              fontWeight: FontWeight.w600),
                          overflow: TextOverflow.ellipsis)),
                  Icon(Icons.chevron_right, color: color, size: 16),
                ]),
              ),
            );
          }).toList(),
        ),
      ]),
    );
  }

  Widget _buildRecentLeaves() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: _card,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppTheme.borderColor),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          const Text('RECENT LEAVES',
              style: TextStyle(
                  color: AppTheme.mutedText,
                  fontSize: 10,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 1.5)),
          GestureDetector(
            onTap: () => setState(() => _currentTab = 2),
            child: const Text('View All',
                style: TextStyle(
                    color: _indigo, fontSize: 11, fontWeight: FontWeight.w600)),
          ),
        ]),
        const SizedBox(height: 12),
        if (_recentLeaves.isEmpty)
          const Center(
            child: Padding(
              padding: EdgeInsets.symmetric(vertical: 10),
              child: Text('No recent leaves',
                  style: TextStyle(color: AppTheme.mutedText, fontSize: 13)),
            ),
          )
        else
          ...List.generate(_recentLeaves.length, (i) {
            final leave = _recentLeaves[i];
            final status = leave['status'] ?? 'Pending';
            Color sc = _amber;
            if (status == 'Approved') sc = _green;
            if (status == 'Rejected') sc = _red;
            final leaveType = leave['type'] ?? leave['leave_type'] ?? '';
            final startDate = leave['startDate'] ?? leave['start_date'] ?? '';
            final endDate = leave['endDate'] ?? leave['end_date'] ?? '';
            return Container(
              padding: const EdgeInsets.symmetric(vertical: 10),
              decoration: BoxDecoration(
                border: i < _recentLeaves.length - 1
                    ? Border(
                        bottom: BorderSide(
                            color: AppTheme.borderColor.withValues(alpha: 0.6)))
                    : null,
              ),
              child: Row(children: [
                Expanded(
                    child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                      Text(leaveType,
                          style: const TextStyle(
                              color: AppTheme.bodyText,
                              fontSize: 13,
                              fontWeight: FontWeight.w600)),
                      const SizedBox(height: 3),
                      Text('$startDate → $endDate',
                          style: const TextStyle(
                              color: AppTheme.mutedText, fontSize: 11)),
                    ])),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
                  decoration: BoxDecoration(
                    color: sc.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: sc.withValues(alpha: 0.3)),
                  ),
                  child: Text(status,
                      style: TextStyle(
                          color: sc,
                          fontSize: 11,
                          fontWeight: FontWeight.bold)),
                ),
              ]),
            );
          }),
      ]),
    );
  }

  Widget _buildBottomNav() {
    final tabs = [
      {'icon': Icons.home_rounded, 'label': 'Home'},
      {'icon': Icons.calendar_month, 'label': 'Attendance'},
      {'icon': Icons.article_outlined, 'label': 'Leave'},
      {'icon': Icons.more_time, 'label': 'Overtime'},
      {'icon': Icons.person_outline, 'label': 'Profile'},
    ];

    return Container(
      decoration: BoxDecoration(
        color: _card,
        border: Border(top: BorderSide(color: AppTheme.borderColor)),
      ),
      padding: const EdgeInsets.fromLTRB(0, 8, 0, 12),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceAround,
        children: List.generate(tabs.length, (i) {
          final isActive = _currentTab == i;
          return GestureDetector(
            onTap: () => setState(() => _currentTab = i),
            child: Container(
              color: Colors.transparent,
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Container(
                  width: 40,
                  height: 32,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(10),
                    gradient: isActive
                        ? const LinearGradient(
                            colors: [AppTheme.navy700, AppTheme.navy600])
                        : null,
                    boxShadow: isActive
                        ? [
                            BoxShadow(
                                color: _indigo.withValues(alpha: 0.4),
                                blurRadius: 12)
                          ]
                        : null,
                  ),
                  child: Icon(tabs[i]['icon'] as IconData,
                      color: isActive ? Colors.white : AppTheme.mutedText,
                      size: 18),
                ),
                const SizedBox(height: 3),
                Text(tabs[i]['label'] as String,
                    style: TextStyle(
                        color: isActive ? _indigo : AppTheme.mutedText,
                        fontSize: 10,
                        fontWeight:
                            isActive ? FontWeight.w700 : FontWeight.w400)),
              ]),
            ),
          );
        }),
      ),
    );
  }
}
