import 'package:flutter_test/flutter_test.dart';
import 'package:attendance_app/utils/attendance_status.dart';

void main() {
  test('late check-in note overrides stale timing status', () {
    const notes = 'Check-in detected at 11:13, late — after shift start.';

    expect(resolveCheckInStatus('early', notes: notes), 'late');
    expect(checkInStatusLabel('on_time', notes: notes), 'LATE');
  });

  test('uses the timing status when notes do not specify it', () {
    expect(resolveCheckInStatus('late', notes: 'Attendance recorded.'), 'late');
    expect(checkInStatusLabel('early'), 'EARLY');
    expect(checkInStatusLabel('on_time'), 'ON TIME');
  });
}
