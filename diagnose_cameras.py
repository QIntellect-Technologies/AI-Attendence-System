"""
Run this from inside local_node/ (same venv as main.py):
    python diagnose_cameras.py

Dumps the raw camera list the node is receiving from the backend
(/v1/node/config), plus which of those get_enabled_cameras() actually
accepts as startable. This tells us, without guessing, whether the
webcam is even present in the config and whether camera_type is set
correctly.
"""
from __future__ import annotations

import json

from local_node.api_client import fetch_node_config, NodeApiError
from local_node.camera_config import get_enabled_cameras, normalize_camera
from local_node.config_store import is_activated, load_config


def main() -> None:
    if not is_activated():
        print("Node is NOT activated. Activate it first — there is no camera "
              "config to fetch until then.")
        return

    cfg = load_config()
    print(f"branch_id: {cfg.get('branch_id')}")
    print(f"attendance_mode: {cfg.get('attendance_mode')}\n")

    try:
        runtime = fetch_node_config()
    except NodeApiError as exc:
        print(f"Failed to fetch node config from backend: {exc}")
        return

    raw_cameras = runtime.get("cameras") or []
    print(f"Backend returned {len(raw_cameras)} camera(s) total:\n")

    for idx, cam in enumerate(raw_cameras, 1):
        norm = normalize_camera(cam, idx)
        print(f"--- Camera #{idx} (raw) ---")
        print(json.dumps(cam, indent=2, default=str))
        print(f"  -> normalized camera_type: {norm['camera_type']!r}")
        print(f"  -> normalized device_index: {norm['device_index']!r}")
        print(f"  -> normalized enabled: {norm['enabled']!r}")
        print(f"  -> normalized rtsp_url: {norm['rtsp_url']!r}\n")

    enabled = get_enabled_cameras(runtime)
    print(f"get_enabled_cameras() accepted {len(enabled)} of {len(raw_cameras)} camera(s):\n")
    for cam in enabled:
        print(f"  id={cam['id']!r} name={cam['camera_name']!r} "
              f"type={cam['camera_type']!r} device_index={cam['device_index']!r}")


if __name__ == "__main__":
    main()