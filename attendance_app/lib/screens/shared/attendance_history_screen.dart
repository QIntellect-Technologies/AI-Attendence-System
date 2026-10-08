import 'package:flutter/material.dart';
import '../../models/user_model.dart';
import '../../services/api_service.dart';
import '../../utils/app_theme.dart';
import '../../widgets/common_widgets.dart';

class AttendanceHistoryScreen extends StatefulWidget {
  final UserModel user;
  const AttendanceHistoryScreen({super.key, required this.user});
  @override
  State<AttendanceHistoryScreen> createState() => _AttendanceHistoryScreenState();
}

class _AttendanceHistoryScreenState extends State<AttendanceHistoryScreen> {
  List<dynamic> _logs = [];
  bool _loading = true;
  String? _error;
  String _selectedPeriod = 'Daily';
  DateTime _selectedDate = DateTime.now();
  DateTime? _customStartDate;
  DateTime? _customEndDate;
  String _draftPeriod = 'Daily';
  DateTime _draftDate = DateTime.now();
  DateTime? _draftStartDate;
  DateTime? _draftEndDate;

  @override
  void initState() {
    super.initState();
    _load();
  }

  // Kept separate from initState's call so RefreshIndicator/the AppBar
  // button can both drive it without touching _loading (which would flash
  // the full-screen spinner over content the user can already see) --
  // RefreshIndicator gets its own affordance, initState gets the one that
  // shows the big spinner on first mount.
  Future<void> _load({bool showSpinner = true}) async {
    if (showSpinner && mounted) setState(() => _loading = true);
    try {
      final data = widget.user.isFieldStaff
          ? await ApiService.getFieldAttendanceLogs(widget.user.token)
          : await ApiService.getOfficeAttendance(
              widget.user.token, widget.user.name);
      if (mounted) {
        setState(() {
          _logs = data;
          _error = null;
          _loading = false;
        });
      }
    } catch (e) {
      // A just-marked attendance that never appears here is otherwise
      // indistinguishable from "the fetch silently failed" -- surface the
      // error instead of quietly falling back to whatever _logs already
      // held (or an empty list), same reasoning as api_service.dart's
      // _decodeOrThrow comment on getOfficeAttendance.
      if (mounted) {
        setState(() {
          _error = 'Could not load attendance history.';
          _loading = false;
        });
      }
    }
  }

  // ─── Defensive field extraction ────────────────────────────────────────
  // The backend has gone through several shapes across this build (date vs
  // timestamp, checkIn vs check_in, camelCase vs snake_case additions like
  // captureChannel/capture_channel). Rather than assume one exact key and
  // silently render blank cells the moment the backend's naming shifts
  // again, every field is read through this multi-key fallback -- same
  // defensive-parsing convention already used in attendanceApi.ts/
  // leaveApi.ts on the web side.
  T? _pick<T>(Map log, List<String> keys) {
    for (final key in keys) {
      final value = log[key];
      if (value != null && value != '') return value as T;
    }
    return null;
  }

  String _dateOf(Map log) =>
      _pick<String>(log, ['date', 'logDate', 'log_date', 'attendanceDate', 'attendance_date']) ??
      (_pick<String>(log, ['timestamp', 'checkIn', 'check_in', 'createdAt', 'created_at'])
              ?.split('T')
              .first ??
          'N/A');

  String? _checkInOf(Map log) => _pick<String>(
      log, ['checkInTime', 'check_in_time', 'checkIn', 'check_in', 'time']);

  String? _checkOutOf(Map log) =>
      _pick<String>(log, ['checkOutTime', 'check_out_time', 'checkOut', 'check_out']);

  String? _durationOf(Map log) => _pick<String>(
      log, ['workDuration', 'work_duration', 'duration', 'durationLabel', 'duration_label']);

  String _statusOf(Map log) {
    if (log['check_in_hold_reason'] != null || log['checkInHoldReason'] != null ||
        log['check_out_hold_reason'] != null || log['checkOutHoldReason'] != null) {
      return 'Pending Review';
    }
    return _pick<String>(log, ['status', 'dayStatus', 'day_status', 'type']) ?? 'Present';
  }

  String? _notesOf(Map log) => _pick<String>(log, ['notes']);

  String? _channelOf(Map log) =>
      _pick<String>(log, ['captureChannel', 'capture_channel']);

  String _channelLabel(String channel) {
    switch (channel) {
      case 'local_node':
        return 'Local Node';
      case 'cloud':
        return 'Cloud';
      case 'mobile_app':
        return 'Mobile App';
      default:
        return channel;
    }
  }

  Widget _statCard(IconData icon, String value, String label, Color color) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppTheme.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppTheme.borderColor),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 28,
              height: 28,
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(icon, color: color, size: 16),
            ),
            const SizedBox(height: 16),
            Text(value,
                style: const TextStyle(
                    color: AppTheme.headText,
                    fontWeight: FontWeight.w700,
                    fontSize: 18)),
            const SizedBox(height: 4),
            Text(label,
                style: const TextStyle(
                    color: AppTheme.mutedText, fontSize: 12)),
          ],
        ),
      ),
    );
  }

  List<Map> get _filteredLogs {
    return _logs.cast<Map>().where((log) {
      final date = _parseDate(_dateOf(log));
      if (date == null) return false;
      if (_selectedPeriod == 'Custom') {
        if (_customStartDate == null || _customEndDate == null) return true;
        return !date.isBefore(_customStartDate!) && !date.isAfter(_customEndDate!);
      }
      final start = _rangeStart(_selectedDate);
      final end = _rangeEnd(_selectedDate);
      return !date.isBefore(start) && !date.isAfter(end);
    }).toList();
  }

  int get _presentCount {
    return _filteredLogs.where((log) => _statusOf(log).toLowerCase() == 'present').length;
  }

  int get _absentCount {
    return _filteredLogs.where((log) => _statusOf(log).toLowerCase() == 'absent').length;
  }

  int get _leaveCount {
    return _filteredLogs.where((log) {
      final status = _statusOf(log).toLowerCase();
      return status.contains('leave') || status.contains('half day') || status.contains('half_day');
    }).length;
  }

  DateTime _rangeStart(DateTime date) {
    switch (_selectedPeriod) {
      case 'Weekly':
        return date.subtract(Duration(days: date.weekday - 1));
      case 'Monthly':
        return DateTime(date.year, date.month, 1);
      default:
        return DateTime(date.year, date.month, date.day);
    }
  }

  DateTime _rangeEnd(DateTime date) {
    switch (_selectedPeriod) {
      case 'Weekly':
        return date.add(Duration(days: 7 - date.weekday));
      case 'Monthly':
        return DateTime(date.year, date.month + 1, 1).subtract(const Duration(days: 1));
      default:
        return DateTime(date.year, date.month, date.day, 23, 59, 59);
    }
  }

  String _formatDate(DateTime date) {
    return '${date.day.toString().padLeft(2, '0')}/${date.month.toString().padLeft(2, '0')}/${date.year}';
  }

  String _formatMonth(DateTime date) {
    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
    ];
    return '${months[date.month - 1]} ${date.year}';
  }

  String _selectedRangeLabel() {
    switch (_selectedPeriod) {
      case 'Weekly':
        final start = _rangeStart(_selectedDate);
        final end = _rangeEnd(_selectedDate);
        return '${_formatDate(start)} - ${_formatDate(end)}';
      case 'Monthly':
        return _formatMonth(_selectedDate);
      case 'Custom':
        if (_customStartDate != null && _customEndDate != null) {
          return '${_formatDate(_customStartDate!)} - ${_formatDate(_customEndDate!)}';
        }
        if (_customStartDate != null) {
          return _formatDate(_customStartDate!);
        }
        return 'Select range';
      default:
        return _formatDate(_selectedDate);
    }
  }

  Future<void> _pickFilterDate({required bool isEnd}) async {
    final initialDate = isEnd
        ? (_customEndDate ?? _customStartDate ?? DateTime.now())
        : (_customStartDate ?? _selectedDate);
    final picked = await showDatePicker(
      context: context,
      initialDate: initialDate,
      firstDate: DateTime.now().subtract(const Duration(days: 365)),
      lastDate: DateTime.now().add(const Duration(days: 365)),
      builder: (ctx, child) => Theme(
        data: ThemeData.light().copyWith(
          colorScheme: const ColorScheme.light(
            primary: AppTheme.accent,
            onPrimary: Colors.white,
            surface: AppTheme.card,
            onSurface: AppTheme.headText,
          ),
        ),
        child: child!,
      ),
    );
    if (picked == null) return;
    setState(() {
      if (_selectedPeriod == 'Custom') {
        if (isEnd) {
          _customEndDate = picked;
        } else {
          _customStartDate = picked;
          if (_customEndDate != null && _customEndDate!.isBefore(picked)) {
            _customEndDate = picked;
          }
        }
      } else {
        _selectedDate = picked;
      }
    });
  }

  void _selectPeriod(String period) {
    setState(() {
      _selectedPeriod = period;
      if (period != 'Custom') {
        _customStartDate = null;
        _customEndDate = null;
      }
    });
  }

  DateTime? _parseDate(String value) {
    try {
      return DateTime.parse(value);
    } catch (_) {
      final normalized = value.replaceAll('/', '-');
      final isoMatch = RegExp(r'^(\d{4})-(\d{1,2})-(\d{1,2})').firstMatch(normalized);
      if (isoMatch != null) {
        return DateTime(
          int.parse(isoMatch.group(1)!),
          int.parse(isoMatch.group(2)!),
          int.parse(isoMatch.group(3)!),
        );
      }
      final dmyMatch = RegExp(r'^(\d{1,2})-(\d{1,2})-(\d{4})').firstMatch(normalized);
      if (dmyMatch != null) {
        return DateTime(
          int.parse(dmyMatch.group(3)!),
          int.parse(dmyMatch.group(2)!),
          int.parse(dmyMatch.group(1)!),
        );
      }
    }
    return null;
  }

  void _resetDraftFilters() {
    _draftPeriod = _selectedPeriod;
    _draftDate = _selectedDate;
    _draftStartDate = _customStartDate;
    _draftEndDate = _customEndDate;
  }

  void _clearAttendanceFilters() {
    setState(() {
      _selectedPeriod = 'Daily';
      _selectedDate = DateTime.now();
      _customStartDate = null;
      _customEndDate = null;
      _draftPeriod = 'Daily';
      _draftDate = DateTime.now();
      _draftStartDate = null;
      _draftEndDate = null;
    });
  }

  Future<void> _openFilterPanel() async {
    _resetDraftFilters();
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) {
        return StatefulBuilder(
          builder: (sheetContext, setSheetState) {
            return TweenAnimationBuilder<double>(
              tween: Tween(begin: 0.96, end: 1),
              duration: const Duration(milliseconds: 220),
              curve: Curves.easeOutCubic,
              builder: (context, value, child) {
                return Transform.translate(
                  offset: Offset(0, 24 * (1 - value)),
                  child: Opacity(
                    opacity: value,
                    child: Container(
                      margin: const EdgeInsets.only(top: 80),
                      decoration: const BoxDecoration(
                        color: AppTheme.surface,
                        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Center(
                              child: Container(
                                width: 48,
                                height: 5,
                                decoration: BoxDecoration(
                                  color: AppTheme.borderColor,
                                  borderRadius: BorderRadius.circular(999),
                                ),
                              ),
                            ),
                            const SizedBox(height: 16),
                            Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                const Text(
                                  'Filter attendance',
                                  style: TextStyle(
                                    color: AppTheme.headText,
                                    fontSize: 18,
                                    fontWeight: FontWeight.w700,
                                  ),
                                ),
                                TextButton(
                                  onPressed: () {
                                    setSheetState(() {
                                      _draftPeriod = 'Daily';
                                      _draftDate = DateTime.now();
                                      _draftStartDate = null;
                                      _draftEndDate = null;
                                    });
                                  },
                                  child: const Text('Reset'),
                                ),
                              ],
                            ),
                            const SizedBox(height: 16),
                            Wrap(
                              spacing: 8,
                              runSpacing: 8,
                              children: [
                                _periodChoiceInSheet('Daily', _draftPeriod, (value) {
                                  setSheetState(() => _draftPeriod = value);
                                }),
                                _periodChoiceInSheet('Weekly', _draftPeriod, (value) {
                                  setSheetState(() => _draftPeriod = value);
                                }),
                                _periodChoiceInSheet('Monthly', _draftPeriod, (value) {
                                  setSheetState(() => _draftPeriod = value);
                                }),
                                _periodChoiceInSheet('Custom', _draftPeriod, (value) {
                                  setSheetState(() => _draftPeriod = value);
                                }),
                              ],
                            ),
                            const SizedBox(height: 16),
                            if (_draftPeriod == 'Custom') ...[
                              Row(
                                children: [
                                  Expanded(
                                    child: GestureDetector(
                                      onTap: () async {
                                        final picked = await showDatePicker(
                                          context: context,
                                          initialDate: _draftStartDate ?? _draftDate,
                                          firstDate: DateTime.now().subtract(const Duration(days: 365)),
                                          lastDate: DateTime.now().add(const Duration(days: 365)),
                                        );
                                        if (picked != null) {
                                          setSheetState(() {
                                            _draftStartDate = picked;
                                            if (_draftEndDate != null && _draftEndDate!.isBefore(picked)) {
                                              _draftEndDate = picked;
                                            }
                                          });
                                        }
                                      },
                                      child: _dateBox(
                                        label: 'Start date',
                                        value: _draftStartDate != null ? _formatDate(_draftStartDate!) : 'Select start date',
                                      ),
                                    ),
                                  ),
                                  const SizedBox(width: 12),
                                  Expanded(
                                    child: GestureDetector(
                                      onTap: () async {
                                        final picked = await showDatePicker(
                                          context: context,
                                          initialDate: _draftEndDate ?? _draftStartDate ?? _draftDate,
                                          firstDate: DateTime.now().subtract(const Duration(days: 365)),
                                          lastDate: DateTime.now().add(const Duration(days: 365)),
                                        );
                                        if (picked != null) {
                                          setSheetState(() => _draftEndDate = picked);
                                        }
                                      },
                                      child: _dateBox(
                                        label: 'End date',
                                        value: _draftEndDate != null ? _formatDate(_draftEndDate!) : 'Select end date',
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ] else
                              GestureDetector(
                                onTap: () async {
                                  final picked = await showDatePicker(
                                    context: context,
                                    initialDate: _draftDate,
                                    firstDate: DateTime.now().subtract(const Duration(days: 365)),
                                    lastDate: DateTime.now().add(const Duration(days: 365)),
                                  );
                                  if (picked != null) {
                                    setSheetState(() => _draftDate = picked);
                                  }
                                },
                                child: _dateBox(
                                  label: 'Selected date',
                                  value: _formatDate(_draftDate),
                                ),
                              ),
                            const SizedBox(height: 20),
                            Row(
                              children: [
                                Expanded(
                                  child: OutlinedButton(
                                    onPressed: () => Navigator.pop(ctx),
                                    style: OutlinedButton.styleFrom(
                                      foregroundColor: AppTheme.headText,
                                      side: const BorderSide(color: AppTheme.borderColor),
                                      padding: const EdgeInsets.symmetric(vertical: 12),
                                      shape: RoundedRectangleBorder(
                                        borderRadius: BorderRadius.circular(10),
                                      ),
                                    ),
                                    child: const Text('Cancel'),
                                  ),
                                ),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: ElevatedButton(
                                    onPressed: () {
                                      setState(() {
                                        _selectedPeriod = _draftPeriod;
                                        _selectedDate = _draftDate;
                                        _customStartDate = _draftStartDate;
                                        _customEndDate = _draftEndDate;
                                      });
                                      Navigator.pop(ctx);
                                    },
                                    style: ElevatedButton.styleFrom(
                                      backgroundColor: AppTheme.primary,
                                      foregroundColor: Colors.white,
                                      padding: const EdgeInsets.symmetric(vertical: 12),
                                      shape: RoundedRectangleBorder(
                                        borderRadius: BorderRadius.circular(10),
                                      ),
                                    ),
                                    child: const Text('Save Changes'),
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                );
              },
            );
          },
        );
      },
    );
  }

  Widget _dateBox({required String label, required String value}) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
      decoration: BoxDecoration(
        color: AppTheme.slate50,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppTheme.borderColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: const TextStyle(color: AppTheme.mutedText, fontSize: 11),
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              const Icon(Icons.calendar_today, size: 16, color: AppTheme.mutedText),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  value,
                  style: const TextStyle(color: AppTheme.headText),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _periodChoiceInSheet(String period, String selected, void Function(String) onTap) {
    final isSelected = selected == period;
    return GestureDetector(
      onTap: () => onTap(period),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: isSelected ? AppTheme.primary : AppTheme.slate50,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: isSelected ? AppTheme.primary : AppTheme.borderColor),
        ),
        child: Text(
          period,
          style: TextStyle(
            color: isSelected ? Colors.white : AppTheme.headText,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }

  Widget _buildFilterButton() {
    final hasActiveFilters = _selectedPeriod != 'Daily' ||
        _customStartDate != null ||
        _customEndDate != null;

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Align(
        alignment: Alignment.centerLeft,
        child: OutlinedButton.icon(
          onPressed: _openFilterPanel,
          icon: const Icon(Icons.tune, size: 18),
          label: Text(hasActiveFilters ? 'Filters Applied' : 'Filter'),
          style: OutlinedButton.styleFrom(
            foregroundColor: hasActiveFilters ? AppTheme.primary : AppTheme.headText,
            side: BorderSide(
              color: hasActiveFilters ? AppTheme.primary : AppTheme.borderColor,
            ),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Attendance History'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh',
            onPressed: _loading ? null : () => _load(showSpinner: false),
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AppTheme.accent))
          : RefreshIndicator(
              color: AppTheme.accent,
              onRefresh: () => _load(showSpinner: false),
              child: _error != null
                  ? _messageState(Icons.error_outline, _error!, isError: true)
                  : _logs.isEmpty
                      ? _messageState(
                          Icons.event_busy, 'No attendance records found.')
                      : ListView(
                          padding: const EdgeInsets.all(16),
                          children: [
                            _buildFilterButton(),
                            const SizedBox(height: 8),
                            if (_filteredLogs.isEmpty)
                              const Padding(
                                padding: EdgeInsets.symmetric(vertical: 24),
                                child: Center(
                                  child: Text('No records match the selected filters.',
                                      style: TextStyle(color: AppTheme.mutedText)),
                                ),
                              )
                            else ..._filteredLogs.map(_logCard),
                          ],
                        ),
            ),
    );
  }

  // Always scrollable (even when empty/error) so RefreshIndicator's pull
  // gesture keeps working instead of only being reachable once there's a
  // long-enough list to scroll.
  Widget _messageState(IconData icon, String message, {bool isError = false}) {
    return ListView(
      children: [
        SizedBox(
          height: MediaQuery.of(context).size.height * 0.6,
          child: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(icon,
                    color: isError ? AppTheme.error : AppTheme.mutedText,
                    size: 40),
                const SizedBox(height: 12),
                Text(message,
                    style: TextStyle(
                        color: isError ? AppTheme.error : AppTheme.mutedText)),
                const SizedBox(height: 12),
                TextButton(
                  onPressed: () => _load(showSpinner: false),
                  child: const Text('Refresh',
                      style: TextStyle(color: AppTheme.primary)),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _logCard(Map log) {
    final status = _statusOf(log);
    final pending = status == 'Pending Review';
    final color = pending
        ? AppTheme.warning
        : (status.toLowerCase() == 'half_day' || status.toLowerCase() == 'half day')
            ? AppTheme.warning
            : AppTheme.accent;
    final checkIn = _checkInOf(log);
    final checkOut = _checkOutOf(log);
    final duration = _durationOf(log);
    final notes = _notesOf(log);
    final channel = _channelOf(log);

    return CustomCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Icon(
                    pending ? Icons.hourglass_top : Icons.check_circle_outline,
                    color: color),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(_dateOf(log),
                        style: const TextStyle(
                            color: AppTheme.headText,
                            fontWeight: FontWeight.w600)),
                    if (checkIn != null || checkOut != null)
                      Text(
                        [
                          if (checkIn != null) 'In $checkIn',
                          if (checkOut != null) 'Out $checkOut',
                        ].join(' · '),
                        style: const TextStyle(
                            color: AppTheme.mutedText, fontSize: 12),
                      ),
                  ],
                ),
              ),
              StatusBadge(status: status),
            ],
          ),
          if (duration != null) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                const Icon(Icons.timer_outlined,
                    color: AppTheme.mutedText, size: 14),
                const SizedBox(width: 6),
                Text(duration,
                    style: const TextStyle(
                        color: AppTheme.mutedText, fontSize: 12)),
                if (channel != null) ...[
                  const SizedBox(width: 10),
                  Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 8, vertical: 2),
                    decoration: BoxDecoration(
                      color: AppTheme.slate50,
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Text(_channelLabel(channel),
                        style: const TextStyle(
                            color: AppTheme.mutedText,
                            fontSize: 10,
                            fontWeight: FontWeight.w600)),
                  ),
                ],
              ],
            ),
          ],
          if (notes != null && notes.isNotEmpty) ...[
            const SizedBox(height: 8),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(notes,
                  style: const TextStyle(
                      color: AppTheme.mutedText, fontSize: 11, height: 1.3)),
            ),
          ],
        ],
      ),
    );
  }
}