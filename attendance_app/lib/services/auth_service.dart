import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/user_model.dart';
import 'api_service.dart';

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

  /// Logs the current user out. Revokes the session server-side first
  /// (session_registry.end_session, via ApiService.logout) so a lost or
  /// stolen phone's token dies immediately instead of staying valid for
  /// up to its full 30-day exp -- previously this only cleared local
  /// storage, so tapping "logout" never actually killed the token itself.
  /// The server call is best-effort (see ApiService.logout): local storage
  /// is cleared unconditionally below regardless of whether it succeeds.
  static Future<void> logout() async {
    final user = await getUser();
    if (user != null && user.token.isNotEmpty) {
      try {
        await ApiService.logout(user.token);
      } catch (_) {
        // Best-effort per the doc above -- a 401 here (token already
        // expired/invalidated, e.g. "logged in elsewhere") means the
        // session is already dead server-side, which is the outcome we
        // wanted anyway. A network failure means the same: nothing left
        // to revoke server-side right now. Either way, still clear local
        // storage below so the app actually logs out locally instead of
        // leaving the user stuck on a stale session because the server
        // call threw.
      }
    }
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_userKey);
  }
}