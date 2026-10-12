from __future__ import annotations

from types import SimpleNamespace

import local_node.live_events as live_events
import local_node.manual_instructions_worker as manual_worker


def test_absent_instruction_deletes_local_attendance_and_its_live_card(monkeypatch):
    deleted_for = []
    acknowledgements = []
    cleared_throttles = []
    live_events.clear_events()
    live_events.publish_event(
        {
            "id": "local-event-1",
            "staff_id": "0001",
            "name": "Staff One",
        }
    )

    monkeypatch.setattr(
        manual_worker,
        "load_config",
        lambda: {"branch_id": "branch-1"},
    )
    monkeypatch.setattr(
        manual_worker,
        "poll_manual_instructions",
        lambda: {
            "manual_instructions": [
                {
                    "id": "instruction-1",
                    "staff_id": "staff-1",
                    "person_code": "0001",
                    "people_type": "staff",
                    "attendance_date": "2026-10-09",
                    "reason": "absent",
                }
            ]
        },
    )
    monkeypatch.setattr(
        manual_worker.local_db,
        "resolve_local_person_code",
        lambda _branch, _people_type, person_code: person_code,
    )
    monkeypatch.setattr(
        manual_worker.local_db,
        "delete_attendance_rows_for_person",
        lambda branch, person_code, attendance_date: (
            deleted_for.append((branch, person_code, attendance_date))
            or [{"local_event_id": "local-event-1"}]
        ),
    )
    monkeypatch.setattr(
        "local_node.camera_stream_manager.get_camera_stream_manager",
        lambda: SimpleNamespace(
            clear_person_throttle=lambda people_type, person_code: (
                cleared_throttles.append((people_type, person_code))
            )
        ),
    )
    monkeypatch.setattr(
        manual_worker,
        "ack_manual_instruction",
        lambda instruction_id, status, note=None: acknowledgements.append(
            (instruction_id, status, note)
        ),
    )

    worker = manual_worker.ManualInstructionsWorker()
    assert worker.interval_seconds == 5
    applied = worker.run_once()

    assert applied == 1
    assert deleted_for == [("branch-1", "0001", "2026-10-09")]
    assert cleared_throttles == [("staff", "0001")]
    assert live_events.list_events() == []
    assert acknowledgements == [
        (
            "instruction-1",
            "applied",
            "Cleared local attendance for absent instruction",
        )
    ]
    live_events.clear_events()


def test_absent_instruction_is_not_acknowledged_as_applied_without_person_code(monkeypatch):
    acknowledgements = []
    monkeypatch.setattr(
        manual_worker,
        "load_config",
        lambda: {"branch_id": "branch-1"},
    )
    monkeypatch.setattr(
        manual_worker,
        "poll_manual_instructions",
        lambda: {
            "manual_instructions": [
                {
                    "id": "instruction-1",
                    "staff_id": "staff-1",
                    "people_type": "staff",
                    "attendance_date": "2026-10-09",
                    "reason": "absent",
                }
            ]
        },
    )
    monkeypatch.setattr(
        manual_worker.local_db,
        "find_person_code_for_staff",
        lambda *_args: None,
    )
    monkeypatch.setattr(
        manual_worker.local_db,
        "delete_attendance_rows_for_person",
        lambda *_args: (_ for _ in ()).throw(
            AssertionError("must not delete attendance without a resolved identity")
        ),
    )
    monkeypatch.setattr(
        manual_worker,
        "ack_manual_instruction",
        lambda instruction_id, status, note=None: acknowledgements.append(
            (instruction_id, status, note)
        ),
    )

    applied = manual_worker.ManualInstructionsWorker().run_once()

    assert applied == 0
    assert acknowledgements[0][0:2] == ("instruction-1", "failed")
    assert "no local person code" in acknowledgements[0][2]
