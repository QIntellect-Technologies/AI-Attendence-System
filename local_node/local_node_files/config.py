"""
local_node/config.py
───────────────────────────────────────────────────────────────────────────────
Hybrid config used when running files from inside local_node/.

Why this file exists:
- When you run `cd local_node && python main.py`, Python sees local_node/config.py
  before the backend config.py.
- Root modules like logger_config.py and face_processor.py import `config`.
- Therefore this file must provide both:
  1) local node bootstrap settings, and
  2) backend-style constants needed by shared AI/logging modules.

Camera/NVR credentials are NOT stored here. The node fetches them from Flask via
/api/local-node/config.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict

# local_node folder
BASE_DIR = Path(__file__).resolve().parent

# project root folder: C:/Flask-Attedence/Flask-Attedence
PROJECT_ROOT = BASE_DIR.parent

# ── Backend/shared constants needed by logger_config.py and face_processor.py ──
UPLOAD_FOLDER = PROJECT_ROOT / "uploads"
MODELS_DIR = PROJECT_ROOT / "models"
DB_PATH = PROJECT_ROOT / "attendance.db"
LOG_DIR = PROJECT_ROOT / "logs"
ORG_DATABASES_DIR = PROJECT_ROOT / "org_databases"
LOCAL_DB_PATH = BASE_DIR / "local_node.db"

for folder in [UPLOAD_FOLDER, MODELS_DIR, LOG_DIR, ORG_DATABASES_DIR, BASE_DIR]:
    folder.mkdir(exist_ok=True)

# Face Detection & Embedding
YOLO_MODEL = "yolov8n.pt"
INSIGHTFACE_MODEL = "buffalo_l"
FACE_DETECTION_CONFIDENCE = 0.5
FACE_MATCHING_THRESHOLD = 0.45
FACE_QUALITY_THRESHOLD = 0.7
MIN_EMBEDDINGS_PER_USER = 5

# Enrollment Settings
MAX_ENROLLMENT_FRAMES = 120
MIN_ENROLLMENT_FRAMES = 10
OPTIMAL_FACES_PER_VIDEO = 40
MIN_VIDEO_DURATION = 5
MAX_VIDEO_DURATION = 300

# RTSP/Camera Settings
RTSP_CONNECTION_TIMEOUT = 10
RTSP_READ_TIMEOUT = 5
RTSP_MAX_FRAMES_PER_STREAM = 500
RTSP_FRAME_SKIP = 5

# Flask/file settings used by shared code
MAX_CONTENT_LENGTH = 500 * 1024 * 1024
ALLOWED_EXTENSIONS = {"mp4", "avi", "mov", "mkv", "flv", "wmv"}
IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "bmp", "webp"}

# Recognition Settings
ATTENDANCE_LOG_RETENTION_DAYS = 365
RECOGNITION_CONFIDENCE_THRESHOLD = 0.6
ANTI_SPOOFING_ENABLED = True
DUPLICATE_LOG_TIMEOUT = 30

# Tracking Settings
TRACK_MAX_AGE_SECONDS = 5.0
TRACK_ACTIVE_IOU_THRESHOLD = 0.15
TRACK_LOST_IOU_THRESHOLD = 0.1
TRACK_ACTIVE_DIST_FACTOR = 0.8
TRACK_LOST_DIST_FACTOR = 0.2
TRACK_ACTIVE_MIN_DIST = 80
TRACK_LOST_MIN_DIST = 40
TRACK_UNKNOWN_RETRY_INTERVAL = 0.1
TRACK_AI_INTERVAL = 0.05

# Performance
BATCH_PROCESSING_ENABLED = True
BATCH_SIZE = 5
ENABLE_GPU = True

# Logging
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
LOG_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
LOG_MAX_SIZE = 10 * 1024 * 1024
LOG_BACKUP_COUNT = 5

# Security
ALLOW_LOCALHOST_ONLY = False
CORS_ENABLED = True
REQUEST_TIMEOUT = 60

# Database Queries
BATCH_QUERY_SIZE = 1000
AUTO_VACUUM_INTERVAL = 1000

# ── Local node bootstrap config ───────────────────────────────────────────────
CONFIG_PATH = Path(os.getenv("LOCAL_NODE_CONFIG", BASE_DIR / "node_config.json"))

DEFAULT_CONFIG: Dict[str, Any] = {
    "api_base_url": "http://127.0.0.1:5000",
    # Keep as strings because Supabase org/branch IDs are UUIDs in your flow.
    "organization_id": "1",
    "branch_id": "1",
    "node_api_key": "NODE_API_KEY",
    "use_public_ip": False,
    "match_threshold": 0.45,
    "camera_check_timeout_seconds": 10,
}


def _env_bool(name: str, fallback: bool) -> bool:
    return os.getenv(name, str(fallback)).strip().lower() in {"1", "true", "yes", "on"}


def load_node_config() -> Dict[str, Any]:
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH, "r", encoding="utf-8") as file:
            file_data = json.load(file)
    else:
        file_data = {}

    config = {**DEFAULT_CONFIG, **file_data}

    config["api_base_url"] = os.getenv("API_BASE_URL", str(config["api_base_url"])).rstrip("/")
    config["organization_id"] = os.getenv("ORGANIZATION_ID", str(config["organization_id"])).strip()
    config["branch_id"] = os.getenv("BRANCH_ID", str(config["branch_id"])).strip()
    config["node_api_key"] = os.getenv("NODE_API_KEY", str(config["node_api_key"])).strip()
    config["use_public_ip"] = _env_bool("USE_PUBLIC_IP", bool(config.get("use_public_ip")))
    config["match_threshold"] = float(os.getenv("MATCH_THRESHOLD", str(config["match_threshold"])))
    config["camera_check_timeout_seconds"] = int(
        os.getenv("CAMERA_CHECK_TIMEOUT_SECONDS", str(config["camera_check_timeout_seconds"]))
    )

    return config
