"""
Configuration and constants for the attendance system.
"""

import os
import sys
from pathlib import Path

# Paths
if getattr(sys, 'frozen', False):
    # Running as compiled PyInstaller executable
    BASE_DIR = Path(sys.executable).parent
    BUNDLE_DIR = Path(getattr(sys, '_MEIPASS', str(Path(sys.executable).parent)))
    # Store persistent DB, uploads, logs in Windows AppData so deployment folder stays 100% clean
    app_folder = os.environ.get('QINTELLECT_APP_NAME', 'QIntellect')
    APPDATA_DIR = Path(os.environ.get('APPDATA', str(Path.home()))) / app_folder
else:
    # Running as normal python script
    BASE_DIR = Path(__file__).parent
    BUNDLE_DIR = BASE_DIR
    APPDATA_DIR = BASE_DIR

UPLOAD_FOLDER = APPDATA_DIR / 'uploads'
MODELS_DIR = BUNDLE_DIR / 'models'

# Support isolated DB filename if specified (defaults to attendance.db)
DB_FILENAME = os.environ.get('QINTELLECT_DB_NAME', 'attendance.db')
DB_PATH = APPDATA_DIR / DB_FILENAME
LOG_DIR = APPDATA_DIR / 'logs'
PROFILE_PHOTOS_DIR = APPDATA_DIR / 'profile_photos'

# Create directories
for folder in [UPLOAD_FOLDER, LOG_DIR, PROFILE_PHOTOS_DIR, APPDATA_DIR]:
    folder.mkdir(parents=True, exist_ok=True)

# Seed initial attendance.db from bundle if starting fresh in AppData
if getattr(sys, 'frozen', False) and not DB_PATH.exists():
    bundled_db = BUNDLE_DIR / DB_FILENAME
    if not bundled_db.exists():
        bundled_db = BUNDLE_DIR / 'attendance.db'
    if bundled_db.exists():
        import shutil
        shutil.copy2(bundled_db, DB_PATH)

# Face Detection & Embedding
YOLO_MODEL = 'yolov8n.pt'  # Kept for reference, though no longer used for face detection
INSIGHTFACE_MODEL = 'buffalo_l'
FACE_DETECTION_CONFIDENCE = 0.42
FACE_MATCHING_THRESHOLD = 0.40  # Final safe tuning for quick live multi-student recognition
FACE_QUALITY_THRESHOLD = 0.38  # Keep only truly bad faces out; allow valid moving faces through
MIN_EMBEDDINGS_PER_USER = 5  # Minimum embeddings for robust profile

# Enrollment Settings
MAX_ENROLLMENT_FRAMES = 120  # Max frames to extract from video
MIN_ENROLLMENT_FRAMES = 10   # Minimum faces to detect
OPTIMAL_FACES_PER_VIDEO = 40  # Target number of faces
MIN_VIDEO_DURATION = 5  # Seconds
MAX_VIDEO_DURATION = 300  # Seconds (5 minutes)

# RTSP/Camera Settings (subtype=1 is the low-latency sub-stream for smooth real-time streaming)
NVR_OFFICE_URL = (
    "rtsp://admin:admin1122@192.168.0.17:554/cam/realmonitor?channel=1&subtype=1"
)
DVR_OFFICE_URL = (
    "rtsp://admin:admin1122@192.168.0.17:554/cam/realmonitor?channel=1&subtype=1"
)
WEBCAM_URL = "0"
RTSP_CONNECTION_TIMEOUT = 10  # Seconds
RTSP_READ_TIMEOUT = 5  # Seconds
RTSP_MAX_FRAMES_PER_STREAM = 500  # Safety limit
RTSP_FRAME_SKIP = 1  # Process every frame; never intentionally drop live attendance frames

# Flask Settings
MAX_CONTENT_LENGTH = 500 * 1024 * 1024  # 500 MB
ALLOWED_EXTENSIONS = {'mp4', 'avi', 'mov', 'mkv', 'flv', 'wmv'}
IMAGE_EXTENSIONS = {'jpg', 'jpeg', 'png', 'bmp', 'webp'}

# Recognition Settings
ATTENDANCE_LOG_RETENTION_DAYS = 365  # Keep 1 year of logs
RECOGNITION_CONFIDENCE_THRESHOLD = 0.6  # Only log if above this
ANTI_SPOOFING_ENABLED = True  # Enable spoof detection
DUPLICATE_LOG_TIMEOUT = 30  # Seconds - don't log same person twice

# Tracking Settings
TRACK_MAX_AGE_SECONDS = 5.0          # How long (in seconds) to remember a recognized person after they disappear from frame
TRACK_ACTIVE_IOU_THRESHOLD = 0.15    # IoU threshold for matching face in consecutive frames
TRACK_LOST_IOU_THRESHOLD = 0.1       # IoU threshold for matching a face after it was temporarily lost
TRACK_ACTIVE_DIST_FACTOR = 0.5       # [CROWD FIX] Reduced from 0.8 -> 0.5: tighter radius so nearby people don't steal tracks
TRACK_LOST_DIST_FACTOR = 0.2         # Max distance factor based on face size for inheriting a lost track
TRACK_ACTIVE_MIN_DIST = 35           # [CROWD FIX] Reduced from 80 -> 35px: at 10-12ft faces are 35-50px wide, 80px caused ID swaps
TRACK_LOST_MIN_DIST = 25             # [CROWD FIX] Reduced from 40 -> 25px: prevents lost tracks from latching onto neighbours
TRACK_UNKNOWN_RETRY_INTERVAL = 0.1   # How fast (in seconds) to retry InsightFace extraction if a face is Unknown
TRACK_AI_INTERVAL = 0.05             # Process the latest frame at ~20 FPS on GPU; no intentional frame skipping
IDLE_AI_INTERVAL = 0.05              # Keep live attendance processing continuous even when no viewer is active

# Attendance Temporal Consensus (balanced speed + stability)
# CROWD NOTE: ATTENDANCE_CONFIRMATION_FRAMES=1 is critical for walk-through scenarios.
# When 10 people pass through the camera in 2-3 seconds, waiting for 2+ frames means
# most will never get confirmed. One strong match is sufficient with the 8x faster
# recognition pipeline now processing all 10 faces per frame at 10+ FPS.
ATTENDANCE_CONFIRMATION_FRAMES = 1   # [CROWD FIX] 1 frame confirmation: people in frame briefly must be caught on first match
ATTENDANCE_CONFIRMATION_WINDOW = 8.0 # Rolling window (seconds) to accumulate confirmation frames
ATTENDANCE_CONFIRMATION_MIN_SIM = 0.40 # Final safe pass: accept quick valid matches without over-rejecting moving faces

# Person & Room Locator Settings
PRESENCE_ACTIVE_TIMEOUT = 45         # Seconds within which person is considered "Currently Sitting Here"
PRESENCE_RECENT_TIMEOUT = 600        # Seconds (10 mins) within which person is considered "Recently In This Room"

# Camera-to-Room Mapping Registry
CAMERA_ROOM_MAPPINGS = {
    "webcam": {
        "room_name": "Front Desk / Reception",
        "camera_name": "Front Desk / Laptop Camera",
        "description": "Main entrance and visitor reception area"
    },
    "nvr_office": {
        "room_name": "Executive Office Room",
        "camera_name": "NVR Channel 3 (Office)",
        "description": "Executive workstations and conference desk"
    },
    "dvr_office": {
        "room_name": "Main Corridor & Hallway",
        "camera_name": "DVR Channel 2 (Corridor)",
        "description": "Central hallway connecting team offices"
    }
}


# Performance
BATCH_PROCESSING_ENABLED = True
BATCH_SIZE = 5  # Process N users at a time
ENABLE_GPU = True  # Auto-detect CUDA

# Logging
LOG_LEVEL = 'INFO'
LOG_FORMAT = '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
LOG_MAX_SIZE = 10 * 1024 * 1024  # 10 MB
LOG_BACKUP_COUNT = 5

# Security
ALLOW_LOCALHOST_ONLY = False  # Set True for local-only access
CORS_ENABLED = True
REQUEST_TIMEOUT = 60  # Seconds

# Database Queries
BATCH_QUERY_SIZE = 1000
AUTO_VACUUM_INTERVAL = 1000  # Optimize DB every N operations
