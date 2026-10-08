class AppConfig {
  AppConfig._();
  static const String baseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'https://ai-attendence-system-production-4333.up.railway.app',
  );
}
