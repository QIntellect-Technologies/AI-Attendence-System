import 'package:flutter_test/flutter_test.dart';
import 'package:attendance_app/utils/overtime_policy.dart';

void main() {
  final now = DateTime(2026, 8, 24, 15, 30);

  test('allows today and future dates within the request window', () {
    expect(isOvertimeClaimDateAllowed(DateTime(2026, 8, 24), now: now), isTrue);
    expect(isOvertimeClaimDateAllowed(DateTime(2026, 8, 25), now: now), isTrue);
    expect(isOvertimeClaimDateAllowed(DateTime(2026, 8, 23), now: now), isFalse);
    expect(isOvertimeClaimDateAllowed(DateTime(2027, 8, 25), now: now), isFalse);
  });

  test('normalizes the current time to its calendar date', () {
    expect(overtimeClaimDate(now), DateTime(2026, 8, 24));
  });
}
