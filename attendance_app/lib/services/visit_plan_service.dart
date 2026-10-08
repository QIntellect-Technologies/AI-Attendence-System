import 'geofence_service.dart';

/// Status of one planned stop, computed on-device from raw plan/visit data
/// fetched via GET /api/field/visits/today. Mirrors what
/// support_db_visits.get_plan_raw deliberately does NOT compute server-side
/// -- see that function's docstring for why this moved here.
enum StopStatus { pending, checkedIn, completed, completedOutOfRange }

class StopWithStatus {
  final Map<String, dynamic> stop;
  final StopStatus status;
  /// The visit row matched to this stop, if one has been logged (i.e.
  /// status is anything other than pending). Null exactly when status ==
  /// StopStatus.pending.
  final Map<String, dynamic>? visit;
  const StopWithStatus(this.stop, this.status, [this.visit]);

  String get id => stop['id'] as String;
  String get locationLabel => stop['location_label'] as String? ?? '';
}

class VisitPlanSummary {
  final int plannedTotal;
  final int completed;
  final int checkedIn;
  final int pending;
  final int unplanned;
  const VisitPlanSummary({
    required this.plannedTotal,
    required this.completed,
    required this.checkedIn,
    required this.pending,
    required this.unplanned,
  });
}

class VisitPlanService {
  /// Diffs `stops` against `visits` to say which planned stops are done.
  /// Pure function, no network -- this is the on-device mirror of the
  /// completed_stop_ids set-diff that used to run inside
  /// get_plan_with_progress on every request. Call this once per
  /// stops/visits fetch (e.g. in setState after the API response lands),
  /// not on every rebuild -- it's cheap but there's no reason to redo it
  /// on every frame either.
  ///
  /// Status is keyed off `verified_inside_geofence` -- computed
  /// server-side in log_visit from the stop's real lat/lng against the
  /// submitted GPS fix -- NOT merely off whether a visit row with a
  /// matching plan_stop_id exists. A visit always gets logged regardless
  /// of distance (see log_visit's docstring), so "a visit exists" alone
  /// only tells you the stop was tapped, not that the person was there.
  /// A stop whose logged visit was verified outside its radius shows as
  /// completedOutOfRange rather than a plain green "completed."
  static List<StopWithStatus> computeStopStatuses(
    List<dynamic> stops,
    List<dynamic> visits,
  ) {
    final visitByStopId = <String, Map<String, dynamic>>{};
    for (final raw in visits) {
      final v = raw as Map<String, dynamic>;
      final stopId = v['plan_stop_id'] as String?;
      if (stopId != null) visitByStopId[stopId] = v;
    }

    return stops.map((raw) {
      final stop = raw as Map<String, dynamic>;
      final visit = visitByStopId[stop['id']];
      StopStatus status;
      if (visit == null) {
        status = StopStatus.pending;
      } else if (visit['checked_out_at'] == null) {
        // Visit logged but not yet checked out -- distinct from
        // "completed" so the screen can show an active check-in state
        // and offer a Check Out action instead of a final duration.
        status = StopStatus.checkedIn;
      } else {
        final verifiedInside = visit['verified_inside_geofence'];
        // Older rows logged before this field existed will have it as
        // null -- treat those as completed (best-effort, no regression
        // for historical data) rather than flagging them.
        status = (verifiedInside == false)
            ? StopStatus.completedOutOfRange
            : StopStatus.completed;
      }
      return StopWithStatus(stop, status, visit);
    }).toList();
  }

  /// 'pending' vs 'skipped' is a display decision based on the current
  /// time of day, not something the data alone can answer -- a stop with
  /// a 2pm window that's still pending at 10am isn't "skipped" yet. This
  /// is why isSkipped takes `now` explicitly rather than being baked into
  /// StopStatus: the same stop's displayed label can change purely by the
  /// clock ticking forward, with no new network call needed.
  static bool isSkipped(StopWithStatus stop, DateTime now) {
    if (stop.status == StopStatus.completed ||
        stop.status == StopStatus.completedOutOfRange ||
        stop.status == StopStatus.checkedIn) return false;
    final windowEnd = stop.stop['window_end'] as String?;
    if (windowEnd == null) return false; // no window = never "skipped," only pending all day
    final parts = windowEnd.split(':');
    if (parts.length < 2) return false;
    final hour = int.tryParse(parts[0]);
    final minute = int.tryParse(parts[1]);
    if (hour == null || minute == null) return false;
    final deadline = DateTime(now.year, now.month, now.day, hour, minute);
    return now.isAfter(deadline);
  }

  /// Aggregate counts for the Visits tab header ("6 of 8 stops"). Pure
  /// arithmetic over data the screen already has in memory.
  static VisitPlanSummary computeSummary(
    List<dynamic> stops,
    List<dynamic> visits,
    DateTime now,
  ) {
    final withStatus = computeStopStatuses(stops, visits);
    final completed = withStatus
        .where((s) =>
            s.status == StopStatus.completed ||
            s.status == StopStatus.completedOutOfRange)
        .length;
    final checkedIn =
        withStatus.where((s) => s.status == StopStatus.checkedIn).length;
    final unplanned = visits.where((v) => v['plan_stop_id'] == null).length;
    return VisitPlanSummary(
      plannedTotal: withStatus.length,
      completed: completed,
      checkedIn: checkedIn,
      pending: withStatus.length - completed - checkedIn,
      unplanned: unplanned,
    );
  }

  /// On-device geofence evaluation for a specific plan stop -- reuses
  /// GeofenceService.calculateDistance (the same haversine implementation
  /// already used for shift attendance) instead of duplicating it, so a
  /// stop check-in and a shift check-in can never disagree about what
  /// "distance" means. Unlike shift geofence, a stop is never "not
  /// configured" -- every stop always carries its own lat/lng/radius, so
  /// this always returns a real evaluation.
  static Map<String, dynamic> evaluateStopDistance({
    required Map<String, dynamic> stop,
    required double currentLat,
    required double currentLng,
  }) {
    final stopLat = (stop['lat'] as num).toDouble();
    final stopLng = (stop['lng'] as num).toDouble();
    final radius = (stop['radius_meters'] as num?)?.toDouble() ?? 150.0;
    final distance = GeofenceService.calculateDistance(
      currentLat, currentLng, stopLat, stopLng,
    );
    return {
      'inside': distance <= radius,
      'distance': double.parse(distance.toStringAsFixed(1)),
      'radius': radius,
    };
  }

  /// How long a stop was actively visited: check-in timestamp to
  /// check-out timestamp. Pure function over the visit row itself, so it
  /// works identically for synced and still-queued (`pending:`) visits --
  /// both carry `timestamp` and `checked_out_at` in the same shape.
  /// Returns null if either end of the interval isn't known yet (e.g.
  /// still checked in, or a malformed/legacy row), so callers can decide
  /// how to render "no duration available" instead of this throwing.
  static Duration? durationOf(Map<String, dynamic>? visit) {
    if (visit == null) return null;
    final startRaw = visit['timestamp'] as String?;
    final endRaw = visit['checked_out_at'] as String?;
    if (startRaw == null || endRaw == null) return null;
    final start = DateTime.tryParse(startRaw);
    final end = DateTime.tryParse(endRaw);
    if (start == null || end == null) return null;
    final diff = end.difference(start);
    return diff.isNegative ? Duration.zero : diff;
  }

  /// Renders a Duration as "1h 23m" / "45m" for the stop tile. Drops the
  /// hours segment entirely rather than showing "0h 45m" -- minutes-only
  /// visits are the common case for quick stops.
  static String formatDuration(Duration duration) {
    final hours = duration.inHours;
    final minutes = duration.inMinutes.remainder(60);
    if (hours > 0) {
      return minutes > 0 ? '${hours}h ${minutes}m' : '${hours}h';
    }
    return '${minutes}m';
  }

  /// Client-side evidence gate -- decides whether the "Log Visit" button
  /// should be enabled, given the evidence_mode cached on UserModel
  /// (session, refreshed at login/GET /api/staff/me -- see
  /// UserModel.visitEvidenceMode) and what the user has provided so far.
  /// The server never re-checks this (see log_visit's docstring in
  /// support_db_visits.py) -- it's UX, not a security boundary, so it
  /// belongs entirely here.
  static bool canSubmitVisit({
    required String evidenceMode,
    required bool hasPhoto,
    required bool hasNote,
  }) {
    switch (evidenceMode) {
      case 'gps_photo':
        return hasPhoto;
      case 'gps_photo_note':
        return hasPhoto && hasNote;
      case 'gps_only':
      default:
        return true;
    }
  }
}