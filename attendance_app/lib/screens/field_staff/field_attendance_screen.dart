import 'dart:async';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import '../../models/user_model.dart';
import '../../services/api_service.dart';
import '../../services/geofence_service.dart';
import '../../services/offline_queue_service.dart';
import '../../utils/app_theme.dart';
import '../../services/face_verification_screen.dart';

class FieldAttendanceScreen extends StatefulWidget {
  final UserModel user;
  const FieldAttendanceScreen({super.key, required this.user});
  @override
  State<FieldAttendanceScreen> createState() => _FieldAttendanceScreenState();
}

/// Terminal state of an attendance attempt. Kept as one enum rather than a
/// second boolean bolted on next to `_success` so the UI can never render
/// an invalid combination (e.g. "success" and "pending review" both true) --
/// exactly the class of bug that let the offline face-mismatch path show a
/// full green checkmark identical to a real confirmed mark.
enum _AttendanceOutcome {
  none,
  success,
  // Face check was deferred (offline capture); attendance is queued but not
  // confirmed until the real verify-face result comes back. Must render
  // visibly differently from `success` -- never collapse this back into it.
  pendingReview,
}

class _FieldAttendanceScreenState extends State<FieldAttendanceScreen> {
  // Same palette aliases as the rest of the field/office screens -- keep
  // any new color additions in AppTheme, not as raw hex here.
  static const _card = AppTheme.cardColor;
  static const _indigo = AppTheme.navy700;
  static const _green = AppTheme.successColor;
  static const _red = AppTheme.error;
  static const _amber = AppTheme.amber;

  bool _loading = false;
  String _status = '';
  _AttendanceOutcome _outcome = _AttendanceOutcome.none;
  bool get _success => _outcome == _AttendanceOutcome.success;
  bool get _pendingReview => _outcome == _AttendanceOutcome.pendingReview;
  // Either terminal state ends the flow the same way for controls like the
  // main button (disabled, no retry) -- see usages below.
  bool get _resolved => _success || _pendingReview;
  Position? _position;

  // Step tracking
  // 0 = idle, 1 = location check, 2 = geofence check, 3 = face verify, 4 = marking
  int _step = 0;

  // Geofence result
  bool _insideGeofence = false;
  double? _distanceMeters;
  // False only once the server has explicitly told us this employee has
  // no assigned geofence yet -- see GeofenceService.checkGeofence's
  // `configured` flag. Starts true so we don't flash a warning before the
  // first check even runs.
  bool _geofenceConfigured = true;

  // ─── Offline queue ────────────────────────────────────────────────────
  // Generic queue (OfflineQueueService) rather than the office side's
  // single-slot SharedPreferences cache -- see that service's module
  // docstring for why a field day can queue more than one pending action.
  int _pendingCount = 0;
  Timer? _syncTimer;

  @override
  void initState() {
    super.initState();
    _refreshPendingCount();
    _syncTimer = Timer.periodic(
      const Duration(minutes: 2),
      (_) => _syncPending(silent: true),
    );
  }

  @override
  void dispose() {
    _syncTimer?.cancel();
    super.dispose();
  }

  Future<void> _refreshPendingCount() async {
    final count = await OfflineQueueService.pendingCount(widget.user.id);
    if (mounted) setState(() => _pendingCount = count);
  }

  Future<void> _syncPending({bool silent = false}) async {
    final result =
        await OfflineQueueService.syncAll(widget.user.id, widget.user.token);
    if (!mounted) return;
    if (result.synced > 0) {
      setState(() {
        _pendingCount = result.remaining;
        if (!silent) _status = 'Synced ${result.synced} pending action(s).';
      });
    } else if (result.remaining != _pendingCount) {
      setState(() => _pendingCount = result.remaining);
    }
    if (result.hasRejected) {
      // The deferred verify-face for an offline selfie came back with no
      // match -- attendance was deliberately NOT marked for it (see
      // OfflineQueueService's _FaceRejected). Never let this pass
      // silently: block with a dialog so it can't be missed the way a
      // toast could be, and offer to jump straight back into a live
      // Face Verification attempt.
      await _showFaceRejectedDialog(result.rejected);
    }
  }

  Future<void> _showFaceRejectedDialog(int count) async {
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        backgroundColor: _card,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: Row(
          children: [
            const Icon(Icons.face_retouching_off, color: _red),
            const SizedBox(width: 8),
            const Text('Face Does Not Match',
                style: TextStyle(
                    color: AppTheme.headText,
                    fontSize: 16,
                    fontWeight: FontWeight.w700)),
          ],
        ),
        content: Text(
          count == 1
              ? 'Your offline selfie was checked now that you\'re back '
                  'online, and the face did not match. Attendance was NOT '
                  'marked. Please try again.'
              : 'Your offline selfies were checked now that you\'re back '
                  'online, and $count did not match. Attendance was NOT '
                  'marked for them. Please try again.',
          style: const TextStyle(color: AppTheme.mutedText),
        ),
        actions: [
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: _red),
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Try Again'),
          ),
        ],
      ),
    );
    if (!mounted) return;
    setState(() {
      _outcome = _AttendanceOutcome.none;
      _status = 'Face does not match. Try again.';
      _step = 0;
    });
  }
  // ─────────────────────────────────────────────────────────────────────

  Future<void> _startAttendanceFlow() async {
    setState(() {
      _loading = true;
      _step = 1;
      _status = 'Location is being fetched';
      _outcome = _AttendanceOutcome.none;
    });

    try {
      // ── Step 1: Location permission & fetch ──
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.deniedForever ||
          permission == LocationPermission.denied) {
        setState(() {
          _status = 'Location permission denied. Allow in settings.';
          _loading = false;
          _step = 0;
        });
        return;
      }

      // Genuinely no network needed for a GPS fix -- but LocationAccuracy
      // .high normally leans on Google's Fused Location Provider, which
      // speeds up its fix with network-assisted (A-GPS) data over
      // WiFi/cell. In airplane mode that assistance is gone, so a cold
      // GPS-only fix can take minutes or may never resolve indoors.
      // Previously there was no timeLimit here at all, so offline this
      // just hung on "Location is being fetched..." forever -- which is
      // what actually made geofence verification look broken too: it's
      // computed entirely on-device (see GeofenceService.evaluateGeofence)
      // and never touches the network, it just never got reached because
      // step 1 above it never returned.
      Position pos;
      try {
        pos = await Geolocator.getCurrentPosition(
          desiredAccuracy: LocationAccuracy.high,
          timeLimit: const Duration(seconds: 15),
        );
      } on TimeoutException {
        // Fall back to the device's last cached fix -- this reads from
        // the OS location cache, not the network, so it works fully
        // offline. Still genuinely this device's GPS, just not a fresh
        // one; good enough to check in against a geofence that doesn't
        // move, and far better than blocking attendance entirely because
        // a fresh cold fix couldn't complete without network assistance.
        final lastKnown = await Geolocator.getLastKnownPosition();
        if (lastKnown == null) {
          if (!mounted) return;
          setState(() {
            _status = 'Could not get a location fix. If you\'re offline, '
                'GPS can take longer without a network assist -- try '
                'moving outdoors, or wait a moment and try again.';
            _loading = false;
            _step = 0;
          });
          return;
        }
        pos = lastKnown;
        if (!mounted) return;
        setState(() {
          _status = 'Using last known location (offline) -- geofence '
              'check will use this fix.';
        });
      }

      // ── Mock/spoofed location check ──
      // Must happen before we ever look at geofence distance: a spoofing
      // app (e.g. "Fake GPS") makes the device report whatever lat/lng it
      // wants, which would sail straight through the distance check below
      // looking perfectly "inside." This is a hard stop, not a dismissible
      // warning like the geofence dialog further down -- there's no
      // legitimate reason for a real check-in to come from a mock location
      // provider, so the employee can't click past this one.
      if (!mounted) return;
      if (GeofenceService.isMockLocation(pos)) {
        setState(() {
          _position = pos;
          _status = 'Mock/simulated location detected. Attendance can\'t be '
              'marked from a spoofed GPS location. Turn off any fake-GPS '
              '/ mock-location app and try again.';
          _loading = false;
          _step = 0;
        });
        return;
      }

      if (!mounted) return;
      setState(() {
        _position = pos;
        _step = 2;
        _status = 'Geofence check is in progress...';
      });

      // ── Step 2: Geofence check (computed on-device — see
      // GeofenceService.evaluateGeofence) ──
      final geofenceResult = GeofenceService.evaluateGeofence(
        geofenceLat: widget.user.geofenceLat,
        geofenceLng: widget.user.geofenceLng,
        geofenceRadius: widget.user.geofenceRadiusMeters,
        label: widget.user.geofenceLabel,
        currentLat: pos.latitude,
        currentLng: pos.longitude,
      );

      if (!mounted) return;

      _insideGeofence = geofenceResult['inside'] == true;
      _distanceMeters = (geofenceResult['distance'] as num?)?.toDouble();
      _geofenceConfigured = geofenceResult['configured'] != false;

      // No assigned location yet -- nothing meaningful to compare against,
      // so don't show a misleading distance/inside-outside verdict. Let
      // the employee know and let them proceed straight to face
      // verification instead of a confusing "0m, outside" warning.
      if (!_geofenceConfigured) {
        if (!mounted) return;
        setState(() {
          _status =
              'No assigned location has been set for you yet. Contact your '
              'admin, or continue without a location check.';
        });
      } else if (!_insideGeofence) {
        await GeofenceService.sendGeoAlert(
          userId: widget.user.id,
          token: widget.user.token,
          latitude: pos.latitude,
          longitude: pos.longitude,
          distance: _distanceMeters ?? 0,
        );

        if (!mounted) return;

        // Show warning dialog — user can still proceed
        final proceed = await showDialog<bool>(
          context: context,
          barrierDismissible: false,
          builder: (ctx) => AlertDialog(
            backgroundColor: _card,
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
            title: Row(
              children: [
                const Icon(Icons.warning_amber_rounded, color: _amber),
                const SizedBox(width: 8),
                const Text('Geofence Alert',
                    style: TextStyle(
                        color: AppTheme.headText,
                        fontSize: 16,
                        fontWeight: FontWeight.w700)),
              ],
            ),
            content: Text(
              'You are outside the assigned geofence!\n'
              'Distance: ${_distanceMeters?.toStringAsFixed(0) ?? "?"} meters\n\n'
              'The alert has been sent to the office. Do you still want to proceed with marking attendance?',
              style: const TextStyle(color: AppTheme.mutedText),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(ctx, false),
                child: const Text('Cancel',
                    style: TextStyle(color: AppTheme.mutedText)),
              ),
              ElevatedButton(
                style: ElevatedButton.styleFrom(backgroundColor: _amber),
                onPressed: () => Navigator.pop(ctx, true),
                child: const Text('Yes, Mark Attendance'),
              ),
            ],
          ),
        );

        if (proceed != true) {
          if (mounted) {
            setState(() {
              _loading = false;
              _step = 0;
              _status = 'Attendance marking cancelled by user.';
            });
          }
          return;
        }
      }

      // ── Step 3: Face verification ──
      if (!mounted) return;
      setState(() {
        _step = 3;
        _status = 'Face verification...';
        _loading = false; // FaceVerificationScreen will handle its own loading
      });

      final faceResult = await Navigator.push<Map<String, dynamic>>(
        context,
        MaterialPageRoute(
          builder: (_) => FaceVerificationScreen(user: widget.user),
        ),
      );

      if (!mounted) return;

      if (faceResult == null) {
        setState(() {
          _step = 0;
          _status = 'Face verification failed. Please try again.';
          _loading = false;
        });
        return;
      }

      if (faceResult['offline_captured'] == true) {
        // No network for verify-face itself -- the biometric check is
        // never skipped, only deferred. Queue the selfie (by path, not
        // bytes -- see face_verification_screen.dart's comment) alongside
        // the geofence/location data already captured, and let
        // OfflineQueueService run the real verify-face -> mark-attendance
        // sequence once connectivity returns.
        setState(() {
          _step = 4;
          _loading = true;
          _status = 'Offline — queuing attendance for verification...';
        });
        await OfflineQueueService.enqueue(
          widget.user.id,
          type: 'field_attendance_offline',
          payload: {
            'user_id': widget.user.id,
            'user_name': widget.user.name,
            'lat': pos.latitude,
            'lng': pos.longitude,
            'is_mocked': GeofenceService.isMockLocation(pos),
            'geofence': geofenceResult,
            'photo_path': faceResult['photo_path'],
          },
        );
        await _refreshPendingCount();
        if (!mounted) return;
        setState(() {
          // Not _AttendanceOutcome.success -- the face has not been
          // verified yet, only queued. Rendering this as success is exactly
          // the UI-invisibility half of the face-mismatch bypass: it must
          // look and read as pending, not as a confirmed mark.
          _outcome = _AttendanceOutcome.pendingReview;
          _status = 'Face verification pending — not yet confirmed.\n'
              'This will be checked and reviewed once you\'re back online.';
          _step = 4;
        });
        return;
      }

      if (faceResult['verified'] != true) {
        setState(() {
          _step = 0;
          _status = 'Face verification failed. Please try again.';
          _loading = false;
        });
        return;
      }

      // ── Step 4: Mark attendance ──
      setState(() {
        _step = 4;
        _loading = true;
        _status = 'Marking attendance...';
      });

      try {
        final res = await ApiService.markFieldAttendance(
          widget.user.token,
          widget.user.id,
          widget.user.name,
          pos.latitude,
          pos.longitude,
          geofenceResult,
          // Already know this is false here -- a true isMockLocation()
          // returns before this call is ever reached (see above) -- but
          // sent explicitly rather than defaulted so the server always
          // gets an on-device answer instead of inferring "not mocked"
          // from a missing field.
          isMocked: GeofenceService.isMockLocation(pos),
        );

        if (!mounted) return;
        final marked = res['success'] == true;
        setState(() {
          _outcome =
              marked ? _AttendanceOutcome.success : _AttendanceOutcome.none;
          _status = res['message'] ??
              (marked ? 'Attendance marked successfully! ✅' : 'Server error occurred');
          _step = marked ? 4 : 0;
        });
      } catch (markError) {
        // Only a connectivity-shaped failure gets queued for later --
        // previously ANY exception here (a genuine validation error, a
        // 4xx from a malformed payload, etc.) was silently queued too,
        // which meant a real bug could masquerade as "cached, will sync"
        // and never surface to the user until the queued retry failed
        // again identically. A non-connectivity failure is shown as an
        // actual error instead.
        if (!OfflineQueueService.looksOffline(markError)) {
          if (!mounted) return;
          setState(() {
            _outcome = _AttendanceOutcome.none;
            _status = 'Error: ${markError.toString()}';
            _step = 0;
          });
          return;
        }

        // Server unreachable -- queue it rather than losing the mark
        // entirely. Optimistically show success locally (same UX
        // decision the office side already made -- see
        // office_home_screen.dart's `_todayCachedPresent`), and the
        // periodic/manual sync will reconcile it with the server's
        // actual response once reachable.
        if (!mounted) return;
        await OfflineQueueService.enqueue(
          widget.user.id,
          type: 'attendance_mark',
          payload: {
            'user_id': widget.user.id,
            'user_name': widget.user.name,
            'lat': pos.latitude,
            'lng': pos.longitude,
            'is_mocked': GeofenceService.isMockLocation(pos),
            'geofence': geofenceResult,
          },
        );
        await _refreshPendingCount();
        if (!mounted) return;
        setState(() {
          // Legitimately success here -- unlike the offline_captured branch
          // above, faceResult['verified'] == true already, so the only
          // thing deferred is the network call to persist the mark.
          _outcome = _AttendanceOutcome.success;
          _status = 'Server not reachable — attendance cached.\n'
              'It will sync automatically once you\'re back online.';
          _step = 4;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _status = 'Error: ${e.toString()}';
          _step = 0;
        });
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Widget _sectionCard({required Widget child}) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: _card,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppTheme.borderColor),
      ),
      child: child,
    );
  }

  // Step indicator widget
  Widget _buildStepRow() {
    final steps = [
      {'icon': Icons.location_on, 'label': 'Location'},
      {'icon': Icons.radar, 'label': 'Geofence'},
      {'icon': Icons.face, 'label': 'Face'},
      {'icon': Icons.check_circle, 'label': 'Mark'},
    ];

    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: List.generate(steps.length, (i) {
        final stepNum = i + 1;
        final isActive = _step == stepNum;
        final isDone = _step > stepNum;
        final color = isDone
            ? _green
            : isActive
                ? _indigo
                : AppTheme.mutedText.withValues(alpha: 0.4);

        return Expanded(
          child: Row(
            children: [
              Expanded(
                child: Column(
                  children: [
                    Container(
                      width: 36,
                      height: 36,
                      decoration: BoxDecoration(
                        color: color.withValues(alpha: 0.12),
                        shape: BoxShape.circle,
                        border: Border.all(color: color, width: 2),
                      ),
                      child: Icon(
                        isDone ? Icons.check : steps[i]['icon'] as IconData,
                        color: color,
                        size: 18,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      steps[i]['label'] as String,
                      style: TextStyle(
                          color: color,
                          fontSize: 10,
                          fontWeight:
                              isActive ? FontWeight.bold : FontWeight.normal),
                    ),
                  ],
                ),
              ),
              if (i < steps.length - 1)
                Container(
                  height: 2,
                  width: 20,
                  color: _step > stepNum
                      ? _green
                      : AppTheme.borderColor,
                ),
            ],
          ),
        );
      }),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.bgPage,
      appBar: AppBar(title: const Text('Mark Attendance')),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          children: [
            // Info card
            _sectionCard(
              child: Column(
                children: [
                  Icon(
                    _success
                        ? Icons.check_circle
                        : _pendingReview
                            ? Icons.hourglass_top
                            : Icons.location_on,
                    color: _success
                        ? _green
                        : _pendingReview
                            ? _amber
                            : _indigo,
                    size: 48,
                  ),
                  const SizedBox(height: 12),
                  Text(
                    _success
                        ? 'Attendance marked successfully!'
                        : _pendingReview
                            ? 'Attendance queued — pending verification'
                            : 'Mark your attendance',
                    style: const TextStyle(
                        color: AppTheme.headText,
                        fontSize: 18,
                        fontWeight: FontWeight.bold),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _success
                        ? 'Your attendance has been marked successfully.'
                        : _pendingReview
                            ? 'Face verification could not run offline. Your check-in '
                                'is queued and will not count until it is verified.'
                            : 'Location → Geofence → Face verify → Mark',
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: AppTheme.mutedText, fontSize: 13),
                  ),
                  if (_position != null) ...[
                    const SizedBox(height: 12),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(
                          'Lat: ${_position!.latitude.toStringAsFixed(6)}  '
                          'Lng: ${_position!.longitude.toStringAsFixed(6)}',
                          style: const TextStyle(
                              color: AppTheme.mutedText, fontSize: 11),
                        ),
                      ],
                    ),
                    if (_distanceMeters != null && _geofenceConfigured)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text(
                          'Assigned location se: ${_distanceMeters!.toStringAsFixed(0)} m  '
                          '(${_insideGeofence ? "Inside ✅" : "Outside ⚠️"})',
                          style: TextStyle(
                            color: _insideGeofence ? _green : _amber,
                            fontSize: 11,
                          ),
                        ),
                      )
                    else if (!_geofenceConfigured)
                      const Padding(
                        padding: EdgeInsets.only(top: 4),
                        child: Text(
                          'No assigned location on file yet',
                          style: TextStyle(
                            color: AppTheme.mutedText,
                            fontSize: 11,
                          ),
                        ),
                      ),
                  ],
                ],
              ),
            ),

            // Step indicator (only show when process started)
            if (_step > 0) _sectionCard(child: _buildStepRow()),

            if (_pendingCount > 0)
              _sectionCard(
                child: Row(
                  children: [
                    const Icon(Icons.cloud_off, color: _amber),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        '$_pendingCount action${_pendingCount == 1 ? '' : 's'} '
                        'waiting to sync',
                        style: const TextStyle(color: AppTheme.headText, fontSize: 13),
                      ),
                    ),
                    TextButton(
                      onPressed: () => _syncPending(),
                      child: const Text('Sync now'),
                    ),
                  ],
                ),
              ),

            // Status message
            if (_status.isNotEmpty)
              _sectionCard(
                child: Row(
                  children: [
                    Icon(
                      _success
                          ? Icons.check_circle
                          : (_loading || _pendingReview)
                              ? Icons.hourglass_top
                              : Icons.info_outline,
                      color: _success
                          ? _green
                          : _pendingReview
                              ? _amber
                              : _loading
                                  ? _indigo
                                  : _amber,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(_status,
                          style: const TextStyle(color: AppTheme.headText)),
                    ),
                  ],
                ),
              ),

            const Spacer(),

            // Flow description
            if (_step == 0 && !_resolved)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: Column(
                  children: [
                    _flowStep(Icons.location_on, '1. Location is fetched'),
                    _flowStep(Icons.radar, '2. Geofence check is in progress'),
                    _flowStep(Icons.face, '3. Face verification is in progress'),
                    _flowStep(Icons.check_circle, '4. Attendance marking is in progress'),
                  ],
                ),
              ),

            GestureDetector(
              onTap: (_loading || _resolved) ? null : _startAttendanceFlow,
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(vertical: 15),
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    colors: _success
                        ? [_green, _green]
                        : _pendingReview
                            ? [_amber, _amber]
                            : _loading
                                ? [Colors.grey.shade400, Colors.grey.shade500]
                                : const [AppTheme.navy700, AppTheme.navy600],
                  ),
                  borderRadius: BorderRadius.circular(14),
                  boxShadow: (_loading || _resolved)
                      ? null
                      : [
                          BoxShadow(
                              color: _indigo.withValues(alpha: 0.3),
                              blurRadius: 16,
                              offset: const Offset(0, 4))
                        ],
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    if (_loading)
                      const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                              color: Colors.white, strokeWidth: 2))
                    else
                      Icon(
                          _success
                              ? Icons.check_circle
                              : _pendingReview
                                  ? Icons.hourglass_top
                                  : Icons.location_on,
                          color: Colors.white,
                          size: 18),
                    const SizedBox(width: 8),
                    Text(
                      _success
                          ? 'Done '
                          : _pendingReview
                              ? 'Pending review'
                              : 'Mark Attendance',
                      style: const TextStyle(
                          color: Colors.white,
                          fontSize: 14,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 0.5),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _flowStep(IconData icon, String label) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Icon(icon, color: _indigo, size: 16),
          const SizedBox(width: 8),
          Text(label, style: const TextStyle(color: AppTheme.mutedText, fontSize: 13)),
        ],
      ),
    );
  }
}