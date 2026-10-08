DateTime leavePolicyDate(DateTime date) =>
    DateTime(date.year, date.month, date.day);

bool isLeaveDateRangeAllowed(
  DateTime start,
  DateTime end, {
  DateTime? now,
}) {
  final today = leavePolicyDate(now ?? DateTime.now());
  final latestAllowedDate = today.add(const Duration(days: 365));
  final normalizedStart = leavePolicyDate(start);
  final normalizedEnd = leavePolicyDate(end);

  return !normalizedStart.isBefore(today) &&
      !normalizedEnd.isBefore(normalizedStart) &&
      !normalizedEnd.isAfter(latestAllowedDate);
}