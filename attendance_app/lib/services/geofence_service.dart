import 'dart:convert';
import 'dart:math';
import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;
import '../config/app_config.dart';

class GeofenceService {
  static const String baseUrl = AppConfig.baseUrl;

  /// True when [position] was reported by a mock/fake location provider
  /// (Android: Developer Options "mock location app", or any of the free
  /// "Fake GPS" apps that register themselves as the mock provider --
  /// exactly the class of app used to bypass geofencing before this check
  /// existed). `Position.isMocked` is populated by Geolocator from the
  /// platform location API itself, so this is a real OS-level signal, not
  /// something derived from the coordinates.
  ///
  /// This is a single shared choke point rather than each attendance/visit
  /// screen reading `position.isMocked` inline, so every caller applies the
  /// exact same rule and a future screen can't forget the check. Callers
  /// MUST treat `true` as a hard stop on THIS device, not a warning the
  /// employee can dismiss -- unlike the geofence-distance check below,
  /// there is no legitimate reason for a real location fix to be mocked.
  ///
  /// This is still only one layer, not the whole defense: it can be
  /// unreliable on iOS and defeated by a rooted/patched client, which is
  /// exactly why the server independently recomputes the geofence from the
  /// submitted coordinates (support_db.evaluate_field_geofence) rather than
  /// trusting either this flag or the on-device distance calculation below.
  static bool isMockLocation(Position position) => position.isMocked;

  /// Returns distance in meters between two lat/lng points
  static double calculateDistance(
      double lat1, double lng1, double lat2, double lng2) {
    const earthRadius = 6371000.0; // meters
    final dLat = _toRad(lat2 - lat1);
    final dLng = _toRad(lng2 - lng1);
    final a = sin(dLat / 2) * sin(dLat / 2) +
        cos(_toRad(lat1)) * cos(_toRad(lat2)) * sin(dLng / 2) * sin(dLng / 2);
    final c = 2 * atan2(sqrt(a), sqrt(1 - a));
    return earthRadius * c;
  }

  static double _toRad(double deg) => deg * pi / 180;

  /// Evaluate this field employee's live GPS fix against their OWN
  /// assigned geofence -- computed entirely on-device now. This used to
  /// POST to /api/field/check-geofence and wait on a server round trip
  /// (which itself re-read the staff row from the DB) for every single
  /// check; the geofence config (geofenceLat/geofenceLng/
  /// geofenceRadiusMeters/geofenceLabel) is already pushed to the app at
  /// login/refresh via UserModel (GET /api/staff/me), so there is nothing
  /// left for the server to look up here. Mirrors
  /// support_db.evaluate_field_geofence's exact contract so the two can
  /// never disagree, in case that server-side copy is ever needed again
  /// (e.g. an admin-facing preview) -- it just no longer sits on this
  /// app's attendance-marking path.
  ///
  /// Returns: {'configured': bool, 'inside': bool, 'distance': double,
  /// 'radius': double, 'label': String?}
  ///
  /// `configured` is the important field here: when this employee has no
  /// assigned geofence yet (Staff Management's "Assigned Geofence
  /// Location" field), this returns `configured: false` alongside
  /// `inside: false, distance: 0` -- distinguishing "no site to measure
  /// against" from "measured 0m and you're still outside," which look
  /// identical if you only inspect `inside`/`distance`.
  static Map<String, dynamic> evaluateGeofence({
    required double? geofenceLat,
    required double? geofenceLng,
    required int geofenceRadius,
    required String? label,
    required double currentLat,
    required double currentLng,
  }) {
    if (geofenceLat == null || geofenceLng == null) {
      return {
        'configured': false,
        'inside': false,
        'distance': 0.0,
        'radius': geofenceRadius.toDouble(),
        'label': label,
      };
    }

    final distance =
        calculateDistance(currentLat, currentLng, geofenceLat, geofenceLng);
    return {
      'configured': true,
      'inside': distance <= geofenceRadius,
      'distance': double.parse(distance.toStringAsFixed(1)),
      'radius': geofenceRadius.toDouble(),
      'label': label,
    };
  }

  /// Send geo-alert to server when user is outside geofence
  static Future<void> sendGeoAlert({
    required String userId,
    required String token,
    required double latitude,
    required double longitude,
    required double distance,
  }) async {
    try {
      await http
          .post(
            Uri.parse('$baseUrl/api/field/geo-alert'),
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer $token',
            },
            body: jsonEncode({
              'user_id': userId,
              'latitude': latitude,
              'longitude': longitude,
              'distance': distance,
              'timestamp': DateTime.now().toIso8601String(),
            }),
          )
          .timeout(const Duration(seconds: 8));
    } catch (_) {
      
      print('Failed to send geo-alert');
    }
  }
}