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


def test_income_tax_slabs_require_contiguous_limits():
    with pytest.raises(ValueError, match="lowerLimit must equal the previous slab"):
        _validate_payroll_policy(
            {
                "incomeTaxSlabs": [
                    {
                        "lowerLimit": 0,
                        "upperLimit": 600_000,
                        "baseTax": 0,
                        "rate": 0,
                    },
                    {
                        "lowerLimit": 500_000,
                        "upperLimit": None,
                        "baseTax": 0,
                        "rate": 1,
                    },
                ]
            }
        )


def test_income_tax_slabs_accept_a_terminal_unlimited_slab():
    _validate_payroll_policy(
        {
            "incomeTaxEnabled": True,
            "incomeTaxSlabs": [
                {
                    "lowerLimit": 0,
                    "upperLimit": 600_000,
                    "baseTax": 0,
                    "rate": 0,
                },
                {
                    "lowerLimit": 600_000,
                    "upperLimit": None,
                    "baseTax": 0,
                    "rate": 1,
                },
            ],
        }
    )
