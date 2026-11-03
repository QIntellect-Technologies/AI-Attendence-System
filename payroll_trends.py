"""Pure aggregation helpers for historical paid-payroll charts."""


def _text(value: object) -> str:
    return str(value or '').strip()


def _number(value: object, fallback: float = 0.0) -> float:
    try:
        return float(value if value is not None and value != '' else fallback)
    except (TypeError, ValueError):
        return fallback


def aggregate_paid_payroll_monthly_trends(
    payment_rows: list[dict],
    staff_rows: list[dict],
    *,
    month_keys: list[str],
    branch_id: str | None = None,
    people_type: str | None = None,
    department: str | None = None,
    search: str = '',
    amount_operator: str = 'all',
    amount_value: float | None = None,
) -> list[dict]:
    """Aggregate paid snapshot net pay by month and branch for payroll trends."""
    staff_by_id = {
        _text(row.get('id')): row
        for row in staff_rows
        if _text(row.get('id'))
    }
    month_set = set(month_keys)
    normalized_type = _text(people_type).lower()
    normalized_department = _text(department).casefold()
    normalized_search = _text(search).casefold()
    totals: dict[tuple[str, str], float] = {}

    for payment in payment_rows:
        month_key = _text(payment.get('period_start'))[:7]
        if month_key not in month_set:
            continue

        staff_id = _text(payment.get('staff_id'))
        staff = staff_by_id.get(staff_id, {})
        breakdown = payment.get('breakdown')
        if not isinstance(breakdown, dict):
            continue
        net_pay = _number(
            breakdown.get('net_pay', breakdown.get('netPay')),
            _number(breakdown.get('base_salary'))
            + _number(breakdown.get('total_additions'))
            - _number(breakdown.get('total_deductions')),
        )
        if net_pay < 0:
            continue

        current_branch_id = _text(staff.get('branch_id'))
        snapshot_branch_id = _text(
            breakdown.get('snapshot_branch_id')
            or breakdown.get('snapshotBranchId')
        )
        resolved_branch_id = snapshot_branch_id or current_branch_id
        if branch_id and resolved_branch_id != str(branch_id):
            continue
        if normalized_type and _text(
            staff.get('people_type') or staff.get('person_type')
        ).lower() != normalized_type:
            continue

        staff_department = _text(
            staff.get('department_name') or staff.get('department')
        ) or 'Unassigned'
        if normalized_department and staff_department.casefold() != normalized_department:
            continue

        if normalized_search:
            searchable = ' '.join(
                _text(staff.get(key))
                for key in (
                    'name', 'full_name', 'staff_name', 'person_code',
                    'employee_id', 'id', 'department', 'department_name',
                )
            ).casefold()
            if normalized_search not in searchable:
                continue

        if amount_value is not None:
            matches_amount = {
                'lt': net_pay < amount_value,
                'lte': net_pay <= amount_value,
                'eq': net_pay == amount_value,
                'gte': net_pay >= amount_value,
                'gt': net_pay > amount_value,
            }.get(amount_operator, True)
            if not matches_amount:
                continue

        resolved_branch_id = resolved_branch_id or 'unknown'
        key = (month_key, resolved_branch_id)
        totals[key] = totals.get(key, 0.0) + net_pay

    return [
        {
            'month': month_key,
            'branch_id': branch_key,
            'payroll': round(amount, 2),
        }
        for (month_key, branch_key), amount in sorted(totals.items())
    ]
