class UserModel {
  /// Backend ids are int for legacy SQLite orgs and UUID strings for
  /// Supabase orgs (client_staff/client_users) — normalized to String so
  /// this model never cares which backend produced it. Widen this back to
  /// a dynamic/int type only if the app drops Supabase-org support.
  final String id;
  final String name;
  final String email;
  final String role;
  final String staffType;
  final String department;
  final String phone;
  final String token;

  /// Raw Supabase org/branch ids from the JWT-scoped session — NOT the
  /// same value as the Client Dashboard's UI-mapped numeric branch id
  /// (see support_db._client_staff_safe on the backend). Protected
  /// endpoints derive org/branch scope from the bearer token server-side
  /// (g.client_staff), so these are informational/display only — do not
  /// wire a future "UI branch id" field into these without renaming, or
  /// the two id spaces will get silently conflated.
  final String? organizationId;
  final String? branchId;

  /// Module access for gating screens/menu items. Deliberately absent
  /// from the login response and JWT (see client_staff_auth._mint_token) —
  /// a 30-day token embedding stale access_modules would keep showing
  /// revoked access until it expired. Populated by a follow-up call to
  /// GET /api/staff/me right after login (see LoginScreen), and should be
  /// refreshed periodically the same way for the same reason.
  final List<String> accessModules;

  /// Field-staff geofence (static-location scenario) — the site this
  /// person is expected to be at, and how far from it (meters) still
  /// counts as "there." Populated from GET /api/staff/me / login
  /// (support_db._client_staff_safe's geofence_lat / geofence_lng /
  /// geofence_radius_meters / geofence_label). Null lat/lng means "not
  /// configured yet" — GeofenceService.evaluateGeofence treats that as
  /// distinct from a real 0,0 point, same contract the backend's
  /// evaluate_field_geofence uses. These previously read the wrong JSON
  /// keys (location_lat/location_lng/geofence_radius/assigned_location,
  /// none of which the backend ever sends) and were always null/default;
  /// fixing the keys is what makes on-device geofence evaluation possible
  /// instead of requiring a server round trip on every check.
  final double? geofenceLat;
  final double? geofenceLng;
  final int geofenceRadiusMeters;
  final String? geofenceLabel;
  final bool isFaceVerified;

  /// Scenario 2 (Visit Plan) evidence requirement -- 'gps_only' |
  /// 'gps_photo' | 'gps_photo_note'. Cached here at login/GET
  /// /api/staff/me exactly like geofenceLat/officeSsid above, instead of
  /// client_field_visits_routes.py's /today looking it up fresh on every
  /// call -- see that route's docstring. Refresh on the same cadence as
  /// the rest of this session data; if a branch admin changes the
  /// requirement mid-day, the app picks it up on the next /me refresh,
  /// not instantly -- same staleness tradeoff already accepted for
  /// geofence/WiFi config.
  final String visitEvidenceMode;

  /// Office-staff WiFi config — replaces office_home_screen.dart's old
  /// hardcoded _officeSSID/_officeBSSID constants. Populated from
  /// GET /api/staff/me (support_db._client_staff_safe's office_ssid /
  /// office_bssid_list, a JSON list since a mesh office can have more
  /// than one access point on the same SSID). Null/empty means "not
  /// configured yet" — office_home_screen.dart should not silently match
  /// an empty SSID against a real network.
  final String? officeSsid;
  final List<String> officeBssidList;

  UserModel({
    required this.id,
    required this.name,
    required this.email,
    required this.role,
    required this.staffType,
    required this.department,
    this.phone = '',
    required this.token,
    this.organizationId,
    this.branchId,
    this.accessModules = const [],
    this.geofenceLat,
    this.geofenceLng,
    this.geofenceRadiusMeters = 150,
    this.geofenceLabel,
    this.isFaceVerified = false,
    this.visitEvidenceMode = 'gps_only',
    this.officeSsid,
    this.officeBssidList = const [],
  });

  bool get isFieldStaff => staffType == 'field';
  bool get isOfficeStaff => staffType == 'office';

  bool hasModuleAccess(String moduleKey) => accessModules.contains(moduleKey);

  static String _idToString(dynamic value) =>
      value == null ? '' : value.toString();

  static List<String> _stringList(dynamic value) {
    if (value is List) {
      return value
          .map((e) => e.toString().trim())
          .where((e) => e.isNotEmpty)
          .toList();
    }
    return const [];
  }

  factory UserModel.fromJson(Map<String, dynamic> json) {
    return UserModel(
      id: _idToString(json['id']),
      name: json['name'] ?? '',
      email: json['email'] ?? '',
      role: json['role'] ?? '',
      staffType: json['staff_type'] ?? 'office',
      department: json['department'] ?? '',
      phone: json['phone'] ?? '',
      token: json['token'] ?? '',
      // /api/staff/login returns raw 'org_id'/'branch_id'; other backend
      // responses may use 'organization_id' — accept either without
      // caring which one produced this particular JSON.
      organizationId: (json['org_id'] ?? json['organization_id'])?.toString(),
      branchId: json['branch_id']?.toString(),
      accessModules: _stringList(json['access_modules'] ?? json['accessModules']),
      geofenceLat: json['geofence_lat'] != null
          ? double.tryParse(json['geofence_lat'].toString())
          : null,
      geofenceLng: json['geofence_lng'] != null
          ? double.tryParse(json['geofence_lng'].toString())
          : null,
      geofenceRadiusMeters:
          int.tryParse(json['geofence_radius_meters']?.toString() ?? '') ?? 150,
      geofenceLabel: json['geofence_label'],
      isFaceVerified: json['is_face_verified'] ?? false,
      // Defaults to 'gps_only' for older cached sessions/backends that
      // predate this field -- VisitPlanService.canSubmitVisit treats that
      // as "no extra evidence required," the least-restrictive fallback,
      // rather than silently blocking the Log Visit button.
      visitEvidenceMode: json['visit_evidence_mode'] as String? ?? 'gps_only',
      officeSsid: json['office_ssid'] ?? json['officeSsid'],
      officeBssidList: _stringList(
        json['office_bssid_list'] ?? json['officeBssidList'],
      ),
    );
  }

  /// Merges fields from a follow-up profile fetch (GET /api/staff/me)
  /// into the session object returned by login. Intentionally does NOT
  /// accept organizationId/branchId here — /me's branch_id is the
  /// Dashboard's UI-mapped numeric id, a different id space than the raw
  /// one login/JWT use, and merging it in would silently corrupt whichever
  /// call site still relies on the raw value. Add a separate branchUiId
  /// field instead if/when something needs the UI-mapped one.
  UserModel copyWith({
    String? name,
    String? department,
    String? phone,
    List<String>? accessModules,
    bool? isFaceVerified,
    String? officeSsid,
    List<String>? officeBssidList,
    double? geofenceLat,
    double? geofenceLng,
    int? geofenceRadiusMeters,
    String? geofenceLabel,
    String? visitEvidenceMode,
  }) {
    return UserModel(
      id: id,
      name: name ?? this.name,
      email: email,
      role: role,
      staffType: staffType,
      department: department ?? this.department,
      phone: phone ?? this.phone,
      token: token,
      organizationId: organizationId,
      branchId: branchId,
      accessModules: accessModules ?? this.accessModules,
      geofenceLat: geofenceLat ?? this.geofenceLat,
      geofenceLng: geofenceLng ?? this.geofenceLng,
      geofenceRadiusMeters: geofenceRadiusMeters ?? this.geofenceRadiusMeters,
      geofenceLabel: geofenceLabel ?? this.geofenceLabel,
      isFaceVerified: isFaceVerified ?? this.isFaceVerified,
      visitEvidenceMode: visitEvidenceMode ?? this.visitEvidenceMode,
      officeSsid: officeSsid ?? this.officeSsid,
      officeBssidList: officeBssidList ?? this.officeBssidList,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'email': email,
        'role': role,
        'staff_type': staffType,
        'department': department,
        'phone': phone,
        'token': token,
        'organization_id': organizationId,
        'branch_id': branchId,
        'access_modules': accessModules,
        'geofence_lat': geofenceLat,
        'geofence_lng': geofenceLng,
        'geofence_radius_meters': geofenceRadiusMeters,
        'geofence_label': geofenceLabel,
        'is_face_verified': isFaceVerified,
        'visit_evidence_mode': visitEvidenceMode,
        'office_ssid': officeSsid,
        'office_bssid_list': officeBssidList,
      };
}