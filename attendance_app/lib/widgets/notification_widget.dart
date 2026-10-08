import 'dart:async';
import 'package:flutter/material.dart';
import '../models/user_model.dart';
import '../services/api_service.dart';
import '../utils/app_theme.dart';
import '../utils/attendance_status.dart';

class NotificationPoller extends StatefulWidget {
  final UserModel user;
  final Future<void> Function()? onAttendanceDetected;

  const NotificationPoller({
    super.key,
    required this.user,
    this.onAttendanceDetected,
  });

  @override
  State<NotificationPoller> createState() => _NotificationPollerState();
}

class _NotificationPollerState extends State<NotificationPoller>
    with SingleTickerProviderStateMixin {
  Timer? _timer;
  final Set<String> _seenIds = {};
  final List<Map<String, dynamic>> _queue = [];
  bool _showing = false;
  bool _fetching = false;
  late AnimationController _animCtrl;
  late Animation<Offset> _slideAnim;

  @override
  void initState() {
    super.initState();
    _animCtrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 400),
    );
    _slideAnim = Tween<Offset>(
      begin: const Offset(0, -1.2),
      end: Offset.zero,
    ).animate(CurvedAnimation(parent: _animCtrl, curve: Curves.easeOut));

    Future.delayed(const Duration(seconds: 3), _fetchNotifications);
    _timer = Timer.periodic(
      const Duration(seconds: 10),
      (_) => _fetchNotifications(),
    );
  }

  @override
  void dispose() {
    _timer?.cancel();
    _animCtrl.dispose();
    super.dispose();
  }

  Future<void> _fetchNotifications() async {
    if (!mounted || _fetching) return;
    _fetching = true;
    try {
      final logs = widget.user.isFieldStaff
          ? await ApiService.getFieldAttendanceLogs(widget.user.token)
          : await ApiService.getOfficeAttendance(
              widget.user.token,
              widget.user.name,
            );
      if (!mounted) return;

      final today = DateTime.now().toIso8601String().substring(0, 10);
      var attendanceDetected = false;
      for (final value in logs) {
        if (value is! Map) continue;
        final log = Map<String, dynamic>.from(value);
        final date =
            (log['date'] ?? log['logDate'] ?? log['log_date'] ?? '').toString();
        final channel = (log['captureChannel'] ?? log['capture_channel'] ?? '')
            .toString()
            .toLowerCase();
        if (!date.startsWith(today) ||
            (channel != 'local_node' && channel != 'cloud')) {
          continue;
        }

        final time = (log['time'] ??
                log['checkInTime'] ??
                log['check_in_time'] ??
                log['timestamp'] ??
                '')
            .toString();
        final id = (log['id'] ?? '$date-$time-$channel').toString();
        if (!_seenIds.add(id)) continue;
        attendanceDetected = true;

        final checkInStatus = resolveCheckInStatus(
          log['checkInStatus'] ?? log['check_in_status'],
          notes: log['notes'],
        );
        final pendingReview =
            (log['status'] ?? '').toString().toLowerCase() == 'pending review';
        final statusLabel = checkInStatus == 'late'
            ? pendingReview
                ? 'Late check-in. Pending admin review.'
                : 'Late check-in.'
            : checkInStatus == 'on_time'
                ? 'On time.'
                : checkInStatus == 'early'
                    ? 'Checked in early.'
                    : 'Attendance recorded.';

        _queue.add({
          'title': 'You are marked present',
          'message': 'Check-in at $time — $statusLabel',
          'department': 'CCTV',
          'created_at': time,
        });
      }
      if (attendanceDetected && widget.onAttendanceDetected != null) {
        unawaited(widget.onAttendanceDetected!());
      }
      _showNext();
    } catch (error) {
      debugPrint('Failed to check for CCTV attendance: $error');
    } finally {
      _fetching = false;
    }
  }

  void _showNext() {
    if (_showing || _queue.isEmpty || !mounted) return;
    _showing = true;
    final notif = _queue.removeAt(0);
    _showPopup(notif);
  }

  void _showPopup(Map<String, dynamic> notif) {
    _animCtrl.forward(from: 0);

    final overlay = Overlay.of(context);
    late OverlayEntry entry;

    void dismiss() {
      if (!entry.mounted) return;
      _animCtrl.reverse().then((_) {
        try {
          entry.remove();
        } catch (_) {}
        _showing = false;
        Future.delayed(const Duration(milliseconds: 500), _showNext);
      });
    }

    entry = OverlayEntry(
      builder: (_) => _NotificationBanner(
        notif: notif,
        slideAnim: _slideAnim,
        onDismiss: dismiss,
      ),
    );

    overlay.insert(entry);

    // 5 sec baad auto dismiss
    Future.delayed(const Duration(seconds: 5), () {
      if (entry.mounted) dismiss();
    });
  }

  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}

class _NotificationBanner extends StatefulWidget {
  final Map<String, dynamic> notif;
  final Animation<Offset> slideAnim;
  final VoidCallback onDismiss;

  const _NotificationBanner({
    required this.notif,
    required this.slideAnim,
    required this.onDismiss,
  });

  @override
  State<_NotificationBanner> createState() => _NotificationBannerState();
}

class _NotificationBannerState extends State<_NotificationBanner> {
  double _dragOffset = 0;
  bool _dismissed = false;

  @override
  Widget build(BuildContext context) {
    final dept = widget.notif['department'] ?? 'all';
    final deptLabel = dept == 'all' ? 'Everyone' : dept;

    return Positioned(
      top: MediaQuery.of(context).padding.top + 10,
      left: 16,
      right: 16,
      child: SlideTransition(
        position: widget.slideAnim,
        child: GestureDetector(
          onTap: widget.onDismiss,
          onHorizontalDragUpdate: (details) {
            if (_dismissed) return;
            setState(() => _dragOffset += details.delta.dx);
          },
          onHorizontalDragEnd: (details) {
            if (_dismissed) return;
            // Left ya right — 80px se zyada swipe karo to dismiss
            if (_dragOffset.abs() > 80 ||
                details.velocity.pixelsPerSecond.dx.abs() > 300) {
              _dismissed = true;
              widget.onDismiss();
            } else {
              // Wapas center aa jao
              setState(() => _dragOffset = 0);
            }
          },
          child: Transform.translate(
            offset: Offset(_dragOffset, 0),
            child: Opacity(
              // Swipe hone par fade bhi ho
              opacity: (1 - (_dragOffset.abs() / 200)).clamp(0.0, 1.0),
              child: Material(
                color: Colors.transparent,
                child: Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: AppTheme.navy700,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(
                      color: AppTheme.teal500.withValues(alpha: 0.5),
                      width: 1.5,
                    ),
                    boxShadow: [
                      BoxShadow(
                        color: AppTheme.teal500.withValues(alpha: 0.3),
                        blurRadius: 20,
                        offset: const Offset(0, 4),
                      ),
                    ],
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // Bell icon
                      Container(
                        width: 40,
                        height: 40,
                        decoration: BoxDecoration(
                          color: AppTheme.teal500.withValues(alpha: 0.2),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: const Icon(
                          Icons.notifications_active,
                          color: AppTheme.teal200,
                          size: 20,
                        ),
                      ),
                      const SizedBox(width: 12),
                      // Content
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    widget.notif['title'] ?? 'Notification',
                                    style: const TextStyle(
                                      color: Colors.white,
                                      fontSize: 14,
                                      fontWeight: FontWeight.w700,
                                    ),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                                Container(
                                  padding: const EdgeInsets.symmetric(
                                      horizontal: 8, vertical: 2),
                                  decoration: BoxDecoration(
                                    color:
                                        AppTheme.teal500.withValues(alpha: 0.2),
                                    borderRadius: BorderRadius.circular(8),
                                  ),
                                  child: Text(
                                    deptLabel,
                                    style: const TextStyle(
                                      color: AppTheme.teal200,
                                      fontSize: 10,
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 4),
                            Text(
                              widget.notif['message'] ?? '',
                              style: const TextStyle(
                                color: Colors.white70,
                                fontSize: 12,
                              ),
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                            ),
                            const SizedBox(height: 6),
                            Row(
                              children: [
                                const Icon(Icons.access_time,
                                    color: Colors.white54, size: 11),
                                const SizedBox(width: 4),
                                Text(
                                  widget.notif['created_at'] ?? '',
                                  style: const TextStyle(
                                      color: Colors.white54, fontSize: 10),
                                ),
                                const Spacer(),
                                const Text(
                                  'Swipe to dismiss',
                                  style: TextStyle(
                                      color: Colors.white54, fontSize: 10),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
