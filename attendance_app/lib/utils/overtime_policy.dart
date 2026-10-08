DateTime overtimeClaimDate(DateTime now) =>
    DateTime(now.year, now.month, now.day);

bool isOvertimeClaimDateAllowed(DateTime date, {DateTime? now}) {
  final today = overtimeClaimDate(now ?? DateTime.now());
  final latestAllowedDate = today.add(const Duration(days: 365));
  final normalizedDate = overtimeClaimDate(date);
  return !normalizedDate.isBefore(today) &&
      !normalizedDate.isAfter(latestAllowedDate);
}
