import 'dart:async';
import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import '../../models/user_model.dart';
import '../../services/api_service.dart';
import '../../services/geofence_service.dart';
import '../../services/offline_queue_service.dart';
import '../../services/visit_plan_service.dart';
import '../../utils/app_theme.dart';

/// Field staff "Visits" tab -- the mobile counterpart to the Client
/// Dashboard's Visit Plans admin panel. Talks only to
/// client_field_visits_routes.py's self-service routes; never touches
/// attendance (see support_db_visits.py's module docstring for why the
/// two are kept separate -- a staff member can have zero visits logged
/// and still be marked Present off their normal check-in/check-out).
///
/// Per-stop status and the completed/pending/unplanned summary are
/// computed entirely on-device (VisitPlanService.computeStopStatuses/
/// computeSummary) from the raw { plan, stops, visits } response -- the
/// backend deliberately does not compute this, see get_plan_raw's
/// docstring.
/// Strips the dart:io HttpException wrapper down to just the message our
/// improved ApiService._decodeOrThrow put there (the real backend error
/// text), so screens show something a person can act on instead of a
/// generic "something went wrong."
String _readableError(Object e) {
  final text = e.toString();
  return text.startsWith('HttpException: ')
      ? text.substring('HttpException: '.length)
      : text;
}

class VisitPlanScreen extends StatefulWidget {
  final UserModel user;
  const VisitPlanScreen({super.key, required this.user});

  @override
  State<VisitPlanScreen> createState() => _VisitPlanScreenState();
}

class _VisitPlanScreenState extends State<VisitPlanScreen> {
  static const _card = AppTheme.cardColor;
  static const _indigo = AppTheme.navy700;
  static const _green = AppTheme.successColor;
  static const _amber = AppTheme.amber;

  bool _loading = true;
  String? _error;
  Map<String, dynamic>? _plan;
  List<dynamic> _stops = [];
  List<dynamic> _visits = [];
  bool _creatingPlan = false;
  bool _showHistory = false;
  List<dynamic> _history = [];

  // ─── Offline queue ────────────────────────────────────────────────────
  int _pendingCount = 0;
  Timer? _syncTimer;

  @override
  void initState() {
    super.initState();
    _load();
    _refreshPendingCount();
    _syncTimer = Timer.periodic(
      const Duration(minutes: 2),
      (_) => _syncPending(),
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

  Future<void> _syncPending() async {
    final result =
        await OfflineQueueService.syncAll(widget.user.id, widget.user.token);
    if (!mounted) return;
    setState(() => _pendingCount = result.remaining);
    if (result.synced > 0) {
      // Something that was only optimistically shown before is now
      // confirmed server-side (and may have gotten a real id, e.g. a
      // pending: visit or stop) -- reload to replace synthetic entries
      // with the real ones.
      await _load();
    }
  }
  // ─────────────────────────────────────────────────────────────────────

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await ApiService.getTodayVisitPlan(widget.user.token);
      if (!mounted) return;
      setState(() {
        _plan = data['plan'] as Map<String, dynamic>?;
        _stops = (data['stops'] as List?) ?? [];
        _visits = (data['visits'] as List?) ?? [];
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = 'Could not load your visit plan.\n${_readableError(e)}';
        _loading = false;
      });
    }
  }

  Future<void> _createOwnPlan() async {
    setState(() => _creatingPlan = true);
    try {
      await ApiService.createOwnVisitPlan(widget.user.token);
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not create your plan. ${_readableError(e)}')),
      );
    } finally {
      if (mounted) setState(() => _creatingPlan = false);
    }
  }

  Future<void> _loadHistory() async {
    try {
      final visits = await ApiService.getVisitHistory(widget.user.token);
      if (!mounted) return;
      setState(() {
        _history = visits;
        _showHistory = true;
      });
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not load visit history. ${_readableError(e)}')),
      );
    }
  }

  Future<void> _openAddStop() async {
    final result = await showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => const _AddStopSheet(),
    );
    if (result == null || _plan == null) return;
    try {
      await ApiService.addOwnVisitStop(
        widget.user.token,
        _plan!['id'] as String,
        locationLabel: result['locationLabel'] as String,
        lat: result['lat'] as double,
        lng: result['lng'] as double,
        radiusMeters: result['radiusMeters'] as int,
        purpose: result['purpose'] as String?,
      );
      await _load();
    } catch (e) {
      if (!OfflineQueueService.looksOffline(e)) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not add stop. ${_readableError(e)}')),
        );
        return;
      }
      final actionId = await OfflineQueueService.enqueue(
        widget.user.id,
        type: 'add_stop',
        payload: {
          'plan_id': _plan!['id'],
          'location_label': result['locationLabel'],
          'lat': result['lat'],
          'lng': result['lng'],
          'radius_meters': result['radiusMeters'],
          'purpose': result['purpose'],
        },
      );
      await _refreshPendingCount();
      if (!mounted) return;
      setState(() {
        _stops = [
          ..._stops,
          {
            'id': 'pending:$actionId',
            'location_label': result['locationLabel'],
            'lat': result['lat'],
            'lng': result['lng'],
            'radius_meters': result['radiusMeters'],
            'purpose': result['purpose'],
            'window_start': null,
            'window_end': null,
          },
        ];
      });
    }
  }

  static bool _isPendingId(String id) => id.startsWith('pending:');

  Future<void> _openLogVisit({Map<String, dynamic>? stop}) async {
    final result = await showModalBottomSheet<Map<String, dynamic>?>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _LogVisitSheet(
        user: widget.user,
        stop: stop,
      ),
    );
    if (result == null) return;

    if (result['status'] == 'synced') {
      await _load();
    } else if (result['status'] == 'queued') {
      // Server unreachable -- the sheet already enqueued the action and
      // handed back a synthetic visit shaped exactly like a real one
      // (see log_visit's response shape) so the stop tile can show
      // "checked in" immediately without a round trip that would just
      // fail again. _load() is deliberately NOT called here -- it would
      // overwrite this optimistic state with server data that doesn't
      // know about the still-queued action yet.
      if (!mounted) return;
      setState(() {
        _visits = [..._visits, result['visit']];
      });
      await _refreshPendingCount();
    }
  }

  /// Closes out an open visit -- GPS only, no evidence gate (see
  /// check_out_visit's docstring; unlike check-in, there's no
  /// "missing required photo" judgment call on the way out).
  ///
  /// `visit['id']` starting with `pending:` means the check-in itself is
  /// still queued (never synced) -- the checkout is queued too, tied to
  /// that same pending check-in via `dependsOn`, since there is no real
  /// server visit id yet to check out against. OfflineQueueService
  /// resolves that dependency once the check-in actually syncs.
  Future<void> _checkOut(Map<String, dynamic> visit) async {
    try {
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      final pos =
          await Geolocator.getCurrentPosition(desiredAccuracy: LocationAccuracy.high);
      final visitId = visit['id'] as String;
      final isPending = _isPendingId(visitId);

      if (!isPending) {
        try {
          await ApiService.checkOutVisit(
            widget.user.token,
            visitId,
            latitude: pos.latitude,
            longitude: pos.longitude,
          );
          await _load();
          return;
        } catch (e) {
          if (!OfflineQueueService.looksOffline(e)) rethrow;
          // fall through to offline queue below
        }
      }

      final dependsOn = isPending ? visitId.substring('pending:'.length) : null;
      await OfflineQueueService.enqueue(
        widget.user.id,
        type: 'check_out_visit',
        payload: {
          if (!isPending) 'visit_id': visitId,
          'latitude': pos.latitude,
          'longitude': pos.longitude,
        },
        dependsOn: dependsOn,
      );
      await _refreshPendingCount();
      if (!mounted) return;
      setState(() {
        _visits = _visits.map((v) {
          if (v['id'] != visitId) return v;
          return {...v, 'checked_out_at': DateTime.now().toIso8601String()};
        }).toList();
      });
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not check out. ${_readableError(e)}')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final summary = VisitPlanService.computeSummary(_stops, _visits, DateTime.now());
    final withStatus = VisitPlanService.computeStopStatuses(_stops, _visits);

    return Scaffold(
      backgroundColor: AppTheme.bgPage,
      appBar: AppBar(
        title: const Text('My Visits'),
        actions: [
          IconButton(
            icon: Icon(_showHistory ? Icons.list_alt : Icons.history),
            onPressed: () {
              if (_showHistory) {
                setState(() => _showHistory = false);
              } else {
                _loadHistory();
              }
            },
          ),
        ],
        bottom: _pendingCount > 0
            ? PreferredSize(
                preferredSize: const Size.fromHeight(36),
                child: Container(
                  height: 36,
                  color: _amber.withValues(alpha: 0.15),
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Row(
                    children: [
                      const Icon(Icons.cloud_off, size: 14, color: _amber),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          '$_pendingCount action${_pendingCount == 1 ? '' : 's'} waiting to sync',
                          style: const TextStyle(fontSize: 11.5, color: AppTheme.headText),
                        ),
                      ),
                      GestureDetector(
                        onTap: _syncPending,
                        child: const Text('Sync now',
                            style: TextStyle(
                                fontSize: 11.5,
                                fontWeight: FontWeight.w700,
                                color: AppTheme.navy700)),
                      ),
                    ],
                  ),
                ),
              )
            : null,
      ),
      floatingActionButton: (!_loading && _plan != null && !_showHistory)
          ? FloatingActionButton.extended(
              onPressed: _openAddStop,
              backgroundColor: _indigo,
              icon: const Icon(Icons.add_location_alt, color: Colors.white),
              label: const Text('Add Stop', style: TextStyle(color: Colors.white)),
            )
          : null,
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const Center(child: CircularProgressIndicator(color: _indigo))
            : _showHistory
                ? _buildHistoryList()
                : _error != null
                    ? _buildError()
                    : _plan == null
                        ? _buildNoPlan()
                        : _buildPlan(summary, withStatus),
      ),
    );
  }

  Widget _buildError() {
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        const SizedBox(height: 60),
        Icon(Icons.error_outline, color: AppTheme.error, size: 40),
        const SizedBox(height: 12),
        Text(
          _error!,
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 12.5, color: AppTheme.mutedText),
        ),
        const SizedBox(height: 20),
        Center(
          child: OutlinedButton.icon(
            onPressed: _load,
            icon: const Icon(Icons.refresh, size: 16),
            label: const Text('Retry'),
          ),
        ),
      ],
    );
  }

  Widget _buildNoPlan() {
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        const SizedBox(height: 60),
        const Icon(Icons.map_outlined, color: AppTheme.mutedText, size: 48),
        const SizedBox(height: 16),
        const Text(
          'No visit plan yet for today',
          textAlign: TextAlign.center,
          style: TextStyle(
              fontSize: 15, fontWeight: FontWeight.w700, color: AppTheme.headText),
        ),
        const SizedBox(height: 6),
        const Text(
          "If your admin hasn't assigned one, you can start your own — "
          "add each place you plan to visit today.",
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 12.5, color: AppTheme.mutedText),
        ),
        const SizedBox(height: 20),
        ElevatedButton.icon(
          onPressed: _creatingPlan ? null : _createOwnPlan,
          icon: _creatingPlan
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(
                      color: Colors.white, strokeWidth: 2))
              : const Icon(Icons.add),
          label: const Text('Start My Visit Plan'),
        ),
      ],
    );
  }

  Widget _buildPlan(
      VisitPlanSummary summary, List<StopWithStatus> withStatus) {
    final now = DateTime.now();
    final openUnplanned = _visits
        .where((v) => v['plan_stop_id'] == null && v['checked_out_at'] == null)
        .toList();
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 90),
      children: [
        _summaryCard(summary),
        const SizedBox(height: 16),
        if (withStatus.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 24),
            child: Text(
              'No stops planned yet. Tap "Add Stop" below to build your day.',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppTheme.mutedText, fontSize: 12.5),
            ),
          )
        else
          ...withStatus.map((s) => _stopTile(s, now)),
        if (openUnplanned.isNotEmpty) ...[
          const SizedBox(height: 8),
          const Text('Currently checked in (unplanned)',
              style: TextStyle(
                  fontSize: 11.5, fontWeight: FontWeight.w700, color: AppTheme.mutedText)),
          const SizedBox(height: 8),
          ...openUnplanned.map((v) => _openUnplannedTile(v)),
        ],
        const SizedBox(height: 20),
        OutlinedButton.icon(
          onPressed: () => _openLogVisit(),
          icon: const Icon(Icons.add_a_photo_outlined, size: 18),
          label: const Text('Log an unplanned visit'),
        ),
      ],
    );
  }

  Widget _summaryCard(VisitPlanSummary summary) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        gradient: const LinearGradient(colors: [AppTheme.navy700, AppTheme.navy600]),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceAround,
        children: [
          _summaryStat('${summary.completed}', 'Completed'),
          _summaryStat('${summary.checkedIn}', 'Checked In'),
          _summaryStat('${summary.pending}', 'Pending'),
          _summaryStat('${summary.unplanned}', 'Unplanned'),
        ],
      ),
    );
  }

  Widget _summaryStat(String value, String label) {
    return Column(
      children: [
        Text(value,
            style: const TextStyle(
                color: Colors.white, fontSize: 22, fontWeight: FontWeight.bold)),
        const SizedBox(height: 2),
        Text(label,
            style: TextStyle(color: Colors.white.withValues(alpha: 0.85), fontSize: 11)),
      ],
    );
  }

  Widget _stopTile(StopWithStatus s, DateTime now) {
    final skipped = VisitPlanService.isSkipped(s, now);
    final isDone = s.status == StopStatus.completed ||
        s.status == StopStatus.completedOutOfRange;
    final isCheckedIn = s.status == StopStatus.checkedIn;
    final color = isDone ? _green : (isCheckedIn ? _indigo : (skipped ? AppTheme.error : _amber));
    final purpose = s.stop['purpose'] as String?;
    final windowStart = s.stop['window_start'] as String?;
    final windowEnd = s.stop['window_end'] as String?;
    final duration = isDone ? VisitPlanService.durationOf(s.visit) : null;

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: _card,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.3)),
      ),
      child: Row(
        children: [
          Icon(
            isDone
                ? Icons.check_circle
                : isCheckedIn
                    ? Icons.timelapse
                    : skipped
                        ? Icons.cancel_outlined
                        : Icons.radio_button_unchecked,
            color: color,
            size: 22,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(s.locationLabel,
                    style: const TextStyle(
                        fontWeight: FontWeight.w700,
                        fontSize: 13.5,
                        color: AppTheme.headText)),
                if (purpose != null && purpose.isNotEmpty)
                  Text(purpose,
                      style: const TextStyle(
                          fontSize: 11.5, color: AppTheme.mutedText)),
                if (isDone && duration != null)
                  Text('Visited for ${VisitPlanService.formatDuration(duration)}',
                      style: const TextStyle(
                          fontSize: 11, color: AppTheme.mutedText))
                else if (isCheckedIn)
                  const Text('Checked in — not checked out yet',
                      style: TextStyle(fontSize: 11, color: AppTheme.mutedText))
                else if (windowStart != null || windowEnd != null)
                  Text('${windowStart ?? '--:--'} – ${windowEnd ?? '--:--'}',
                      style: const TextStyle(
                          fontSize: 11, color: AppTheme.mutedText)),
              ],
            ),
          ),
          if (isCheckedIn)
            TextButton(
              onPressed: () => _checkOut(s.visit!),
              child: const Text('Check Out'),
            )
          else if (!isDone)
            TextButton(
              onPressed: () => _openLogVisit(stop: s.stop),
              child: const Text('Log Visit'),
            ),
        ],
      ),
    );
  }

  /// Tile for an unplanned visit that's checked in but not checked out
  /// yet (no plan_stop_id, checked_out_at == null -- see the filter in
  /// _buildPlan). Deliberately simpler than _stopTile: there's no
  /// stop/window/purpose to show, just where the check-in came from and
  /// a Check Out action.
  Widget _openUnplannedTile(Map<String, dynamic> v) {
    final note = v['note'] as String?;
    final ts = v['timestamp'] as String?;
    final checkedInAt = ts != null ? DateTime.tryParse(ts) : null;
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: _card,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _indigo.withValues(alpha: 0.3)),
      ),
      child: Row(
        children: [
          const Icon(Icons.timelapse, color: _indigo, size: 22),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Unplanned visit',
                    style: TextStyle(
                        fontWeight: FontWeight.w700,
                        fontSize: 13.5,
                        color: AppTheme.headText)),
                if (note != null && note.isNotEmpty)
                  Text(note,
                      style: const TextStyle(
                          fontSize: 11.5, color: AppTheme.mutedText)),
                if (checkedInAt != null)
                  Text(
                      'Checked in at ${TimeOfDay.fromDateTime(checkedInAt).format(context)}',
                      style: const TextStyle(
                          fontSize: 11, color: AppTheme.mutedText))
                else
                  const Text('Checked in — not checked out yet',
                      style: TextStyle(fontSize: 11, color: AppTheme.mutedText)),
              ],
            ),
          ),
          TextButton(
            onPressed: () => _checkOut(v),
            child: const Text('Check Out'),
          ),
        ],
      ),
    );
  }

  Widget _buildHistoryList() {
    if (_history.isEmpty) {
      return const Center(
        child: Text('No visits logged yet.',
            style: TextStyle(color: AppTheme.mutedText)),
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.all(16),
      itemCount: _history.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (_, i) {
        final v = _history[i] as Map<String, dynamic>;
        final ts = v['timestamp'] as String?;
        return ListTile(
          leading: Icon(
            v['plan_stop_id'] != null ? Icons.check_circle_outline : Icons.location_on,
            color: v['plan_stop_id'] != null ? _green : _amber,
          ),
          title: Text(v['note'] as String? ?? (v['plan_stop_id'] != null ? 'Planned stop' : 'Unplanned visit')),
          subtitle: ts != null ? Text(ts) : null,
        );
      },
    );
  }
}

// ─── Add Stop bottom sheet (self-service) ──────────────────────────────────

class _AddStopSheet extends StatefulWidget {
  const _AddStopSheet();

  @override
  State<_AddStopSheet> createState() => _AddStopSheetState();
}

class _AddStopSheetState extends State<_AddStopSheet> {
  final _labelCtrl = TextEditingController();
  final _purposeCtrl = TextEditingController();
  double? _lat;
  double? _lng;
  bool _locating = false;
  String? _error;

  Future<void> _useCurrentLocation() async {
    setState(() {
      _locating = true;
      _error = null;
    });
    try {
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.deniedForever ||
          permission == LocationPermission.denied) {
        setState(() {
          _error = 'Location permission denied.';
          _locating = false;
        });
        return;
      }
      final pos = await Geolocator.getCurrentPosition(
          desiredAccuracy: LocationAccuracy.high);
      setState(() {
        _lat = pos.latitude;
        _lng = pos.longitude;
        _locating = false;
      });
    } catch (e) {
      setState(() {
        _error = 'Could not fetch location.';
        _locating = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: Container(
        padding: const EdgeInsets.all(20),
        decoration: const BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Add a Stop',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
            const SizedBox(height: 14),
            TextField(
              controller: _labelCtrl,
              decoration: const InputDecoration(
                labelText: 'Location (e.g. ABC Pharmacy, Khanpur)',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _purposeCtrl,
              decoration: const InputDecoration(
                labelText: 'Purpose (optional)',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: _locating ? null : _useCurrentLocation,
              icon: _locating
                  ? const SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.my_location, size: 16),
              label: Text(_lat == null
                  ? 'Use my current location'
                  : 'Location captured (${_lat!.toStringAsFixed(4)}, ${_lng!.toStringAsFixed(4)})'),
            ),
            if (_error != null) ...[
              const SizedBox(height: 6),
              Text(_error!, style: const TextStyle(color: AppTheme.error, fontSize: 12)),
            ],
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: (_labelCtrl.text.trim().isEmpty || _lat == null)
                    ? null
                    : () => Navigator.pop(context, {
                          'locationLabel': _labelCtrl.text.trim(),
                          'lat': _lat,
                          'lng': _lng,
                          'radiusMeters': 150,
                          'purpose': _purposeCtrl.text.trim().isEmpty
                              ? null
                              : _purposeCtrl.text.trim(),
                        }),
                child: const Text('Add Stop'),
              ),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }
}

// ─── Log Visit bottom sheet ─────────────────────────────────────────────────

class _LogVisitSheet extends StatefulWidget {
  final UserModel user;
  final Map<String, dynamic>? stop;
  const _LogVisitSheet({required this.user, this.stop});

  @override
  State<_LogVisitSheet> createState() => _LogVisitSheetState();
}

class _LogVisitSheetState extends State<_LogVisitSheet> {
  final _noteCtrl = TextEditingController();
  Position? _position;
  Map<String, dynamic>? _distanceResult;
  bool _fetchingLocation = true;
  bool _submitting = false;
  String? _error;

  // Photo evidence -- reuses the same `camera` package already a
  // dependency for face verification. Kept optional/local-only here: no
  // upload endpoint for visit photos exists yet in this codebase, so
  // photoUrl is left null and only the boolean "photo captured" is used
  // to satisfy the evidence-mode gate. Wire in real upload (e.g. to
  /// object storage) before relying on photo_url for audit review.
  bool _hasPhoto = false;

  @override
  void initState() {
    super.initState();
    _fetchLocation();
  }

  Future<void> _fetchLocation() async {
    setState(() => _fetchingLocation = true);
    try {
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      final pos = await Geolocator.getCurrentPosition(
          desiredAccuracy: LocationAccuracy.high);
      if (!mounted) return;
      setState(() {
        _position = pos;
        if (widget.stop != null) {
          _distanceResult = VisitPlanService.evaluateStopDistance(
            stop: widget.stop!,
            currentLat: pos.latitude,
            currentLng: pos.longitude,
          );
        }
        _fetchingLocation = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'Could not fetch your location.';
        _fetchingLocation = false;
      });
    }
  }

  Future<void> _capturePhoto() async {
    try {
      final cameras = await availableCameras();
      if (cameras.isEmpty) return;
      final controller = CameraController(cameras.first, ResolutionPreset.medium);
      await controller.initialize();
      await controller.takePicture();
      await controller.dispose();
      if (!mounted) return;
      setState(() => _hasPhoto = true);
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not capture photo.')),
      );
    }
  }

  bool get _canSubmit {
    if (_position == null) return false;
    return VisitPlanService.canSubmitVisit(
      evidenceMode: widget.user.visitEvidenceMode,
      hasPhoto: _hasPhoto,
      hasNote: _noteCtrl.text.trim().isNotEmpty,
    );
  }

  Future<void> _submit() async {
    if (!_canSubmit || _position == null) return;
    setState(() {
      _submitting = true;
      _error = null;
    });

    final stopId = widget.stop?['id'] as String?;
    final note = _noteCtrl.text.trim().isEmpty ? null : _noteCtrl.text.trim();
    final distance = (_distanceResult?['distance'] as num?)?.toDouble();

    try {
      final visit = await ApiService.logVisit(
        widget.user.token,
        latitude: _position!.latitude,
        longitude: _position!.longitude,
        planStopId: stopId,
        distanceFromStopMeters: distance,
        note: note,
        evidenceMode: widget.user.visitEvidenceMode,
      );
      if (!mounted) return;
      Navigator.pop(context, {'status': 'synced', 'visit': visit});
    } catch (e) {
      if (!OfflineQueueService.looksOffline(e)) {
        if (!mounted) return;
        setState(() {
          _error = _readableError(e);
          _submitting = false;
        });
        return;
      }

      // Offline -- queue it. If the stop itself is still pending (never
      // synced, id looks like "pending:<actionId>"), this visit depends
      // on that stop's action resolving first -- see
      // OfflineQueueService's dependency-chain handling.
      final stopIsPending = stopId != null && stopId.startsWith('pending:');
      final dependsOn = stopIsPending ? stopId.substring('pending:'.length) : null;
      final actionId = await OfflineQueueService.enqueue(
        widget.user.id,
        type: 'log_visit',
        payload: {
          'latitude': _position!.latitude,
          'longitude': _position!.longitude,
          'plan_stop_id': stopId,
          'distance_from_stop_meters': distance,
          'note': note,
          'evidence_mode': widget.user.visitEvidenceMode,
        },
        dependsOn: dependsOn,
      );

      if (!mounted) return;
      Navigator.pop(context, {
        'status': 'queued',
        'visit': {
          'id': 'pending:$actionId',
          'plan_stop_id': stopId,
          'latitude': _position!.latitude,
          'longitude': _position!.longitude,
          'distance_from_stop_meters': distance,
          'note': note,
          'evidence_mode_recorded': widget.user.visitEvidenceMode,
          'timestamp': DateTime.now().toIso8601String(),
          'checked_out_at': null,
        },
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final evidenceMode = widget.user.visitEvidenceMode;
    final needsPhoto = evidenceMode == 'gps_photo' || evidenceMode == 'gps_photo_note';
    final needsNote = evidenceMode == 'gps_photo_note';
    final inside = _distanceResult?['inside'] as bool?;

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Container(
        padding: const EdgeInsets.all(20),
        decoration: const BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              widget.stop != null
                  ? 'Log Visit — ${widget.stop!['location_label']}'
                  : 'Log Unplanned Visit',
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 12),
            if (_fetchingLocation)
              const Row(children: [
                SizedBox(
                    width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
                SizedBox(width: 8),
                Text('Fetching your location…'),
              ])
            else if (_position != null) ...[
              Row(children: [
                const Icon(Icons.my_location, size: 16, color: AppTheme.navy700),
                const SizedBox(width: 6),
                Text(
                  '${_position!.latitude.toStringAsFixed(5)}, ${_position!.longitude.toStringAsFixed(5)}',
                  style: const TextStyle(fontSize: 12.5),
                ),
              ]),
              if (widget.stop != null && inside != null) ...[
                const SizedBox(height: 4),
                Text(
                  inside
                      ? '✓ Within ${_distanceResult!['radius']}m of this stop'
                      : '${_distanceResult!['distance']}m away — outside the ${_distanceResult!['radius']}m radius (still logged, flagged for review)',
                  style: TextStyle(
                      fontSize: 11.5,
                      color: inside ? AppTheme.successColor : AppTheme.amber),
                ),
              ],
            ],
            if (needsPhoto) ...[
              const SizedBox(height: 14),
              OutlinedButton.icon(
                onPressed: _capturePhoto,
                icon: Icon(_hasPhoto ? Icons.check : Icons.camera_alt_outlined, size: 16),
                label: Text(_hasPhoto ? 'Photo captured' : 'Capture photo (required)'),
              ),
            ],
            const SizedBox(height: 12),
            TextField(
              controller: _noteCtrl,
              onChanged: (_) => setState(() {}),
              maxLines: 2,
              decoration: InputDecoration(
                labelText: needsNote ? 'Note (required)' : 'Note (optional)',
                border: const OutlineInputBorder(),
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: const TextStyle(color: AppTheme.error, fontSize: 12)),
            ],
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: (_canSubmit && !_submitting) ? _submit : null,
                child: _submitting
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                    : const Text('Submit Visit'),
              ),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }
}