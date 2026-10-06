from support_db_time_utils import count_unique_late_staff


def test_count_unique_late_staff_dedupes_and_ignores_blank():
    rows = [
        {'staff_id': 'a', 'check_in_status': 'Late'},
        {'staff_id': 'a', 'check_in_status': 'late'},
        {'staffId': 'b', 'checkInStatus': 'on_time'},
        {'staff_id': '', 'check_in_status': 'late'},
    ]
    assert count_unique_late_staff(rows) == 1