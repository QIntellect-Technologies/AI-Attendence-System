import 'package:flutter/material.dart';
import '../../models/user_model.dart';
import '../../services/api_service.dart';
import '../../utils/app_theme.dart';
import '../../utils/overtime_policy.dart';
import '../../widgets/common_widgets.dart';

// Mirrors leave_screen.dart's structure:
//  - no user id is ever sent to the API; org/branch/staff scope comes
//    from widget.user.token server-side (see ApiService.requestOvertime /
//    getMyOvertime -> client_staff_overtime_routes.py).
//  - this screen only ever shows/creates the signed-in staff member's OWN
//    overtime. Team-wide (manager) or org-wide (admin) visibility is a
//    Client Dashboard concern with its own token -- not this screen's job.
class OvertimeScreen extends StatefulWidget {
  final UserModel user;
  const OvertimeScreen({super.key, required this.user});

  @override
  State<OvertimeScreen> createState() => _OvertimeScreenState();
}

class _OvertimeScreenState extends State<OvertimeScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;
  List<dynamic> _records = [];
  bool _loading = true;
  String _selectedStatus = 'All';
  String _selectedMonth = 'All';
  String _draftStatus = 'All';
  String _draftMonth = 'All';

  DateTime? _selectedDate;
  double _hours = 1.0;
  final _reasonCtrl = TextEditingController();
  bool _submitting = false;
  String _formMsg = '';
  bool _formSuccess = false;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _loadOvertime();
  }

  @override
  void dispose() {
    _tabController.dispose();
    _reasonCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadOvertime() async {
    setState(() => _loading = true);
    try {
      final data = await ApiService.getMyOvertime(widget.user.token);
      if (mounted) setState(() => _records = data);
    } catch (_) {
      // silent fail -- matches leave_screen.dart's _loadLeaves behavior
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _pickDate() async {
    final today = overtimeClaimDate(DateTime.now());
    final picked = await showDatePicker(
      context: context,
      initialDate: today,
      firstDate: today,
      lastDate: today.add(const Duration(days: 365)),
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
    if (picked != null) setState(() => _selectedDate = picked);
  }

  Future<void> _submitOvertime() async {
    if (_selectedDate == null) {
      setState(() {
        _formMsg = 'Select a date for overtime.';
        _formSuccess = false;
      });
      return;
    }
    if (!isOvertimeClaimDateAllowed(_selectedDate!)) {
      setState(() {
        _formMsg = 'Overtime can only be claimed for today or a future date.';
        _formSuccess = false;
      });
      return;
    }
    if (_reasonCtrl.text.trim().isEmpty) {
      setState(() {
        _formMsg = 'Please enter a reason for overtime.';
        _formSuccess = false;
      });
      return;
    }

    setState(() {
      _submitting = true;
      _formMsg = '';
    });

    try {
      final dateStr =
          '${_selectedDate!.year}-${_selectedDate!.month.toString().padLeft(2, '0')}-${_selectedDate!.day.toString().padLeft(2, '0')}';

      final res = await ApiService.requestOvertime(
        widget.user.token,
        dateStr,
        _hours,
        _reasonCtrl.text.trim(),
      );

      if (mounted) {
        setState(() {
          _formSuccess = res['success'] == true;
          _formMsg = res['message']?.toString() ??
              (_formSuccess
                  ? 'Overtime request submitted successfully!'
                  : 'An error occurred.');
        });

        if (_formSuccess) {
          _reasonCtrl.clear();
          _selectedDate = null;
          _hours = 1.0;
          await _loadOvertime();
          _tabController.animateTo(1);
        }
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _formMsg = 'Network error: ${e.toString()}';
          _formSuccess = false;
        });
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Color _statusColor(String status) {
    switch (status.toLowerCase()) {
      case 'approved':
        return AppTheme.success;
      case 'rejected':
        return AppTheme.error;
      default:
        return AppTheme.warning;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.bg,
      appBar: AppBar(
        title: const Text('Overtime'),
        backgroundColor: AppTheme.surface,
        bottom: TabBar(
          controller: _tabController,
          indicatorColor: AppTheme.primary,
          labelColor: AppTheme.primary,
          unselectedLabelColor: AppTheme.mutedText,
          tabs: const [
            Tab(text: 'Request'),
            Tab(text: 'History'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [
          _buildRequestTab(),
          _buildHistoryTab(),
        ],
      ),
    );
  }

  Widget _buildRequestTab() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          CustomCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Overtime Date',
                    style: TextStyle(color: AppTheme.mutedText, fontSize: 12)),
                const SizedBox(height: 8),
                GestureDetector(
                  onTap: _pickDate,
                  child: Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppTheme.slate50,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: AppTheme.borderColor),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.calendar_today,
                            color: AppTheme.accent, size: 18),
                        const SizedBox(width: 10),
                        Text(
                          _selectedDate != null
                              ? '${_selectedDate!.day}/${_selectedDate!.month}/${_selectedDate!.year}'
                              : 'Select a date',
                          style: TextStyle(
                            color: _selectedDate != null
                                ? AppTheme.headText
                                : AppTheme.mutedText,
                            fontSize: 14,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          CustomCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const Text('Overtime Hours',
                        style: TextStyle(color: AppTheme.mutedText, fontSize: 12)),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 12, vertical: 4),
                      decoration: BoxDecoration(
                        color: AppTheme.accent.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(20),
                      ),
                      child: Text(
                        '${_hours.toStringAsFixed(1)} hrs',
                        style: const TextStyle(
                            color: AppTheme.accent,
                            fontWeight: FontWeight.bold),
                      ),
                    ),
                  ],
                ),
                Slider(
                  value: _hours,
                  min: 0.5,
                  max: 8.0,
                  divisions: 15,
                  activeColor: AppTheme.accent,
                  inactiveColor: AppTheme.accent.withValues(alpha: 0.2),
                  onChanged: (v) => setState(() => _hours = v),
                ),
                const Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('0.5 hrs',
                        style: TextStyle(color: AppTheme.mutedText, fontSize: 11)),
                    Text('8 hrs',
                        style: TextStyle(color: AppTheme.mutedText, fontSize: 11)),
                  ],
                ),
              ],
            ),
          ),
          CustomCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Reason',
                    style: TextStyle(color: AppTheme.mutedText, fontSize: 12)),
                const SizedBox(height: 8),
                TextField(
                  controller: _reasonCtrl,
                  maxLines: 3,
                  style: const TextStyle(color: AppTheme.bodyText),
                  decoration: InputDecoration(
                    hintText: 'Enter reason for overtime',
                    hintStyle: const TextStyle(color: AppTheme.mutedText),
                    filled: true,
                    fillColor: AppTheme.bg,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(8),
                      borderSide: BorderSide.none,
                    ),
                  ),
                ),
              ],
            ),
          ),
          if (_formMsg.isNotEmpty)
            CustomCard(
              child: Row(
                children: [
                  Icon(
                    _formSuccess ? Icons.check_circle : Icons.error_outline,
                    color: _formSuccess ? AppTheme.success : AppTheme.error,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(_formMsg,
                        style: TextStyle(
                            color: _formSuccess
                                ? AppTheme.success
                                : AppTheme.error)),
                  ),
                ],
              ),
            ),
          const SizedBox(height: 8),
          LoadingButton(
            isLoading: _submitting,
            text: 'Submit Overtime Request',
            onPressed: _submitOvertime,
          ),
        ],
      ),
    );
  }

  // Reads across the dashboard's field-name variants (ot_date/date,
  // approved_by/approvedBy, etc. -- see support_db._map_client_overtime)
  // so this screen renders correctly regardless of which alias Supabase
  // happens to have populated for a given row.
  String _recordDate(dynamic r) =>
      (r['date'] ?? r['ot_date'] ?? r['otDate'] ?? '').toString();

  String _recordStatus(dynamic r) =>
      (r['status'] ?? 'Pending').toString();

  // rejection_note is written by the dashboard's reject flow (see
  // support_db_payroll.update_client_overtime_status); only populated
  // when the request was actually rejected with a note attached.
  String _recordRejectionNote(dynamic r) =>
      (r['rejection_note'] ?? r['rejectionNote'] ?? '').toString();

  double _recordHours(dynamic r) =>
      double.tryParse((r['hours'] ?? 0).toString()) ?? 0;

  String _recordMonth(dynamic r) {
    final date = _recordDate(r);
    final parsed = _parseDate(date);
    if (parsed == null) return 'Unknown';
    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
    ];
    return '${months[parsed.month - 1]} ${parsed.year}';
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

  List<Map> get _filteredRecords {
    return _records.cast<Map>().where((record) {
      final status = _recordStatus(record);
      final month = _recordMonth(record);
      final statusMatch = _selectedStatus == 'All' || status.toLowerCase() == _selectedStatus.toLowerCase();
      final monthMatch = _selectedMonth == 'All' || month == _selectedMonth;
      return statusMatch && monthMatch;
    }).toList();
  }

  List<String> get _statusOptions {
    final values = _records.cast<Map>().map(_recordStatus).toSet().toList();
    values.sort((a, b) => a.toLowerCase().compareTo(b.toLowerCase()));
    return ['All', ...values];
  }

  List<String> get _monthOptions {
    final values = _records.cast<Map>().map(_recordMonth).toSet().toList();
    values.sort((a, b) {
      final aDate = _parseMonthLabel(a);
      final bDate = _parseMonthLabel(b);
      return aDate.compareTo(bDate);
    });
    return ['All', ...values];
  }

  DateTime _parseMonthLabel(String label) {
    final parts = label.split(' ');
    if (parts.length != 2) return DateTime(1900);
    const months = {
      'Jan': 1,
      'Feb': 2,
      'Mar': 3,
      'Apr': 4,
      'May': 5,
      'Jun': 6,
      'Jul': 7,
      'Aug': 8,
      'Sep': 9,
      'Oct': 10,
      'Nov': 11,
      'Dec': 12,
    };
    final month = months[parts[0]] ?? 1;
    final year = int.tryParse(parts[1]) ?? 1900;
    return DateTime(year, month);
  }

  void _resetDraftFilters() {
    _draftStatus = _selectedStatus;
    _draftMonth = _selectedMonth;
  }

  void _clearOvertimeFilters() {
    setState(() {
      _selectedStatus = 'All';
      _selectedMonth = 'All';
      _draftStatus = 'All';
      _draftMonth = 'All';
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
                                  'Filter overtime',
                                  style: TextStyle(
                                    color: AppTheme.headText,
                                    fontSize: 18,
                                    fontWeight: FontWeight.w700,
                                  ),
                                ),
                                TextButton(
                                  onPressed: () {
                                    setSheetState(() {
                                      _draftStatus = 'All';
                                      _draftMonth = 'All';
                                    });
                                  },
                                  child: const Text('Reset'),
                                ),
                              ],
                            ),
                            const SizedBox(height: 16),
                            _filterDropdown(
                              label: 'Status',
                              value: _draftStatus,
                              options: _statusOptions,
                              onChanged: (value) {
                                if (value == null) return;
                                setSheetState(() => _draftStatus = value);
                              },
                            ),
                            const SizedBox(height: 12),
                            _filterDropdown(
                              label: 'Month',
                              value: _draftMonth,
                              options: _monthOptions,
                              onChanged: (value) {
                                if (value == null) return;
                                setSheetState(() => _draftMonth = value);
                              },
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
                                        _selectedStatus = _draftStatus;
                                        _selectedMonth = _draftMonth;
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

  Widget _buildFilterButton() {
    final hasActiveFilters = _selectedStatus != 'All' || _selectedMonth != 'All';

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

  Widget _buildHistoryTab() {
    if (_loading) {
      return const Center(
          child: CircularProgressIndicator(color: AppTheme.accent));
    }

    if (_records.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.access_time, color: AppTheme.slate300, size: 64),
            const SizedBox(height: 16),
            const Text('No overtime records found.',
                style: TextStyle(color: AppTheme.mutedText, fontSize: 16)),
            const SizedBox(height: 8),
            TextButton(
              onPressed: _loadOvertime,
              child: const Text('Refresh',
                  style: TextStyle(color: AppTheme.primary)),
            ),
          ],
        ),
      );
    }

    final totalHours =
        _filteredRecords.fold<double>(0, (sum, r) => sum + _recordHours(r));
    final approved = _filteredRecords
        .where((r) => _recordStatus(r).toLowerCase() == 'approved')
        .length;
    final pending = _filteredRecords
        .where((r) => _recordStatus(r).toLowerCase() == 'pending')
        .length;

    return RefreshIndicator(
      onRefresh: _loadOvertime,
      color: AppTheme.accent,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _buildFilterButton(),
          const SizedBox(height: 12),
          Row(
            children: [
              _statCard('Total Hours', totalHours.toStringAsFixed(1),
                  Icons.timer, AppTheme.accent),
              const SizedBox(width: 8),
              _statCard('Approved', '$approved', Icons.check_circle,
                  AppTheme.success),
              const SizedBox(width: 8),
              _statCard('Pending', '$pending', Icons.schedule, AppTheme.warning),
            ],
          ),
          const SizedBox(height: 16),
          if (_filteredRecords.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 24),
              child: Center(
                child: Text('No overtime records match the selected filters.',
                    style: const TextStyle(color: AppTheme.mutedText)),
              ),
            )
          else ..._filteredRecords.map((r) {
            final status = _recordStatus(r);
            final date = _recordDate(r);
            final hours = _recordHours(r);
            final reason = (r['reason'] ?? '').toString();
            final rejectionNote = _recordRejectionNote(r);
            final showRejectionNote =
                status.toLowerCase() == 'rejected' && rejectionNote.isNotEmpty;

            return CustomCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Container(
                        width: 48,
                        height: 48,
                        decoration: BoxDecoration(
                          color: AppTheme.accent.withValues(alpha: 0.15),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Text(
                              hours.toStringAsFixed(1),
                              style: const TextStyle(
                                  color: AppTheme.accent,
                                  fontWeight: FontWeight.bold,
                                  fontSize: 14),
                            ),
                            const Text('hrs',
                                style: TextStyle(
                                    color: AppTheme.mutedText, fontSize: 10)),
                          ],
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(date.isNotEmpty ? date : '—',
                                style: const TextStyle(
                                    color: AppTheme.headText,
                                    fontWeight: FontWeight.w600)),
                            if (reason.isNotEmpty)
                              Text(reason,
                                  style: const TextStyle(
                                      color: AppTheme.mutedText, fontSize: 12),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis),
                          ],
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 10, vertical: 4),
                        decoration: BoxDecoration(
                          color: _statusColor(status).withValues(alpha: 0.15),
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: Text(status,
                            style: TextStyle(
                                color: _statusColor(status),
                                fontSize: 12,
                                fontWeight: FontWeight.w600)),
                      ),
                    ],
                  ),
                  if (showRejectionNote) ...[
                    const SizedBox(height: 8),
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: AppTheme.error.withValues(alpha: 0.08),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('Rejection reason',
                              style: TextStyle(
                                  color: AppTheme.mutedText,
                                  fontSize: 11,
                                  fontWeight: FontWeight.w600)),
                          const SizedBox(height: 2),
                          Text(rejectionNote,
                              style: const TextStyle(
                                  color: AppTheme.bodyText, fontSize: 12)),
                        ],
                      ),
                    ),
                  ],
                ],
              ),
            );
          }),
        ],
      ),
    );
  }

  Widget _filterDropdown({
    required String label,
    required String value,
    required List<String> options,
    required void Function(String?) onChanged,
  }) {
    return DropdownButtonFormField<String>(
      initialValue: options.contains(value) ? value : 'All',
      dropdownColor: AppTheme.surface,
      style: const TextStyle(color: AppTheme.headText),
      decoration: InputDecoration(
        labelText: label,
        labelStyle: const TextStyle(color: AppTheme.mutedText, fontSize: 12),
        filled: true,
        fillColor: AppTheme.slate50,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: AppTheme.borderColor),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: AppTheme.borderColor),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: AppTheme.primary, width: 1.2),
        ),
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      ),
      items: options
          .map((option) => DropdownMenuItem(value: option, child: Text(option)))
          .toList(),
      onChanged: onChanged,
    );
  }

  Widget _statCard(String label, String value, IconData icon, Color color) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: color.withValues(alpha: 0.3)),
        ),
        child: Column(
          children: [
            Icon(icon, color: color, size: 18),
            const SizedBox(height: 4),
            Text(value,
                style: TextStyle(
                    color: color, fontSize: 16, fontWeight: FontWeight.bold)),
            Text(label,
                style: TextStyle(
                    color: color.withValues(alpha: 0.7), fontSize: 10),
                textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}