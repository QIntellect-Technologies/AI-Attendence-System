"""
support_db_shift_overlap.py
──────────────────────────────────────────────────────────────────────────────
The ONE definition of "do these two shifts collide?" in this codebase.

Why this is its own module (and not inlined into support_db_shifts.py):
four separate call sites need the identical answer and must never be allowed
to drift apart —

  1. support_db_shifts.create_shift   — reject a new overlapping shift
  2. support_db_shifts.update_shift   — reject an edit that creates an overlap
  3. support_db_shifts.assign_staff_shift — explain what a reassignment replaces
  4. support_db_attendance_settings   — branch default must not collide either

Same "shared helpers, no circular import" split already used by
support_db_time_utils.py, which this module builds on for HH:MM parsing.

──────────────────────────────────────────────────────────────────────────────
THE MODEL

A shift owns a window on a 1440-minute circular clock. Two spans are derived
from every shift, and they answer two different questions:

  duty span   [check_in_time, check_out_time)
              Who is on the clock. Two shifts whose DUTY spans intersect are
              a hard conflict: a punch inside the intersection cannot be
              attributed to one shift, which is exactly the undefined state
              this module exists to prevent.

  claim span  [check_in_time, check_out_time + checkout_grace_minutes)
              Duty plus the trailing grace the gate still accepts punches in.
              Two shifts whose CLAIM spans intersect but whose DUTY spans do
              not are a soft warning, not an error — back-to-back shifts
              (Morning 09:00–17:00 → Evening 17:00–01:00) are a completely
              normal roster and must stay creatable. Only their grace tails
              bleed, and the gate resolves that by check-in proximity.

Half-open intervals throughout, so an end that lands exactly on the next
shift's start is adjacency, not overlap.

Open-ended shifts (capture_check_out off, so no check_out_time) claim only
their check-in window: [check_in_time, check_in_time + grace_minutes).
There is no checkout leg to own any time beyond it.

Overnight shifts (22:00 → 06:00) wrap midnight. Every span is normalized to
one or two flat segments before comparison, so wrap is handled once, here,
rather than at each call site — the same convention shift_gate.py uses to
bucket an overnight checkout to the previous calendar day.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Optional, Sequence

from support_db_time_utils import clean_text as _clean_text

DAY_MINUTES = 24 * 60

# A conflict check is only meaningful within one scope. Shifts in different
# branches, or for different people_types in the same branch, never compete
# for the same punch, so they are never compared.
SCOPE_KEYS = ("branch_id", "people_type")


# ─── Errors ─────────────────────────────────────────────────────────────────

class ShiftConflictError(ValueError):
    """A shift's duty span intersects an existing shift in the same
    branch + people_type.

    Subclasses ValueError so any handler that already maps ValueError to a
    clean 400 keeps working unchanged; client_routes_helpers.handle() checks
    for this type first and upgrades it to 409 with the structured
    `conflicts` payload the UI renders.
    """

    def __init__(self, message: str, conflicts: Sequence["ShiftConflict"]):
        super().__init__(message)
        self.conflicts = list(conflicts)

    def to_payload(self) -> list[dict]:
        return [c.to_dict() for c in self.conflicts]


# ─── Value types ────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ShiftConflict:
    """One colliding pair, described in the terms the admin sees in the UI."""
    shift_id: Optional[str]
    shift_name: str
    # "conflict" — duty hours are shared. Informational: normal for a
    #              staggered roster, only blocking under strict=True.
    # "warning"  — only the trailing grace windows touch (handover bleed).
    severity: str
    overlap_minutes: int
    window: str              # human-readable "09:00–17:00" of the other shift

    def to_dict(self) -> dict:
        return {
            "shift_id": self.shift_id,
            "shift_name": self.shift_name,
            "severity": self.severity,
            "overlap_minutes": self.overlap_minutes,
            "window": self.window,
        }

    def describe(self) -> str:
        if self.severity == "conflict":
            return (
                f'Shares {self.overlap_minutes} minute(s) with "{self.shift_name}" '
                f"({self.window})"
            )
        return (
            f'The grace window of "{self.shift_name}" ({self.window}) runs '
            f"{self.overlap_minutes} minute(s) into this shift"
        )


# ─── Parsing ────────────────────────────────────────────────────────────────

def to_minutes(value: Any) -> Optional[int]:
    """"HH:MM" / "HH:MM:SS" → minutes past midnight. None for blank/invalid,
    so callers can treat "no checkout configured" and "garbage in the column"
    the same benign way instead of raising mid-comparison. Input that reaches
    a write path has already been through validate_time_string()."""
    text = _clean_text(value)
    if not text:
        return None
    parts = text.split(":")
    if len(parts) < 2:
        return None
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except (TypeError, ValueError):
        return None
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return hour * 60 + minute


def _format_time(value: Any) -> str:
    """Renders a stored time as HH:MM. Reformats from the PARSED minutes
    rather than slicing the raw string — a slice turns an unparseable value
    into a plausible-looking truncation ("not-a-time" → "not-a") and puts
    that in front of an admin as if it were a real time. An unparseable
    value is echoed back whole so it's recognizable as the bad data it is."""
    minutes = to_minutes(value)
    if minutes is None:
        return _clean_text(value) or "??:??"
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def format_window(shift: dict) -> str:
    """"09:00–17:00", or "09:00 (open-ended)" when checkout isn't captured."""
    start = _format_time(shift.get("check_in_time"))
    end = _clean_text(shift.get("check_out_time"))
    return (
        f"{start}–{_format_time(end)}" if end else f"{start} (open-ended)"
    )


# ─── Circular-clock segment math ────────────────────────────────────────────

def _segments(start: int, length: int) -> list[tuple[int, int]]:
    """A span of `length` minutes beginning at `start`, flattened into one or
    two non-wrapping [begin, end) segments on a 0..1440 line."""
    start %= DAY_MINUTES
    length = max(0, min(length, DAY_MINUTES))
    if length == 0:
        return []
    end = start + length
    if end <= DAY_MINUTES:
        return [(start, end)]
    return [(start, DAY_MINUTES), (0, end - DAY_MINUTES)]


def _span_length(start: int, end: int) -> int:
    """Forward distance start → end on the circular clock. A shift whose
    check-out equals its check-in is a full 24-hour shift, not a zero-length
    one — that reading is the only one that makes sense for a round-the-clock
    post, and a 0 here would silently make it collide with nothing."""
    delta = (end - start) % DAY_MINUTES
    return delta or DAY_MINUTES


def _overlap_minutes(
    a: Iterable[tuple[int, int]], b: Iterable[tuple[int, int]]
) -> int:
    """Total minutes shared by two flattened segment lists."""
    total = 0
    b_list = list(b)
    for a_start, a_end in a:
        for b_start, b_end in b_list:
            total += max(0, min(a_end, b_end) - max(a_start, b_start))
    return total


# ─── Span derivation ────────────────────────────────────────────────────────

def duty_segments(shift: dict) -> list[tuple[int, int]]:
    """[check_in, check_out) — or the check-in grace window for an
    open-ended shift, which owns nothing past it."""
    check_in = to_minutes(shift.get("check_in_time"))
    if check_in is None:
        return []

    check_out = to_minutes(shift.get("check_out_time"))
    if check_out is None:
        grace = max(int(shift.get("grace_minutes") or 0), 1)
        return _segments(check_in, grace)

    return _segments(check_in, _span_length(check_in, check_out))


def claim_segments(shift: dict) -> list[tuple[int, int]]:
    """Duty plus the trailing checkout grace the gate still accepts."""
    check_in = to_minutes(shift.get("check_in_time"))
    if check_in is None:
        return []

    check_out = to_minutes(shift.get("check_out_time"))
    if check_out is None:
        grace = max(int(shift.get("grace_minutes") or 0), 1)
        return _segments(check_in, grace)

    tail = max(0, int(shift.get("checkout_grace_minutes") or 0))
    length = min(_span_length(check_in, check_out) + tail, DAY_MINUTES)
    return _segments(check_in, length)


# ─── The public check ───────────────────────────────────────────────────────

def compare(candidate: dict, other: dict) -> Optional[ShiftConflict]:
    """Classify one pair. None when the two shifts don't touch at all."""
    duty = _overlap_minutes(duty_segments(candidate), duty_segments(other))
    if duty > 0:
        severity, minutes = "conflict", duty
    else:
        claim = _overlap_minutes(claim_segments(candidate), claim_segments(other))
        if claim <= 0:
            return None
        severity, minutes = "warning", claim

    return ShiftConflict(
        shift_id=str(other.get("id")) if other.get("id") else None,
        shift_name=_clean_text(other.get("name")) or "Untitled shift",
        severity=severity,
        overlap_minutes=minutes,
        window=format_window(other),
    )


def in_same_scope(candidate: dict, other: dict) -> bool:
    """Only shifts competing for the same punches are comparable."""
    for key in SCOPE_KEYS:
        if _clean_text(candidate.get(key)) != _clean_text(other.get(key)):
            return False
    return True


def find_conflicts(
    candidate: dict,
    existing: Iterable[dict],
    *,
    exclude_id: str | None = None,
    include_inactive: bool = False,
) -> list[ShiftConflict]:
    """Every collision between `candidate` and the shifts already configured
    for its branch + people_type.

    exclude_id      — the row being edited, so update_shift never reports a
                      shift as conflicting with itself.
    include_inactive— deactivated shifts assign no attendance and so can't
                      create ambiguity; off by default.

    Sorted hard conflicts first, then by size, so a caller that only surfaces
    the first item surfaces the worst one.
    """
    skip = _clean_text(exclude_id)
    found: list[ShiftConflict] = []

    for other in existing:
        if skip and _clean_text(other.get("id")) == skip:
            continue
        if not include_inactive and other.get("is_active") is False:
            continue
        if not in_same_scope(candidate, other):
            continue
        conflict = compare(candidate, other)
        if conflict:
            found.append(conflict)

    found.sort(key=lambda c: (c.severity != "conflict", -c.overlap_minutes))
    return found


def check_overlaps(
    candidate: dict,
    existing: Iterable[dict],
    *,
    exclude_id: str | None = None,
    strict: bool = False,
) -> list[ShiftConflict]:
    """Report how a shift relates to the ones already configured beside it.

    NON-BLOCKING BY DEFAULT, and that default is deliberate.

    Overlapping shifts are a completely normal roster. A café runs Morning
    09:00-17:00 and Evening 14:00-22:00 so two people cover the lunch and
    dinner rushes together; a clinic staggers starts so the desk is never
    empty at handover. Refusing to save those would be a worse bug than the
    one this module was written for.

    Crucially, an overlap creates no resolution ambiguity HERE. Every shift
    lookup in this codebase is by id — client_staff.shift_id_ref,
    departments.default_shift_id, attendance_capture_settings
    .default_shift_id, and the .in_('id', ...) batch reads in
    support_db_payroll / support_db_staff / support_db_fast. Nothing
    anywhere picks a shift by matching a punch time against shift windows,
    so a 15:00 punch resolves through the punching person's own assigned
    shift and is never a choice between two candidates. Alice on Morning
    and Bob on Evening both punch at 15:00 and both resolve correctly.

    What IS worth surfacing is that the admin may not have meant it —
    especially when the same person is being moved between two shifts that
    share hours. So this returns what it found and lets the caller show it.

    strict=True restores hard rejection, for an org that genuinely runs a
    tiling roster and wants the invariant enforced. Nothing passes it today
    except the audit script's --strict mode; it exists so enforcement is one
    flag away rather than a rewrite.
    """
    conflicts = find_conflicts(candidate, existing, exclude_id=exclude_id)

    if strict:
        blocking = [c for c in conflicts if c.severity == "conflict"]
        if blocking:
            name = _clean_text(candidate.get("name")) or "This shift"
            detail = "; ".join(c.describe() for c in blocking)
            raise ShiftConflictError(
                f"{name} ({format_window(candidate)}) overlaps an existing "
                f"shift in this branch: {detail}.",
                blocking,
            )

    return conflicts