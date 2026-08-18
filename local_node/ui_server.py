# from __future__ import annotations

# import tempfile
# from pathlib import Path

# from flask import Flask, Response, jsonify, request, send_from_directory

# from local_node import local_db
# from local_node.activation import activate_with_token
# from local_node.camera_stream_manager import get_camera_stream_manager
# from local_node.config_store import get_branch_id, get_branch_name, get_org_id, get_runtime_identity, is_activated, load_config, read_runtime_status
# from local_node.live_events import list_events, clear_events
# from local_node.node_service import NodeService
# from local_node.package_import import PackageImportError, parse_embedding_package
# from local_node import api_client
# _service = NodeService()
# _camera_manager = get_camera_stream_manager()
# from local_node import recognition_worker



# def _web_dist() -> Path:
#     return Path(__file__).resolve().parent / "web" / "dist"


# def _current_branch_id() -> str:
#     """Single source of truth for "which branch is this node's local
#     attendance data scoped to" — every attendance_buffer read/maintenance
#     call below must pass this, or it risks operating across every branch
#     that has ever shared this machine's SQLite file (see local_db.py's
#     _ensure_schema_migrations branch_id docstring for why that used to
#     happen)."""
#     return get_branch_id(load_config())


# def create_app() -> Flask:
#     app = Flask(__name__, static_folder=None)  # disable Flask's implicit static route entirely
#     local_db.init_db()
#     _service.start()

#     @app.get("/api/status")
#     def api_status():
#         cfg = get_runtime_identity(load_config())
#         runtime = read_runtime_status()
#         return jsonify({
#             "success": True,
#             "activated": is_activated(),
#             "node_id": cfg.get("node_id"),
#             "org_id": cfg.get("org_id") or cfg.get("organization_id"),
#             "branch_id": cfg.get("branch_id"),
#             "branch_name": cfg.get("branch_name"),
#             "attendance_mode": cfg.get("attendance_mode"),
#             "hostname": cfg.get("hostname"),
#             "runtime": runtime,
#             "held_attendance_count": local_db.held_attendance_count(_current_branch_id()),
#         })

#     @app.post("/api/activate")
#     def api_activate():
#         data = request.get_json(silent=True) or {}
#         try:
#             config = activate_with_token(
#                 api_base_url=str(data.get("api_base_url") or ""),
#                 install_token=str(data.get("install_token") or ""),
#                 node_label=str(data.get("node_label") or "") or None,
#             )
#             return jsonify({"success": True, "config": config})
#         except Exception as exc:
#             return jsonify({"success": False, "message": str(exc)}), 400

#     @app.get("/api/live-events")
#     def api_live_events():
#         return jsonify({
#             "success": True,
#             "events": list_events(100),
#             "attendance": local_db.recent_attendance(_current_branch_id(), 50),
#         })

#     @app.get("/api/cameras")
#     def api_cameras():
#         return jsonify({"success": True, "cameras": _camera_manager.list_cameras()})

#     @app.get("/api/camera-stream/<camera_id>")
#     def api_camera_stream(camera_id: str):
#         return Response(
#             _camera_manager.mjpeg_frames(camera_id),
#             mimetype="multipart/x-mixed-replace; boundary=frame",
#         )
    
    
#     @app.post("/api/run-cycle")
#     def api_run_cycle():
#         try:
#             return jsonify({"success": True, "status": _service.run_cycle()})
#         except Exception as exc:
#             return jsonify({"success": False, "message": str(exc)}), 400

#     @app.post("/api/sync-attendance")
#     def api_sync_attendance():
#         try:
#             synced_count = _service.sync_all_attendance()
#             return jsonify({
#                 "success": True,
#                 "synced_count": synced_count,
#                 "held_remaining": local_db.held_attendance_count(_current_branch_id()),
#             })
#         except Exception as exc:
#             return jsonify({"success": False, "message": str(exc)}), 400

#     @app.get("/api/held-attendance")
#     def api_held_attendance():
#         """List every detection currently held for manual review (outside
#         its shift window) so the operator can see exactly who was sighted,
#         when, and on which camera before deciding whether to sync or
#         discard it — see local_db.held_attendance_rows."""
#         rows = local_db.held_attendance_rows(_current_branch_id(), 200)
#         held = [
#             {
#                 "id": row["local_event_id"],
#                 "people_type": row["people_type"],
#                 "person_code": row["person_code"],
#                 "staff_name": row.get("staff_name") or row["person_code"],
#                 "confidence": row.get("confidence"),
#                 "camera_id": row.get("camera_id"),
#                 "camera_name": (row.get("metadata") or {}).get("camera_name"),
#                 # Which calendar day this row belongs to (branch-local, see
#                 # local_db._today()) — surfaced explicitly rather than
#                 # making the operator infer it from marked_at, since held
#                 # rows have no expiry and can sit across multiple days.
#                 "attendance_date": row.get("attendance_date"),
#                 "marked_at": row.get("marked_at"),
#                 "check_out_marked_at": row.get("check_out_marked_at"),
#                 # A held row is one of three distinct cases the frontend
#                 # must label differently: an unconfirmed early check-in
#                 # stray (still waiting for the real in-window sighting —
#                 # see local_db.record_attendance_local's docstring), a
#                 # confirmed-but-late check-in, or a held CHECKOUT sighting
#                 # (check_out_hold_reason set — 'early' or 'late'). The
#                 # first two are check-in holds (check_out_hold_reason is
#                 # always None for those); the third is what the three
#                 # resolution endpoints below act on.
#                 "check_in_confirmed": bool(row.get("check_in_confirmed")),
#                 "check_in_hold_reason": row.get("check_in_hold_reason"),
#                 "check_out_hold_reason": row.get("check_out_hold_reason"),
#                 "notes": row.get("notes"),
#             }
#             for row in rows
#         ]
#         return jsonify({"success": True, "held": held})

#     def _held_checkout_action(action_fn):
#         """Shared request-handling for the three checkout-hold resolution
#         endpoints below — each differs only in which NodeService method it
#         calls, so this keeps the request parsing / response shaping DRY."""
#         data = request.get_json(silent=True) or {}
#         local_event_ids = [str(v) for v in (data.get("local_event_ids") or []) if str(v).strip()]
#         if not local_event_ids:
#             return jsonify({"success": False, "message": "No records selected."}), 400
#         try:
#             result = action_fn(local_event_ids)
#             return jsonify({
#                 "success": True,
#                 "resolved_count": len(result["resolved_ids"]),
#                 "skipped_count": len(result["skipped_ids"]),
#                 "skipped_ids": result["skipped_ids"],
#                 "held_remaining": local_db.held_attendance_count(_current_branch_id()),
#             })
#         except Exception as exc:
#             return jsonify({"success": False, "message": str(exc)}), 400

#     @app.post("/api/held-attendance/confirm-checkout")
#     def api_held_attendance_confirm_checkout():
#         """Operator action: accept a held checkout sighting's stored time
#         as the real checkout (valid for either 'early' or 'late' hold
#         reason). See NodeService.confirm_held_checkouts."""
#         return _held_checkout_action(_service.confirm_held_checkouts)

#     @app.post("/api/held-attendance/mark-half-day")
#     def api_held_attendance_mark_half_day():
#         """Operator action: an 'early' held checkout was actually a half
#         day — clear the checkout, flag the day. Rows held for the 'late'
#         reason are skipped. See NodeService.mark_held_checkouts_half_day."""
#         return _held_checkout_action(_service.mark_held_checkouts_half_day)

#     @app.post("/api/held-attendance/mark-short-leave")
#     def api_held_attendance_mark_short_leave():
#         """Operator action: an 'early' held checkout was a short leave, not
#         a full half day — clear the checkout, flag the day short_leave.
#         Rows held for the 'late' reason are skipped. See
#         NodeService.mark_held_checkouts_short_leave."""
#         return _held_checkout_action(_service.mark_held_checkouts_short_leave)

#     @app.post("/api/held-attendance/leave-open")
#     def api_held_attendance_leave_open():
#         """Operator action: a 'late' held checkout sighting shouldn't be
#         recorded as the checkout time — clear it, leave the day's status
#         untouched. Rows held for the 'early' reason are skipped. See
#         NodeService.leave_held_checkouts_open."""
#         return _held_checkout_action(_service.leave_held_checkouts_open)

#     @app.post("/api/held-attendance/mark-overtime")
#     def api_held_attendance_mark_overtime():
#         """Operator action: a 'late' held checkout sighting is overtime,
#         not a normal checkout — clear the tentative checkout, flag the day
#         as overtime. Rows held for the 'early' reason are skipped. See
#         NodeService.mark_held_checkouts_overtime."""
#         return _held_checkout_action(_service.mark_held_checkouts_overtime)
    
#     @app.post("/api/held-attendance/confirm-checkin")
#     def api_held_attendance_confirm_checkin():
#         """Operator action: accept a held LATE check-in sighting's stored
#         time as the real check-in. See NodeService.confirm_held_check_ins."""
#         return _held_checkout_action(_service.confirm_held_check_ins)

#     @app.post("/api/held-attendance/mark-half-day-checkin")
#     def api_held_attendance_mark_half_day_checkin():
#         """Operator action: a held LATE check-in should be recorded as a
#         half-day instead. See NodeService.mark_held_check_ins_half_day."""
#         return _held_checkout_action(_service.mark_held_check_ins_half_day)

#     @app.post("/api/held-attendance/sync")
#     def api_held_attendance_sync():
#         data = request.get_json(silent=True) or {}
#         local_event_ids = [str(v) for v in (data.get("local_event_ids") or []) if str(v).strip()]
#         if not local_event_ids:
#             return jsonify({"success": False, "message": "No records selected."}), 400
#         try:
#             synced_count = _service.sync_selected_attendance(local_event_ids)
#             return jsonify({
#                 "success": True,
#                 "synced_count": synced_count,
#                 "held_remaining": local_db.held_attendance_count(_current_branch_id()),
#             })
#         except Exception as exc:
#             return jsonify({"success": False, "message": str(exc)}), 400

#     @app.post("/api/held-attendance/delete")
#     def api_held_attendance_delete():
#         data = request.get_json(silent=True) or {}
#         local_event_ids = [str(v) for v in (data.get("local_event_ids") or []) if str(v).strip()]
#         if not local_event_ids:
#             return jsonify({"success": False, "message": "No records selected."}), 400
#         try:
#             # Restricted to held_for_review here (the trust boundary for
#             # this request), not left to local_db.delete_attendance_rows'
#             # by-id-only deletion — the held-review screen is the only UI
#             # surface that offers "delete", and it must never be able to
#             # delete a pending or already-synced row via a stale/replayed id.
#             requested = set(local_event_ids)
#             held_ids = {row["local_event_id"] for row in local_db.held_attendance_rows(_current_branch_id(), 500) if row["local_event_id"] in requested}
#             deleted_rows = _service.delete_held_attendance(list(held_ids))
#             return jsonify({
#                 "success": True,
#                 "deleted_count": len(deleted_rows),
#                 "held_remaining": local_db.held_attendance_count(_current_branch_id()),
#             })
#         except Exception as exc:
#             return jsonify({"success": False, "message": str(exc)}), 400

#     @app.post("/api/clear-today-attendance")
#     def api_clear_today_attendance():
#         """Maintenance/testing action: wipes today's attendance_buffer rows
#         (pending, held, and already-synced alike), clears the live-events
#         feed, and resets the per-camera dedupe throttle so a cleared person
#         is eligible to be re-detected on the very next frame instead of
#         waiting out DUPLICATE_LOG_SECONDS. This does not un-sync anything
#         already pushed to the backend — it only resets this node's local
#         view of today."""
#         try:
#             cleared = local_db.clear_today_attendance(_current_branch_id())
#             clear_events()
#             _camera_manager.clear_person_throttles()
#             return jsonify({
#                 "success": True,
#                 "cleared_count": cleared,
#                 "held_remaining": local_db.held_attendance_count(_current_branch_id()),
#             })
#         except Exception as exc:
#             return jsonify({"success": False, "message": str(exc)}), 400

#     @app.post("/api/import-embeddings")
#     def api_import_embeddings():
#         uploaded = request.files.get("package")
#         if uploaded is None or not uploaded.filename:
#             return jsonify({"success": False, "message": "No package file uploaded."}), 400

#         cfg = get_runtime_identity(load_config())
#         branch_id = str(cfg.get("branch_id") or "")
#         branch_name = str(cfg.get("branch_name") or "")
#         if not branch_id:
#             return jsonify({"success": False, "message": "Node is not activated."}), 400

#         with tempfile.TemporaryDirectory() as tmp_dir:
#             tmp_path = Path(tmp_dir) / "package.zip"
#             uploaded.save(tmp_path)
#             try:
#                 package = parse_embedding_package(tmp_path)
#             except PackageImportError as exc:
#                 return jsonify({"success": False, "message": str(exc)}), 400

#             package_branch_label = str(package.get("branch_label") or "").strip()
#             if branch_name and package_branch_label and package_branch_label != branch_name:
#                 return jsonify({
#                     "success": False,
#                     "message": (
#                         f"Package branch label '{package_branch_label}' does not match this node branch '{branch_name}'."
#                     ),
#                 }), 400

#             result = local_db.import_embedding_package(
#                 branch_id=branch_id,
#                 package_id=package["package_id"],
#                 branch_label=package["branch_label"],
#                 generated_at=package["generated_at"],
#                 records=package["records"],
#             )

#             recognition_worker.invalidate_cache() 

#         # Mirror this branch's full local embedding set to Supabase so cloud-mode
#         # recognition and offline fallback stay in sync with the authoritative
#         # local import. Best-effort by design: sync failure (e.g. node
#         # temporarily offline from Railway) must never fail the local import,
#         # since local recognition works independently of cloud connectivity.
#         # Delete-then-insert on the server side makes this push idempotent, so
#         # re-running an import after a prior sync failure self-heals Supabase.
#         cloud_sync = {"synced_count": 0, "sync_error": None}
#         try:
#             branch_records = local_db.get_embeddings_grouped_by_person(branch_id)
#             if branch_records:
#                 push_result = api_client.push_embeddings(branch_records)
#                 cloud_sync["synced_count"] = push_result.get("synced_count", 0)
#                 cloud_sync["results"] = push_result.get("results", [])
#         except Exception as exc:
#             cloud_sync["sync_error"] = str(exc)

#         return jsonify({
#             "success": True,
#             "branch_label": package["branch_label"],
#             "generated_at": package["generated_at"],
#             "source_csv_name": package.get("source_csv_name"),
#             "source_csv_sha256": package.get("source_csv_sha256"),
#             **result,
#             "cloud_sync": cloud_sync,
#         })

#     @app.get("/api/import-history")
#     def api_import_history():
#         return jsonify({"success": True, "history": local_db.import_history(20)})

#     @app.get("/")
#     def index():
#         dist = _web_dist()
#         index_file = dist / "index.html"
#         if index_file.exists():
#             return send_from_directory(dist, "index.html")
#         return "Build local_node_ui first: npm run build", 200

#     @app.get("/<path:path>")
#     def spa(path: str):
#         dist = _web_dist()
#         target = dist / path
#         if target.exists() and target.is_file():
#             return send_from_directory(dist, path)
#         return send_from_directory(dist, "index.html")

#     return app


# from __future__ import annotations

# import tempfile
# from pathlib import Path

# from flask import Flask, Response, jsonify, request, send_from_directory

# from local_node import local_db
# from local_node.activation import activate_with_token
# from local_node.camera_stream_manager import get_camera_stream_manager
# from local_node.config_store import get_branch_id, get_branch_name, get_org_id, get_runtime_identity, is_activated, load_config, read_runtime_status
# from local_node.live_events import list_events, clear_events
# from local_node.node_service import NodeService
# from local_node.package_import import PackageImportError, parse_embedding_package
# from local_node import api_client
# _service = NodeService()
# _camera_manager = get_camera_stream_manager()
# from local_node import recognition_worker



# def _web_dist() -> Path:
#     return Path(__file__).resolve().parent / "web" / "dist"


# def _current_branch_id() -> str:
#     """Single source of truth for "which branch is this node's local
#     attendance data scoped to" — every attendance_buffer read/maintenance
#     call below must pass this, or it risks operating across every branch
#     that has ever shared this machine's SQLite file (see local_db.py's
#     _ensure_schema_migrations branch_id docstring for why that used to
#     happen)."""
#     return get_branch_id(load_config())


# def create_app() -> Flask:
#     app = Flask(__name__, static_folder=None)  # disable Flask's implicit static route entirely
#     local_db.init_db()
#     _service.start()

#     @app.get("/api/status")
#     def api_status():
#         cfg = get_runtime_identity(load_config())
#         runtime = read_runtime_status()
#         return jsonify({
#             "success": True,
#             "activated": is_activated(),
#             "node_id": cfg.get("node_id"),
#             "org_id": cfg.get("org_id") or cfg.get("organization_id"),
#             "branch_id": cfg.get("branch_id"),
#             "branch_name": cfg.get("branch_name"),
#             "attendance_mode": cfg.get("attendance_mode"),
#             "hostname": cfg.get("hostname"),
#             "runtime": runtime,
#             "held_attendance_count": local_db.held_attendance_count(_current_branch_id()),
#         })

#     @app.post("/api/activate")
#     def api_activate():
#         data = request.get_json(silent=True) or {}
#         try:
#             config = activate_with_token(
#                 api_base_url=str(data.get("api_base_url") or ""),
#                 install_token=str(data.get("install_token") or ""),
#                 node_label=str(data.get("node_label") or "") or None,
#             )
#             return jsonify({"success": True, "config": config})
#         except Exception as exc:
#             return jsonify({"success": False, "message": str(exc)}), 400

#     @app.get("/api/live-events")
#     def api_live_events():
#         return jsonify({
#             "success": True,
#             "events": list_events(100),
#             "attendance": local_db.recent_attendance(_current_branch_id(), 50),
#         })

#     @app.get("/api/cameras")
#     def api_cameras():
#         return jsonify({"success": True, "cameras": _camera_manager.list_cameras()})

#     @app.get("/api/camera-stream/<camera_id>")
#     def api_camera_stream(camera_id: str):
#         return Response(
#             _camera_manager.mjpeg_frames(camera_id),
#             mimetype="multipart/x-mixed-replace; boundary=frame",
#         )
    
    
#     @app.post("/api/run-cycle")
#     def api_run_cycle():
#         try:
#             return jsonify({"success": True, "status": _service.run_cycle()})
#         except Exception as exc:
#             return jsonify({"success": False, "message": str(exc)}), 400

#     @app.post("/api/sync-attendance")
#     def api_sync_attendance():
#         try:
#             synced_count = _service.sync_all_attendance()
#             return jsonify({
#                 "success": True,
#                 "synced_count": synced_count,
#                 "held_remaining": local_db.held_attendance_count(_current_branch_id()),
#             })
#         except Exception as exc:
#             return jsonify({"success": False, "message": str(exc)}), 400

#     @app.get("/api/held-attendance")
#     def api_held_attendance():
#         """List every detection currently held for manual review (outside
#         its shift window) so the operator can see exactly who was sighted,
#         when, and on which camera before deciding whether to sync or
#         discard it — see local_db.held_attendance_rows."""
#         rows = local_db.held_attendance_rows(_current_branch_id(), 200)
#         held = [
#             {
#                 "id": row["local_event_id"],
#                 "people_type": row["people_type"],
#                 "person_code": row["person_code"],
#                 "staff_name": row.get("staff_name") or row["person_code"],
#                 "confidence": row.get("confidence"),
#                 "camera_id": row.get("camera_id"),
#                 "camera_name": (row.get("metadata") or {}).get("camera_name"),
#                 # Which calendar day this row belongs to (branch-local, see
#                 # local_db._today()) — surfaced explicitly rather than
#                 # making the operator infer it from marked_at, since held
#                 # rows have no expiry and can sit across multiple days.
#                 "attendance_date": row.get("attendance_date"),
#                 "marked_at": row.get("marked_at"),
#                 "check_out_marked_at": row.get("check_out_marked_at"),
#                 # A held row is one of three distinct cases the frontend
#                 # must label differently: an unconfirmed early check-in
#                 # stray (still waiting for the real in-window sighting —
#                 # see local_db.record_attendance_local's docstring), a
#                 # confirmed-but-late check-in, or a held CHECKOUT sighting
#                 # (check_out_hold_reason set — 'early' or 'late'). The
#                 # first two are check-in holds (check_out_hold_reason is
#                 # always None for those); the third is what the three
#                 # resolution endpoints below act on.
#                 "check_in_confirmed": bool(row.get("check_in_confirmed")),
#                 "check_in_hold_reason": row.get("check_in_hold_reason"),
#                 "check_out_hold_reason": row.get("check_out_hold_reason"),
#                 "notes": row.get("notes"),
#             }
#             for row in rows
#         ]
#         return jsonify({"success": True, "held": held})

#     def _held_checkout_action(action_fn):
#         """Shared request-handling for the three checkout-hold resolution
#         endpoints below — each differs only in which NodeService method it
#         calls, so this keeps the request parsing / response shaping DRY."""
#         data = request.get_json(silent=True) or {}
#         local_event_ids = [str(v) for v in (data.get("local_event_ids") or []) if str(v).strip()]
#         if not local_event_ids:
#             return jsonify({"success": False, "message": "No records selected."}), 400
#         try:
#             result = action_fn(local_event_ids)
#             return jsonify({
#                 "success": True,
#                 "resolved_count": len(result["resolved_ids"]),
#                 "skipped_count": len(result["skipped_ids"]),
#                 "skipped_ids": result["skipped_ids"],
#                 "held_remaining": local_db.held_attendance_count(_current_branch_id()),
#             })
#         except Exception as exc:
#             return jsonify({"success": False, "message": str(exc)}), 400

#     @app.post("/api/held-attendance/confirm-checkout")
#     def api_held_attendance_confirm_checkout():
#         """Operator action: accept a held checkout sighting's stored time
#         as the real checkout (valid for either 'early' or 'late' hold
#         reason). See NodeService.confirm_held_checkouts."""
#         return _held_checkout_action(_service.confirm_held_checkouts)

#     @app.post("/api/held-attendance/mark-half-day")
#     def api_held_attendance_mark_half_day():
#         """Operator action: an 'early' held checkout was actually a half
#         day — clear the checkout, flag the day. Rows held for the 'late'
#         reason are skipped. See NodeService.mark_held_checkouts_half_day."""
#         return _held_checkout_action(_service.mark_held_checkouts_half_day)

#     @app.post("/api/held-attendance/mark-short-leave")
#     def api_held_attendance_mark_short_leave():
#         """Operator action: an 'early' held checkout was a short leave, not
#         a full half day — clear the checkout, flag the day short_leave.
#         Rows held for the 'late' reason are skipped. See
#         NodeService.mark_held_checkouts_short_leave."""
#         return _held_checkout_action(_service.mark_held_checkouts_short_leave)

#     @app.post("/api/held-attendance/leave-open")
#     def api_held_attendance_leave_open():
#         """Operator action: a 'late' held checkout sighting shouldn't be
#         recorded as the checkout time — clear it, leave the day's status
#         untouched. Rows held for the 'early' reason are skipped. See
#         NodeService.leave_held_checkouts_open."""
#         return _held_checkout_action(_service.leave_held_checkouts_open)

#     @app.post("/api/held-attendance/mark-overtime")
#     def api_held_attendance_mark_overtime():
#         """Operator action: a 'late' held checkout sighting is overtime,
#         not a normal checkout — clear the tentative checkout, flag the day
#         as overtime. Rows held for the 'early' reason are skipped. See
#         NodeService.mark_held_checkouts_overtime."""
#         return _held_checkout_action(_service.mark_held_checkouts_overtime)
    
#     @app.post("/api/held-attendance/confirm-checkin")
#     def api_held_attendance_confirm_checkin():
#         """Operator action: accept a held LATE check-in sighting's stored
#         time as the real check-in. See NodeService.confirm_held_check_ins."""
#         return _held_checkout_action(_service.confirm_held_check_ins)

#     @app.post("/api/held-attendance/mark-half-day-checkin")
#     def api_held_attendance_mark_half_day_checkin():
#         """Operator action: a held LATE check-in should be recorded as a
#         half-day instead. See NodeService.mark_held_check_ins_half_day."""
#         return _held_checkout_action(_service.mark_held_check_ins_half_day)

#     @app.post("/api/held-attendance/sync")
#     def api_held_attendance_sync():
#         data = request.get_json(silent=True) or {}
#         local_event_ids = [str(v) for v in (data.get("local_event_ids") or []) if str(v).strip()]
#         if not local_event_ids:
#             return jsonify({"success": False, "message": "No records selected."}), 400
#         try:
#             synced_count = _service.sync_selected_attendance(local_event_ids)
#             return jsonify({
#                 "success": True,
#                 "synced_count": synced_count,
#                 "held_remaining": local_db.held_attendance_count(_current_branch_id()),
#             })
#         except Exception as exc:
#             return jsonify({"success": False, "message": str(exc)}), 400

#     @app.post("/api/held-attendance/delete")
#     def api_held_attendance_delete():
#         data = request.get_json(silent=True) or {}
#         local_event_ids = [str(v) for v in (data.get("local_event_ids") or []) if str(v).strip()]
#         if not local_event_ids:
#             return jsonify({"success": False, "message": "No records selected."}), 400
#         try:
#             # Restricted to held_for_review here (the trust boundary for
#             # this request), not left to local_db.delete_attendance_rows'
#             # by-id-only deletion — the held-review screen is the only UI
#             # surface that offers "delete", and it must never be able to
#             # delete a pending or already-synced row via a stale/replayed id.
#             requested = set(local_event_ids)
#             held_ids = {row["local_event_id"] for row in local_db.held_attendance_rows(_current_branch_id(), 500) if row["local_event_id"] in requested}
#             deleted_rows = _service.delete_held_attendance(list(held_ids))
#             return jsonify({
#                 "success": True,
#                 "deleted_count": len(deleted_rows),
#                 "held_remaining": local_db.held_attendance_count(_current_branch_id()),
#             })
#         except Exception as exc:
#             return jsonify({"success": False, "message": str(exc)}), 400

#     @app.post("/api/clear-today-attendance")
#     def api_clear_today_attendance():
#         """Maintenance/testing action: wipes today's attendance_buffer rows
#         (pending, held, and already-synced alike), clears the live-events
#         feed, and resets the per-camera dedupe throttle so a cleared person
#         is eligible to be re-detected on the very next frame instead of
#         waiting out DUPLICATE_LOG_SECONDS. This does not un-sync anything
#         already pushed to the backend — it only resets this node's local
#         view of today."""
#         try:
#             cleared = local_db.clear_today_attendance(_current_branch_id())
#             clear_events()
#             _camera_manager.clear_person_throttles()
#             return jsonify({
#                 "success": True,
#                 "cleared_count": cleared,
#                 "held_remaining": local_db.held_attendance_count(_current_branch_id()),
#             })
#         except Exception as exc:
#             return jsonify({"success": False, "message": str(exc)}), 400

#     @app.post("/api/import-embeddings")
#     def api_import_embeddings():
#         uploaded = request.files.get("package")
#         if uploaded is None or not uploaded.filename:
#             return jsonify({"success": False, "message": "No package file uploaded."}), 400

#         cfg = get_runtime_identity(load_config())
#         branch_id = str(cfg.get("branch_id") or "")
#         branch_name = str(cfg.get("branch_name") or "")
#         if not branch_id:
#             return jsonify({"success": False, "message": "Node is not activated."}), 400

#         with tempfile.TemporaryDirectory() as tmp_dir:
#             tmp_path = Path(tmp_dir) / "package.zip"
#             uploaded.save(tmp_path)
#             try:
#                 package = parse_embedding_package(tmp_path)
#             except PackageImportError as exc:
#                 return jsonify({"success": False, "message": str(exc)}), 400

#             package_branch_label = str(package.get("branch_label") or "").strip()
#             if branch_name and package_branch_label and package_branch_label != branch_name:
#                 return jsonify({
#                     "success": False,
#                     "message": (
#                         f"Package branch label '{package_branch_label}' does not match this node branch '{branch_name}'."
#                     ),
#                 }), 400

#             result = local_db.import_embedding_package(
#                 branch_id=branch_id,
#                 package_id=package["package_id"],
#                 branch_label=package["branch_label"],
#                 generated_at=package["generated_at"],
#                 records=package["records"],
#             )

#             recognition_worker.invalidate_cache() 

#         # Mirror this branch's full local embedding set to Supabase so cloud-mode
#         # recognition and offline fallback stay in sync with the authoritative
#         # local import. Best-effort by design: sync failure (e.g. node
#         # temporarily offline from Railway) must never fail the local import,
#         # since local recognition works independently of cloud connectivity.
#         # Delete-then-insert on the server side makes this push idempotent, so
#         # re-running an import after a prior sync failure self-heals Supabase.
#         cloud_sync = {"synced_count": 0, "sync_error": None}
#         try:
#             branch_records = local_db.get_embeddings_grouped_by_person(branch_id)
#             if branch_records:
#                 push_result = api_client.push_embeddings(branch_records)
#                 cloud_sync["synced_count"] = push_result.get("synced_count", 0)
#                 cloud_sync["results"] = push_result.get("results", [])
#         except Exception as exc:
#             cloud_sync["sync_error"] = str(exc)

#         return jsonify({
#             "success": True,
#             "branch_label": package["branch_label"],
#             "generated_at": package["generated_at"],
#             "source_csv_name": package.get("source_csv_name"),
#             "source_csv_sha256": package.get("source_csv_sha256"),
#             **result,
#             "cloud_sync": cloud_sync,
#         })

#     @app.get("/api/import-history")
#     def api_import_history():
#         return jsonify({"success": True, "history": local_db.import_history(20)})

#     @app.get("/")
#     def index():
#         dist = _web_dist()
#         index_file = dist / "index.html"
#         if index_file.exists():
#             return send_from_directory(dist, "index.html")
#         return "Build local_node_ui first: npm run build", 200

#     @app.get("/<path:path>")
#     def spa(path: str):
#         dist = _web_dist()
#         target = dist / path
#         if target.exists() and target.is_file():
#             return send_from_directory(dist, path)
#         return send_from_directory(dist, "index.html")

#     return app


from __future__ import annotations

import tempfile
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

from local_node import local_db
from local_node.activation import activate_with_token
from local_node.camera_stream_manager import get_camera_stream_manager
from local_node.config_store import get_branch_id, get_branch_name, get_org_id, get_runtime_identity, is_activated, load_config, read_runtime_status
from local_node.live_events import list_events, clear_events
from local_node.node_service import NodeService
from local_node.package_import import PackageImportError, parse_embedding_package
from local_node import api_client
_service = NodeService()
_camera_manager = get_camera_stream_manager()
from local_node import recognition_worker



def _web_dist() -> Path:
    return Path(__file__).resolve().parent / "web" / "dist"


def _current_branch_id() -> str:
    """Single source of truth for "which branch is this node's local
    attendance data scoped to" — every attendance_buffer read/maintenance
    call below must pass this, or it risks operating across every branch
    that has ever shared this machine's SQLite file (see local_db.py's
    _ensure_schema_migrations branch_id docstring for why that used to
    happen)."""
    return get_branch_id(load_config())


def create_app() -> Flask:
    app = Flask(__name__, static_folder=None)  # disable Flask's implicit static route entirely
    local_db.init_db()
    _service.start()

    @app.get("/api/status")
    def api_status():
        cfg = get_runtime_identity(load_config())
        runtime = read_runtime_status()
        return jsonify({
            "success": True,
            "activated": is_activated(),
            "node_id": cfg.get("node_id"),
            "org_id": cfg.get("org_id") or cfg.get("organization_id"),
            "branch_id": cfg.get("branch_id"),
            "branch_name": cfg.get("branch_name"),
            "attendance_mode": cfg.get("attendance_mode"),
            "hostname": cfg.get("hostname"),
            "runtime": runtime,
            "held_attendance_count": local_db.held_attendance_count(_current_branch_id()),
        })

    @app.post("/api/activate")
    def api_activate():
        data = request.get_json(silent=True) or {}
        try:
            config = activate_with_token(
                api_base_url=str(data.get("api_base_url") or ""),
                install_token=str(data.get("install_token") or ""),
                node_label=str(data.get("node_label") or "") or None,
            )
            return jsonify({"success": True, "config": config})
        except Exception as exc:
            return jsonify({"success": False, "message": str(exc)}), 400

    @app.get("/api/live-events")
    def api_live_events():
        return jsonify({
            "success": True,
            "events": list_events(100),
            "attendance": local_db.recent_attendance(_current_branch_id(), 50),
        })

    @app.get("/api/cameras")
    def api_cameras():
        return jsonify({"success": True, "cameras": _camera_manager.list_cameras()})

    @app.get("/api/camera-stream/<camera_id>")
    def api_camera_stream(camera_id: str):
        return Response(
            _camera_manager.mjpeg_frames(camera_id),
            mimetype="multipart/x-mixed-replace; boundary=frame",
        )
    
    
    @app.post("/api/run-cycle")
    def api_run_cycle():
        try:
            return jsonify({"success": True, "status": _service.run_cycle()})
        except Exception as exc:
            return jsonify({"success": False, "message": str(exc)}), 400

    @app.post("/api/sync-attendance")
    def api_sync_attendance():
        try:
            synced_count = _service.sync_all_attendance()
            return jsonify({
                "success": True,
                "synced_count": synced_count,
                "held_remaining": local_db.held_attendance_count(_current_branch_id()),
            })
        except Exception as exc:
            return jsonify({"success": False, "message": str(exc)}), 400

    @app.get("/api/held-attendance")
    def api_held_attendance():
        """List every detection currently held for manual review (outside
        its shift window) so the operator can see exactly who was sighted,
        when, and on which camera before deciding whether to sync or
        discard it — see local_db.held_attendance_rows."""
        rows = local_db.held_attendance_rows(_current_branch_id(), 200)
        held = [
            {
                "id": row["local_event_id"],
                "people_type": row["people_type"],
                "person_code": row["person_code"],
                "staff_name": row.get("staff_name") or row["person_code"],
                "confidence": row.get("confidence"),
                "camera_id": row.get("camera_id"),
                "camera_name": (row.get("metadata") or {}).get("camera_name"),
                "attendance_date": row.get("attendance_date"),
                "marked_at": row.get("marked_at"),
                "check_out_marked_at": row.get("check_out_marked_at"),
                "check_in_confirmed": bool(row.get("check_in_confirmed")),
                "check_in_hold_reason": row.get("check_in_hold_reason"),
                "check_out_hold_reason": row.get("check_out_hold_reason"),
                "notes": row.get("notes"),
                # The decision the operator already made (late / half_day /
                # short_leave / overtime), if any — None until resolved.
                "status": row.get("status"),
                # True once BOTH hold reasons are cleared — i.e. the operator
                # has already picked an outcome for this row and it is now
                # just sitting in held_for_review waiting for an explicit
                # sync click, not waiting for a decision. Computed here
                # (not stored) so there is exactly one place that defines
                # "resolved" instead of every caller re-deriving it.
                # An EARLY check-in hold carries no hold_reason by design
                # (local_db.record_attendance_local sets check_in_hold_reason
                # only for the 'late' case), so absence of a reason cannot
                # mean "resolved" — for an unconfirmed check-in it means the
                # opposite: still waiting for the shift window to open. Key
                # off the confirmation flags, which are what the per-leg
                # state machine actually advances.
                "resolved": bool(
                    row.get("check_in_confirmed")
                    and not row.get("check_out_hold_reason")
                ),
            }
            for row in rows
        ]
        return jsonify({"success": True, "held": held})

    def _held_checkout_action(action_fn):
        """Shared request-handling for the three checkout-hold resolution
        endpoints below — each differs only in which NodeService method it
        calls, so this keeps the request parsing / response shaping DRY."""
        data = request.get_json(silent=True) or {}
        local_event_ids = [str(v) for v in (data.get("local_event_ids") or []) if str(v).strip()]
        if not local_event_ids:
            return jsonify({"success": False, "message": "No records selected."}), 400
        try:
            result = action_fn(local_event_ids)
            return jsonify({
                "success": True,
                "resolved_count": len(result["resolved_ids"]),
                "skipped_count": len(result["skipped_ids"]),
                "skipped_ids": result["skipped_ids"],
                "held_remaining": local_db.held_attendance_count(_current_branch_id()),
            })
        except Exception as exc:
            return jsonify({"success": False, "message": str(exc)}), 400

    @app.post("/api/held-attendance/mark-late")
    def api_held_attendance_mark_late():
        """Operator action: a 'late' held checkout sighting IS real, but
        isn't overtime — accept the sighted time as the real checkout and
        flag the day status='late' so the admin dashboard has a decision
        to make. One of exactly two decisions for a late-checkout hold
        (the other is mark-overtime); rows held for the 'early' reason are
        skipped. See NodeService.mark_held_checkouts_late."""
        return _held_checkout_action(_service.mark_held_checkouts_late)

    @app.post("/api/held-attendance/mark-half-day")
    def api_held_attendance_mark_half_day():
        """Operator action: an 'early' held checkout was actually a half
        day — clear the checkout, flag the day. Rows held for the 'late'
        reason are skipped. See NodeService.mark_held_checkouts_half_day."""
        return _held_checkout_action(_service.mark_held_checkouts_half_day)

    @app.post("/api/held-attendance/mark-short-leave")
    def api_held_attendance_mark_short_leave():
        """Operator action: an 'early' held checkout was a short leave, not
        a full half day — clear the checkout, flag the day short_leave.
        Rows held for the 'late' reason are skipped. See
        NodeService.mark_held_checkouts_short_leave."""
        return _held_checkout_action(_service.mark_held_checkouts_short_leave)

    @app.post("/api/held-attendance/mark-overtime")
    def api_held_attendance_mark_overtime():
        """Operator action: a 'late' held checkout sighting is overtime,
        not a normal checkout — clear the tentative checkout, flag the day
        as overtime. Rows held for the 'early' reason are skipped. See
        NodeService.mark_held_checkouts_overtime."""
        return _held_checkout_action(_service.mark_held_checkouts_overtime)

    @app.post("/api/held-attendance/mark-early-left")
    def api_held_attendance_mark_early_left():
        """Operator action: an 'early' held checkout really was the person
        leaving early — accept the sighted time as the real checkout, but
        (unlike mark-half-day/mark-short-leave) don't touch the day's
        status; just record "Early left" as a note, since status is the
        arrival-side classification. Third option for an early-checkout
        hold, alongside mark-half-day and mark-short-leave. Rows held for
        the 'late' reason are skipped. See
        NodeService.mark_held_checkouts_early_left."""
        return _held_checkout_action(_service.mark_held_checkouts_early_left)

    @app.post("/api/held-attendance/mark-late-checkin")
    def api_held_attendance_mark_late_checkin():
        """Operator action: a held LATE check-in sighting really is just a
        late arrival — accept the sighted time as the real check-in and
        flag the day status='late'. One of three decisions for a late
        check-in hold, alongside mark-short-leave-checkin and
        mark-half-day-checkin. See NodeService.mark_held_check_ins_late."""
        return _held_checkout_action(_service.mark_held_check_ins_late)

    @app.post("/api/held-attendance/mark-short-leave-checkin")
    def api_held_attendance_mark_short_leave_checkin():
        """Operator action: a held LATE check-in sighting reflects the
        person being on a manager-approved short leave, not a full absence
        — accept the sighted time as the real check-in and flag the day
        status='short_leave'. One of three decisions for a late check-in
        hold, alongside mark-late-checkin and mark-half-day-checkin. See
        NodeService.mark_held_check_ins_short_leave."""
        return _held_checkout_action(_service.mark_held_check_ins_short_leave)

    @app.post("/api/held-attendance/mark-half-day-checkin")
    def api_held_attendance_mark_half_day_checkin():
        """Operator action: a held LATE check-in should be recorded as a
        half-day instead. See NodeService.mark_held_check_ins_half_day."""
        return _held_checkout_action(_service.mark_held_check_ins_half_day)

    @app.post("/api/held-attendance/sync")
    def api_held_attendance_sync():
        data = request.get_json(silent=True) or {}
        local_event_ids = [str(v) for v in (data.get("local_event_ids") or []) if str(v).strip()]
        if not local_event_ids:
            return jsonify({"success": False, "message": "No records selected."}), 400
        try:
            synced_count = _service.sync_selected_attendance(local_event_ids)
            return jsonify({
                "success": True,
                "synced_count": synced_count,
                "held_remaining": local_db.held_attendance_count(_current_branch_id()),
            })
        except Exception as exc:
            return jsonify({"success": False, "message": str(exc)}), 400

    @app.post("/api/held-attendance/delete")
    def api_held_attendance_delete():
        data = request.get_json(silent=True) or {}
        local_event_ids = [str(v) for v in (data.get("local_event_ids") or []) if str(v).strip()]
        if not local_event_ids:
            return jsonify({"success": False, "message": "No records selected."}), 400
        try:
            # Restricted to held_for_review here (the trust boundary for
            # this request), not left to local_db.delete_attendance_rows'
            # by-id-only deletion — the held-review screen is the only UI
            # surface that offers "delete", and it must never be able to
            # delete a pending or already-synced row via a stale/replayed id.
            requested = set(local_event_ids)
            held_ids = {row["local_event_id"] for row in local_db.held_attendance_rows(_current_branch_id(), 500) if row["local_event_id"] in requested}
            deleted_rows = _service.delete_held_attendance(list(held_ids))
            return jsonify({
                "success": True,
                "deleted_count": len(deleted_rows),
                "held_remaining": local_db.held_attendance_count(_current_branch_id()),
            })
        except Exception as exc:
            return jsonify({"success": False, "message": str(exc)}), 400

    @app.post("/api/clear-today-attendance")
    def api_clear_today_attendance():
        """Maintenance/testing action: wipes today's attendance_buffer rows
        (pending, held, and already-synced alike), clears the live-events
        feed, and resets the per-camera dedupe throttle so a cleared person
        is eligible to be re-detected on the very next frame instead of
        waiting out DUPLICATE_LOG_SECONDS. This does not un-sync anything
        already pushed to the backend — it only resets this node's local
        view of today."""
        try:
            cleared = local_db.clear_today_attendance(_current_branch_id())
            clear_events()
            _camera_manager.clear_person_throttles()
            return jsonify({
                "success": True,
                "cleared_count": cleared,
                "held_remaining": local_db.held_attendance_count(_current_branch_id()),
            })
        except Exception as exc:
            return jsonify({"success": False, "message": str(exc)}), 400

    @app.post("/api/import-embeddings")
    def api_import_embeddings():
        uploaded = request.files.get("package")
        if uploaded is None or not uploaded.filename:
            return jsonify({"success": False, "message": "No package file uploaded."}), 400

        cfg = get_runtime_identity(load_config())
        branch_id = str(cfg.get("branch_id") or "")
        branch_name = str(cfg.get("branch_name") or "")
        if not branch_id:
            return jsonify({"success": False, "message": "Node is not activated."}), 400

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir) / "package.zip"
            uploaded.save(tmp_path)
            try:
                package = parse_embedding_package(tmp_path)
            except PackageImportError as exc:
                return jsonify({"success": False, "message": str(exc)}), 400

            package_branch_label = str(package.get("branch_label") or "").strip()
            if branch_name and package_branch_label and package_branch_label != branch_name:
                return jsonify({
                    "success": False,
                    "message": (
                        f"Package branch label '{package_branch_label}' does not match this node branch '{branch_name}'."
                    ),
                }), 400

            result = local_db.import_embedding_package(
                branch_id=branch_id,
                package_id=package["package_id"],
                branch_label=package["branch_label"],
                generated_at=package["generated_at"],
                records=package["records"],
            )

            recognition_worker.invalidate_cache() 

        # Mirror this branch's full local embedding set to Supabase so cloud-mode
        # recognition and offline fallback stay in sync with the authoritative
        # local import. Best-effort by design: sync failure (e.g. node
        # temporarily offline from Railway) must never fail the local import,
        # since local recognition works independently of cloud connectivity.
        # Delete-then-insert on the server side makes this push idempotent, so
        # re-running an import after a prior sync failure self-heals Supabase.
        cloud_sync = {"synced_count": 0, "sync_error": None}
        try:
            branch_records = local_db.get_embeddings_grouped_by_person(branch_id)
            if branch_records:
                push_result = api_client.push_embeddings(branch_records)
                cloud_sync["synced_count"] = push_result.get("synced_count", 0)
                cloud_sync["results"] = push_result.get("results", [])
        except Exception as exc:
            cloud_sync["sync_error"] = str(exc)

        return jsonify({
            "success": True,
            "branch_label": package["branch_label"],
            "generated_at": package["generated_at"],
            "source_csv_name": package.get("source_csv_name"),
            "source_csv_sha256": package.get("source_csv_sha256"),
            **result,
            "cloud_sync": cloud_sync,
        })

    @app.get("/api/import-history")
    def api_import_history():
        return jsonify({"success": True, "history": local_db.import_history(20)})

    @app.get("/")
    def index():
        dist = _web_dist()
        index_file = dist / "index.html"
        if index_file.exists():
            return send_from_directory(dist, "index.html")
        return "Build local_node_ui first: npm run build", 200

    @app.get("/<path:path>")
    def spa(path: str):
        dist = _web_dist()
        target = dist / path
        if target.exists() and target.is_file():
            return send_from_directory(dist, path)
        return send_from_directory(dist, "index.html")

    return app