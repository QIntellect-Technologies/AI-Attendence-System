import pytest

from support_db_staff import _coerce_staff_salary


@pytest.mark.parametrize("value", [-1, 0, 0.0000001, "not-a-number"])
def test_staff_salary_rejects_values_below_minimum_or_invalid(value):
    with pytest.raises(ValueError):
        _coerce_staff_salary(value)


def test_staff_salary_rejects_values_above_maximum():
    with pytest.raises(ValueError, match="cannot exceed"):
        _coerce_staff_salary(100_000_001)


def test_staff_salary_accepts_values_within_bounds():
    assert _coerce_staff_salary(1) == 1
    assert _coerce_staff_salary(100_000_000) == 100_000_000