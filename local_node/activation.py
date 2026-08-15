from __future__ import annotations

import socket
from datetime import datetime, timezone
from typing import Any

from local_node import local_db
from local_node.api_client import activate_node, heartbeat
from local_node.config_store import load_config, save_config


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def activate_with_token(api_base_url: str, install_token: str, node_label: str | None = None) -> dict[str, Any]:
    hostname = socket.gethostname()

    # Captured BEFORE save_config() overwrites it below — this is the only
    # place that still knows which branch (if any) this machine's local
    # data currently belongs to. Empty string covers a genuinely fresh
    # install (no prior config at all).
    previous_branch_id = str((load_config() or {}).get("branch_id") or "").strip()

    response = activate_node(api_base_url, install_token, hostname, node_label)

    node_api_key = str(response.get("node_api_key") or "").strip()
    node_id = str(response.get("node_id") or "").strip()
    org_id = str(response.get("org_id") or response.get("organization_id") or "").strip()
    branch_id = str(response.get("branch_id") or "").strip()
    branch_name = str(response.get("branch_name") or "").strip()
    attendance_mode = str(response.get("attendance_mode") or "local").strip().lower()
    railway_api_base_url = str(response.get("railway_api_base_url") or response.get("api_base_url") or api_base_url).rstrip("/")

    if not node_api_key or not node_id or not org_id or not branch_id:
        raise RuntimeError("Activation response is missing node_api_key, node_id, org_id, or branch_id.")

    if branch_id != previous_branch_id:
        # Either a brand-new install (previous_branch_id == "") or this
        # machine is being (re)activated for a DIFFERENT branch than
        # whatever it last belonged to — e.g. redeployed/reimaged hardware,
        # or the same downloaded exe reused at a different client site.
        # Either way, no attendance/embeddings data from the previous
        # state should survive onto the new one. See local_db.reset_local_data.
        #
        # Deliberately does NOT fire when branch_id == previous_branch_id
        # (e.g. re-activating with a rotated install token for the SAME
        # branch) — that must preserve today's not-yet-synced pending/held
        # attendance rather than silently discarding real unsynced data.
        local_db.reset_local_data()

    config = {
        "railway_api_base_url": railway_api_base_url,
        "api_base_url": railway_api_base_url,
        "node_api_key": node_api_key,
        "node_id": node_id,
        "org_id": org_id,
        "branch_id": branch_id,
        "branch_name": branch_name,
        "attendance_mode": attendance_mode if attendance_mode in {"cloud", "local"} else "local",
        "hostname": hostname,
        "node_label": node_label or hostname,
        "activated_at": utc_now(),
        "poll_interval_seconds": int(response.get("sync_poll_interval") or response.get("poll_interval_seconds") or 30),
        "sync_delay_minutes": int(response.get("sync_delay_minutes") or 0),
    }
    save_config(config)

    try:
        heartbeat({"node_id": node_id, "hostname": hostname, "status": "online", "activated_at": config["activated_at"]})
    except Exception:
        pass

    return {key: value for key, value in config.items() if key != "node_api_key"}