"""
Configuration and constants for the attendance system.
"""

import os
from pathlib import Path

# Paths
BASE_DIR = Path(__file__).parent
UPLOAD_FOLDER = BASE_DIR / 'uploads'
MODELS_DIR = BASE_DIR / 'models'
DB_PATH = BASE_DIR / 'attendance.db'
LOG_DIR = BASE_DIR / 'logs'

# Create directories
for folder in [UPLOAD_FOLDER, MODELS_DIR, LOG_DIR]:
    folder.mkdir(exist_ok=True)

# Face Detection & Embedding
YOLO_MODEL = 'yolov8n.pt'  # Kept for reference, though no longer used for face detection
INSIGHTFACE_MODEL = 'buffalo_l'
FACE_DETECTION_CONFIDENCE = 0.5
FACE_MATCHING_THRESHOLD = 0.45  # Standard ArcFace cosine similarity threshold for robust matching
FACE_QUALITY_THRESHOLD = 0.7  # Face quality score (0-1)
MIN_EMBEDDINGS_PER_USER = 5  # Minimum embeddings for robust profile

# Enrollment Settings
MAX_ENROLLMENT_FRAMES = 120  # Max frames to extract from video
MIN_ENROLLMENT_FRAMES = 10   # Minimum faces to detect
OPTIMAL_FACES_PER_VIDEO = 40  # Target number of faces
MIN_VIDEO_DURATION = 5  # Seconds
MAX_VIDEO_DURATION = 300  # Seconds (5 minutes)

# RTSP/Camera Settings
# NVR_OFFICE_URL = "rtsp://admin:admin1122@192.168.0.77:554/cam/realmonitor?channel=3&subtype=1"
# DVR_OFFICE_URL = "rtsp://admin:admin1122@192.168.0.77:554/cam/realmonitor?channel=2&subtype=1"
NVR_OFFICE_URL = (
    "rtsp://admin:admin1122@192.168.0.77:554/cam/realmonitor?channel=3&subtype=1"
)
# Channel 2 - Corridor
DVR_OFFICE_URL = (
    "rtsp://admin:admin1122@192.168.0.77:554/cam/realmonitor?channel=2&subtype=1"
)
WEBCAM_URL = "0"
RTSP_CONNECTION_TIMEOUT = 10  # Seconds
RTSP_READ_TIMEOUT = 5  # Seconds
RTSP_MAX_FRAMES_PER_STREAM = 500  # Safety limit
RTSP_FRAME_SKIP = 5  # Process every Nth frame (for performance)

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
TRACK_ACTIVE_DIST_FACTOR = 0.8       # Max distance factor based on face size for matching in consecutive frames
TRACK_LOST_DIST_FACTOR = 0.2         # Max distance factor based on face size for inheriting a lost track
TRACK_ACTIVE_MIN_DIST = 80           # Minimum distance threshold (pixels) for matching in consecutive frames
TRACK_LOST_MIN_DIST = 40             # Minimum distance threshold (pixels) for inheriting a lost track
TRACK_UNKNOWN_RETRY_INTERVAL = 0.1   # How fast (in seconds) to retry InsightFace extraction if a face is Unknown
TRACK_AI_INTERVAL = 0.05             # How fast (in seconds) the background AI thread loops (0.05s = 20 FPS)


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
