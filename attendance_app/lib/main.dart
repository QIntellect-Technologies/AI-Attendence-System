import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:toastification/toastification.dart';
import 'utils/app_theme.dart';
import 'services/api_service.dart';
import 'services/auth_service.dart';
import 'screens/auth/login_screen.dart';
import 'screens/field_staff/field_home_screen.dart';
import 'screens/office_staff/office_home_screen.dart';

/// Root navigator, so a forced logout can replace the entire stack with
/// LoginScreen from ApiService.onSessionInvalidated -- a plain static
/// callback with no BuildContext of its own (see api_service.dart).
final navigatorKey = GlobalKey<NavigatorState>();

/// Guards against a forced logout firing twice -- e.g. a screen's own
/// fetch and a background OfflineQueueService sync both 401ing within the
/// same moment would otherwise each try to push LoginScreen and show a
/// toast on top of each other.
bool _sessionInvalidationInFlight = false;

Future<void> _handleSessionInvalidated(String message) async {
  if (_sessionInvalidationInFlight) return;
  _sessionInvalidationInFlight = true;
  try {
    await AuthService.logout();
    await navigatorKey.currentState?.pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const LoginScreen()),
      (route) => false,
    );
    final context = navigatorKey.currentContext;
    if (context != null && context.mounted) {
      toastification.show(
        context: context,
        type: ToastificationType.error,
        style: ToastificationStyle.flatColored,
        title: Text(message),
        icon: const Icon(Icons.lock_outline),
        primaryColor: AppTheme.error,
        backgroundColor: AppTheme.cardColor,
        foregroundColor: AppTheme.headText,
        alignment: Alignment.topCenter,
        autoCloseDuration: const Duration(seconds: 5),
        borderRadius: BorderRadius.circular(12),
      );
    }
  } finally {
    _sessionInvalidationInFlight = false;
  }
}

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
  ApiService.onSessionInvalidated = _handleSessionInvalidated;
  runApp(const AttendanceApp());
}

class AttendanceApp extends StatelessWidget {
  const AttendanceApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      navigatorKey: navigatorKey,
      title: 'Attendance Pro',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.lightTheme,
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
