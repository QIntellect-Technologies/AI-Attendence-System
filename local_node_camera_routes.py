"""
backend/local_node_camera_routes.py
───────────────────────────────────────────────────────────────────────────────
Connects onboarding camera/NVR configuration with the local attendance node.

Endpoints added:
- GET  /api/local-node/config
- GET  /api/attendance/events/today

Important:
- Normal dashboard reads never return rtsp_password.
- Local node config returns full RTSP URLs only when node key matches.
- Attendance WRITES for local nodes go through /v1/node/push-attendance
  (support_db.push_node_attendance), not through this file. This module
  used to also expose POST /api/local-node/attendance-event as a second,
  parallel write path with its own single-global-key auth, no same-day
  dedup, and no shift/timing-window resolution — it was never called by
  any local-node client (api_client.py talks to /v1/node/push-attendance
  exclusively), so it was removed rather than kept as an unused, silently
  divergent path into the same attendance table.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone, time
from typing import Any, Dict, List, Optional
from urllib.parse import quote

from flask import Flask, jsonify, request

from support_db import _normalize_camera_type


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _as_int(value: Any, fallback: Optional[int] = None) -> Optional[int]:
    try:
        if value is None or str(value).strip() == "":
            return fallback
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _as_bool(value: Any, fallback: bool = True) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return fallback
    return str(value).strip().lower() not in {"0", "false", "no", "off"}


def _request_node_key() -> str:
    auth = request.headers.get("Authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()

    return (
        request.headers.get("X-Node-Api-Key")
        or request.headers.get("X-Node-API-Key")
        or request.headers.get("x-node-api-key")
        or ""
    ).strip()


def _public_network(network: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not network:
        return None

    return {
        "id": network.get("id"),
        "organization_id": network.get("organization_id"),
        "branch_id": network.get("branch_id"),
        "public_ip": network.get("public_ip"),
        "nvr_local_ip": network.get("nvr_local_ip"),
        "rtsp_port": network.get("rtsp_port"),
        "rtsp_username": network.get("rtsp_username"),
        "created_at": network.get("created_at"),
        "updated_at": network.get("updated_at"),
    }


def _build_rtsp_url(
    network: Dict[str, Any],
    camera: Dict[str, Any],
    *,
    use_public_ip: bool = False,
) -> Optional[str]:
    existing = _clean_text(camera.get("rtsp_url"))
    if existing:
        return existing

    host = _clean_text(network.get("public_ip" if use_public_ip else "nvr_local_ip"))
    if not host:
        host = _clean_text(network.get("nvr_local_ip") or network.get("public_ip"))
    if not host:
        return None

    port = _as_int(network.get("rtsp_port"), 554) or 554
    username = _clean_text(network.get("rtsp_username")) or ""
    password = _clean_text(network.get("rtsp_password")) or ""
    channel = _as_int(camera.get("channel"), 1) or 1
    stream_path = _clean_text(camera.get("stream_path"))

    if not stream_path:
        # Dahua style, matching your URLs:
        # rtsp://admin:***@192.168.0.77:554/cam/realmonitor?channel=3&subtype=1
        stream_path = f"cam/realmonitor?channel={channel}&subtype=1"

    auth = ""
    if username or password:
        auth = f"{quote(username, safe='')}:{quote(password, safe='')}@"

    return f"rtsp://{auth}{host}:{port}/{stream_path.lstrip('/')}"


def _normalize_camera_row(data: Dict[str, Any], organization_id: Any, branch_id: Any) -> Dict[str, Any]:
    channel = _as_int(data.get("channel"), None)
    camera_type = _normalize_camera_type(data.get("camera_type") or data.get("cameraType") or data.get("type"))
    return {
        "organization_id": str(organization_id),
        "branch_id": str(branch_id),
        "camera_name": _clean_text(data.get("camera_name") or data.get("name")) or "Camera",
        "camera_type": camera_type,
        "channel": channel,
        "stream_path": _clean_text(data.get("stream_path") or data.get("streamPath") or data.get("path")),
        "rtsp_url": _clean_text(data.get("rtsp_url") or data.get("rtspUrl")) if camera_type != "webcam" else None,
        "location": _clean_text(data.get("location")),
        "enabled": _as_bool(data.get("enabled"), True),
        "updated_at": _utc_now_iso(),
    }

def _normalize_network_row(data: Dict[str, Any], organization_id: Any, branch_id: Any) -> Dict[str, Any]:
    """Normalize network config from either onboarding or direct API payload."""
    return {
        "organization_id": str(organization_id),
        "branch_id": str(branch_id),
        "public_ip": _clean_text(data.get("public_ip") or data.get("publicIp")),
        "nvr_local_ip": _clean_text(
            data.get("nvr_local_ip")
            or data.get("nvrLocalIp")
            or data.get("nvr_dvr_ip")
            or data.get("nvrDvrIp")
            or data.get("nvr_ip")
            or data.get("nvrIp")
            or data.get("local_ip")
            or data.get("localIp")
            or data.get("ip")
        ),
        "rtsp_port": _as_int(data.get("rtsp_port") or data.get("rtspPort") or data.get("port"), 554),
        "rtsp_username": _clean_text(data.get("rtsp_username") or data.get("rtspUsername") or data.get("username")),
        "rtsp_password": _clean_text(data.get("rtsp_password") or data.get("rtspPassword") or data.get("password")),
        "updated_at": _utc_now_iso(),
    }


def _branch_candidates(supabase: Any, organization_id: str, branch_id: str) -> tuple[str, list[str]]:
    """Return (backend_branch_id, candidate keys) for UUID and numeric UI branch ids.

    The current React dashboard exposes branch ids as 1..N but Supabase stores
    real UUID branch IDs. Local node config may receive either. This function
    accepts both and builds keys used by client_onboarding_configs.
    """
    raw = str(branch_id or "").strip()
    candidates: list[str] = []

    def add(value: Any) -> None:
        value = str(value or "").strip()
        if value and value not in candidates:
            candidates.append(value)

    add(raw)

    backend_branch_id = raw
    try:
        branches_result = (
            supabase.table("branches")
            .select("id,name,created_at")
            .eq("org_id", str(organization_id))
            .order("created_at")
            .execute()
        )
        branches = branches_result.data or []
    except Exception:
        branches = []

    # If branch_id is a UI id like "1", map it to the first Supabase branch UUID.
    ui_index = _as_int(raw, None)
    if ui_index and 1 <= ui_index <= len(branches):
        backend_branch_id = str(branches[ui_index - 1].get("id") or raw)
        add(backend_branch_id)
        add(ui_index)

    # If branch_id is already a backend UUID, also add its UI index as a possible key.
    for idx, branch in enumerate(branches, start=1):
        if str(branch.get("id")) == raw:
            backend_branch_id = raw
            add(idx)
            break

    return backend_branch_id, candidates


def _pick_branch_config(value: Any, candidates: list[str]) -> Any:
    """Pick branch-specific config from a dict keyed by UUID or UI id."""
    if not isinstance(value, dict):
        return value

    for key in candidates:
        if key in value:
            return value[key]

    # Some frontends store nested branch config under these keys.
    for wrapper_key in ("branches", "byBranch", "branchConfigs", "branch_config"):
        wrapper = value.get(wrapper_key)
        if isinstance(wrapper, dict):
            for key in candidates:
                if key in wrapper:
                    return wrapper[key]

    return value


def _fallback_config_from_onboarding(
    supabase: Any,
    organization_id: str,
    branch_id: str,
) -> tuple[Optional[Dict[str, Any]], List[Dict[str, Any]], str]:
    """Read camera/NVR config from client_onboarding_configs and mirror it.

    This fixes the local flow where onboarding saved config only in
    client_onboarding_configs, while the local node route reads
    branch_network_configs and branch_cameras.
    """
    backend_branch_id, candidates = _branch_candidates(supabase, str(organization_id), str(branch_id))

    try:
        onboarding_result = (
            supabase.table("client_onboarding_configs")
            .select("network,cameras")
            .eq("org_id", str(organization_id))
            .limit(1)
            .execute()
        )
    except Exception:
        return None, [], backend_branch_id

    if not onboarding_result.data:
        return None, [], backend_branch_id

    saved = onboarding_result.data[0] or {}
    raw_network = _pick_branch_config(saved.get("network") or {}, candidates)
    raw_cameras = _pick_branch_config(saved.get("cameras") or {}, candidates)

    if not isinstance(raw_network, dict):
        raw_network = {}

    if isinstance(raw_cameras, dict):
        # Some camera configs are stored as {cameraId: cameraObject}; convert to list.
        raw_cameras = [v for v in raw_cameras.values() if isinstance(v, dict)]
    elif not isinstance(raw_cameras, list):
        raw_cameras = []

    network = _normalize_network_row(raw_network, organization_id, backend_branch_id)
    cameras = [_normalize_camera_row(camera, organization_id, backend_branch_id) for camera in raw_cameras if isinstance(camera, dict)]

    # If there is no NVR host but cameras have full RTSP URLs, still allow the node.
    # A branch with only a webcam has neither an NVR host nor an RTSP camera,
    # but is still a valid, capturable configuration.
    has_network_host = bool(network.get("nvr_local_ip") or network.get("public_ip"))
    has_camera_rtsp = any(_clean_text(camera.get("rtsp_url")) for camera in cameras)
    has_webcam = any(str(camera.get("camera_type") or "").lower() == "webcam" for camera in cameras)
    if not has_network_host and not has_camera_rtsp and not has_webcam:
        return None, [], backend_branch_id

    # Best-effort mirror so the next request reads from the local-node tables.
    try:
        supabase.table("branch_network_configs").upsert(
            network,
            on_conflict="organization_id,branch_id",
        ).execute()

        supabase.table("branch_cameras").delete().eq("organization_id", str(organization_id)).eq(
            "branch_id", str(backend_branch_id)
        ).execute()

        if cameras:
            supabase.table("branch_cameras").insert(cameras).execute()
    except Exception:
        # Do not block dry-run; return the recovered config for this request.
        pass

    return network, cameras, backend_branch_id


def _date_bounds_iso(date_value: str) -> tuple[str, str]:
    day = datetime.fromisoformat(date_value).date()
    start_dt = datetime.combine(day, time.min, tzinfo=timezone.utc)
    end_dt = datetime.combine(day, time.max, tzinfo=timezone.utc)
    return start_dt.isoformat(), end_dt.isoformat()


def _staff_name_map(supabase: Any, org_id: str, staff_ids: list[str]) -> dict[str, dict]:
    if not staff_ids:
        return {}

    try:
        result = (
            supabase.table("client_staff")
            .select("id,name,department_name,role_name,branch_id,branch_name")
            .eq("org_id", str(org_id))
            .in_("id", staff_ids)
            .execute()
        )
        return {str(row.get("id")): row for row in (result.data or [])}
    except Exception:
        return {}


def _map_attendance_row(row: dict, staff_by_id: dict[str, dict]) -> dict:
    staff_id = str(row.get("staff_id") or "")
    staff = staff_by_id.get(staff_id) or {}
    ts = row.get("timestamp") or row.get("check_in_time") or row.get("created_at")

    return {
        "id": row.get("id"),
        "organization_id": row.get("org_id") or row.get("organization_id"),
        "org_id": row.get("org_id") or row.get("organization_id"),
        "branch_id": row.get("branch_id"),
        "staff_id": staff_id,
        "user_id": staff_id,
        "user_name": staff.get("name") or row.get("staff_name") or staff_id,
        "staff_name": staff.get("name") or row.get("staff_name") or staff_id,
        "department": staff.get("department_name") or row.get("department") or "",
        "attendance_date": str(ts or "")[:10],
        "status": "PRESENT",
        "timestamp": ts,
        "check_in": ts,
        "check_in_time": ts,
        "check_out_time": None,
        "source": row.get("source") or "camera",
        "confidence": row.get("confidence"),
        "camera_id": row.get("camera_id"),
        "node_id": row.get("node_id"),
        "created_at": row.get("created_at") or ts,
        "updated_at": row.get("updated_at") or ts,
    }


def register_local_node_camera_routes(app: Flask, supabase: Any) -> None:
    local_node_api_key = os.getenv("LOCAL_NODE_API_KEY", "local-dev-node-key")

    def require_node_key():
        node_key = _request_node_key()
        if not node_key or node_key != local_node_api_key:
            return jsonify({"success": False, "message": "Invalid local node API key"}), 401
        return None


    @app.route("/api/local-node/config", methods=["GET"])
    def get_local_node_config():
        auth_error = require_node_key()
        if auth_error:
            return auth_error

        organization_id = request.args.get("organization_id") or request.args.get("org_id")
        branch_id = request.args.get("branch_id")
        use_public_ip = str(request.args.get("use_public_ip", "false")).lower() in {"1", "true", "yes", "on"}

        if not organization_id or not branch_id:
            return jsonify({"success": False, "message": "organization_id and branch_id are required"}), 400

        backend_branch_id, _ = _branch_candidates(supabase, str(organization_id), str(branch_id))

        network_result = (
            supabase.table("branch_network_configs")
            .select("*")
            .eq("organization_id", str(organization_id))
            .eq("branch_id", str(backend_branch_id))
            .limit(1)
            .execute()
        )

        network_source = "branch_network_configs"
        if network_result.data:
            network = network_result.data[0]
        else:
            network, fallback_cameras, backend_branch_id = _fallback_config_from_onboarding(
                supabase,
                str(organization_id),
                str(branch_id),
            )
            network_source = "client_onboarding_configs_fallback"
            if not network:
                return jsonify({
                    "success": False,
                    "message": (
                        "No network configuration found for this branch. "
                        "Complete client onboarding camera/NVR setup again, or POST the branch config to "
                        
                    ),
                    "organization_id": str(organization_id),
                    "branch_id_requested": str(branch_id),
                    "backend_branch_id": str(backend_branch_id),
                }), 404

        cameras_result = (
            supabase.table("branch_cameras")
            .select("*")
            .eq("organization_id", str(organization_id))
            .eq("branch_id", str(backend_branch_id))
            .eq("enabled", True)
            .order("camera_name")
            .execute()
        )

        cameras: List[Dict[str, Any]] = cameras_result.data or []
        if not cameras and network_source == "client_onboarding_configs_fallback":
            cameras = fallback_cameras
        enriched_cameras = [
            {
                **camera,
                "rtsp_url": (
                    camera.get("rtsp_url")
                    if str(camera.get("camera_type") or "nvr").lower() == "webcam"
                    else _build_rtsp_url(network, camera, use_public_ip=use_public_ip)
                ),
            }
            for camera in cameras
        ]

        return jsonify({
            "success": True,
            "organization_id": str(organization_id),
            "branch_id": str(backend_branch_id),
            "branch_id_requested": str(branch_id),
            "config_source": network_source,
            "network": {
                "public_ip": network.get("public_ip"),
                "nvr_local_ip": network.get("nvr_local_ip"),
                "rtsp_port": network.get("rtsp_port"),
                "rtsp_username": network.get("rtsp_username"),
                "use_public_ip": use_public_ip,
            },
            "cameras": enriched_cameras,
        }), 200

    @app.route("/api/attendance/events/today", methods=["GET"])
    def get_today_attendance_events():
        organization_id = request.args.get("organization_id") or request.args.get("org_id")
        branch_id = request.args.get("branch_id")
        attendance_date = request.args.get("date") or datetime.now(timezone.utc).date().isoformat()

        if not organization_id:
            return jsonify({"success": False, "message": "organization_id is required"}), 400

        start_iso, end_iso = _date_bounds_iso(attendance_date)

        query = (
            supabase.table("attendance")
            .select("*")
            .eq("org_id", str(organization_id))
            .gte("timestamp", start_iso)
            .lte("timestamp", end_iso)
        )

        if branch_id:
            query = query.eq("branch_id", str(branch_id))

        result = query.order("timestamp", desc=True).execute()
        rows = result.data or []
        staff_ids = sorted({str(row.get("staff_id")) for row in rows if row.get("staff_id")})
        staff_by_id = _staff_name_map(supabase, str(organization_id), staff_ids)

        # Return one latest row per staff for dashboard status.
        latest_by_staff: dict[str, dict] = {}
        for row in rows:
            sid = str(row.get("staff_id") or "")
            if not sid or sid in latest_by_staff:
                continue
            latest_by_staff[sid] = _map_attendance_row(row, staff_by_id)

        return jsonify({
            "success": True,
            "date": attendance_date,
            "records": list(latest_by_staff.values()),
            "raw_count": len(rows),
        }), 200