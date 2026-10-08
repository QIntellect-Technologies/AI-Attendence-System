// import 'package:flutter/material.dart';
// import '../../models/user_model.dart';
// import '../../services/api_service.dart';
// import '../../utils/app_theme.dart';
// import '../../utils/leave_policy.dart';
// import '../../widgets/common_widgets.dart';

// class LeaveScreen extends StatefulWidget {
//   final UserModel user;
//   const LeaveScreen({super.key, required this.user});

//   @override
//   State<LeaveScreen> createState() => _LeaveScreenState();
// }

// class _LeaveScreenState extends State<LeaveScreen>
//     with SingleTickerProviderStateMixin {
//   late TabController _tabController;
//   List<dynamic> _leaves = [];
//   bool _loading = true;

//   // 'Half Day' lives in this same dropdown as a duration choice, but it is
//   // NOT sent to the backend as leave_type -- see _effectiveLeaveType below.
//   // The backend (support_db.create_client_leave_request) and the web
//   // dashboard both key off leave_type as the real category (Annual/Sick/
//   // ...); overwriting it with a literal 'half_day' was tried before and
//   // reverted (see client_staff_leave_routes.py's module docstring) because
//   // it made leave_type untrustworthy as "the category" for every half-day
//   // row, including for support_db_attendance_gate's half-day lookup, which
//   // matches on half_day_period being set rather than leave_type=='half_day'.
//   // So the UI shows one flat list with 'Half Day' as an entry (matching
//   // the requested UX), and when it's picked, _halfDayCategory (a second,
//   // small dropdown) is what actually goes into leave_type on submit.
//   String _leaveType = 'Annual Leave';
//   String _halfDayCategory = 'Annual Leave';
//   final _reasonCtrl = TextEditingController();
//   DateTime? _startDate;
//   DateTime? _endDate;
//   bool _submitting = false;
//   String _formMsg = '';
//   bool _formSuccess = false;
//   String _selectedStatus = 'All';
//   String _selectedLeaveTypeFilter = 'All';
//   String _selectedMonth = 'All';

//   String _draftStatus = 'All';
//   String _draftLeaveTypeFilter = 'All';
//   String _draftMonth = 'All';

//   String _halfDayPeriod = 'morning'; // 'morning' | 'afternoon' -- derived from _halfDayStartTime, kept for dashboard compat
//   TimeOfDay? _halfDayStartTime;
//   TimeOfDay? _halfDayEndTime;

//   // IDs currently mid-cancel-request, so the Cancel button on that specific
//   // history row can show a spinner and disable itself without blocking the
//   // rest of the list.
//   final Set<String> _cancellingIds = {};

//   bool get _isHalfDay => _leaveType == 'Half Day';

//   // What actually gets sent to the backend as leave_type -- the real
//   // category, never the literal 'Half Day' label. See the comment on
//   // _leaveType above for why this indirection exists.
//   String get _effectiveLeaveType => _isHalfDay ? _halfDayCategory : _leaveType;

//   // Fallback only -- used when the org hasn't configured any leave types
//   // in Payroll Rules yet (leaveTypeRules defaults to {} server-side, see
//   // support_db_payroll._DEFAULT_PAYROLL_POLICY) or the /types call fails
//   // (offline, etc.), so the form is never left with an empty dropdown.
//   // Real leave types now come from ApiService.getLeaveTypes -- the same
//   // org+branch-scoped config the web dashboard's Leave Management filter
//   // and payroll's paid/unpaid deduction math read (support_db_payroll.
//   // get_leave_type_rules), so all three surfaces always agree.
//   static const List<String> _defaultLeaveTypeSlugs = [
//     'annual',
//     'sick',
//     'emergency',
//     'casual',
//     'unpaid',
//   ];

//   // Display label -> the slug actually submitted as leave_type, so the
//   // dropdown can show a friendly "Sick Leave" while the backend receives
//   // the exact key ("sick") configured in Payroll Rules -- keeping the
//   // value payroll_engine/leaveTypeRules key off of, and the value the
//   // dashboard's Leave Management filter matches on, in agreement.
//   Map<String, String> _leaveTypeSlugByLabel = {
//     for (final slug in _defaultLeaveTypeSlugs) _humanizeLeaveType(slug): slug,
//   };
//   List<String> _leaveTypes = [
//     for (final slug in _defaultLeaveTypeSlugs) _humanizeLeaveType(slug),
//   ];
//   bool _leaveTypesLoading = true;

//   static String _humanizeLeaveType(String slug) {
//     final words = slug.trim().replaceAll('_', ' ').split(RegExp(r'\s+'));
//     final title = words
//         .where((w) => w.isNotEmpty)
//         .map((w) => w[0].toUpperCase() + w.substring(1).toLowerCase())
//         .join(' ');
//     // Every configured type is a leave *category* -- "Sick" alone reads
//     // ambiguously in a dropdown next to "Half Day", so match the existing
//     // "<Category> Leave" convention unless it's already there (e.g. an
//     // admin who typed "sick leave" as the key).
//     return title.toLowerCase().endsWith('leave') ? title : '$title Leave';
//   }

//   Future<void> _loadLeaveTypes() async {
//     setState(() => _leaveTypesLoading = true);
//     try {
//       final rules = await ApiService.getLeaveTypes(widget.user.token);
//       final slugs = rules.keys
//           .map((k) => k.toString().trim())
//           .where((k) => k.isNotEmpty)
//           .toList()
//         ..sort();
//       if (slugs.isEmpty) return; // keep the default fallback as-is

//       final labelToSlug = {
//         for (final slug in slugs) _humanizeLeaveType(slug): slug,
//       };
//       if (!mounted) return;
//       setState(() {
//         _leaveTypeSlugByLabel = labelToSlug;
//         _leaveTypes = labelToSlug.keys.toList();
//         // The previously-selected value may no longer exist in the newly
//         // configured list (e.g. it only ever held the hardcoded default) --
//         // reset both dropdowns to a real option so _dropdownField never
//         // gets a value outside its own options list.
//         if (!_leaveTypes.contains(_leaveType)) {
//           _leaveType = _leaveTypes.first;
//         }
//         if (!_leaveTypes.contains(_halfDayCategory)) {
//           _halfDayCategory = _leaveTypes.first;
//         }
//         if (!_leaveTypes.contains(_selectedLeaveTypeFilter)) {
//           _selectedLeaveTypeFilter = 'All';
//         }
//       });
//     } catch (e) {
//       // Form stays usable on the default fallback list either way (offline,
//       // 401, 500, etc.) -- but log it, since a failed fetch and "org has no
//       // leave types configured yet" both leave _leaveTypes on the same
//       // fallback and are otherwise indistinguishable from the UI alone.
//       debugPrint('[LeaveScreen] Failed to load configured leave types — '
//           'dropdown is showing the hardcoded fallback list: $e');
//     } finally {
//       if (mounted) setState(() => _leaveTypesLoading = false);
//     }
//   }

//   // Main dropdown: the real categories plus 'Half Day' as a duration
//   // choice at the end.
//   List<String> get _mainLeaveTypeOptions => [..._leaveTypes, 'Half Day'];

//   @override
//   void initState() {
//     super.initState();
//     _tabController = TabController(length: 2, vsync: this);
//     _loadLeaves();
//     _loadLeaveTypes();
//   }

//   @override
//   void dispose() {
//     _tabController.dispose();
//     _reasonCtrl.dispose();
//     super.dispose();
//   }

//   Future<void> _loadLeaves() async {
//     setState(() => _loading = true);
//     try {
//       final data = await ApiService.getMyLeaves(widget.user.token);
//       if (mounted) setState(() => _leaves = data);
//     } catch (e) {
//       // silent fail
//     } finally {
//       if (mounted) setState(() => _loading = false);
//     }
//   }

//   List<Map> get _filteredLeaves {
//     return _leaves.cast<Map>().where((leave) {
//       final status = _statusOf(leave);
//       final type = _leaveTypeOf(leave);
//       final month = _monthLabel(_startDateOf(leave));
//       final statusMatch = _selectedStatus == 'All' || status == _selectedStatus.toLowerCase();
//       final typeMatch = _selectedLeaveTypeFilter == 'All' || type == _selectedLeaveTypeFilter;
//       final monthMatch = _selectedMonth == 'All' || month == _selectedMonth;
//       return statusMatch && typeMatch && monthMatch;
//     }).toList();
//   }

//   List<String> get _statusOptions {
//     final values = _leaves.cast<Map>().map(_statusOf).where((s) => s.isNotEmpty).toSet().toList();
//     values.sort();
//     return ['All', ...values.map((s) => s[0].toUpperCase() + s.substring(1))];
//   }

//   List<String> get _leaveTypeOptions {
//     final values = [..._leaveTypes];
//     values.sort();
//     return ['All', ...values];
//   }

//   List<String> get _monthOptions {
//     final values = _leaves.cast<Map>().map((leave) => _monthLabel(_startDateOf(leave))).toSet().toList();
//     values.sort((a, b) => _parseMonthLabel(a).compareTo(_parseMonthLabel(b)));
//     return ['All', ...values];
//   }

//   String _normalizeLeaveTypeValue(String raw) {
//     final value = raw.trim();
//     if (value.isEmpty) return 'Leave';
//     if (_leaveTypeSlugByLabel.containsKey(value)) return value;
//     if (_leaveTypeSlugByLabel.containsValue(value)) {
//       final entry = _leaveTypeSlugByLabel.entries.firstWhere(
//         (entry) => entry.value == value,
//         orElse: () => const MapEntry('', ''),
//       );
//       if (entry.key.isNotEmpty) return entry.key;
//     }
//     return _humanizeLeaveType(value);
//   }

//   String _leaveTypeOf(Map leave) {
//     final raw = (leave['type'] ?? leave['leave_type'] ?? 'Leave').toString();
//     return _normalizeLeaveTypeValue(raw);
//   }

//   String _statusOf(dynamic leave) {
//     return (leave['status'] ?? '').toString().trim().toLowerCase();
//   }

//   String _startDateOf(Map leave) {
//     return (leave['startDate'] ?? leave['start_date'] ?? '').toString();
//   }

//   String _monthLabel(String dateText) {
//     final date = _parseDate(dateText);
//     if (date == null) return 'Unknown';
//     const months = [
//       'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
//       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
//     ];
//     return '${months[date.month - 1]} ${date.year}';
//   }

//   DateTime _parseMonthLabel(String label) {
//     final parts = label.split(' ');
//     if (parts.length != 2) return DateTime(1900);
//     final monthNames = {
//       'Jan': 1,
//       'Feb': 2,
//       'Mar': 3,
//       'Apr': 4,
//       'May': 5,
//       'Jun': 6,
//       'Jul': 7,
//       'Aug': 8,
//       'Sep': 9,
//       'Oct': 10,
//       'Nov': 11,
//       'Dec': 12,
//     };
//     final month = monthNames[parts[0]] ?? 1;
//     final year = int.tryParse(parts[1]) ?? 1900;
//     return DateTime(year, month);
//   }

//   DateTime? _parseDate(String value) {
//     try {
//       return DateTime.parse(value);
//     } catch (_) {
//       final normalized = value.replaceAll('/', '-');
//       final isoMatch = RegExp(r'^(\d{4})-(\d{1,2})-(\d{1,2})').firstMatch(normalized);
//       if (isoMatch != null) {
//         return DateTime(
//           int.parse(isoMatch.group(1)!),
//           int.parse(isoMatch.group(2)!),
//           int.parse(isoMatch.group(3)!),
//         );
//       }
//       final dmyMatch = RegExp(r'^(\d{1,2})-(\d{1,2})-(\d{4})').firstMatch(normalized);
//       if (dmyMatch != null) {
//         return DateTime(
//           int.parse(dmyMatch.group(3)!),
//           int.parse(dmyMatch.group(2)!),
//           int.parse(dmyMatch.group(1)!),
//         );
//       }
//     }
//     return null;
//   }

//   void _resetDraftFilters() {
//     _draftStatus = _selectedStatus;
//     _draftLeaveTypeFilter = _selectedLeaveTypeFilter;
//     _draftMonth = _selectedMonth;
//   }

//   void _clearLeaveFilters() {
//     setState(() {
//       _selectedStatus = 'All';
//       _selectedLeaveTypeFilter = 'All';
//       _selectedMonth = 'All';
//       _draftStatus = 'All';
//       _draftLeaveTypeFilter = 'All';
//       _draftMonth = 'All';
//     });
//   }

//   Future<void> _openFilterPanel() async {
//     _resetDraftFilters();
//     await showModalBottomSheet<void>(
//       context: context,
//       isScrollControlled: true,
//       backgroundColor: Colors.transparent,
//       builder: (ctx) {
//         return StatefulBuilder(
//           builder: (sheetContext, setSheetState) {
//             return TweenAnimationBuilder<double>(
//               tween: Tween(begin: 0.96, end: 1),
//               duration: const Duration(milliseconds: 220),
//               curve: Curves.easeOutCubic,
//               builder: (context, value, child) {
//                 return Transform.translate(
//                   offset: Offset(0, 24 * (1 - value)),
//                   child: Opacity(
//                     opacity: value,
//                     child: Container(
//                       margin: const EdgeInsets.only(top: 80),
//                       decoration: const BoxDecoration(
//                         color: AppTheme.surface,
//                         borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
//                       ),
//                       child: Padding(
//                         padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
//                         child: Column(
//                           mainAxisSize: MainAxisSize.min,
//                           crossAxisAlignment: CrossAxisAlignment.start,
//                           children: [
//                             Center(
//                               child: Container(
//                                 width: 48,
//                                 height: 5,
//                                 decoration: BoxDecoration(
//                                   color: AppTheme.borderColor,
//                                   borderRadius: BorderRadius.circular(999),
//                                 ),
//                               ),
//                             ),
//                             const SizedBox(height: 16),
//                             Row(
//                               mainAxisAlignment: MainAxisAlignment.spaceBetween,
//                               children: [
//                                 const Text(
//                                   'Filter leaves',
//                                   style: TextStyle(
//                                     color: AppTheme.headText,
//                                     fontSize: 18,
//                                     fontWeight: FontWeight.w700,
//                                   ),
//                                 ),
//                                 TextButton(
//                                   onPressed: () {
//                                     setSheetState(() {
//                                       _draftStatus = 'All';
//                                       _draftLeaveTypeFilter = 'All';
//                                       _draftMonth = 'All';
//                                     });
//                                   },
//                                   child: const Text('Reset'),
//                                 ),
//                               ],
//                             ),
//                             const SizedBox(height: 16),
//                             _filterDropdown(
//                               label: 'Status',
//                               value: _draftStatus,
//                               options: _statusOptions,
//                               onChanged: (value) {
//                                 if (value == null) return;
//                                 setSheetState(() => _draftStatus = value);
//                               },
//                             ),
//                             const SizedBox(height: 12),
//                             _filterDropdown(
//                               label: 'Leave Type',
//                               value: _draftLeaveTypeFilter,
//                               options: _leaveTypeOptions,
//                               onChanged: (value) {
//                                 if (value == null) return;
//                                 setSheetState(() => _draftLeaveTypeFilter = value);
//                               },
//                             ),
//                             const SizedBox(height: 12),
//                             _filterDropdown(
//                               label: 'Month',
//                               value: _draftMonth,
//                               options: _monthOptions,
//                               onChanged: (value) {
//                                 if (value == null) return;
//                                 setSheetState(() => _draftMonth = value);
//                               },
//                             ),
//                             const SizedBox(height: 20),
//                             Row(
//                               children: [
//                                 Expanded(
//                                   child: OutlinedButton(
//                                     onPressed: () => Navigator.pop(ctx),
//                                     style: OutlinedButton.styleFrom(
//                                       foregroundColor: AppTheme.headText,
//                                       side: const BorderSide(color: AppTheme.borderColor),
//                                       padding: const EdgeInsets.symmetric(vertical: 12),
//                                       shape: RoundedRectangleBorder(
//                                         borderRadius: BorderRadius.circular(10),
//                                       ),
//                                     ),
//                                     child: const Text('Cancel'),
//                                   ),
//                                 ),
//                                 const SizedBox(width: 10),
//                                 Expanded(
//                                   child: ElevatedButton(
//                                     onPressed: () {
//                                       setState(() {
//                                         _selectedStatus = _draftStatus;
//                                         _selectedLeaveTypeFilter = _draftLeaveTypeFilter;
//                                         _selectedMonth = _draftMonth;
//                                       });
//                                       Navigator.pop(ctx);
//                                     },
//                                     style: ElevatedButton.styleFrom(
//                                       backgroundColor: AppTheme.primary,
//                                       foregroundColor: Colors.white,
//                                       padding: const EdgeInsets.symmetric(vertical: 12),
//                                       shape: RoundedRectangleBorder(
//                                         borderRadius: BorderRadius.circular(10),
//                                       ),
//                                     ),
//                                     child: const Text('Save Changes'),
//                                   ),
//                                 ),
//                               ],
//                             ),
//                           ],
//                         ),
//                       ),
//                     ),
//                   ),
//                 );
//               },
//             );
//           },
//         );
//       },
//     );
//   }

//   Widget _buildFilterButton() {
//     final hasActiveFilters = _selectedStatus != 'All' ||
//         _selectedLeaveTypeFilter != 'All' ||
//         _selectedMonth != 'All';

//     return Padding(
//       padding: const EdgeInsets.only(bottom: 8),
//       child: Align(
//         alignment: Alignment.centerLeft,
//         child: OutlinedButton.icon(
//           onPressed: _openFilterPanel,
//           icon: const Icon(Icons.tune, size: 18),
//           label: Text(hasActiveFilters ? 'Filters Applied' : 'Filter'),
//           style: OutlinedButton.styleFrom(
//             foregroundColor: hasActiveFilters ? AppTheme.primary : AppTheme.headText,
//             side: BorderSide(
//               color: hasActiveFilters ? AppTheme.primary : AppTheme.borderColor,
//             ),
//             padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
//             shape: RoundedRectangleBorder(
//               borderRadius: BorderRadius.circular(999),
//             ),
//           ),
//         ),
//       ),
//     );
//   }

//   Widget _filterDropdown({
//     required String label,
//     required String value,
//     required List<String> options,
//     required ValueChanged<String?> onChanged,
//   }) {
//     return DropdownButtonFormField<String>(
//       initialValue: options.contains(value) ? value : 'All',
//       dropdownColor: AppTheme.surface,
//       style: const TextStyle(color: AppTheme.headText),
//       decoration: InputDecoration(
//         labelText: label,
//         labelStyle: const TextStyle(color: AppTheme.mutedText, fontSize: 12),
//         filled: true,
//         fillColor: AppTheme.slate50,
//         border: OutlineInputBorder(
//           borderRadius: BorderRadius.circular(12),
//           borderSide: const BorderSide(color: AppTheme.borderColor),
//         ),
//         enabledBorder: OutlineInputBorder(
//           borderRadius: BorderRadius.circular(12),
//           borderSide: const BorderSide(color: AppTheme.borderColor),
//         ),
//         focusedBorder: OutlineInputBorder(
//           borderRadius: BorderRadius.circular(12),
//           borderSide: const BorderSide(color: AppTheme.primary, width: 1.2),
//         ),
//         contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
//       ),
//       items: options
//           .map((t) => DropdownMenuItem(
//               value: t,
//               child: Text(t, style: const TextStyle(color: AppTheme.headText))))
//           .toList(),
//       onChanged: onChanged,
//     );
//   }

//   /// Cancels a still-pending leave request. The server (client_staff_leave_
//   /// routes.cancel_leave) is the actual authority here -- it re-checks
//   /// ownership and that status is still 'pending' -- this client-side
//   /// gate (only rendering the button for pending rows) is just so the
//   /// user doesn't tap a button that's guaranteed to fail.
//   Future<void> _cancelLeave(dynamic leave) async {
//     final leaveId = (leave['id'] ?? '').toString();
//     if (leaveId.isEmpty || _cancellingIds.contains(leaveId)) return;

//     final confirmed = await showDialog<bool>(
//       context: context,
//       builder: (ctx) => AlertDialog(
//         backgroundColor: AppTheme.surface,
//         title: const Text('Cancel leave request?',
//             style: TextStyle(color: AppTheme.headText)),
//         content: const Text(
//             'This will withdraw your pending leave request. This cannot be undone.',
//             style: TextStyle(color: AppTheme.bodyText)),
//         actions: [
//           TextButton(
//             onPressed: () => Navigator.pop(ctx, false),
//             child: const Text('Keep it'),
//           ),
//           TextButton(
//             onPressed: () => Navigator.pop(ctx, true),
//             child:
//                 const Text('Cancel Leave', style: TextStyle(color: AppTheme.error)),
//           ),
//         ],
//       ),
//     );
//     if (confirmed != true) return;

//     setState(() => _cancellingIds.add(leaveId));
//     try {
//       await ApiService.cancelLeave(widget.user.token, leaveId);
//       if (mounted) {
//         setState(() => _leaves.removeWhere((l) => (l['id'] ?? '').toString() == leaveId));
//       }
//       await _loadLeaves();
//     } catch (e) {
//       if (mounted) {
//         ScaffoldMessenger.of(context).showSnackBar(
//           SnackBar(content: Text('Could not cancel leave: ${e.toString()}')),
//         );
//       }
//     } finally {
//       if (mounted) setState(() => _cancellingIds.remove(leaveId));
//     }
//   }

//   Future<void> _pickDate(bool isStart) async {
//     final today = leavePolicyDate(DateTime.now());
//     final firstDate = isStart
//       ? today
//       : (_startDate ?? today);
//     final lastDate = today.add(const Duration(days: 365));
//     final initialDate = isStart
//       ? (_startDate ?? today)
//       : (_endDate != null && !_endDate!.isBefore(firstDate)
//         ? _endDate!
//         : firstDate);
//     final picked = await showDatePicker(
//       context: context,
//       initialDate: initialDate,
//       firstDate: firstDate,
//       lastDate: lastDate,
//       builder: (ctx, child) => Theme(
//         data: ThemeData.light().copyWith(
//           colorScheme: const ColorScheme.light(
//             primary: AppTheme.accent,
//             onPrimary: Colors.white,
//             surface: AppTheme.card,
//             onSurface: AppTheme.headText,
//           ),
//         ),
//         child: child!,
//       ),
//     );
//     if (picked != null) {
//       setState(() {
//         if (isStart) {
//           _startDate = picked;
//           if (_isHalfDay || (_endDate != null && _endDate!.isBefore(_startDate!))) {
//             _endDate = _startDate;
//           }
//         } else {
//           _endDate = picked;
//         }
//       });
//     }
//   }

//   double get _leaveDays {
//     if (_isHalfDay) return _startDate != null ? 0.5 : 0;
//     if (_startDate == null || _endDate == null) return 0;
//     return (_endDate!.difference(_startDate!).inDays + 1).toDouble();
//   }

//   void _onLeaveTypeChanged(String? value) {
//     if (value == null) return;
//     setState(() {
//       _leaveType = value;
//       final nowHalfDay = value == 'Half Day';
//       if (nowHalfDay && _startDate != null) _endDate = _startDate;
//       if (nowHalfDay) {
//         _halfDayStartTime ??= const TimeOfDay(hour: 9, minute: 0);
//         _halfDayEndTime ??= const TimeOfDay(hour: 13, minute: 0);
//         _halfDayPeriod = _periodFromTime(_halfDayStartTime!);
//       } else {
//         _halfDayStartTime = null;
//         _halfDayEndTime = null;
//       }
//     });
//   }

//   // Derives the AM/PM bucket the dashboard's half_day_period field expects
//   // from the actual time picked, so the user only has to set one thing
//   // (the time window) instead of a time AND a redundant morning/afternoon
//   // toggle that could disagree with it.
//   String _periodFromTime(TimeOfDay t) => t.hour < 12 ? 'morning' : 'afternoon';

//   int _toMinutes(TimeOfDay t) => t.hour * 60 + t.minute;

//   String _fmtTime(TimeOfDay t) =>
//       '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

//   Future<void> _pickTime(bool isStart) async {
//     final initial = (isStart ? _halfDayStartTime : _halfDayEndTime) ??
//         (isStart
//             ? const TimeOfDay(hour: 9, minute: 0)
//             : const TimeOfDay(hour: 13, minute: 0));
//     final picked = await showTimePicker(
//       context: context,
//       initialTime: initial,
//       builder: (ctx, child) => Theme(
//         data: ThemeData.light().copyWith(
//           colorScheme: const ColorScheme.light(
//             primary: AppTheme.accent,
//             onPrimary: Colors.white,
//             surface: AppTheme.card,
//             onSurface: AppTheme.headText,
//           ),
//         ),
//         child: child!,
//       ),
//     );
//     if (picked != null) {
//       setState(() {
//         if (isStart) {
//           _halfDayStartTime = picked;
//           _halfDayPeriod = _periodFromTime(picked);
//         } else {
//           _halfDayEndTime = picked;
//         }
//       });
//     }
//   }

//   Future<void> _submitLeave() async {
//     if (_startDate == null || (!_isHalfDay && _endDate == null)) {
//       setState(() {
//         _formMsg = _isHalfDay
//             ? 'Select date for half day leave'
//             : 'Select start and end dates for leave';
//         _formSuccess = false;
//       });
//       return;
//     }
//     if (!_isHalfDay && !isLeaveDateRangeAllowed(_startDate!, _endDate!)) {
//       setState(() {
//         _formMsg = 'End date must be after the start date.';
//         _formSuccess = false;
//       });
//       return;
//     }
//     if (_isHalfDay &&
//         (_halfDayStartTime == null || _halfDayEndTime == null)) {
//       setState(() {
//         _formMsg = 'Select start and end times for half day leave';
//         _formSuccess = false;
//       });
//       return;
//     }
//     if (_isHalfDay &&
//         _halfDayStartTime != null &&
//         _halfDayEndTime != null &&
//         _toMinutes(_halfDayEndTime!) <= _toMinutes(_halfDayStartTime!)) {
//       setState(() {
//         _formMsg = 'End time must be after start time';
//         _formSuccess = false;
//       });
//       return;
//     }
//     if (_reasonCtrl.text.trim().isEmpty) {
//       setState(() {
//         _formMsg = 'Please enter a reason for the leave';
//         _formSuccess = false;
//       });
//       return;
//     }

//     setState(() {
//       _submitting = true;
//       _formMsg = '';
//     });

//     try {
//       String fmt(DateTime d) =>
//           '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

//       final effectiveEnd = _isHalfDay ? _startDate! : _endDate!;

//       // Send the underlying slug (e.g. "sick"), not the humanized label
//       // ("Sick Leave") -- this is the exact key leaveTypeRules is keyed
//       // by, so payroll's paid/unpaid lookup and the dashboard's Leave
//       // Management type filter both match this row correctly. Falls back
//       // to the label itself only if it's somehow not in the map (should
//       // not happen via the dropdown, but keeps this resilient).
//       final leaveTypeSlug =
//           _leaveTypeSlugByLabel[_effectiveLeaveType] ?? _effectiveLeaveType;

//       final res = await ApiService.applyLeave(
//         widget.user.token,
//         leaveTypeSlug,
//         fmt(_startDate!),
//         fmt(effectiveEnd),
//         _reasonCtrl.text.trim(),
//         halfDay: _isHalfDay,
//         halfDayPeriod: _isHalfDay ? _halfDayPeriod : null,
//         halfDayStartTime:
//             _isHalfDay && _halfDayStartTime != null ? _fmtTime(_halfDayStartTime!) : null,
//         halfDayEndTime:
//             _isHalfDay && _halfDayEndTime != null ? _fmtTime(_halfDayEndTime!) : null,
//       );

//       if (mounted) {
//         setState(() {
//           _formSuccess = res['success'] == true;
//           _formMsg = res['message'] ??
//               (_formSuccess ? 'Leave applied successfully!' : 'Error occurred');
//         });

//         if (_formSuccess) {
//           _reasonCtrl.clear();
//           _startDate = null;
//           _endDate = null;
//           _leaveType = _leaveTypes.isNotEmpty ? _leaveTypes.first : 'Annual Leave';
//           _halfDayCategory = _leaveType;
//           _halfDayPeriod = 'morning';
//           _halfDayStartTime = null;
//           _halfDayEndTime = null;
//           await _loadLeaves();
//           _tabController.animateTo(1);
//         }
//       }
//     } catch (e) {
//       if (mounted) {
//         setState(() {
//           _formMsg = 'Network error: ${e.toString()}';
//           _formSuccess = false;
//         });
//       }
//     } finally {
//       if (mounted) setState(() => _submitting = false);
//     }
//   }

//   Color _statusColor(String status) {
//     switch (status.toLowerCase()) {
//       case 'approved':
//         return AppTheme.success;
//       case 'rejected':
//         return AppTheme.error;
//       default:
//         return AppTheme.warning;
//     }
//   }

//   IconData _statusIcon(String status) {
//     switch (status.toLowerCase()) {
//       case 'approved':
//         return Icons.check_circle;
//       case 'rejected':
//         return Icons.cancel;
//       default:
//         return Icons.schedule;
//     }
//   }

//   @override
//   Widget build(BuildContext context) {
//     return Scaffold(
//       backgroundColor: AppTheme.bg,
//       appBar: AppBar(
//         title: const Text('Leave Management'),
//         backgroundColor: AppTheme.surface,
//         bottom: TabBar(
//           controller: _tabController,
//           indicatorColor: AppTheme.primary,
//           labelColor: AppTheme.primary,
//           unselectedLabelColor: AppTheme.mutedText,
//           tabs: const [
//             Tab(text: 'Apply Leave'),
//             Tab(text: 'My Leaves'),
//           ],
//         ),
//       ),
//       body: TabBarView(
//         controller: _tabController,
//         children: [
//           _buildApplyTab(),
//           _buildHistoryTab(),
//         ],
//       ),
//     );
//   }

//   Widget _buildApplyTab() {
//     return SingleChildScrollView(
//       padding: const EdgeInsets.all(16),
//       child: Column(
//         crossAxisAlignment: CrossAxisAlignment.start,
//         children: [
//           CustomCard(
//             child: Column(
//               crossAxisAlignment: CrossAxisAlignment.start,
//               children: [
//                 const Text('Leave Type',
//                     style: TextStyle(
//                         color: AppTheme.mutedText,
//                         fontSize: 12,
//                         fontWeight: FontWeight.w600)),
//                 const SizedBox(height: 8),
//                 _dropdownField(
//                   value: _leaveType,
//                   options: _mainLeaveTypeOptions,
//                   onChanged: _onLeaveTypeChanged,
//                 ),
//               ],
//             ),
//           ),
//           if (_isHalfDay)
//             CustomCard(
//               child: Column(
//                 crossAxisAlignment: CrossAxisAlignment.start,
//                 children: [
//                   const Text('Leave Category',
//                       style: TextStyle(
//                           color: AppTheme.mutedText,
//                           fontSize: 12,
//                           fontWeight: FontWeight.w600)),
//                   const SizedBox(height: 4),
//                   const Text(
//                       'Which leave category is this half day being taken against?',
//                       style: TextStyle(color: AppTheme.mutedText, fontSize: 11)),
//                   const SizedBox(height: 8),
//                   _dropdownField(
//                     value: _halfDayCategory,
//                     options: _leaveTypes,
//                     onChanged: (v) => setState(() => _halfDayCategory = v!),
//                   ),
//                   const SizedBox(height: 14),
//                   Row(
//                     children: [
//                       Expanded(
//                         child: _timePicker('Start Time', _halfDayStartTime, true),
//                       ),
//                       const SizedBox(width: 10),
//                       Expanded(
//                         child: _timePicker('End Time', _halfDayEndTime, false),
//                       ),
//                     ],
//                   ),
//                 ],
//               ),
//             ),
//           CustomCard(
//             child: _isHalfDay
//                 ? _datePicker('Date', _startDate, true)
//                 : Row(
//                     children: [
//                       Expanded(child: _datePicker('Start Date', _startDate, true)),
//                       const SizedBox(width: 12),
//                       Expanded(child: _datePicker('End Date', _endDate, false)),
//                     ],
//                   ),
//           ),
//           if (_leaveDays > 0)
//             CustomCard(
//               child: Row(
//                 mainAxisAlignment: MainAxisAlignment.center,
//                 children: [
//                   const Icon(Icons.calendar_today,
//                       color: AppTheme.accent, size: 20),
//                   const SizedBox(width: 8),
//                   Text(
//                     _isHalfDay
//                         ? (_halfDayStartTime != null && _halfDayEndTime != null
//                             ? 'Half day requested (${_fmtTime(_halfDayStartTime!)}–${_fmtTime(_halfDayEndTime!)})'
//                             : 'Half day requested')
//                         : '${_leaveDays.toInt()} day${_leaveDays > 1 ? 's' : ''} requested',
//                     style: const TextStyle(
//                         color: AppTheme.accent,
//                         fontWeight: FontWeight.bold,
//                         fontSize: 16),
//                   ),
//                 ],
//               ),
//             ),
//           CustomCard(
//             child: Column(
//               crossAxisAlignment: CrossAxisAlignment.start,
//               children: [
//                 const Text('Reason',
//                     style: TextStyle(
//                         color: AppTheme.mutedText,
//                         fontSize: 12,
//                         fontWeight: FontWeight.w600)),
//                 const SizedBox(height: 8),
//                 TextField(
//                   controller: _reasonCtrl,
//                   maxLines: 3,
//                   style: const TextStyle(color: AppTheme.bodyText),
//                   decoration: InputDecoration(
//                     hintText: 'Enter reason for leave',
//                     hintStyle: const TextStyle(color: AppTheme.mutedText),
//                     filled: true,
//                     fillColor: AppTheme.bg,
//                     border: OutlineInputBorder(
//                       borderRadius: BorderRadius.circular(8),
//                       borderSide: BorderSide.none,
//                     ),
//                   ),
//                 ),
//               ],
//             ),
//           ),
//           if (_formMsg.isNotEmpty)
//             CustomCard(
//               child: Row(
//                 children: [
//                   Icon(
//                     _formSuccess ? Icons.check_circle : Icons.error_outline,
//                     color: _formSuccess ? AppTheme.success : AppTheme.error,
//                   ),
//                   const SizedBox(width: 12),
//                   Expanded(
//                     child: Text(_formMsg,
//                         style: TextStyle(
//                             color: _formSuccess
//                                 ? AppTheme.success
//                                 : AppTheme.error)),
//                   ),
//                 ],
//               ),
//             ),
//           const SizedBox(height: 8),
//           LoadingButton(
//             isLoading: _submitting,
//             text: 'Submit Leave Request',
//             onPressed: _submitLeave,
//           ),
//         ],
//       ),
//     );
//   }

//   Widget _dropdownField({
//     required String value,
//     required List<String> options,
//     required ValueChanged<String?> onChanged,
//   }) {
//     return DropdownButtonFormField<String>(
//       initialValue: value,
//       dropdownColor: AppTheme.surface,
//       style: const TextStyle(color: AppTheme.headText),
//       decoration: InputDecoration(
//         filled: true,
//         fillColor: AppTheme.bg,
//         border: OutlineInputBorder(
//           borderRadius: BorderRadius.circular(8),
//           borderSide: BorderSide.none,
//         ),
//         contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
//       ),
//       items: options
//           .map((t) => DropdownMenuItem(
//               value: t,
//               child:
//                   Text(t, style: const TextStyle(color: AppTheme.headText))))
//           .toList(),
//       onChanged: onChanged,
//     );
//   }

//   Widget _timePicker(String label, TimeOfDay? time, bool isStart) {
//     return GestureDetector(
//       onTap: () => _pickTime(isStart),
//       child: Container(
//         padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
//         decoration: BoxDecoration(
//           color: AppTheme.slate50,
//           borderRadius: BorderRadius.circular(8),
//           border: Border.all(color: AppTheme.borderColor),
//         ),
//         child: Column(
//           crossAxisAlignment: CrossAxisAlignment.start,
//           children: [
//             Text(label,
//                 style: const TextStyle(color: AppTheme.mutedText, fontSize: 11)),
//             const SizedBox(height: 4),
//             Row(
//               children: [
//                 const Icon(Icons.access_time, color: AppTheme.accent, size: 16),
//                 const SizedBox(width: 6),
//                 Text(
//                   time != null ? time.format(context) : 'Select',
//                   style: TextStyle(
//                     color: time != null ? AppTheme.headText : AppTheme.mutedText,
//                     fontSize: 13,
//                     fontWeight: FontWeight.w600,
//                   ),
//                 ),
//               ],
//             ),
//           ],
//         ),
//       ),
//     );
//   }

//   Widget _datePicker(String label, DateTime? date, bool isStart) {
//     String fmt(DateTime d) => '${d.day}/${d.month}/${d.year}';
//     return GestureDetector(
//       onTap: () => _pickDate(isStart),
//       child: Container(
//         padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
//         decoration: BoxDecoration(
//           color: AppTheme.slate50,
//           borderRadius: BorderRadius.circular(8),
//           border: Border.all(color: AppTheme.borderColor),
//         ),
//         child: Column(
//           crossAxisAlignment: CrossAxisAlignment.start,
//           children: [
//             Text(label,
//                 style: const TextStyle(color: AppTheme.mutedText, fontSize: 11)),
//             const SizedBox(height: 4),
//             Row(
//               children: [
//                 const Icon(Icons.calendar_month,
//                     color: AppTheme.accent, size: 16),
//                 const SizedBox(width: 6),
//                 Text(
//                   date != null ? fmt(date) : 'Select',
//                   style: TextStyle(
//                     color: date != null ? AppTheme.headText : AppTheme.mutedText,
//                     fontSize: 13,
//                     fontWeight: FontWeight.w600,
//                   ),
//                 ),
//               ],
//             ),
//           ],
//         ),
//       ),
//     );
//   }

//   Widget _buildHistoryTab() {
//     if (_loading) {
//       return const Center(
//           child: CircularProgressIndicator(color: AppTheme.accent));
//     }

//     if (_leaves.isEmpty) {
//       return Center(
//         child: Column(
//           mainAxisAlignment: MainAxisAlignment.center,
//           children: [
//             Icon(Icons.event_busy, color: AppTheme.slate300, size: 64),
//             const SizedBox(height: 16),
//             const Text('No leave requests found',
//                 style: TextStyle(color: AppTheme.mutedText, fontSize: 16)),
//             const SizedBox(height: 8),
//             TextButton(
//               onPressed: _loadLeaves,
//               child: const Text('Refresh',
//                   style: TextStyle(color: AppTheme.primary)),
//             ),
//           ],
//         ),
//       );
//     }

//     final pending = _filteredLeaves.where((l) => _statusOf(l) == 'pending').length;
//     final approved = _filteredLeaves.where((l) => _statusOf(l) == 'approved').length;
//     final rejected = _filteredLeaves.where((l) => _statusOf(l) == 'rejected').length;

//     return RefreshIndicator(
//       onRefresh: _loadLeaves,
//       color: AppTheme.accent,
//       child: ListView(
//         padding: const EdgeInsets.all(16),
//         children: [
//           _buildFilterButton(),
//           const SizedBox(height: 12),
//           Row(
//             children: [
//               _statChip('Pending', pending, AppTheme.warning),
//               const SizedBox(width: 8),
//               _statChip('Approved', approved, AppTheme.success),
//               const SizedBox(width: 8),
//               _statChip('Rejected', rejected, AppTheme.error),
//             ],
//           ),
//           const SizedBox(height: 16),
//           if (_filteredLeaves.isEmpty)
//             Padding(
//               padding: const EdgeInsets.symmetric(vertical: 24),
//               child: Center(
//                 child: Text('No leave requests match the selected filters.',
//                     style: const TextStyle(color: AppTheme.mutedText)),
//               ),
//             ),
//           ..._filteredLeaves.map((leave) {
//             final status = leave['status'] ?? 'Pending';
//             final type = leave['type'] ?? leave['leave_type'] ?? 'Leave';
//             final start = leave['startDate'] ?? leave['start_date'] ?? '';
//             final end = leave['endDate'] ?? leave['end_date'] ?? '';
//             final reason = leave['reason'] ?? '';
//             final isHalfDayRow = leave['half_day'] == true ||
//                 leave['halfDay'] == true ||
//                 (leave['half_day_period'] ?? leave['halfDayPeriod']) != null;
//             final leaveId = (leave['id'] ?? '').toString();
//             final isPending = _statusOf(leave) == 'pending';
//             final isCancelling = _cancellingIds.contains(leaveId);

//             return CustomCard(
//               child: Column(
//                 crossAxisAlignment: CrossAxisAlignment.start,
//                 children: [
//                   Row(
//                     children: [
//                       const Icon(Icons.event_note,
//                           color: AppTheme.accent, size: 20),
//                       const SizedBox(width: 8),
//                       Expanded(
//                         child: Row(
//                           children: [
//                             Flexible(
//                               child: Text(type,
//                                   overflow: TextOverflow.ellipsis,
//                                   style: const TextStyle(
//                                       color: AppTheme.headText,
//                                       fontWeight: FontWeight.bold,
//                                       fontSize: 15)),
//                             ),
//                             if (isHalfDayRow) ...[
//                               const SizedBox(width: 6),
//                               Container(
//                                 padding: const EdgeInsets.symmetric(
//                                     horizontal: 6, vertical: 2),
//                                 decoration: BoxDecoration(
//                                   color: AppTheme.accent.withValues(alpha: 0.15),
//                                   borderRadius: BorderRadius.circular(6),
//                                 ),
//                                 child: const Text('Half Day',
//                                     style: TextStyle(
//                                         color: AppTheme.accent,
//                                         fontSize: 10,
//                                         fontWeight: FontWeight.w600)),
//                               ),
//                             ],
//                           ],
//                         ),
//                       ),
//                       Container(
//                         padding: const EdgeInsets.symmetric(
//                             horizontal: 10, vertical: 4),
//                         decoration: BoxDecoration(
//                           color: _statusColor(status).withValues(alpha: 0.15),
//                           borderRadius: BorderRadius.circular(20),
//                           border: Border.all(
//                               color:
//                                   _statusColor(status).withValues(alpha: 0.5)),
//                         ),
//                         child: Row(
//                           mainAxisSize: MainAxisSize.min,
//                           children: [
//                             Icon(_statusIcon(status),
//                                 color: _statusColor(status), size: 12),
//                             const SizedBox(width: 4),
//                             Text(status,
//                                 style: TextStyle(
//                                     color: _statusColor(status),
//                                     fontSize: 12,
//                                     fontWeight: FontWeight.w600)),
//                           ],
//                         ),
//                       ),
//                     ],
//                   ),
//                   if (start.isNotEmpty) ...[
//                     const SizedBox(height: 8),
//                     Row(
//                       children: [
//                         const Icon(Icons.date_range,
//                             color: AppTheme.mutedText, size: 14),
//                         const SizedBox(width: 6),
//                         Text('$start → $end',
//                             style: const TextStyle(
//                                 color: AppTheme.mutedText, fontSize: 13)),
//                       ],
//                     ),
//                   ],
//                   if (reason.isNotEmpty) ...[
//                     const SizedBox(height: 6),
//                     Text(reason,
//                         style:
//                             const TextStyle(color: AppTheme.bodyText, fontSize: 12),
//                         maxLines: 2,
//                         overflow: TextOverflow.ellipsis),
//                   ],
//                   if (isPending) ...[
//                     const SizedBox(height: 10),
//                     Align(
//                       alignment: Alignment.centerRight,
//                       child: TextButton.icon(
//                         onPressed: isCancelling ? null : () => _cancelLeave(leave),
//                         icon: isCancelling
//                             ? const SizedBox(
//                                 width: 14,
//                                 height: 14,
//                                 child: CircularProgressIndicator(
//                                     strokeWidth: 2, color: AppTheme.error),
//                               )
//                             : const Icon(Icons.close, size: 16, color: AppTheme.error),
//                         label: Text(isCancelling ? 'Cancelling…' : 'Cancel Leave',
//                             style: const TextStyle(color: AppTheme.error, fontSize: 13)),
//                       ),
//                     ),
//                   ],
//                 ],
//               ),
//             );
//           }),
//         ],
//       ),
//     );
//   }

//   Widget _statChip(String label, int count, Color color) {
//     return Expanded(
//       child: Container(
//         padding: const EdgeInsets.symmetric(vertical: 10),
//         decoration: BoxDecoration(
//           color: color.withValues(alpha: 0.1),
//           borderRadius: BorderRadius.circular(10),
//           border: Border.all(color: color.withValues(alpha: 0.3)),
//         ),
//         child: Column(
//           children: [
//             Text('$count',
//                 style: TextStyle(
//                     color: color, fontSize: 20, fontWeight: FontWeight.bold)),
//             Text(label,
//                 style: TextStyle(
//                     color: color.withValues(alpha: 0.8), fontSize: 11)),
//           ],
//         ),
//       ),
//     );
//   }
// }

import 'package:flutter/material.dart';
import '../../models/user_model.dart';
import '../../services/api_service.dart';
import '../../utils/app_theme.dart';
import '../../utils/leave_policy.dart';
import '../../widgets/common_widgets.dart';

class LeaveScreen extends StatefulWidget {
  final UserModel user;
  final int refreshToken;

  const LeaveScreen({
    super.key,
    required this.user,
    this.refreshToken = 0,
  });

  @override
  State<LeaveScreen> createState() => _LeaveScreenState();
}

class _LeaveScreenState extends State<LeaveScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;
  List<dynamic> _leaves = [];
  bool _loading = true;

  // 'Half Day' lives in this same dropdown as a duration choice, but it is
  // NOT sent to the backend as leave_type -- see _effectiveLeaveType below.
  // The backend (support_db.create_client_leave_request) and the web
  // dashboard both key off leave_type as the real category (Annual/Sick/
  // ...); overwriting it with a literal 'half_day' was tried before and
  // reverted (see client_staff_leave_routes.py's module docstring) because
  // it made leave_type untrustworthy as "the category" for every half-day
  // row, including for support_db_attendance_gate's half-day lookup, which
  // matches on half_day_period being set rather than leave_type=='half_day'.
  // So the UI shows one flat list with 'Half Day' as an entry (matching
  // the requested UX), and when it's picked, _halfDayCategory (a second,
  // small dropdown) is what actually goes into leave_type on submit.
  String _leaveType = 'Annual Leave';
  String _halfDayCategory = 'Annual Leave';
  final _reasonCtrl = TextEditingController();
  DateTime? _startDate;
  DateTime? _endDate;
  bool _submitting = false;
  String _formMsg = '';
  bool _formSuccess = false;
  String _selectedStatus = 'All';
  String _selectedLeaveTypeFilter = 'All';
  String _selectedMonth = 'All';

  String _draftStatus = 'All';
  String _draftLeaveTypeFilter = 'All';
  String _draftMonth = 'All';

  String _halfDayPeriod =
      'morning'; // 'morning' | 'afternoon' -- derived from _halfDayStartTime, kept for dashboard compat
  TimeOfDay? _halfDayStartTime;
  TimeOfDay? _halfDayEndTime;

  // IDs currently mid-cancel-request, so the Cancel button on that specific
  // history row can show a spinner and disable itself without blocking the
  // rest of the list.
  final Set<String> _cancellingIds = {};

  // ─── Quota-based leave balance (History tab) ──────────────────────────
  // Distinct from the Pending/Approved/Rejected request-count chips above
  // (those come from _leaves itself, client-side); this is the org's
  // configured paid/unpaid annual quota vs. what's actually been taken --
  // same figures as the Client Dashboard's Leave Management > Leave
  // History tab for this same employee, via GET /api/staff/leaves/summary.
  bool _summaryIsAnnual = true;
  bool _summaryLoading = true;
  Map<String, dynamic>? _annualSummary;
  Map<String, dynamic>? _monthlySummary;
  int _summaryYear = DateTime.now().year;
  // First of the currently-selected month, so both the API's "YYYY-MM"
  // param and the on-screen label derive from one value instead of two
  // that could drift apart.
  DateTime _summaryMonth = DateTime(DateTime.now().year, DateTime.now().month);

  bool get _isHalfDay => _leaveType == 'Half Day';

  // What actually gets sent to the backend as leave_type -- the real
  // category, never the literal 'Half Day' label. See the comment on
  // _leaveType above for why this indirection exists.
  String get _effectiveLeaveType => _isHalfDay ? _halfDayCategory : _leaveType;

  // Fallback only -- used when the org hasn't configured any leave types
  // in Payroll Rules yet (leaveTypeRules defaults to {} server-side, see
  // support_db_payroll._DEFAULT_PAYROLL_POLICY) or the /types call fails
  // (offline, etc.), so the form is never left with an empty dropdown.
  // Real leave types now come from ApiService.getLeaveTypes -- the same
  // org+branch-scoped config the web dashboard's Leave Management filter
  // and payroll's paid/unpaid deduction math read (support_db_payroll.
  // get_leave_type_rules), so all three surfaces always agree.
  static const List<String> _defaultLeaveTypeSlugs = [
    'annual',
    'sick',
    'emergency',
    'casual',
    'unpaid',
  ];

  // Display label -> the slug actually submitted as leave_type, so the
  // dropdown can show a friendly "Sick Leave" while the backend receives
  // the exact key ("sick") configured in Payroll Rules -- keeping the
  // value payroll_engine/leaveTypeRules key off of, and the value the
  // dashboard's Leave Management filter matches on, in agreement.
  Map<String, String> _leaveTypeSlugByLabel = {
    for (final slug in _defaultLeaveTypeSlugs) _humanizeLeaveType(slug): slug,
  };
  List<String> _leaveTypes = [
    for (final slug in _defaultLeaveTypeSlugs) _humanizeLeaveType(slug),
  ];
  bool _leaveTypesLoading = true;

  static String _humanizeLeaveType(String slug) {
    final words = slug.trim().replaceAll('_', ' ').split(RegExp(r'\s+'));
    final title = words
        .where((w) => w.isNotEmpty)
        .map((w) => w[0].toUpperCase() + w.substring(1).toLowerCase())
        .join(' ');
    // Every configured type is a leave *category* -- "Sick" alone reads
    // ambiguously in a dropdown next to "Half Day", so match the existing
    // "<Category> Leave" convention unless it's already there (e.g. an
    // admin who typed "sick leave" as the key).
    return title.toLowerCase().endsWith('leave') ? title : '$title Leave';
  }

  static bool _isHalfDayType(String slug) {
    final normalized =
        slug.trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
    return normalized == 'half_day' || normalized == 'half_day_leave';
  }

  Future<void> _loadLeaveTypes() async {
    setState(() => _leaveTypesLoading = true);
    try {
      final rules = await ApiService.getLeaveTypes(widget.user.token);
      final slugs = rules.keys
          .map((k) => k.toString().trim())
          .where((k) => k.isNotEmpty && !_isHalfDayType(k))
          .toList()
        ..sort();
      if (slugs.isEmpty) return; // keep the default fallback as-is

      final labelToSlug = {
        for (final slug in slugs) _humanizeLeaveType(slug): slug,
      };
      if (!mounted) return;
      setState(() {
        _leaveTypeSlugByLabel = labelToSlug;
        _leaveTypes = labelToSlug.keys.toList();
        // The previously-selected value may no longer exist in the newly
        // configured list (e.g. it only ever held the hardcoded default) --
        // reset both dropdowns to a real option so _dropdownField never
        // gets a value outside its own options list.
        if (!_leaveTypes.contains(_leaveType)) {
          _leaveType = _leaveTypes.first;
        }
        if (!_leaveTypes.contains(_halfDayCategory)) {
          _halfDayCategory = _leaveTypes.first;
        }
        if (!_leaveTypes.contains(_selectedLeaveTypeFilter)) {
          _selectedLeaveTypeFilter = 'All';
        }
      });
    } catch (e) {
      // Form stays usable on the default fallback list either way (offline,
      // 401, 500, etc.) -- but log it, since a failed fetch and "org has no
      // leave types configured yet" both leave _leaveTypes on the same
      // fallback and are otherwise indistinguishable from the UI alone.
      debugPrint('[LeaveScreen] Failed to load configured leave types — '
          'dropdown is showing the hardcoded fallback list: $e');
    } finally {
      if (mounted) setState(() => _leaveTypesLoading = false);
    }
  }

  // Main dropdown: the real categories plus 'Half Day' as a duration
  // choice at the end.
  List<String> get _mainLeaveTypeOptions => [..._leaveTypes, 'Half Day'];

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    _loadLeaves();
    _loadLeaveTypes();
    _loadSummary();
  }

  @override
  void didUpdateWidget(covariant LeaveScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.refreshToken != widget.refreshToken) {
      _loadLeaves();
      _loadLeaveTypes();
      _loadSummary();
    }
  }

  @override
  void dispose() {
    _tabController.dispose();
    _reasonCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadLeaves() async {
    setState(() => _loading = true);
    try {
      final data = await ApiService.getMyLeaves(widget.user.token);
      if (mounted) setState(() => _leaves = data);
    } catch (e) {
      // silent fail
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  // Loads whichever of the two (annual/monthly) is currently selected.
  // Called on first load and every time the toggle/year/month changes --
  // each summary is cheap (one Supabase policy read + one leave-list read,
  // both already cached-per-request server-side) and there's no reason to
  // hold a stale annual figure in memory while only the month view is
  // visible, or vice versa.
  Future<void> _loadSummary() {
    return _summaryIsAnnual ? _loadAnnualSummary() : _loadMonthlySummary();
  }

  Future<void> _loadAnnualSummary() async {
    setState(() => _summaryLoading = true);
    try {
      final data = await ApiService.getLeaveSummary(
        widget.user.token,
        period: 'year',
        year: _summaryYear,
      );
      if (mounted) setState(() => _annualSummary = data);
    } catch (e) {
      // Leaves _annualSummary as whatever it last successfully was (or
      // null on first load) -- the card grid below already renders "—"
      // for a null/missing summary, same treatment as an unconfigured
      // quota, so a transient fetch failure never shows a fabricated 0.
    } finally {
      if (mounted) setState(() => _summaryLoading = false);
    }
  }

  Future<void> _loadMonthlySummary() async {
    setState(() => _summaryLoading = true);
    try {
      final monthParam =
          '${_summaryMonth.year.toString().padLeft(4, '0')}-${_summaryMonth.month.toString().padLeft(2, '0')}';
      final data = await ApiService.getLeaveSummary(
        widget.user.token,
        period: 'month',
        month: monthParam,
      );
      if (mounted) setState(() => _monthlySummary = data);
    } catch (e) {
      // See _loadAnnualSummary's comment -- same fail-quiet contract.
    } finally {
      if (mounted) setState(() => _summaryLoading = false);
    }
  }

  List<Map> get _filteredLeaves {
    return _leaves.cast<Map>().where((leave) {
      final status = _statusOf(leave);
      final type = _leaveTypeOf(leave);
      final month = _monthLabel(_startDateOf(leave));
      final statusMatch =
          _selectedStatus == 'All' || status == _selectedStatus.toLowerCase();
      final typeMatch =
          _selectedLeaveTypeFilter == 'All' || type == _selectedLeaveTypeFilter;
      final monthMatch = _selectedMonth == 'All' || month == _selectedMonth;
      return statusMatch && typeMatch && monthMatch;
    }).toList();
  }

  List<String> get _statusOptions {
    final values = _leaves
        .cast<Map>()
        .map(_statusOf)
        .where((s) => s.isNotEmpty)
        .toSet()
        .toList();
    values.sort();
    return ['All', ...values.map((s) => s[0].toUpperCase() + s.substring(1))];
  }

  List<String> get _leaveTypeOptions {
    final values = [..._leaveTypes];
    values.sort();
    return ['All', ...values];
  }

  List<String> get _monthOptions {
    final values = _leaves
        .cast<Map>()
        .map((leave) => _monthLabel(_startDateOf(leave)))
        .toSet()
        .toList();
    values.sort((a, b) => _parseMonthLabel(a).compareTo(_parseMonthLabel(b)));
    return ['All', ...values];
  }

  String _normalizeLeaveTypeValue(String raw) {
    final value = raw.trim();
    if (value.isEmpty) return 'Leave';
    if (_leaveTypeSlugByLabel.containsKey(value)) return value;
    if (_leaveTypeSlugByLabel.containsValue(value)) {
      final entry = _leaveTypeSlugByLabel.entries.firstWhere(
        (entry) => entry.value == value,
        orElse: () => const MapEntry('', ''),
      );
      if (entry.key.isNotEmpty) return entry.key;
    }
    return _humanizeLeaveType(value);
  }

  String _leaveTypeOf(Map leave) {
    final raw = (leave['type'] ?? leave['leave_type'] ?? 'Leave').toString();
    return _normalizeLeaveTypeValue(raw);
  }

  String _statusOf(dynamic leave) {
    return (leave['status'] ?? '').toString().trim().toLowerCase();
  }

  String _startDateOf(Map leave) {
    return (leave['startDate'] ?? leave['start_date'] ?? '').toString();
  }

  String _monthLabel(String dateText) {
    final date = _parseDate(dateText);
    if (date == null) return 'Unknown';
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
    return '${months[date.month - 1]} ${date.year}';
  }

  DateTime _parseMonthLabel(String label) {
    final parts = label.split(' ');
    if (parts.length != 2) return DateTime(1900);
    final monthNames = {
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
    final month = monthNames[parts[0]] ?? 1;
    final year = int.tryParse(parts[1]) ?? 1900;
    return DateTime(year, month);
  }

  DateTime? _parseDate(String value) {
    try {
      return DateTime.parse(value);
    } catch (_) {
      final normalized = value.replaceAll('/', '-');
      final isoMatch =
          RegExp(r'^(\d{4})-(\d{1,2})-(\d{1,2})').firstMatch(normalized);
      if (isoMatch != null) {
        return DateTime(
          int.parse(isoMatch.group(1)!),
          int.parse(isoMatch.group(2)!),
          int.parse(isoMatch.group(3)!),
        );
      }
      final dmyMatch =
          RegExp(r'^(\d{1,2})-(\d{1,2})-(\d{4})').firstMatch(normalized);
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
    _draftStatus = _selectedStatus;
    _draftLeaveTypeFilter = _selectedLeaveTypeFilter;
    _draftMonth = _selectedMonth;
  }

  void _clearLeaveFilters() {
    setState(() {
      _selectedStatus = 'All';
      _selectedLeaveTypeFilter = 'All';
      _selectedMonth = 'All';
      _draftStatus = 'All';
      _draftLeaveTypeFilter = 'All';
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
                        borderRadius:
                            BorderRadius.vertical(top: Radius.circular(24)),
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
                                  'Filter leaves',
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
                                      _draftLeaveTypeFilter = 'All';
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
                              label: 'Leave Type',
                              value: _draftLeaveTypeFilter,
                              options: _leaveTypeOptions,
                              onChanged: (value) {
                                if (value == null) return;
                                setSheetState(
                                    () => _draftLeaveTypeFilter = value);
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
                                      side: const BorderSide(
                                          color: AppTheme.borderColor),
                                      padding: const EdgeInsets.symmetric(
                                          vertical: 12),
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
                                        _selectedLeaveTypeFilter =
                                            _draftLeaveTypeFilter;
                                        _selectedMonth = _draftMonth;
                                      });
                                      Navigator.pop(ctx);
                                    },
                                    style: ElevatedButton.styleFrom(
                                      backgroundColor: AppTheme.primary,
                                      foregroundColor: Colors.white,
                                      padding: const EdgeInsets.symmetric(
                                          vertical: 12),
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
    final hasActiveFilters = _selectedStatus != 'All' ||
        _selectedLeaveTypeFilter != 'All' ||
        _selectedMonth != 'All';

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Align(
        alignment: Alignment.centerLeft,
        child: OutlinedButton.icon(
          onPressed: _openFilterPanel,
          icon: const Icon(Icons.tune, size: 18),
          label: Text(hasActiveFilters ? 'Filters Applied' : 'Filter'),
          style: OutlinedButton.styleFrom(
            foregroundColor:
                hasActiveFilters ? AppTheme.primary : AppTheme.headText,
            side: BorderSide(
              color: hasActiveFilters ? AppTheme.primary : AppTheme.borderColor,
            ),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(999),
            ),
          ),
        ),
      ),
    );
  }

  Widget _filterDropdown({
    required String label,
    required String value,
    required List<String> options,
    required ValueChanged<String?> onChanged,
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
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      ),
      items: options
          .map((t) => DropdownMenuItem(
              value: t,
              child: Text(t, style: const TextStyle(color: AppTheme.headText))))
          .toList(),
      onChanged: onChanged,
    );
  }

  /// Cancels a still-pending leave request. The server (client_staff_leave_
  /// routes.cancel_leave) is the actual authority here -- it re-checks
  /// ownership and that status is still 'pending' -- this client-side
  /// gate (only rendering the button for pending rows) is just so the
  /// user doesn't tap a button that's guaranteed to fail.
  Future<void> _cancelLeave(dynamic leave) async {
    final leaveId = (leave['id'] ?? '').toString();
    if (leaveId.isEmpty || _cancellingIds.contains(leaveId)) return;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppTheme.surface,
        title: const Text('Cancel leave request?',
            style: TextStyle(color: AppTheme.headText)),
        content: const Text(
            'This will withdraw your pending leave request. This cannot be undone.',
            style: TextStyle(color: AppTheme.bodyText)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Keep it'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Cancel Leave',
                style: TextStyle(color: AppTheme.error)),
          ),
        ],
      ),
    );
    if (confirmed != true) return;

    setState(() => _cancellingIds.add(leaveId));
    try {
      await ApiService.cancelLeave(widget.user.token, leaveId);
      if (mounted) {
        setState(() =>
            _leaves.removeWhere((l) => (l['id'] ?? '').toString() == leaveId));
      }
      await _loadLeaves();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not cancel leave: ${e.toString()}')),
        );
      }
    } finally {
      if (mounted) setState(() => _cancellingIds.remove(leaveId));
    }
  }

  Future<void> _pickDate(bool isStart) async {
    final today = leavePolicyDate(DateTime.now());
    final firstDate = isStart ? today : (_startDate ?? today);
    final lastDate = today.add(const Duration(days: 365));
    final initialDate = isStart
        ? (_startDate ?? today)
        : (_endDate != null && !_endDate!.isBefore(firstDate)
            ? _endDate!
            : firstDate);
    final picked = await showDatePicker(
      context: context,
      initialDate: initialDate,
      firstDate: firstDate,
      lastDate: lastDate,
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
    if (picked != null) {
      setState(() {
        if (isStart) {
          _startDate = picked;
          if (_isHalfDay ||
              (_endDate != null && _endDate!.isBefore(_startDate!))) {
            _endDate = _startDate;
          }
        } else {
          _endDate = picked;
        }
      });
    }
  }

  double get _leaveDays {
    if (_isHalfDay) return _startDate != null ? 0.5 : 0;
    if (_startDate == null || _endDate == null) return 0;
    return (_endDate!.difference(_startDate!).inDays + 1).toDouble();
  }

  void _onLeaveTypeChanged(String? value) {
    if (value == null) return;
    setState(() {
      _leaveType = value;
      final nowHalfDay = value == 'Half Day';
      if (nowHalfDay && _startDate != null) _endDate = _startDate;
      if (nowHalfDay) {
        _halfDayStartTime ??= const TimeOfDay(hour: 9, minute: 0);
        _halfDayEndTime ??= const TimeOfDay(hour: 13, minute: 0);
        _halfDayPeriod = _periodFromTime(_halfDayStartTime!);
      } else {
        _halfDayStartTime = null;
        _halfDayEndTime = null;
      }
    });
  }

  // Derives the AM/PM bucket the dashboard's half_day_period field expects
  // from the actual time picked, so the user only has to set one thing
  // (the time window) instead of a time AND a redundant morning/afternoon
  // toggle that could disagree with it.
  String _periodFromTime(TimeOfDay t) => t.hour < 12 ? 'morning' : 'afternoon';

  int _toMinutes(TimeOfDay t) => t.hour * 60 + t.minute;

  String _fmtTime(TimeOfDay t) =>
      '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

  Future<void> _pickTime(bool isStart) async {
    final initial = (isStart ? _halfDayStartTime : _halfDayEndTime) ??
        (isStart
            ? const TimeOfDay(hour: 9, minute: 0)
            : const TimeOfDay(hour: 13, minute: 0));
    final picked = await showTimePicker(
      context: context,
      initialTime: initial,
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
    if (picked != null) {
      setState(() {
        if (isStart) {
          _halfDayStartTime = picked;
          _halfDayPeriod = _periodFromTime(picked);
        } else {
          _halfDayEndTime = picked;
        }
      });
    }
  }

  Future<void> _submitLeave() async {
    if (_startDate == null || (!_isHalfDay && _endDate == null)) {
      setState(() {
        _formMsg = _isHalfDay
            ? 'Select date for half day leave'
            : 'Select start and end dates for leave';
        _formSuccess = false;
      });
      return;
    }
    if (!_isHalfDay && !isLeaveDateRangeAllowed(_startDate!, _endDate!)) {
      setState(() {
        _formMsg = 'End date must be after the start date.';
        _formSuccess = false;
      });
      return;
    }
    if (_isHalfDay && (_halfDayStartTime == null || _halfDayEndTime == null)) {
      setState(() {
        _formMsg = 'Select start and end times for half day leave';
        _formSuccess = false;
      });
      return;
    }
    if (_isHalfDay &&
        _halfDayStartTime != null &&
        _halfDayEndTime != null &&
        _toMinutes(_halfDayEndTime!) <= _toMinutes(_halfDayStartTime!)) {
      setState(() {
        _formMsg = 'End time must be after start time';
        _formSuccess = false;
      });
      return;
    }
    if (_reasonCtrl.text.trim().isEmpty) {
      setState(() {
        _formMsg = 'Please enter a reason for the leave';
        _formSuccess = false;
      });
      return;
    }

    setState(() {
      _submitting = true;
      _formMsg = '';
    });

    try {
      String fmt(DateTime d) =>
          '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

      final effectiveEnd = _isHalfDay ? _startDate! : _endDate!;

      // Send the underlying slug (e.g. "sick"), not the humanized label
      // ("Sick Leave") -- this is the exact key leaveTypeRules is keyed
      // by, so payroll's paid/unpaid lookup and the dashboard's Leave
      // Management type filter both match this row correctly. Falls back
      // to the label itself only if it's somehow not in the map (should
      // not happen via the dropdown, but keeps this resilient).
      final leaveTypeSlug =
          _leaveTypeSlugByLabel[_effectiveLeaveType] ?? _effectiveLeaveType;

      final res = await ApiService.applyLeave(
        widget.user.token,
        leaveTypeSlug,
        fmt(_startDate!),
        fmt(effectiveEnd),
        _reasonCtrl.text.trim(),
        halfDay: _isHalfDay,
        halfDayPeriod: _isHalfDay ? _halfDayPeriod : null,
        halfDayStartTime: _isHalfDay && _halfDayStartTime != null
            ? _fmtTime(_halfDayStartTime!)
            : null,
        halfDayEndTime: _isHalfDay && _halfDayEndTime != null
            ? _fmtTime(_halfDayEndTime!)
            : null,
      );

      if (mounted) {
        setState(() {
          _formSuccess = res['success'] == true;
          _formMsg = res['message'] ??
              (_formSuccess ? 'Leave applied successfully!' : 'Error occurred');
        });

        if (_formSuccess) {
          _reasonCtrl.clear();
          _startDate = null;
          _endDate = null;
          _leaveType =
              _leaveTypes.isNotEmpty ? _leaveTypes.first : 'Annual Leave';
          _halfDayCategory = _leaveType;
          _halfDayPeriod = 'morning';
          _halfDayStartTime = null;
          _halfDayEndTime = null;
          await _loadLeaves();
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

  IconData _statusIcon(String status) {
    switch (status.toLowerCase()) {
      case 'approved':
        return Icons.check_circle;
      case 'rejected':
        return Icons.cancel;
      default:
        return Icons.schedule;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.bg,
      appBar: AppBar(
        title: const Text('Leave Management'),
        backgroundColor: AppTheme.surface,
        bottom: TabBar(
          controller: _tabController,
          indicatorColor: AppTheme.primary,
          labelColor: AppTheme.primary,
          unselectedLabelColor: AppTheme.mutedText,
          labelStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
          unselectedLabelStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500),
          tabs: const [
            Tab(text: 'Apply Leave'),
            Tab(text: 'My Leaves'),
            Tab(text: 'Leave History'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [
          _buildApplyTab(),
          _buildHistoryTab(),
          _buildLeaveHistoryTab(),
        ],
      ),
    );
  }

  Widget _buildApplyTab() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CustomCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Leave Type',
                    style: TextStyle(
                        color: AppTheme.mutedText,
                        fontSize: 12,
                        fontWeight: FontWeight.w600)),
                const SizedBox(height: 8),
                _dropdownField(
                  value: _leaveType,
                  options: _mainLeaveTypeOptions,
                  onChanged: _onLeaveTypeChanged,
                ),
              ],
            ),
          ),
          if (_isHalfDay)
            CustomCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Leave Category',
                      style: TextStyle(
                          color: AppTheme.mutedText,
                          fontSize: 12,
                          fontWeight: FontWeight.w600)),
                  const SizedBox(height: 4),
                  const Text(
                      'Which leave category is this half day being taken against?',
                      style:
                          TextStyle(color: AppTheme.mutedText, fontSize: 11)),
                  const SizedBox(height: 8),
                  _dropdownField(
                    value: _halfDayCategory,
                    options: _leaveTypes,
                    onChanged: (v) => setState(() => _halfDayCategory = v!),
                  ),
                  const SizedBox(height: 14),
                  Row(
                    children: [
                      Expanded(
                        child:
                            _timePicker('Start Time', _halfDayStartTime, true),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: _timePicker('End Time', _halfDayEndTime, false),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          CustomCard(
            child: _isHalfDay
                ? _datePicker('Date', _startDate, true)
                : Row(
                    children: [
                      Expanded(
                          child: _datePicker('Start Date', _startDate, true)),
                      const SizedBox(width: 12),
                      Expanded(child: _datePicker('End Date', _endDate, false)),
                    ],
                  ),
          ),
          if (_leaveDays > 0)
            CustomCard(
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(Icons.calendar_today,
                      color: AppTheme.accent, size: 20),
                  const SizedBox(width: 8),
                  Text(
                    _isHalfDay
                        ? (_halfDayStartTime != null && _halfDayEndTime != null
                            ? 'Half day requested (${_fmtTime(_halfDayStartTime!)}–${_fmtTime(_halfDayEndTime!)})'
                            : 'Half day requested')
                        : '${_leaveDays.toInt()} day${_leaveDays > 1 ? 's' : ''} requested',
                    style: const TextStyle(
                        color: AppTheme.accent,
                        fontWeight: FontWeight.bold,
                        fontSize: 16),
                  ),
                ],
              ),
            ),
          CustomCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Reason',
                    style: TextStyle(
                        color: AppTheme.mutedText,
                        fontSize: 12,
                        fontWeight: FontWeight.w600)),
                const SizedBox(height: 8),
                TextField(
                  controller: _reasonCtrl,
                  maxLines: 3,
                  style: const TextStyle(color: AppTheme.bodyText),
                  decoration: InputDecoration(
                    hintText: 'Enter reason for leave',
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
            text: 'Submit Leave Request',
            onPressed: _submitLeave,
          ),
        ],
      ),
    );
  }

  Widget _dropdownField({
    required String value,
    required List<String> options,
    required ValueChanged<String?> onChanged,
  }) {
    return DropdownButtonFormField<String>(
      initialValue: value,
      dropdownColor: AppTheme.surface,
      style: const TextStyle(color: AppTheme.headText),
      decoration: InputDecoration(
        filled: true,
        fillColor: AppTheme.bg,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: BorderSide.none,
        ),
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      ),
      items: options
          .map((t) => DropdownMenuItem(
              value: t,
              child: Text(t, style: const TextStyle(color: AppTheme.headText))))
          .toList(),
      onChanged: onChanged,
    );
  }

  Widget _timePicker(String label, TimeOfDay? time, bool isStart) {
    return GestureDetector(
      onTap: () => _pickTime(isStart),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: AppTheme.slate50,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: AppTheme.borderColor),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label,
                style:
                    const TextStyle(color: AppTheme.mutedText, fontSize: 11)),
            const SizedBox(height: 4),
            Row(
              children: [
                const Icon(Icons.access_time, color: AppTheme.accent, size: 16),
                const SizedBox(width: 6),
                Text(
                  time != null ? time.format(context) : 'Select',
                  style: TextStyle(
                    color:
                        time != null ? AppTheme.headText : AppTheme.mutedText,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _datePicker(String label, DateTime? date, bool isStart) {
    String fmt(DateTime d) => '${d.day}/${d.month}/${d.year}';
    return GestureDetector(
      onTap: () => _pickDate(isStart),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: AppTheme.slate50,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: AppTheme.borderColor),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label,
                style:
                    const TextStyle(color: AppTheme.mutedText, fontSize: 11)),
            const SizedBox(height: 4),
            Row(
              children: [
                const Icon(Icons.calendar_month,
                    color: AppTheme.accent, size: 16),
                const SizedBox(width: 6),
                Text(
                  date != null ? fmt(date) : 'Select',
                  style: TextStyle(
                    color:
                        date != null ? AppTheme.headText : AppTheme.mutedText,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildHistoryTab() {
    if (_loading) {
      return const Center(
          child: CircularProgressIndicator(color: AppTheme.accent));
    }

    if (_leaves.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.event_busy, color: AppTheme.slate300, size: 64),
            const SizedBox(height: 16),
            const Text('No leave requests found',
                style: TextStyle(color: AppTheme.mutedText, fontSize: 16)),
            const SizedBox(height: 8),
            TextButton(
              onPressed: _loadLeaves,
              child: const Text('Refresh',
                  style: TextStyle(color: AppTheme.primary)),
            ),
          ],
        ),
      );
    }

    final pending =
        _filteredLeaves.where((l) => _statusOf(l) == 'pending').length;
    final approved =
        _filteredLeaves.where((l) => _statusOf(l) == 'approved').length;
    final rejected =
        _filteredLeaves.where((l) => _statusOf(l) == 'rejected').length;

    return RefreshIndicator(
      onRefresh: _loadLeaves,
      color: AppTheme.accent,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _buildFilterButton(),
          const SizedBox(height: 12),
          Row(
            children: [
              _statChip('Pending', pending, AppTheme.warning),
              const SizedBox(width: 8),
              _statChip('Approved', approved, AppTheme.success),
              const SizedBox(width: 8),
              _statChip('Rejected', rejected, AppTheme.error),
            ],
          ),
          const SizedBox(height: 16),
          if (_filteredLeaves.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 24),
              child: Center(
                child: Text('No leave requests match the selected filters.',
                    style: const TextStyle(color: AppTheme.mutedText)),
              ),
            ),
          ..._filteredLeaves.map((leave) {
            final status = leave['status'] ?? 'Pending';
            final type = leave['type'] ?? leave['leave_type'] ?? 'Leave';
            final start = leave['startDate'] ?? leave['start_date'] ?? '';
            final end = leave['endDate'] ?? leave['end_date'] ?? '';
            final reason = leave['reason'] ?? '';
            final isHalfDayRow = leave['half_day'] == true ||
                leave['halfDay'] == true ||
                (leave['half_day_period'] ?? leave['halfDayPeriod']) != null;
            final leaveId = (leave['id'] ?? '').toString();
            final isPending = _statusOf(leave) == 'pending';
            final isCancelling = _cancellingIds.contains(leaveId);

            return CustomCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.event_note,
                          color: AppTheme.accent, size: 20),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Row(
                          children: [
                            Flexible(
                              child: Text(type,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                      color: AppTheme.headText,
                                      fontWeight: FontWeight.bold,
                                      fontSize: 15)),
                            ),
                            if (isHalfDayRow) ...[
                              const SizedBox(width: 6),
                              Container(
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 6, vertical: 2),
                                decoration: BoxDecoration(
                                  color:
                                      AppTheme.accent.withValues(alpha: 0.15),
                                  borderRadius: BorderRadius.circular(6),
                                ),
                                child: const Text('Half Day',
                                    style: TextStyle(
                                        color: AppTheme.accent,
                                        fontSize: 10,
                                        fontWeight: FontWeight.w600)),
                              ),
                            ],
                          ],
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 10, vertical: 4),
                        decoration: BoxDecoration(
                          color: _statusColor(status).withValues(alpha: 0.15),
                          borderRadius: BorderRadius.circular(20),
                          border: Border.all(
                              color:
                                  _statusColor(status).withValues(alpha: 0.5)),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(_statusIcon(status),
                                color: _statusColor(status), size: 12),
                            const SizedBox(width: 4),
                            Text(status,
                                style: TextStyle(
                                    color: _statusColor(status),
                                    fontSize: 12,
                                    fontWeight: FontWeight.w600)),
                          ],
                        ),
                      ),
                    ],
                  ),
                  if (start.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        const Icon(Icons.date_range,
                            color: AppTheme.mutedText, size: 14),
                        const SizedBox(width: 6),
                        Text('$start → $end',
                            style: const TextStyle(
                                color: AppTheme.mutedText, fontSize: 13)),
                      ],
                    ),
                  ],
                  if (reason.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Text(reason,
                        style: const TextStyle(
                            color: AppTheme.bodyText, fontSize: 12),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis),
                  ],
                  if (isPending) ...[
                    const SizedBox(height: 10),
                    Align(
                      alignment: Alignment.centerRight,
                      child: TextButton.icon(
                        onPressed:
                            isCancelling ? null : () => _cancelLeave(leave),
                        icon: isCancelling
                            ? const SizedBox(
                                width: 14,
                                height: 14,
                                child: CircularProgressIndicator(
                                    strokeWidth: 2, color: AppTheme.error),
                              )
                            : const Icon(Icons.close,
                                size: 16, color: AppTheme.error),
                        label: Text(
                            isCancelling ? 'Cancelling…' : 'Cancel Leave',
                            style: const TextStyle(
                                color: AppTheme.error, fontSize: 13)),
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

  // ─── Leave History tab (annual/monthly balance) ───────────────────────
  // Dedicated tab so the balance/quota view isn't buried under the request
  // list on "My Leaves" -- same data (_annualSummary/_monthlySummary,
  // loaded eagerly in initState/didUpdateWidget) just given its own home.

  Widget _buildLeaveHistoryTab() {
    return RefreshIndicator(
      onRefresh: _loadSummary,
      color: AppTheme.accent,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _leaveHistoryHeader(),
          const SizedBox(height: 16),
          _buildLeaveBalanceSection(),
          const SizedBox(height: 16),
          _leaveHistoryFootnote(),
        ],
      ),
    );
  }

  Widget _leaveHistoryHeader() {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [AppTheme.accent, AppTheme.accentAlt],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(16),
        boxShadow: [
          BoxShadow(
            color: AppTheme.accent.withValues(alpha: 0.25),
            blurRadius: 12,
            offset: const Offset(0, 6),
          ),
        ],
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.16),
              borderRadius: BorderRadius.circular(12),
            ),
            child: const Icon(Icons.event_available,
                color: Colors.white, size: 26),
          ),
          const SizedBox(width: 14),
          const Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Leave History',
                    style: TextStyle(
                        color: Colors.white,
                        fontSize: 17,
                        fontWeight: FontWeight.bold)),
                SizedBox(height: 4),
                Text('Track your annual and monthly leave usage',
                    style: TextStyle(color: Colors.white70, fontSize: 12)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  // Taken figures here reflect approved leave reconciled against
  // attendance -- a day only counts as taken when the employee was both
  // approved AND absent that day, the same rule Payroll applies (see
  // ApiService.getLeaveSummary / support_db_payroll.get_client_staff_
  // leave_taken), so this can never disagree with a payslip deduction.
  Widget _leaveHistoryFootnote() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.info_outline, size: 14, color: AppTheme.mutedText.withValues(alpha: 0.8)),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              'A day is counted as availed only when it was approved and you '
              'were absent that day -- matching what Payroll deducts.',
              style: TextStyle(
                  color: AppTheme.mutedText.withValues(alpha: 0.8),
                  fontSize: 11,
                  height: 1.4),
            ),
          ),
        ],
      ),
    );
  }

  // ─── Quota-based leave balance section ────────────────────────────────

  Widget _buildLeaveBalanceSection() {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.cardColor,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppTheme.borderColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Text('Leave Balance',
                  style: TextStyle(
                      color: AppTheme.headText,
                      fontSize: 14,
                      fontWeight: FontWeight.bold)),
              const Spacer(),
              _balanceToggle(),
            ],
          ),
          const SizedBox(height: 10),
          _summaryIsAnnual ? _yearSelector() : _monthSelector(),
          const SizedBox(height: 12),
          if (_summaryLoading)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 16),
              child: Center(
                  child: CircularProgressIndicator(color: AppTheme.accent)),
            )
          else
            _summaryIsAnnual ? _annualBalanceGrid() : _monthlyBalanceGrid(),
        ],
      ),
    );
  }

  Widget _balanceToggle() {
    Widget segment(String label, bool isAnnual) {
      final selected = _summaryIsAnnual == isAnnual;
      return GestureDetector(
        onTap: () {
          if (selected) return;
          setState(() => _summaryIsAnnual = isAnnual);
          _loadSummary();
        },
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: BoxDecoration(
            color: selected ? AppTheme.primary : Colors.transparent,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Text(
            label,
            style: TextStyle(
              color: selected ? Colors.white : AppTheme.mutedText,
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: AppTheme.slate50,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppTheme.borderColor),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        segment('Annual', true),
        segment('Monthly', false),
      ]),
    );
  }

  Widget _yearSelector() {
    return Row(
      children: [
        IconButton(
          icon: const Icon(Icons.chevron_left, color: AppTheme.mutedText),
          onPressed: () {
            setState(() => _summaryYear -= 1);
            _loadAnnualSummary();
          },
        ),
        Text('$_summaryYear',
            style: const TextStyle(
                color: AppTheme.headText,
                fontSize: 14,
                fontWeight: FontWeight.w700)),
        IconButton(
          icon: const Icon(Icons.chevron_right, color: AppTheme.mutedText),
          onPressed: _summaryYear >= DateTime.now().year
              ? null
              : () {
                  setState(() => _summaryYear += 1);
                  _loadAnnualSummary();
                },
        ),
      ],
    );
  }

  Widget _monthSelector() {
    final label = _monthYearLabel(_summaryMonth);
    final isCurrentMonth = _summaryMonth.year == DateTime.now().year &&
        _summaryMonth.month == DateTime.now().month;
    return Row(
      children: [
        IconButton(
          icon: const Icon(Icons.chevron_left, color: AppTheme.mutedText),
          onPressed: () {
            setState(() => _summaryMonth =
                DateTime(_summaryMonth.year, _summaryMonth.month - 1));
            _loadMonthlySummary();
          },
        ),
        Text(label,
            style: const TextStyle(
                color: AppTheme.headText,
                fontSize: 14,
                fontWeight: FontWeight.w700)),
        IconButton(
          icon: const Icon(Icons.chevron_right, color: AppTheme.mutedText),
          onPressed: isCurrentMonth
              ? null
              : () {
                  setState(() => _summaryMonth =
                      DateTime(_summaryMonth.year, _summaryMonth.month + 1));
                  _loadMonthlySummary();
                },
        ),
      ],
    );
  }

  static const List<String> _monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  String _monthYearLabel(DateTime d) => '${_monthNames[d.month - 1]} ${d.year}';

  /// Renders a quota-derived figure ("Total"/"Remaining" columns only --
  /// never the "Availed" column, which is real usage regardless of
  /// whether a quota is configured). Matches LeaveHistoryTable.tsx's
  /// QuotaCell: an unconfigured quota shows "—", never a misleading "0".
  String _quotaValue(num? value, bool quotaConfigured) {
    if (!quotaConfigured || value == null) return '—';
    return _formatLeaveDays(value);
  }

  /// Drops a trailing ".0" for whole numbers but keeps one decimal place
  /// for a half-day figure (e.g. 8 -> "8", 0.5 -> "0.5", 13.0 -> "13").
  String _formatLeaveDays(num value) {
    return value == value.roundToDouble()
        ? value.toInt().toString()
        : value.toStringAsFixed(1);
  }

  Widget _annualBalanceGrid() {
    final summary = _annualSummary;
    final quotaConfigured = (summary?['quotaConfigured'] as bool?) ?? false;
    final takenPaid = (summary?['takenPaidLeaves'] as num?) ?? 0;
    final takenUnpaid = (summary?['takenUnpaidLeaves'] as num?) ?? 0;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (!quotaConfigured)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Text(
              'No annual leave quota is configured yet for your organization. '
              'Ask your admin to set one in Payroll Rules to see Total and '
              'Remaining leaves.',
              style: TextStyle(
                  color: AppTheme.mutedText.withValues(alpha: 0.9),
                  fontSize: 11),
            ),
          ),
        _balanceTable(
          columnFlex: const [1.6, 1, 1, 1],
          header: const ['Leave Type', 'Total', 'Availed', 'Remaining'],
          rows: [
            _balanceRow(
              label: 'Paid Leaves',
              accentColor: AppTheme.success,
              values: [
                _quotaValue(summary?['totalPaidLeaves'] as num?, quotaConfigured),
                _formatLeaveDays(takenPaid),
                _quotaValue(summary?['remainingPaidLeaves'] as num?, quotaConfigured),
              ],
              warn: const [false, false, true],
            ),
            _balanceRow(
              label: 'Unpaid Leaves',
              accentColor: AppTheme.warning,
              values: [
                _quotaValue(summary?['totalUnpaidLeaves'] as num?, quotaConfigured),
                _formatLeaveDays(takenUnpaid),
                _quotaValue(summary?['remainingUnpaidLeaves'] as num?, quotaConfigured),
              ],
              warn: const [false, false, true],
            ),
            _balanceRow(
              label: 'Total',
              accentColor: AppTheme.accent,
              bold: true,
              values: [
                _quotaValue(summary?['totalLeaves'] as num?, quotaConfigured),
                _formatLeaveDays(takenPaid + takenUnpaid),
                _quotaValue(summary?['remainingLeaves'] as num?, quotaConfigured),
              ],
              warn: const [false, false, true],
            ),
          ],
        ),
      ],
    );
  }

  Widget _monthlyBalanceGrid() {
    final summary = _monthlySummary;
    final takenPaid = (summary?['takenPaidLeaves'] as num?) ?? 0;
    final takenUnpaid = (summary?['takenUnpaidLeaves'] as num?) ?? 0;
    final takenTotal =
        (summary?['takenThisMonth'] as num?) ?? (takenPaid + takenUnpaid);

    return _balanceTable(
      columnFlex: const [1.6, 1],
      header: const ['Leave Type', 'Availed'],
      rows: [
        _balanceRow(
          label: 'Paid Leaves',
          accentColor: AppTheme.success,
          values: [_formatLeaveDays(takenPaid)],
        ),
        _balanceRow(
          label: 'Unpaid Leaves',
          accentColor: AppTheme.warning,
          values: [_formatLeaveDays(takenUnpaid)],
        ),
        _balanceRow(
          label: 'Total',
          accentColor: AppTheme.accent,
          bold: true,
          values: [_formatLeaveDays(takenTotal)],
        ),
      ],
    );
  }

  // ─── Table primitives (shared by annual + monthly balance tables) ─────
  // A real Table (bordered rows/columns) reads as a proper financial/HR
  // ledger -- the professional look this replaces the balance-card grid
  // for -- instead of a loose Wrap of colored chips.

  Widget _balanceTable({
    required List<double> columnFlex,
    required List<String> header,
    required List<TableRow> rows,
  }) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(10),
      child: Container(
        decoration: BoxDecoration(
          border: Border.all(color: AppTheme.borderColor),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Table(
          columnWidths: {
            for (var i = 0; i < columnFlex.length; i++)
              i: FlexColumnWidth(columnFlex[i]),
          },
          border: TableBorder(
            horizontalInside:
                BorderSide(color: AppTheme.borderColor.withValues(alpha: 0.6)),
          ),
          children: [_balanceHeaderRow(header), ...rows],
        ),
      ),
    );
  }

  TableRow _balanceHeaderRow(List<String> labels) {
    return TableRow(
      decoration: const BoxDecoration(color: AppTheme.slate50),
      children: labels
          .asMap()
          .entries
          .map((e) => _tableCell(
                e.value,
                align: e.key == 0 ? TextAlign.left : TextAlign.center,
                style: const TextStyle(
                  color: AppTheme.mutedText,
                  fontSize: 10.5,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 0.2,
                ),
              ))
          .toList(),
    );
  }

  /// A "—" (unconfigured quota) never trips the negative-remaining warn
  /// color -- only a real, parsed negative number does.
  TableRow _balanceRow({
    required String label,
    required Color accentColor,
    required List<String> values,
    bool bold = false,
    List<bool> warn = const [],
  }) {
    return TableRow(
      decoration: bold
          ? BoxDecoration(color: accentColor.withValues(alpha: 0.06))
          : null,
      children: [
        _tableCell(
          label,
          align: TextAlign.left,
          leadingDot: accentColor,
          style: TextStyle(
            color: AppTheme.headText,
            fontSize: 12.5,
            fontWeight: bold ? FontWeight.w800 : FontWeight.w600,
          ),
        ),
        ...values.asMap().entries.map((entry) {
          final isWarn = entry.key < warn.length && warn[entry.key];
          final parsed = double.tryParse(entry.value);
          final isNegative = isWarn && parsed != null && parsed < 0;
          return _tableCell(
            entry.value,
            align: TextAlign.center,
            style: TextStyle(
              color: isNegative
                  ? AppTheme.error
                  : (bold ? AppTheme.headText : AppTheme.bodyText),
              fontSize: 12.5,
              fontWeight: bold || isNegative ? FontWeight.w800 : FontWeight.w600,
            ),
          );
        }),
      ],
    );
  }

  Widget _tableCell(
    String text, {
    required TextAlign align,
    required TextStyle style,
    Color? leadingDot,
  }) {
    return TableCell(
      verticalAlignment: TableCellVerticalAlignment.middle,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 10),
        child: leadingDot == null
            ? Text(text, style: style, textAlign: align)
            : Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 7,
                    height: 7,
                    margin: const EdgeInsets.only(right: 8),
                    decoration:
                        BoxDecoration(color: leadingDot, shape: BoxShape.circle),
                  ),
                  Expanded(child: Text(text, style: style)),
                ],
              ),
      ),
    );
  }

  Widget _statChip(String label, int count, Color color) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: color.withValues(alpha: 0.3)),
        ),
        child: Column(
          children: [
            Text('$count',
                style: TextStyle(
                    color: color, fontSize: 20, fontWeight: FontWeight.bold)),
            Text(label,
                style: TextStyle(
                    color: color.withValues(alpha: 0.8), fontSize: 11)),
          ],
        ),
      ),
    );
  }
}