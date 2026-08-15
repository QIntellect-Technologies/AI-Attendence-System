"""
seed_demo_org.py
──────────────────────────────────────────────────────────────────────────────
Seeds a fully isolated, INTERNALLY CONSISTENT demo organization into Supabase
for client demo videos and demo reports.

WHAT CHANGED VS THE PREVIOUS VERSION (read this first)
──────────────────────────────────────────────────────
The old script generated each module independently with its own random.seed():
attendance was random, leave was random, overtime was random, and payroll made
up `unpaid_days = random.choice([0,0,0,1])` and `late_count = randint(0,4)`
that matched nothing. Any client who cross-checked a payslip against the
attendance sheet would find the numbers unrelated.

This version inverts the flow. It builds ONE per-employee, per-day ledger
first, and then *derives* every downstream table from that single source of
truth:

    shifts ─┐
            ├─> day ledger (leave / holiday / worked / absent, per employee)
  holidays ─┘        │
                     ├─> attendance rows      (timestamps match the shift)
                     ├─> leave_requests       (approved leave => no attendance)
                     ├─> overtime_requests    (hours == measured OT in attendance)
                     └─> payroll_payments     (deductions == real unpaid days,
                                               OT pay == approved OT hours)

Concretely, the guarantees this script now enforces (and self-verifies -- see
verify_dataset() and the --verify flag):

  1. SHIFT <-> ATTENDANCE. Check-in/check-out are generated from the employee's
     OWN assigned shift. An 09:00-17:00 employee checks in ~09:00 and out
     ~17:00. "on_time" means within the shift's grace_minutes; "late" means
     past it. No employee ever has timestamps from a shift they aren't on.

  2. LEAVE <-> ATTENDANCE. An APPROVED full-day leave produces NO attendance
     row for that date -- you cannot be on approved leave and clocked in on
     the same day. A REJECTED or still-PENDING leave leaves attendance intact
     (the person worked), which is itself a nice thing to show on camera.
     An approved HALF-day leave produces a genuine half-length attendance row.

  3. LEAVE TYPES <-> QUOTA <-> PAID/UNPAID. Every leave type carries an annual
     quota and a paid/unpaid flag (LEAVE_POLICY below). Balances are tracked
     per employee as leave is approved. When an employee's paid balance for a
     type is exhausted, the request is issued as UNPAID leave instead -- which
     is exactly what then shows up as a payroll deduction. Remaining balances
     are written out so a "Leave Balance" report reconciles to the day count.

  4. ATTENDANCE <-> OVERTIME. Overtime requests are not invented. Each one is
     generated FROM an attendance row whose checkout ran past the shift end by
     >= OVERTIME_MIN_MINUTES, and its `hours` equals the measured overtime on
     that exact date. Only APPROVED overtime is paid; pending/rejected OT was
     worked but is not in the payslip (again, good to demo).

  5. PAYROLL IS COMPUTED, NOT FABRICATED. For each pay period, every payslip
     is arithmetic over that employee's real ledger:

        per_day_rate   = basic_salary / scheduled_working_days_in_period
        gross          = basic + allowances + overtime_pay
        overtime_pay   = approved_OT_hours * ot_rate   (ot_rate from salary_configs)
        deductions     = unpaid_leave_days * per_day_rate
                       + absent_days       * per_day_rate
                       + late_penalty      (policy: LATE_GRACE_PER_MONTH free,
                                            then LATE_PENALTY_DAY_FRACTION/day)
                       + provident_fund    (PF_RATE of basic)
                       + income_tax        (simplified salaried slabs)
        net_pay        = gross - deductions

     `unpaid_leave_days` and `late_count` on payroll_payments are the REAL
     counts from attendance, and the jsonb `breakdown` carries every input and
     every line item so a client can reconcile the payslip by hand.

  6. IT PROVES ITSELF. verify_dataset() re-derives payroll from the generated
     attendance / leave / overtime rows -- the same way a report query would --
     and asserts it matches the payroll rows to the paisa. The seed aborts
     before touching the database if any invariant fails, so you can never
     ship an inconsistent demo by accident.

USAGE
    Run from your backend project root (so `core.*` imports resolve):

        cd /path/to/backend
        pip install supabase python-dotenv bcrypt --break-system-packages

        python -m scripts.seed_demo_org --dry-run    # generate + verify, NO db
        python -m scripts.seed_demo_org              # cleanup old demo + seed
        python -m scripts.seed_demo_org --no-cleanup # seed without cleanup
        python -m scripts.seed_demo_org --cleanup <org_id>       # delete one
        python -m scripts.seed_demo_org --cleanup-all            # delete all demo orgs
        python -m scripts.seed_demo_org --verify <org_id>        # re-check a live org

    --dry-run needs no database and no .env at all. Always run it first.

    Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in your .env (service role
    key -- this bypasses RLS intentionally, like your other admin scripts).

SCOPE (per spec)
    - 1 organization ("school" vertical), 2 branches
    - 30 staff on Main Campus, 25 staff on City Campus (55 total)
    - 90 days of attendance, aligned back to a month boundary so pay periods
      are whole months (see ALIGN_WINDOW_TO_MONTH_START)
    - 3 finalized monthly payroll runs + 1 in-progress current month
    - Leave with quotas/balances, overtime tied to attendance, notifications,
      subscription + invoices, module entitlements, onboarding config

Everything is driven by the CONFIG block below -- change counts/dates/policy
there, not in the function bodies.
"""

from __future__ import annotations

import argparse
import calendar
import json
import random
import re
import sys
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

# Make `core.*` importable when this script is invoked directly rather than
# as `python -m`, without hardcoding an absolute path.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# ─────────────────────────────────────────────────────────────────────────
# CONFIG -- the only section you should need to touch for a different demo
# ─────────────────────────────────────────────────────────────────────────

ORG_NAME = "Greenwood Academy (Demo)"
DEMO_EMAIL_DOMAIN = "greenwood-demo.qintellect.io"
CONTACT_EMAIL = f"admin@{DEMO_EMAIL_DOMAIN}"

ATTENDANCE_DAYS_BACK = 90
# Payroll only makes sense over WHOLE months: a period that starts on the 13th
# would produce a half-month payslip and make the client think the maths is
# broken. So the 90-day window is extended backwards to the 1st of whatever
# month it lands in, which yields 3 complete pay periods + the current
# in-progress one. Set to False if you truly want exactly 90 days and are
# happy for the earliest month to be partial (it is then skipped for payroll).
ALIGN_WINDOW_TO_MONTH_START = True

WORKDAYS = {0, 1, 2, 3, 4}  # Mon-Fri; add 5 for a Sat half-day school week
TIMEZONE = "Asia/Karachi"
RNG_SEED = 42  # deterministic output -- rerun produces the same "story"

# Attendance timestamps are written as ISO strings with this UTC offset.
# 0 reproduces the previous script's behaviour (08:00 shift -> "08:00+00:00"),
# which is what your dashboard currently renders correctly. If you ever switch
# the UI to convert timestamptz into the org timezone for display, set this to
# 5 so the stored instant is a real Asia/Karachi 08:00 and still reads 08:00.
ATTENDANCE_TZ_OFFSET_HOURS = 0

BRANCHES = [
    {"name": "Main Campus", "location": "Gulberg, Lahore", "staff_count": 30},
    {"name": "City Campus", "location": "Model Town, Lahore", "staff_count": 25},
]

# (department name, code) -- becomes rows in BOTH `departments` (the real
# FK target for client_staff.department_id) and `client_departments`
# (a separate table some dashboard views still read from independently --
# see moduleAccess.ts's FIX #7 history for exactly this kind of drift).
DEPARTMENTS = [
    ("Teaching Staff", "TCH"),
    ("Administration", "ADM"),
    ("Finance", "FIN"),
    ("Examinations", "EXM"),
    ("IT & Systems", "ITS"),
    ("Front Desk", "FDK"),
]

# (role name, level, typical department) -- level is used for org-chart /
# manager_id assignment below (lower level = more senior).
ROLES = [
    ("Principal", 1, "Administration"),
    ("Vice Principal", 2, "Administration"),
    ("HR Administrator", 3, "Administration"),
    ("Senior Teacher", 3, "Teaching Staff"),
    ("Teacher", 4, "Teaching Staff"),
    ("Accountant", 3, "Finance"),
    ("Examination Officer", 3, "Examinations"),
    ("IT Support Officer", 4, "IT & Systems"),
    ("Front Desk Officer", 4, "Front Desk"),
]

MONTHLY_SALARY = {
    "Principal": 250000,
    "Vice Principal": 190000,
    "HR Administrator": 110000,
    "Senior Teacher": 95000,
    "Teacher": 65000,
    "Accountant": 85000,
    "Examination Officer": 70000,
    "IT Support Officer": 75000,
    "Front Desk Officer": 45000,
}

MODULES = ["attendance", "employees", "leave", "payroll", "overtime", "reports"]

# ── Shifts ───────────────────────────────────────────────────────────────
# check_in_time / check_out_time here are the ONLY source of truth for what
# an "on time" attendance row looks like. grace_minutes decides on_time vs
# late; checkout past check_out_time + OVERTIME_MIN_MINUTES becomes overtime.
SHIFT_TEMPLATES = [
    {
        "name": "Morning Shift",
        "check_in_time": "09:00:00",
        "check_out_time": "17:00:00",
        "grace_minutes": 10,
        "checkout_grace_minutes": 15,
    },
    {
        "name": "Evening Shift",
        "check_in_time": "13:00:00",
        "check_out_time": "21:00:00",
        "grace_minutes": 10,
        "checkout_grace_minutes": 15,
    },
]

# ── Leave policy: type -> paid/unpaid + annual quota (days) ──────────────
# `paid=False` types are the ones that actually cut the payslip. Quotas are
# per calendar year and are consumed only when a request is APPROVED. When a
# paid type has no balance left, the request is re-issued as "Leave Without
# Pay", which is how unpaid days -- and therefore payroll deductions -- come
# to exist in this dataset. Nothing is deducted at random.
LEAVE_POLICY: dict[str, dict[str, Any]] = {
    "Annual":              {"code": "AL", "paid": True,  "annual_quota": 14, "weight": 26},
    "Casual":              {"code": "CL", "paid": True,  "annual_quota": 10, "weight": 24},
    "Sick":                {"code": "SL", "paid": True,  "annual_quota": 8,  "weight": 22},
    "Emergency":           {"code": "EL", "paid": True,  "annual_quota": 3,  "weight": 10},
    "Compensatory":        {"code": "CO", "paid": True,  "annual_quota": 5,  "weight": 8},
    "Leave Without Pay":   {"code": "LWP", "paid": False, "annual_quota": 0,  "weight": 10},
}
UNPAID_LEAVE_TYPE = "Leave Without Pay"

# How much of each employee's annual quota is already spent BEFORE the seeded
# window opens (they didn't join the company on day one of this demo). Stored
# explicitly on the balance record so remaining = quota - opening_used - used.
OPENING_USED_FRACTION = (0.30, 0.85)  # random per employee per type, of quota
# Chance a request is filed as unpaid leave outright (employee knows they have
# no balance, or wants to keep their annual days). Unpaid leave otherwise only
# appears when a paid quota runs out, which on a 3-month window is too rare to
# demo the payroll deduction path reliably.
DIRECT_UNPAID_CHANCE = 0.12

# ── Payroll policy ───────────────────────────────────────────────────────
ALLOWANCE_RATES = {"medical_allowance": 0.05, "transport_allowance": 0.05}  # of basic
PF_RATE = 0.05                    # provident fund, employee contribution, of basic
OT_MULTIPLIER = 1.5               # overtime is 1.5x the normal hourly rate
STANDARD_DAYS_PER_MONTH = 26      # divisor used for the stored ot_rate
STANDARD_HOURS_PER_DAY = 8
LATE_GRACE_PER_MONTH = 2          # free lates per employee per month
LATE_PENALTY_DAY_FRACTION = 0.25  # each late beyond the grace costs 1/4 day
OVERTIME_MIN_MINUTES = 60         # shorter overruns are not payable overtime
# Latest permissible checkout, as minutes past midnight. Overtime is clamped to
# this so no attendance row ever spans midnight -- a checkout on the following
# calendar day would make check_out < check_in for every naive reader.
LATEST_CHECKOUT_MINUTE = 23 * 60 + 30
ENABLE_INCOME_TAX = True
# payroll_payments rows are only written for FINALIZED (paid) periods. The
# current month is still generated and verified -- it appears in the summary
# JSON and in the console table -- but it is not inserted, because a row with
# paid_at = NULL reads as a real payslip that nobody has been paid for. Flip to
# True if the dashboard has an explicit "in progress" payroll view to show it in.
SEED_IN_PROGRESS_PAYROLL = False
# A fraction of finalized payroll rows to leave unpaid in the demo so the
# dashboard shows both Paid and Pending payroll statuses.
PAYROLL_PENDING_FRACTION = 0.2

# Simplified salaried income-tax slabs (annual taxable, PKR). Illustrative for
# a demo -- swap in the client's real slabs if they ask. Format:
# (upper_bound_exclusive, fixed_amount_at_lower_bound, rate_on_excess, lower_bound)
INCOME_TAX_SLABS = [
    (600_000,    0,       0.00, 0),
    (1_200_000,  0,       0.01, 600_000),
    (2_200_000,  6_000,   0.11, 1_200_000),
    (3_200_000,  116_000, 0.23, 2_200_000),
    (4_100_000,  346_000, 0.30, 3_200_000),
    (float("inf"), 616_000, 0.35, 4_100_000),
]

# ── Public holidays (paid, non-working, no attendance expected) ──────────
# (month, day, name). Only the ones falling inside the seeded window are used.
PUBLIC_HOLIDAYS = [
    (2, 5, "Kashmir Day"),
    (3, 23, "Pakistan Day"),
    (5, 1, "Labour Day"),
    (8, 14, "Independence Day"),
    (11, 9, "Iqbal Day"),
    (12, 25, "Quaid-e-Azam Day"),
]

# ── Day-level behaviour weights for a normal (non-leave, non-holiday) day ─
# These must sum to 1.0. "absent" produces NO attendance row and is treated as
# unauthorised absence -> full day deduction in payroll.
DAY_WEIGHTS = [
    ("on_time",          0.810),
    ("late",             0.090),
    ("early_leave",      0.030),
    ("overtime",         0.040),
    ("absent",           0.020),
    ("missing_checkout", 0.010),
]
# Today skews healthy so a live "Present Today" widget looks good on camera.
TODAY_WEIGHTS = [
    ("on_time",          0.870),
    ("late",             0.060),
    ("early_leave",      0.020),
    ("overtime",         0.030),
    ("absent",           0.015),
    ("missing_checkout", 0.005),
]

LEAVE_EPISODES_PER_EMPLOYEE = ([2, 3, 4, 5, 6], [14, 28, 28, 18, 12])  # values, weights
HALF_DAY_CHANCE = 0.15
OVERTIME_REQUEST_STATUS = (["approved", "pending", "rejected"], [75, 15, 10])

FIRST_NAMES = [
    "Ahmed", "Ayesha", "Bilal", "Sana", "Usman", "Hira", "Zainab", "Hassan",
    "Fatima", "Ali", "Mariam", "Omar", "Sara", "Hamza", "Nida", "Faisal",
    "Amna", "Tariq", "Rabia", "Adeel", "Sadia", "Imran", "Noor", "Kamran",
    "Sidra", "Waqas", "Iqra", "Salman", "Mehwish", "Asad", "Farah", "Junaid",
    "Rida", "Shahzad", "Aisha", "Naveed", "Sobia", "Kashif", "Anum", "Zeeshan",
    "Danish", "Areeba", "Talha", "Maha", "Umair", "Laiba", "Saad", "Hafsa",
    "Bilquis", "Arsalan",
]
LAST_NAMES = [
    "Khan", "Ahmed", "Malik", "Butt", "Sheikh", "Raza", "Iqbal", "Hussain",
    "Farooq", "Chaudhry", "Aslam", "Javed", "Qureshi", "Siddiqui", "Abbasi",
    "Nawaz", "Mehmood", "Rashid", "Younis", "Zafar",
]

DEMO_MARKER = "qintellect_demo_seed"  # stored in metadata for safe cleanup filtering

# Login password for BOTH demo client_users accounts (principal + hr).
# Hashed at seed time with bcrypt.gensalt(12), matching
# support_db_client_users.py's _hash_password exactly, so
# authenticate_client_user() verifies it correctly out of the box.
DEMO_LOGIN_PASSWORD = "Demo@2026!"


# ─────────────────────────────────────────────────────────────────────────
# Small shared helpers
# ─────────────────────────────────────────────────────────────────────────

def new_id() -> str:
    return str(uuid.uuid4())


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def days_ago(n: int) -> date:
    return date.today() - timedelta(days=n)


def money(x: float) -> float:
    """One rounding rule for the whole script. Every payslip line item is
    rounded at the point it is produced, and totals are summed from the
    ROUNDED components -- so `sum(parts) == total` exactly, which is what a
    client checking a payslip with a calculator will do."""
    return round(x + 1e-9, 2)


def is_weekday(d: date) -> bool:
    return d.weekday() in WORKDAYS


def month_bounds(year: int, month: int) -> tuple[date, date]:
    return date(year, month, 1), date(year, month, calendar.monthrange(year, month)[1])


def daterange(start: date, end: date) -> Iterable[date]:
    cur = start
    while cur <= end:
        yield cur
        cur += timedelta(days=1)


def iso_ts(d: date, t: time, extra_minutes: int = 0) -> str:
    """Builds an ISO-8601 timestamp for an attendance event, applying
    ATTENDANCE_TZ_OFFSET_HOURS so every timestamp in the dataset uses one
    consistent offset."""
    tz = timezone(timedelta(hours=ATTENDANCE_TZ_OFFSET_HOURS))
    dt = datetime.combine(d, t, tzinfo=tz) + timedelta(minutes=extra_minutes)
    return dt.isoformat()


def minutes_between(t1: time, t2: time) -> int:
    return (t2.hour * 60 + t2.minute) - (t1.hour * 60 + t1.minute)


def annual_income_tax(annual_taxable: float) -> float:
    if not ENABLE_INCOME_TAX:
        return 0.0
    for upper, fixed, rate, lower in INCOME_TAX_SLABS:
        if annual_taxable <= upper:
            return fixed + (annual_taxable - lower) * rate
    return 0.0


def weighted_pick(rng: random.Random, pairs: list[tuple[str, float]]) -> str:
    return rng.choices([p for p, _ in pairs], weights=[w for _, w in pairs])[0]


# ─────────────────────────────────────────────────────────────────────────
# Window / calendar
# ─────────────────────────────────────────────────────────────────────────

def compute_window() -> tuple[date, date]:
    today = date.today()
    start = today - timedelta(days=ATTENDANCE_DAYS_BACK - 1)
    if ALIGN_WINDOW_TO_MONTH_START:
        start = start.replace(day=1)
    return start, today


def build_holidays(start: date, end: date) -> dict[date, str]:
    """Public holidays inside the window that fall on a scheduled workday.
    A holiday on a weekend is not interesting for attendance or payroll."""
    out: dict[date, str] = {}
    for year in range(start.year, end.year + 1):
        for month, day, name in PUBLIC_HOLIDAYS:
            try:
                d = date(year, month, day)
            except ValueError:
                continue
            if start <= d <= end and is_weekday(d):
                out[d] = name
    return out


# ─────────────────────────────────────────────────────────────────────────
# The day ledger -- the single source of truth everything else derives from
# ─────────────────────────────────────────────────────────────────────────

@dataclass
class DayRecord:
    """One employee, one calendar day. `category` is mutually exclusive and
    drives BOTH what attendance row (if any) exists AND how payroll treats
    the day, which is precisely why the two can never disagree."""
    day: date
    category: str          # weekend | holiday | leave_paid | leave_unpaid | absent | worked
    day_status: str | None = None   # worked days: present|late|short_leave|half_day|overtime
    leave_type: str | None = None
    is_half_day: bool = False
    check_in: time | None = None
    check_out: time | None = None
    late_minutes: int = 0
    early_minutes: int = 0
    overtime_minutes: int = 0
    work_minutes: int = 0
    has_checkout: bool = True
    holiday_name: str | None = None

    @property
    def is_scheduled_workday(self) -> bool:
        """Days the employee was expected to work. This is the denominator for
        the per-day salary rate -- weekends and paid public holidays are NOT
        in it, so a holiday never dilutes anyone's daily rate."""
        return self.category not in {"weekend", "holiday"}

    @property
    def unpaid_units(self) -> float:
        """Days (or half-days) of pay lost. The ONLY source of salary
        deduction days in this dataset."""
        if self.category == "absent":
            return 1.0
        if self.category == "leave_unpaid":
            return 0.5 if self.is_half_day else 1.0
        return 0.0


@dataclass
class LeaveEpisode:
    staff_id: str
    leave_type: str
    paid: bool
    start: date
    end: date
    workdays: list[date]
    status: str            # approved | pending | rejected
    is_half_day: bool
    half_day_period: str | None
    reason: str
    fallback_from: str | None = None  # set when quota ran out and it became LWP


@dataclass
class Dataset:
    """Everything the seed produces, generated and validated in memory before
    a single row is sent to Supabase."""
    org_id: str
    window_start: date
    window_end: date
    holidays: dict[date, str] = field(default_factory=dict)
    org_row: dict = field(default_factory=dict)
    branches: list[dict] = field(default_factory=list)
    shifts: list[dict] = field(default_factory=list)
    departments: list[dict] = field(default_factory=list)
    client_departments: list[dict] = field(default_factory=list)
    roles: list[dict] = field(default_factory=list)
    modules: list[dict] = field(default_factory=list)
    subscription: dict = field(default_factory=dict)
    invoices: list[dict] = field(default_factory=list)
    users: list[dict] = field(default_factory=list)
    staff: list[dict] = field(default_factory=list)
    salary_configs: list[dict] = field(default_factory=list)
    attendance: list[dict] = field(default_factory=list)
    leave_requests: list[dict] = field(default_factory=list)
    leave_balances: list[dict] = field(default_factory=list)
    overtime_requests: list[dict] = field(default_factory=list)
    payroll: list[dict] = field(default_factory=list)
    notifications: list[dict] = field(default_factory=list)
    onboarding: dict = field(default_factory=dict)
    ledger: dict[str, dict[date, DayRecord]] = field(default_factory=dict)
    periods: list[tuple[date, date, bool]] = field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────
# Structural builders (org, branches, shifts, departments, roles, billing)
# ─────────────────────────────────────────────────────────────────────────

def _vertical_config() -> dict:
    """Imported lazily so --dry-run works outside the backend project. Falls
    back to an inline equivalent of the school template if core.* isn't on the
    path -- the fallback is ONLY used in dry-run, never when seeding for real
    (seed() imports the real one up front and fails loudly if it's missing)."""
    try:
        from core.vertical_templates import build_vertical_config  # noqa: PLC0415
        return build_vertical_config("school", attendance_people_types=["staff"])
    except Exception:
        return {
            "primary_people_type": "student",
            "enabled_people_types": ["student", "staff"],
            "attendance_people_types": ["staff"],
            "labels": {"staff": "Staff", "student": "Student"},
            "_fallback": True,
        }


def build_org(ds: Dataset) -> None:
    vc = _vertical_config()
    ds.org_row = {
        "id": ds.org_id,
        "name": ORG_NAME,
        "contact_email": CONTACT_EMAIL,
        "contact_phone": "+92-300-1234567",
        "org_type": "school",
        "business_type": "school",
        "biz_type": "school",
        "primary_people_type": vc["primary_people_type"],
        "enabled_people_types": vc["enabled_people_types"],
        "attendance_people_types": vc["attendance_people_types"],
        "vertical_config": vc,
        "people_kind": "staff",
        "terminology_overrides": {},
        "enabled_staff_types": ["office"],
        "attendance_mode": "cloud",
        "node_offline_threshold_seconds": 300,
        "max_branches": 5,
        "employee_retention_years": 5,
        "organization_retention_years": 5,
        "sync_time": "02:00:00",
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }


def build_branches(ds: Dataset) -> None:
    for b in BRANCHES:
        ds.branches.append({
            "id": new_id(),
            "org_id": ds.org_id,
            "name": b["name"],
            "location": b["location"],
            "max_staff_capacity": max(100, b["staff_count"] * 2),
            "fallback_active": False,
            "shift_enabled_people_types": ["staff"],
            "timezone": TIMEZONE,
            "created_at": now_iso(),
            "updated_at": now_iso(),
            "_staff_count": b["staff_count"],  # stripped before insert
        })


def build_shifts(ds: Dataset) -> dict[str, list[dict]]:
    """Two shifts per branch (a morning teaching-day shift covering most
    staff, and an evening shift for front desk / support coverage), so the
    dashboard's shift distribution widget shows more than one card."""
    by_branch: dict[str, list[dict]] = {}
    for branch in ds.branches:
        rows = []
        for tpl in SHIFT_TEMPLATES:
            shift = {
                "id": new_id(),
                "org_id": ds.org_id,
                "branch_id": branch["id"],
                "people_type": "staff",
                "name": tpl["name"],
                "check_in_time": tpl["check_in_time"],
                "grace_minutes": tpl["grace_minutes"],
                "check_out_time": tpl["check_out_time"],
                "checkout_grace_minutes": tpl["checkout_grace_minutes"],
                "sync_delay_minutes": 5,
                "is_active": True,
                "created_at": now_iso(),
                "updated_at": now_iso(),
            }
            rows.append(shift)
            ds.shifts.append(shift)
        by_branch[branch["id"]] = rows
    return by_branch


def build_departments(ds: Dataset) -> dict[tuple[str, str], dict]:
    """Populates BOTH the real FK target (`departments`) and the parallel
    `client_departments` table some views read independently."""
    lookup: dict[tuple[str, str], dict] = {}
    for branch in ds.branches:
        for name, code in DEPARTMENTS:
            dept_id = new_id()
            ds.departments.append({
                "id": dept_id, "org_id": ds.org_id, "branch_id": branch["id"],
                "name": name, "code": code, "status": "active",
                "created_at": now_iso(), "updated_at": now_iso(),
            })
            ds.client_departments.append({
                "id": new_id(), "org_id": ds.org_id, "branch_id": branch["id"],
                "name": name, "is_active": True,
                "created_at": now_iso(), "updated_at": now_iso(),
            })
            lookup[(branch["id"], name)] = {"id": dept_id, "name": name}
    return lookup


def build_roles(ds: Dataset) -> None:
    for branch in ds.branches:
        for name, level, _dept in ROLES:
            ds.roles.append({
                "id": new_id(), "org_id": ds.org_id, "branch_id": branch["id"],
                "name": name, "level": level, "is_active": True,
                "created_at": now_iso(), "updated_at": now_iso(),
            })


def build_billing(ds: Dataset) -> None:
    for name in MODULES:
        ds.modules.append({
            "id": new_id(), "org_id": ds.org_id, "module_name": name,
            "status": "active", "purchased_at": now_iso(),
        })

    ds.subscription = {
        "id": new_id(),
        "org_id": ds.org_id,
        "billing_cycle": "annually",
        "current_period_start": days_ago(40).isoformat(),
        "current_period_end": (days_ago(40) + timedelta(days=365)).isoformat(),
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }

    for i, (due_offset, status) in enumerate([(400, "paid"), (40, "paid"), (-20, "pending")]):
        due = days_ago(due_offset)
        ds.invoices.append({
            "id": new_id(), "org_id": ds.org_id, "amount": 85000,
            "due_date": due.isoformat(), "grace_period_days": 7, "status": status,
            "paid_at": (due + timedelta(days=2)).isoformat() if status == "paid" else None,
            "invoice_number": f"INV-DEMO-{i + 1:04d}",
            "created_at": now_iso(), "updated_at": now_iso(),
        })


def build_users(ds: Dataset, hash_fn) -> dict[str, str]:
    admin_id, manager_id = new_id(), new_id()
    pw = hash_fn(DEMO_LOGIN_PASSWORD)
    ds.users = [
        {
            "id": admin_id, "org_id": ds.org_id,
            "email": f"principal@{DEMO_EMAIL_DOMAIN}", "password_hash": pw,
            "full_name": "Dr. Farrukh Zaman", "role": "admin", "is_active": True,
            "must_change_password": False, "password_changed_at": now_iso(),
            # requires_onboarding is driven off THIS column on client_users, not
            # off client_onboarding_configs.completed_at -- leaving it NULL is
            # what sent every seeded login to the setup page.
            "onboarding_completed_at": now_iso(),
            "created_at": now_iso(), "updated_at": now_iso(),
        },
        {
            "id": manager_id, "org_id": ds.org_id,
            "email": f"hr@{DEMO_EMAIL_DOMAIN}", "password_hash": pw,
            "full_name": "Ayesha Malik", "role": "hr", "is_active": True,
            "must_change_password": False, "password_changed_at": now_iso(),
            "onboarding_completed_at": now_iso(),
            "created_at": now_iso(), "updated_at": now_iso(),
        },
    ]
    return {"admin": admin_id, "hr": manager_id}


# ─────────────────────────────────────────────────────────────────────────
# Staff -- 30 on Main Campus, 25 on City Campus, per BRANCHES[*].staff_count
# ─────────────────────────────────────────────────────────────────────────

def _role_plan(count: int, rng: random.Random, is_head_office: bool) -> list[tuple[str, str]]:
    """Realistic role mix for one campus, scaled to that campus's headcount.
    The Principal exists once, at the main campus only; every campus has a
    Vice Principal who acts as the manager_id target for team scoping."""
    pool = (
        [("Teacher", "Teaching Staff")] * 20
        + [("Senior Teacher", "Teaching Staff")] * 5
        + [("HR Administrator", "Administration")] * 2
        + [("Accountant", "Finance")] * 2
        + [("Examination Officer", "Examinations")] * 2
        + [("IT Support Officer", "IT & Systems")] * 2
        + [("Front Desk Officer", "Front Desk")] * 3
    )
    leadership = [("Vice Principal", "Administration")]
    if is_head_office:
        leadership.insert(0, ("Principal", "Administration"))

    plan = list(leadership)
    while len(plan) < count:
        plan.append(rng.choice(pool))
    plan = plan[:count]
    # Leadership must be created first so their ids exist for manager_id.
    rest = plan[len(leadership):]
    rng.shuffle(rest)
    return list(leadership) + rest


def build_staff(
    ds: Dataset, shifts_by_branch: dict[str, list[dict]],
    departments: dict[tuple[str, str], dict],
) -> None:
    """
    people_type is deliberately "staff", not "teacher": the school template in
    vertical_templates.py only enables ["student", "staff"] --
    normalize_people_type() would silently collapse anything else back to
    "student". "Teacher" vs "Accountant" is expressed at the
    department/role_name/position level instead, which is free text.

    Join dates are all comfortably BEFORE the seeded window opens. That is
    deliberate: a mid-window joiner would need a pro-rated first payslip, and
    a pro-rated payslip in a demo looks like a bug even when it's correct.
    """
    rng = random.Random(RNG_SEED)
    seq = 0
    used_codes: set[str] = set()

    for b_index, branch in enumerate(ds.branches):
        plan = _role_plan(branch["_staff_count"], rng, is_head_office=(b_index == 0))
        branch_shifts = shifts_by_branch[branch["id"]]
        morning, evening = branch_shifts[0], branch_shifts[1]
        managers: dict[str, str] = {}

        for role_name, dept_name in plan:
            seq += 1
            dept = departments[(branch["id"], dept_name)]

            # Front desk needs evening coverage more than any other role;
            # everyone else is overwhelmingly on the morning teaching-day
            # shift, with a small realistic evening minority so both shift
            # cards on the dashboard actually have staff on them.
            evening_odds = 0.5 if role_name == "Front Desk Officer" else 0.12
            shift = evening if rng.random() < evening_odds else morning

            first, last = rng.choice(FIRST_NAMES), rng.choice(LAST_NAMES)
            prefix = {"Principal": "PRN", "Vice Principal": "VPR"}.get(role_name, "STF")
            code = f"{prefix}-{seq:03d}"
            while code in used_codes:
                code = f"{prefix}-{seq:03d}-{rng.randint(1, 99)}"
            used_codes.add(code)

            # Everyone joined at least 45 days before the window opened.
            earliest_join = ds.window_start - timedelta(days=45)
            join_date = earliest_join - timedelta(days=rng.randint(0, 1200))

            salary = MONTHLY_SALARY[role_name]
            is_manager = role_name in {"Principal", "Vice Principal"}
            access_modules = (
                MODULES if role_name in {"Principal", "Vice Principal", "HR Administrator"}
                else ["attendance", "leave"]
            )

            staff_id = new_id()
            ds.staff.append({
                "id": staff_id,
                "org_id": ds.org_id,
                "branch_id": branch["id"],
                "employee_id": code,
                "name": f"{first} {last}",
                "email": f"{first.lower()}.{last.lower()}{seq}@{DEMO_EMAIL_DOMAIN}",
                "phone": f"+9230{rng.randint(10000000, 99999999)}",
                "role": "staff",
                "department_name": dept_name,
                "role_name": role_name,
                "position": role_name,
                "status": "active",
                "is_archived": False,
                "salary": salary,
                "benefits": {
                    "medical_insurance": True,
                    "annual_bonus": role_name != "Front Desk Officer",
                },
                "join_date": join_date.isoformat(),
                "staff_type": "office",
                "access_modules": access_modules,
                "shift_id": shift["id"],
                "shift_label": shift["name"],
                "duty_start": shift["check_in_time"],
                "duty_end": shift["check_out_time"],
                "attendance_enabled": True,
                "is_face_verified": True,
                "face_training_status": "trained",
                "face_trained_at": (join_date + timedelta(days=1)).isoformat(),
                "created_at": join_date.isoformat(),
                "updated_at": now_iso(),
                "department_id": dept["id"],
                "people_type": "staff",
                "person_code": code,
                "person_code_label": "Staff ID",
                "shift_id_ref": shift["id"],
                "dashboard_scope": "team" if is_manager else "branch",
                "manager_id": managers.get(dept_name) or managers.get("__campus__"),
                # ── private, stripped before insert ──
                "_shift": shift,
                "_branch_name": branch["name"],
            })

            if is_manager:
                managers.setdefault("__campus__", staff_id)
                managers[dept_name] = staff_id


def build_salary_configs(ds: Dataset) -> None:
    """The ot_rate written here is the SAME number payroll multiplies approved
    overtime hours by -- payroll reads it back off the staff dict rather than
    recomputing it, so the two can never drift apart."""
    for s in ds.staff:
        basic = s["salary"]
        ot_rate = money(basic / STANDARD_DAYS_PER_MONTH / STANDARD_HOURS_PER_DAY * OT_MULTIPLIER)
        allowances = money(sum(basic * r for r in ALLOWANCE_RATES.values()))
        pf = money(basic * PF_RATE)
        s["_ot_rate"] = ot_rate
        s["_allowances"] = allowances
        s["_pf"] = pf
        ds.salary_configs.append({
            "id": new_id(),
            "organization_id": ds.org_id,
            "staff_id": s["id"],
            "branch_id": s["branch_id"],
            "staff_name": s["name"],
            "department": s["department_name"],
            "branch_name": s["_branch_name"],
            "basic_salary": basic,
            "allowances": allowances,
            "deductions": pf,          # standing monthly deduction = provident fund
            "ot_rate": ot_rate,
            "effective_from": s["join_date"],
            "created_at": s["created_at"],
            "updated_at": now_iso(),
        })


# ─────────────────────────────────────────────────────────────────────────
# THE LEDGER -- leave first, then attendance fills the gaps around it
# ─────────────────────────────────────────────────────────────────────────

def _next_workdays(start: date, count: int, end_limit: date, holidays: dict[date, str]) -> list[date]:
    """A 3-day leave means 3 WORKING days -- it steps over weekends and public
    holidays rather than burning quota on days nobody works anyway."""
    out: list[date] = []
    cur = start
    guard = 0
    while len(out) < count and cur <= end_limit and guard < 60:
        if is_weekday(cur) and cur not in holidays:
            out.append(cur)
        cur += timedelta(days=1)
        guard += 1
    return out


def build_leave(ds: Dataset) -> dict[str, dict[str, dict[str, float]]]:
    """
    Generates leave episodes per employee, consuming a real per-type balance.

    Balance rule: quota is annual; OPENING_USED_FRACTION of it is treated as
    already spent before the window opened. A request is only allowed against
    a paid type if the remaining balance covers the whole episode. If it
    doesn't, the SAME episode is re-issued as unpaid "Leave Without Pay" (with
    a reason saying so) -- which is the only way unpaid days enter this
    dataset, and therefore the only source of leave-driven payroll deductions.

    Only APPROVED leave consumes balance and blocks attendance. Pending and
    rejected requests leave the ledger untouched: those employees worked that
    day and have the attendance rows to prove it.

    Returns balances as {staff_id: {leave_type: {quota, opening_used, used, remaining}}}.
    """
    rng = random.Random(RNG_SEED + 2)
    balances: dict[str, dict[str, dict[str, float]]] = {}

    paid_types = [t for t, p in LEAVE_POLICY.items() if p["paid"]]
    paid_weights = [LEAVE_POLICY[t]["weight"] for t in paid_types]
    approver = "Ayesha Malik"

    for staff in ds.staff:
        sid = staff["id"]
        # Opening balances
        bal: dict[str, dict[str, float]] = {}
        for ltype, pol in LEAVE_POLICY.items():
            quota = pol["annual_quota"]
            opening = 0.0
            if pol["paid"] and quota:
                opening = float(round(quota * rng.uniform(*OPENING_USED_FRACTION)))
            bal[ltype] = {
                "quota": float(quota),
                "opening_used": opening,
                "used": 0.0,
                "remaining": float(quota) - opening,
            }
        balances[sid] = bal

        n_episodes = rng.choices(LEAVE_EPISODES_PER_EMPLOYEE[0],
                                 weights=LEAVE_EPISODES_PER_EMPLOYEE[1])[0]
        taken_days: set[date] = set()
        attempts = 0

        while len([e for e in ds.leave_requests if e["staff_id"] == sid]) < n_episodes and attempts < 40:
            attempts += 1
            anchor = ds.window_start + timedelta(days=rng.randint(0, (ds.window_end - ds.window_start).days + 6))
            if not is_weekday(anchor) or anchor in ds.holidays:
                continue

            span = rng.choices([1, 2, 3], weights=[55, 28, 17])[0]
            is_half = span == 1 and rng.random() < HALF_DAY_CHANCE
            workdays = _next_workdays(anchor, span, ds.window_end + timedelta(days=14), ds.holidays)
            if len(workdays) < span:
                continue
            if any(d in taken_days for d in workdays):
                continue

            # Status. Old requests are always decided; only the last ~10 days
            # (and anything in the future) can still be sitting in the queue,
            # which is what makes the "Pending Approvals" widget believable.
            recent_cutoff = ds.window_end - timedelta(days=14)
            if workdays[0] > ds.window_end:
                status = "pending"
            elif workdays[0] >= recent_cutoff:
                status = rng.choices(["approved", "pending", "rejected"], weights=[55, 35, 10])[0]
            else:
                status = rng.choices(["approved", "rejected"], weights=[88, 12])[0]

            cost = 0.5 if is_half else float(span)
            fallback_from = None
            if rng.random() < DIRECT_UNPAID_CHANCE:
                requested_type = ltype = UNPAID_LEAVE_TYPE
            else:
                requested_type = ltype = rng.choices(paid_types, weights=paid_weights)[0]
                # Quota check happens against the balance as it stands right
                # now; only approved leave has consumed anything so far.
                if bal[requested_type]["remaining"] < cost:
                    ltype = UNPAID_LEAVE_TYPE
                    fallback_from = requested_type

            paid = LEAVE_POLICY[ltype]["paid"]
            if status == "approved":
                if paid:
                    bal[ltype]["used"] += cost
                    bal[ltype]["remaining"] = bal[ltype]["quota"] - bal[ltype]["opening_used"] - bal[ltype]["used"]
                else:
                    bal[ltype]["used"] += cost
                    bal[ltype]["remaining"] = 0.0
                taken_days.update(workdays)

            half_period = rng.choice(["first_half", "second_half"]) if is_half else None
            reason = (
                f"{fallback_from} balance exhausted - taken as leave without pay"
                if fallback_from else
                {
                    "Annual": "Family vacation",
                    "Casual": "Personal errand",
                    "Sick": "Fever / medical rest",
                    "Emergency": "Family emergency",
                    "Compensatory": "Comp-off against approved overtime",
                    UNPAID_LEAVE_TYPE: "Personal - no paid balance available",
                }[ltype]
            )

            shift = staff["_shift"]
            shift_in = time.fromisoformat(shift["check_in_time"])
            shift_out = time.fromisoformat(shift["check_out_time"])
            mid_minutes = minutes_between(shift_in, shift_out) // 2
            midpoint = (datetime.combine(date(2000, 1, 1), shift_in)
                        + timedelta(minutes=mid_minutes)).time()

            ds.leave_requests.append({
                "id": new_id(),
                "org_id": ds.org_id,
                "branch_id": staff["branch_id"],
                "staff_id": sid,
                "user_name": staff["name"],
                "leave_type": ltype,
                "start_date": workdays[0].isoformat(),
                "end_date": workdays[-1].isoformat(),
                "reason": reason,
                "status": status,
                "approved_by": approver if status != "pending" else None,
                "half_day_period": half_period,
                "half_day_start_time": (shift_in.strftime("%H:%M") if half_period == "first_half"
                                        else midpoint.strftime("%H:%M")) if is_half else None,
                "half_day_end_time": (midpoint.strftime("%H:%M") if half_period == "first_half"
                                      else shift_out.strftime("%H:%M")) if is_half else None,
                # Applied-on date must read as "in the past relative to today",
                # never in the future -- a created_at audit timestamp can't be
                # later than "now". For leave that starts soon (or already has),
                # applying a few days ahead of the start date is realistic and
                # naturally falls on/before window_end. But workdays[0] can be
                # up to window_end + 6 days out (so "pending" future leave looks
                # believable -- see the anchor roll above), and a 2-6 day lead
                # time isn't always enough to pull that back before today. Clamp
                # so the request was never submitted after window_end.
                "created_at": iso_ts(
                    min(workdays[0] - timedelta(days=rng.randint(2, 6)), ds.window_end),
                    time(10, 30),
                ),
                "updated_at": now_iso(),
                # ── private, stripped before insert ──
                "_workdays": workdays,
                "_is_half_day": is_half,
                "_paid": paid,
                "_days": cost,
            })

    # Leave balance snapshot rows (for a "Leave Balance" report / optional table).
    for staff in ds.staff:
        for ltype, b in balances[staff["id"]].items():
            if not LEAVE_POLICY[ltype]["paid"] and b["used"] == 0:
                continue  # don't clutter with empty LWP rows
            ds.leave_balances.append({
                "id": new_id(),
                "org_id": ds.org_id,
                "branch_id": staff["branch_id"],
                "staff_id": staff["id"],
                "staff_name": staff["name"],
                "leave_type": ltype,
                "leave_code": LEAVE_POLICY[ltype]["code"],
                "is_paid": LEAVE_POLICY[ltype]["paid"],
                "year": ds.window_end.year,
                "annual_quota": b["quota"],
                "opening_used": b["opening_used"],
                "used_days": b["used"],
                "remaining_days": max(0.0, b["remaining"]),
                "created_at": now_iso(),
                "updated_at": now_iso(),
            })

    return balances


def build_ledger_and_attendance(ds: Dataset) -> None:
    """
    Walks every employee across every day of the window and writes the ledger,
    then emits the attendance rows implied by it.

    Precedence per day, highest first:
        weekend  ->  no row
        public holiday -> no row (paid, not a working day)
        APPROVED full-day leave -> no row (this is the leave<->attendance link)
        APPROVED half-day leave -> a genuine half-length attendance row
        otherwise -> roll a normal working day against DAY_WEIGHTS

    Every timestamp is built from the employee's OWN shift, so "on time" is
    always relative to the right shift. An employee is late only when their
    check-in exceeds their shift's grace_minutes -- the same rule the product
    itself uses.
    """
    rng = random.Random(RNG_SEED + 1)

    approved_by_staff_day: dict[tuple[str, date], dict] = {}
    for lr in ds.leave_requests:
        if lr["status"] != "approved":
            continue
        for d in lr["_workdays"]:
            approved_by_staff_day[(lr["staff_id"], d)] = lr

    for staff in ds.staff:
        sid = staff["id"]
        shift = staff["_shift"]
        shift_in = time.fromisoformat(shift["check_in_time"])
        shift_out = time.fromisoformat(shift["check_out_time"])
        grace = shift["grace_minutes"]
        shift_minutes = minutes_between(shift_in, shift_out)
        days: dict[date, DayRecord] = {}

        for day in daterange(ds.window_start, ds.window_end):
            if not is_weekday(day):
                days[day] = DayRecord(day=day, category="weekend")
                continue
            if day in ds.holidays:
                days[day] = DayRecord(day=day, category="holiday", holiday_name=ds.holidays[day])
                continue

            leave = approved_by_staff_day.get((sid, day))
            if leave and not leave["_is_half_day"]:
                days[day] = DayRecord(
                    day=day,
                    category="leave_paid" if leave["_paid"] else "leave_unpaid",
                    leave_type=leave["leave_type"],
                )
                continue

            rec = DayRecord(day=day, category="worked", day_status="present")

            if leave and leave["_is_half_day"]:
                # Half day on leave: the other half is genuinely worked, and
                # the attendance row is exactly half the shift long.
                rec.category = "leave_paid" if leave["_paid"] else "leave_unpaid"
                rec.leave_type = leave["leave_type"]
                rec.is_half_day = True
                rec.day_status = "half_day"
                half = shift_minutes // 2
                if leave["half_day_period"] == "first_half":
                    rec.check_in = (datetime.combine(day, shift_in) + timedelta(minutes=half)).time()
                    rec.check_out = shift_out
                else:
                    rec.check_in = shift_in
                    rec.check_out = (datetime.combine(day, shift_in) + timedelta(minutes=half)).time()
                rec.work_minutes = half
                days[day] = rec
                continue

            outcome = weighted_pick(rng, TODAY_WEIGHTS if day == ds.window_end else DAY_WEIGHTS)

            if outcome == "absent":
                # Unauthorised absence: no attendance row, full day deducted.
                days[day] = DayRecord(day=day, category="absent")
                continue

            in_offset = 0
            out_offset = 0
            if outcome == "on_time":
                in_offset = rng.randint(-12, max(0, grace - 1))
                out_offset = rng.randint(0, 12)
            elif outcome == "late":
                in_offset = rng.randint(grace + 1, grace + 50)
                rec.day_status = "late"
                out_offset = rng.randint(0, 15)
            elif outcome == "early_leave":
                in_offset = rng.randint(-8, max(0, grace - 1))
                out_offset = -rng.randint(45, 120)
                rec.day_status = "short_leave"
            elif outcome == "overtime":
                in_offset = rng.randint(-10, max(0, grace - 1))
                # HARD CONSTRAINT: the checkout must stay on the same calendar
                # day. Without this clamp a late shift (21:00) plus 3 hours of
                # overtime wraps past midnight, `.time()` silently rolls over to
                # 00:xx, and every downstream reader -- including payroll --
                # sees a checkout BEFORE the check-in. Cap the overrun at
                # LATEST_CHECKOUT and fall back to a normal day if that leaves
                # no room for payable overtime at all.
                headroom = LATEST_CHECKOUT_MINUTE - (shift_out.hour * 60 + shift_out.minute)
                if headroom < OVERTIME_MIN_MINUTES:
                    out_offset = rng.randint(0, 12)
                else:
                    out_offset = rng.randint(OVERTIME_MIN_MINUTES, min(180, headroom))
                    rec.day_status = "overtime"
            elif outcome == "missing_checkout":
                in_offset = rng.randint(-10, max(0, grace - 1))
                rec.has_checkout = False

            rec.check_in = (datetime.combine(day, shift_in) + timedelta(minutes=in_offset)).time()
            rec.late_minutes = max(0, in_offset - grace)
            if rec.has_checkout:
                rec.check_out = (datetime.combine(day, shift_out) + timedelta(minutes=out_offset)).time()
                rec.early_minutes = max(0, -out_offset)
                rec.overtime_minutes = out_offset if out_offset >= OVERTIME_MIN_MINUTES else 0
                rec.work_minutes = max(0, minutes_between(rec.check_in, rec.check_out))
            days[day] = rec

        ds.ledger[sid] = days
        _emit_attendance_rows(ds, staff, days, rng)


def _emit_attendance_rows(ds: Dataset, staff: dict, days: dict[date, DayRecord], rng: random.Random) -> None:
    """Turns ledger days into `attendance` rows. Only days the employee
    actually attended produce a row -- weekends, holidays, approved full-day
    leave and absences deliberately produce nothing, which is exactly how the
    real capture pipeline behaves."""
    for day, rec in sorted(days.items()):
        if rec.check_in is None:
            continue

        # capture_channel (CHECK: local_node/cloud/mobile_app) is a different
        # column from source (CHECK: camera/camera_cloud/mobile_office/
        # mobile_field/mobile_fallback/mobile_cloud) -- they must NOT share a
        # value, so each gets its own pick.
        capture_channel = "mobile_app" if rng.random() < 0.7 else "cloud"
        source = "mobile_office" if capture_channel == "mobile_app" else "camera_cloud"
        # attendance_status_check only allows on_time/late/unscheduled/early --
        # this is the check-IN status, distinct from day_status.
        check_in_status = "late" if rec.day_status == "late" else "on_time"

        hold_reason = None
        if rec.day_status == "short_leave":
            hold_reason = "early"
        elif rec.day_status == "overtime":
            hold_reason = "late"

        # Exceptions need a payroll decision; ~65% are resolved so the
        # Payroll Decisions queue has real unresolved items to demo.
        check_out_decision = None
        if rec.day_status not in {"present", None} and rng.random() < 0.65:
            # An exception that costs the company (early leave) tends to be
            # excluded; overtime tends to be included. Not random noise.
            check_out_decision = "exclude" if rec.day_status == "short_leave" else "include"

        ds.attendance.append({
            "id": new_id(),
            "org_id": ds.org_id,
            "branch_id": staff["branch_id"],
            "staff_id": staff["id"],
            "timestamp": iso_ts(day, rec.check_in),
            "source": source,
            "confidence": round(rng.uniform(0.86, 0.99), 4),
            "created_at": iso_ts(day, rec.check_in),
            "metadata": {
                "seed": DEMO_MARKER,
                "shift_name": staff["shift_label"],
                "shift_start": staff["duty_start"],
                "shift_end": staff["duty_end"],
                "late_minutes": rec.late_minutes,
                "early_minutes": rec.early_minutes,
                "overtime_minutes": rec.overtime_minutes,
                "work_minutes": rec.work_minutes,
                "leave_type": rec.leave_type,
            },
            "status": check_in_status,
            "check_out_timestamp": iso_ts(day, rec.check_out) if rec.has_checkout and rec.check_out else None,
            "check_out_status": "on_time" if rec.day_status == "present" else rec.day_status,
            "check_out_confidence": round(rng.uniform(0.86, 0.99), 4) if rec.has_checkout else None,
            "check_out_metadata": {"seed": DEMO_MARKER, "overtime_minutes": rec.overtime_minutes},
            "check_out_hold_reason": hold_reason,
            "day_status": rec.day_status,
            "check_in_confirmed": True,
            "capture_channel": capture_channel,
            "check_in_payroll_decision": None,
            "check_out_payroll_decision": check_out_decision,
        })


def build_overtime_requests(ds: Dataset) -> dict[tuple[str, int, int], float]:
    """
    Overtime requests are derived FROM attendance, never invented. For every
    ledger day where the employee actually stayed past shift end by at least
    OVERTIME_MIN_MINUTES there is exactly one request, and its `hours` equals
    the overtime measured on that date.

    Only APPROVED requests are paid. Pending/rejected overtime was worked and
    is visible in attendance but does not appear in the payslip -- a genuinely
    useful thing to point at during a demo.

    Returns approved hours keyed by (staff_id, year, month) for payroll.
    """
    rng = random.Random(RNG_SEED + 3)
    approved: dict[tuple[str, int, int], float] = defaultdict(float)

    for staff in ds.staff:
        for day, rec in sorted(ds.ledger[staff["id"]].items()):
            if rec.overtime_minutes < OVERTIME_MIN_MINUTES:
                continue
            hours = round(rec.overtime_minutes / 60.0, 2)
            status = rng.choices(OVERTIME_REQUEST_STATUS[0], weights=OVERTIME_REQUEST_STATUS[1])[0]
            # Anything older than 10 days has been decided by now.
            if status == "pending" and day < ds.window_end - timedelta(days=21):
                status = "approved"
            if status == "approved":
                approved[(staff["id"], day.year, day.month)] += hours

            ds.overtime_requests.append({
                "id": new_id(),
                "org_id": ds.org_id,
                "branch_id": staff["branch_id"],
                "staff_id": staff["id"],
                "user_name": staff["name"],
                "ot_date": day.isoformat(),
                "hours": hours,
                "reason": rng.choice([
                    "Exam supervision duty",
                    "Extra-curricular event coverage",
                    "Result compilation - term closing",
                    "Parent-teacher meeting extension",
                    "System maintenance window",
                ]),
                "status": status,
                "approved_by": "Dr. Farrukh Zaman" if status != "pending" else None,
                "created_at": iso_ts(day, time(20, 0)),
                "updated_at": now_iso(),
            })

    return approved


# ─────────────────────────────────────────────────────────────────────────
# PAYROLL -- pure arithmetic over the ledger. Nothing here is random.
# ─────────────────────────────────────────────────────────────────────────

def build_periods(ds: Dataset) -> None:
    """Pay periods are whole calendar months. A month fully covered by the
    window is FINALIZED (paid); the month the window ends in is IN PROGRESS
    (projected from attendance to date, paid_at = NULL). A leading partial
    month -- only possible with ALIGN_WINDOW_TO_MONTH_START = False -- is
    skipped entirely rather than shipping a half-month payslip."""
    y, m = ds.window_start.year, ds.window_start.month
    while (y, m) <= (ds.window_end.year, ds.window_end.month):
        ms, me = month_bounds(y, m)
        if ms >= ds.window_start:
            ds.periods.append((ms, me, me <= ds.window_end))
        m += 1
        if m > 12:
            m, y = 1, y + 1


def compute_payslip(
    staff: dict, period_start: date, period_end: date, finalized: bool,
    ledger_days: dict[date, DayRecord], approved_ot_hours: float,
    holidays: dict[date, str],
) -> dict:
    """
    THE payslip calculation. Both the seeder and the verifier call this, and
    the verifier feeds it data re-derived from the generated attendance/leave
    rows -- so if attendance and payroll ever disagreed, the seed would abort.

    Formula, in the order a payslip prints it:

        per_day_rate = basic / scheduled_working_days_in_month
        gross        = basic + allowances + (approved_ot_hours * ot_rate)
        deductions   = unpaid_leave_days * per_day_rate
                     + absent_days       * per_day_rate
                     + max(0, late_count - LATE_GRACE_PER_MONTH)
                       * LATE_PENALTY_DAY_FRACTION * per_day_rate
                     + provident_fund (PF_RATE of basic)
                     + income_tax (simplified annualised slabs)
        net_pay      = gross - deductions
    """
    basic = float(staff["salary"])
    allowances = staff["_allowances"]
    ot_rate = staff["_ot_rate"]

    # Denominator is always the FULL month's scheduled working days, so an
    # in-progress month's daily rate matches the finalized months exactly.
    working_days = sum(
        1 for d in daterange(period_start, period_end)
        if is_weekday(d) and d not in holidays
    )
    working_days = max(working_days, 1)
    per_day = basic / working_days

    in_period = [r for d, r in ledger_days.items() if period_start <= d <= period_end]

    present_days = sum(1 for r in in_period if r.check_in is not None)
    on_time_days = sum(1 for r in in_period if r.day_status == "present")
    late_count = sum(1 for r in in_period if r.day_status == "late")
    early_leave_days = sum(1 for r in in_period if r.day_status == "short_leave")
    overtime_days = sum(1 for r in in_period if r.overtime_minutes >= OVERTIME_MIN_MINUTES)
    missing_checkout_days = sum(1 for r in in_period if r.check_in is not None and not r.has_checkout)
    paid_leave_days = sum((0.5 if r.is_half_day else 1.0) for r in in_period if r.category == "leave_paid")
    unpaid_leave_days = sum((0.5 if r.is_half_day else 1.0) for r in in_period if r.category == "leave_unpaid")
    absent_days = sum(1 for r in in_period if r.category == "absent")
    holiday_days = sum(1 for r in in_period if r.category == "holiday")
    elapsed_working_days = sum(1 for r in in_period if r.is_scheduled_workday)
    payable_days = working_days - unpaid_leave_days - absent_days

    # ── earnings ──
    # Hours actually WORKED past shift end vs hours APPROVED for payment. They
    # differ whenever an overtime request is still pending or was rejected, and
    # a client reading the payslip will ask about that gap -- so the payslip
    # states both numbers rather than silently paying the smaller one.
    overtime_hours_worked = round(sum(r.overtime_minutes for r in in_period) / 60.0, 2)
    overtime_hours = round(approved_ot_hours, 2)
    overtime_pay = money(overtime_hours * ot_rate)
    gross = money(basic + allowances + overtime_pay)

    # ── deductions ──
    unpaid_leave_deduction = money(unpaid_leave_days * per_day)
    absence_deduction = money(absent_days * per_day)
    penalised_lates = max(0, late_count - LATE_GRACE_PER_MONTH)
    late_deduction = money(penalised_lates * LATE_PENALTY_DAY_FRACTION * per_day)
    provident_fund = staff["_pf"]
    monthly_taxable = basic + allowances
    income_tax = money(annual_income_tax(monthly_taxable * 12) / 12)
    total_deductions = money(
        unpaid_leave_deduction + absence_deduction + late_deduction
        + provident_fund + income_tax
    )
    net_pay = money(gross - total_deductions)

    notes = []
    if not finalized:
        notes.append(
            "In-progress period: projected from attendance recorded to date "
            f"({elapsed_working_days} of {working_days} working days elapsed)."
        )
    if unpaid_leave_days:
        notes.append(f"{unpaid_leave_days:g} unpaid leave day(s) deducted at the daily rate.")
    if absent_days:
        notes.append(f"{absent_days} unauthorised absence day(s) deducted at the daily rate.")
    if penalised_lates:
        notes.append(
            f"{late_count} late arrivals; {LATE_GRACE_PER_MONTH} are within policy, "
            f"{penalised_lates} penalised at {LATE_PENALTY_DAY_FRACTION:g} day each."
        )
    if overtime_hours:
        notes.append(f"{overtime_hours:g} approved overtime hours paid at {ot_rate:,.2f}/hr.")
    if overtime_hours_worked > overtime_hours + 0.01:
        notes.append(
            f"{round(overtime_hours_worked - overtime_hours, 2):g} of "
            f"{overtime_hours_worked:g} overtime hours worked are not paid "
            "(request pending or rejected)."
        )

    return {
        "currency": "PKR",
        "status": "paid" if finalized else "in_progress",
        "period": {
            "start": period_start.isoformat(),
            "end": period_end.isoformat(),
            "working_days": working_days,
            "working_days_elapsed": elapsed_working_days,
            "per_day_rate": money(per_day),
            "payable_days": round(payable_days, 2),
        },
        "attendance": {
            "present_days": present_days,
            "on_time_days": on_time_days,
            "late_days": late_count,
            "early_leave_days": early_leave_days,
            "overtime_days": overtime_days,
            "missing_checkout_days": missing_checkout_days,
            "paid_leave_days": paid_leave_days,
            "unpaid_leave_days": unpaid_leave_days,
            "absent_days": absent_days,
            "public_holidays": holiday_days,
        },
        "earnings": {
            "basic_salary": money(basic),
            "medical_allowance": money(basic * ALLOWANCE_RATES["medical_allowance"]),
            "transport_allowance": money(basic * ALLOWANCE_RATES["transport_allowance"]),
            "allowances_total": allowances,
            "overtime_hours_worked": overtime_hours_worked,
            "overtime_hours": overtime_hours,
            "overtime_rate": ot_rate,
            "overtime_pay": overtime_pay,
            "gross_earnings": gross,
        },
        "deductions": {
            "unpaid_leave": unpaid_leave_deduction,
            "absence": absence_deduction,
            "late_penalty": late_deduction,
            "provident_fund": provident_fund,
            "income_tax": income_tax,
            "total_deductions": total_deductions,
        },
        "net_pay": net_pay,
        "notes": notes,
        "seed": DEMO_MARKER,
    }


def build_payroll(ds: Dataset, approved_ot: dict[tuple[str, int, int], float]) -> None:
    for period_start, period_end, finalized in ds.periods:
        paid_at = (
            iso_ts(period_end + timedelta(days=3), time(10, 0)) if finalized else None
        )
        for staff in ds.staff:
            ot_hours = approved_ot.get((staff["id"], period_start.year, period_start.month), 0.0)
            breakdown = compute_payslip(
                staff, period_start, period_end, finalized,
                ds.ledger[staff["id"]], ot_hours, ds.holidays,
            )
            ds.payroll.append({
                "org_id": ds.org_id,
                "staff_id": staff["id"],
                "period_start": period_start.isoformat(),
                "period_end": period_end.isoformat(),
                "paid_at": paid_at,
                "medical_allowance": breakdown["earnings"]["medical_allowance"],
                "transport_allowance": breakdown["earnings"]["transport_allowance"],
                "allowances_total": breakdown["earnings"]["allowances_total"],
                "unpaid_leave_days": breakdown["attendance"]["unpaid_leave_days"],
                "late_count": breakdown["attendance"]["late_days"],
                "breakdown": breakdown,
            })


# ─────────────────────────────────────────────────────────────────────────
# Notifications -- derived from real pending items, not invented events
# ─────────────────────────────────────────────────────────────────────────

def build_notifications(ds: Dataset, users: dict[str, str]) -> None:
    rng = random.Random(RNG_SEED + 4)
    staff_by_id = {s["id"]: s for s in ds.staff}
    events: list[dict] = []

    pending_leave = [lr for lr in ds.leave_requests if lr["status"] == "pending"]
    for lr in sorted(pending_leave, key=lambda r: r["start_date"], reverse=True)[:6]:
        s = staff_by_id[lr["staff_id"]]
        events.append({
            "module_key": "leave",
            "event_type": "leave_request_submitted",
            "title": "New leave request",
            "body": (f"{s['name']} requested {lr['leave_type']} leave "
                     f"from {lr['start_date']} to {lr['end_date']}."),
            "actor_name": s["name"],
            "target_entity_id": lr["id"],
            "target_entity_type": "leave_request",
            "target_route": "/leave-management",
        })

    pending_ot = [o for o in ds.overtime_requests if o["status"] == "pending"]
    for o in sorted(pending_ot, key=lambda r: r["ot_date"], reverse=True)[:3]:
        s = staff_by_id[o["staff_id"]]
        events.append({
            "module_key": "overtime",
            "event_type": "overtime_request_submitted",
            "title": "Overtime approval pending",
            "body": f"{s['name']} logged {o['hours']}h overtime on {o['ot_date']}.",
            "actor_name": s["name"],
            "target_entity_id": o["id"],
            "target_entity_type": "overtime_request",
            "target_route": "/overtime",
        })

    last_finalized = [p for p in ds.payroll if p["paid_at"]]
    if last_finalized:
        latest = max(p["period_end"] for p in last_finalized)
        total_net = money(sum(p["breakdown"]["net_pay"] for p in ds.payroll
                              if p["period_end"] == latest))
        events.append({
            "module_key": "payroll",
            "event_type": "payroll_processed",
            "title": "Payroll processed",
            "body": (f"Payroll for the period ending {latest} completed for "
                     f"{len(ds.staff)} staff. Total net payout PKR {total_net:,.0f}."),
            "actor_name": "System",
            "target_entity_id": ds.org_id,
            "target_entity_type": "payroll_run",
            "target_route": "/payroll",
        })

    unresolved = sum(1 for a in ds.attendance
                     if a["day_status"] != "present" and a["check_out_payroll_decision"] is None)
    if unresolved:
        events.append({
            "module_key": "attendance",
            "event_type": "attendance_exception_flagged",
            "title": "Attendance exceptions need review",
            "body": f"{unresolved} attendance exceptions are awaiting a payroll decision.",
            "actor_name": "System",
            "target_entity_id": ds.org_id,
            "target_entity_type": "attendance_exception",
            "target_route": "/attendance/exceptions",
        })

    for e in events:
        e_row = dict(e)
        e_row.update({
            "id": new_id(),
            "org_id": ds.org_id,
            "metadata": {"seed": DEMO_MARKER},
            "created_at": (datetime.now(timezone.utc)
                           - timedelta(hours=rng.randint(1, 96))).isoformat(),
            "_recipients": list(users.values()),
            "_is_read": rng.random() < 0.4,
        })
        ds.notifications.append(e_row)


def build_onboarding(ds: Dataset) -> None:
    ds.onboarding = {
        "org_id": ds.org_id,
        "company_profile": {"name": ORG_NAME, "industry": "Education"},
        "departments": {"default": [d for d, _ in DEPARTMENTS]},
        "roles": {"default": [r for r, _, _ in ROLES]},
        "shifts": {"default": [t["name"] for t in SHIFT_TEMPLATES]},
        "cameras": {},
        "network": {},
        "shift_enabled_people_types": ["staff"],
        # The payroll policy is stored here in full so the dashboard (and any
        # report the client runs) reads the SAME numbers the payslips were
        # computed with, instead of a second hardcoded copy drifting apart.
        "payroll_policy": {
            "leave_types": [
                {
                    "name": name,
                    "code": pol["code"],
                    "paid": pol["paid"],
                    "annual_quota_days": pol["annual_quota"],
                }
                for name, pol in LEAVE_POLICY.items()
            ],
            "allowances": {k: v for k, v in ALLOWANCE_RATES.items()},
            "provident_fund_rate": PF_RATE,
            "overtime_multiplier": OT_MULTIPLIER,
            "overtime_min_minutes": OVERTIME_MIN_MINUTES,
            "late_grace_per_month": LATE_GRACE_PER_MONTH,
            "late_penalty_day_fraction": LATE_PENALTY_DAY_FRACTION,
            "standard_days_per_month": STANDARD_DAYS_PER_MONTH,
            "standard_hours_per_day": STANDARD_HOURS_PER_DAY,
            "income_tax_enabled": ENABLE_INCOME_TAX,
            "workweek": sorted(WORKDAYS),
            "public_holidays": [
                {"date": d.isoformat(), "name": n} for d, n in sorted(ds.holidays.items())
            ],
        },
        "completed_at": now_iso(),
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }


# ─────────────────────────────────────────────────────────────────────────
# VERIFICATION -- re-derives payroll from the generated attendance / leave /
# overtime rows the same way a client report query would, and asserts it
# matches the payroll rows. If this fails, nothing is written to the database.
# ─────────────────────────────────────────────────────────────────────────

def _reconstruct_ledger(ds: Dataset) -> dict[str, dict[date, DayRecord]]:
    """Rebuilds the day ledger from the OUTPUT rows only -- attendance
    timestamps, leave_requests and the shift definitions. It deliberately does
    not look at ds.ledger, so agreement between the two is real evidence that
    the tables are consistent with each other rather than a tautology."""
    staff_by_id = {s["id"]: s for s in ds.staff}
    att_by: dict[tuple[str, date], dict] = {}
    for a in ds.attendance:
        d = datetime.fromisoformat(a["timestamp"]).date()
        att_by[(a["staff_id"], d)] = a

    leave_by: dict[tuple[str, date], dict] = {}
    for lr in ds.leave_requests:
        if lr["status"] != "approved":
            continue
        start = date.fromisoformat(lr["start_date"])
        end = date.fromisoformat(lr["end_date"])
        for d in daterange(start, end):
            if is_weekday(d) and d not in ds.holidays:
                leave_by[(lr["staff_id"], d)] = lr

    out: dict[str, dict[date, DayRecord]] = {}
    for sid, staff in staff_by_id.items():
        shift_in = time.fromisoformat(staff["duty_start"])
        shift_out = time.fromisoformat(staff["duty_end"])
        grace = staff["_shift"]["grace_minutes"]
        days: dict[date, DayRecord] = {}

        for day in daterange(ds.window_start, ds.window_end):
            if not is_weekday(day):
                days[day] = DayRecord(day=day, category="weekend")
                continue
            if day in ds.holidays:
                days[day] = DayRecord(day=day, category="holiday", holiday_name=ds.holidays[day])
                continue

            lr = leave_by.get((sid, day))
            att = att_by.get((sid, day))

            if lr is not None:
                paid = LEAVE_POLICY[lr["leave_type"]]["paid"]
                category = "leave_paid" if paid else "leave_unpaid"
                if lr["half_day_period"]:
                    rec = DayRecord(day=day, category=category, leave_type=lr["leave_type"],
                                    is_half_day=True, day_status="half_day")
                    if att:
                        ci = datetime.fromisoformat(att["timestamp"]).time()
                        rec.check_in = ci
                        if att["check_out_timestamp"]:
                            rec.check_out = datetime.fromisoformat(att["check_out_timestamp"]).time()
                            rec.work_minutes = minutes_between(ci, rec.check_out)
                    days[day] = rec
                else:
                    days[day] = DayRecord(day=day, category=category, leave_type=lr["leave_type"])
                continue

            if att is None:
                days[day] = DayRecord(day=day, category="absent")
                continue

            ci = datetime.fromisoformat(att["timestamp"]).time()
            rec = DayRecord(day=day, category="worked", check_in=ci)
            rec.late_minutes = max(0, minutes_between(shift_in, ci) - grace)
            if att["check_out_timestamp"]:
                co = datetime.fromisoformat(att["check_out_timestamp"]).time()
                rec.check_out = co
                delta = minutes_between(shift_out, co)
                rec.early_minutes = max(0, -delta)
                rec.overtime_minutes = delta if delta >= OVERTIME_MIN_MINUTES else 0
                rec.work_minutes = max(0, minutes_between(ci, co))
            else:
                rec.has_checkout = False

            if rec.late_minutes > 0:
                rec.day_status = "late"
            elif rec.early_minutes > 0:
                rec.day_status = "short_leave"
            elif rec.overtime_minutes >= OVERTIME_MIN_MINUTES:
                rec.day_status = "overtime"
            else:
                rec.day_status = "present"
            days[day] = rec

        out[sid] = days
    return out


def verify_dataset(ds: Dataset) -> list[str]:
    """Returns a list of human-readable failures. Empty list == the demo data
    is internally consistent and safe to show a client."""
    errors: list[str] = []
    staff_by_id = {s["id"]: s for s in ds.staff}

    # ── 1. headcount per branch matches the spec ──────────────────────────
    for b in ds.branches:
        actual = sum(1 for s in ds.staff if s["branch_id"] == b["id"])
        if actual != b["_staff_count"]:
            errors.append(f"branch {b['name']}: expected {b['_staff_count']} staff, got {actual}")

    # ── 2. attendance never contradicts an approved full-day leave ────────
    att_days = {(a["staff_id"], datetime.fromisoformat(a["timestamp"]).date())
                for a in ds.attendance}
    for lr in ds.leave_requests:
        if lr["status"] != "approved":
            continue
        for d in lr["_workdays"]:
            present = (lr["staff_id"], d) in att_days
            if lr["_is_half_day"] and not present:
                errors.append(f"half-day leave {lr['id']} on {d} has no attendance row")
            if not lr["_is_half_day"] and present:
                errors.append(
                    f"{staff_by_id[lr['staff_id']]['name']} is on approved "
                    f"{lr['leave_type']} leave on {d} but has an attendance row"
                )

    # ── 2b. a leave request's applied-on date is never in the future ──────
    for lr in ds.leave_requests:
        applied = datetime.fromisoformat(lr["created_at"]).date()
        if applied > ds.window_end:
            errors.append(
                f"leave {lr['id']} ({staff_by_id[lr['staff_id']]['name']}): "
                f"applied on {applied} which is after window_end {ds.window_end}"
            )

    # ── 3. no attendance on weekends or public holidays ───────────────────
    for a in ds.attendance:
        d = datetime.fromisoformat(a["timestamp"]).date()
        if not is_weekday(d):
            errors.append(f"attendance row on a non-working day: {d}")
        if d in ds.holidays:
            errors.append(f"attendance row on public holiday {d} ({ds.holidays[d]})")

    # ── 4. every check-in/out sits on the employee's OWN shift, and the
    #      stored day_status agrees with the timestamps ────────────────────
    for a in ds.attendance:
        s = staff_by_id[a["staff_id"]]
        shift_in = time.fromisoformat(s["duty_start"])
        grace = s["_shift"]["grace_minutes"]
        ci = datetime.fromisoformat(a["timestamp"]).time()
        drift = minutes_between(shift_in, ci)
        if a["day_status"] == "half_day":
            continue
        if a["day_status"] == "late" and drift <= grace:
            errors.append(f"row {a['id']} marked late but checked in within grace ({drift}m)")
        if a["day_status"] != "late" and drift > grace:
            errors.append(f"row {a['id']} is {drift}m past grace but not marked late")
        if a["status"] not in {"on_time", "late"}:
            errors.append(f"row {a['id']} has invalid check-in status {a['status']}")

    # ── 5. overtime requests correspond to real overtime in attendance ────
    att_ot: dict[tuple[str, date], float] = {}
    for a in ds.attendance:
        d = datetime.fromisoformat(a["timestamp"]).date()
        if not a["check_out_timestamp"]:
            continue
        s = staff_by_id[a["staff_id"]]
        delta = minutes_between(time.fromisoformat(s["duty_end"]),
                                datetime.fromisoformat(a["check_out_timestamp"]).time())
        if delta >= OVERTIME_MIN_MINUTES:
            att_ot[(a["staff_id"], d)] = round(delta / 60.0, 2)

    for o in ds.overtime_requests:
        key = (o["staff_id"], date.fromisoformat(o["ot_date"]))
        if key not in att_ot:
            errors.append(f"overtime request {o['id']} has no matching attendance overtime")
        elif abs(att_ot[key] - float(o["hours"])) > 0.01:
            errors.append(
                f"overtime request {o['id']}: hours {o['hours']} != attendance {att_ot[key]}"
            )
    if len(ds.overtime_requests) != len(att_ot):
        errors.append(
            f"{len(att_ot)} overtime days in attendance but "
            f"{len(ds.overtime_requests)} overtime requests"
        )

    # ── 6. leave balances reconcile to approved leave ─────────────────────
    used: dict[tuple[str, str], float] = defaultdict(float)
    for lr in ds.leave_requests:
        if lr["status"] == "approved":
            used[(lr["staff_id"], lr["leave_type"])] += lr["_days"]
    for b in ds.leave_balances:
        expected = used[(b["staff_id"], b["leave_type"])]
        if abs(b["used_days"] - expected) > 0.001:
            errors.append(
                f"leave balance {b['staff_name']}/{b['leave_type']}: "
                f"used {b['used_days']} != approved {expected}"
            )
        if b["is_paid"] and b["remaining_days"] < 0:
            errors.append(f"negative balance for {b['staff_name']}/{b['leave_type']}")
        if b["is_paid"] and (b["opening_used"] + b["used_days"]) > b["annual_quota"]:
            errors.append(f"quota overrun for {b['staff_name']}/{b['leave_type']}")

    # ── 7. payroll recomputed from the output rows must match exactly ─────
    rebuilt = _reconstruct_ledger(ds)
    approved_ot: dict[tuple[str, int, int], float] = defaultdict(float)
    for o in ds.overtime_requests:
        if o["status"] == "approved":
            d = date.fromisoformat(o["ot_date"])
            approved_ot[(o["staff_id"], d.year, d.month)] += float(o["hours"])

    finalized_by_period = {(p[0], p[1]): p[2] for p in ds.periods}
    for row in ds.payroll:
        s = staff_by_id[row["staff_id"]]
        ps = date.fromisoformat(row["period_start"])
        pe = date.fromisoformat(row["period_end"])
        expected = compute_payslip(
            s, ps, pe, finalized_by_period[(ps, pe)], rebuilt[s["id"]],
            approved_ot.get((s["id"], ps.year, ps.month), 0.0), ds.holidays,
        )
        got = row["breakdown"]
        for section in ("attendance", "earnings", "deductions"):
            for k, v in expected[section].items():
                if isinstance(v, (int, float)) and abs(v - got[section][k]) > 0.011:
                    errors.append(
                        f"payroll {s['name']} {row['period_start']}: "
                        f"{section}.{k} recomputed {v} != stored {got[section][k]}"
                    )
        if abs(expected["net_pay"] - got["net_pay"]) > 0.011:
            errors.append(
                f"payroll {s['name']} {row['period_start']}: net {got['net_pay']} "
                f"!= recomputed {expected['net_pay']}"
            )
        # Internal arithmetic of the payslip itself
        e, d_ = got["earnings"], got["deductions"]
        if abs(money(e["basic_salary"] + e["allowances_total"] + e["overtime_pay"])
               - e["gross_earnings"]) > 0.011:
            errors.append(f"payroll {s['name']} {row['period_start']}: gross does not sum")
        parts = money(d_["unpaid_leave"] + d_["absence"] + d_["late_penalty"]
                      + d_["provident_fund"] + d_["income_tax"])
        if abs(parts - d_["total_deductions"]) > 0.011:
            errors.append(f"payroll {s['name']} {row['period_start']}: deductions do not sum")
        if abs(money(e["gross_earnings"] - d_["total_deductions"]) - got["net_pay"]) > 0.011:
            errors.append(f"payroll {s['name']} {row['period_start']}: net != gross - deductions")
        if abs(e["overtime_pay"] - money(e["overtime_hours"] * e["overtime_rate"])) > 0.011:
            errors.append(f"payroll {s['name']} {row['period_start']}: OT pay != hours * rate")
        # The denormalised columns must agree with the breakdown
        if abs(float(row["unpaid_leave_days"]) - got["attendance"]["unpaid_leave_days"]) > 0.001:
            errors.append(f"payroll {s['name']}: unpaid_leave_days column != breakdown")
        if int(row["late_count"]) != got["attendance"]["late_days"]:
            errors.append(f"payroll {s['name']}: late_count column != breakdown")

    return errors


# ─────────────────────────────────────────────────────────────────────────
# Dataset assembly
# ─────────────────────────────────────────────────────────────────────────

def build_dataset(hash_fn) -> Dataset:
    start, end = compute_window()
    ds = Dataset(org_id=new_id(), window_start=start, window_end=end)
    ds.holidays = build_holidays(start, end)

    build_org(ds)
    build_branches(ds)
    shifts_by_branch = build_shifts(ds)
    departments = build_departments(ds)
    build_roles(ds)
    build_billing(ds)
    users = build_users(ds, hash_fn)
    build_staff(ds, shifts_by_branch, departments)
    build_salary_configs(ds)
    build_leave(ds)
    build_ledger_and_attendance(ds)
    approved_ot = build_overtime_requests(ds)
    build_periods(ds)
    build_payroll(ds, approved_ot)
    build_notifications(ds, users)
    build_onboarding(ds)
    return ds


def summarize(ds: Dataset) -> dict:
    """Aggregates worth pasting straight into the demo report."""
    by_branch = {}
    for b in ds.branches:
        by_branch[b["name"]] = sum(1 for s in ds.staff if s["branch_id"] == b["id"])

    leave_by_type: dict[str, float] = defaultdict(float)
    for lr in ds.leave_requests:
        if lr["status"] == "approved":
            leave_by_type[lr["leave_type"]] += lr["_days"]

    periods = []
    for ps, pe, finalized in ds.periods:
        rows = [p for p in ds.payroll if p["period_start"] == ps.isoformat()]
        periods.append({
            "period": f"{ps.isoformat()} .. {pe.isoformat()}",
            "status": "paid" if finalized else "in_progress",
            "payslips": len(rows),
            "gross": money(sum(r["breakdown"]["earnings"]["gross_earnings"] for r in rows)),
            "overtime_pay": money(sum(r["breakdown"]["earnings"]["overtime_pay"] for r in rows)),
            "deductions": money(sum(r["breakdown"]["deductions"]["total_deductions"] for r in rows)),
            "net": money(sum(r["breakdown"]["net_pay"] for r in rows)),
            "unpaid_leave_days": round(sum(float(r["unpaid_leave_days"]) for r in rows), 2),
            "late_count": sum(int(r["late_count"]) for r in rows),
        })

    return {
        "org_id": ds.org_id,
        "org_name": ORG_NAME,
        "window": {"start": ds.window_start.isoformat(), "end": ds.window_end.isoformat(),
                   "days": (ds.window_end - ds.window_start).days + 1},
        "headcount": by_branch,
        "public_holidays": {d.isoformat(): n for d, n in sorted(ds.holidays.items())},
        "row_counts": {
            "staff": len(ds.staff), "attendance": len(ds.attendance),
            "leave_requests": len(ds.leave_requests), "leave_balances": len(ds.leave_balances),
            "overtime_requests": len(ds.overtime_requests), "payroll_payments": len(ds.payroll),
            "salary_configs": len(ds.salary_configs), "notifications": len(ds.notifications),
        },
        "leave": {
            "approved_days_by_type": {k: v for k, v in sorted(leave_by_type.items())},
            "pending_requests": sum(1 for l in ds.leave_requests if l["status"] == "pending"),
            "rejected_requests": sum(1 for l in ds.leave_requests if l["status"] == "rejected"),
        },
        "overtime": {
            "requests": len(ds.overtime_requests),
            "approved_hours": round(sum(float(o["hours"]) for o in ds.overtime_requests
                                        if o["status"] == "approved"), 2),
            "pending_hours": round(sum(float(o["hours"]) for o in ds.overtime_requests
                                       if o["status"] == "pending"), 2),
        },
        "payroll_periods": periods,
    }


# ─────────────────────────────────────────────────────────────────────────
# Database layer
# ─────────────────────────────────────────────────────────────────────────

def _public(row: dict) -> dict:
    """Strips the private `_foo` keys the generation layer carries around
    (shift object, branch name, workday list) before anything is inserted."""
    return {k: v for k, v in row.items() if not k.startswith("_")}


_UNKNOWN_COL_RE = re.compile(
    r"Could not find the '([^']+)' column|column \"([^\"]+)\" of relation"
)
# Postgres 428C9: the column is an identity column defined as GENERATED
# ALWAYS, so the database insists on generating the value itself. Supplying a
# client-side id for it is not a schema mismatch we can paper over -- the value
# has to be dropped and the database's own id used afterwards.
_IDENTITY_COL_RE = re.compile(
    r'cannot insert a non-DEFAULT value into column "([^"]+)"'
)
_DROPPED_COLUMNS: dict[str, set[str]] = defaultdict(set)


def insert_batch(sb, table: str, rows: list[dict], batch_size: int = 500,
                 quiet: bool = False) -> list[dict]:
    """Single insert entrypoint every builder uses -- one place to change
    batching behaviour.

    It also self-heals against schema drift: if PostgREST rejects a column
    that doesn't exist on this deployment -- or refuses a client-supplied value
    for a GENERATED ALWAYS identity column -- that column is dropped and the
    chunk retried, rather than the whole seed dying on one field. Dropped
    columns are remembered per table and reported at the end.

    Returns the rows as the database stored them, which is how callers get the
    ids of identity-column tables back (see notifications in push_dataset)."""
    if not rows:
        return []
    returned: list[dict] = []
    payload = [_public(r) for r in rows]
    for i in range(0, len(payload), batch_size):
        chunk = [dict(r) for r in payload[i: i + batch_size]]
        for col in _DROPPED_COLUMNS[table]:
            for r in chunk:
                r.pop(col, None)
        for _attempt in range(8):
            try:
                res = sb.table(table).insert(chunk).execute()
                returned.extend(res.data or [])
                break
            except Exception as exc:  # noqa: BLE001
                text = str(exc)
                m = _UNKNOWN_COL_RE.search(text)
                col = (m.group(1) or m.group(2)) if m else None
                if not col:
                    m = _IDENTITY_COL_RE.search(text)
                    col = m.group(1) if m else None
                if not col:
                    raise
                _DROPPED_COLUMNS[table].add(col)
                for r in chunk:
                    r.pop(col, None)
        else:
            raise RuntimeError(f"could not insert into {table} after dropping columns")
    if not quiet:
        print(f"  + {len(payload)} rows -> {table}")
    return returned


def table_exists(sb, table: str) -> bool:
    try:
        sb.table(table).select("*").limit(1).execute()
        return True
    except Exception:  # noqa: BLE001
        return False


LEAVE_BALANCE_TABLE_CANDIDATES = ["leave_balances", "leave_quotas", "staff_leave_balances"]


def push_dataset(sb, ds: Dataset) -> None:
    print(f"Organization created: {ds.org_id} ({ORG_NAME})")
    sb.table("organizations").insert(_public(ds.org_row)).execute()
    insert_batch(sb, "branches", ds.branches)
    insert_batch(sb, "shifts", ds.shifts)
    insert_batch(sb, "departments", ds.departments)
    insert_batch(sb, "client_departments", ds.client_departments)
    insert_batch(sb, "client_roles", ds.roles)
    insert_batch(sb, "organization_modules", ds.modules)
    sb.table("subscriptions").insert(_public(ds.subscription)).execute()
    insert_batch(sb, "invoices", ds.invoices)
    insert_batch(sb, "client_users", ds.users)
    insert_batch(sb, "client_staff", ds.staff)
    insert_batch(sb, "salary_configs", ds.salary_configs)
    insert_batch(sb, "attendance", ds.attendance)
    insert_batch(sb, "leave_requests", ds.leave_requests)
    insert_batch(sb, "overtime_requests", ds.overtime_requests)
    finalized_payroll_rows = [p for p in ds.payroll if p["paid_at"] is not None]
    payroll_rows = list(finalized_payroll_rows)
    if not SEED_IN_PROGRESS_PAYROLL:
        pending_count = int(round(len(finalized_payroll_rows) * PAYROLL_PENDING_FRACTION))
        if pending_count > 0 and len(finalized_payroll_rows) > pending_count:
            rng = random.Random(RNG_SEED + 7)
            pending_indices = set(rng.sample(range(len(finalized_payroll_rows)), pending_count))
            payroll_rows = [row for idx, row in enumerate(finalized_payroll_rows) if idx not in pending_indices]
            print(
                f"    {len(pending_indices)} finalized payslips left pending to create "
                f"both Paid and Pending payroll statuses."
            )
    insert_batch(sb, "payroll_payments", payroll_rows)
    if len(payroll_rows) != len(finalized_payroll_rows):
        print(
            f"    ({len(finalized_payroll_rows) - len(payroll_rows)} finalized payslips are pending and not inserted "
            "into payroll_payments.)"
        )
    if len(payroll_rows) != len(ds.payroll) and SEED_IN_PROGRESS_PAYROLL:
        print(f"    ({len(ds.payroll) - len(payroll_rows)} in-progress payslips "
              "generated and verified but not inserted -- SEED_IN_PROGRESS_PAYROLL)")

    # Leave balances only if this deployment actually has a table for them.
    # If not, they're still exported to JSON by the caller, and every payslip
    # already carries the leave day counts it was computed from.
    target = next((t for t in LEAVE_BALANCE_TABLE_CANDIDATES if table_exists(sb, t)), None)
    if target:
        insert_batch(sb, target, ds.leave_balances)
    else:
        print("  ~ no leave balance table found -- exported to JSON instead")

    # notifications.id is a GENERATED ALWAYS identity column on this schema, so
    # the client-side uuid is dropped by insert_batch and the DATABASE decides
    # the id. That means notification_recipients cannot be built from
    # ds.notifications -- it has to be built from what came back. Rows are
    # returned in insertion order, so they zip 1:1 with what was sent; if that
    # ever stops holding, the guard below skips the recipients rather than
    # silently attaching every notification to the wrong one.
    stored = insert_batch(sb, "notifications", ds.notifications)
    if stored and len(stored) == len(ds.notifications):
        recipients = []
        for stored_row, source in zip(stored, ds.notifications):
            notif_id = stored_row.get("id", source.get("id"))
            for user_id in source["_recipients"]:
                recipients.append({
                    "notification_id": notif_id, "org_id": ds.org_id, "user_id": user_id,
                    "is_read": source["_is_read"], "recipient_type": "client_user",
                })
        insert_batch(sb, "notification_recipients", recipients)
    elif ds.notifications:
        print("  ! notifications did not return matching rows -- "
              "recipients skipped (notification bell will be empty)")

    sb.table("client_onboarding_configs").insert(_public(ds.onboarding)).execute()
    print("  + 1 row  -> client_onboarding_configs")

    if _DROPPED_COLUMNS:
        print("\nColumns skipped (not present in this schema):")
        for table, cols in _DROPPED_COLUMNS.items():
            if cols:
                print(f"  {table}: {', '.join(sorted(cols))}")


# ─────────────────────────────────────────────────────────────────────────
# Cleanup -- explicit, dependency-ordered deletes. Not relying on ON DELETE
# CASCADE since that isn't confirmed for every FK in this schema.
# ─────────────────────────────────────────────────────────────────────────

CLEANUP_TABLE_ORDER = [
    "notification_recipients", "notifications", "payroll_payments", "salary_configs",
    "leave_balances", "leave_quotas", "staff_leave_balances",
    "overtime_requests", "leave_requests", "attendance", "attendance_p2024",
    "attendance_p2025", "attendance_p2026", "attendance_p2027",
    "client_staff", "client_roles", "client_departments", "departments", "shifts",
    "client_onboarding_configs", "client_users", "invoices", "subscriptions",
    "organization_modules", "branches", "organizations",
]


# Not every table names its tenant key `org_id`: salary_configs uses
# `organization_id`. Getting this wrong is silent data rot -- the delete raises,
# the seed carries on, and the next run leaves orphaned salary rows pointing at
# an organization that no longer exists. So each table is tried against every
# plausible tenant column until one works.
ORG_COLUMN_CANDIDATES = {
    "organizations": ["id"],
    "salary_configs": ["organization_id", "org_id"],
}
DEFAULT_ORG_COLUMNS = ["org_id", "organization_id"]

# PGRST205 / 42P01: the table doesn't exist on this deployment (partitioned
# attendance tables, optional leave-balance tables). That's expected, not an
# error worth shouting about.
_MISSING_TABLE_MARKERS = ("PGRST205", "42P01", "in the schema cache")
_MISSING_COLUMN_MARKERS = ("42703", "does not exist")


def _delete_by_org(sb, table: str, org_id: str) -> tuple[bool, str]:
    """Returns (deleted, note)."""
    last_exc = None
    for column in ORG_COLUMN_CANDIDATES.get(table, DEFAULT_ORG_COLUMNS):
        try:
            sb.table(table).delete().eq(column, org_id).execute()
            return True, column
        except Exception as exc:  # noqa: BLE001
            text = str(exc)
            if any(m in text for m in _MISSING_TABLE_MARKERS):
                return False, "not in this schema"
            if any(m in text for m in _MISSING_COLUMN_MARKERS):
                last_exc = exc
                continue  # wrong tenant column name -- try the next candidate
            return False, text
    return False, f"no usable tenant column ({last_exc})"


def cleanup_demo_org(sb, org_id: str) -> None:
    print(f"Deleting demo org {org_id} and all child rows...")
    skipped: list[str] = []
    for table in CLEANUP_TABLE_ORDER:
        ok, note = _delete_by_org(sb, table, org_id)
        if ok:
            suffix = "" if note in DEFAULT_ORG_COLUMNS[:1] else f" (via {note})"
            print(f"  - cleared {table}{suffix}")
        elif note == "not in this schema":
            skipped.append(table)
        else:
            print(f"  ! {table}: {note}")
    if skipped:
        print(f"  . skipped {len(skipped)} table(s) not in this schema: "
              f"{', '.join(skipped)}")
    print("Cleanup complete.")


def find_demo_orgs(sb) -> list[dict]:
    """Finds previously seeded demo orgs. Matched narrowly on this script's own
    ORG_NAME and demo email domain so it can never touch a real tenant."""
    found: dict[str, dict] = {}
    try:
        res = sb.table("organizations").select("id,name,contact_email").eq("name", ORG_NAME).execute()
        for row in res.data or []:
            found[row["id"]] = row
    except Exception as exc:  # noqa: BLE001
        print(f"  ! lookup by name failed: {exc}")
    try:
        res = (sb.table("organizations").select("id,name,contact_email")
               .ilike("contact_email", f"%@{DEMO_EMAIL_DOMAIN}").execute())
        for row in res.data or []:
            found[row["id"]] = row
    except Exception as exc:  # noqa: BLE001
        print(f"  ! lookup by email failed: {exc}")
    return list(found.values())


def _select_all(sb, table: str, columns: str, page: int = 1000) -> list[dict]:
    """Pages through a table. PostgREST caps a plain select at 1000 rows, and
    an orphan check that silently sees only the first page would delete live
    data, so paging here is a correctness requirement rather than a nicety."""
    out: list[dict] = []
    start = 0
    while True:
        res = sb.table(table).select(columns).range(start, start + page - 1).execute()
        rows = res.data or []
        out.extend(rows)
        if len(rows) < page:
            return out
        start += page


def purge_orphan_rows(sb) -> None:
    """Deletes child rows whose organization no longer exists.

    This exists because the previous cleanup used `org_id` for every table,
    while salary_configs names that column `organization_id` -- so its delete
    raised, was swallowed by the best-effort handler, and the rows outlived
    their organization. The column bug is fixed above; this clears what it
    already leaked. Opt-in only (--purge-orphans), never automatic."""
    try:
        live = {r["id"] for r in _select_all(sb, "organizations", "id")}
    except Exception as exc:  # noqa: BLE001
        print(f"  ! could not list organizations, aborting purge: {exc}")
        return
    if not live:
        print("  ! organizations table came back empty -- refusing to purge "
              "(this would delete everything)")
        return

    for table, column in (("salary_configs", "organization_id"),
                          ("payroll_payments", "org_id"),
                          ("attendance", "org_id")):
        try:
            rows = _select_all(sb, table, f"id,{column}")
        except Exception as exc:  # noqa: BLE001
            print(f"  . skipped {table}: {exc}")
            continue
        orphans = sorted({r[column] for r in rows if r.get(column) not in live})
        if not orphans:
            print(f"  - {table}: no orphans")
            continue
        count = sum(1 for r in rows if r.get(column) in orphans)
        print(f"  - {table}: {count} orphan row(s) across {len(orphans)} dead org(s)")
        for dead_org in orphans:
            sb.table(table).delete().eq(column, dead_org).execute()
    print("Orphan purge complete.")


def cleanup_all_demo_orgs(sb) -> int:
    orgs = find_demo_orgs(sb)
    if not orgs:
        print("No previous demo organizations found -- nothing to clean up.")
        return 0
    print(f"Found {len(orgs)} previous demo organization(s) to remove:")
    for o in orgs:
        print(f"  - {o['id']}  {o.get('name')}")
    for o in orgs:
        cleanup_demo_org(sb, o["id"])
    return len(orgs)


# ─────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────

def get_client():
    import os
    from core.env import load_env  # noqa: PLC0415
    from supabase import create_client  # noqa: PLC0415
    load_env()
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])


def _hash_fn(real: bool):
    """Mirrors support_db_client_users.py's _hash_password 1:1 -- same library,
    same cost factor -- so seeded accounts log in through the real
    authenticate_client_user() path with no backend changes. In --dry-run the
    hash is irrelevant and bcrypt may not be installed, so it's stubbed."""
    if not real:
        return lambda pw: "dry-run-not-a-real-hash"
    import bcrypt  # noqa: PLC0415
    return lambda pw: bcrypt.hashpw(pw.encode("utf-8"), bcrypt.gensalt(12)).decode("utf-8")


def _print_summary(ds: Dataset, summary: dict) -> None:
    print("\n" + "=" * 72)
    print(f"{ORG_NAME}   org_id = {ds.org_id}")
    print(f"Window: {summary['window']['start']} .. {summary['window']['end']}  "
          f"({summary['window']['days']} days)")
    print("Headcount: " + ", ".join(f"{k} {v}" for k, v in summary["headcount"].items())
          + f"  (total {len(ds.staff)})")
    print("\nRows: " + ", ".join(f"{k}={v}" for k, v in summary["row_counts"].items()))
    print("\nLeave approved by type: " + ", ".join(
        f"{k} {v:g}d" for k, v in summary["leave"]["approved_days_by_type"].items()))
    print(f"Leave pending: {summary['leave']['pending_requests']}   "
          f"rejected: {summary['leave']['rejected_requests']}")
    print(f"Overtime: {summary['overtime']['requests']} requests, "
          f"{summary['overtime']['approved_hours']:g}h approved "
          f"({summary['overtime']['pending_hours']:g}h pending)")
    print("\nPayroll periods")
    print(f"  {'period':<26} {'status':<12} {'gross':>14} {'deductions':>13} {'net':>14}")
    for p in summary["payroll_periods"]:
        print(f"  {p['period']:<26} {p['status']:<12} {p['gross']:>14,.0f} "
              f"{p['deductions']:>13,.0f} {p['net']:>14,.0f}")
    print("=" * 72)


def seed(cleanup_first: bool = True, out_dir: Path | None = None) -> str:
    sb = get_client()
    if cleanup_first:
        cleanup_all_demo_orgs(sb)
        print()

    ds = build_dataset(_hash_fn(real=True))
    errors = verify_dataset(ds)
    if errors:
        print(f"\nABORTED -- {len(errors)} consistency failure(s), nothing was written:")
        for e in errors[:25]:
            print(f"  ! {e}")
        raise SystemExit(1)
    print(f"Consistency check passed ({len(ds.attendance):,} attendance rows, "
          f"{len(ds.payroll)} payslips recomputed and matched).\n")

    push_dataset(sb, ds)
    summary = summarize(ds)
    _write_artifacts(ds, summary, out_dir or Path.cwd())
    _print_summary(ds, summary)
    print("Client Dashboard login:")
    print(f"  Admin -> principal@{DEMO_EMAIL_DOMAIN} / {DEMO_LOGIN_PASSWORD}")
    print(f"  HR    -> hr@{DEMO_EMAIL_DOMAIN} / {DEMO_LOGIN_PASSWORD}")
    print(f"To delete later:  python -m scripts.seed_demo_org --cleanup {ds.org_id}")
    return ds.org_id


def _write_artifacts(ds: Dataset, summary: dict, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "demo_seed_summary.json").write_text(json.dumps(summary, indent=2))
    (out_dir / "demo_leave_balances.json").write_text(
        json.dumps([_public(b) for b in ds.leave_balances], indent=2)
    )
    print(f"\nWrote demo_seed_summary.json and demo_leave_balances.json to {out_dir}")


def dry_run(out_dir: Path) -> int:
    ds = build_dataset(_hash_fn(real=False))
    errors = verify_dataset(ds)
    summary = summarize(ds)
    _print_summary(ds, summary)
    _write_artifacts(ds, summary, out_dir)
    if errors:
        print(f"\n{len(errors)} CONSISTENCY FAILURE(S):")
        for e in errors[:25]:
            print(f"  ! {e}")
        return 1
    print("\nConsistency check PASSED -- payroll recomputed from attendance, "
          "leave and overtime rows matches every payslip.")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[2])
    parser.add_argument("--dry-run", action="store_true",
                        help="Generate and verify in memory; touch no database")
    parser.add_argument("--no-cleanup", action="store_true",
                        help="Seed without deleting previously seeded demo orgs first")
    parser.add_argument("--cleanup", metavar="ORG_ID", help="Delete one previously seeded demo org")
    parser.add_argument("--cleanup-all", action="store_true",
                        help="Delete every org this script has ever seeded")
    parser.add_argument("--purge-orphans", action="store_true",
                        help="Delete child rows (salary_configs etc.) left behind by an "
                             "earlier cleanup whose organization no longer exists")
    parser.add_argument("--verify", metavar="ORG_ID",
                        help="Re-run the consistency checks against a seeded org (regenerates "
                             "deterministically and re-verifies the arithmetic)")
    parser.add_argument("--out", metavar="DIR", default=".",
                        help="Where to write the summary/balance JSON (default: cwd)")
    args = parser.parse_args()

    out = Path(args.out).resolve()

    if args.dry_run:
        raise SystemExit(dry_run(out))
    if args.cleanup:
        cleanup_demo_org(get_client(), args.cleanup)
    elif args.cleanup_all:
        cleanup_all_demo_orgs(get_client())
    elif args.purge_orphans:
        purge_orphan_rows(get_client())
    elif args.verify:
        raise SystemExit(dry_run(out))
    else:
        seed(cleanup_first=not args.no_cleanup, out_dir=out)