import os

files = {}

files[
    "lib/main.dart"
] = """import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'utils/app_theme.dart';
import 'services/auth_service.dart';
import 'screens/auth/login_screen.dart';
import 'screens/field_staff/field_home_screen.dart';
import 'screens/office_staff/office_home_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
  runApp(const AttendanceApp());
}

class AttendanceApp extends StatelessWidget {
  const AttendanceApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Attendance Pro',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.darkTheme,
      home: const SplashScreen(),
    );
  }
}

class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});
  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> {
  @override
  void initState() {
    super.initState();
    _checkAuth();
  }

  Future<void> _checkAuth() async {
    await Future.delayed(const Duration(seconds: 2));
    if (!mounted) return;
    final user = await AuthService.getUser();
    if (!mounted) return;
    if (user != null) {
      Navigator.pushReplacement(context, MaterialPageRoute(
        builder: (_) => user.isFieldStaff
            ? FieldHomeScreen(user: user)
            : OfficeHomeScreen(user: user),
      ));
    } else {
      Navigator.pushReplacement(
          context, MaterialPageRoute(builder: (_) => const LoginScreen()));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0F1117),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 90, height: 90,
              decoration: BoxDecoration(
                color: const Color(0xFF6C63FF).withOpacity(0.15),
                borderRadius: BorderRadius.circular(24),
                border: Border.all(
                    color: const Color(0xFF6C63FF).withOpacity(0.4), width: 1.5),
              ),
              child: const Icon(Icons.fingerprint,
                  color: Color(0xFF6C63FF), size: 50),
            ),
            const SizedBox(height: 24),
            const Text('Attendance Pro',
                style: TextStyle(
                    color: Colors.white,
                    fontSize: 28,
                    fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            const Text('Loading...',
                style: TextStyle(color: Colors.grey, fontSize: 14)),
            const SizedBox(height: 32),
            const SizedBox(
              width: 30, height: 30,
              child: CircularProgressIndicator(
                  color: Color(0xFF6C63FF), strokeWidth: 2.5),
            ),
          ],
        ),
      ),
    );
  }
}
"""

files[
    "lib/models/user_model.dart"
] = """class UserModel {
  final int id;
  final String name;
  final String email;
  final String role;
  final String token;

  UserModel({
    required this.id,
    required this.name,
    required this.email,
    required this.role,
    required this.token,
  });

  bool get isFieldStaff => role == 'field_staff';
  bool get isOfficeStaff => role == 'office_staff';

  factory UserModel.fromJson(Map<String, dynamic> json) {
    return UserModel(
      id: json['id'] ?? 0,
      name: json['name'] ?? '',
      email: json['email'] ?? '',
      role: json['role'] ?? '',
      token: json['token'] ?? '',
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'email': email,
    'role': role,
    'token': token,
  };
}
"""

files[
    "lib/services/api_service.dart"
] = """import 'dart:convert';
import 'package:http/http.dart' as http;
import '../models/user_model.dart';

class ApiService {
  // TODO: apna IP address yahan set karein (CMD mein ipconfig chalao)
  static const String baseUrl = 'http://192.168.100.50:5000';

  static Map<String, String> _headers(String token) => {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer \$token',
  };

  // ===== AUTH =====
  static Future<Map<String, dynamic>> login(String email, String password) async {
    final res = await http.post(
      Uri.parse('\$baseUrl/api/login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'email': email, 'password': password}),
    ).timeout(const Duration(seconds: 15));
    return jsonDecode(res.body);
  }

  // ===== FIELD STAFF =====
  static Future<Map<String, dynamic>> markFieldAttendance(
      String token, double lat, double lng) async {
    final res = await http.post(
      Uri.parse('\$baseUrl/api/field/mark-attendance'),
      headers: _headers(token),
      body: jsonEncode({'latitude': lat, 'longitude': lng}),
    ).timeout(const Duration(seconds: 15));
    return jsonDecode(res.body);
  }

  static Future<List<dynamic>> getFieldAttendanceLogs(String token) async {
    final res = await http.get(
      Uri.parse('\$baseUrl/api/field/attendance-logs'),
      headers: _headers(token),
    ).timeout(const Duration(seconds: 15));
    final data = jsonDecode(res.body);
    return data['logs'] ?? [];
  }

  // ===== OFFICE STAFF =====
  static Future<Map<String, dynamic>> markOfficeAttendance(
      String token, String name) async {
    final res = await http.post(
      Uri.parse('\$baseUrl/mark_attendance'),
      headers: _headers(token),
      body: jsonEncode({'name': name}),
    ).timeout(const Duration(seconds: 15));
    return jsonDecode(res.body);
  }

  static Future<List<dynamic>> getOfficeAttendance(
      String token, String name) async {
    final res = await http.get(
      Uri.parse('\$baseUrl/get_attendance_by_name?name=\$name'),
      headers: _headers(token),
    ).timeout(const Duration(seconds: 15));
    final data = jsonDecode(res.body);
    return data['attendance'] ?? [];
  }

  // ===== LEAVE =====
  static Future<Map<String, dynamic>> applyLeave(
      String token, String leaveType, String startDate,
      String endDate, String reason) async {
    final res = await http.post(
      Uri.parse('\$baseUrl/apply_leave'),
      headers: _headers(token),
      body: jsonEncode({
        'leave_type': leaveType,
        'start_date': startDate,
        'end_date': endDate,
        'reason': reason,
      }),
    ).timeout(const Duration(seconds: 15));
    return jsonDecode(res.body);
  }

  static Future<List<dynamic>> getMyLeaves(String token) async {
    final res = await http.get(
      Uri.parse('\$baseUrl/get_my_leaves'),
      headers: _headers(token),
    ).timeout(const Duration(seconds: 15));
    final data = jsonDecode(res.body);
    return data['leaves'] ?? [];
  }

  // ===== OVERTIME =====
  static Future<Map<String, dynamic>> requestOvertime(
      String token, String date, String hours, String reason) async {
    final res = await http.post(
      Uri.parse('\$baseUrl/api/overtime/request'),
      headers: _headers(token),
      body: jsonEncode({'date': date, 'hours': hours, 'reason': reason}),
    ).timeout(const Duration(seconds: 15));
    return jsonDecode(res.body);
  }

  static Future<List<dynamic>> getMyOvertime(String token) async {
    final res = await http.get(
      Uri.parse('\$baseUrl/api/overtime/my'),
      headers: _headers(token),
    ).timeout(const Duration(seconds: 15));
    final data = jsonDecode(res.body);
    return data['overtime'] ?? [];
  }
}
"""

files[
    "lib/services/auth_service.dart"
] = """import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/user_model.dart';

class AuthService {
  static const String _userKey = 'user_data';

  static Future<void> saveUser(UserModel user) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_userKey, jsonEncode(user.toJson()));
  }

  static Future<UserModel?> getUser() async {
    final prefs = await SharedPreferences.getInstance();
    final data = prefs.getString(_userKey);
    if (data == null) return null;
    return UserModel.fromJson(jsonDecode(data));
  }

  static Future<void> logout() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_userKey);
  }
}
"""

files[
    "lib/utils/app_theme.dart"
] = """import 'package:flutter/material.dart';

class AppTheme {
  static const Color primary = Color(0xFF6C63FF);
  static const Color bg = Color(0xFF0F1117);
  static const Color surface = Color(0xFF1A1D27);
  static const Color card = Color(0xFF252836);
  static const Color success = Color(0xFF4CAF50);
  static const Color warning = Color(0xFFFF9800);
  static const Color error = Color(0xFFF44336);

  static ThemeData get darkTheme => ThemeData(
    brightness: Brightness.dark,
    scaffoldBackgroundColor: bg,
    primaryColor: primary,
    colorScheme: const ColorScheme.dark(
      primary: primary,
      surface: surface,
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: surface,
      elevation: 0,
      centerTitle: true,
      titleTextStyle: TextStyle(
          color: Colors.white, fontSize: 18, fontWeight: FontWeight.bold),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: primary,
        foregroundColor: Colors.white,
        padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 24),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: card,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide.none,
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: primary, width: 1.5),
      ),
      labelStyle: const TextStyle(color: Colors.grey),
    ),
  );
}
"""

files[
    "lib/widgets/common_widgets.dart"
] = """import 'package:flutter/material.dart';
import '../utils/app_theme.dart';

class CustomCard extends StatelessWidget {
  final Widget child;
  final EdgeInsets? padding;
  const CustomCard({super.key, required this.child, this.padding});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: padding ?? const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppTheme.card,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Colors.white.withOpacity(0.05)),
      ),
      child: child,
    );
  }
}

class StatusBadge extends StatelessWidget {
  final String status;
  const StatusBadge({super.key, required this.status});

  @override
  Widget build(BuildContext context) {
    Color color;
    switch (status.toLowerCase()) {
      case 'approved': color = AppTheme.success; break;
      case 'pending': color = AppTheme.warning; break;
      case 'rejected': color = AppTheme.error; break;
      default: color = Colors.grey;
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withOpacity(0.15),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: color.withOpacity(0.4)),
      ),
      child: Text(status,
          style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600)),
    );
  }
}

class LoadingButton extends StatelessWidget {
  final bool isLoading;
  final String text;
  final VoidCallback? onPressed;
  const LoadingButton(
      {super.key, required this.isLoading, required this.text, this.onPressed});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      child: ElevatedButton(
        onPressed: isLoading ? null : onPressed,
        child: isLoading
            ? const SizedBox(
                width: 20, height: 20,
                child: CircularProgressIndicator(
                    color: Colors.white, strokeWidth: 2))
            : Text(text, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
      ),
    );
  }
}
"""

files[
    "lib/screens/auth/login_screen.dart"
] = """import 'package:flutter/material.dart';
import '../../services/api_service.dart';
import '../../services/auth_service.dart';
import '../../models/user_model.dart';
import '../../utils/app_theme.dart';
import '../../widgets/common_widgets.dart';
import '../field_staff/field_home_screen.dart';
import '../office_staff/office_home_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _emailCtrl = TextEditingController();
  final _passCtrl = TextEditingController();
  bool _loading = false;
  bool _obscure = true;
  String _error = '';

  Future<void> _login() async {
    if (_emailCtrl.text.isEmpty || _passCtrl.text.isEmpty) {
      setState(() => _error = 'Email aur password required hai');
      return;
    }
    setState(() { _loading = true; _error = ''; });
    try {
      final res = await ApiService.login(_emailCtrl.text.trim(), _passCtrl.text);
      if (res['success'] == true || res['token'] != null) {
        final user = UserModel.fromJson(res['user'] ?? res);
        await AuthService.saveUser(user);
        if (!mounted) return;
        Navigator.pushReplacement(context, MaterialPageRoute(
          builder: (_) => user.isFieldStaff
              ? FieldHomeScreen(user: user)
              : OfficeHomeScreen(user: user),
        ));
      } else {
        setState(() => _error = res['message'] ?? 'Login failed');
      }
    } catch (e) {
      setState(() => _error = 'Server se connect nahi ho saka. IP check karein.');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 60),
              Center(
                child: Container(
                  width: 80, height: 80,
                  decoration: BoxDecoration(
                    color: AppTheme.primary.withOpacity(0.15),
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(
                        color: AppTheme.primary.withOpacity(0.4), width: 1.5),
                  ),
                  child: const Icon(Icons.fingerprint,
                      color: AppTheme.primary, size: 44),
                ),
              ),
              const SizedBox(height: 32),
              const Text('Welcome Back',
                  style: TextStyle(
                      color: Colors.white,
                      fontSize: 28,
                      fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              const Text('Apna account mein login karein',
                  style: TextStyle(color: Colors.grey, fontSize: 14)),
              const SizedBox(height: 40),
              TextField(
                controller: _emailCtrl,
                keyboardType: TextInputType.emailAddress,
                style: const TextStyle(color: Colors.white),
                decoration: const InputDecoration(
                  labelText: 'Email',
                  prefixIcon: Icon(Icons.email_outlined, color: Colors.grey),
                ),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _passCtrl,
                obscureText: _obscure,
                style: const TextStyle(color: Colors.white),
                decoration: InputDecoration(
                  labelText: 'Password',
                  prefixIcon: const Icon(Icons.lock_outline, color: Colors.grey),
                  suffixIcon: IconButton(
                    icon: Icon(
                        _obscure ? Icons.visibility_off : Icons.visibility,
                        color: Colors.grey),
                    onPressed: () => setState(() => _obscure = !_obscure),
                  ),
                ),
                onSubmitted: (_) => _login(),
              ),
              if (_error.isNotEmpty) ...[
                const SizedBox(height: 12),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: AppTheme.error.withOpacity(0.1),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: AppTheme.error.withOpacity(0.3)),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.error_outline,
                          color: AppTheme.error, size: 16),
                      const SizedBox(width: 8),
                      Expanded(
                          child: Text(_error,
                              style: const TextStyle(
                                  color: AppTheme.error, fontSize: 13))),
                    ],
                  ),
                ),
              ],
              const SizedBox(height: 32),
              LoadingButton(
                  isLoading: _loading, text: 'Login', onPressed: _login),
            ],
          ),
        ),
      ),
    );
  }
}
"""

files[
    "lib/screens/field_staff/field_home_screen.dart"
] = """import 'package:flutter/material.dart';
import '../../models/user_model.dart';
import '../../services/auth_service.dart';
import '../../utils/app_theme.dart';
import '../../widgets/common_widgets.dart';
import '../auth/login_screen.dart';
import '../shared/leave_screen.dart';
import '../shared/overtime_screen.dart';
import '../shared/attendance_history_screen.dart';
import 'field_attendance_screen.dart';

class FieldHomeScreen extends StatelessWidget {
  final UserModel user;
  const FieldHomeScreen({super.key, required this.user});

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final greeting = now.hour < 12 ? 'Good Morning' :
        now.hour < 17 ? 'Good Afternoon' : 'Good Evening';

    return Scaffold(
      appBar: AppBar(
        title: const Text('Field Staff'),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout, color: Colors.grey),
            onPressed: () async {
              await AuthService.logout();
              if (context.mounted) {
                Navigator.pushReplacement(context,
                    MaterialPageRoute(builder: (_) => const LoginScreen()));
              }
            },
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            CustomCard(
              child: Row(
                children: [
                  CircleAvatar(
                    radius: 28,
                    backgroundColor: AppTheme.primary.withOpacity(0.2),
                    child: Text(user.name.isNotEmpty ? user.name[0].toUpperCase() : 'F',
                        style: const TextStyle(
                            color: AppTheme.primary,
                            fontSize: 22,
                            fontWeight: FontWeight.bold)),
                  ),
                  const SizedBox(width: 16),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(greeting,
                          style: const TextStyle(
                              color: Colors.grey, fontSize: 13)),
                      Text(user.name,
                          style: const TextStyle(
                              color: Colors.white,
                              fontSize: 18,
                              fontWeight: FontWeight.bold)),
                      const Text('Field Staff',
                          style: TextStyle(
                              color: AppTheme.primary, fontSize: 12)),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            _MenuButton(
              icon: Icons.location_on,
              color: AppTheme.primary,
              title: 'Mark Attendance',
              subtitle: 'GPS se attendance lagayein',
              onTap: () => Navigator.push(context, MaterialPageRoute(
                  builder: (_) => FieldAttendanceScreen(user: user))),
            ),
            _MenuButton(
              icon: Icons.history,
              color: AppTheme.success,
              title: 'Attendance History',
              subtitle: 'Apni attendance record dekhein',
              onTap: () => Navigator.push(context, MaterialPageRoute(
                  builder: (_) => AttendanceHistoryScreen(user: user))),
            ),
            _MenuButton(
              icon: Icons.beach_access,
              color: AppTheme.warning,
              title: 'Apply Leave',
              subtitle: 'Leave request karein',
              onTap: () => Navigator.push(context, MaterialPageRoute(
                  builder: (_) => LeaveScreen(user: user))),
            ),
            _MenuButton(
              icon: Icons.more_time,
              color: Colors.teal,
              title: 'Overtime',
              subtitle: 'Overtime request karein',
              onTap: () => Navigator.push(context, MaterialPageRoute(
                  builder: (_) => OvertimeScreen(user: user))),
            ),
          ],
        ),
      ),
    );
  }
}

class _MenuButton extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  const _MenuButton({
    required this.icon, required this.color, required this.title,
    required this.subtitle, required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return CustomCard(
      padding: EdgeInsets.zero,
      child: ListTile(
        onTap: onTap,
        leading: Container(
          width: 46, height: 46,
          decoration: BoxDecoration(
            color: color.withOpacity(0.15),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Icon(icon, color: color, size: 24),
        ),
        title: Text(title,
            style: const TextStyle(
                color: Colors.white, fontWeight: FontWeight.w600)),
        subtitle: Text(subtitle,
            style: const TextStyle(color: Colors.grey, fontSize: 12)),
        trailing: const Icon(Icons.arrow_forward_ios,
            color: Colors.grey, size: 14),
      ),
    );
  }
}
"""

files[
    "lib/screens/field_staff/field_attendance_screen.dart"
] = """import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import '../../models/user_model.dart';
import '../../services/api_service.dart';
import '../../utils/app_theme.dart';
import '../../widgets/common_widgets.dart';

class FieldAttendanceScreen extends StatefulWidget {
  final UserModel user;
  const FieldAttendanceScreen({super.key, required this.user});
  @override
  State<FieldAttendanceScreen> createState() => _FieldAttendanceScreenState();
}

class _FieldAttendanceScreenState extends State<FieldAttendanceScreen> {
  bool _loading = false;
  String _status = '';
  bool _success = false;
  Position? _position;

  Future<void> _markAttendance() async {
    setState(() { _loading = true; _status = 'Location le raha hai...'; });
    try {
      final permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        await Geolocator.requestPermission();
      }
      final pos = await Geolocator.getCurrentPosition(
          desiredAccuracy: LocationAccuracy.high);
      setState(() { _position = pos; _status = 'Attendance mark ho rahi hai...'; });
      final res = await ApiService.markFieldAttendance(
          widget.user.token, pos.latitude, pos.longitude);
      if (mounted) {
        setState(() {
          _success = res['success'] == true;
          _status = res['message'] ?? (_success ? 'Attendance mark ho gayi!' : 'Error aaya');
        });
      }
    } catch (e) {
      if (mounted) setState(() => _status = 'Error: \${e.toString()}');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Mark Attendance')),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          children: [
            CustomCard(
              child: Column(
                children: [
                  const Icon(Icons.location_on, color: AppTheme.primary, size: 48),
                  const SizedBox(height: 12),
                  const Text('GPS Attendance',
                      style: TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 8),
                  const Text('Apni current location se attendance mark karein',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: Colors.grey)),
                  if (_position != null) ...[
                    const SizedBox(height: 12),
                    Text('Lat: \${_position!.latitude.toStringAsFixed(6)}',
                        style: const TextStyle(color: Colors.grey, fontSize: 12)),
                    Text('Lng: \${_position!.longitude.toStringAsFixed(6)}',
                        style: const TextStyle(color: Colors.grey, fontSize: 12)),
                  ],
                ],
              ),
            ),
            if (_status.isNotEmpty)
              CustomCard(
                child: Row(
                  children: [
                    Icon(
                      _success ? Icons.check_circle : Icons.info_outline,
                      color: _success ? AppTheme.success : AppTheme.warning,
                    ),
                    const SizedBox(width: 12),
                    Expanded(child: Text(_status,
                        style: const TextStyle(color: Colors.white))),
                  ],
                ),
              ),
            const Spacer(),
            LoadingButton(
              isLoading: _loading,
              text: 'Mark Attendance',
              onPressed: _markAttendance,
            ),
          ],
        ),
      ),
    );
  }
}
"""

files[
    "lib/screens/office_staff/office_home_screen.dart"
] = """import 'package:flutter/material.dart';
import '../../models/user_model.dart';
import '../../services/api_service.dart';
import '../../services/auth_service.dart';
import '../../utils/app_theme.dart';
import '../../widgets/common_widgets.dart';
import '../auth/login_screen.dart';
import '../shared/leave_screen.dart';
import '../shared/overtime_screen.dart';
import '../shared/attendance_history_screen.dart';

class OfficeHomeScreen extends StatefulWidget {
  final UserModel user;
  const OfficeHomeScreen({super.key, required this.user});
  @override
  State<OfficeHomeScreen> createState() => _OfficeHomeScreenState();
}

class _OfficeHomeScreenState extends State<OfficeHomeScreen> {
  bool _marking = false;
  String _attendanceMsg = '';
  bool _attendanceSuccess = false;

  Future<void> _markAttendance() async {
    setState(() { _marking = true; _attendanceMsg = ''; });
    try {
      final res = await ApiService.markOfficeAttendance(
          widget.user.token, widget.user.name);
      if (mounted) {
        setState(() {
          _attendanceSuccess = res['success'] == true;
          _attendanceMsg = res['message'] ?? 'Done';
        });
      }
    } catch (e) {
      if (mounted) setState(() => _attendanceMsg = 'Error: Check server connection');
    } finally {
      if (mounted) setState(() => _marking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Office Staff'),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout, color: Colors.grey),
            onPressed: () async {
              await AuthService.logout();
              if (context.mounted) {
                Navigator.pushReplacement(context,
                    MaterialPageRoute(builder: (_) => const LoginScreen()));
              }
            },
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          children: [
            CustomCard(
              child: Row(
                children: [
                  CircleAvatar(
                    radius: 28,
                    backgroundColor: AppTheme.success.withOpacity(0.2),
                    child: Text(
                      widget.user.name.isNotEmpty
                          ? widget.user.name[0].toUpperCase() : 'O',
                      style: const TextStyle(
                          color: AppTheme.success, fontSize: 22,
                          fontWeight: FontWeight.bold),
                    ),
                  ),
                  const SizedBox(width: 16),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Welcome',
                          style: TextStyle(color: Colors.grey, fontSize: 13)),
                      Text(widget.user.name,
                          style: const TextStyle(color: Colors.white,
                              fontSize: 18, fontWeight: FontWeight.bold)),
                      const Text('Office Staff',
                          style: TextStyle(color: AppTheme.success, fontSize: 12)),
                    ],
                  ),
                ],
              ),
            ),
            CustomCard(
              child: Column(
                children: [
                  const Icon(Icons.how_to_reg, color: AppTheme.primary, size: 40),
                  const SizedBox(height: 12),
                  const Text('Attendance Mark karein',
                      style: TextStyle(color: Colors.white, fontSize: 16,
                          fontWeight: FontWeight.bold)),
                  if (_attendanceMsg.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Text(_attendanceMsg,
                        style: TextStyle(
                            color: _attendanceSuccess
                                ? AppTheme.success : AppTheme.error)),
                  ],
                  const SizedBox(height: 16),
                  LoadingButton(
                    isLoading: _marking,
                    text: 'Mark Attendance',
                    onPressed: _markAttendance,
                  ),
                ],
              ),
            ),
            _tile(context, Icons.history, AppTheme.success,
                'Attendance History', () => Navigator.push(context,
                    MaterialPageRoute(builder: (_) =>
                        AttendanceHistoryScreen(user: widget.user)))),
            _tile(context, Icons.beach_access, AppTheme.warning,
                'Apply Leave', () => Navigator.push(context,
                    MaterialPageRoute(builder: (_) =>
                        LeaveScreen(user: widget.user)))),
            _tile(context, Icons.more_time, Colors.teal,
                'Overtime Request', () => Navigator.push(context,
                    MaterialPageRoute(builder: (_) =>
                        OvertimeScreen(user: widget.user)))),
          ],
        ),
      ),
    );
  }

  Widget _tile(BuildContext context, IconData icon, Color color,
      String title, VoidCallback onTap) {
    return CustomCard(
      padding: EdgeInsets.zero,
      child: ListTile(
        onTap: onTap,
        leading: Container(
          width: 46, height: 46,
          decoration: BoxDecoration(
            color: color.withOpacity(0.15),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Icon(icon, color: color),
        ),
        title: Text(title,
            style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
        trailing: const Icon(Icons.arrow_forward_ios, color: Colors.grey, size: 14),
      ),
    );
  }
}
"""

files[
    "lib/screens/shared/leave_screen.dart"
] = """import 'package:flutter/material.dart';
import '../../models/user_model.dart';
import '../../services/api_service.dart';
import '../../utils/app_theme.dart';
import '../../widgets/common_widgets.dart';

class LeaveScreen extends StatefulWidget {
  final UserModel user;
  const LeaveScreen({super.key, required this.user});
  @override
  State<LeaveScreen> createState() => _LeaveScreenState();
}

class _LeaveScreenState extends State<LeaveScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabs;
  final _reasonCtrl = TextEditingController();
  String _leaveType = 'Annual Leave';
  DateTime? _startDate;
  DateTime? _endDate;
  bool _loading = false;
  String _msg = '';
  List<dynamic> _leaves = [];
  bool _loadingLeaves = true;

  final _leaveTypes = [
    'Annual Leave', 'Sick Leave', 'Casual Leave', 'Emergency Leave'
  ];

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 2, vsync: this);
    _loadLeaves();
  }

  Future<void> _loadLeaves() async {
    try {
      final data = await ApiService.getMyLeaves(widget.user.token);
      if (mounted) setState(() { _leaves = data; _loadingLeaves = false; });
    } catch (_) {
      if (mounted) setState(() => _loadingLeaves = false);
    }
  }

  Future<void> _apply() async {
    if (_startDate == null || _endDate == null || _reasonCtrl.text.isEmpty) {
      setState(() => _msg = 'Sab fields fill karein');
      return;
    }
    setState(() { _loading = true; _msg = ''; });
    try {
      final res = await ApiService.applyLeave(
        widget.user.token, _leaveType,
        _startDate!.toIso8601String().split('T')[0],
        _endDate!.toIso8601String().split('T')[0],
        _reasonCtrl.text,
      );
      if (mounted) {
        setState(() => _msg = res['message'] ?? 'Done');
        _loadLeaves();
      }
    } catch (_) {
      if (mounted) setState(() => _msg = 'Error aaya, dobara try karein');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _pickDate(bool isStart) async {
    final d = await showDatePicker(
      context: context,
      initialDate: DateTime.now(),
      firstDate: DateTime.now(),
      lastDate: DateTime.now().add(const Duration(days: 365)),
    );
    if (d != null) setState(() => isStart ? _startDate = d : _endDate = d);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Leave Management'),
        bottom: TabBar(
          controller: _tabs,
          indicatorColor: AppTheme.primary,
          tabs: const [Tab(text: 'Apply'), Tab(text: 'My Leaves')],
        ),
      ),
      body: TabBarView(
        controller: _tabs,
        children: [_buildApply(), _buildLeaves()],
      ),
    );
  }

  Widget _buildApply() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        children: [
          CustomCard(
            child: DropdownButtonFormField<String>(
              value: _leaveType,
              dropdownColor: AppTheme.card,
              style: const TextStyle(color: Colors.white),
              decoration: const InputDecoration(labelText: 'Leave Type'),
              items: _leaveTypes.map((t) =>
                  DropdownMenuItem(value: t, child: Text(t))).toList(),
              onChanged: (v) => setState(() => _leaveType = v!),
            ),
          ),
          Row(
            children: [
              Expanded(child: _dateTile('Start Date', _startDate, () => _pickDate(true))),
              const SizedBox(width: 12),
              Expanded(child: _dateTile('End Date', _endDate, () => _pickDate(false))),
            ],
          ),
          CustomCard(
            child: TextField(
              controller: _reasonCtrl,
              maxLines: 3,
              style: const TextStyle(color: Colors.white),
              decoration: const InputDecoration(
                  labelText: 'Reason', border: InputBorder.none),
            ),
          ),
          if (_msg.isNotEmpty)
            Text(_msg, style: const TextStyle(color: AppTheme.primary)),
          const SizedBox(height: 8),
          LoadingButton(isLoading: _loading, text: 'Apply Leave', onPressed: _apply),
        ],
      ),
    );
  }

  Widget _dateTile(String label, DateTime? date, VoidCallback onTap) {
    return CustomCard(
      child: InkWell(
        onTap: onTap,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: const TextStyle(color: Colors.grey, fontSize: 12)),
            const SizedBox(height: 4),
            Text(
              date != null ? '\${date.day}/\${date.month}/\${date.year}' : 'Select',
              style: const TextStyle(color: Colors.white),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildLeaves() {
    if (_loadingLeaves) {
      return const Center(child: CircularProgressIndicator(color: AppTheme.primary));
    }
    if (_leaves.isEmpty) {
      return const Center(
          child: Text('Koi leave nahi mili', style: TextStyle(color: Colors.grey)));
    }
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: _leaves.length,
      itemBuilder: (_, i) {
        final l = _leaves[i];
        return CustomCard(
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(l['leave_type'] ?? '',
                        style: const TextStyle(
                            color: Colors.white, fontWeight: FontWeight.w600)),
                    Text('\${l['start_date']} - \${l['end_date']}',
                        style: const TextStyle(color: Colors.grey, fontSize: 12)),
                    Text(l['reason'] ?? '',
                        style: const TextStyle(color: Colors.grey, fontSize: 12)),
                  ],
                ),
              ),
              StatusBadge(status: l['status'] ?? 'pending'),
            ],
          ),
        );
      },
    );
  }
}
"""

files[
    "lib/screens/shared/overtime_screen.dart"
] = """import 'package:flutter/material.dart';
import '../../models/user_model.dart';
import '../../services/api_service.dart';
import '../../utils/app_theme.dart';
import '../../widgets/common_widgets.dart';

class OvertimeScreen extends StatefulWidget {
  final UserModel user;
  const OvertimeScreen({super.key, required this.user});
  @override
  State<OvertimeScreen> createState() => _OvertimeScreenState();
}

class _OvertimeScreenState extends State<OvertimeScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabs;
  final _hoursCtrl = TextEditingController();
  final _reasonCtrl = TextEditingController();
  DateTime? _date;
  bool _loading = false;
  String _msg = '';
  List<dynamic> _records = [];

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 2, vsync: this);
    _loadOvertime();
  }

  Future<void> _loadOvertime() async {
    try {
      final data = await ApiService.getMyOvertime(widget.user.token);
      if (mounted) setState(() => _records = data);
    } catch (_) {}
  }

  Future<void> _submit() async {
    if (_date == null || _hoursCtrl.text.isEmpty || _reasonCtrl.text.isEmpty) {
      setState(() => _msg = 'Sab fields fill karein');
      return;
    }
    setState(() { _loading = true; _msg = ''; });
    try {
      final res = await ApiService.requestOvertime(
        widget.user.token,
        _date!.toIso8601String().split('T')[0],
        _hoursCtrl.text,
        _reasonCtrl.text,
      );
      if (mounted) {
        setState(() => _msg = res['message'] ?? 'Submitted');
        _loadOvertime();
      }
    } catch (_) {
      if (mounted) setState(() => _msg = 'Error aaya');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Overtime'),
        bottom: TabBar(
          controller: _tabs,
          indicatorColor: AppTheme.primary,
          tabs: const [Tab(text: 'Request'), Tab(text: 'History')],
        ),
      ),
      body: TabBarView(
        controller: _tabs,
        children: [_buildRequest(), _buildHistory()],
      ),
    );
  }

  Widget _buildRequest() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        children: [
          CustomCard(
            child: InkWell(
              onTap: () async {
                final d = await showDatePicker(
                  context: context,
                  initialDate: DateTime.now(),
                  firstDate: DateTime.now().subtract(const Duration(days: 30)),
                  lastDate: DateTime.now(),
                );
                if (d != null) setState(() => _date = d);
              },
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Row(
                  children: [
                    const Icon(Icons.calendar_today, color: Colors.grey),
                    const SizedBox(width: 12),
                    Text(
                      _date != null
                          ? '\${_date!.day}/\${_date!.month}/\${_date!.year}'
                          : 'Date select karein',
                      style: const TextStyle(color: Colors.white),
                    ),
                  ],
                ),
              ),
            ),
          ),
          CustomCard(
            child: TextField(
              controller: _hoursCtrl,
              keyboardType: TextInputType.number,
              style: const TextStyle(color: Colors.white),
              decoration: const InputDecoration(
                  labelText: 'Hours', border: InputBorder.none),
            ),
          ),
          CustomCard(
            child: TextField(
              controller: _reasonCtrl,
              maxLines: 3,
              style: const TextStyle(color: Colors.white),
              decoration: const InputDecoration(
                  labelText: 'Reason', border: InputBorder.none),
            ),
          ),
          if (_msg.isNotEmpty)
            Text(_msg, style: const TextStyle(color: AppTheme.primary)),
          const SizedBox(height: 8),
          LoadingButton(isLoading: _loading, text: 'Submit Request', onPressed: _submit),
        ],
      ),
    );
  }

  Widget _buildHistory() {
    if (_records.isEmpty) {
      return const Center(
          child: Text('Koi record nahi', style: TextStyle(color: Colors.grey)));
    }
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: _records.length,
      itemBuilder: (_, i) {
        final r = _records[i];
        return CustomCard(
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Date: \${r['date'] ?? ''}',
                        style: const TextStyle(color: Colors.white)),
                    Text('Hours: \${r['hours'] ?? ''}',
                        style: const TextStyle(color: Colors.grey, fontSize: 12)),
                    Text(r['reason'] ?? '',
                        style: const TextStyle(color: Colors.grey, fontSize: 12)),
                  ],
                ),
              ),
              StatusBadge(status: r['status'] ?? 'pending'),
            ],
          ),
        );
      },
    );
  }
}
"""

files[
    "lib/screens/shared/attendance_history_screen.dart"
] = """import 'package:flutter/material.dart';
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

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final data = widget.user.isFieldStaff
          ? await ApiService.getFieldAttendanceLogs(widget.user.token)
          : await ApiService.getOfficeAttendance(
              widget.user.token, widget.user.name);
      if (mounted) setState(() { _logs = data; _loading = false; });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Attendance History')),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AppTheme.primary))
          : _logs.isEmpty
              ? const Center(
                  child: Text('Koi record nahi mila',
                      style: TextStyle(color: Colors.grey)))
              : ListView.builder(
                  padding: const EdgeInsets.all(16),
                  itemCount: _logs.length,
                  itemBuilder: (_, i) {
                    final log = _logs[i];
                    return CustomCard(
                      child: Row(
                        children: [
                          Container(
                            width: 42, height: 42,
                            decoration: BoxDecoration(
                              color: AppTheme.primary.withOpacity(0.15),
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: const Icon(Icons.check_circle_outline,
                                color: AppTheme.primary),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(log['date'] ?? log['timestamp'] ?? 'N/A',
                                    style: const TextStyle(
                                        color: Colors.white,
                                        fontWeight: FontWeight.w600)),
                                Text(log['status'] ?? log['type'] ?? 'Present',
                                    style: const TextStyle(
                                        color: Colors.grey, fontSize: 12)),
                              ],
                            ),
                          ),
                          StatusBadge(status: log['status'] ?? 'present'),
                        ],
                      ),
                    );
                  },
                ),
    );
  }
}
"""

files[
    "pubspec.yaml"
] = """name: attendance_app
description: Attendance Management App

publish_to: 'none'
version: 1.0.0+1

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  http: ^1.1.0
  shared_preferences: ^2.2.2
  geolocator: ^10.1.0
  intl: ^0.18.1

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^3.0.0

flutter:
  uses-material-design: true
"""

# Create all files
for path, content in files.items():
    os.makedirs(os.path.dirname(path) if os.path.dirname(path) else ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"Created: {path}")

print("\nDone! All files created successfully.")
