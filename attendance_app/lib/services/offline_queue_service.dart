// import 'dart:convert';
// import 'dart:io';
// import 'dart:math';
// import 'package:shared_preferences/shared_preferences.dart';
// import 'api_service.dart';

// /// Generic offline action queue for BOTH office and field staff. This
// /// replaces office_home_screen.dart's old single-slot SharedPreferences
// /// cache (`pending_attendance_${user.name}` / `_syncPendingAttendance`)
// /// with the same ordered queue field staff already uses, because even
// /// office attendance can generate more than one pending action before
// /// signal returns -- check in, then check out, both offline in the same
// /// day -- which a single-slot cache can only ever hold one of at a time.
// ///
// /// Every write action funnels through here: office attendance check-in/
// /// out, field attendance check-in/out, visit log (check-in), visit
// /// checkout, and adding a plan stop. Each queued item carries a
// /// `client_action_id` that the corresponding backend function
// /// (mark_client_staff_attendance / mark_field_staff_attendance / log_visit
// /// / check_out_visit / add_stop) uses to detect a replay -- see their
// /// docstrings in support_db.py / support_db_visits.py. Without that, a
// /// retry of an action whose response was lost mid-flight could double-log
// /// a visit or misread a replayed check-in as a check-out.
// ///
// /// check_out_visit is the one genuinely hard case: it targets a visit by
// /// server-assigned id, but if the matching log_visit is ITSELF still
// /// queued (never synced), there is no server id yet. That checkout is
// /// queued with `dependsOn` set to the log_visit's client_action_id
// /// instead of a visit_id -- syncAll() resolves it to a real id once the
// /// parent syncs, in the same pass if possible, and leaves it queued
// /// (never guesses) otherwise.
// /// Thrown by _runOne's 'field_attendance_offline' case when the deferred
// /// verify-face comes back with no match. Deliberately NOT a subtype/shape
// /// that _looksLikeConnectivityError would ever match -- a mismatch is a
// /// definitive server verdict (verify-face returned 200 with verified:
// /// false), not a transport failure, so syncAll() must never requeue it for
// /// a retry the same photo would just fail again, and must never let it
// /// stop the drain of the rest of the queue the way a real connectivity
// /// error does.
// class _FaceRejected implements Exception {
//   final String clientActionId;
//   final String userName;
//   const _FaceRejected(this.clientActionId, this.userName);
// }

// class OfflineQueueService {
//   static String _key(String userId) => 'offline_queue_$userId';

//   static final Random _rand = Random();

//   static String newActionId() {
//     return '${DateTime.now().microsecondsSinceEpoch}-${_rand.nextInt(0x7FFFFFFF)}';
//   }

//   static Future<List<Map<String, dynamic>>> _readQueue(String userId) async {
//     final prefs = await SharedPreferences.getInstance();
//     final raw = prefs.getString(_key(userId));
//     if (raw == null) return [];
//     try {
//       final decoded = jsonDecode(raw) as List;
//       return decoded.map((e) => Map<String, dynamic>.from(e as Map)).toList();
//     } catch (_) {
//       return [];
//     }
//   }

//   static Future<void> _writeQueue(
//       String userId, List<Map<String, dynamic>> queue) async {
//     final prefs = await SharedPreferences.getInstance();
//     await prefs.setString(_key(userId), jsonEncode(queue));
//   }

//   /// Adds an action to the end of the queue (FIFO -- sync always drains
//   /// oldest first, since a checkout queued after its check-in must not
//   /// be attempted before it).
//   static Future<String> enqueue(
//     String userId, {
//     required String type,
//     required Map<String, dynamic> payload,
//     String? dependsOn,
//   }) async {
//     final actionId = newActionId();
//     final queue = await _readQueue(userId);
//     queue.add({
//       'client_action_id': actionId,
//       'type': type,
//       'payload': payload,
//       'depends_on': dependsOn,
//       'created_at': DateTime.now().toIso8601String(),
//       'attempts': 0,
//       'last_error': null,
//     });
//     await _writeQueue(userId, queue);
//     return actionId;
//   }

//   static Future<int> pendingCount(String userId) async {
//     final queue = await _readQueue(userId);
//     return queue.length;
//   }

//   static Future<List<Map<String, dynamic>>> pending(String userId) =>
//       _readQueue(userId);

//   /// True once a stop check-in (`type: log_visit`) has actually been
//   /// queued but not yet synced -- used by the Visits screen to show
//   /// "Checked in (pending sync)" instead of enabling a checkout it can't
//   /// resolve to anything yet in this pass.
//   static Future<bool> hasQueuedAction(String userId, String clientActionId) async {
//     final queue = await _readQueue(userId);
//     return queue.any((a) => a['client_action_id'] == clientActionId);
//   }

//   /// Public wrapper around the connectivity-error heuristic used by
//   /// syncAll() -- screens use this to decide "should this failure be
//   /// queued for later, or is it a real error to show the user?" before
//   /// calling enqueue() themselves for actions that need optimistic local
//   /// state (see visit_plan_screen.dart's _checkOut / _LogVisitSheet).
//   static bool looksOffline(Object e) => _looksLikeConnectivityError(e);

//   static bool _looksLikeConnectivityError(Object e) {
//     final s = e.toString().toLowerCase();
//     // NOT 'httpexception' -- that's what ApiService._decodeOrThrow throws
//     // for EVERY non-2xx HTTP response (401/403/404/500/...), meaning the
//     // server was reached and responded. That's the opposite of offline:
//     // a real 401 ("logged in elsewhere", expired token, etc.) was being
//     // misclassified as a connectivity failure and silently queued instead
//     // of surfaced, which is how "Present (Offline)" could show up with a
//     // fully working internet connection. A genuine connectivity failure
//     // throws SocketException/TimeoutException/ClientException instead --
//     // all already covered below -- because the request never got a
//     // response to decode in the first place.
//     return s.contains('socketexception') ||
//         s.contains('connection refused') ||
//         s.contains('connection reset') ||
//         s.contains('connection abort') ||
//         s.contains('connection closed') ||
//         s.contains('timeout') ||
//         s.contains('network is unreachable') ||
//         s.contains('failed host lookup') ||
//         s.contains('clientexception');
//   }

//   /// Drains the queue in order. Returns as soon as the queue is empty or
//   /// a connectivity-shaped failure is hit (further items would just fail
//   /// identically -- no point burning through all of them one by one).
//   /// A non-connectivity failure (e.g. a genuine validation error from one
//   /// bad action) does NOT stop the drain -- that failure is specific to
//   /// that action, not the connection, so later items still get a chance.
//   static Future<OfflineSyncResult> syncAll(
//     String userId,
//     String token,
//   ) async {
//     final queue = await _readQueue(userId);
//     if (queue.isEmpty) {
//       return const OfflineSyncResult(synced: 0, remaining: 0, failed: 0);
//     }

//     final resolvedIds = <String, String>{};
//     var synced = 0;
//     var failed = 0;
//     final rejectedNames = <String>[];
//     final remaining = <Map<String, dynamic>>[];

//     for (var i = 0; i < queue.length; i++) {
//       final action = queue[i];
//       final dependsOn = action['depends_on'] as String?;

//       if (dependsOn != null && !resolvedIds.containsKey(dependsOn)) {
//         // Parent action hasn't synced yet (this pass or ever) -- keep
//         // this one queued, try again on the next syncAll() call.
//         remaining.add(action);
//         continue;
//       }

//       try {
//         await _runOne(action, token, resolvedIds);
//         synced++;
//       } on _FaceRejected catch (e) {
//         // Deliberately NOT added to `remaining` -- the same queued photo
//         // would just fail the same verify-face check again forever, and
//         // attendance was never marked for this action, so there is
//         // nothing left to retry. Tracked separately from `failed` so
//         // callers can tell "will resolve itself once online" apart from
//         // "needs the person to redo Face Verification live".
//         rejectedNames.add(e.userName);
//         // Not a connectivity error -- the rest of the queue still gets a
//         // chance this pass.
//       } catch (e) {
//         failed++;
//         action['attempts'] = (action['attempts'] as int? ?? 0) + 1;
//         action['last_error'] = e.toString();
//         remaining.add(action);

//         if (_looksLikeConnectivityError(e)) {
//           // Connection's gone -- stop here, requeue everything else
//           // untouched so ordering/dependencies are preserved exactly.
//           remaining.addAll(queue.sublist(i + 1));
//           break;
//         }
//       }
//     }

//     await _writeQueue(userId, remaining);
//     return OfflineSyncResult(
//       synced: synced,
//       remaining: remaining.length,
//       failed: failed,
//       rejected: rejectedNames.length,
//     );
//   }

//   static Future<void> _runOne(
//     Map<String, dynamic> action,
//     String token,
//     Map<String, String> resolvedIds,
//   ) async {
//     final type = action['type'] as String;
//     final payload = Map<String, dynamic>.from(action['payload'] as Map);
//     final clientActionId = action['client_action_id'] as String;
//     final dependsOn = action['depends_on'] as String?;

//     switch (type) {
//       case 'attendance_mark':
//         await ApiService.markFieldAttendance(
//           token,
//           payload['user_id'] as String,
//           payload['user_name'] as String,
//           (payload['lat'] as num).toDouble(),
//           (payload['lng'] as num).toDouble(),
//           Map<String, dynamic>.from(payload['geofence'] as Map? ?? {}),
//           isMocked: payload['is_mocked'] as bool? ?? false,
//           syncedAfterOffline: true,
//           clientActionId: clientActionId,
//         );
//         break;

//       case 'attendance_mark_office':
//         // Office check-in and check-out are the SAME call
//         // (mark_client_staff_attendance toggles between them by whether
//         // an attendance row already exists for today) -- unlike visits,
//         // there is no separate visit_id to resolve, so this never needs
//         // dependsOn/resolvedIds. Ordering alone (FIFO drain) is what
//         // guarantees a queued check-in lands before its queued checkout
//         // is attempted.
//         await ApiService.markAttendance(
//           token,
//           ssid: payload['ssid'] as String?,
//           bssid: payload['bssid'] as String?,
//           wifiVerified: payload['wifi_verified'] as bool? ?? false,
//           syncedAfterOffline: true,
//           clientActionId: clientActionId,
//         );
//         break;

//       case 'field_attendance_offline':
//         // Deferred completion of a selfie captured while offline (see
//         // face_verification_screen.dart's connectivity-failure branch).
//         // Runs the real verify-face now that connectivity is back, and
//         // only calls mark-attendance if it actually matched. A mismatch
//         // is a definitive "no" from the server, not something a human
//         // should quietly review after the fact -- so on
//         // verified == false, attendance is deliberately NEVER marked for
//         // this action (see _FaceRejected below); the person has to stand
//         // in front of the camera again and redo Face Verification live.
//         final photoPath = payload['photo_path'] as String;
//         final photoFile = File(photoPath);
//         if (!await photoFile.exists()) {
//           // Nothing left to verify against -- the app/OS may have cleared
//           // its documents dir between capture and sync. Not a
//           // connectivity error, so this action gets dropped (requeuing it
//           // forever would never succeed) rather than blocking the rest of
//           // the drain.
//           throw StateError('Queued selfie no longer exists at $photoPath');
//         }
//         final bytes = await photoFile.readAsBytes();
//         final base64Image = base64Encode(bytes);

//         final verifyResult = await ApiService.verifyFace(
//           token, payload['user_id'] as String, base64Image,
//         );
//         final faceVerified = verifyResult['verified'] == true;
//         final faceSimilarity = (verifyResult['similarity'] as num?)?.toDouble();

//         if (!faceVerified) {
//           // Best-effort cleanup -- nothing left to retry this photo
//           // against, it already got its one verify-face verdict.
//           try {
//             await photoFile.delete();
//           } catch (_) {}
//           throw _FaceRejected(
//             clientActionId,
//             payload['user_name'] as String? ?? 'You',
//           );
//         }

//         await ApiService.markFieldAttendance(
//           token,
//           payload['user_id'] as String,
//           payload['user_name'] as String,
//           (payload['lat'] as num).toDouble(),
//           (payload['lng'] as num).toDouble(),
//           Map<String, dynamic>.from(payload['geofence'] as Map? ?? {}),
//           isMocked: payload['is_mocked'] as bool? ?? false,
//           syncedAfterOffline: true,
//           clientActionId: clientActionId,
//           faceVerified: faceVerified,
//           faceSimilarity: faceSimilarity,
//         );

//         // Only delete once both calls above succeeded -- if either threw
//         // (including a connectivity error on the second call), the photo
//         // stays on disk and this whole case retries from the top on the
//         // next syncAll() pass, exactly like every other queued action.
//         try {
//           await photoFile.delete();
//         } catch (_) {
//           // Best-effort cleanup -- a leftover file costs disk space, not
//           // correctness (mark-attendance already succeeded and is keyed
//           // off client_action_id, so a future accidental resync of this
//           // same action would just replay idempotently, not double-mark).
//         }
//         break;

//       case 'add_stop':
//         final result = await ApiService.addOwnVisitStop(
//           token,
//           payload['plan_id'] as String,
//           locationLabel: payload['location_label'] as String,
//           lat: (payload['lat'] as num).toDouble(),
//           lng: (payload['lng'] as num).toDouble(),
//           radiusMeters: (payload['radius_meters'] as num?)?.toInt() ?? 150,
//           purpose: payload['purpose'] as String?,
//           clientActionId: clientActionId,
//         );
//         resolvedIds[clientActionId] = result['id'] as String;
//         break;

//       case 'log_visit':
//         // If this visit targets a stop that was ITSELF still queued when
//         // logged (dependsOn points at that stop's action id), resolve it
//         // to the real server id here -- syncAll() only reaches this case
//         // once dependsOn is present in resolvedIds, so this is always
//         // resolvable when we get here, never a guess.
//         var planStopId = payload['plan_stop_id'] as String?;
//         if (planStopId != null &&
//             planStopId.startsWith('pending:') &&
//             dependsOn != null) {
//           planStopId = resolvedIds[dependsOn];
//         }
//         final result = await ApiService.logVisit(
//           token,
//           latitude: (payload['latitude'] as num).toDouble(),
//           longitude: (payload['longitude'] as num).toDouble(),
//           planStopId: planStopId,
//           distanceFromStopMeters:
//               (payload['distance_from_stop_meters'] as num?)?.toDouble(),
//           note: payload['note'] as String?,
//           evidenceMode: payload['evidence_mode'] as String? ?? 'gps_only',
//           clientActionId: clientActionId,
//         );
//         resolvedIds[clientActionId] = result['id'] as String;
//         break;

//       case 'check_out_visit':
//         final visitId = (payload['visit_id'] as String?) ??
//             (dependsOn != null ? resolvedIds[dependsOn] : null);
//         if (visitId == null) {
//           // Should be unreachable -- syncAll() only calls _runOne once
//           // dependsOn is resolved or absent. Guard anyway rather than
//           // send a checkout with a null target.
//           throw StateError('Checkout has no resolvable visit id yet');
//         }
//         await ApiService.checkOutVisit(
//           token,
//           visitId,
//           latitude: (payload['latitude'] as num).toDouble(),
//           longitude: (payload['longitude'] as num).toDouble(),
//           clientActionId: clientActionId,
//         );
//         break;

//       default:
//         throw StateError('Unknown queued action type: $type');
//     }
//   }

//   static Future<void> clearAll(String userId) async {
//     final prefs = await SharedPreferences.getInstance();
//     await prefs.remove(_key(userId));
//   }
// }

// class OfflineSyncResult {
//   final int synced;
//   final int remaining;
//   final int failed;
//   // Count of queued offline selfies whose deferred verify-face came back
//   // with no match once connectivity returned. These are NOT included in
//   // `remaining` -- attendance was never marked for them and retrying the
//   // same photo would only fail identically -- so callers must surface
//   // this count to the person and prompt them to redo Face Verification
//   // live, or it silently disappears from view.
//   final int rejected;
//   const OfflineSyncResult({
//     required this.synced,
//     required this.remaining,
//     required this.failed,
//     this.rejected = 0,
//   });

//   bool get hasPending => remaining > 0;
//   bool get hasRejected => rejected > 0;
// }



import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:shared_preferences/shared_preferences.dart';
import 'api_service.dart';

/// Generic offline action queue for BOTH office and field staff. This
/// replaces office_home_screen.dart's old single-slot SharedPreferences
/// cache (`pending_attendance_${user.name}` / `_syncPendingAttendance`)
/// with the same ordered queue field staff already uses, because even
/// office attendance can generate more than one pending action before
/// signal returns -- check in, then check out, both offline in the same
/// day -- which a single-slot cache can only ever hold one of at a time.
///
/// Every write action funnels through here: office attendance check-in/
/// out, field attendance check-in/out, visit log (check-in), visit
/// checkout, and adding a plan stop. Each queued item carries a
/// `client_action_id` that the corresponding backend function
/// (mark_client_staff_attendance / mark_field_staff_attendance / log_visit
/// / check_out_visit / add_stop) uses to detect a replay -- see their
/// docstrings in support_db.py / support_db_visits.py. Without that, a
/// retry of an action whose response was lost mid-flight could double-log
/// a visit or misread a replayed check-in as a check-out.
///
/// check_out_visit is the one genuinely hard case: it targets a visit by
/// server-assigned id, but if the matching log_visit is ITSELF still
/// queued (never synced), there is no server id yet. That checkout is
/// queued with `dependsOn` set to the log_visit's client_action_id
/// instead of a visit_id -- syncAll() resolves it to a real id once the
/// parent syncs, in the same pass if possible, and leaves it queued
/// (never guesses) otherwise.
/// Thrown by _runOne's 'field_attendance_offline' case when the deferred
/// verify-face comes back with no match. Deliberately NOT a subtype/shape
/// that _looksLikeConnectivityError would ever match -- a mismatch is a
/// definitive server verdict (verify-face returned 200 with verified:
/// false), not a transport failure, so syncAll() must never requeue it for
/// a retry the same photo would just fail again, and must never let it
/// stop the drain of the rest of the queue the way a real connectivity
/// error does.
class _FaceRejected implements Exception {
  final String clientActionId;
  final String userName;
  const _FaceRejected(this.clientActionId, this.userName);
}

/// Thrown by _runOne's 'attendance_mark_office' case when the deferred
/// sync of a cached office check-in/out comes back rejected because the
/// device wasn't on the assigned office WiFi (support_db_attendance_mobile
/// .py's OfficeWifiRejectedError, surfaced as ApiException.code ==
/// 'wifi_not_verified'). Deliberately NOT a subtype/shape
/// _looksLikeConnectivityError would ever match -- this is a definitive
/// server verdict, not a transport failure, so syncAll() must never
/// requeue it for a retry that would just fail identically forever (the
/// bssid this action captured will never match), and must never let it
/// stop the drain of the rest of the queue the way a real connectivity
/// error does. Mirrors _FaceRejected exactly, one level up the stack.
class _WifiRejected implements Exception {
  final String clientActionId;
  const _WifiRejected(this.clientActionId);
}

class OfflineQueueService {
  static String _key(String userId) => 'offline_queue_$userId';

  static final Random _rand = Random();

  static String newActionId() {
    return '${DateTime.now().microsecondsSinceEpoch}-${_rand.nextInt(0x7FFFFFFF)}';
  }

  static Future<List<Map<String, dynamic>>> _readQueue(String userId) async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_key(userId));
    if (raw == null) return [];
    try {
      final decoded = jsonDecode(raw) as List;
      return decoded.map((e) => Map<String, dynamic>.from(e as Map)).toList();
    } catch (_) {
      return [];
    }
  }

  static Future<void> _writeQueue(
      String userId, List<Map<String, dynamic>> queue) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key(userId), jsonEncode(queue));
  }

  /// Adds an action to the end of the queue (FIFO -- sync always drains
  /// oldest first, since a checkout queued after its check-in must not
  /// be attempted before it).
  static Future<String> enqueue(
    String userId, {
    required String type,
    required Map<String, dynamic> payload,
    String? dependsOn,
  }) async {
    final actionId = newActionId();
    final queue = await _readQueue(userId);
    queue.add({
      'client_action_id': actionId,
      'type': type,
      'payload': payload,
      'depends_on': dependsOn,
      'created_at': DateTime.now().toIso8601String(),
      'attempts': 0,
      'last_error': null,
    });
    await _writeQueue(userId, queue);
    return actionId;
  }

  static Future<int> pendingCount(String userId) async {
    final queue = await _readQueue(userId);
    return queue.length;
  }

  static Future<List<Map<String, dynamic>>> pending(String userId) =>
      _readQueue(userId);

  /// True once a stop check-in (`type: log_visit`) has actually been
  /// queued but not yet synced -- used by the Visits screen to show
  /// "Checked in (pending sync)" instead of enabling a checkout it can't
  /// resolve to anything yet in this pass.
  static Future<bool> hasQueuedAction(String userId, String clientActionId) async {
    final queue = await _readQueue(userId);
    return queue.any((a) => a['client_action_id'] == clientActionId);
  }

  /// Public wrapper around the connectivity-error heuristic used by
  /// syncAll() -- screens use this to decide "should this failure be
  /// queued for later, or is it a real error to show the user?" before
  /// calling enqueue() themselves for actions that need optimistic local
  /// state (see visit_plan_screen.dart's _checkOut / _LogVisitSheet).
  static bool looksOffline(Object e) => _looksLikeConnectivityError(e);

  static bool _looksLikeConnectivityError(Object e) {
    final s = e.toString().toLowerCase();
    // NOT 'httpexception' -- that's what ApiService._decodeOrThrow throws
    // for EVERY non-2xx HTTP response (401/403/404/500/...), meaning the
    // server was reached and responded. That's the opposite of offline:
    // a real 401 ("logged in elsewhere", expired token, etc.) was being
    // misclassified as a connectivity failure and silently queued instead
    // of surfaced, which is how "Present (Offline)" could show up with a
    // fully working internet connection. A genuine connectivity failure
    // throws SocketException/TimeoutException/ClientException instead --
    // all already covered below -- because the request never got a
    // response to decode in the first place.
    return s.contains('socketexception') ||
        s.contains('connection refused') ||
        s.contains('connection reset') ||
        s.contains('connection abort') ||
        s.contains('connection closed') ||
        s.contains('timeout') ||
        s.contains('network is unreachable') ||
        s.contains('failed host lookup') ||
        s.contains('clientexception');
  }

  /// Drains the queue in order. Returns as soon as the queue is empty or
  /// a connectivity-shaped failure is hit (further items would just fail
  /// identically -- no point burning through all of them one by one).
  /// A non-connectivity failure (e.g. a genuine validation error from one
  /// bad action) does NOT stop the drain -- that failure is specific to
  /// that action, not the connection, so later items still get a chance.
  static Future<OfflineSyncResult> syncAll(
    String userId,
    String token,
  ) async {
    final queue = await _readQueue(userId);
    if (queue.isEmpty) {
      return const OfflineSyncResult(synced: 0, remaining: 0, failed: 0);
    }

    final resolvedIds = <String, String>{};
    var synced = 0;
    var failed = 0;
    final rejectedNames = <String>[];
    final wifiRejectedIds = <String>[];
    final remaining = <Map<String, dynamic>>[];

    for (var i = 0; i < queue.length; i++) {
      final action = queue[i];
      final dependsOn = action['depends_on'] as String?;

      if (dependsOn != null && !resolvedIds.containsKey(dependsOn)) {
        // Parent action hasn't synced yet (this pass or ever) -- keep
        // this one queued, try again on the next syncAll() call.
        remaining.add(action);
        continue;
      }

      try {
        await _runOne(action, token, resolvedIds);
        synced++;
      } on _FaceRejected catch (e) {
        // Deliberately NOT added to `remaining` -- the same queued photo
        // would just fail the same verify-face check again forever, and
        // attendance was never marked for this action, so there is
        // nothing left to retry. Tracked separately from `failed` so
        // callers can tell "will resolve itself once online" apart from
        // "needs the person to redo Face Verification live".
        rejectedNames.add(e.userName);
        // Not a connectivity error -- the rest of the queue still gets a
        // chance this pass.
      } on _WifiRejected catch (e) {
        // Same reasoning as _FaceRejected above: this is a definitive
        // server verdict, not a transport failure, so it's dropped from
        // the queue instead of retried, and tracked separately so the
        // caller can tell the person to reconnect to office WiFi and
        // mark again live rather than believing the cached mark is still
        // pending.
        wifiRejectedIds.add(e.clientActionId);
      } catch (e) {
        failed++;
        action['attempts'] = (action['attempts'] as int? ?? 0) + 1;
        action['last_error'] = e.toString();
        remaining.add(action);

        if (_looksLikeConnectivityError(e)) {
          // Connection's gone -- stop here, requeue everything else
          // untouched so ordering/dependencies are preserved exactly.
          remaining.addAll(queue.sublist(i + 1));
          break;
        }
      }
    }

    await _writeQueue(userId, remaining);
    return OfflineSyncResult(
      synced: synced,
      remaining: remaining.length,
      failed: failed,
      rejected: rejectedNames.length,
      wifiRejected: wifiRejectedIds.length,
    );
  }

  static Future<void> _runOne(
    Map<String, dynamic> action,
    String token,
    Map<String, String> resolvedIds,
  ) async {
    final type = action['type'] as String;
    final payload = Map<String, dynamic>.from(action['payload'] as Map);
    final clientActionId = action['client_action_id'] as String;
    final dependsOn = action['depends_on'] as String?;

    switch (type) {
      case 'attendance_mark':
        await ApiService.markFieldAttendance(
          token,
          payload['user_id'] as String,
          payload['user_name'] as String,
          (payload['lat'] as num).toDouble(),
          (payload['lng'] as num).toDouble(),
          Map<String, dynamic>.from(payload['geofence'] as Map? ?? {}),
          isMocked: payload['is_mocked'] as bool? ?? false,
          syncedAfterOffline: true,
          clientActionId: clientActionId,
        );
        break;

      case 'attendance_mark_office':
        // Office check-in and check-out are the SAME call
        // (mark_client_staff_attendance toggles between them by whether
        // an attendance row already exists for today) -- unlike visits,
        // there is no separate visit_id to resolve, so this never needs
        // dependsOn/resolvedIds. Ordering alone (FIFO drain) is what
        // guarantees a queued check-in lands before its queued checkout
        // is attempted.
        try {
          await ApiService.markAttendance(
            token,
            ssid: payload['ssid'] as String?,
            bssid: payload['bssid'] as String?,
            wifiVerified: payload['wifi_verified'] as bool? ?? false,
            syncedAfterOffline: true,
            clientActionId: clientActionId,
          );
        } on ApiException catch (e) {
          if (e.code == 'wifi_not_verified') {
            // The device wasn't actually on the assigned office network
            // at capture time (or a client wifi_verified=true was wrong/
            // spoofed) -- the server's independent bssid check said no.
            // See _WifiRejected's docstring for why this must not be
            // requeued.
            throw _WifiRejected(clientActionId);
          }
          rethrow;
        }
        break;

      case 'field_attendance_offline':
        // Deferred completion of a selfie captured while offline (see
        // face_verification_screen.dart's connectivity-failure branch).
        // Runs the real verify-face now that connectivity is back, and
        // only calls mark-attendance if it actually matched. A mismatch
        // is a definitive "no" from the server, not something a human
        // should quietly review after the fact -- so on
        // verified == false, attendance is deliberately NEVER marked for
        // this action (see _FaceRejected below); the person has to stand
        // in front of the camera again and redo Face Verification live.
        final photoPath = payload['photo_path'] as String;
        final photoFile = File(photoPath);
        if (!await photoFile.exists()) {
          // Nothing left to verify against -- the app/OS may have cleared
          // its documents dir between capture and sync. Not a
          // connectivity error, so this action gets dropped (requeuing it
          // forever would never succeed) rather than blocking the rest of
          // the drain.
          throw StateError('Queued selfie no longer exists at $photoPath');
        }
        final bytes = await photoFile.readAsBytes();
        final base64Image = base64Encode(bytes);

        final verifyResult = await ApiService.verifyFace(
          token, payload['user_id'] as String, base64Image,
        );
        final faceVerified = verifyResult['verified'] == true;
        final faceSimilarity = (verifyResult['similarity'] as num?)?.toDouble();

        if (!faceVerified) {
          // Best-effort cleanup -- nothing left to retry this photo
          // against, it already got its one verify-face verdict.
          try {
            await photoFile.delete();
          } catch (_) {}
          throw _FaceRejected(
            clientActionId,
            payload['user_name'] as String? ?? 'You',
          );
        }

        await ApiService.markFieldAttendance(
          token,
          payload['user_id'] as String,
          payload['user_name'] as String,
          (payload['lat'] as num).toDouble(),
          (payload['lng'] as num).toDouble(),
          Map<String, dynamic>.from(payload['geofence'] as Map? ?? {}),
          isMocked: payload['is_mocked'] as bool? ?? false,
          syncedAfterOffline: true,
          clientActionId: clientActionId,
          faceVerified: faceVerified,
          faceSimilarity: faceSimilarity,
        );

        // Only delete once both calls above succeeded -- if either threw
        // (including a connectivity error on the second call), the photo
        // stays on disk and this whole case retries from the top on the
        // next syncAll() pass, exactly like every other queued action.
        try {
          await photoFile.delete();
        } catch (_) {
          // Best-effort cleanup -- a leftover file costs disk space, not
          // correctness (mark-attendance already succeeded and is keyed
          // off client_action_id, so a future accidental resync of this
          // same action would just replay idempotently, not double-mark).
        }
        break;

      case 'add_stop':
        final result = await ApiService.addOwnVisitStop(
          token,
          payload['plan_id'] as String,
          locationLabel: payload['location_label'] as String,
          lat: (payload['lat'] as num).toDouble(),
          lng: (payload['lng'] as num).toDouble(),
          radiusMeters: (payload['radius_meters'] as num?)?.toInt() ?? 150,
          purpose: payload['purpose'] as String?,
          clientActionId: clientActionId,
        );
        resolvedIds[clientActionId] = result['id'] as String;
        break;

      case 'log_visit':
        // If this visit targets a stop that was ITSELF still queued when
        // logged (dependsOn points at that stop's action id), resolve it
        // to the real server id here -- syncAll() only reaches this case
        // once dependsOn is present in resolvedIds, so this is always
        // resolvable when we get here, never a guess.
        var planStopId = payload['plan_stop_id'] as String?;
        if (planStopId != null &&
            planStopId.startsWith('pending:') &&
            dependsOn != null) {
          planStopId = resolvedIds[dependsOn];
        }
        final result = await ApiService.logVisit(
          token,
          latitude: (payload['latitude'] as num).toDouble(),
          longitude: (payload['longitude'] as num).toDouble(),
          planStopId: planStopId,
          distanceFromStopMeters:
              (payload['distance_from_stop_meters'] as num?)?.toDouble(),
          note: payload['note'] as String?,
          evidenceMode: payload['evidence_mode'] as String? ?? 'gps_only',
          clientActionId: clientActionId,
        );
        resolvedIds[clientActionId] = result['id'] as String;
        break;

      case 'check_out_visit':
        final visitId = (payload['visit_id'] as String?) ??
            (dependsOn != null ? resolvedIds[dependsOn] : null);
        if (visitId == null) {
          // Should be unreachable -- syncAll() only calls _runOne once
          // dependsOn is resolved or absent. Guard anyway rather than
          // send a checkout with a null target.
          throw StateError('Checkout has no resolvable visit id yet');
        }
        await ApiService.checkOutVisit(
          token,
          visitId,
          latitude: (payload['latitude'] as num).toDouble(),
          longitude: (payload['longitude'] as num).toDouble(),
          clientActionId: clientActionId,
        );
        break;

      default:
        throw StateError('Unknown queued action type: $type');
    }
  }

  static Future<void> clearAll(String userId) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_key(userId));
  }
}

class OfflineSyncResult {
  final int synced;
  final int remaining;
  final int failed;
  // Count of queued offline selfies whose deferred verify-face came back
  // with no match once connectivity returned. These are NOT included in
  // `remaining` -- attendance was never marked for them and retrying the
  // same photo would only fail identically -- so callers must surface
  // this count to the person and prompt them to redo Face Verification
  // live, or it silently disappears from view.
  final int rejected;
  // Count of queued office check-in/out actions whose deferred sync came
  // back rejected because the device wasn't on the assigned office WiFi
  // (see _WifiRejected). Also NOT included in `remaining` for the same
  // reason as `rejected` -- attendance was never marked, and retrying
  // would just fail identically. Callers must surface this to the person
  // and correct any optimistic "Present (cached)" UI state, or the app
  // shows them as present for a day the server never actually recorded.
  final int wifiRejected;
  const OfflineSyncResult({
    required this.synced,
    required this.remaining,
    required this.failed,
    this.rejected = 0,
    this.wifiRejected = 0,
  });

  bool get hasPending => remaining > 0;
  bool get hasRejected => rejected > 0;
  bool get hasWifiRejected => wifiRejected > 0;
}