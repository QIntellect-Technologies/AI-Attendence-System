"""
local_node/shift_gate.py

Real-time shift gate for local face-recognition attendance.

Checks two tiers, same precedence order as support_db_attendance_gate.py's
cloud-side resolve_timing_source: a per-staff personal shift override first
(tier 2, client_staff.shift_id_ref, synced down as config["staff_shift_windows"]
keyed by "people_type:person_code"), falling back to the branch's default
shift per people_type (tiers 4/5, config["shift_windows"][people_type]) when
no personal override is synced for that person. Department-level overrides
(tier 3) are still not supported locally and fall through to the branch
default like before.

This gate only decides whether a detection should HOLD locally for manual
review, not the final status — the backend still re-resolves the precise
per-staff status (on_time/late/early/unscheduled) when the record syncs.

CRITICAL BEHAVIOR: Shift Gating Fallback Strategy
──────────────────────────────────────────────────
When NO shift window is found for a person:

  1. If shift_mode_enabled=True (shifts ARE being used on this branch):
     → Return False (mark detection as OUTSIDE shift, hold for review)
     This is the safe default when shift timing rules apply but config
     is missing or sync failed — better to hold and require manual review
     than to silently accept out-of-hours detections.

  2. If shift_mode_enabled=False (shifts are NOT configured):
     → Return True (accept detection, backward-compatible behavior)
     Branches using simple mode or no attendance timing at all don't want
     detections held just because shift_windows are empty.

This dual behavior prevents two classes of bugs:
  - Sync failure: If shift_windows fails to sync but shift mode is active,
    we don't silently accept pre-shift detections (10:04 when shift is 10:10).
  - Configuration drift: If shift mode is disabled but old shift data lingers,
    we don't incorrectly hold all detections.
"""
from __future__ import annotations

from datetime import datetime, time as dt_time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from local_node.config_store import load_config


def _parse_time(value: Any) -> dt_time | None:
    if not value:
        return None
    parts = str(value).split(":")
    if len(parts) < 2:
        return None
    return dt_time(hour=int(parts[0]), minute=int(parts[1]))


def _branch_zone(config: dict[str, Any]) -> ZoneInfo:
    name = str((config.get("branch") or {}).get("timezone") or "UTC").strip() or "UTC"
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def _lookup_personal_window(
    staff_windows: dict[str, Any], people_type_key: str, person_code: str
) -> tuple[dict[str, Any], str]:
    """client_staff.person_code (Staff ID convention, e.g. "0003") and this
    node's own person_code (from the trainer-enrolled embedding package,
    e.g. "3") are the same identity in two string representations — same
    mismatch push_node_attendance() already tolerates cloud-side with a
    digit-aware fallback. get_node_config's resolve_staff_shift_windows now
    stores both the raw and zero-stripped numeric key for exactly this
    reason, but this node may be running against an older backend that only
    ever wrote the raw key, so this still tries an int-normalized lookup
    locally as a second line of defense: an exact match first, then (only
    for purely-numeric codes) match after stripping leading zeros from
    both sides. Returns (window, key_actually_used) so callers can report
    which lookup path found it."""
    raw_key = f"{people_type_key}:{person_code}"
    window = staff_windows.get(raw_key)
    if window:
        return window, raw_key

    if person_code.isdigit():
        normalized_key = f"{people_type_key}:{str(int(person_code))}"
        window = staff_windows.get(normalized_key)
        if window:
            return window, normalized_key
        # Last resort: scan for any stored key whose person_code segment is
        # numerically equal once its own leading zeros are stripped (covers
        # a backend that sent "0003" while this node's person_code is "3").
        for key, candidate_window in staff_windows.items():
            prefix, _, candidate_code = key.partition(":")
            if prefix == people_type_key and candidate_code.isdigit() and int(candidate_code) == int(person_code):
                return candidate_window, key

    return {}, raw_key


# NEW — added after _lookup_personal_window, before resolve_window_for_debug

def _event_local_date(event_dt_utc: datetime, cfg: dict[str, Any]) -> str:
    """Branch-local calendar date for an event, same conversion
    _branch_zone-based date bucketing uses everywhere else in this
    codebase (see local_db._today()) — this is what a manual instruction's
    attendance_date must match for it to apply to this specific event."""
    dt = event_dt_utc if event_dt_utc.tzinfo else event_dt_utc.replace(tzinfo=timezone.utc)
    return dt.astimezone(_branch_zone(cfg)).date().isoformat()


def _lookup_manual_instruction(
    instructions: list[dict[str, Any]], people_type_key: str, person_code: str, date_str: str
) -> dict[str, Any]:
    """Highest-precedence gating tier — a per-date operator override beats
    both the personal shift (tier 2) and the branch default (tiers 4/5).
    Config carries the raw list from get_node_config's
    list_pending_manual_instructions_for_branch (same query
    /v1/node/poll-manual-instructions already runs), so this does the
    date+people_type+person_code match locally rather than pre-keying it
    server-side — same digit-normalizing fallback as
    _lookup_personal_window for the client_staff "0003" vs
    trainer-enrolled "3" mismatch. Returns {} (not merged with any shift)
    on no match, since a matched instruction is fully authoritative for
    that date, including a deliberately omitted checkout meaning "none
    expected today" rather than "fall back to the shift's checkout"."""
    for inst in instructions:
        if inst.get("attendance_date") != date_str:
            continue
        if str(inst.get("people_type") or "").lower() != people_type_key:
            continue
        inst_code = str(inst.get("person_code") or "")
        if not inst_code:
            continue
        if inst_code == person_code or (
            inst_code.isdigit() and person_code.isdigit() and int(inst_code) == int(person_code)
        ):
            return {
                "check_in_time": inst.get("check_in_time"),
                "check_in_grace_minutes": inst.get("check_in_grace_minutes") or 0,
                "check_out_time": inst.get("check_out_time"),
                "check_out_grace_minutes": inst.get("check_out_grace_minutes") or 0,
            }
    return {}

def resolve_window_for_debug(
    people_type: str, person_code: str | None, config: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Diagnostic wrapper around _resolve_window: reports not just the
    merged window but which tier actually supplied it, so a caller logging
    a detection can distinguish "personal override applied", "fell back to
    branch default", and "no window configured at all" without having to
    re-derive that from the merged dict alone. Use this at the call site
    (camera_stream_manager._detect_and_record) to log ground truth for
    every gate decision instead of guessing after the fact whether a stale
    config poll or a person_code mismatch caused a fallback."""
    cfg = config or load_config()
    people_type_key = str(people_type or "staff").lower()
    branch_window = (cfg.get("shift_windows") or {}).get(people_type_key) or {}
    personal_window: dict[str, Any] = {}
    lookup_key = None
    if person_code:
        staff_windows = cfg.get("staff_shift_windows") or {}
        personal_window, lookup_key = _lookup_personal_window(
            staff_windows, people_type_key, str(person_code).strip()
        )

    shift_mode_enabled = cfg.get("shift_mode_enabled", False)
    return {
        "lookup_key": lookup_key,
        "personal_override_found": bool(personal_window),
        "branch_default_found": bool(branch_window),
        "shift_mode_enabled": shift_mode_enabled,
        "source": "personal" if personal_window else ("branch_default" if branch_window else "none"),
        "effective_window": {**branch_window, **personal_window} or None,
        "staff_shift_windows_count": len(cfg.get("staff_shift_windows") or {}),
    }


# AFTER
def _resolve_window(
    cfg: dict[str, Any], people_type: str, person_code: str | None, event_dt_utc: datetime | None = None,
) -> dict[str, Any] | None:
    """Tier precedence, highest first:
      0. Manual attendance instruction for this exact person + branch-local
         date (fully authoritative — returned as-is, never merged with a
         shift; see _lookup_manual_instruction).
      1. Per-FIELD merge of personal override (tier 2) over branch default
         (tiers 4/5): personal values win, but any field it doesn't specify
         falls back to the branch default for that same field, rather than
         a partial personal window silently disabling gating for the leg
         it left out.
    Mirrors the cloud-side precedence in resolve_timing_source, just
    without the department tier (3), which the node never receives.

    event_dt_utc is optional so existing callers/tests that only need the
    shift tiers keep working — but every real caller in this module now
    passes it, since without an event timestamp there's no way to know
    which date's manual instruction (if any) applies."""
    people_type_key = str(people_type or "staff").lower()

    if event_dt_utc is not None and person_code:
        manual_window = _lookup_manual_instruction(
            cfg.get("manual_instructions") or [],
            people_type_key,
            str(person_code).strip(),
            _event_local_date(event_dt_utc, cfg),
        )
        if manual_window:
            return manual_window

    branch_window = (cfg.get("shift_windows") or {}).get(people_type_key) or {}
    personal_window: dict[str, Any] = {}
    if person_code:
        staff_windows = cfg.get("staff_shift_windows") or {}
        personal_window, _ = _lookup_personal_window(
            staff_windows, people_type_key, str(person_code).strip()
        )
    if not branch_window and not personal_window:
        return None
    return {**branch_window, **personal_window}


def is_check_in_window_closed(
    people_type: str,
    event_dt_utc: datetime,
    *,
    config: dict[str, Any] | None = None,
    person_code: str | None = None,
) -> bool:
    """True if event_dt_utc falls AFTER the check-in window has already
    closed for today (local time > check_in_time + grace) — meaning there
    is no remaining chance today for a later, genuinely on-time sighting
    to still claim the check-in slot instead.

    This exists to fix a real bug in local_db.record_attendance_local's
    per-leg state machine: is_event_within_shift alone can't distinguish
    "too EARLY — window hasn't opened yet, a later on-time sighting should
    still get to confirm the slot" from "too LATE — window already closed,
    it will never open again today". Both look identical as "not within
    the window" to is_event_within_shift, but they need opposite handling:
    an early stray must stay unconfirmed (so a real on-time arrival can
    still claim it), while a late arrival must confirm on THIS sighting —
    otherwise a person who simply arrives late never gets a confirmed
    check-in at all, and therefore never transitions to the checkout leg
    either, for the rest of the day.

    Returns False (never treat as "closed") when there's no window to
    evaluate against — same "nothing configured, don't gate" default used
    everywhere else in this module.
    """
    cfg = config or load_config()
    window = _resolve_window(cfg, people_type, person_code, event_dt_utc)
    if not window:
        return False

    target = _parse_time(window.get("check_in_time"))
    if not target:
        return False

    grace = int(window.get("check_in_grace_minutes") or 0)
    dt = event_dt_utc if event_dt_utc.tzinfo else event_dt_utc.replace(tzinfo=timezone.utc)
    local = dt.astimezone(_branch_zone(cfg))
    local_minutes = local.hour * 60 + local.minute
    target_minutes = target.hour * 60 + target.minute
    return local_minutes > (target_minutes + grace)


def is_event_within_shift(
    people_type: str,
    event_dt_utc: datetime,
    *,
    is_check_out: bool = False,
    config: dict[str, Any] | None = None,
    person_code: str | None = None,
) -> bool:
    """True if no window is configured for this person (neither a personal
    override nor a branch default for their people_type -> nothing to gate
    against -> never hold, unchanged pre-feature behavior), or if
    event_dt_utc falls within [target - grace, target + grace] in the
    branch's own local time, evaluated against whichever window applies:
    the person's own synced shift if one exists, otherwise the branch
    default for their people_type.
    
    CRITICAL: When shift_mode_enabled is True but no window found, this
    returns False (marking event as OUTSIDE shift) — not the pre-feature
    fallback of True. This prevents the dangerous case where missing
    shift_windows (sync failure, misconfiguration) silently allows
    out-of-hours detections to sync. The fallback (return True) only
    applies when shift gating is explicitly disabled for this branch."""
    cfg = config or load_config()
    window = _resolve_window(cfg, people_type, person_code, event_dt_utc)
    if not window:
        # Check if shift mode is explicitly enabled but unconfigured.
        # If so, mark as outside_shift (safer default). Only fallback to
        # pre-feature behavior (return True) if shift mode is disabled.
        shift_mode_enabled = cfg.get("shift_mode_enabled", False)
        if shift_mode_enabled:
            # Shift mode is ON but this person has NO shift window → outside shift
            return False
        # Shift mode is OFF → no gating, accept all detections (backward compat)
        return True

    target_key = "check_out_time" if is_check_out else "check_in_time"
    grace_key = "check_out_grace_minutes" if is_check_out else "check_in_grace_minutes"
    target = _parse_time(window.get(target_key))
    if not target:
        return True

    grace = int(window.get(grace_key) or 0)
    dt = event_dt_utc if event_dt_utc.tzinfo else event_dt_utc.replace(tzinfo=timezone.utc)
    local = dt.astimezone(_branch_zone(cfg))
    local_minutes = local.hour * 60 + local.minute
    target_minutes = target.hour * 60 + target.minute
    return (target_minutes - grace) <= local_minutes <= (target_minutes + grace)


def classify_check_out_timing(
    people_type: str,
    event_dt_utc: datetime,
    *,
    config: dict[str, Any] | None = None,
    person_code: str | None = None,
) -> str:
    """Classify a checkout-leg sighting as 'early' (before the checkout
    window opens, target - grace), 'late' (after the checkout window
    closes, target + grace), or 'within'.

    This is the checkout-leg counterpart to is_check_in_window_closed: that
    function only needed a boolean (has the check-in window's one-sided
    deadline passed), but the checkout leg is symmetric — a sighting can
    miss the window on either side, and record_attendance_local's held-
    review flow needs to know WHICH side to pick the right hold reason
    (check_out_hold_reason='early'|'late') and therefore which operator
    resolution actions apply (half-day is only offered for 'early', leave-
    open only for 'late').

    Uses the exact same window resolution (_resolve_window, same tier
    precedence) and branch-local time conversion as is_event_within_shift,
    so a caller that already determined "outside window" via that function
    gets a consistent answer here rather than a second, differently-tuned
    window calculation.

    Returns 'within' both when the event turns out to actually be inside
    the window on re-evaluation (defensive; callers should not normally
    reach this after already failing is_event_within_shift) and when no
    window can be resolved at all — either way there is nothing to hold
    against, so the caller should treat that the same as "don't hold"."""
    cfg = config or load_config()
    window = _resolve_window(cfg, people_type, person_code, event_dt_utc)
    if not window:
        return "within"

    target = _parse_time(window.get("check_out_time"))
    if not target:
        return "within"

    grace = int(window.get("check_out_grace_minutes") or 0)
    dt = event_dt_utc if event_dt_utc.tzinfo else event_dt_utc.replace(tzinfo=timezone.utc)
    local = dt.astimezone(_branch_zone(cfg))
    local_minutes = local.hour * 60 + local.minute
    target_minutes = target.hour * 60 + target.minute

    if local_minutes < (target_minutes - grace):
        return "early"
    if local_minutes > (target_minutes + grace):
        return "late"
    return "within"


def resolve_leg_ready_at_utc(
    people_type: str,
    person_code: str | None,
    event_dt_utc: datetime,
    *,
    is_check_out: bool,
    config: dict[str, Any] | None = None,
) -> str | None:
    """UTC instant this leg becomes sync-ready: shift's grace window close
    (target_time + grace) PLUS that same shift's own sync_delay_minutes —
    both now shift-owned, so this is the complete, final anchor. Returns
    None when no window resolves (delay-only fallback then applies from
    the branch-wide cfg default at the caller)."""
    cfg = config or load_config()
    window = _resolve_window(cfg, people_type, person_code, event_dt_utc)
    if not window:
        return None

    target_key = "check_out_time" if is_check_out else "check_in_time"
    grace_key = "check_out_grace_minutes" if is_check_out else "check_in_grace_minutes"
    target = _parse_time(window.get(target_key))
    if not target:
        return None
    grace = int(window.get(grace_key) or 0)
    delay = int(window.get("sync_delay_minutes") or 0)

    zone = _branch_zone(cfg)
    local_date = event_dt_utc.astimezone(zone).date()
    target_local = datetime.combine(local_date, target, tzinfo=zone)
    ready_at_local = target_local + timedelta(minutes=grace + delay)
    return ready_at_local.astimezone(timezone.utc).isoformat()

