import 'dart:async';
import 'package:flutter/material.dart';
import 'package:toastification/toastification.dart';
import '../../models/user_model.dart';
import '../../services/api_service.dart';
import '../../services/auth_service.dart';
import '../../services/offline_queue_service.dart';
import '../../utils/app_theme.dart';
import '../../widgets/hr_chatbot_widget.dart'; // ← HR Chatbot import
import '../../widgets/notification_widget.dart'; // ← Notification import

import '../auth/login_screen.dart';
import '../shared/leave_screen.dart';
import '../shared/overtime_screen.dart';
import '../shared/attendance_history_screen.dart';
import '../shared/profile_screen.dart';
import 'field_attendance_screen.dart';
import 'visit_plan_screen.dart';

class FieldHomeScreen extends StatefulWidget {
  final UserModel user;
  const FieldHomeScreen({super.key, required this.user});

  @override
  State<FieldHomeScreen> createState() => _FieldHomeScreenState();
}

class _FieldHomeScreenState extends State<FieldHomeScreen> {
  int _currentTab = 0;
  late Timer _clockTimer;
  DateTime _now = DateTime.now();

  int _presentDays = 0;
  int _absentDays = 0;
  int _attendanceRate = 0;
  bool _todayPresent = false;
  String _todayTime = '';
  List<dynamic> _recentLeaves = [];

  // ← NEW: header refresh-button state
  bool _refreshing = false;
  int _refreshToken = 0;

  // ─── Offline queue ────────────────────────────────────────────────────
  int _pendingCount = 0;
  Timer? _syncTimer;

  static const _bg = AppTheme.bgPage;
  static const _card = AppTheme.cardColor;
  static const _indigo = AppTheme.navy700;
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
    _fetchStats();
    _fetchRecentLeaves();
    _refreshPendingCount();
    _syncTimer = Timer.periodic(
      const Duration(minutes: 2),
      (_) => _syncPending(silent: true),
    );
  }

  @override
  void dispose() {
    _clockTimer.cancel();
    _syncTimer?.cancel();
    super.dispose();
  }

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

  Future<void> _refreshPendingCount() async {
    final count = await OfflineQueueService.pendingCount(widget.user.id);
    if (mounted) setState(() => _pendingCount = count);
  }

  Future<void> _syncPending({bool silent = true}) async {
    final result =
        await OfflineQueueService.syncAll(widget.user.id, widget.user.token);
    if (!mounted) return;
    setState(() => _pendingCount = result.remaining);
    if (result.synced > 0) {
      await _fetchStats();
      if (!silent) {
        _showToast('Synced ${result.synced} pending action(s).',
            isError: false);
      }
    }
    if (result.hasRejected) {
      // Deferred verify-face for an offline selfie came back with no
      // match -- attendance was deliberately NOT marked (see
      // OfflineQueueService's _FaceRejected). This can fire from the
      // background timer with the person sitting on the dashboard, not
      // the attendance screen, so this is the one place that has to
      // catch it too -- a dialog rather than a toast so it can't be
      // missed, with a direct path back into a live retry.
      await _showFaceRejectedDialog(result.rejected);
    }
  }

  Future<void> _showFaceRejectedDialog(int count) async {
    if (!mounted) return;
    final retry = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        backgroundColor: _card,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: const Row(
          children: [
            Icon(Icons.face_retouching_off, color: _red),
            SizedBox(width: 8),
            Text('Face Does Not Match',
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
                  'marked. Please verify your face again.'
              : 'Your offline selfies were checked now that you\'re back '
                  'online, and $count did not match. Attendance was NOT '
                  'marked for them. Please verify your face again.',
          style: const TextStyle(color: AppTheme.mutedText),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Later',
                style: TextStyle(color: AppTheme.mutedText)),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: _red),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Verify Now'),
          ),
        ],
      ),
    );
    if (retry == true && mounted) {
      Navigator.push(
          context,
          MaterialPageRoute(
              builder: (_) => FieldAttendanceScreen(user: widget.user)));
    }
  }

  Future<void> _fetchStats() async {
    try {
      final logs = await ApiService.getFieldAttendanceLogs(widget.user.token);
      if (!mounted) return;
      final present = logs
          .where((r) => r['status'] == 'PRESENT' || r['status'] == 'COMPLETED')
          .length;
      final total = logs.isEmpty ? 1 : logs.length;
      final today = DateTime.now().toIso8601String().split('T')[0];
      final todayRec = logs.cast<Map<String, dynamic>?>().firstWhere(
            (r) => (r?['date'] ?? '').toString().startsWith(today),
            orElse: () => null,
          );
      setState(() {
        _presentDays = present;
        _absentDays = total - present;
        _attendanceRate = ((present / total) * 100).round();
        _todayPresent = todayRec != null;
        _todayTime = todayRec?['check_in'] ?? todayRec?['time'] ?? '';
      });
    } catch (_) {}
  }

  Future<void> _fetchRecentLeaves() async {
    try {
      final leaves = await ApiService.getMyLeaves(widget.user.token);
      if (mounted) setState(() => _recentLeaves = leaves.take(3).toList());
    } catch (_) {}
  }

  // ← NEW: manual, whole-screen refresh -- what the header button calls.
  // Re-runs every fetch this screen makes at launch plus the offline-queue
  // count, so a tap catches anything that changed server-side without
  // waiting on the 2-minute sync timer. Deliberately does NOT call
  // _syncPending itself -- syncing (push queued actions) is a different
  // concern from refreshing (pull latest state) and already runs on its
  // own timer, so a tap here can't kick off a sync attempt while offline
  // and produce a confusing failure toast.
  Future<void> _refreshAll() async {
    if (_refreshing) return;
    setState(() {
      _refreshing = true;
      _refreshToken++;
    });
    try {
      await Future.wait([
        _fetchStats(),
        _fetchRecentLeaves(),
        _refreshPendingCount(),
      ]);
      _showToast('Refreshed', isError: false);
    } catch (_) {
      _showToast('Refresh failed — check your connection', isError: true);
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  String get _timeString {
    final h = _now.hour.toString().padLeft(2, '0');
    final m = _now.minute.toString().padLeft(2, '0');
    final s = _now.second.toString().padLeft(2, '0');
    return '$h:$m:$s';
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
                      VisitPlanScreen(user: widget.user),
                      AttendanceHistoryScreen(user: widget.user),
                      LeaveScreen(
                        user: widget.user,
                        refreshToken: _refreshToken,
                      ),
                      OvertimeScreen(user: widget.user),
                      ProfileScreen(user: widget.user, staffType: 'field'),
                    ],
                  ),
                ),
                _buildBottomNav(),
              ],
            ),
            // ─── HR Chatbot Widget ───────────────────────────
            HRChatbotWidget(user: widget.user),
            // ─── Notification Poller ─────────────────────────
            NotificationPoller(
              user: widget.user,
              onAttendanceDetected: _fetchStats,
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
                      : 'F',
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
                const Text('Field Staff',
                    style: TextStyle(color: _indigo, fontSize: 11)),
              ]),
            ]),
          ),
          // ← NEW: refresh button, same spot/style as office_home_screen.dart's
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
      child: Column(
        children: [
          _buildClockCard(),
          if (_pendingCount > 0) ...[
            const SizedBox(height: 10),
            _buildPendingSyncBanner(),
          ],
          const SizedBox(height: 10),
          _buildTodayStatus(),
          const SizedBox(height: 10),
          _buildStatsRow(),
          const SizedBox(height: 10),
          _buildQuickActions(),
          const SizedBox(height: 10),
          _buildRecentLeaves(),
          const SizedBox(height: 80),
        ],
      ),
    );
  }

  Widget _buildPendingSyncBanner() {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: _amber.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _amber.withValues(alpha: 0.3)),
      ),
      child: Row(
        children: [
          const Icon(Icons.cloud_off, color: _amber),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              '$_pendingCount action${_pendingCount == 1 ? '' : 's'} '
              'waiting to sync',
              style: const TextStyle(
                  color: AppTheme.headText,
                  fontSize: 13,
                  fontWeight: FontWeight.w600),
            ),
          ),
          TextButton(
            onPressed: () => _syncPending(silent: false),
            child: const Text('Sync now'),
          ),
        ],
      ),
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
            Expanded(
              child: Text('Field Staff • ${widget.user.department}',
                  style:
                      const TextStyle(color: Color(0x99FFFFFF), fontSize: 12),
                  overflow: TextOverflow.ellipsis),
            ),
          ]),
        ]),
      ]),
    );
  }

  Widget _buildTodayStatus() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: _card,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppTheme.borderColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text("TODAY'S STATUS",
              style: TextStyle(
                  color: AppTheme.mutedText,
                  fontSize: 10,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 1.5)),
          const SizedBox(height: 12),
          if (_todayPresent)
            Row(
              children: [
                Container(
                    width: 10,
                    height: 10,
                    decoration: const BoxDecoration(
                        color: _green, shape: BoxShape.circle)),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Present',
                          style: TextStyle(
                              color: _green,
                              fontWeight: FontWeight.bold,
                              fontSize: 15)),
                      Text('Checked in at $_todayTime',
                          style: const TextStyle(
                              color: AppTheme.mutedText, fontSize: 12)),
                    ],
                  ),
                ),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  decoration: BoxDecoration(
                    color: _green.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: _green.withValues(alpha: 0.3)),
                  ),
                  child: const Text('PRESENT',
                      style: TextStyle(
                          color: _green,
                          fontSize: 11,
                          fontWeight: FontWeight.bold)),
                ),
              ],
            )
          else ...[
            Row(
              children: [
                Container(
                  width: 10,
                  height: 10,
                  decoration:
                      const BoxDecoration(color: _red, shape: BoxShape.circle),
                ),
                const SizedBox(width: 10),
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Not Marked Yet',
                          style: TextStyle(
                              color: _red,
                              fontWeight: FontWeight.bold,
                              fontSize: 15)),
                      Text('Attendance via GPS + Face',
                          style: TextStyle(
                              color: AppTheme.mutedText, fontSize: 12)),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),
            GestureDetector(
              onTap: () => Navigator.push(
                      context,
                      MaterialPageRoute(
                          builder: (_) =>
                              FieldAttendanceScreen(user: widget.user)))
                  .then((_) => _fetchStats()),
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(vertical: 14),
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    colors: [AppTheme.navy700, AppTheme.navy600],
                  ),
                  borderRadius: BorderRadius.circular(12),
                  boxShadow: [
                    BoxShadow(
                      color: _indigo.withValues(alpha: 0.3),
                      blurRadius: 20,
                      offset: const Offset(0, 4),
                    )
                  ],
                ),
                child: const Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(Icons.location_on, color: Colors.white, size: 18),
                    SizedBox(width: 8),
                    Text('MARK ATTENDANCE',
                        style: TextStyle(
                            color: Colors.white,
                            fontSize: 14,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 0.5)),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
    );
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

  Widget _statCard(IconData icon, String value, String label, Color color) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 14),
        decoration: BoxDecoration(
          color: _card,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: color.withValues(alpha: 0.22)),
        ),
        child: Column(
          children: [
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
          ],
        ),
      ),
    );
  }

  Widget _buildQuickActions() {
    final actions = [
      {
        'icon': Icons.beach_access,
        'label': 'Apply Leave',
        'color': _indigo,
        'onTap': () => setState(() => _currentTab = 3),
      },
      {
        'icon': Icons.more_time,
        'label': 'Overtime',
        'color': _amber,
        'onTap': () => setState(() => _currentTab = 4),
      },
      {
        'icon': Icons.calendar_month,
        'label': 'History',
        'color': _teal,
        'onTap': () => setState(() => _currentTab = 2),
      },
      {
        'icon': Icons.person_outline,
        'label': 'My Profile',
        'color': _green,
        'onTap': () => setState(() => _currentTab = 5),
      },
    ];

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: _card,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppTheme.borderColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
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
              final icon = a['icon'] as IconData;
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
                  child: Row(
                    children: [
                      Icon(icon, color: color, size: 18),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(a['label'] as String,
                            style: const TextStyle(
                                color: AppTheme.headText,
                                fontSize: 12,
                                fontWeight: FontWeight.w600),
                            overflow: TextOverflow.ellipsis),
                      ),
                      Icon(Icons.chevron_right, color: color, size: 16),
                    ],
                  ),
                ),
              );
            }).toList(),
          ),
        ],
      ),
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
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
            const Text('RECENT LEAVES',
                style: TextStyle(
                    color: AppTheme.mutedText,
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 1.5)),
            GestureDetector(
              onTap: () => setState(() => _currentTab = 3),
              child: const Text('View All',
                  style: TextStyle(
                      color: _indigo,
                      fontSize: 11,
                      fontWeight: FontWeight.w600)),
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
              Color statusColor = _amber;
              if (status == 'Approved') statusColor = _green;
              if (status == 'Rejected') statusColor = _red;
              final leaveType = leave['type'] ?? leave['leave_type'] ?? '';
              final startDate = leave['startDate'] ?? leave['start_date'] ?? '';
              final endDate = leave['endDate'] ?? leave['end_date'] ?? '';
              return Container(
                padding: const EdgeInsets.symmetric(vertical: 10),
                decoration: BoxDecoration(
                  border: i < _recentLeaves.length - 1
                      ? Border(
                          bottom: BorderSide(
                              color:
                                  AppTheme.borderColor.withValues(alpha: 0.6)))
                      : null,
                ),
                child: Row(
                  children: [
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
                        ],
                      ),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 10, vertical: 3),
                      decoration: BoxDecoration(
                        color: statusColor.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(20),
                        border: Border.all(
                            color: statusColor.withValues(alpha: 0.3)),
                      ),
                      child: Text(status,
                          style: TextStyle(
                              color: statusColor,
                              fontSize: 11,
                              fontWeight: FontWeight.bold)),
                    ),
                  ],
                ),
              );
            }),
        ],
      ),
    );
  }

  Widget _buildBottomNav() {
    final tabs = [
      {'icon': Icons.home_rounded, 'label': 'Home'},
      {'icon': Icons.map_outlined, 'label': 'Visits'},
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
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
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
                ],
              ),
            ),
          );
        }),
      ),
    );
  }
}
