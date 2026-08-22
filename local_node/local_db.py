from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone, date
from typing import Any, Iterable
import threading

from local_node.config_store import DB_PATH as LOCAL_DB_PATH
from local_node import shift_gate

# Process-global lock to serialize local DB write paths and avoid
# TOCTOU races between threads in this process.
_write_lock = threading.Lock()


def _connect() -> sqlite3.Connection:
    """Single connection factory for every call site in this module.
    WAL mode replaces the default rollback-journal's two blocking
    fsync()s per commit (write journal -> fsync -> write db -> fsync ->
    delete journal) with an append-only log — this is what turns an
    ordinary attendance write into a multi-second stall under real-time
    antivirus scanning on Windows. journal_mode=WAL persists in the db
    file itself once set, but synchronous is per-connection and must be
    re-applied every time, which is why this can't just be a one-time
    PRAGMA in init_db()."""
    conn = sqlite3.connect(LOCAL_DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today(cfg: dict[str, Any] | None = None) -> str:
    """Branch-local calendar date — the same timezone the shift gate and
    the cloud's day-window bucketing use (see shift_gate._branch_zone,
    support_db_attendance_gate._get_branch_timezone), not the node
    machine's own system clock. Falls back to shift_gate's own UTC
    default if no branch timezone has synced yet (fresh activation,
    before the first /v1/node/config poll).

    Accepts an already-loaded config so callers that also need
    shift_gate lookups in the same pass (record_attendance_local) don't
    each re-read+re-parse node_config.json from disk for one detection.
    cfg=None preserves the old standalone behavior for every other
    caller (e.g. clear_today_attendance)."""
    zone = shift_gate._branch_zone(cfg or shift_gate.load_config())
    return datetime.now(zone).date().isoformat()

def _ensure_schema_migrations(conn: sqlite3.Connection) -> None:
    """attendance_buffer may already exist on branch machines from earlier
    deployments without these columns. CREATE TABLE IF NOT EXISTS won't
    retrofit those — this PRAGMA-guarded ALTER TABLE lets every already-
    installed local node pick up new columns on next start, with zero
    manual migration step at any client site.

    check_in_confirmed / check_out_confirmed: per-leg "was the value
    currently stored in marked_at / check_out_marked_at actually captured
    inside its shift window" flags — see record_attendance_local. DEFAULT 1
    so pre-existing rows (written before this migration) are treated as
    already finalized and never silently reopened for reconfirmation;
    every new row/update this function's caller writes sets the real value
    explicitly.

    notes: operator-facing free text set by record_attendance_local for
    the "detected early, never seen again inside the shift window, only
    confirmed once it closed" case — see _format_early_before_shift_note.
    Also used for the checkout-leg early/late held-review case — see
    _format_checkout_hold_note. NULL for every other row; no default
    needed.

    check_out_hold_reason: 'early' | 'late' | NULL. Set only while a
    checkout sighting sits in held_for_review (check_out_confirmed=0,
    check_out_marked_at holding the informative-but-unconfirmed sighting
    time) — see record_attendance_local's checkout branch. Cleared back to
    NULL by whichever operator resolution action (mark_held_checkouts_late /
    mark_held_checkouts_overtime / mark_held_checkouts_half_day /
    mark_held_checkouts_short_leave) resolves the row, so its presence
    alone tells the review screen "this row still needs a checkout
    decision" without a separate flag.

    branch_id: SECURITY-RELEVANT retrofit. attendance_buffer previously had
    NO branch scoping at all — every query matched purely on
    (people_type, person_code, attendance_date), and local_event_id was
    just f"{people_type}:{person_code}:{today}". Since this SQLite file
    lives at one fixed path per machine (config_store.DB_PATH) regardless
    of which branch is currently activated, reactivating a machine for a
    DIFFERENT branch made every read/write here silently operate across
    branches — a stale row from a previous branch with the same
    people_type+person_code (very plausible with small numeric codes like
    "0001") would be read, shown in held-review, and even overwritten by
    the new branch's detections. DEFAULT '' means every row written before
    this migration is retroactively "no branch" — which never matches a
    real (non-empty Supabase UUID) branch_id in any query below, so it's
    automatically and permanently excluded from every branch-scoped query
    without a destructive DELETE. It is NOT backfilled to the current
    branch_id, since a mixed-branch machine could have rows from more than
    one branch and there's no way to tell them apart after the fact —
    quarantining beats guessing. These orphaned '' rows are otherwise
    inert and can be purged manually if disk space matters."""
    existing_columns = {row[1] for row in conn.execute("PRAGMA table_info(attendance_buffer)").fetchall()}
    additions = {
        "check_out_marked_at": "TEXT",
        "check_out_confidence": "REAL",
        "check_out_camera_id": "TEXT",
        "check_out_metadata": "TEXT NOT NULL DEFAULT '{}'",
        "check_in_confirmed": "INTEGER NOT NULL DEFAULT 1",
        "check_out_confirmed": "INTEGER NOT NULL DEFAULT 1",
        "notes": "TEXT",
        "check_out_hold_reason": "TEXT",
        # 'late' | NULL. Set only while a check-in sighting sits in
        # held_for_review because it arrived after the check-in window
        # closed — mirrors check_out_hold_reason. There's only ever one
        # value ('late'): unlike checkout, an early check-in stray isn't a
        # "hold reason" needing a decision — it's just "still waiting for
        # the window", which check_in_hold_reason=NULL already represents.
        # Cleared by mark_held_check_ins_short_leave / mark_held_check_ins_half_day.
        "check_in_hold_reason": "TEXT",
        "branch_id": "TEXT NOT NULL DEFAULT ''",
    }
    for column, ddl_type in additions.items():
        if column not in existing_columns:
            conn.execute(f"ALTER TABLE attendance_buffer ADD COLUMN {column} {ddl_type}")


def reset_local_data() -> None:
    """Wipe every locally-cached table (attendance_buffer, staff_embeddings,
    imported_packages) and recreate them fresh via init_db(). Called from
    activation.activate_with_token() whenever a machine activates for a
    branch different from whatever it was previously configured for (or is
    activating for the very first time) — see that function's comment for
    the exact "reset vs. preserve" decision.

    Why this exists on top of branch_id scoping (see
    _ensure_schema_migrations' branch_id docstring): since this machine's
    SQLite file lives at one fixed path regardless of which branch is
    currently activated (config_store.DB_PATH), branch_id scoping stops a
    reactivated machine's OLD data from ever being READ or WRITTEN
    across branches — but on its own it just quarantines that old data
    forever rather than removing it. For a machine being redeployed to a
    genuinely different client/branch (returned hardware, support
    reimaging a device, a client's exe reused on new premises), the
    correct behavior isn't "keep it quarantined indefinitely", it's "this
    machine has no business holding that data at all anymore" —
    activation is the one moment that's unambiguously true, so that's
    where the actual wipe belongs. Branch scoping remains as defense in
    depth for any path that reaches attendance_buffer without going
    through activation (there isn't one today, but a future refactor
    could introduce one without realizing this guarantee depended on it).

    Uses DROP + recreate (via init_db()) rather than DELETE FROM, so the
    recreated schema is always exactly current — no lingering columns from
    whatever schema-migration state the previous branch's install had
    reached. Does NOT touch config_store's own JSON config file; that's a
    separate concern already fully overwritten by save_config() in the
    same activation flow.
    """
    with _connect() as conn:
        conn.execute("DROP TABLE IF EXISTS attendance_buffer")
        conn.execute("DROP TABLE IF EXISTS staff_embeddings")
        conn.execute("DROP TABLE IF EXISTS imported_packages")
        conn.commit()
    init_db()


def init_db() -> None:
    with _connect() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS staff_embeddings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                branch_id TEXT NOT NULL,
                people_type TEXT NOT NULL,
                person_code TEXT NOT NULL,
                full_name TEXT NOT NULL DEFAULT '',
                staff_id TEXT,
                embedding_index INTEGER NOT NULL DEFAULT 0,
                embedding TEXT NOT NULL,
                embedding_dim INTEGER NOT NULL DEFAULT 0,
                model_version TEXT,
                source_package_id TEXT,
                imported_at TEXT NOT NULL,
                UNIQUE (branch_id, people_type, person_code, embedding_index)
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_staff_embeddings_person "
            "ON staff_embeddings(branch_id, people_type, person_code)"
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS imported_packages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                package_id TEXT NOT NULL,
                branch_label TEXT,
                generated_at TEXT,
                record_count INTEGER NOT NULL DEFAULT 0,
                imported_count INTEGER NOT NULL DEFAULT 0,
                skipped_count INTEGER NOT NULL DEFAULT 0,
                imported_at TEXT NOT NULL
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS attendance_buffer (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                local_event_id TEXT NOT NULL UNIQUE,
                branch_id TEXT NOT NULL DEFAULT '',
                people_type TEXT NOT NULL,
                person_code TEXT NOT NULL,
                staff_name TEXT NOT NULL DEFAULT '',
                attendance_date TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'present',
                confidence REAL NOT NULL,
                source TEXT NOT NULL,
                camera_id TEXT,
                metadata TEXT NOT NULL DEFAULT '{}',
                marked_at TEXT NOT NULL,
                sync_status TEXT NOT NULL DEFAULT 'pending',
                sync_error TEXT,
                synced_at TEXT
            )
            """
        )
        _ensure_schema_migrations(conn)

        # Created after the migration above (not right after CREATE TABLE)
        # because branch_id only exists unconditionally once
        # _ensure_schema_migrations has run — on a pre-existing install,
        # CREATE INDEX referencing branch_id here would fail if it ran
        # before the ALTER TABLE that adds the column.
        #
        # MUST be UNIQUE: record_attendance_local's upserts (see the two
        # ON CONFLICT(branch_id, people_type, person_code, attendance_date)
        # sites below) require the conflict target to be backed by a UNIQUE
        # index or PRIMARY KEY — SQLite raises "ON CONFLICT clause does not
        # match any PRIMARY KEY or UNIQUE constraint" against a plain index,
        # which is exactly what every attendance mark hit while this index
        # was non-unique. CREATE UNIQUE INDEX IF NOT EXISTS alone is not
        # enough to repair an install that already has the old plain index:
        # IF NOT EXISTS sees a same-named index and silently no-ops, so the
        # crash would persist on every existing deployment while looking
        # fixed on a fresh one. Detect that case explicitly, dedupe the rows
        # the old non-unique index allowed to collide (keeping the highest
        # id — local_event_id/id is monotonically increasing on insert, so
        # MAX(id) is the newest row per tuple), drop the stale index, then
        # recreate it unique. Guarded on index_is_unique so this dedupe scan
        # runs once per install, not on every process start.
        index_is_unique = any(
            row[1] == "idx_attendance_branch_person_date" and row[2]
            for row in cur.execute("PRAGMA index_list(attendance_buffer)").fetchall()
        )
        if not index_is_unique:
            cur.execute(
                """
                DELETE FROM attendance_buffer
                WHERE id NOT IN (
                    SELECT MAX(id) FROM attendance_buffer
                    GROUP BY branch_id, people_type, person_code, attendance_date
                )
                """
            )
            cur.execute("DROP INDEX IF EXISTS idx_attendance_branch_person_date")
            cur.execute(
                "CREATE UNIQUE INDEX idx_attendance_branch_person_date "
                "ON attendance_buffer(branch_id, people_type, person_code, attendance_date)"
            )
        conn.commit()


# ── Embedding import (per-person upsert) ────────────────────────────────────

def upsert_person_embeddings(
    branch_id: str,
    people_type: str,
    person_code: str,
    full_name: str,
    embeddings: list[list[float]],
    model_version: str,
    source_package_id: str,
) -> int:
    """Replace embeddings for exactly one person, leaving every other person
    in this branch untouched. This is the core primitive for incremental zip
    imports — never delete-then-insert at the branch level for this flow."""
    now = utc_now()
    with _connect() as conn:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM staff_embeddings WHERE branch_id = ? AND people_type = ? AND person_code = ?",
            (branch_id, people_type, person_code),
        )
        for index, embedding in enumerate(embeddings):
            cur.execute(
                """
                INSERT INTO staff_embeddings (
                    branch_id, people_type, person_code, full_name, embedding_index,
                    embedding, embedding_dim, model_version, source_package_id, imported_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    branch_id, people_type, person_code, full_name, index,
                    json.dumps(embedding, separators=(",", ":")), len(embedding),
                    model_version, source_package_id, now,
                ),
            )
        conn.commit()
    return len(embeddings)


def import_embedding_package(
    branch_id: str,
    package_id: str,
    branch_label: str,
    generated_at: str,
    records: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    """Apply every person record from a parsed zip package. Idempotent —
    re-importing the same package produces the same end state."""
    imported, skipped, errors = 0, 0, []
    for record in records:
        try:
            count = upsert_person_embeddings(
                branch_id=branch_id,
                people_type=str(record["people_type"]),
                person_code=str(record["person_code"]),
                full_name=str(record.get("full_name") or ""),
                embeddings=record["embeddings"],
                model_version=str(record.get("model_version") or ""),
                source_package_id=package_id,
            )
            if count > 0:
                imported += 1
            else:
                skipped += 1
        except Exception as exc:
            skipped += 1
            errors.append(f"{record.get('people_type')}:{record.get('person_code')}: {exc}")

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO imported_packages
                (package_id, branch_label, generated_at, record_count, imported_count, skipped_count, imported_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (package_id, branch_label, generated_at, imported + skipped, imported, skipped, utc_now()),
        )
        conn.commit()

    return {"imported": imported, "skipped": skipped, "errors": errors}


def get_all_embeddings(branch_id: str) -> list[dict[str, Any]]:
    with _write_lock:
        with _connect() as conn:
            conn.row_factory = sqlite3.Row
            # Reduce contention and allow concurrent readers; wait briefly
            # if the DB is busy rather than erroring immediately.
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=5000")
            cur = conn.cursor()
        cur.execute(
            "SELECT * FROM staff_embeddings WHERE branch_id = ? ORDER BY people_type, person_code, embedding_index",
            (branch_id,),
        )
        return [dict(row) | {"embedding": json.loads(row["embedding"])} for row in cur.fetchall()]


def import_history(limit: int = 20) -> list[dict[str, Any]]:
    with _connect() as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("SELECT * FROM imported_packages ORDER BY id DESC LIMIT ?", (int(limit or 20),))
        return [dict(row) for row in cur.fetchall()]


# ── Attendance ───────────────────────────────────────────────────────────────

def get_attendance_row(branch_id: str, people_type: str, person_code: str, attendance_date: str) -> dict[str, Any] | None:
    """Read-only peek at one person's attendance_buffer row for a given
    date, without mutating anything. Used by manual_instructions_worker to
    check whether a real camera sighting already landed for this person+date
    before deciding whether to honor its timestamp (within the instruction's
    grace window) or fall back to the admin-typed instructed time.

    branch_id-scoped — without it, this could return a different branch's
    stale row for the same people_type+person_code (e.g. after a machine is
    reactivated for a new branch), causing a manual instruction to honor a
    stranger's sighting time instead of correctly falling back to the
    instructed time. See _ensure_schema_migrations' branch_id docstring."""
    with _connect() as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM attendance_buffer WHERE branch_id = ? AND people_type = ? AND person_code = ? AND attendance_date = ?",
            (branch_id, people_type, person_code, attendance_date),
        )
        row = cur.fetchone()
        if not row:
            return None
        return dict(row) | {"metadata": json.loads(row["metadata"] or "{}")}

def _format_late_check_in_note(
    people_type: str, person_code: str, late_marked_at: str | None,
    early_marked_at: str | None = None, *, held: bool = True,
) -> str | None:
    """Operator-facing note for a check-in sighting arriving after the
    check-in window had already closed — the check-in-leg counterpart to
    _format_checkout_hold_note.

    Two distinct situations share this formatter, distinguished by `held`:
    - held=True (the common case, no earlier sighting that day): the row
      HOLDS for an operator's confirm-as-check-in / mark-half-day decision
      — see record_attendance_local's first-late-sighting-of-the-day path.
    - held=False: an earlier too-early stray (before the window even
      opened) already proved the person was on site that day, so this late
      sighting is auto-confirmed as the real check-in instead of holding —
      the note drops "Awaiting operator decision" accordingly, since there
      is no decision left for an operator to make.

    Rendered in the branch's own local time. Returns None only if there's
    no resolved shift window to quote a check-in time from."""
    if not late_marked_at:
        return None
    cfg = shift_gate.load_config()
    window_info = shift_gate.resolve_window_for_debug(people_type, person_code, cfg)
    shift_check_in = (window_info.get("effective_window") or {}).get("check_in_time")
    if not shift_check_in:
        return None
    try:
        late_dt = datetime.fromisoformat(str(late_marked_at).replace("Z", "+00:00"))
    except Exception:
        return None
    if late_dt.tzinfo is None:
        late_dt = late_dt.replace(tzinfo=timezone.utc)
    late_local = late_dt.astimezone(shift_gate._branch_zone(cfg)).strftime("%H:%M")
    suffix = _PENDING_DECISION_CLAUSE if held else ""

    if early_marked_at:
        try:
            early_dt = datetime.fromisoformat(str(early_marked_at).replace("Z", "+00:00"))
            if early_dt.tzinfo is None:
                early_dt = early_dt.replace(tzinfo=timezone.utc)
            early_local = early_dt.astimezone(shift_gate._branch_zone(cfg)).strftime("%H:%M")
            return (
                f"Seen early at {early_local}, then at {late_local} — after the "
                f"{shift_check_in} shift start.{suffix}"
            )
        except Exception:
            pass
    return f"Detected at {late_local}, late — after the {shift_check_in} shift start.{suffix}"

def _format_checkout_hold_note(
    people_type: str, person_code: str, sighted_at: str | None, hold_reason: str,
) -> str | None:
    """Operator-facing note for a checkout-leg sighting held for review —
    the checkout-leg counterpart to _format_early_before_shift_note. Unlike
    the check-in case (which only ever fires once, when the window finally
    closes), this fires on every held checkout sighting, since a checkout
    hold has no separate "confirm on this one" transition — the row simply
    stays held, its most-recent sighting time and note updated each time,
    until an operator resolves it (see record_attendance_local's checkout
    branch and the three held-checkout resolution functions below).

    Rendered in the branch's own local time, same as every other shift-gate
    time comparison, so the note matches the shift times configured for
    this branch rather than UTC or the node machine's clock.

    Returns None when there's nothing meaningful to quote a checkout time
    from (no resolved shift window) or hold_reason isn't 'early'/'late'.
    """
    if not sighted_at or hold_reason not in ("early", "late"):
        return None
    cfg = shift_gate.load_config()
    window_info = shift_gate.resolve_window_for_debug(people_type, person_code, cfg)
    shift_check_out = (window_info.get("effective_window") or {}).get("check_out_time")
    try:
        sighted_dt = datetime.fromisoformat(str(sighted_at).replace("Z", "+00:00"))
    except Exception:
        return None
    if sighted_dt.tzinfo is None:
        sighted_dt = sighted_dt.replace(tzinfo=timezone.utc)
    sighted_local = sighted_dt.astimezone(shift_gate._branch_zone(cfg)).strftime("%H:%M")

    if hold_reason == "early":
        where = f"before the {shift_check_out} shift end" if shift_check_out else "before their checkout window"
        return f"Left at {sighted_local}, early — {where}."
    where = f"after the {shift_check_out} shift end" if shift_check_out else "after their checkout window"
    return f"Seen at {sighted_local}, late — {where}."


# The notes column holds one string but a single day can accumulate a note
# from EACH leg independently (a late check-in note from the morning, then
# an early/late checkout-hold note in the evening for that same shift).
# Each leg's note is tagged with its own prefix and kept on its own line,
# so writing/refreshing one leg's note can never blow away the other leg's
# — previously both legs shared the same COALESCE(?, notes) write, so
# whichever leg wrote LAST silently erased whatever the other leg had
# already recorded there.
_NOTE_PREFIXES = {
    "check_in": "Check-in: ",
    "check_out": "Check-out: ",
}


def _merge_note(existing_notes: str | None, category: str, new_note: str | None) -> str | None:
    """Return the notes column value with `category`'s line replaced by
    `new_note` (its own leg re-firing updates its own line in place, same
    as before) while leaving any OTHER category's line untouched.

    - new_note=None: leave existing notes exactly as they were — nothing
      new to record for this leg on this call, so this must never disturb
      whatever the other leg already wrote.
    - new_note="" (empty string): explicitly CLEAR this leg's line (e.g. a
      held checkout note that's no longer accurate once a later in-window
      sighting resolves the checkout normally) while still leaving the
      other leg's line untouched.
    - new_note=<text>: set/replace this leg's line with that text.
    """
    if new_note is None:
        return existing_notes

    prefix = _NOTE_PREFIXES[category]
    kept_lines = [
        line for line in (existing_notes or "").split("\n")
        if line.strip() and not line.startswith(prefix)
    ]
    if new_note:
        kept_lines.append(f"{prefix}{new_note}")
    if not kept_lines:
        return None
    # Stable, predictable order regardless of which leg fired most recently
    # — check-in note (if any) always reads before the check-out note.
    ordered = sorted(kept_lines, key=lambda line: 0 if line.startswith(_NOTE_PREFIXES["check_in"]) else 1)
    return "\n".join(ordered)


def record_attendance_local(
    branch_id: str,
    people_type: str,
    person_code: str,
    staff_name: str,
    confidence: float,
    source: str = "camera",
    camera_id: str | None = None,
    metadata: dict[str, Any] | None = None,
    event_dt_utc: datetime | None = None,
) -> dict[str, Any]:
    """Capture a raw presence detection for today, deciding INTERNALLY
    whether it's a check-in or check-out attempt and whether it lands
    inside that leg's shift window — see local_node.shift_gate. This used
    to be the caller's job (camera_stream_manager pre-computed a leg via
    attendance_leg_for_today, purely from "does a row exist yet", then
    passed in a precomputed outside_shift bool). That was wrong: it let
    whichever detection happened to arrive FIRST claim the check-in slot,
    even if it was outside the shift window — so a legitimate, in-window
    arrival that showed up after an early false/loitering detection got
    filed as a check-OUT attempt instead, and the real check-in was lost.
    Folding the decision in here, atomically with the write, fixes that:
    a slot is only ever CONFIRMED by a detection that actually falls
    inside its own window.

    Per-leg state machine (check_in_confirmed / check_out_confirmed):

    · No row yet, or check-in was never confirmed and no checkout has
      happened yet -> this is a check-in ATTEMPT.
        - inside check-in window  -> confirms the check-in. marked_at is
          this detection's time, check_in_confirmed=1, sync_status=pending.
          This is "the first detection IN the shift timing".
        - outside the window, window NOT YET OPEN (early stray) -> held
          candidate. marked_at tracks the most recent such sighting
          (informative for review) but check_in_confirmed stays 0, so a
          later in-window detection can still claim the slot instead of
          being misfiled as a checkout.
        - outside the window, window ALREADY CLOSED (genuinely late) ->
          two different outcomes depending on whether this person was
          ALSO seen earlier that day, before the window even opened:
            · no earlier stray -> HOLDS for an operator decision (mark
              short leave, or mark half-day) rather than auto-confirming.
              This is the first (and possibly only) sighting this person
              gets today, and it's genuinely ambiguous whether it should
              count — see mark_held_check_ins_short_leave / mark_held_check_ins_half_day.
            · an earlier too-early stray WAS already seen (this is the
              row's second sighting today) -> auto-CONFIRMS on this
              detection instead of holding. The early stray is already
              proof the person was on site before the shift even started,
              so there's no real decision left for an operator to make —
              confirming immediately also lets the row transition to
              checkout tracking right away instead of sitting in
              held-for-review purgatory. marked_at becomes this (late)
              detection's time, and notes records the earlier early
              sighting for context (see _format_late_check_in_note's
              held=False wording). Either way, leaving a genuinely-first
              late sighting unconfirmed would strand the person in
              check-in-attempt purgatory for the rest of the day, never
              transitioning to checkout tracking at all. See
              shift_gate.is_check_in_window_closed.

    · Check-in already confirmed -> this is a check-out ATTEMPT.
        - inside check-out window -> check_out_marked_at = this detection's
          time, check_out_confirmed=1, check_out_hold_reason cleared,
          sync_status=pending. Every in-window sighting keeps overwriting
          it, so the LAST detection inside the checkout window is what
          ends up stored, per spec.
        - outside the window, and a checkout is ALREADY confirmed -> the
          row is left completely untouched (event_type=stray_ignored, no
          write at all). Without this, a person re-appearing on camera
          hours after a valid checkout (hallway walk-through, camera
          glitch) would silently overwrite their real checkout with a
          bogus one just for being the most recent sighting.
        - outside the window, no confirmed checkout yet -> HELD for
          review rather than silently discarded. check_out_marked_at
          tracks the most recent such sighting (informative only —
          check_out_confirmed stays 0, so this never syncs as a real
          checkout on its own), check_out_hold_reason records which side
          of the window it missed ('early' — seen before the window
          opened, likely left early; or 'late' — seen after it closed,
          likely stayed late/forgot to check out), and notes captures a
          human-readable timestamp via _format_checkout_hold_note.
          sync_status=held_for_review, so — same as a held check-in — it
          is invisible to the live feed and the normal auto-sync loop
          until an operator resolves it via one of:
            · mark_held_checkouts_late    — late reason only: accept the
              sighted time as the real checkout, flag status='late'.
            · mark_held_checkouts_overtime — late reason only: accept the
              sighted time as the real checkout, flag status='overtime'.
            · mark_held_checkouts_half_day — early reason only: clear the
              checkout, keep the note, flag the day status='half_day'.
            · mark_held_checkouts_short_leave — early reason only: clear
              the checkout, keep the note, flag the day status='short_leave'.
          There is deliberately no "just accept it, no decision needed"
          option, and no defer/leave-open option either — every held
          checkout must resolve immediately to one of the two decisions
          for its hold_reason.
          Held rows carry no date-based expiry (same invariant as held
          check-ins) — they persist across days, unresolved, until an
          operator acts or explicitly syncs them as-is.

    A manual_override row is always authoritative and short-circuits all
    of the above, unchanged from before.
    """
    cfg = shift_gate.load_config()
    today = _today(cfg)
    event_dt = event_dt_utc or datetime.now(timezone.utc)
    now = event_dt.isoformat()

    # AFTER — replace the whole block above with this
    with _write_lock:
        with _connect() as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            cur.execute(
                "SELECT * FROM attendance_buffer WHERE branch_id = ? AND people_type = ? AND person_code = ? AND attendance_date = ?",
                (branch_id, people_type, person_code, today),
            )
            existing = cur.fetchone()
            existing_dict = dict(existing) if existing else None

            if existing_dict is not None and existing_dict.get("source") == "manual_override":
                return {**existing_dict, "already_marked": True, "event_type": "locked_by_manual_override"}

            check_in_already_confirmed = bool(existing_dict["check_in_confirmed"]) if existing_dict else False
            has_checkout_value = bool(existing_dict.get("check_out_marked_at")) if existing_dict else False

            def _apply_checkout_attempt(row: dict[str, Any]) -> dict[str, Any]:
                """Evaluate THIS call's event_dt/now as a checkout-leg sighting
                against an already-checked-in row. Factored out so the exact
                same event can reach here two ways: check-in was already
                confirmed before this call started (the ordinary case), or
                check-in was JUST auto-confirmed a few lines below — from an
                earlier stray sighting, using THAT stray's own timestamp — and
                this event still needs to be evaluated fresh, on its own merits,
                as a checkout attempt (see the auto_confirm_late branch below).
                Without this fall-through, a person's actual checkout, arriving
                any time after their check-in window closed, was being silently
                swallowed as "the late check-in" instead — see this function's
                module-level bug report for the reproduction."""
                within_co = shift_gate.is_event_within_shift(
                    people_type, event_dt, is_check_out=True, person_code=person_code, config=cfg,
                )
                check_out_ready_at = shift_gate.resolve_leg_ready_at_utc(
                    people_type, person_code, event_dt, is_check_out=True, config=cfg,
                )
                check_out_metadata_json = json.dumps(
                    {**(metadata or {}), "ready_at": check_out_ready_at}, separators=(",", ":"),
                )

                if within_co:
                    notes = _merge_note(row.get("notes"), "check_out", "")
                    cur.execute(
                        """
                        UPDATE attendance_buffer
                        SET check_out_marked_at = ?, check_out_confidence = ?, check_out_camera_id = ?,
                            check_out_metadata = ?, check_out_confirmed = 1, check_out_hold_reason = NULL,
                            sync_status = 'pending', sync_error = NULL, notes = ?
                        WHERE id = ?
                        """,
                        # Was check_in_metadata_json (undefined on this path — see
                        # the module bug report). check_out_metadata_json is the
                        # value actually computed for this leg two lines above.
                        (now, float(confidence), camera_id, check_out_metadata_json, notes, row["id"]),
                    )
                    conn.commit()
                    return {
                        **row, "check_out_marked_at": now, "check_out_confidence": float(confidence),
                        "check_out_camera_id": camera_id, "check_out_confirmed": 1, "check_out_hold_reason": None,
                        "sync_status": "pending", "already_marked": False,
                        "outside_shift": False, "event_type": "check_out",
                        "notes": notes,
                    }

                has_checkout_confirmed = bool(row.get("check_out_confirmed"))
                if has_checkout_confirmed:
                    return {**row, "already_marked": True, "event_type": "stray_ignored"}

                hold_reason = shift_gate.classify_check_out_timing(
                    people_type, event_dt, person_code=person_code, config=cfg,
                )
                if hold_reason not in ("early", "late"):
                    return {**row, "already_marked": True, "event_type": "outside_checkout_window_ignored"}

                note = _format_checkout_hold_note(people_type, person_code, now, hold_reason)
                notes = _merge_note(row.get("notes"), "check_out", note)
                cur.execute(
                    """
                    UPDATE attendance_buffer
                    SET check_out_marked_at = ?, check_out_confidence = ?, check_out_camera_id = ?,
                        check_out_metadata = ?, check_out_confirmed = 0, check_out_hold_reason = ?,
                        sync_status = 'held_for_review', sync_error = NULL, notes = ?
                    WHERE id = ?
                    """,
                    # Same fix — check_out_metadata_json, not check_in_metadata_json.
                    (now, float(confidence), camera_id, check_out_metadata_json, hold_reason, notes, row["id"]),
                )
                conn.commit()
                return {
                    **row, "check_out_marked_at": now, "check_out_confidence": float(confidence),
                    "check_out_camera_id": camera_id, "check_out_confirmed": 0, "check_out_hold_reason": hold_reason,
                    "sync_status": "held_for_review", "already_marked": False,
                    "outside_shift": True, "event_type": "check_out_pending_review",
                    "notes": notes,
                }

            if existing_dict is None or (not check_in_already_confirmed and not has_checkout_value):
                within = shift_gate.is_event_within_shift(
                    people_type, event_dt, is_check_out=False, person_code=person_code, config=cfg,
                )
                window_closed = (
                    not within
                    and shift_gate.is_check_in_window_closed(
                        people_type, event_dt, person_code=person_code, config=cfg,
                    )
                )
                early_stray_already_seen = bool(
                    existing_dict is not None
                    and not check_in_already_confirmed
                    and existing_dict.get("check_in_hold_reason") is None
                )
                auto_confirm_late = window_closed and early_stray_already_seen

                if existing_dict is None:
                    # Brand new row: auto_confirm_late is always False here (no
                    # prior stray to have triggered it), so this insert path is
                    # completely unchanged from before.
                    confirm = within
                    check_in_hold_reason = "late" if window_closed else None
                    sync_status = "pending" if confirm else "held_for_review"
                    event_type = (
                        "check_in" if within
                        else "check_in_late_pending_review" if window_closed
                        else "check_in_pending_review"
                    )
                    check_in_ready_at = shift_gate.resolve_leg_ready_at_utc(
                        people_type, person_code, event_dt, is_check_out=False, config=cfg,
                    )
                    check_in_metadata_json = json.dumps(
                        {**(metadata or {}), "ready_at": check_in_ready_at}, separators=(",", ":"),
                    )
                    local_event_id = f"{branch_id}:{people_type}:{person_code}:{today}"
                    raw_note = (
                        _format_late_check_in_note(people_type, person_code, now)
                        if window_closed else None
                    )
                    notes = _merge_note(None, "check_in", raw_note)
                    cur.execute(
                        """
                        INSERT INTO attendance_buffer (
                            local_event_id, branch_id, people_type, person_code, staff_name, attendance_date,
                            status, confidence, source, camera_id, metadata, marked_at,
                            check_in_confirmed, check_out_confirmed, sync_status, check_in_hold_reason, notes
                        ) VALUES (?, ?, ?, ?, ?, ?, 'present', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
                        ON CONFLICT(branch_id, people_type, person_code, attendance_date) DO UPDATE SET
                            staff_name=excluded.staff_name, status='present', confidence=excluded.confidence,
                            source=excluded.source, camera_id=excluded.camera_id, metadata=excluded.metadata,
                            marked_at=excluded.marked_at, check_in_confirmed=excluded.check_in_confirmed,
                            sync_status=excluded.sync_status, check_in_hold_reason=excluded.check_in_hold_reason,
                            notes=excluded.notes
                        """,
                        (local_event_id, branch_id, people_type, person_code, staff_name, today,
                        float(confidence), source, camera_id, check_in_metadata_json, now,
                        1 if confirm else 0, sync_status, check_in_hold_reason, notes),
                    )
                    conn.commit()
                    return {
                        "local_event_id": local_event_id, "branch_id": branch_id,
                        "people_type": people_type, "person_code": person_code,
                        "staff_name": staff_name, "confidence": float(confidence), "camera_id": camera_id,
                        "marked_at": now, "check_out_marked_at": None, "sync_status": sync_status,
                        "already_marked": False, "outside_shift": not within, "event_type": event_type,
                        "check_in_hold_reason": check_in_hold_reason, "notes": notes,
                    }

                if auto_confirm_late:
                    # THE FIX: confirm the check-in using the STRAY's own
                    # original sighting time (existing_dict["marked_at"]) —
                    # never `now`. `now` belongs to THIS call's fresh event,
                    # which is handed to _apply_checkout_attempt right below
                    # instead of being consumed here. The note text is
                    # unchanged (still narrates both the early and late
                    # sightings for the operator) — only which timestamp gets
                    # written to marked_at has changed.
                    raw_note = _format_late_check_in_note(
                        people_type, person_code, now, existing_dict.get("marked_at"), held=False,
                    )
                    notes = _merge_note(existing_dict.get("notes"), "check_in", raw_note)
                    cur.execute(
                        """
                        UPDATE attendance_buffer
                        SET check_in_confirmed = 1, check_in_hold_reason = NULL,
                            sync_status = 'pending', sync_error = NULL, notes = ?
                        WHERE id = ?
                        """,
                        (notes, existing_dict["id"]),
                    )
                    conn.commit()
                    confirmed_row = {
                        **existing_dict, "check_in_confirmed": 1, "check_in_hold_reason": None,
                        "sync_status": "pending", "notes": notes,
                    }
                    return _apply_checkout_attempt(confirmed_row)

                # Remaining cases: genuine in-window check-in (within=True), or
                # a genuinely-first late sighting with no earlier stray to
                # explain it (window_closed=True, holds for an operator
                # decision) — both unchanged from before, just simplified
                # since auto_confirm_late is always False on this branch now.
                confirm = within
                check_in_hold_reason = "late" if window_closed else None
                sync_status = "pending" if confirm else "held_for_review"
                event_type = "check_in" if within else "check_in_late_pending_review"
                check_in_ready_at = shift_gate.resolve_leg_ready_at_utc(
                    people_type, person_code, event_dt, is_check_out=False, config=cfg,
                )
                check_in_metadata_json = json.dumps(
                    {**(metadata or {}), "ready_at": check_in_ready_at}, separators=(",", ":"),
                )
                raw_note = (
                    _format_late_check_in_note(
                        people_type, person_code, now, existing_dict.get("marked_at"), held=True,
                    )
                    if window_closed else None
                )
                notes = _merge_note(existing_dict.get("notes"), "check_in", raw_note)
                cur.execute(
                    """
                    UPDATE attendance_buffer
                    SET staff_name = ?, confidence = ?, source = ?, camera_id = ?, metadata = ?,
                        marked_at = ?, check_in_confirmed = ?, sync_status = ?, sync_error = NULL,
                        check_in_hold_reason = ?, notes = ?
                    WHERE id = ?
                    """,
                    (staff_name, float(confidence), source, camera_id, check_in_metadata_json,
                    now, 1 if confirm else 0, sync_status, check_in_hold_reason, notes, existing_dict["id"]),
                )
                conn.commit()
                return {
                    **existing_dict, "staff_name": staff_name, "confidence": float(confidence),
                    "camera_id": camera_id, "marked_at": now, "check_in_confirmed": 1 if confirm else 0,
                    "sync_status": sync_status, "already_marked": False,
                    "outside_shift": not within, "event_type": event_type,
                    "check_in_hold_reason": check_in_hold_reason, "notes": notes,
                }

            # Check-in is already confirmed -> ordinary checkout attempt.
            return _apply_checkout_attempt(existing_dict)


def record_attendance_manual(
    branch_id: str,
    people_type: str,
    person_code: str,
    staff_name: str,
    confidence: float,
    attendance_date: str,
    check_in_marked_at: str | None = None,
    check_out_marked_at: str | None = None,
    source: str = "manual_override",
    camera_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Insert or FULLY REPLACE an attendance row with explicit instructed
    timestamps. A manual instruction is authoritative for this person+date —
    by design it replaces whatever a camera detection (or an earlier
    override) put there, rather than merging into it. That's why, unlike
    record_attendance_local, every field below is written unconditionally
    on an existing row: check-in, check-out, source, and metadata all move
    to the instruction's values, and sync_status is re-armed to 'pending'
    even if the prior row had already synced, so the corrected version
    reaches the backend.

    Idempotent per instruction_id (carried in metadata by
    manual_instructions_worker): re-polling the same still-pending
    instruction before it's been acked is a no-op rather than re-writing
    identical data and re-publishing a duplicate live event.
    """
    today = str(attendance_date)
    meta = dict(metadata or {})
    instruction_id = meta.get("instruction_id")
    metadata_json = json.dumps(meta, separators=(",", ":"))
    check_in_final = check_in_marked_at or check_out_marked_at or utc_now()

    with _write_lock:
        with _connect() as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=5000")
            cur = conn.cursor()
        cur.execute(
            "SELECT * FROM attendance_buffer WHERE branch_id = ? AND people_type = ? AND person_code = ? AND attendance_date = ?",
            (branch_id, people_type, person_code, today),
        )
        existing = cur.fetchone()
        existing_dict = dict(existing) if existing else None

        if existing_dict is not None and instruction_id is not None:
            already_applied = (
                existing_dict.get("source") == "manual_override"
                and json.loads(existing_dict.get("metadata") or "{}").get("instruction_id") == instruction_id
            )
            if already_applied:
                return {**existing_dict, "already_marked": True, "event_type": "already_applied"}

        if existing_dict is not None:
            cur.execute(
                """
                UPDATE attendance_buffer
                SET staff_name = ?, status = 'present', confidence = ?, source = ?, camera_id = ?,
                    metadata = ?, marked_at = ?,
                    check_out_marked_at = ?, check_out_confidence = ?, check_out_camera_id = ?,
                    check_out_metadata = ?, sync_status = 'pending', sync_error = NULL, notes = NULL
                WHERE id = ?
                """,
                (
                    staff_name, float(confidence), source, camera_id,
                    metadata_json, check_in_final,
                    check_out_marked_at,
                    float(confidence) if check_out_marked_at else None,
                    camera_id if check_out_marked_at else None,
                    metadata_json if check_out_marked_at else "{}",
                    existing_dict["id"],
                ),
            )
            conn.commit()
            return {
                "local_event_id": existing_dict["local_event_id"],
                "people_type": people_type,
                "person_code": person_code,
                "staff_name": staff_name,
                "confidence": float(confidence),
                "camera_id": camera_id,
                "marked_at": check_in_final,
                "check_out_marked_at": check_out_marked_at,
                "sync_status": "pending",
                "already_marked": False,
                "event_type": "overridden",
            }

        # No existing row for this person+date — plain insert. branch_id
        # embedded in local_event_id itself for the same global-uniqueness
        # reason as record_attendance_local — see that function's comment.
        local_event_id = f"{branch_id}:{people_type}:{person_code}:{today}"
        # Insert the manual override; if a camera or another manual write
        # raced to create the row, merge by replacing fields so the
        # manual instruction remains authoritative.
        cur.execute(
            """
            INSERT INTO attendance_buffer (
                local_event_id, branch_id, people_type, person_code, staff_name, attendance_date,
                status, confidence, source, camera_id, metadata, marked_at,
                check_out_marked_at, check_out_confidence, check_out_camera_id, check_out_metadata, sync_status
            ) VALUES (?, ?, ?, ?, ?, ?, 'present', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
            ON CONFLICT(branch_id, people_type, person_code, attendance_date) DO UPDATE SET
                local_event_id=excluded.local_event_id,
                staff_name=excluded.staff_name,
                status='present',
                confidence=excluded.confidence,
                source=excluded.source,
                camera_id=excluded.camera_id,
                metadata=excluded.metadata,
                marked_at=excluded.marked_at,
                check_out_marked_at=excluded.check_out_marked_at,
                check_out_confidence=excluded.check_out_confidence,
                check_out_camera_id=excluded.check_out_camera_id,
                check_out_metadata=excluded.check_out_metadata,
                sync_status=excluded.sync_status
            """,
            (
                local_event_id, branch_id, people_type, person_code, staff_name, today,
                float(confidence), source, camera_id, metadata_json, check_in_final,
                check_out_marked_at,
                float(confidence) if check_out_marked_at else None,
                camera_id if check_out_marked_at else None,
                metadata_json if check_out_marked_at else "{}",
            ),
        )
        conn.commit()
        return {
            "local_event_id": local_event_id,
            "branch_id": branch_id,
            "people_type": people_type,
            "person_code": person_code,
            "staff_name": staff_name,
            "confidence": float(confidence),
            "camera_id": camera_id,
            "marked_at": check_in_final,
            "check_out_marked_at": check_out_marked_at,
            "sync_status": "pending",
            "already_marked": False,
            "event_type": "check_in_and_out" if check_out_marked_at else "check_in",
        }

def pending_attendance(branch_id: str, limit: int = 100) -> list[dict[str, Any]]:
    with _connect() as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM attendance_buffer WHERE branch_id = ? AND sync_status = 'pending' ORDER BY id LIMIT ?",
            (branch_id, int(limit or 100)),
        )
        return [dict(row) | {"metadata": json.loads(row["metadata"] or "{}")} for row in cur.fetchall()]


def unsynced_attendance(branch_id: str, limit: int = 500) -> list[dict[str, Any]]:
    """Everything not yet on the cloud — 'pending' (normal auto-sync queue)
    AND 'held_for_review' (outside-shift, awaiting manual approval).
    Used ONLY by the manual flush path — the background auto-loop must
    keep using pending_attendance() so it never silently pushes a held row."""
    with _connect() as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM attendance_buffer WHERE branch_id = ? AND sync_status IN ('pending', 'held_for_review') ORDER BY id LIMIT ?",
            (branch_id, int(limit or 500)),
        )
        return [dict(row) | {"metadata": json.loads(row["metadata"] or "{}")} for row in cur.fetchall()]


def clear_today_attendance(branch_id: str) -> int:
    """Delete every attendance_buffer row for today's date AND this branch
    (local machine date, same as _today()/record_attendance_local). Used by
    the "Clear today's attendance" maintenance action — a full reset for
    testing/troubleshooting, not a normal operator action, since it also
    discards already-synced rows for today, not just pending/held ones.
    Does not touch the backend's copy of anything already synced before
    this is called. branch_id-scoped so this can never delete a different
    branch's rows sharing this machine's SQLite file. Returns the number of
    rows deleted."""
    today = _today()
    with _connect() as conn:
        cur = conn.execute(
            "DELETE FROM attendance_buffer WHERE branch_id = ? AND attendance_date = ?",
            (branch_id, today),
        )
        conn.commit()
        return cur.rowcount


def held_attendance_count(branch_id: str) -> int:
    """Powers the frontend's badge on the "Sync attendance" button."""
    with _connect() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT COUNT(*) FROM attendance_buffer WHERE branch_id = ? AND sync_status = 'held_for_review'",
            (branch_id,),
        )
        return int(cur.fetchone()[0])


def held_attendance_rows(branch_id: str, limit: int = 200) -> list[dict[str, Any]]:
    """Full rows for every held_for_review detection on THIS branch, newest
    first — the data source for the operator-facing review list. Unlike
    held_attendance_count() (a single number) or recent_attendance()'s
    default include_held=False (which deliberately hides these), this is
    the one read path meant to expose held rows in full, since an operator
    can't decide "delete this person" or "sync this one anyway" from a
    count alone. branch_id-scoped — this is the exact query that used to
    leak a previous branch's held rows into a freshly (re)activated node's
    review screen; see _ensure_schema_migrations' branch_id docstring."""
    with _connect() as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM attendance_buffer WHERE branch_id = ? AND sync_status = 'held_for_review' ORDER BY id DESC LIMIT ?",
            (branch_id, int(limit or 200)),
        )
        return [dict(row) | {"metadata": json.loads(row["metadata"] or "{}")} for row in cur.fetchall()]


def attendance_rows_by_ids(local_event_ids: list[str]) -> list[dict[str, Any]]:
    """Fetch specific rows by local_event_id, regardless of sync_status —
    used by the selective-sync path (operator ticks specific held rows and
    hits "Sync selected") where the caller already knows exactly which
    rows it wants, unlike pending_attendance()/unsynced_attendance() which
    select by status."""
    if not local_event_ids:
        return []
    placeholders = ",".join("?" for _ in local_event_ids)
    with _connect() as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(
            f"SELECT * FROM attendance_buffer WHERE local_event_id IN ({placeholders})",
            list(local_event_ids),
        )
        return [dict(row) | {"metadata": json.loads(row["metadata"] or "{}")} for row in cur.fetchall()]


def delete_attendance_rows(local_event_ids: list[str]) -> list[dict[str, Any]]:
    """Delete specific attendance_buffer rows by local_event_id — the
    operator's "delete this person's held detection" action. Returns the
    deleted rows (not just a count) so the caller can reset each deleted
    person's per-camera dedupe throttle (see
    CameraStreamManager.clear_person_throttle) — without that, a held
    detection deleted here would still be silently skipped by
    DUPLICATE_LOG_SECONDS throttling on the next frame, identical to the
    reasoning behind clear_person_throttles() in clear_today_attendance's
    caller. Local-only: does not affect anything already synced to the
    cloud, since only pending/held rows should ever reach here from the
    UI (the endpoint that calls this restricts to held_for_review rows)."""
    if not local_event_ids:
        return []
    deleted_rows = attendance_rows_by_ids(local_event_ids)
    if not deleted_rows:
        return []
    placeholders = ",".join("?" for _ in local_event_ids)
    with _connect() as conn:
        conn.execute(
            f"DELETE FROM attendance_buffer WHERE local_event_id IN ({placeholders})",
            list(local_event_ids),
        )
        conn.commit()
    return deleted_rows


def _resolve_held_checkouts(
    local_event_ids: list[str],
    *,
    build_update: "callable[[dict[str, Any]], tuple[str, tuple]]",
) -> dict[str, Any]:
    """Shared per-id apply loop for the three checkout-hold resolution
    actions below. Each caller supplies build_update(row) -> (sql, params)
    for exactly what changes about THAT resolution; this function owns the
    common parts all three share: restricting to rows that are actually a
    pending checkout hold (sync_status='held_for_review' AND
    check_out_hold_reason set — so an ordinary held CHECK-IN row, or an
    already-resolved row, can never be accidentally resolved by one of
    these actions), and collecting per-id errors instead of letting one bad
    id abort the whole batch — consistent with how
    attendance_sync_worker.run_once(local_event_ids=...) already treats a
    stale/already-handled id selection as something to skip, not fail on.
    """
    resolved_ids: list[str] = []
    skipped_ids: list[str] = []
    rows = {row["local_event_id"]: row for row in attendance_rows_by_ids(local_event_ids)}

    with _connect() as conn:
        cur = conn.cursor()
        for event_id in local_event_ids:
            row = rows.get(event_id)
            if not row or row.get("sync_status") != "held_for_review" or not row.get("check_out_hold_reason"):
                skipped_ids.append(event_id)
                continue
            sql, params = build_update(row)
            cur.execute(sql, params)
            # build_update's WHERE clause carries the action-specific guard
            # (e.g. check_out_hold_reason = 'early' for half-day) alongside
            # the id match — rowcount is 0 when the row exists but doesn't
            # satisfy that guard (e.g. a 'late' row sent to
            # mark_held_checkouts_half_day), which must be reported as
            # skipped rather than falsely-resolved.
            (resolved_ids if cur.rowcount > 0 else skipped_ids).append(event_id)
        conn.commit()

    return {"resolved_ids": resolved_ids, "skipped_ids": skipped_ids}


def mark_held_checkouts_late(local_event_ids: list[str]) -> dict[str, Any]:
    """Operator action for hold_reason='late' rows only: the person WAS
    genuinely sighted after their checkout window closed, but this late
    departure is NOT overtime worked — still needs an admin decision on
    whether it affects salary, so it can't just be silently accepted as an
    ordinary 'present' day the way the old confirm_held_checkouts used to.

    Mirrors mark_held_checkouts_overtime exactly (accepts the sighted
    check_out_marked_at as the real, confirmed checkout time — same
    reasoning: the cloud's hours computation needs a real timestamp to
    measure against) but flags the day status='late' instead of
    'overtime', matching the office-staff exception vocabulary in
    support_db_attendance_exceptions.py — _CHECK_OUT_DECISIONS_BY_HOLD_REASON["late"]
    is exactly {'late', 'overtime'} there too, so both attendance paths
    (camera-tracked local-node staff and office-staff mobile check-in)
    offer the admin dashboard the identical pair of outcomes for a late
    checkout, whichever path the row came from.

    Replaces the old confirm_held_checkouts for this hold_reason — there is
    deliberately no "just accept it, no decision needed" option left; the
    operator must choose late vs overtime vs leave-open (defer)."""
    def build_update(row: dict[str, Any]) -> tuple[str, tuple]:
        return (
            "UPDATE attendance_buffer SET check_out_confirmed = 1, check_out_hold_reason = NULL, "
            "status = 'late', sync_error = NULL "
            "WHERE id = ? AND check_out_hold_reason = 'late'",
            (row["id"],),
        )
    return _resolve_held_checkouts(local_event_ids, build_update=build_update)


def mark_held_checkouts_half_day(local_event_ids: list[str]) -> dict[str, Any]:
    """Operator action for hold_reason='early' rows only: the person left
    before their checkout window opened and was never seen again today —
    clear the tentative checkout (it was never real), keep the informative
    note already stored, and flag the day status='half_day' so downstream
    reporting reflects a partial day rather than a missing checkout.

    Deliberately writes only the existing status/notes columns, not a
    leave_requests row — that table represents an HR-approval workflow, and
    auto-inserting an "approved" row there from an automated camera
    detection would misrepresent an approval that never happened.

    Rows with hold_reason='late' are skipped (same as any row that doesn't
    match this action's precondition) — "half day" only makes sense for an
    early departure, not someone who stayed/left late.
    """
    def build_update(row: dict[str, Any]) -> tuple[str, tuple]:
        return (
            "UPDATE attendance_buffer SET check_out_marked_at = NULL, check_out_confidence = NULL, "
            "check_out_camera_id = NULL, check_out_metadata = '{}', check_out_confirmed = 0, "
            "check_out_hold_reason = NULL, status = 'half_day', sync_error = NULL "
            "WHERE id = ? AND check_out_hold_reason = 'early'",

            (row["id"],),
        )
    return _resolve_held_checkouts(local_event_ids, build_update=build_update)


def mark_held_checkouts_short_leave(local_event_ids: list[str]) -> dict[str, Any]:
    """Operator action for hold_reason='early' rows only: the person left
    before their checkout window opened, and the operator judges this a
    SHORT leave rather than a full half day — same detection
    (check_out_hold_reason='early') as mark_held_checkouts_half_day, this
    is purely the operator picking the other of the two possible outcomes
    for that same early-departure sighting. No separate time threshold is
    computed here (see shift_gate.classify_check_out_timing — it only ever
    returns 'early'/'late'/'within', nothing finer); short-leave vs
    half-day for a given early checkout is entirely the operator's call.

    Unlike mark_held_checkouts_half_day, this ACCEPTS the sighted
    check_out_marked_at as the real, confirmed checkout time — a short
    leave is, by definition, a real departure at a real (if early) time,
    which is exactly what distinguishes it from half_day (where the
    departure time is treated as unreliable/unknown and discarded).
    Mirrors mark_held_checkouts_overtime's same choice on the late-hold
    side, and matches mark_held_check_ins_short_leave, which already
    keeps the sighted check-in time rather than clearing it.

    Deliberately writes only the existing status/notes columns, not a
    leave_requests row — same reasoning mark_held_checkouts_half_day
    already documents: that table represents an HR-approval workflow, and
    auto-inserting an "approved" row from an automated camera detection
    would misrepresent an approval that never happened.

    Rows with hold_reason='late' are skipped, same restriction every other
    early-only action here has — "short leave" only makes sense for an
    early departure.
    """
    def build_update(row: dict[str, Any]) -> tuple[str, tuple]:
        return (
            "UPDATE attendance_buffer SET check_out_confirmed = 1, check_out_hold_reason = NULL, "
            "status = 'short_leave', sync_error = NULL "
            "WHERE id = ? AND check_out_hold_reason = 'early'",
            (row["id"],),
        )
    return _resolve_held_checkouts(local_event_ids, build_update=build_update)


def mark_held_checkouts_early_left(local_event_ids: list[str]) -> dict[str, Any]:
    """Operator action for hold_reason='early' rows only: the person really
    did leave early, and the operator doesn't want to classify it as a
    short_leave or half_day outcome — just record that they left early and
    move on. Third option alongside mark_held_checkouts_half_day and
    mark_held_checkouts_short_leave for an early-departure hold.

    Unlike those two, this does NOT touch the `status` column at all —
    `status` is this table's day-level ARRIVAL classification
    (present/late/short_leave/half_day/overtime, set at check-in time and
    otherwise only ever touched by the check-in-hold resolutions and the
    late-checkout resolutions above); an early checkout on its own isn't an
    arrival-side outcome, so it has no business overwriting whatever status
    the check-in leg already established (ordinarily 'present'). Instead
    the decision is recorded purely as a note ("Early left"), the same way
    an operator-typed observation would be — visible on the row without
    redefining what `status` means.

    Mirrors mark_held_checkouts_short_leave's other choice: ACCEPTS the
    sighted check_out_marked_at as the real, confirmed checkout time (a
    real departure at a real, if early, time), rather than clearing it the
    way mark_held_checkouts_half_day does.

    Rows with hold_reason='late' are skipped, same restriction every other
    early-only action here has.
    """
    def build_update(row: dict[str, Any]) -> tuple[str, tuple]:
        return (
            "UPDATE attendance_buffer SET check_out_confirmed = 1, check_out_hold_reason = NULL, "
            "notes = 'Early left', sync_error = NULL "
            "WHERE id = ? AND check_out_hold_reason = 'early'",
            (row["id"],),
        )
    return _resolve_held_checkouts(local_event_ids, build_update=build_update)


def mark_held_checkouts_overtime(local_event_ids: list[str]) -> dict[str, Any]:
    """Operator action for hold_reason='late' rows only: the person was
    genuinely sighted after their checkout window closed, and that late
    departure IS overtime worked (not just an ordinary late checkout) —
    this ACCEPTS the sighted check_out_marked_at as the real, confirmed
    checkout time (the cloud's overtime-hours computation needs a real
    check_out_timestamp to measure against the shift's scheduled cutoff —
    see support_db_attendance_exceptions._compute_overtime_hours), and
    flags the day status='overtime' instead of leaving it untouched.

    Mirrors mark_held_checkouts_late (same accept-timestamp mechanics,
    same hold_reason='late' restriction — "overtime" only makes sense for
    someone who stayed/was seen late, not someone who left early) — the
    two together are the only decisions offered for a late-checkout hold,
    matching the office-staff exception vocabulary exactly
    (_CHECK_OUT_DECISIONS_BY_HOLD_REASON["late"] == {"late", "overtime"}
    in support_db_attendance_exceptions.py).

    Deliberately writes only the existing status/notes columns, not an
    overtime_requests row — same reasoning mark_held_checkouts_half_day
    already documents for leave_requests: that table represents an
    HR-approval workflow, and auto-inserting an "approved" row from an
    automated camera detection would misrepresent an approval that never
    happened. Whether this status='overtime' day actually gets credited
    toward payroll is a separate, later decision (see the payroll-decision
    work), not something this local resolution action decides on its own.
    """
    def build_update(row: dict[str, Any]) -> tuple[str, tuple]:
        return (
            "UPDATE attendance_buffer SET check_out_confirmed = 1, check_out_hold_reason = NULL, "
            "status = 'overtime', sync_error = NULL "
            "WHERE id = ? AND check_out_hold_reason = 'late'",
            (row["id"],),
        )
    return _resolve_held_checkouts(local_event_ids, build_update=build_update)


def _strip_pending_decision_suffix(notes: str | None) -> str | None:
    """Remove the "Awaiting operator decision." sentence from a stored note.

    The note is composed ONCE, at hold time, by
    _format_late_check_in_note(held=True) / _format_checkout_hold_note.
    Every resolution action below updates the row's flags but never
    rewrote the note, so a resolved row kept telling the operator — on the
    node's review panel, the dashboard's attendance view, and the
    notification body, all of which render this same stored string — that
    it was still awaiting the decision they had just made.

    Only the trailing pending clause is removed; the factual part of the
    note ("Detected at 12:05, late — after the 11:45:00 shift start.") is
    the audit trail and must survive resolution.
    """
    if not notes:
        return notes
    return notes.replace(" Awaiting operator decision.", "").replace(
        "Awaiting operator decision.", ""
    ).rstrip()


# The exact clause _format_late_check_in_note appends when held=True
# (see its `suffix` line). Kept as a module constant so the formatter and
# the stripper below can never drift apart.
_PENDING_DECISION_CLAUSE = " Awaiting operator decision."


def _strip_pending_decision_clause(notes: str | None) -> str | None:
    """Remove the "Awaiting operator decision." clause from a stored note.

    The note is composed ONCE, at hold time, by
    _format_late_check_in_note(held=True). Every resolution action below
    updates the row's flags (check_in_confirmed / check_in_hold_reason /
    status) but none rewrote `notes`, so a resolved row kept telling the
    operator it was still awaiting the decision they had just made — on
    the node's Held-for-review panel, in the Client Dashboard's attendance
    view, and in the notification body, all three of which render this
    same stored string.

    Only the trailing pending clause goes. The factual part ("Detected at
    12:05, late — after the 11:45:00 shift start.") is the audit trail and
    must survive resolution.

    Longer term the durable shape is to store the facts and render the
    sentence at display time — then a pending clause cannot outlive the
    decision by construction. This keeps the stored-prose design working
    until then.
    """
    if not notes:
        return notes
    cleaned = notes.replace(_PENDING_DECISION_CLAUSE, "")
    # Defensive: an older row may have been written without the leading
    # space (or had it collapsed by a note merge).
    cleaned = cleaned.replace(_PENDING_DECISION_CLAUSE.strip(), "")
    return cleaned.rstrip() or None

def _resolve_held_check_ins(
    local_event_ids: list[str],
    *,
    build_update: "callable[[dict[str, Any]], tuple[str, tuple]]",
) -> dict[str, Any]:
    """Shared per-id apply loop for the check-in-hold resolution actions
    below — the check-in-leg counterpart to _resolve_held_checkouts.
    Restricts to rows that are actually a pending LATE check-in hold
    (sync_status='held_for_review' AND check_in_hold_reason='late'), so an
    early-stray-still-waiting row (check_in_hold_reason NULL) or a held
    CHECKOUT row can never be accidentally resolved by these."""
    resolved_ids: list[str] = []
    skipped_ids: list[str] = []
    rows = {row["local_event_id"]: row for row in attendance_rows_by_ids(local_event_ids)}

    with _connect() as conn:
        cur = conn.cursor()
        for event_id in local_event_ids:
            row = rows.get(event_id)
            if not row or row.get("sync_status") != "held_for_review" or row.get("check_in_hold_reason") != "late":
                skipped_ids.append(event_id)
                continue
            sql, params = build_update(row)
            cur.execute(sql, params)
            if cur.rowcount > 0:
                # The decision has now been made — the note must stop
                # claiming otherwise. Done here rather than in each
                # build_update so all three check-in resolution actions
                # (late / short_leave / half_day) get it automatically.
                cleaned = _strip_pending_decision_clause(row.get("notes"))
                if cleaned != row.get("notes"):
                    cur.execute(
                        "UPDATE attendance_buffer SET notes = ? WHERE id = ?",
                        (cleaned, row["id"]),
                    )
                resolved_ids.append(event_id)
            else:
                skipped_ids.append(event_id)
        conn.commit()

    return {"resolved_ids": resolved_ids, "skipped_ids": skipped_ids}


def mark_held_check_ins_late(local_event_ids: list[str]) -> dict[str, Any]:
    """Operator action: the late sighting IS a genuine late arrival — not a
    short leave, not a half day, just late. Accepts the already-stored
    marked_at (the late sighting time) as the final, confirmed check-in
    time and flags status='late', matching the office-staff exception
    vocabulary (_CHECK_IN_DECISIONS includes 'late' in
    support_db_attendance_exceptions.py, resolving to day_status='present'
    there since 'late' isn't one of that module's day-level decisions —
    here it's status='late' directly, since this table has no separate
    day_status/status split).

    One of three decisions for a late check-in hold, alongside
    mark_held_check_ins_short_leave and mark_held_check_ins_half_day."""
    def build_update(row: dict[str, Any]) -> tuple[str, tuple]:
        return (
            "UPDATE attendance_buffer SET check_in_confirmed = 1, check_in_hold_reason = NULL, "
            "status = 'late', sync_error = NULL "
            "WHERE id = ? AND check_in_hold_reason = 'late'",
            (row["id"],),
        )
    return _resolve_held_check_ins(local_event_ids, build_update=build_update)


def mark_held_check_ins_short_leave(local_event_ids: list[str]) -> dict[str, Any]:
    """Operator action: this late check-in reflects the person being on a
    short leave (manager-approved absence earlier in the day, not a full
    half day) — accepts the already-stored marked_at (the late sighting
    time) as the final check-in time, same mechanics
    mark_held_check_ins_late uses, but flags status='short_leave' so the
    admin dashboard has a decision to make on whether it affects salary.

    One of three decisions for a late check-in hold, alongside
    mark_held_check_ins_late and mark_held_check_ins_half_day — mirroring
    the checkout-early trio (mark_held_checkouts_short_leave /
    mark_held_checkouts_half_day / mark_held_checkouts_early_left) and
    matching the office-staff exception vocabulary (_CHECK_IN_DECISIONS =
    {'late', 'short_leave', 'half_day'} in
    support_db_attendance_exceptions.py)."""
    def build_update(row: dict[str, Any]) -> tuple[str, tuple]:
        return (
            "UPDATE attendance_buffer SET check_in_confirmed = 1, check_in_hold_reason = NULL, "
            "status = 'short_leave', sync_error = NULL "
            "WHERE id = ? AND check_in_hold_reason = 'late'",
            (row["id"],),
        )
    return _resolve_held_check_ins(local_event_ids, build_update=build_update)


def mark_held_check_ins_half_day(local_event_ids: list[str]) -> dict[str, Any]:
    """Operator action: the late sighting shouldn't be recorded as a real
    check-in — flag the day half_day instead. marked_at is NOT NULL (unlike
    the checkout columns) so it's left in place as an audit trail of when
    the sighting happened, but check_in_confirmed stays 0 — the cloud must
    treat check_in_confirmed=0 + status='half_day' as "show Half Day in the
    check-in field", not as a real confirmed check-in time. See the
    required support_db.py change noted alongside this."""
    def build_update(row: dict[str, Any]) -> tuple[str, tuple]:
        return (
            "UPDATE attendance_buffer SET check_in_confirmed = 0, check_in_hold_reason = NULL, "
            "status = 'half_day', sync_error = NULL "
            "WHERE id = ? AND check_in_hold_reason = 'late'",
            (row["id"],),
        )
    return _resolve_held_check_ins(local_event_ids, build_update=build_update)

def mark_attendance_synced(local_event_ids: list[str]) -> None:
    if not local_event_ids:
        return
    now = utc_now()
    placeholders = ",".join("?" for _ in local_event_ids)
    with _connect() as conn:
        conn.execute(
            f"UPDATE attendance_buffer SET sync_status = 'synced', synced_at = ?, sync_error = NULL "
            f"WHERE local_event_id IN ({placeholders})",
            [now, *local_event_ids],
        )
        conn.commit()


def mark_attendance_failed(local_event_ids: list[str], error: str) -> None:
    if not local_event_ids:
        return
    placeholders = ",".join("?" for _ in local_event_ids)
    with _connect() as conn:
        conn.execute(
            f"UPDATE attendance_buffer SET sync_error = ? WHERE local_event_id IN ({placeholders})",
            [error, *local_event_ids],
        )
        conn.commit()


def recent_attendance(branch_id: str, limit: int = 50, include_held: bool = False) -> list[dict[str, Any]]:
    """Feeds /api/live-events' "attendance" array. include_held defaults to
    False so this stays consistent with the rest of the pipeline treating
    held_for_review as invisible-until-reviewed: camera_stream_manager.py
    skips publish_event() for held rows, and attendance_sync_worker.py
    refuses to auto-sync them. Without this filter, a held row was still
    reaching the frontend through this endpoint's "attendance" array even
    though it was correctly absent from "events" — the one place a
    held detection was still leaking through despite the shift gate
    correctly holding it. Pass include_held=True explicitly if a future
    "review held detections" screen needs to see them here.

    branch_id-scoped for the same reason as held_attendance_rows — this
    endpoint used to return every branch's rows ever written to this
    machine's SQLite file, unfiltered."""
    query = "SELECT * FROM attendance_buffer WHERE branch_id = ?"
    params: list[Any] = [branch_id]
    if not include_held:
        query += " AND sync_status != 'held_for_review'"
    query += " ORDER BY id DESC LIMIT ?"
    params.append(int(limit or 50))
    with _connect() as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(query, params)
        return [dict(row) | {"metadata": json.loads(row["metadata"] or "{}")} for row in cur.fetchall()]
    

def get_embeddings_grouped_by_person(branch_id: str) -> list[dict[str, Any]]:
    """Reshape staff_embeddings rows (one row per vector) into one record
    per person, ready for api_client.push_embeddings()."""
    rows = get_all_embeddings(branch_id)
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        key = (row["people_type"], row["person_code"])
        record = grouped.setdefault(key, {
            "people_type": row["people_type"],
            "person_code": row["person_code"],
            "full_name": row["full_name"],
            "model_version": row["model_version"],
            "embeddings": [],
        })
        record["embeddings"].append(row["embedding"])
    return list(grouped.values())


def find_person_code_for_staff(branch_id: str, staff_id: str, people_type: str | None = None) -> str | None:
    """Attempt to find a local `person_code` for a given `staff_id` by
    scanning the staff_embeddings table. If `people_type` is provided,
    restrict the search to that people_type for better accuracy.

    Returns the person_code (string) if found, otherwise None.
    """
    with _connect() as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        if people_type:
            cur.execute(
                "SELECT person_code FROM staff_embeddings WHERE branch_id = ? AND staff_id = ? AND people_type = ? LIMIT 1",
                (branch_id, staff_id, people_type),
            )
        else:
            cur.execute(
                "SELECT person_code FROM staff_embeddings WHERE branch_id = ? AND staff_id = ? LIMIT 1",
                (branch_id, staff_id),
            )
        row = cur.fetchone()
        return str(row[0]) if row else None
    

def resolve_local_person_code(branch_id: str, people_type: str, backend_person_code: str) -> str:
    """A manual instruction's person_code comes from client_staff.person_code
    (dashboard's zero-padded Staff ID convention, e.g. "0003"). This node's
    own attendance_buffer/staff_embeddings key people by whatever person_code
    the trainer-enrolled embedding package used instead (e.g. "3") — same
    identity, two representations, exactly like shift_gate._lookup_personal_window
    and support_db.push_node_attendance already normalize on their own paths.
    Without this, record_attendance_manual silently writes to a brand-new,
    disconnected attendance_buffer row instead of the person's real one —
    the override "applies" and acks, but the person's actual attendance
    never changes.
    """
    if not backend_person_code:
        return backend_person_code
    with _connect() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT DISTINCT person_code FROM staff_embeddings WHERE branch_id = ? AND people_type = ?",
            (branch_id, people_type),
        )
        local_codes = [row[0] for row in cur.fetchall()]

    if backend_person_code in local_codes:
        return backend_person_code
    if backend_person_code.isdigit():
        target = int(backend_person_code)
        for candidate in local_codes:
            if candidate.isdigit() and int(candidate) == target:
                return candidate
    return backend_person_code