import 'package:flutter/material.dart';
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
      setState(() => _error = 'Email and Password fields cannot be empty.');
      return;
    }
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final res =
          await ApiService.login(_emailCtrl.text.trim(), _passCtrl.text);

      if (res['success'] != true) {
        setState(() => _error = res['message'] ?? 'Login failed');
        return;
      }

      final loginJson = Map<String, dynamic>.from(res['user'] ?? {});
      loginJson['token'] = res['token'] ?? '';
      var user = UserModel.fromJson(loginJson);

      // The login response is deliberately lean (see UserModel.accessModules
      // doc comment) — hydrate department/access_modules from /me before
      // navigating so the home screen never renders with stale/empty module
      // access. Non-fatal: if this fails, proceed with the lean profile
      // rather than blocking login entirely.
      try {
        final meRes = await ApiService.getMe(user.token);
        if (meRes['success'] == true && meRes['user'] is Map) {
          final profile = Map<String, dynamic>.from(meRes['user']);
          user = user.copyWith(
            name: profile['name'],
            department: profile['department'],
            accessModules: UserModel.fromJson(profile).accessModules,
            isFaceVerified: profile['is_face_verified'],
          );
        }
      } catch (_) {
        // Ignore — see comment above.
      }

      await AuthService.saveUser(user);
      if (!mounted) return;
      Navigator.pushReplacement(
          context,
          MaterialPageRoute(
            builder: (_) => user.isFieldStaff
                ? FieldHomeScreen(user: user)
                : OfficeHomeScreen(user: user),
          ));
    } catch (e) {
      setState(() => _error = e.toString());
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
                  width: 80,
                  height: 80,
                  decoration: BoxDecoration(
                    color: AppTheme.accent.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(
                        color: AppTheme.accent.withValues(alpha: 0.4), width: 1.5),
                  ),
                  child: const Icon(Icons.fingerprint,
                      color: AppTheme.accent, size: 44),
                ),
              ),
              const SizedBox(height: 32),
              const Text('Welcome Back',
                  style: TextStyle(
                      color: AppTheme.headText,
                      fontSize: 28,
                      fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              const Text('Please login to your account',
                  style: TextStyle(color: AppTheme.mutedText, fontSize: 14)),
              const SizedBox(height: 40),
              TextField(
                controller: _emailCtrl,
                keyboardType: TextInputType.emailAddress,
                style: const TextStyle(color: AppTheme.bodyText),
                decoration: const InputDecoration(
                  labelText: 'Email',
                  prefixIcon: Icon(Icons.email_outlined, color: AppTheme.mutedText),
                ),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _passCtrl,
                obscureText: _obscure,
                style: const TextStyle(color: AppTheme.bodyText),
                decoration: InputDecoration(
                  labelText: 'Password',
                  prefixIcon:
                      const Icon(Icons.lock_outline, color: AppTheme.mutedText),
                  suffixIcon: IconButton(
                    icon: Icon(
                        _obscure ? Icons.visibility_off : Icons.visibility,
                        color: AppTheme.mutedText),
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