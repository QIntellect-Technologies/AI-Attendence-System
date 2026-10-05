"""Filesystem path configuration. Single source of truth for on-disk locations."""
from pathlib import Path

__all__ = [
    "BASE_DIR", "UPLOAD_FOLDER", "MODELS_DIR", "LOG_DIR",
    "ORG_DATABASES_DIR", "DB_PATH", "LOCAL_DB_PATH",
]

# shared/config/paths.py -> shared/config -> shared -> <repo_root>
BASE_DIR = Path(__file__).resolve().parents[2]

UPLOAD_FOLDER = BASE_DIR / "uploads"
MODELS_DIR = BASE_DIR / "models"
LOG_DIR = BASE_DIR / "logs"
ORG_DATABASES_DIR = BASE_DIR / "org_databases"

DB_PATH = BASE_DIR / "attendance.db"
LOCAL_DB_PATH = BASE_DIR / "local_node.db"

for _path in (UPLOAD_FOLDER, MODELS_DIR, LOG_DIR, ORG_DATABASES_DIR):
    _path.mkdir(parents=True, exist_ok=True)
