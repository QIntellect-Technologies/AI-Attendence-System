import pytest

from support_db_payroll import _validate_payroll_policy


def test_allowance_labels_must_be_unique_case_insensitively():
    with pytest.raises(ValueError, match="labels must be unique"):
        _validate_payroll_policy(
            {
                "allowanceTypes": {
                    "meal": {"label": "Meal", "mode": "fixed", "value": 100},
                    "meal_evening": {
                        "label": " meal ",
                        "mode": "fixed",
                        "value": 200,
                    },
                }
            }
        )


def test_distinct_allowance_labels_are_valid():
    _validate_payroll_policy(
        {
            "allowanceTypes": {
                "meal": {"label": "Meal", "mode": "fixed", "value": 100},
                "transport": {
                    "label": "Transport",
                    "mode": "fixed",
                    "value": 200,
                },
            }
        }
    )