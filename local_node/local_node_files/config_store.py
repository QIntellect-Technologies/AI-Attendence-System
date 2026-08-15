from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

APP_NAME = "qintellect_attendance_node"

# Load local-node environment overrides from local_node/.env when running
# the node from source. This is useful for development setups that rely on
# .env values instead of setting them globally in the shell.
_dotenv_path = Path(__file__).resolve().parent / ".env"
if _dotenv_path.exists():
    load_dotenv(_dotenv_path)
DEFAULT_API_BASE_URL = os.getenv("QINTELLECT_API_BASE_URL", "http://127.0.0.1:5000").rstrip("/")


def app_data_dir() -> Path:
    configured = os.getenv("QINTELLECT_NODE_DATA_DIR", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()

    if os.name == "nt":
        base = os.getenv("PROGRAMDATA") or str(Path.home())
        return Path(base) / "QIntellect" / "AttendanceNode"

    return Path.home() / f".{APP_NAME}"


APP_DIR = app_data_dir()
CONFIG_PATH = APP_DIR / "node_config.json"
STATUS_PATH = APP_DIR / "node_runtime_status.json"
LOG_DIR = APP_DIR / "logs"
DB_PATH = APP_DIR / "local_node.db"
MODELS_DIR = APP_DIR / "models"


def ensure_app_dirs() -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)


def _restrict_file(path: Path) -> None:
    if os.name != "nt" and path.exists():
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _normalize_api_base(config: dict[str, Any]) -> str:
    return _clean_text(config.get("railway_api_base_url") or config.get("api_base_url") or DEFAULT_API_BASE_URL).rstrip("/")


def _normalize_runtime_config(config: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(config or {})
    api_base = _normalize_api_base(normalized)
    org_id = _clean_text(
        normalized.get("organization_id")
        or normalized.get("org_id")
        or normalized.get("organizationId")
    )
    branch_id = _clean_text(normalized.get("branch_id") or normalized.get("branchId"))
    branch_name = _clean_text(
        normalized.get("branch_name")
        or normalized.get("branchName")
        or normalized.get("node_branch_name")
    )
    attendance_mode = _clean_text(normalized.get("attendance_mode") or "local").lower()

    normalized["railway_api_base_url"] = api_base
    normalized["api_base_url"] = api_base
    if org_id:
        normalized["organization_id"] = org_id
        normalized["org_id"] = org_id
    if branch_id:
        normalized["branch_id"] = branch_id
    if branch_name:
        normalized["branch_name"] = branch_name
        normalized["branchName"] = branch_name
    if attendance_mode not in {"cloud", "local"}:
        attendance_mode = "local"
    normalized["attendance_mode"] = attendance_mode

    if "sync_delay_minutes" in normalized:
        try:
            normalized["sync_delay_minutes"] = max(0, int(normalized.get("sync_delay_minutes") or 0))
        except Exception:
            normalized["sync_delay_minutes"] = 0

    if "node_label" in normalized:
        normalized["node_label"] = _clean_text(normalized.get("node_label")) or None
    if "node_id" in normalized:
        normalized["node_id"] = _clean_text(normalized.get("node_id")) or None

    return normalized


def load_config() -> dict[str, Any]:
    ensure_app_dirs()
    if not CONFIG_PATH.exists():
        return _normalize_runtime_config({
            "railway_api_base_url": DEFAULT_API_BASE_URL,
            "api_base_url": DEFAULT_API_BASE_URL,
            "ui_port": int(os.getenv("QINTELLECT_NODE_UI_PORT", "8765")),
            "poll_interval_seconds": int(os.getenv("QINTELLECT_NODE_POLL_SECONDS", "30")),
        })

    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {}
    except Exception:
        return {}

    data = _normalize_runtime_config(data)
    data["ui_port"] = int(data.get("ui_port") or os.getenv("QINTELLECT_NODE_UI_PORT", "8765"))
    data["poll_interval_seconds"] = int(data.get("poll_interval_seconds") or 30)
    data["sync_delay_minutes"] = int(data.get("sync_delay_minutes") or 0)
    return data


def save_config(config: dict[str, Any]) -> None:
    ensure_app_dirs()
    existing = load_config()
    merged = _normalize_runtime_config({**existing, **dict(config or {})})
    CONFIG_PATH.write_text(json.dumps(merged, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    _restrict_file(CONFIG_PATH)


def get_runtime_identity(config: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = _normalize_runtime_config(config or load_config())
    return {
        "api_base_url": cfg.get("api_base_url"),
        "railway_api_base_url": cfg.get("railway_api_base_url"),
        "organization_id": cfg.get("organization_id") or cfg.get("org_id"),
        "org_id": cfg.get("org_id") or cfg.get("organization_id"),
        "branch_id": cfg.get("branch_id"),
        "branch_name": cfg.get("branch_name") or cfg.get("branchName"),
        "attendance_mode": cfg.get("attendance_mode") or "local",
        "node_id": cfg.get("node_id"),
        "node_label": cfg.get("node_label"),
        "hostname": cfg.get("hostname"),
    }


def get_branch_name(config: dict[str, Any] | None = None) -> str:
    return _clean_text(get_runtime_identity(config).get("branch_name"))


def get_branch_id(config: dict[str, Any] | None = None) -> str:
    return _clean_text(get_runtime_identity(config).get("branch_id"))


def get_org_id(config: dict[str, Any] | None = None) -> str:
    identity = get_runtime_identity(config)
    return _clean_text(identity.get("organization_id") or identity.get("org_id"))


def get_attendance_mode(config: dict[str, Any] | None = None) -> str:
    return _clean_text(get_runtime_identity(config).get("attendance_mode") or "local").lower()


def get_api_base_url(config: dict[str, Any] | None = None) -> str:
    return _clean_text(get_runtime_identity(config).get("api_base_url") or DEFAULT_API_BASE_URL).rstrip("/")


def is_activated() -> bool:
    cfg = load_config()
    return bool(_clean_text(cfg.get("node_api_key")) and _clean_text(cfg.get("node_id")) and _clean_text(cfg.get("branch_id")))


def write_runtime_status(status: dict[str, Any]) -> None:
    ensure_app_dirs()
    STATUS_PATH.write_text(json.dumps(status, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def read_runtime_status() -> dict[str, Any]:
    ensure_app_dirs()
    if not STATUS_PATH.exists():
        return {}
    try:
        value = json.loads(STATUS_PATH.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}
