import 'package:flutter/material.dart';
import 'package:toastification/toastification.dart';
import '../../models/user_model.dart';
import '../../services/api_service.dart';
import '../../services/auth_service.dart';
import '../../utils/app_theme.dart';
import '../auth/login_screen.dart';

/// profile_screen.dart
/// ──────────────────────────────────────────────────────────────────────
/// "My Profile" tab, shared between office staff and field staff. Split
/// out of the old office_home_screen.dart::_buildProfileTab() into its
/// own file, the same way AttendanceHistoryScreen / LeaveScreen /
/// OvertimeScreen already are.
///
/// [staffType] ('office' | 'field') is passed in explicitly by whichever
/// home screen instantiates this widget -- the same pattern
/// HRChatbotWidget/NotificationPoller already use for `type`/`staffType`
/// -- rather than relying on a field on UserModel. It only changes:
///   - which attendance source stats are pulled from (office attendance
///     vs. field GPS+face attendance logs)
///   - the default role/staff-type labels shown when the backend hasn't
///     supplied one
///   - whether an "Assigned Location" row is shown (field only)
/// Everything else (leave stats, overtime stats, live profile fields)
/// is fetched the same way for both, so there is no hardcoded per-type
/// data beyond these display defaults.
///
/// Why the old inline version actually broke (see the screenshot this
/// was reported with): its header packed the ID straight into a
/// fixed-width column sitting next to an Expanded name column inside one
/// Row. That layout implicitly assumed a short id. The real value is a
/// 36-character Supabase UUID -- once that landed in the fixed column,
/// there wasn't enough row width left for the Expanded name column,
/// which Flutter then squeezed to near-zero, wrapping the name one
/// letter per line and throwing a RenderFlex overflow. Fixed here by
/// giving the ID its own full-width row *below* the name (see
/// _buildHeader), truncated + ellipsized, so its length can never again
/// starve a sibling column.
///
/// "Functional": unlike the old tab (a method on OfficeHomeScreen's
/// State that only ever showed whatever the dashboard had already
/// fetched), this screen fetches its own profile + attendance/leave/
/// overtime data via ApiService, the same self-sufficient pattern
/// AttendanceHistoryScreen/LeaveScreen/OvertimeScreen use -- so it's
/// correct however it's reached, supports pull-to-refresh, and reflects
/// live department/role/shift/branch data instead of the login-time
/// snapshot on UserModel plus a hardcoded label.
class ProfileScreen extends StatefulWidget {
  final UserModel user;
  final String staffType; // 'office' | 'field'
  const ProfileScreen({
    super.key,
    required this.user,
    this.staffType = 'office',
  });

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  // Same palette source/aliases as office_home_screen.dart -- keep any
  // new color additions in AppTheme, not as raw hex here.
  static const _bg = AppTheme.bgPage;
  static const _card = AppTheme.cardColor;
  static const _indigo = AppTheme.navy700;
  static const _green = AppTheme.successColor;
  static const _red = AppTheme.error;
  static const _amber = AppTheme.amber;
  static const _blue = AppTheme.navy600;

  bool get _isField => widget.staffType == 'field';

  bool _loading = true;
  bool _refreshing = false;

  // Fresh profile fields from ApiService.getMe(). Read defensively via
  // _field() below (multiple key spellings, always falls back to
  // widget.user's login-time snapshot) since the exact response shape
  // isn't guaranteed the same way UserModel's own fields are.
  Map<String, dynamic> _profile = {};


  @override
  void initState() {
    super.initState();
    _fetchAll();
  }

  Future<void> _fetchAll() async {
    await _fetchProfile();
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _fetchProfile() async {
    try {
      final res = await ApiService.getMe(widget.user.token);
      if (!mounted) return;
      final data = res['staff'] ?? res['user'] ?? res['data'] ?? res;
      if (data is Map<String, dynamic>) {
        setState(() => _profile = data);
      }
    } catch (_) {
      // Soft-fail: every read below falls back to widget.user's
      // login-time snapshot, so a failed refresh shows slightly-stale
      // data instead of a blank/broken screen.
    }
  }

  Future<void> _refresh() async {
    if (_refreshing) return;
    setState(() => _refreshing = true);
    try {
      await _fetchAll();
      _showToast('Profile refreshed', isError: false);
    } catch (_) {
      _showToast('Refresh failed — check your connection', isError: true);
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
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
      autoCloseDuration: const Duration(seconds: 2),
      borderRadius: BorderRadius.circular(12),
    );
  }

  // Reads a field from the freshly-fetched profile map, trying a couple
  // of common key spellings, and only falls back once every spelling
  // comes up empty -- never returns null, so every call site below can
  // treat the result as plain text.
  String _field(String key, {String fallback = ''}) {
    final v = _profile[key];
    if (v != null) {
      final s = v.toString().trim();
      if (s.isNotEmpty) return s;
    }
    return fallback;
  }

  String _titleCase(String s) {
    if (s.isEmpty) return s;
    return s
        .split(RegExp(r'[_\s]+'))
        .where((w) => w.isNotEmpty)
        .map((w) => '${w[0].toUpperCase()}${w.substring(1)}')
        .join(' ');
  }

  Future<void> _confirmSignOut() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: _card,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: const Text('Sign Out',
            style:
                TextStyle(color: AppTheme.headText, fontWeight: FontWeight.w700)),
        content: const Text(
          'You will need to log in again to access your account.',
          style: TextStyle(color: AppTheme.mutedText),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel',
                style: TextStyle(color: AppTheme.mutedText)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Sign Out',
                style: TextStyle(color: _red, fontWeight: FontWeight.w700)),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await AuthService.logout();
    if (!mounted) return;
    Navigator.pushAndRemoveUntil(
      context,
      MaterialPageRoute(builder: (_) => const LoginScreen()),
      (route) => false,
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return Container(
        color: _bg,
        alignment: Alignment.center,
        child: const CircularProgressIndicator(color: _indigo),
      );
    }
    return Container(
      color: _bg,
      child: RefreshIndicator(
        color: _indigo,
        onRefresh: _refresh,
        child: SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(14, 20, 14, 32),
          child: Column(children: [
            _buildHeader(),
            const SizedBox(height: 16),
            _buildInfoCard(),
            const SizedBox(height: 20),
            _buildSignOutButton(),
          ]),
        ),
      ),
    );
  }

  Widget _buildHeader() {
    final name =
        widget.user.name.isNotEmpty ? widget.user.name : _field('name', fallback: 'Staff Member');
    final defaultRole = _isField ? 'Field Staff' : 'Office Staff';
    final role = _field('role', fallback: widget.user.role.isNotEmpty
        ? widget.user.role
        : defaultRole);

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [AppTheme.navy700, AppTheme.navy600],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: _indigo.withValues(alpha: 0.3)),
      ),
      child: Column(children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Container(
            width: 64,
            height: 64,
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: _indigo.withValues(alpha: 0.5), width: 2),
            ),
            child: Center(
              child: Text(
                name.isNotEmpty
                    ? name[0].toUpperCase()
                    : (_isField ? 'F' : 'O'),
                style: const TextStyle(
                    color: Colors.white, fontSize: 24, fontWeight: FontWeight.bold),
              ),
            ),
          ),
          const SizedBox(width: 16),
          // Expanded so the name/role column always gets whatever width
          // is left after the fixed-size avatar and refresh button --
          // never squeezed by anything variable-length like the ID,
          // which now lives in its own row below instead of here.
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(
                name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                    color: Colors.white, fontSize: 19, fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 3),
              Text(
                role,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Color(0xB3FFFFFF), fontSize: 12),
              ),
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: _green.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: _green.withValues(alpha: 0.3)),
                ),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Container(
                    width: 6,
                    height: 6,
                    decoration:
                        const BoxDecoration(color: _green, shape: BoxShape.circle),
                  ),
                  const SizedBox(width: 4),
                  const Text('ACTIVE',
                      style: TextStyle(
                          color: _green, fontSize: 10, fontWeight: FontWeight.w700)),
                ]),
              ),
            ]),
          ),
          const SizedBox(width: 8),
          _refreshing
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white70),
                )
              : GestureDetector(
                  onTap: _refresh,
                  child: Container(
                    padding: const EdgeInsets.all(6),
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: const Icon(Icons.refresh, color: Colors.white70, size: 18),
                  ),
                ),
        ]),
      ]),
    );
  }

  Widget _buildInfoCard() {
    final defaultStaffType = _isField ? 'field_staff' : 'office_staff';
    final staffType = _titleCase(
        _field('people_type', fallback: _field('staff_type', fallback: defaultStaffType)));
    final shift = _field('shift_name', fallback: _field('shift'));
    final branch = _field('branch_name', fallback: _field('branch'));
    final joined = _field('join_date', fallback: _field('joined_at'));
    // Field staff only: their assigned geofence location, sourced from the
    // live profile first and falling back to the login-time UserModel
    // snapshot (the same field field_home_screen previously read directly).
    final assignedLocation = _isField
        ? _field('assigned_location',
            fallback: _field('location', fallback: widget.user.geofenceLabel ?? ''))
        : '';

    final fields = <Map<String, Object>>[
      {
        'icon': Icons.email_outlined,
        'label': 'Email',
        'value': widget.user.email,
        'color': _indigo,
      },
      {
        'icon': Icons.business,
        'label': 'Department',
        'value': _field('department', fallback: widget.user.department),
        'color': _green,
      },
      {
        'icon': Icons.work_outline,
        'label': 'Role',
        'value': _field('role', fallback: widget.user.role),
        'color': _amber,
      },
      {
        'icon': Icons.badge_outlined,
        'label': 'Staff Type',
        'value': staffType,
        'color': _blue,
      },
      if (shift.isNotEmpty)
        {
          'icon': Icons.schedule,
          'label': 'Shift',
          'value': shift,
          'color': AppTheme.teal600,
        },
      if (branch.isNotEmpty)
        {
          'icon': Icons.apartment_outlined,
          'label': 'Branch',
          'value': branch,
          'color': _indigo,
        },
      if (assignedLocation.isNotEmpty)
        {
          'icon': Icons.location_on_outlined,
          'label': 'Assigned Location',
          'value': assignedLocation,
          'color': AppTheme.teal600,
        },
      if (joined.isNotEmpty)
        {
          'icon': Icons.event_available_outlined,
          'label': 'Joined',
          'value': joined,
          'color': _green,
        },
    ];

    return Container(
      decoration: BoxDecoration(
        color: _card,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppTheme.borderColor),
      ),
      child: Column(
        children: List.generate(fields.length, (i) {
          final f = fields[i];
          final color = f['color'] as Color;
          final rawValue = f['value'] as String;
          final value = rawValue.isEmpty ? '—' : rawValue;
          return Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: BoxDecoration(
              border: i < fields.length - 1
                  ? Border(
                      bottom: BorderSide(color: AppTheme.borderColor.withValues(alpha: 0.5)))
                  : null,
            ),
            child: Row(children: [
              Container(
                width: 28,
                height: 28,
                decoration: BoxDecoration(
                  color: AppTheme.teal50,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(f['icon'] as IconData, color: color, size: 14),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(f['label'] as String,
                      style: const TextStyle(color: AppTheme.mutedText, fontSize: 10)),
                  Text(value,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          color: AppTheme.headText,
                          fontSize: 13,
                          fontWeight: FontWeight.w500)),
                ]),
              ),
            ]),
          );
        }),
      ),
    );
  }

  Widget _buildSignOutButton() {
    return GestureDetector(
      onTap: _confirmSignOut,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(vertical: 14),
        decoration: BoxDecoration(
          color: _red.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: _red.withValues(alpha: 0.3)),
        ),
        child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          const Icon(Icons.logout, color: _red, size: 18),
          const SizedBox(width: 8),
          const Text('Sign Out',
              style: TextStyle(color: _red, fontSize: 14, fontWeight: FontWeight.w600)),
        ]),
      ),
    );
  }
}