import 'package:flutter_test/flutter_test.dart';
import 'package:attendance_app/utils/attendance_summary.dart';

void main() {
  test('derives elapsed dates when API omits the optional elapsed list', () {
    final workingDays = AttendanceWorkingDays.fromResponse(
      {
        'working_dates': ['2026-10-07', '2026-10-08', '2026-10-09'],
        'join_date': '2026-10-07',
      },
      asOf: DateTime(2026, 10, 8),
    );

    expect(
        workingDays.scheduledDates, {'2026-10-07', '2026-10-08', '2026-10-09'});
    expect(workingDays.elapsedDates, {'2026-10-07', '2026-10-08'});
    expect(workingDays.joinDate, '2026-10-07');
  });

  test('counts attendance against configured working dates only', () {
    const configuredWorkDates = [
      '2026-10-01',
      '2026-10-02',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
    ];
    final summary = AttendanceSummary.fromLogs(
      [
        {'date': '2026-10-01', 'status': 'Present'},
        {
          'date': '2026-10-02',
          'status': 'Present',
          'checkInStatus': 'late',
        },
        {'date': '2026-10-05', 'status': 'Present', 'notes': 'Late check-in'},
        {'date': '2026-10-12', 'status': 'Present'},
      ],
      configuredWorkDates,
      elapsedWorkingDates: configuredWorkDates.take(6),
    );

    expect(summary.totalWorkingDays, 20);
    expect(summary.elapsedWorkingDays, 6);
    expect(summary.presentDays, 3);
    expect(summary.absentDays, 3);
    expect(summary.lateDays, 2);
  });
}
