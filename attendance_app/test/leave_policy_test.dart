import 'package:flutter_test/flutter_test.dart';
import 'package:attendance_app/utils/leave_policy.dart';

void main() {
  final now = DateTime(2026, 8, 24, 15, 30);

  test('allows same-day leave within the allowed request window', () {
    expect(
      isLeaveDateRangeAllowed(
        DateTime(2026, 8, 24),
        DateTime(2026, 8, 25),
        now: now,
      ),
      isTrue,
    );
    expect(
      isLeaveDateRangeAllowed(
        DateTime(2026, 8, 24),
        DateTime(2026, 8, 24),
        now: now,
      ),
      isTrue,
    );
    expect(
      isLeaveDateRangeAllowed(
        DateTime(2026, 8, 25),
        DateTime(2026, 8, 24),
        now: now,
      ),
      isFalse,
    );
  });

  test('rejects ranges outside the sensible calendar window', () {
    expect(
      isLeaveDateRangeAllowed(
        DateTime(2026, 8, 23),
        DateTime(2026, 8, 25),
        now: now,
      ),
      isFalse,
    );
    expect(
      isLeaveDateRangeAllowed(
        DateTime(2026, 8, 24),
        DateTime(2027, 8, 25),
        now: now,
      ),
      isFalse,
    );
  });
}