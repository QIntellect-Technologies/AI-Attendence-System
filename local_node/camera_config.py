from __future__ import annotations

from typing import Any


def normalize_camera(camera: dict[str, Any], index: int) -> dict[str, Any]:
    row = dict(camera or {})
    camera_id = row.get("id") or row.get("camera_id") or f"camera-{index}"
    name = row.get("camera_name") or row.get("name") or row.get("label") or f"Camera {index}"
    rtsp = row.get("rtsp_url") or row.get("rtspUrl") or ""
    # Public-IP/domain variant of the same stream, if the cloud config
    # supplies one — same credentials/channel, different reachable host.
    # This is what enables automatic failover in camera_stream_manager
    # instead of the old use_public_ip manual toggle.
    rtsp_public = row.get("public_rtsp_url") or row.get("rtspUrlPublic") or row.get("rtsp_url_public") or ""
    camera_type = str(row.get("camera_type") or row.get("cameraType") or "nvr").lower()
    device_index = int(row.get("channel") or row.get("device_index") or 0)
    return {
        **row,
        "id": str(camera_id),
        "camera_id": str(camera_id),
        "camera_name": str(name),
        "name": str(name),
        "camera_type": camera_type,
        "device_index": device_index,
        "rtsp_url": str(rtsp),
        "rtspUrl": str(rtsp),
        "rtsp_url_fallback": str(rtsp_public),
        "enabled": bool(row.get("enabled", True)),
    }


def get_enabled_cameras(config: dict[str, Any]) -> list[dict[str, Any]]:
    cameras = config.get("cameras") or []
    if not isinstance(cameras, list):
        return []
    result: list[dict[str, Any]] = []
    for idx, camera in enumerate(cameras, 1):
        if not isinstance(camera, dict) or not camera.get("enabled", True):
            continue
        camera_type = str(camera.get("camera_type") or camera.get("cameraType") or "nvr").lower()
        has_source = camera_type == "webcam" or bool(
            camera.get("rtsp_url") or camera.get("rtspUrl")
            or camera.get("public_rtsp_url") or camera.get("rtspUrlPublic") or camera.get("rtsp_url_public")
        )
        if has_source:
            result.append(normalize_camera(camera, idx))
    return result