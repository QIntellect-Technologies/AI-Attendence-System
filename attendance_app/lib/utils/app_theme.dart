import 'package:flutter/material.dart';

/// Central theme definitions.
///
/// Usage convention:
///   - AppTheme.accent   -> icons, active tab/nav states, badges, avatar
///                          highlights, borders that need emphasis.
///   - AppTheme.primary  -> primary action BUTTONS specifically
///                          (ElevatedButton, "Login", "Mark Attendance", etc).
///   - AppTheme.card     -> container/card backgrounds (white).
///   - AppTheme.bg       -> page/scaffold background.
class AppTheme {
  // ── Raw palette ─────────────────────────────────────────────────────
  static const Color bgPage = Color(0xFFF5F6FA);
  static const Color textHeading = Color(0xFF1A699F);
  static const Color navy700 = Color(0xFF173F67);
  static const Color navy600 = Color(0xFF1F5B86);
  static const Color teal700 = Color(0xFF0F7E8B);
  static const Color teal600 = Color(0xFF118D97);
  static const Color teal500 = Color(0xFF2EA7B0);
  static const Color teal200 = Color(0xFFB9E2E7);
  static const Color teal100 = Color(0xFFE2F3F6);
  static const Color teal50 = Color(0xFFEEF9FB);
  static const Color slate300 = Color(0xFFC7D5DE);
  static const Color slate200 = Color(0xFFDBE7EF);
  static const Color slate100 = Color(0xFFEEF6FB);
  static const Color slate50 = Color(0xFFF5F9FB);
  static const Color borderColor = Color(0xFFD2DCE4);
  static const Color cardColor = Color(0xFFFFFFFF);
  static const Color bgAlt = Color(0xFFF8FBFC);
  static const Color headText = Color(0xFF102A3F);
  static const Color bodyText = Color(0xFF3F556C);
  static const Color mutedText = Color(0xFF6B7D8F);
  static const Color amber = Color(0xFFD97706);
  static const Color amberBg = Color(0xFFFEF3C7);
  static const Color amberBorder = Color(0xFFFDE68A);
  static const Color successColor = Color(0xFF118D97);
  static const Color successBg = Color(0xFFE2F3F6);

  static const List<Color> semiColors = [
    navy700, navy600, teal600, teal500, teal200,
    Color(0xFF64748B),
  ];

  // ── Role-based aliases (what screens should actually reference) ────
  static const Color accent = navy700;      // icons / active states / badges
  static const Color accentAlt = navy600;   // gradients' 2nd stop
  static const Color primary = teal600;     // BUTTONS
  static const Color primaryPressed = teal700;
  static const Color bg = bgPage;           // page background
  static const Color surface = cardColor;   // container/card background
  static const Color card = cardColor;
  static const Color success = successColor;
  static const Color warning = amber;
  static const Color error = Color(0xFFDC2626);
  static const Color onlineDot = successColor;

  static ThemeData get lightTheme => ThemeData(
        brightness: Brightness.light,
        scaffoldBackgroundColor: bgPage,
        primaryColor: teal600,
        colorScheme: const ColorScheme.light(
          primary: teal600,
          secondary: navy700,
          surface: cardColor,
          error: error,
        ),
        appBarTheme: const AppBarTheme(
          backgroundColor: cardColor,
          elevation: 0,
          centerTitle: true,
          foregroundColor: headText,
          iconTheme: IconThemeData(color: navy700),
          titleTextStyle: TextStyle(
              color: headText, fontSize: 18, fontWeight: FontWeight.bold),
        ),
        textTheme: const TextTheme(
          bodyLarge: TextStyle(color: bodyText),
          bodyMedium: TextStyle(color: bodyText),
          titleLarge: TextStyle(color: headText),
        ),
        elevatedButtonTheme: ElevatedButtonThemeData(
          style: ElevatedButton.styleFrom(
            backgroundColor: teal600,
            foregroundColor: Colors.white,
            padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 24),
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          ),
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: slate50,
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: borderColor),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: teal600, width: 1.5),
          ),
          labelStyle: const TextStyle(color: mutedText),
        ),
      );
}