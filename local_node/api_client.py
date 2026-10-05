from __future__ import annotations

from typing import Any

import requests

from local_node.config_store import load_config


class NodeApiError(RuntimeError):
    pass


def _base_url(config: dict[str, Any] | None = None) -> str:
    cfg = config or load_config()
    base = str(cfg.get("railway_api_base_url") or cfg.get("api_base_url") or "").rstrip("/")
    if not base:
        raise NodeApiError("Railway API base URL is missing. Activate the node first.")
    return base


def _node_key(config: dict[str, Any] | None = None) -> str:
    cfg = config or load_config()
    key = str(cfg.get("node_api_key") or "").strip()
    if not key:
        raise NodeApiError("Node API key is missing. Activate the node first.")
    return key


def _headers(config: dict[str, Any] | None = None) -> dict[str, str]:
    return {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Node-Api-Key": _node_key(config),
    }


def _request_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    json_body: dict[str, Any] | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    try:
        response = requests.request(method, url, headers=headers, params=params, json=json_body, timeout=timeout)
    except requests.RequestException as exc:
        raise NodeApiError(f"Could not connect to backend: {exc}") from exc

    try:
        body = response.json()
    except ValueError as exc:
        raise NodeApiError(f"Backend returned non-JSON response. HTTP {response.status_code}: {response.text[:300]}") from exc

    if response.status_code >= 400 or body.get("success") is False:
        message = body.get("message") or body.get("error") or response.text[:300]
        raise NodeApiError(f"Backend rejected request. HTTP {response.status_code}: {message}")

    return body


def activate_node(api_base_url: str, install_token: str, hostname: str, node_label: str | None = None) -> dict[str, Any]:
    base = str(api_base_url or "").strip().rstrip("/")
    token = str(install_token or "").strip()
    if not base:
        raise NodeApiError("Railway API URL is required.")
    if not token:
        raise NodeApiError("Install token is required.")

    return _request_json(
        "POST",
        f"{base}/v1/activate",
        headers={"Accept": "application/json", "Content-Type": "application/json"},
        json_body={"install_token": token, "hostname": hostname, "node_label": node_label or hostname},
        timeout=30,
    )


def heartbeat(payload: dict[str, Any]) -> dict[str, Any]:
    cfg = load_config()
    return _request_json(
        "POST",
        f"{_base_url(cfg)}/v1/node/heartbeat",
        headers=_headers(cfg),
        json_body=payload,
        timeout=20,
    )


def fetch_node_config() -> dict[str, Any]:
    cfg = load_config()
    body = _request_json("GET", f"{_base_url(cfg)}/v1/node/config", headers=_headers(cfg), timeout=30)
    value = body.get("config") if isinstance(body.get("config"), dict) else body
    return value if isinstance(value, dict) else {}


def sync_attendance(records: list[dict[str, Any]]) -> dict[str, Any]:
    cfg = load_config()
    return _request_json(
        "POST",
        f"{_base_url(cfg)}/v1/node/push-attendance",
        headers=_headers(cfg),
        json_body={"logs": records},
        timeout=60,
    )
def poll_manual_instructions() -> dict[str, Any]:
    cfg = load_config()
    return _request_json(
        "GET",
        f"{_base_url(cfg)}/v1/node/poll-manual-instructions",
        headers=_headers(cfg),
        timeout=30,
    )


def ack_manual_instruction(instruction_id: str, status: str, note: str | None = None) -> dict[str, Any]:
    cfg = load_config()
    body: dict[str, Any] = {"instruction_id": instruction_id, "status": status}
    if note is not None:
        body["note"] = note
    return _request_json(
        "POST",
        f"{_base_url(cfg)}/v1/node/ack-manual-instruction",
        headers=_headers(cfg),
        json_body=body,
        timeout=30,
    )

def push_embeddings(records: list[dict[str, Any]]) -> dict[str, Any]:
    cfg = load_config()
    return _request_json(
        "POST",
        f"{_base_url(cfg)}/v1/node/push-embeddings",
        headers=_headers(cfg),
        json_body={"records": records},
        timeout=60,
    )


