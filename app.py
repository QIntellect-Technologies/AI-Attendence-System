"""
Flask AI Attendance System
- Enrollment: Upload video, extract embeddings, store profile
- Recognition: Camera/RTSP feed, detect faces, match against profiles, log attendance
"""

from core.bootstrap import enforce_utf8_stdio, register_cuda_dll_dirs
enforce_utf8_stdio()
register_cuda_dll_dirs()
from dotenv import load_dotenv

load_dotenv()
from flask import Flask, request, jsonify, render_template, send_from_directory, Response, send_file, g
from flask_cors import CORS
from werkzeug.utils import secure_filename
import re
import os
import json
import numpy as np
import payroll_engine
from datetime import date, datetime, timezone
from pathlib import Path
import mimetypes
import database as db
from download_models import verify_models
from logger_config import get_logger
from shared_face_engine import (
    get_face_model,
    detect_and_extract,
    process_video,
    compute_aggregate_embedding,
    compare_embeddings,
    assess_face_quality,
)
from shared_face_engine.spoof import detect_spoofing

from config import (
    UPLOAD_FOLDER,
    MAX_CONTENT_LENGTH, FACE_MATCHING_THRESHOLD, FACE_DETECTION_CONFIDENCE,
    MIN_ENROLLMENT_FRAMES, OPTIMAL_FACES_PER_VIDEO,
    MIN_VIDEO_DURATION, MAX_VIDEO_DURATION,
    TRACK_MAX_AGE_SECONDS, TRACK_ACTIVE_IOU_THRESHOLD, TRACK_LOST_IOU_THRESHOLD,
    TRACK_ACTIVE_DIST_FACTOR, TRACK_LOST_DIST_FACTOR,
    TRACK_ACTIVE_MIN_DIST, TRACK_LOST_MIN_DIST,
    TRACK_UNKNOWN_RETRY_INTERVAL, TRACK_AI_INTERVAL,
    MODELS_DIR, ENABLE_GPU, ANTI_SPOOFING_ENABLED,
)
from local_node_camera_routes import register_local_node_camera_routes
import login_throttle
import tempfile
from shared_face_engine.package_format import parse_embedding_package, PackageImportError

logger = get_logger(__name__)

from werkzeug.middleware.proxy_fix import ProxyFix

# Initialize Flask app
app = Flask(__name__)

# Railway terminates TLS at its edge and forwards to gunicorn over plain
# HTTP, so request.host_url reports "http://" without this — and that value
# is what /v1/activate hands back to the node as railway_api_base_url.
# The node then stores an http:// URL, Railway 301-redirects it, and
# requests downgrades POST to GET on the redirect: heartbeat and
# push-attendance silently die while GET config polls keep working.
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)

# ─── CORS ──────────────────────────────────────────────────────
# Was a bare CORS(app), i.e. Access-Control-Allow-Origin: * on every route.
# With the dashboard JWT travelling in an Authorization header (not a
# cookie), a wildcard doesn't hand out sessions by itself -- but it does let
# any page on the internet script a victim's browser into calling this API
# and read the response, which is exactly the amplifier you don't want
# sitting under the routes fixed above.
#
# Allowlist comes from CORS_ALLOWED_ORIGINS (comma-separated). The default
# below is localhost-only so a misconfigured deploy fails closed and loudly
# in the browser console, rather than silently staying wide open. Set the
# env var to the real dashboard origin(s) in Railway.
_DEFAULT_CORS_ORIGINS = 'http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173'
CORS_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get('CORS_ALLOWED_ORIGINS', _DEFAULT_CORS_ORIGINS).split(',')
    if origin.strip()
]
if '*' in CORS_ALLOWED_ORIGINS:
    # Explicit opt-in only, and never silently: if someone genuinely needs
    # the old behaviour they have to type it, and it shows up in the logs.
    logger.warning('CORS_ALLOWED_ORIGINS contains "*" — every origin on the internet can call this API.')

CORS(
    app,
    resources={r'/api/*': {'origins': CORS_ALLOWED_ORIGINS},
               r'/v1/*': {'origins': CORS_ALLOWED_ORIGINS}},
    supports_credentials=True,
    allow_headers=['Content-Type', 'Authorization', 'Accept', 'X-Node-Api-Key'],
    methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    max_age=600,
)
logger.info('CORS allowlist: %s', CORS_ALLOWED_ORIGINS)

# login_throttle keeps its counters in process memory, which is only
# correct while gunicorn runs a single worker (as the Dockerfile does).
# Shout if that ever changes — see login_throttle.py's module docstring.
_web_concurrency = os.environ.get('WEB_CONCURRENCY') or os.environ.get('GUNICORN_WORKERS')
try:
    if _web_concurrency and int(_web_concurrency) > 1:
        logger.warning(
            'Running %s workers: login_throttle counters are per-process, so the effective '
            'brute-force budget is %sx the configured limit. Move it to a shared store.',
            _web_concurrency, _web_concurrency,
        )
except ValueError:
    pass
from internal_routes import internal_bp
app.register_blueprint(internal_bp)
# ─── Support Dashboard API ─────────────────────────────────────
# Internal-only QIntellect routes under /v1/support/*
from support_routes import support_bp
from tenant_routes import tenant_bp
import support_db as support_cp_db
from supabase_client import get_supabase
from support_db_fast import (
    FastScope,
    get_fast_summary,
    get_fast_dashboard_overview,
    get_fast_page,
    clear_fast_cache,
)
import support_db_attendance_settings as attendance_settings_db
import support_db_notifications as notifications_db
import support_db_attendance_exceptions as attendance_exceptions_db
from installer_packager import (
    build_node_installer_exe,
    build_node_installer_zip,
    node_exe_installer_filename,
    node_installer_filename,
)
supabase = get_supabase()

app.register_blueprint(support_bp)
app.register_blueprint(tenant_bp)
register_local_node_camera_routes(app, supabase)

# ─── Client Dashboard: branch-managed shifts + dynamic attendance timing ──
from client_shift_routes import client_shifts_bp
from client_attendance_settings_routes import client_attendance_settings_bp
from client_staff_auth_routes import client_staff_auth_bp
from client_staff_attendance_routes import client_staff_attendance_bp
from client_field_attendance_routes import client_field_attendance_bp
from client_staff_hierarchy_routes import client_staff_hierarchy_bp
from client_staff_notifications_routes import client_staff_notifications_bp
from client_staff_leave_routes import client_staff_leave_bp
from client_staff_overtime_routes import client_staff_overtime_bp 
from client_staff_hr_assistant_routes import client_staff_hr_assistant_bp
from client_field_visits_routes import client_field_visits_bp
from client_visit_plans_routes import client_visit_plans_bp
from client_payroll_decision_routes import client_payroll_decisions_bp
from client_dashboard_auth import (
    mint_dashboard_token,
    require_client_dashboard_auth,
    require_client_dashboard_admin,
    logout_dashboard_user,
    get_team_scope_ids,
    get_effective_scope_ids,
    filter_rows_by_scope,
)
from support_db_hierarchy import set_dashboard_scope as hierarchy_set_dashboard_scope
from stream_token import mint_stream_token, verify_stream_token


def _dashboard_target_org_matches(dashboard_user: dict, target_organization_id) -> bool:
    """True if target_organization_id belongs to the caller's own org.

    Admin-only account-lifecycle actions (delete/restore/purge/reset
    another user's password) are additionally scoped to the caller's org
    even after @require_client_dashboard_admin passes — an admin token
    minted for org A must never be usable against org B's accounts. Always
    compare against g.dashboard_user['org_id'] (from the verified token),
    never against an org_id read from the request body/query string.
    """
    if target_organization_id is None:
        return False
    return str(dashboard_user.get('org_id') or '') == str(target_organization_id)


def _dashboard_user_owns_notification_inbox(dashboard_user: dict, raw_user_id) -> bool:
    """Notifications are a personal inbox — the caller may only read, mark
    read, or delete their OWN notifications, identified by the verified
    token's id, never an id supplied in the query string/request body."""
    return str(dashboard_user.get('id')) == str(raw_user_id or '')


app.register_blueprint(client_shifts_bp)
app.register_blueprint(client_attendance_settings_bp)
app.register_blueprint(client_staff_auth_bp)
app.register_blueprint(client_staff_attendance_bp)
app.register_blueprint(client_field_attendance_bp)
app.register_blueprint(client_staff_hierarchy_bp)
app.register_blueprint(client_staff_notifications_bp)
app.register_blueprint(client_staff_leave_bp)
app.register_blueprint(client_staff_overtime_bp)
app.register_blueprint(client_staff_hr_assistant_bp)
app.register_blueprint(client_field_visits_bp)   # mobile: self-service plan/stop/log-visit
app.register_blueprint(client_visit_plans_bp)    # dashboard: admin plan/stop CRUD + roster
app.register_blueprint(client_payroll_decisions_bp)  # dashboard: Phase 3 local-node payroll include/exclude

# If a production React build exists, serve it as static files and use it for templates
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIST = os.path.join(BASE_DIR, "frontend", "dist")
if os.path.isdir(FRONTEND_DIST):
    app.static_folder = FRONTEND_DIST
    app.template_folder = FRONTEND_DIST
    app.static_url_path = ""

import threading

# Global in-memory cache for enrolled face embeddings to avoid SQLite query bottlenecks inside live streams
EMBEDDING_CACHE = {}  # {user_id: {"name": name, "aggregate_embedding": np.array}}
LATEST_STREAM_DETECTIONS = []  # Thread-safe real-time detections queue for the sidebar ticker
DETECTED_USERS_SESSION = set()  # Permanent session dedup — each user shown only once
SUPABASE_EMBEDDING_CACHE = {}  # key: f"{org_id}:{branch_id or '-'}"
_SUPABASE_EMBEDDING_CACHE_TTL_SECONDS = 60
cache_lock = threading.Lock()

def _detect_faces(frame):
    """Single detection+embedding pass via the shared engine. Centralizes
    models_root/min_confidence so every recognition endpoint and
    CameraStreamReader use identical detection parameters."""
    return detect_and_extract(frame, MODELS_DIR, min_confidence=FACE_DETECTION_CONFIDENCE)

def refresh_embedding_cache():
    """Refresh the in-memory aggregate embeddings for all enrolled users."""
    global EMBEDDING_CACHE
    try:
        logger.info("[*] Refreshing in-memory facial embedding cache from database...")
        new_cache = {}
        all_users = db.get_all_users()
        for user in all_users:
            user_embeddings = db.get_embeddings_for_user(user['id'])
            if len(user_embeddings) == 0:
                continue
            user_embs = [np.array(emb['embedding']) for emb in user_embeddings]
            aggregate_emb = compute_aggregate_embedding(user_embs)
            new_cache[user['id']] = {
                'name': user['name'],
                'department': user.get('department', ''),
                'organization_id': user.get('organization_id'),
                'branch_id': user.get('branch_id'),
                'branch_name': user.get('branch_name', ''),
                'aggregate_embedding': aggregate_emb,
            }
        with cache_lock:
            EMBEDDING_CACHE = new_cache
        logger.info(f"✓ Cached aggregate profiles for {len(new_cache)} users in memory.")
    except Exception as e:
        logger.error(f"✗ Failed to refresh embedding cache: {e}")

def refresh_supabase_embedding_cache(organization_id, branch_id, force=False):
    """Load/refresh one Supabase tenant's recognition embeddings on demand.

    Unlike refresh_embedding_cache() (legacy, global, eager), this only
    loads a tenant into memory when its camera is actually streaming, and
    TTL-refreshes rather than eagerly loading every organization up front.
    """
    import time
    org_key = str(organization_id or '').strip()
    if not org_key:
        return

    cache_key = f"{org_key}:{branch_id or '-'}"
    with cache_lock:
        entry = SUPABASE_EMBEDDING_CACHE.get(cache_key)
        fresh = entry and (time.monotonic() - entry['loaded_at']) < _SUPABASE_EMBEDDING_CACHE_TTL_SECONDS
    if fresh and not force:
        return

    try:
        status = support_cp_db.get_camera_recognition_status(org_key, branch_id)
        people = support_cp_db.get_org_recognition_embeddings(org_key, branch_id)
        built = {}
        for person in people:
            vectors = [np.array(v) for v in person['embeddings']]
            aggregate = compute_aggregate_embedding(vectors)
            if aggregate is None:
                continue
            built[person['staff_id']] = {
                'name': person['name'],
                'people_type': person['people_type'],
                'organization_id': org_key,
                'branch_id': person.get('branch_id') or (str(branch_id) if branch_id else None),
                'aggregate_embedding': aggregate,
            }
        with cache_lock:
            SUPABASE_EMBEDDING_CACHE[cache_key] = {
                'loaded_at': time.monotonic(),
                'people': built,
                'always_on': status['always_on'],
            }
        logger.info(f"✓ Cached {len(built)} Supabase recognition profiles for org={org_key} branch={branch_id or 'any'} (always_on={status['always_on']})")
    except Exception as e:
        logger.error(f"✗ Failed to refresh Supabase embedding cache for org={org_key}: {e}")

def _is_cloud_recognition_always_on(organization_id, branch_id) -> bool:
    cache_key = f"{organization_id}:{branch_id or '-'}"
    with cache_lock:
        entry = SUPABASE_EMBEDDING_CACHE.get(cache_key)
    return bool(entry and entry.get('always_on'))

# Configuration
UPLOAD_FOLDER.mkdir(exist_ok=True)

app.config['UPLOAD_FOLDER'] = str(UPLOAD_FOLDER)
app.config['MAX_CONTENT_LENGTH'] = MAX_CONTENT_LENGTH


def _parse_tenant_id(value):
    """Return a safe tenant id for routes that accept either legacy numeric ids or Supabase UUID/text ids.

    - Empty/null/all values become None.
    - Positive integer-looking values stay int for legacy SQLite routes.
    - UUID/text values stay string for Supabase tenant filtering.
    """
    if value is None:
        return None

    text = str(value).strip()
    if not text or text.lower() in {"null", "none", "undefined", "all", "all_branches"}:
        return None

    try:
        parsed = int(text)
        if parsed > 0 and str(parsed) == text:
            return parsed
    except (TypeError, ValueError):
        pass

    return text


@app.route('/')
def index():
    """Serve the dashboard UI."""
    return render_template('index.html')


@app.route('/camera')
def camera():
    """Serve the dedicated laptop camera detection page."""
    return render_template('camera.html')


@app.route('/live-monitoring')
def live_monitoring():
    """Serve the professional live monitoring dashboard."""
    return render_template('live_monitoring.html')


@app.route('/api/dashboard/embeddings/import', methods=['POST'])
@require_client_dashboard_admin
def api_dashboard_import_embeddings():
    """Cloud-mode 'Import embeddings' button. Accepts the same trainer-
    produced .zip a Local Node would import, but writes straight to
    Supabase since there is no local node for a cloud-mode org.

    Org-admin action, not internal Support tooling — the Client Dashboard
    button described in the local-mode/cloud-mode fallback design pinned
    to the caller's own org. organization_id therefore comes from
    g.dashboard_user, never from the request body: previously this field
    was fully caller-supplied with zero auth, meaning any request could
    import biometric embeddings into ANY org's staff records simply by
    naming a different organization_id. A value in the form body is no
    longer read for scoping at all."""
    organization_id = g.dashboard_user['org_id']
    branch_id = (request.form.get('branch_id') or request.args.get('branch_id') or '').strip() or None

    upload = request.files.get('package') or request.files.get('file')
    if not upload:
        return jsonify({'success': False, 'error': 'No package file uploaded'}), 400
 
    try:
        with tempfile.NamedTemporaryFile(suffix='.zip', delete=False) as tmp:
            upload.save(tmp.name)
            tmp_path = tmp.name
 
        parsed = parse_embedding_package(Path(tmp_path))
        result = support_cp_db.import_embeddings_cloud_mode(organization_id, branch_id, parsed['records'])
 
        return jsonify({
            'success': True,
            'package_id': parsed.get('package_id'),
            'branch_label': parsed.get('branch_label'),
            **result,
        }), 200
    except PackageImportError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.exception('Cloud-mode embeddings import failed')
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        try:
            os.remove(tmp_path)
        except Exception:
            pass
 
# ============================================
# ENROLLMENT ENDPOINTS
# ============================================

@app.route('/api/enroll/upload-video', methods=['POST'])
def upload_enrollment_video():
    """Retired: not called anywhere in the current frontend and confirmed
    out of the current architecture (2026-08-14) — no UI surface creates
    a face_training_jobs row through this path anymore. Note for whoever
    revives biometric enrollment: this used to be the only entry point
    that queued face_training_jobs for Local Node's /v1/node/poll-jobs
    consumer, so if that pipeline is still expected to run, re-enable
    (auth-gated) rather than delete outright — don't assume the job-queue
    side is also dead just because this trigger is."""
    return jsonify({
        'success': False,
        'error': 'This endpoint has been retired.',
    }), 410


# ============================================
# RECOGNITION ENDPOINTS
# ============================================

@app.route('/api/recognize/frame', methods=['POST'])
def recognize_face_frame():
    """Retired (2026-08-14): not called anywhere in the current frontend or
    by the Local Node (which only ever talks through /v1/node/*), and its
    write path (db.log_attendance) is the legacy SQLite db — already dead
    for every real (UUID) org. Worse than idle dead code: with no auth and
    no org scoping, it matched against the global, unpartitioned
    EMBEDDING_CACHE (populated with real orgs' Supabase-backed embeddings —
    see CameraStreamReader.__init__), so anyone could POST a photo here and
    get back a real employee's name from ANY org. Retired the same way as
    /api/enroll/upload-video rather than auth-gated, since it has no
    legitimate caller today. Note for whoever revives single-frame
    recognition: re-scope EMBEDDING_CACHE lookups to the caller's org
    before re-enabling, not just add a decorator on top of this body."""
    return jsonify({
        'success': False,
        'error': 'This endpoint has been retired.',
    }), 410


@app.route('/api/recognize/rtsp', methods=['POST'])
def recognize_rtsp_stream():
    """Retired (2026-08-14): same rationale as /api/recognize/frame just
    above — no caller in the current frontend or Local Node, no auth or
    org scoping on a route that opened an arbitrary configured camera's
    RTSP feed and matched every frame against the global, unpartitioned
    EMBEDDING_CACHE (real orgs' Supabase-backed embeddings). Also wrote
    attendance through the dead legacy SQLite db.log_attendance path.
    Retired rather than auth-gated for the same reason: no legitimate
    caller today to preserve behavior for."""
    return jsonify({
        'success': False,
        'error': 'This endpoint has been retired.',
    }), 410


@app.route('/api/live-detections', methods=['GET'])
@require_client_dashboard_auth
def get_live_detections():
    # organization_id is pinned to the caller's own token, not read from
    # the query string — previously this endpoint had zero auth and
    # trusted organization_id/branch_id straight off the URL, so any
    # request could read another org's live face-detection feed just by
    # changing a query param. branch_id stays caller-suppliable: a
    # 'branch'-scoped dashboard_user may legitimately narrow within their
    # own org (e.g. viewing one branch's detections), so it's still an
    # optional filter, just no longer a tenant boundary.
    organization_id = g.dashboard_user['org_id']
    branch_id = _parse_tenant_id(request.args.get('branch_id')) or g.dashboard_user.get('branch_id')
    camera_ids_raw = request.args.get('camera_ids', '')
    people_type = (
        request.args.get('people_type') or request.args.get('peopleType') or ''
    ).strip().lower() or None

    allowed_camera_ids = {
        item.strip()
        for item in camera_ids_raw.split(',')
        if item.strip()
    }

    with cache_lock:
        detections = list(LATEST_STREAM_DETECTIONS)

    filtered = []

    for detection in detections:
        detection_camera_id = str(
            detection.get('camera_id')
            or str(detection.get('source', '')).replace('stream_', '')
        )

        if allowed_camera_ids and detection_camera_id not in allowed_camera_ids:
            continue

        if organization_id is not None:
            if str(detection.get('organization_id') or '') != str(organization_id):
                continue

        if branch_id is not None:
            if str(detection.get('branch_id') or '') != str(branch_id):
                continue

        if people_type:
            # Legacy (numeric-ID) orgs never populate people_type on a
            # detection — treat that as "not applicable" and let it through,
            # rather than silently dropping every detection for those orgs.
            detection_people_type = str(detection.get('people_type') or '').strip().lower()
            if detection_people_type and detection_people_type != people_type:
                continue

        filtered.append(detection)

    return jsonify({"detections": filtered}), 200

class CameraStreamReader:
    """
    High-performance dual-threaded camera reader:
    - Thread 1 (Grabber): Continuously grabs the latest frame at 30 FPS from the NVR/DVR.
      This completely eliminates OpenCV buffer delay and lagging.
    - Thread 2 (AI Worker): Processes the latest frame asynchronously for face detection 
      and recognition in the background, updating detections without blocking the stream.
    """
    def __init__(self, camera_id, rtsp_url, organization_id=None, branch_id=None):
        import cv2
        import threading
        import os

        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay"

        self.camera_id = camera_id
        self.rtsp_url = rtsp_url
        self.organization_id = str(organization_id) if organization_id else None
        self.branch_id = str(branch_id) if branch_id else None
        self.is_supabase_org = bool(self.organization_id) and not _positive_int(self.organization_id)
        if self.is_supabase_org:
            refresh_supabase_embedding_cache(self.organization_id, self.branch_id, force=True)

        self.cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
        self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        self.latest_frame = None
        self.latest_detections = []
        self.tracked_faces = {}
        self.next_track_id = 1
        self.last_logged = {}
        self.running = True
        self.viewers_count = 0

        self.lock = threading.Lock()

        self.grabber_thread = threading.Thread(target=self._grabber_loop, daemon=True)
        self.grabber_thread.start()

        self.ai_thread = threading.Thread(target=self._ai_loop, daemon=True)
        self.ai_thread.start()

        # Supabase cache refresh has its own TTL (60s) but was previously
        # being re-checked on every _ai_loop tick (~50Hz) and, on expiry,
        # blocking that same thread on a live Supabase round-trip — a
        # network stall landing directly in the frame-processing path.
        # Runs on its own cadence instead; _ai_loop only ever reads the
        # cache now, never refreshes it.
        if self.is_supabase_org:
            self.supabase_refresh_thread = threading.Thread(
                target=self._supabase_refresh_loop, daemon=True
            )
            self.supabase_refresh_thread.start()
        else:
            self.supabase_refresh_thread = None

    def _supabase_refresh_loop(self):
        import time
        # refresh_supabase_embedding_cache() already no-ops internally if
        # the 60s TTL hasn't expired, so a 5s poll interval here just means
        # we notice expiry within 5s of it happening — not that we hit
        # Supabase every 5s.
        while self.running:
            try:
                refresh_supabase_embedding_cache(self.organization_id, self.branch_id)
            except Exception as e:
                logger.error(f"[{self.camera_id}] Supabase cache refresh failed: {e}")
            time.sleep(5)


    def _grabber_loop(self):
        import time
        import cv2
        import os

        # Set low-latency and TCP options for FFmpeg backend
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay"

        # Uncapped, this loop spins as fast as the decoder allows, burning a
        # full CPU core per camera and starving the AI thread of GIL time.
        # Cap it to a sane source FPS instead — 30 covers every camera we
        # target and still eliminates the buffer-lag this loop exists for.
        target_interval = 1.0 / 30

        while self.running:
            loop_start = time.time()

            if not self.cap.isOpened():
                os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay"
                self.cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_FFMPEG)
                self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                time.sleep(1)
                continue
                
            # Flush FFMPEG/OpenCV socket buffer completely to ensure 0.0 seconds of latency
            for _ in range(5):
                self.cap.grab()
                
            ret, frame = self.cap.retrieve()
            if ret:
                # Resize immediately to 1080px wide for superior distant face recognition range
                h, w = frame.shape[:2]
                max_width = 1080
                if w > max_width:
                    scale = max_width / w
                    frame = cv2.resize(frame, (max_width, int(h * scale)))
                
                with self.lock:
                    self.latest_frame = frame
            else:
                # If grab failed, sleep briefly and retry
                time.sleep(0.005)
                continue

            elapsed = time.time() - loop_start
            if elapsed < target_interval:
                time.sleep(target_interval - elapsed)

    def _ai_loop(self):
        import time
        import cv2
        import base64
        import numpy as np
        from datetime import datetime

        last_ai_time = 0
        ai_interval = TRACK_AI_INTERVAL

        while self.running:
            current_time = time.time()
            
            # Retrieve latest frame from grabber thread under lock
            frame_to_process = None
            with self.lock:
                if self.latest_frame is not None:
                    frame_to_process = self.latest_frame.copy()

            always_on = self.is_supabase_org and _is_cloud_recognition_always_on(
                self.organization_id, self.branch_id
            )

            # Run AI if a viewer is watching OR this branch requires unattended
            # cloud/fallback recognition.
            if (self.viewers_count > 0 or always_on) and frame_to_process is not None:
                if (current_time - last_ai_time) > ai_interval:
                    last_ai_time = current_time
                    
                    try:
                        # ALL-IN-ONE High-Speed Face Detection & Extraction
                        face_results = _detect_faces(frame_to_process)
                        new_cached_detections = []
                        
                        # Sort faces by area (largest first) to prioritize closer faces
                        face_results = sorted(face_results, key=lambda d: (d['bbox'][2] - d['bbox'][0]) * (d['bbox'][3] - d['bbox'][1]), reverse=True)
                        
                        # Get active tracked faces (not unseen for more than 2.0 seconds)
                        active_tracks = {tid: t for tid, t in self.tracked_faces.items() if (current_time - t["last_seen"]) < 2.0}
                        
                        assigned_detections = []  # list of (face_dict, track_id)
                        used_track_ids = set()
                        
                        for face_dict in face_results:
                            x1, y1, x2, y2 = face_dict['bbox']
                            conf = face_dict['conf']
                            cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
                            best_tid = None
                            best_dist = float('inf')
                            
                            # Match with closest active track
                            for tid, t in active_tracks.items():
                                if tid in used_track_ids:
                                    continue
                                rx, ry = t["centroid"]
                                tx1, ty1, tx2, ty2 = t["bbox"]
                                
                                # Calculate IoU
                                ix1 = max(x1, tx1)
                                iy1 = max(y1, ty1)
                                ix2 = min(x2, tx2)
                                iy2 = min(y2, ty2)
                                i_area = max(0, ix2 - ix1) * max(0, iy2 - iy1)
                                u_area = (x2 - x1) * (y2 - y1) + (tx2 - tx1) * (ty2 - ty1) - i_area
                                iou = i_area / u_area if u_area > 0 else 0.0
                                
                                dist = np.sqrt((cx - rx)**2 + (cy - ry)**2)
                                face_size = max(x2 - x1, y2 - y1)
                                
                                if (iou > TRACK_ACTIVE_IOU_THRESHOLD or dist < max(TRACK_ACTIVE_MIN_DIST, face_size * TRACK_ACTIVE_DIST_FACTOR)) and dist < best_dist:
                                    best_dist = dist
                                    best_tid = tid
                                    
                            if best_tid is not None:
                                used_track_ids.add(best_tid)
                                assigned_detections.append((face_dict, best_tid))
                            else:
                                # Start a new track
                                inherited_name = "Unknown"
                                inherited_uid = None
                                inherited_sim = 0.0
                                last_ai_run_val = 0.0
                                
                                for old_tid, old_t in list(self.tracked_faces.items()):
                                    is_lost = (current_time - old_t["last_seen"]) > 0.15
                                    if is_lost and old_t["name"] != "Unknown" and (current_time - old_t["last_seen"]) < TRACK_MAX_AGE_SECONDS:
                                        old_rx, old_ry = old_t["centroid"]
                                        tx1, ty1, tx2, ty2 = old_t["bbox"]
                                        
                                        ix1 = max(x1, tx1)
                                        iy1 = max(y1, ty1)
                                        ix2 = min(x2, tx2)
                                        iy2 = min(y2, ty2)
                                        i_area = max(0, ix2 - ix1) * max(0, iy2 - iy1)
                                        u_area = (x2 - x1) * (y2 - y1) + (tx2 - tx1) * (ty2 - ty1) - i_area
                                        iou = i_area / u_area if u_area > 0 else 0.0
                                        
                                        spatial_dist = np.sqrt((cx - old_rx)**2 + (cy - old_ry)**2)
                                        face_size = max(x2 - x1, y2 - y1)
                                        
                                        if iou > TRACK_LOST_IOU_THRESHOLD or spatial_dist < max(TRACK_LOST_MIN_DIST, face_size * TRACK_LOST_DIST_FACTOR):
                                            inherited_name = old_t["name"]
                                            inherited_uid = old_t["user_id"]
                                            inherited_sim = old_t["similarity"]
                                            last_ai_run_val = old_t["last_ai_run"]
                                            break
                                
                                tid = self.next_track_id
                                self.next_track_id += 1
                                self.tracked_faces[tid] = {
                                    "name": inherited_name,
                                    "user_id": inherited_uid,
                                    "similarity": inherited_sim,
                                    "last_seen": current_time,
                                    "centroid": (cx, cy),
                                    "bbox": (x1, y1, x2, y2),
                                    "last_ai_run": last_ai_run_val
                                }
                                assigned_detections.append((face_dict, tid))
                        
                        # Process each assigned face
                        for idx, (face_dict, tid) in enumerate(assigned_detections):
                            x1, y1, x2, y2 = face_dict['bbox']
                            test_embedding = face_dict['embedding']
                            cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
                            
                            track = self.tracked_faces[tid]
                            track["centroid"] = (cx, cy)
                            track["bbox"] = (x1, y1, x2, y2)
                            track["last_seen"] = current_time
                            
                            name = track["name"]
                            
                            if name == "Unknown" and test_embedding is not None:
                                track["last_ai_run"] = current_time
                                logger.info(f"[_ai_loop - Stream {self.camera_id} - Track {tid}] Identifying via pre-extracted embedding...")

                                best_match = None
                                best_similarity = -1
                                best_identity_source = None  # 'legacy' | 'supabase'

                                with cache_lock:
                                    legacy_candidates = list(EMBEDDING_CACHE.items())

                                if not self.is_supabase_org:
                                    for uid, cache_data in legacy_candidates:
                                        if self.organization_id and str(cache_data.get('organization_id') or '') != self.organization_id:
                                            continue
                                        if self.branch_id and cache_data.get('branch_id') and str(cache_data.get('branch_id')) != self.branch_id:
                                            continue
                                        similarity, is_match = compare_embeddings(
                                            cache_data['aggregate_embedding'], test_embedding, threshold=FACE_MATCHING_THRESHOLD
                                        )
                                        if is_match and similarity > best_similarity:
                                            best_similarity = similarity
                                            best_match = (uid, cache_data)
                                            best_identity_source = 'legacy'

                                if self.is_supabase_org:
                                    refresh_supabase_embedding_cache(self.organization_id, self.branch_id)
                                    cache_key = f"{self.organization_id}:{self.branch_id or '-'}"
                                    with cache_lock:
                                        supabase_people = dict(SUPABASE_EMBEDDING_CACHE.get(cache_key, {}).get('people', {}))
                                    for staff_id, cache_data in supabase_people.items():
                                        similarity, is_match = compare_embeddings(
                                            cache_data['aggregate_embedding'], test_embedding, threshold=FACE_MATCHING_THRESHOLD
                                        )
                                        if is_match and similarity > best_similarity:
                                            best_similarity = similarity
                                            best_match = (staff_id, cache_data)
                                            best_identity_source = 'supabase'

                                if best_match:
                                    matched_id, cache_data = best_match
                                    name = cache_data['name']
                                    similarity_score = best_similarity

                                    track["name"] = name
                                    track["user_id"] = matched_id
                                    track["similarity"] = similarity_score

                                    logger.info(
                                        f"[_ai_loop - Stream {self.camera_id} - Track {tid}] LOCK ESTABLISHED: "
                                        f"'{name}' (ID: {matched_id}, source={best_identity_source}) "
                                        f"with Cosine Similarity {best_similarity:.4f}"
                                    )

                                    face_crop_b64 = None
                                    try:
                                        fh, fw = frame_to_process.shape[:2]
                                        fx1, fy1 = max(0, x1), max(0, y1)
                                        fx2, fy2 = min(fw, x2), min(fh, y2)
                                        crop = frame_to_process[fy1:fy2, fx1:fx2]
                                        if crop.size > 0:
                                            crop_resized = cv2.resize(crop, (80, 80))
                                            _, buf = cv2.imencode('.jpg', crop_resized, [cv2.IMWRITE_JPEG_QUALITY, 85])
                                            face_crop_b64 = "data:image/jpeg;base64," + base64.b64encode(buf).decode('utf-8')
                                    except Exception as ce:
                                        logger.warning(f"Face crop extraction failed: {ce}")

                                    global LATEST_STREAM_DETECTIONS
                                    detection_entry = {
                                        "name": name,
                                        "timestamp": datetime.now().isoformat(),
                                        "confidence": float(best_similarity),
                                        "source": f"stream_{self.camera_id}",
                                        "camera_id": self.camera_id,
                                        "face_crop": face_crop_b64,
                                        "user_id": matched_id,
                                        "department": cache_data.get('department', ''),
                                        "organization_id": cache_data.get('organization_id'),
                                        "branch_id": cache_data.get('branch_id'),
                                        "branch_name": cache_data.get('branch_name', ''),
                                        # Present only for UUID/Supabase orgs (see
                                        # refresh_supabase_embedding_cache) — legacy
                                        # numeric-ID orgs have no vertical concept and
                                        # this stays None for them, which /api/live-
                                        # detections treats as "not filterable", not
                                        # "no match".
                                        "people_type": cache_data.get('people_type'),
                                    }

                                    global DETECTED_USERS_SESSION
                                    with cache_lock:
                                        if matched_id not in DETECTED_USERS_SESSION:
                                            DETECTED_USERS_SESSION.add(matched_id)
                                            LATEST_STREAM_DETECTIONS.insert(0, detection_entry)
                                            LATEST_STREAM_DETECTIONS = LATEST_STREAM_DETECTIONS[:10]

                                    try:
                                        if best_identity_source == 'supabase':
                                            result = support_cp_db.record_cloud_camera_attendance(
                                                org_id=self.organization_id,
                                                branch_id=self.branch_id,
                                                staff_id=matched_id,
                                                confidence=float(best_similarity),
                                                source=f'stream_{self.camera_id}',
                                                camera_id=self.camera_id,
                                            )
                                            if not result.get('already_marked'):
                                                logger.info(
                                                    f"[_ai_loop - Stream {self.camera_id} - Track {tid}] "
                                                    f"Supabase attendance written for '{name}'"
                                                )
                                        elif not db.is_user_present_today(matched_id):
                                            db.log_attendance(matched_id, name, float(best_similarity), f'stream_{self.camera_id}')
                                            logger.info(
                                                f"[_ai_loop - Stream {self.camera_id} - Track {tid}] "
                                                f"DB Attendance written for '{name}'"
                                            )
                                    except Exception as attendance_error:
                                        logger.error(
                                            f"[_ai_loop - Stream {self.camera_id} - Track {tid}] "
                                            f"Failed to record attendance for '{name}': {attendance_error}"
                                        )
                                else:
                                    logger.info(
                                        f"[_ai_loop - Stream {self.camera_id} - Track {tid}] "
                                        f"Biometric verification complete: No match (Highest: {best_similarity:.4f})"
                                    )


                        # Build new_cached_detections from all active tracks (grace period 0.8s)
                        for tid, track in list(self.tracked_faces.items()):
                            if (current_time - track["last_seen"]) < 0.8:
                                name = track["name"]
                                similarity_score = track["similarity"]
                                bbox = track["bbox"]
                                color = (0, 255, 0) if name != "Unknown" else (0, 0, 255)
                                
                                new_cached_detections.append({
                                    'bbox': bbox,
                                    'name': name,
                                    'color': color,
                                    'similarity': similarity_score
                                })
                            
                        # Clean up very old inactive tracks (>6.0 seconds)
                        self.tracked_faces = {tid: t for tid, t in self.tracked_faces.items() if (current_time - t["last_seen"]) < 6.0}
                        
                        with self.lock:
                            self.latest_detections = new_cached_detections
                            
                    except Exception as e:
                        logger.error(f"Background AI processing failed: {e}")
            else:
                # Clear detections when no viewers are active
                if len(self.latest_detections) > 0:
                    with self.lock:
                        self.latest_detections = []
                
            time.sleep(0.02)

    def get_frame(self):
        with self.lock:
            if self.latest_frame is None:
                return False, None, []
            return True, self.latest_frame.copy(), list(self.latest_detections)

    def stop(self):
        self.running = False
        self.grabber_thread.join(timeout=1.0)
        self.ai_thread.join(timeout=1.0)
        if self.supabase_refresh_thread is not None:
            self.supabase_refresh_thread.join(timeout=1.0)
        self.cap.release()


active_stream_readers = {}
active_readers_lock = threading.Lock()

def get_or_create_reader(camera_id, rtsp_url, organization_id=None, branch_id=None):
    global active_stream_readers
    with active_readers_lock:
        if camera_id in active_stream_readers:
            if active_stream_readers[camera_id].running:
                return active_stream_readers[camera_id]
        logger.info(f"[*] Starting background thread stream reader for: {camera_id}")
        reader = CameraStreamReader(camera_id, rtsp_url, organization_id=organization_id, branch_id=branch_id)
        active_stream_readers[camera_id] = reader
        return reader


@app.route('/api/cameras', methods=['GET'])
@require_client_dashboard_auth
def api_get_cameras():
    """raw_org_id is pinned to g.dashboard_user['org_id'] rather than read
    from the query string — previously unauthenticated, so any request
    could read another org's camera layout (names, branch mapping, and
    rtsp_url — often credential-bearing) by supplying a different
    organization_id/organizationId/org_id param. raw_branch_id stays
    query-suppliable as an optional in-org narrowing filter, same
    reasoning as /api/cctv/live-tracking above."""
    raw_org_id = str(g.dashboard_user['org_id'])
    raw_branch_id = (
        request.args.get('branch_id')
        or request.args.get('branchId')
        or g.dashboard_user.get('branch_id')
    )

    if not raw_org_id:
        return jsonify({'error': 'organization_id is required'}), 400

    # organizations.id is uuid NOT NULL in Supabase — every real tenant's
    # organization_id is a UUID. Cameras always come from Supabase; the old
    # legacy-SQLite fallback below this line is unreachable and has been
    # removed (see /api/cctv/live-tracking cleanup for the full rationale).
    if not _positive_int(raw_org_id):
        try:
            return jsonify(support_cp_db.list_client_cameras(raw_org_id, raw_branch_id)), 200
        except ValueError as exc:
            return jsonify({'error': str(exc), 'message': str(exc)}), 400

    return jsonify({'error': 'organization_id must be a valid UUID'}), 400

@app.route('/api/cctv/live-tracking', methods=['GET'])
@require_client_dashboard_auth
def api_cctv_live_tracking():
    """
    Live CCTV tracking endpoint that returns:
    - All cameras for the scope with activeDetections
    - All people/staff in the attendance system
    - Stats: registered, active feeds, active now
    - Local node status and fallback indicators
    
    Used by the Live CCTV Tracking dashboard page.
    Features:
    - UUID-safe and tenant-safe with strict validation
    - People-type aware (from enabledPeopleTypes config)
    - Branch-scoped camera list
    - Dynamic activeDetections based on recent detections
    - Local node heartbeat tracking and offline fallback

    raw_org_id is pinned to g.dashboard_user['org_id'] rather than read
    from the query string — previously unauthenticated, so any request
    could read another org's full staff directory + camera layout +
    live-tracking data by supplying a different organization_id/
    organizationId/org_id param. raw_branch_id stays query-suppliable as
    an optional in-org narrowing filter, same reasoning as
    /api/live-detections just above.
    """
    raw_org_id = str(g.dashboard_user['org_id'])
    raw_branch_id = (
        request.args.get('branch_id')
        or request.args.get('branchId')
        or g.dashboard_user.get('branch_id')
    )
    requested_people_type = (
        request.args.get('people_type') or request.args.get('peopleType') or ''
    ).strip().lower() or None

    # UUID Support-created tenants use Supabase backend
    if raw_org_id and not _positive_int(raw_org_id):
        try:
            # Validate UUID format for strict tenant isolation
            if not isinstance(raw_org_id, str) or len(raw_org_id) < 16:
                return jsonify({'error': 'Invalid organization_id format'}), 400
            
            # Independent lookups fetched in parallel — cameras, org config,
            # onboarding config, node status, and one staff query per scoped
            # people-type all have no data dependency on each other. Doing
            # them sequentially (the previous version of this endpoint) added
            # up to ~6-10 blocking Supabase round trips per poll even after
            # the N+1 fallback-attendance fix, which meant every poll of the
            # ~2s-interval Live CCTV page ran uncomfortably close to (and
            # sometimes over) the poll interval, showing occasional
            # (canceled) requests in the Network tab. get_client_bootstrap()
            # in support_db_client_users.py uses the same
            # ThreadPoolExecutor pattern for the same reason.
            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                f_cameras = pool.submit(
                    support_cp_db.list_client_cameras, raw_org_id, raw_branch_id
                )
                f_org = pool.submit(support_cp_db.get_organization, raw_org_id)
                f_onboarding = pool.submit(
                    support_cp_db.get_client_onboarding_config, raw_org_id
                )
                f_node_status = pool.submit(
                    support_cp_db.get_local_node_status, raw_org_id
                )
                f_detections = pool.submit(
                    support_cp_db.get_today_detections_by_staff,
                    raw_org_id, raw_branch_id,
                )

                raw_cameras = f_cameras.result() or []
                org = f_org.result()
                onboarding_config = f_onboarding.result() or {}
                node_status = f_node_status.result()
                detections_by_staff = f_detections.result() or {}

            # People-type scope comes from the normalized organizations row
            # (get_organization -> _attach_status), the same source the
            # Support Dashboard toggle actually writes to. The onboarding
            # JSONB blob (get_client_onboarding_config) can drift from that
            # row and was causing this endpoint to keep showing a people
            # type after it had been switched off — kept below only for
            # node_offline_threshold_seconds, which is node/hardware config,
            # not a people-type field.
            enabled_people_types = org.get('enabled_people_types') or ['staff']
            attendance_people_types = org.get('attendance_people_types') or enabled_people_types
            node_offline_threshold = onboarding_config.get('node_offline_threshold_seconds', 300)

            if requested_people_type and requested_people_type not in attendance_people_types:
                return jsonify({
                    'error': f"people_type '{requested_people_type}' is not currently active for this organization",
                }), 400

            # Default scope is attendance_people_types (what the Support
            # Dashboard toggle currently has switched on) — not
            # enabled_people_types (every type the org could ever track).
            # An explicit people_type narrows further to just that one type,
            # for the dropdown filter on this page.
            scoped_people_types = (
                [requested_people_type] if requested_people_type else attendance_people_types
            )

            # Get local node status for fallback detection
            is_node_offline = node_status.get('offline', False) if node_status else True
            last_heartbeat = node_status.get('last_heartbeat') if node_status else None
            
            # Get all people/staff currently in scope
            employees = []
            total_detections_by_camera = {}
            # list_client_cameras returns both 'id' and 'camera_name'/'location'
            # (see support_db_attendance_dashboard.list_client_cameras).
            camera_by_id = {str(cam.get('id')): cam for cam in raw_cameras}

            # One list_client_staff call per scoped people-type, also run in
            # parallel — most orgs only have one or two active people-types,
            # but this avoids paying for them one after another when there
            # are several.
            with concurrent.futures.ThreadPoolExecutor(
                max_workers=max(1, len(scoped_people_types))
            ) as pool:
                staff_futures = {
                    person_type: pool.submit(
                        support_cp_db.list_client_staff,
                        raw_org_id,
                        branch_id=raw_branch_id,
                        people_type=person_type,
                        archived=False,
                    )
                    for person_type in scoped_people_types
                }
                all_staff_by_type = {
                    person_type: (future.result() or [])
                    for person_type, future in staff_futures.items()
                }

            # Fetch fallback/manual attendance for every in-scope person in
            # ONE Supabase round trip instead of one call per person. The
            # old per-person loop (get_recent_fallback_attendance inside
            # this for-loop) meant an org with N staff made N sequential
            # network calls on every single poll of this endpoint. Since
            # the Live CCTV Tracking page polls every ~2s and aborts the
            # previous in-flight request each time (see
            # useLiveCctvTracking.load() on the frontend), a slow enough
            # N pushed every request past the poll interval, so requests
            # kept getting aborted before they could finish — showing as
            # continuous (failed)/cancelled entries in the Network tab and
            # a UI stuck at 0/0/0.
            fallback_by_person: dict = {}
            if is_node_offline:
                all_person_ids = [
                    person.get('id')
                    for staff in all_staff_by_type.values()
                    for person in staff
                ]
                fallback_by_person = support_cp_db.get_recent_fallback_attendance_bulk(
                    raw_org_id,
                    all_person_ids,
                    branch_id=raw_branch_id,
                    within_seconds=node_offline_threshold,
                )

            for person_type in scoped_people_types:
                staff = all_staff_by_type[person_type]

                for person in staff:
                    # Check if person has recent manual/fallback attendance when node is offline
                    attendance_status = 'offline'
                    fallback_marker = False

                    if is_node_offline:
                        fallback_attendance = fallback_by_person.get(str(person.get('id')))
                        if fallback_attendance:
                            attendance_status = 'fallback'
                            fallback_marker = True

                    # The roster says who COULD be detected; only an
                    # attendance row says who actually WAS, and from which
                    # camera. Without this the six fields below stay None
                    # and Movement Logs is indistinguishable from "nobody
                    # has been seen all day".
                    detection = detections_by_staff.get(str(person.get('id')))
                    camera = (
                        camera_by_id.get(str(detection.get('camera_id')))
                        if detection and detection.get('camera_id')
                        else None
                    )
                    if detection:
                        attendance_status = 'Active'
                        camera_key = str(detection.get('camera_id') or '')
                        if camera_key:
                            total_detections_by_camera[camera_key] = (
                                total_detections_by_camera.get(camera_key, 0) + 1
                            )

                    employee = {
                        'id': person.get('id'),
                        'name': person.get('name') or person.get('display_name'),
                        'personType': person_type,
                        'personCode': person.get('employee_id') or person.get('staff_id'),
                        'employeeId': person.get('id'),
                        'cameraId': detection.get('camera_id') if detection else None,
                        'cameraName': camera.get('camera_name') if camera else None,
                        'location': camera.get('location') if camera else None,
                        'branchId': person.get('branch_id') or raw_branch_id,
                        'branchName': person.get('branch_name'),
                        'timestamp': detection.get('timestamp') if detection else None,
                        'detectedAt': detection.get('timestamp') if detection else None,
                        # MovementRow renders formatDetectionTime(person.lastSeen)
                        # — the other two keys are carried for API consumers
                        # but are not what the table reads.
                        'lastSeen': detection.get('timestamp') if detection else None,
                        'status': attendance_status,
                        'pose': (detection.get('capture_channel') or 'detected') if detection else '—',
                        'duty': 'on_duty',
                        'fallbackMarker': fallback_marker,
                    }
                    employees.append(employee)
            
            # Format cameras with activeDetections and local node status
            formatted_cameras = []
            for cam in raw_cameras:
                camera_id = cam.get('id') or cam.get('camera_id')
                formatted_camera = {
                    'id': camera_id,
                    'cameraName': cam.get('name') or cam.get('camera_name'),
                    'location': cam.get('location') or 'Unconfigured',
                    'branchId': cam.get('branch_id') or raw_branch_id,
                    'branchName': cam.get('branch_name') or 'Main Branch',
                    'status': cam.get('status') or ('Offline' if is_node_offline else 'Online'),
                    'activeDetections': total_detections_by_camera.get(str(camera_id), 0),
                    'localNodeOffline': is_node_offline,
                    'lastHeartbeat': last_heartbeat,
                }
                formatted_cameras.append(formatted_camera)
            
            # Build response with node status indicators
            return jsonify({
                'employees': employees,
                'cameras': formatted_cameras,
                'registeredCount': len(set(e.get('id') for e in employees)),
                'activeFeedCount': len(formatted_cameras),
                # Detected today, not "flagged as fallback" — the old count
                # only ever incremented while the node was OFFLINE, so an
                # online node always reported 0 detections.
                'activeNowCount': sum(1 for e in employees if e.get('status') == 'Active'),
                'sourceStatus': 'ready' if not is_node_offline else 'degraded',
                'sourceLabel': (raw_branch_id or 'All Branches') + (' (Local Node Offline)' if is_node_offline else ''),
                'localNodeStatus': {
                    'online': not is_node_offline,
                    'lastHeartbeat': last_heartbeat,
                    'thresholdSeconds': node_offline_threshold,
                },
            }), 200
        except Exception as exc:
            logger.error(f"Error in /api/cctv/live-tracking (UUID org): {exc}", exc_info=True)
            return jsonify({'error': str(exc), 'message': str(exc)}), 400

    # organizations.id is uuid NOT NULL in Supabase — no real tenant can
    # reach this branch. It previously called db.get_users() and
    # db.get_attendance_for_today(), neither of which exists in
    # database.py, so any request that did land here crashed with an
    # AttributeError masked as a generic 400. Fail fast with an accurate
    # error instead of leaving that dead, broken path in place.
    logger.warning(f"/api/cctv/live-tracking hit with non-UUID organization_id={raw_org_id!r}")
    return jsonify({'error': 'organization_id must be a valid UUID'}), 400

@app.route('/api/stream/token', methods=['POST'])
@require_client_dashboard_auth
def api_mint_stream_token():
    """Mints the short-lived token GET /api/stream/<camera_id> requires.

    Called by the Client Dashboard (a normal authenticated fetch, unlike
    the <img> tag that consumes the stream itself) immediately before
    setting img.src, and periodically thereafter to keep a fresh token
    available in case the MJPEG connection needs to reopen.

    Verifies the camera belongs to the caller's own org BEFORE minting —
    stream_token.py trusts this check completely and performs none of its
    own, so this is the one and only place that guards against minting a
    token for a camera in another org.
    """
    data = request.get_json(silent=True) or {}
    camera_id = str(data.get('camera_id') or '').strip()
    if not camera_id:
        return jsonify({'success': False, 'error': 'camera_id is required'}), 400

    org_id = g.dashboard_user['org_id']
    # Belt and braces: get_client_camera_by_id now rejects non-UUID ids
    # itself, but this route must never turn a lookup failure into a 500.
    # A 500 here is both an availability bug (the dashboard's live view
    # silently dies) and an information leak — under the dev server's
    # debug mode an unhandled exception renders a full traceback and an
    # interactive console. Fail closed: no camera resolved means no token
    # minted, and the caller cannot tell "malformed id" from "camera
    # belongs to another org".
    try:
        camera = support_cp_db.get_client_camera_by_id(org_id, camera_id)
    except Exception:
        logger.exception('Camera lookup failed while minting a stream token for org %s', org_id)
        camera = None
    if not camera:
        return jsonify({
            'success': False,
            'error': 'Camera is not configured in backend',
            'camera_id': camera_id,
        }), 404

    token = mint_stream_token(org_id, camera_id)
    return jsonify({'success': True, 'stream_token': token}), 200


@app.route('/api/stream/<camera_id>')
def video_stream(camera_id):
    # org_id/camera_id scoping for this request comes ENTIRELY from the
    # stream token, never from a query string — an <img> tag can't send an
    # Authorization header, so this route can't wear @require_client_
    # dashboard_auth like the rest of the dashboard API. Previously it had
    # no auth at all and trusted organization_id straight off the URL, so
    # any request could open ANY org's camera feed just by supplying a
    # different id. See stream_token.py for the full rationale.
    stream_token = request.args.get('stream_token', '')
    token_payload = verify_stream_token(stream_token, camera_id)
    if not token_payload:
        return jsonify({'error': 'Missing, invalid, or expired stream_token'}), 401

    raw_org_id = token_payload['org_id']
    camera = support_cp_db.get_client_camera_by_id(str(raw_org_id), str(camera_id))

    if not camera:
        return jsonify({
            'error': 'Camera is not configured in backend',
            'camera_id': camera_id,
        }), 404

    rtsp_url = camera.get('rtsp_url')

    if not rtsp_url:
        return jsonify({
            'error': 'Camera URL is missing in backend configuration',
            'camera_id': camera_id,
            'camera_name': camera.get('camera_name') or camera.get('name'),
            'status': 'Error',
        }), 400

    reader = get_or_create_reader(
        camera_id,
        rtsp_url,
        organization_id=raw_org_id or None,
        branch_id=camera.get('backend_branch_id') or camera.get('branch_id'),
    )

    def generate_frames():
        import cv2
        import time

        with reader.lock:
            reader.viewers_count += 1

        try:
            while True:
                ret, frame, detections = reader.get_frame()

                if not ret:
                    offline_frame = np.zeros((480, 640, 3), dtype=np.uint8)
                    cv2.putText(
                        offline_frame,
                        "CAMERA STANDBY / RECONNECTING...",
                        (70, 240),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.7,
                        (0, 165, 255),
                        2,
                        cv2.LINE_AA,
                    )

                    ret_encode, jpeg = cv2.imencode(".jpg", offline_frame)
                    if ret_encode:
                        yield (
                            b"--frame\r\n"
                            b"Content-Type: image/jpeg\r\n\r\n"
                            + jpeg.tobytes()
                            + b"\r\n"
                        )

                    time.sleep(0.5)
                    continue

                # Do not draw bounding boxes on the live feed to reduce the
                # perception of lag. Detection results are shown in the
                # right-panel confirmation grid instead (see /api/live-detections).
                ret_encode, jpeg = cv2.imencode(".jpg", frame)
                if not ret_encode:
                    continue

                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n\r\n"
                    + jpeg.tobytes()
                    + b"\r\n"
                )

                time.sleep(0.033)

        finally:
            with reader.lock:
                reader.viewers_count = max(0, reader.viewers_count - 1)

    return Response(
        generate_frames(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )

    

# ============================================
# ADMIN/DASHBOARD ENDPOINTS
# ============================================

@app.route('/api/users', methods=['GET'])
def get_users():
    """Retired 2026-08 — unauthenticated legacy-SQLite staff dump. No active
    tenant runs on legacy SQLite; use GET /api/staff (Supabase, authenticated,
    org/branch/team-scoped) instead. See security-remediation Tier 2."""
    return jsonify({
        'success': False,
        'error': 'This endpoint has been retired. Use GET /api/staff instead.',
    }), 410

@app.route('/api/staff/<int:user_id>/restore', methods=['POST'])
@require_client_dashboard_admin
def api_restore_staff_member(user_id):
    """
    Restore archived employee back to active Staff Directory.

    Biometrics are not restored.
    User must be trained again.
    """
    try:
        data = request.get_json(silent=True) or {}

        # organization_id comes from the verified admin token, not the
        # request body — restore_archived_user refuses the restore outright
        # if it doesn't match the archived user's own org.
        organization_id = _positive_int(g.dashboard_user.get('org_id'))
        restored_by = data.get("restored_by")

        restored = db.restore_archived_user(
            user_id=int(user_id),
            restored_by=int(restored_by) if restored_by else None,
            organization_id=organization_id,
        )

        if not restored:
            return jsonify({
                "success": False,
                "error": "Archived employee not found.",
            }), 404

        refresh_embedding_cache()

        user = db.get_user_by_id(int(user_id))

        return jsonify({
            "success": True,
            "message": (
                "Employee restored successfully. "
                "Biometric training is required again."
            ),
            "restore": restored,
            "user": _safe_user(user),
        }), 200

    except ValueError as e:
        return jsonify({
            "success": False,
            "error": str(e),
        }), 409

    except Exception as e:
        logger.exception(f"Failed to restore staff member {user_id}")
        return jsonify({
            "success": False,
            "error": str(e),
        }), 500



@app.route('/api/users/<int:user_id>/update', methods=['POST'])
@app.route('/api/users/<int:user_id>', methods=['PUT'])
@require_client_dashboard_auth
def api_update_user(user_id):
    try:
        data = request.get_json() or {}

        if not data.get('name'):
            return jsonify({'error': 'Name is required'}), 400

        existing = db.get_user_by_id(user_id)
        if not existing or not _dashboard_target_org_matches(g.dashboard_user, existing.get('organization_id')):
            return jsonify({'error': 'User not found or update failed'}), 404

        # Phase 2B: flexible staff update keeps StaffDirectory and old pages
        # using the same /api/users/<id> endpoint.
        if hasattr(db, 'update_user_fields'):
            success = db.update_user_fields(user_id, data)
        else:
            success = db.update_user(
                user_id,
                data.get('name'),
                data.get('email'),
                data.get('phone'),
                data.get('department'),
                data.get('notes'),
                shift=data.get('shift'),
                duty_start=data.get('duty_start'),
                duty_end=data.get('duty_end'),
                staff_type=data.get('staff_type'),
                access_modules=json.dumps(data.get('access_modules')) if data.get('access_modules') is not None else None,
            )

        if success:
            refresh_embedding_cache()
            user = db.get_user_by_id(user_id)
            return jsonify({
                'success': True,
                'message': f"User '{data.get('name')}' updated successfully",
                'user': _safe_user(user),
            }), 200

        return jsonify({'error': 'User not found or update failed'}), 404
    except Exception as e:
        logger.error(f"API update user error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/users/<int:user_id>/profile', methods=['PATCH', 'PUT'])
@require_client_dashboard_auth
def api_update_user_profile(user_id):
    """Update the logged-in dashboard user's own profile settings.

    This endpoint is intentionally user-scoped profile data only. It does not
    update organization/branch/website settings. Both admin and staff dashboard
    users can use it for their own name/email/phone and optional password.
    """
    # Self-only, matching the docstring's own stated intent — this is not a
    # generic "edit any employee" endpoint (that's PUT /api/users/<id> /
    # /api/staff/<id>, both org-scoped and above the caller-vs-target-self
    # question this route was never designed to answer).
    if str(g.dashboard_user.get('id')) != str(user_id):
        return jsonify({
            'success': False,
            'error': 'You can only update your own profile.',
        }), 403

    try:
        data = request.get_json(silent=True) or {}
        user = db.get_user_by_id(int(user_id))

        if not user:
            return jsonify({
                'success': False,
                'error': 'User not found.',
            }), 404

        payload = {}

        for key in ('name', 'email', 'phone'):
            if key in data:
                value = data.get(key)
                payload[key] = str(value or '').strip()

        if 'name' in payload and not payload['name']:
            return jsonify({
                'success': False,
                'error': 'Name is required.',
            }), 400

        if 'email' in payload and not payload['email']:
            return jsonify({
                'success': False,
                'error': 'Email is required.',
            }), 400

        # No current_password re-verification: this route sits behind
        # @require_client_dashboard_auth's self-only JWT check (enforced at
        # the top of this function), which is already proof of identity —
        # re-asking for the current password here would be a second,
        # redundant login, not additional security. Same policy, same
        # reasoning, as the Supabase-backed
        # support_db_client_users.update_client_user_profile.
        new_password = str(data.get('new_password') or '')

        if new_password:
            try:
                support_cp_db.validate_strong_password(new_password)
            except ValueError as e:
                return jsonify({'success': False, 'error': str(e)}), 400

        if payload:
            updated = db.update_user_fields(int(user_id), payload)
            if not updated:
                return jsonify({
                    'success': False,
                    'error': 'Profile update failed.',
                }), 500

        if new_password:
            db.change_password(int(user_id), new_password)

        refreshed = db.get_user_by_id(int(user_id))
        refresh_embedding_cache()

        response = {
            'success': True,
            'message': 'Profile settings saved successfully.',
            'user': _safe_user(refreshed),
        }

        if new_password:
            # This is the live legacy path ChangePasswordCard.tsx actually
            # calls for non-UUID (legacy SQLite) accounts -- unlike
            # /api/change-password below, which api.ts no longer calls.
            # Same reasoning as api_change_own_dashboard_password: rotate
            # (not invalidate) so the CALLER's own request doesn't
            # immediately 401 itself out on its next call, and return the
            # fresh token so the frontend can persist it before that next
            # call goes out.
            response['token'] = mint_dashboard_token(
                {'id': g.dashboard_user.get('id'), 'org_id': g.dashboard_user.get('org_id')},
                account_type='legacy',
                is_admin=g.dashboard_user.get('is_admin', False),
                session_reason='password_changed',
            )

        return jsonify(response), 200

    except Exception as e:
        logger.exception(f"Dashboard profile update failed for user_id={user_id}")
        return jsonify({
            'success': False,
            'error': str(e),
        }), 500

@app.route('/api/users/<int:user_id>/delete', methods=['POST'])
@app.route('/api/users/<int:user_id>', methods=['DELETE'])
@require_client_dashboard_admin
def api_delete_user(user_id):
    try:
        data = request.get_json(silent=True) or {}
        reason = data.get("reason", "Archived from Staff Management")
        archived_by = data.get("archived_by")
        retention_years = data.get("retention_years")

        # organization_id always comes from the verified admin token, never
        # from the request body — see _dashboard_target_org_matches. This is
        # also what makes archive_user_for_retention refuse a cross-org
        # delete at the data layer.
        result = db.archive_user_for_retention(
            user_id=user_id,
            retention_years=int(retention_years) if retention_years else None,
            reason=reason,
            archived_by=int(archived_by) if archived_by else None,
            organization_id=_positive_int(g.dashboard_user.get('org_id')),
        )

        if not result:
            return jsonify({"error": "User not found or archive failed"}), 404

        with cache_lock:
            if user_id in EMBEDDING_CACHE:
                del EMBEDDING_CACHE[user_id]
                logger.info(f"Evicted user ID {user_id} from EMBEDDING_CACHE")

        return jsonify({
            "success": True,
            "message": (
                "Employee archived. Biometric embeddings deleted immediately. "
                f"HR records retained for {result['retention_years']} years."
            ),
            "archive": result,
        }), 200

    except Exception as e:
        logger.error(f"API archive user error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/api/users/<int:user_id>/mark-absent', methods=['POST'])
@require_client_dashboard_auth
def api_mark_user_absent(user_id):
    try:
        target = db.get_user_by_id(int(user_id))
        if not target or not _dashboard_target_org_matches(g.dashboard_user, target.get('organization_id')):
            return jsonify({'error': 'User not found'}), 404

        success = db.mark_user_absent_today(user_id)
        if success:
            return jsonify({'success': True, 'message': f'User ID {user_id} marked absent for today'}), 200
        else:
            return jsonify({'error': 'Failed to mark user absent'}), 400
    except Exception as e:
        logger.error(f"API mark absent error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/users/<int:user_id>/mark-present', methods=['POST'])
@require_client_dashboard_auth
def api_mark_user_present(user_id):
    try:
        target = db.get_user_by_id(int(user_id))
        if not target or not _dashboard_target_org_matches(g.dashboard_user, target.get('organization_id')):
            return jsonify({'error': 'User not found'}), 404

        success = db.mark_user_present_today(user_id)
        if success:
            return jsonify({'success': True, 'message': f'User ID {user_id} marked present for today'}), 200
        else:
            return jsonify({'error': 'Failed to mark user present'}), 400
    except Exception as e:
        logger.error(f"API mark present error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/attendance/logs', methods=['GET'])
@require_client_dashboard_auth
def get_attendance_logs():
    limit = request.args.get('limit', 100, type=int)
    # organization_id always comes from the verified token — never the
    # query string/header — so a caller can only ever pull their own org's
    # logs, no matter what they pass.
    raw_org_id = str(g.dashboard_user.get('org_id') or '').strip()
    raw_branch_id = g.dashboard_user.get('branch_id') or request.args.get('branch_id') or request.args.get('branchId')
    people_type = request.args.get('people_type') or request.args.get('peopleType')

    # organizations.id is uuid NOT NULL in Supabase — the legacy-SQLite
    # fallback this route used to fall through to for a non-UUID org_id is
    # unreachable by any real tenant.
    if not _positive_int(raw_org_id):
        try:
            logs = support_cp_db.get_client_attendance_logs(
                org_id=raw_org_id,
                branch_id=raw_branch_id,
                limit=limit,
                people_type=people_type,
            )
            return jsonify({'logs': logs}), 200
        except ValueError as e:
            return jsonify({'logs': [], 'message': str(e)}), 400
        except Exception as e:
            logger.exception(f'Supabase attendance logs failed for organization_id={raw_org_id}')
            return jsonify({'logs': [], 'message': str(e)}), 500

    return jsonify({'logs': [], 'message': 'organization_id must be a valid UUID'}), 400


@app.route('/api/attendance/user/<int:user_id>', methods=['GET'])
@require_client_dashboard_auth
def get_user_attendance(user_id):
    target = db.get_user_by_id(user_id)
    if not target or not _dashboard_target_org_matches(g.dashboard_user, target.get('organization_id')):
        return jsonify({'error': 'User not found'}), 404
    days = request.args.get('days', 7, type=int)
    logs = db.get_attendance_by_user(user_id, days)
    return jsonify({'user_id': user_id, 'logs': logs, 'days': days}), 200


@app.route('/api/stats', methods=['GET'])
@require_client_dashboard_auth
def get_stats():
    """Was completely open, with organization_id trusted from the query
    string/header — any caller could pull another tenant's attendance
    counts (present/absent/enrolled/recent entries) by editing the URL.
    Fixed to the standard contract: org_id only from the verified token,
    team-scoped managers get filtered stats via get_effective_scope_ids
    (get_client_attendance_statistics was updated to accept scope_ids,
    matching get_client_attendance_today's existing convention)."""
    try:
        dashboard_user = g.dashboard_user
        raw_org_id = str(dashboard_user.get('org_id') or '').strip()
        raw_branch_id = request.args.get('branch_id') or request.args.get('branchId')
        if not dashboard_user.get('is_admin'):
            raw_branch_id = dashboard_user.get('branch_id') or raw_branch_id
        date_value = request.args.get('date') or request.args.get('log_date')
        people_type = request.args.get('people_type') or request.args.get('peopleType')

        if not raw_org_id:
            return jsonify({'error': 'organization_id is required'}), 400

        requested_view = request.args.get('view') or request.args.get('teamView')
        scope_ids = get_effective_scope_ids(dashboard_user, requested_view=requested_view)

        stats = support_cp_db.get_client_attendance_statistics(
            org_id=raw_org_id,
            branch_id=raw_branch_id,
            date_value=date_value,
            people_type=people_type,
            scope_ids=scope_ids,
        )
        return jsonify({
            'total_users': stats.get('total_users', 0),
            'attendance_users': stats.get('attendance_users', 0),
            'total_staff': stats.get('total_staff', stats.get('attendance_users', 0)),
            'enrolled_users': stats.get('enrolled_users', 0),
            'today_attendance': stats.get('today_count', 0),
            'unique_users_today': stats.get('unique_users_today', 0),
            'present_today': stats.get('present_today', 0),
            'absent_today': stats.get('absent_today', 0),
            'total_logs': stats.get('total_records', stats.get('today_count', 0)),
            'avg_confidence': stats.get('avg_confidence', 0),
            'recent_entries': stats.get('recent_entries', []),
            'timestamp': stats.get('timestamp') or datetime.now().isoformat(),
        }), 200

    except Exception as e:
        logger.error(f"Stats endpoint error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/system/health', methods=['GET'])
def system_health():
    try:
        db_ok = True
        models_ok = True
        try:
            db.init_db()
        except:
            db_ok = False
        try:
            get_face_model(MODELS_DIR, prefer_gpu=ENABLE_GPU)
        except:
            models_ok = False
        return jsonify({
            'status': 'healthy' if (db_ok and models_ok) else 'degraded',
            'database': 'ok' if db_ok else 'error',
            'models': 'ok' if models_ok else 'error',
            'timestamp': datetime.now().isoformat()
        }), 200
    except Exception as e:
        logger.error(f"Health check error: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({'status': 'healthy', 'timestamp': datetime.now().isoformat()}), 200


@app.route('/api/init', methods=['POST'])
def initialize_system():
    """Retired: not called anywhere in the current frontend (initSystem is
    exported from api.ts but never invoked from any component) and
    confirmed unused/dead in testing. Startup DB init and model warm-up
    already happen automatically in __main__ at process start — this
    route was a manual re-trigger with no live caller."""
    return jsonify({
        'success': False,
        'error': 'This endpoint has been retired.',
    }), 410


@app.errorhandler(413)
def request_entity_too_large(error):
    max_mb = app.config['MAX_CONTENT_LENGTH'] // (1024 * 1024)
    return jsonify({'error': f'File too large. Max size: {max_mb}MB'}), 413

@app.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Endpoint not found'}), 404

@app.errorhandler(500)
def internal_error(error):
    return jsonify({'error': 'Internal server error'}), 500


import base64 as _b64

@app.route('/api/users/<int:user_id>/photo', methods=['POST'])
@require_client_dashboard_auth
def upload_user_photo(user_id):
    """Upload professional profile photo for a user."""
    target = db.get_user_by_id(user_id)
    if not target or not _dashboard_target_org_matches(g.dashboard_user, target.get('organization_id')):
        return jsonify({'error': 'User not found'}), 404

    if 'photo' not in request.files:
        return jsonify({'error': 'No photo provided'}), 400
    photo = request.files['photo']
    if photo.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    # Validate extension
    ext = photo.filename.rsplit('.', 1)[-1].lower()
    if ext not in ['jpg', 'jpeg', 'png', 'webp']:
        return jsonify({'error': 'Only jpg/png/webp allowed'}), 400

    # Per-route size cap. MAX_CONTENT_LENGTH is the global backstop sized
    # for the embeddings import package; a profile photo needs far less.
    MAX_PHOTO_BYTES = 5 * 1024 * 1024
    photo.stream.seek(0, os.SEEK_END)
    size = photo.stream.tell()
    photo.stream.seek(0)
    if size > MAX_PHOTO_BYTES:
        return jsonify({'error': 'Photo too large. Max size: 5MB'}), 413
    
    # Save to static/profile_photos/
    photos_dir = Path('static/profile_photos')
    photos_dir.mkdir(parents=True, exist_ok=True)
    
    try:
        import cv2
        import numpy as np
        
        # Hamesha .jpg ke tor par save karo
        # chahe upload .jpeg / .png / .webp ho
        file_bytes = np.frombuffer(photo.read(), np.uint8)
        img = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)
        
        if img is None:
            return jsonify({'error': 'Invalid image file'}), 400
        
        # Hamesha user_{id}.jpg — extension problem khatam
        filename = f"user_{user_id}.jpg"
        filepath = photos_dir / filename
        
        cv2.imwrite(str(filepath), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        
        photo_url = f'/api/users/{user_id}/photo'
        public_photo_url = f'/profile_photos/{filename}'

        db.save_user_photo(user_id, str(filepath))

        if hasattr(db, 'update_user_fields'):
            db.update_user_fields(user_id, {
                'profile_image_url': photo_url,
                'profile_image_name': filename,
            })

        user = db.get_user_by_id(user_id)

        return jsonify({
            'success': True,
            'photo_url': photo_url,
            'public_photo_url': public_photo_url,
            'profile_image_url': photo_url,
            'profileImageUrl': photo_url,
            'profile_image_name': filename,
            'profileImageName': filename,
            'user': _safe_user(user),
        }), 200
        
    except Exception as e:
        logger.error(f"Photo upload error: {e}")
        return jsonify({'error': f'Photo processing failed: {str(e)}'}), 500

@app.route('/api/users/<int:user_id>/photo', methods=['GET'])
@require_client_dashboard_auth
def get_user_photo(user_id):
    """Serve profile photo for a user."""
    target = db.get_user_by_id(user_id)
    if not target or not _dashboard_target_org_matches(g.dashboard_user, target.get('organization_id')):
        return jsonify({'error': 'No photo found'}), 404

    photo_path = db.get_user_photo(user_id)
    if not photo_path or not os.path.exists(photo_path):
        return jsonify({'error': 'No photo found'}), 404
    
    directory = os.path.dirname(os.path.abspath(photo_path))
    filename = os.path.basename(photo_path)
    return send_from_directory(directory, filename)

@app.route('/profile_photos/<path:filename>')
@require_client_dashboard_auth
def serve_profile_photo_direct(filename):
    # Legacy filenames are always exactly "user_{id}.jpg" (see
    # upload_user_photo) — parse the id back out and enforce the same
    # org-scope check as the JSON photo endpoint above, rather than serving
    # any file in the directory to any authenticated caller regardless of
    # org.
    match = re.fullmatch(r'user_(\d+)\.jpg', filename)
    if not match:
        return jsonify({'error': 'No photo found'}), 404

    target = db.get_user_by_id(int(match.group(1)))
    if not target or not _dashboard_target_org_matches(g.dashboard_user, target.get('organization_id')):
        return jsonify({'error': 'No photo found'}), 404

    photos_dir = os.path.join(app.root_path, 'static', 'profile_photos')
    return send_from_directory(photos_dir, filename)


# ============================================
# AUTH ENDPOINTS
# ============================================

def _org_login_blocked_response(org_status):
    """Return a 403 tuple when an org's commercial state forbids login.

    Returns None when login may proceed. Callers should still count the
    attempt as a *success* for throttling purposes — the password was
    correct, and locking out a customer whose invoice is merely late would
    leave them unable to distinguish suspension from a brute-force block.
    """
    status = str(org_status or '').lower()
    if not status or support_cp_db._org_access_allows_client(status):
        return None

    messages = {
        'archived': 'This organization has been archived. Contact QIntellect Support.',
        'deleted': 'This organization no longer exists. Contact QIntellect Support.',
        'suspended': 'Access is suspended due to an unpaid invoice. Contact QIntellect Support.',
    }
    return jsonify({
        'success': False,
        'message': messages.get(status, 'This organization is not active.'),
        'code': 'ORG_ACCESS_BLOCKED',
        'organization_status': status,
    }), 403


@app.route('/api/login', methods=['POST'])
def api_login():
    data = request.get_json() or {}
    email = data.get('email', data.get('username', '')).strip()
    password = data.get('password', '').strip()
    if not email or not password:
        return jsonify({'success': False, 'message': 'Email and password required'}), 400

    # Brute-force throttle. Checked BEFORE any of the three authentication
    # backends below are consulted, so a locked-out caller costs us one dict
    # lookup rather than three credential lookups (two of them network round
    # trips to Supabase) — the throttle has to be cheaper than the attack to
    # be worth having. See login_throttle.py.
    if login_throttle.is_locked_out(email):
        return login_throttle.lockout_response(email)

    # First try the new Supabase client_users table created from Support Dashboard invites.
    try:
        client_user = support_cp_db.authenticate_client_user(email, password)
    except Exception as e:
        logger.warning(f"Client user auth lookup failed; falling back to legacy SQLite auth: {e}")
        client_user = None

    if client_user:
        # Block the login itself, not just subsequent requests. Without
        # this, an archived/suspended org's admin authenticates cleanly,
        # receives a token, and only discovers the block on their next
        # call — which logs them straight back out. Refusing here means
        # they never get a session to lose.
        blocked = _org_login_blocked_response(client_user.get('organization_status'))
        if blocked is not None:
            login_throttle.register_success(email)
            return blocked

        try:
            token = mint_dashboard_token(
                client_user,
                account_type='client_user',
                # is_admin intentionally omitted (None) — mint_dashboard_token
                # derives it from role_permissions.capabilities_for(role).
                # client_users.role is always 'admin' now (the HR co-admin
                # tier was removed — see role_permissions.py and
                # support_db_client_users.create_client_invite). Same rule,
                # same source of truth, as the client_staff branch below.
            )
        except ValueError:
            token = None
        login_throttle.register_success(email)
        return jsonify({
            'success': True,
            'user': client_user,
            'token': token,
            'dashboard_ready': bool(client_user.get('dashboard_ready')),
            'requires_onboarding': bool(client_user.get('requires_onboarding')),
            'organization_id': client_user.get('organization_id'),
            'organization_status': client_user.get('organization_status'),
            'message': 'Login successful.',
        })

    # Second tier: Supabase client_staff — branch-scoped, limited-module
    # dashboard accounts issued from Staff Management (see StaffManagement.tsx
    # buildStaffCredentials / "Dashboard: Enabled — branch-scoped limited
    # module access"). Distinct from the mobile JWT login in
    # client_staff_auth_routes.py; this uses authenticate_client_staff_for_dashboard,
    # which was already written for exactly this purpose but was never wired
    # into /api/login.
    try:
        client_staff = support_cp_db.authenticate_client_staff_for_dashboard(email, password)
    except Exception as e:
        logger.warning(f"Client staff dashboard auth lookup failed; falling back to legacy SQLite auth: {e}")
        client_staff = None

    if client_staff:
        # This branch hardcodes organization_status='active' in its
        # response (below) and never consults the real lifecycle state, so
        # compute it here rather than trusting the payload.
        staff_org_id = client_staff.get('organization_id')
        blocked = _org_login_blocked_response(
            support_cp_db._compute_org_status(str(staff_org_id))
            if staff_org_id else None
        )
        if blocked is not None:
            login_throttle.register_success(email)
            return blocked

        token = mint_dashboard_token(
            client_staff,
            account_type='client_staff',
            dashboard_scope=client_staff.get('dashboard_scope'),
            manager_id=client_staff.get('manager_id'),
            # is_admin intentionally omitted (None) — mint_dashboard_token
            # derives it from role_permissions.capabilities_for(role). A
            # plain 'staff'/'manager'/'employee' client_staff row still
            # gets is_admin=False exactly as before; a row whose account
            # role has been promoted to 'admin' (only another admin/hr can
            # do that — enforced at write time in support_db_staff.py, see
            # role_permissions.can_grant_role) now genuinely gets
            # is_admin=True, same as a Support-invited client_users admin.
            # dashboard_scope='team' remains a *separate* visibility axis
            # from account-management privilege — a team-scoped manager
            # promoted to 'admin' still gets full account-management
            # rights; team-scope alone, without role='admin', still does
            # not.
        )
        login_throttle.register_success(email)
        return jsonify({
            'success': True,
            'user': client_staff,
            'token': token,
            'dashboard_ready': bool(client_staff.get('organization_id') and client_staff.get('branch_id')),
            'requires_onboarding': False,
            'organization_id': client_staff.get('organization_id'),
            'organization_status': 'active',
            'message': 'Login successful.',
        })

    # Legacy SQLite user auth remains for old local/dev accounts and staff users.
    user = db.authenticate_user(email, password)
    if not user:
        # Only reached once all three backends (client_users, client_staff,
        # legacy SQLite) have declined — i.e. this really is a bad
        # credential, not just "wrong table".
        login_throttle.register_failure(email)
        return jsonify({'success': False, 'message': 'Invalid credentials'}), 401

    login_throttle.register_success(email)
    safe_user = _safe_user(user)
    try:
        token = mint_dashboard_token(
            safe_user,
            account_type='legacy',
            is_admin=(str(safe_user.get('role') or '').lower() == 'admin'),
        )
    except ValueError:
        # No organization yet (fresh admin signup awaiting onboarding) —
        # nothing to scope a token to. Login still succeeds; dashboard-
        # gated routes simply aren't reachable until onboarding completes,
        # same as today (they need organization_id either way).
        token = None

    return jsonify({
        'success': True,
        'user': safe_user,
        'token': token,
        'dashboard_ready': bool(safe_user.get('dashboard_ready')),
        'requires_onboarding': bool(safe_user.get('requires_onboarding')),
        'organization_id': safe_user.get('organization_id'),
        'organization_status': safe_user.get('organization_status'),
        'message': (
            'Organization setup required before dashboard access.'
            if safe_user.get('requires_onboarding')
            else 'Login successful.'
        ),
    })


@app.route('/api/client/auth/logout', methods=['POST'])
@require_client_dashboard_auth
def api_client_logout():
    """Server-side session revocation for the Client Dashboard -- makes the
    current token unusable immediately rather than leaving it valid until
    natural expiry (up to 12h). Mirrors /v1/support/auth/logout
    (support_routes.py) and /api/staff/logout (client_staff_auth_routes.py)
    -- all three now share the same session_registry.py mechanism, so this
    was the one auth surface still missing a real logout route. See
    session_registry.py.

    account_type/id come from g.dashboard_user (verified token), never from
    the request body -- a caller can only ever end their OWN session here.
    """
    logout_dashboard_user(g.dashboard_user['account_type'], g.dashboard_user['id'])
    return jsonify({'success': True})


@app.route('/api/change-password', methods=['POST'])
@require_client_dashboard_auth
def api_change_password():
    data = request.get_json() or {}
    user_id = data.get('user_id')
    new_pass = data.get('new_password', '')
    if not user_id or not new_pass:
        return jsonify({'success': False}), 400

    # Self-service only — a caller may change their OWN password, full
    # stop. No admin override: there is no "reset another user's password"
    # flow in the UI today (changePassword() in api.ts has no caller), so
    # we don't build one implicitly here. If that becomes a real product
    # need, it should be its own reviewed endpoint/flow, not a side effect
    # of loosening this check.
    if str(g.dashboard_user.get('id')) != str(user_id):
        return jsonify({'success': False, 'error': 'You can only change your own password.'}), 403

    target_user = db.get_user_by_id(int(user_id))
    if not target_user:
        return jsonify({'success': False, 'error': 'User not found.'}), 404

    db.change_password(int(user_id), new_pass)

    # Legacy account_type='legacy' sessions are covered by the same
    # session_registry mechanism as the two Supabase-backed account types
    # (see mint_dashboard_token's _VALID_ACCOUNT_TYPES). Currently dead code
    # from the frontend (no live caller of api.ts's changePassword — see
    # api_change_own_dashboard_password above for the endpoint actually in
    # use), kept alive server-side for defense-in-depth and given the same
    # fresh-token treatment for consistency, not as a workaround. org_id/
    # is_admin come from g.dashboard_user (already-verified current token),
    # not target_user, since a legacy SQLite row's shape isn't guaranteed
    # to carry the same keys mint_dashboard_token expects.
    fresh_token = mint_dashboard_token(
        {'id': target_user['id'], 'org_id': g.dashboard_user.get('org_id')},
        account_type='legacy',
        is_admin=g.dashboard_user.get('is_admin', False),
        session_reason='password_changed',
    )
    return jsonify({'success': True, 'token': fresh_token})


# ============================================
# CLIENT DASHBOARD BOOTSTRAP
# ============================================
@app.route('/api/client/bootstrap', methods=['GET'])
@require_client_dashboard_auth
def api_client_bootstrap():
    """
    Return support-created organization setup for the Client Dashboard.

    This is the bridge from Support Dashboard commercial setup to the existing
    client dashboard OrgConfig shape. Branch UUIDs are preserved in each branch
    as backend_branch_id/backendBranchId while the current React branch UI keeps
    numeric internal ids.

    Was completely unauthenticated — any caller could enumerate org UUIDs
    and read branches/modules/billing status/onboarding config for any
    tenant. apiClient.ts's fetchJson() already sent the dashboard Bearer
    token on this call and its own comment assumed server-side scoping was
    enforced from it — the decorator was simply never added. org_id is
    still read from the query string (this fires right after login,
    before other org context is necessarily hydrated client-side) but is
    now checked against the token's own org rather than trusted outright.
    """
    org_id = (
        request.args.get('organization_id')
        or request.args.get('org_id')
        or request.args.get('organizationId')
    )

    if not org_id:
        return jsonify({
            'success': False,
            'message': 'organization_id is required.',
        }), 400

    if not _dashboard_target_org_matches(g.dashboard_user, org_id):
        return jsonify({'success': False, 'message': 'Not found.'}), 404

    try:
        bootstrap = support_cp_db.get_client_bootstrap(str(org_id))
        return jsonify({
            'success': True,
            **bootstrap,
        }), 200
    except ValueError as e:
        return jsonify({'success': False, 'message': str(e)}), 404
    except Exception as e:
        logger.exception(f"Client bootstrap failed for organization_id={org_id}")
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/client/session/<user_id>', methods=['GET'])
@require_client_dashboard_auth
def api_client_session(user_id):
    """
    Return current Supabase client user session flags after onboarding changes.

    This endpoint exists because invited client users live in Supabase
    public.client_users, not in the legacy SQLite users table used by
    /api/users/<id>.

    Was completely unauthenticated — any caller could enumerate UUIDs and
    read organization_id/dashboard_ready/requires_onboarding/
    organization_status for any account. Fixed with the same self-only
    check used elsewhere for session/profile routes: the token's own id
    (set at login for both client_users and client_staff rows — see
    mint_dashboard_token) must match the requested user_id. This is a
    session-refresh endpoint for the caller's own session, not a general
    lookup, so there's no legitimate cross-user case to preserve.

    Requires AuthContext.tsx's refreshUser() to send the Bearer token
    (fixed alongside this change) — it previously called this route with
    no Authorization header at all.
    """
    if str(g.dashboard_user.get('id')) != str(user_id):
        return jsonify({'success': False, 'message': 'Forbidden'}), 403

    try:
        user = support_cp_db.get_client_user_session_by_id(str(user_id))
        return jsonify({
            'success': True,
            'user': user,
            'dashboard_ready': bool(user.get('dashboard_ready')),
            'requires_onboarding': bool(user.get('requires_onboarding')),
            'organization_id': user.get('organization_id'),
            'organization_status': user.get('organization_status'),
        }), 200
    except ValueError:
        pass  # not a client_users row — fall through to client_staff below
    except Exception as e:
        logger.exception(f"Client user session refresh failed for user_id={user_id}")
        return jsonify({'success': False, 'message': str(e)}), 500

    # client_staff ids are UUIDs too, so AuthContext.refreshUser() routes them
    # here via the same isUuidLike check — without this fallback, every
    # Staff-Management-issued dashboard login gets logged back out on its
    # first refresh/mount after a successful /api/login.
    try:
        staff = support_cp_db.get_client_staff_member(str(user_id))
        return jsonify({
            'success': True,
            'user': staff,
            'dashboard_ready': bool(staff.get('organization_id') and staff.get('branch_id')),
            'requires_onboarding': False,
            'organization_id': staff.get('organization_id'),
            'organization_status': 'active',
        }), 200
    except ValueError as e:
        return jsonify({'success': False, 'message': str(e)}), 404
    except Exception as e:
        logger.exception(f"Client staff session refresh failed for user_id={user_id}")
        return jsonify({'success': False, 'message': str(e)}), 500



def _client_user_id_from_request(payload: dict | None = None) -> str:
    payload = payload or {}
    return str(
        payload.get('user_id')
        or payload.get('client_user_id')
        or request.headers.get('X-Client-User-Id')
        or request.headers.get('X-User-Id')
        or ''
    ).strip()


@app.route('/api/client/branches/<branch_id>/node-installer', methods=['POST'])
@require_client_dashboard_auth
def api_client_branch_node_installer(branch_id):
    """Generate a client-facing branch-scoped Windows EXE node installer."""
    data = request.get_json(silent=True) or {}
    # user_id always comes from the verified token now, never the request
    # body/header — create_client_branch_install_token re-derives role/org
    # from this id and raises if it isn't an admin, so a caller-supplied id
    # here was a straightforward impersonation path (generate an installer,
    # which embeds a real node-activation token, as any admin whose UUID
    # you happened to know).
    user_id = str(g.dashboard_user.get('id') or '')
    if not user_id:
        return jsonify({
            'success': False,
            'message': 'client user session is required.',
            'error': 'client user session is required.',
        }), 401

    try:
        ttl_days = int(data.get('ttl_days') or 7)
    except (TypeError, ValueError):
        ttl_days = 7

    package_type = str(data.get('package_type') or data.get('installer_type') or 'exe').strip().lower()
    if package_type not in {'exe', 'zip'}:
        return jsonify({'success': False, 'message': 'package_type must be exe or zip'}), 400

    try:
        token = support_cp_db.create_client_branch_install_token(
            user_id=user_id,
            branch_id=str(branch_id),
            ttl_days=ttl_days,
            node_label=data.get('node_label'),
        )
        api_base_url = str(
            data.get('api_base_url')
            or data.get('railway_api_base_url')
            or request.host_url.rstrip('/')
        ).strip().rstrip('/')
        use_public_ip = bool(data.get('use_public_ip', False))

        # token carries branch_name (set in create_branch_install_token);
        # pass that, NOT the token dict — see installer_packager.installer_filename.
        branch_label = token.get('branch_name') if isinstance(token, dict) else None

        if package_type == 'exe':
            package = build_node_installer_exe(
                project_root=Path(__file__).resolve().parent,
                install_token_payload=token,
                api_base_url=api_base_url,
                node_label=data.get('node_label'),
                use_public_ip=use_public_ip,
            )
            return send_file(
                package,
                mimetype='application/vnd.microsoft.portable-executable',
                as_attachment=True,
                download_name=node_exe_installer_filename(branch_label),
            )

        package = build_node_installer_zip(
            project_root=Path(__file__).resolve().parent,
            install_token_payload=token,
            api_base_url=api_base_url,
            node_label=data.get('node_label'),
            use_public_ip=use_public_ip,
        )
        return send_file(
            package,
            mimetype='application/zip',
            as_attachment=True,
            download_name=node_installer_filename(branch_label),
        )
    except ValueError as e:
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 400
    except RuntimeError as e:
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 500
    except Exception as e:
        logger.exception('Client node installer generation failed')
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 500


@app.route('/api/client/profile', methods=['PATCH', 'PUT', 'POST'])
@require_client_dashboard_auth
def api_update_client_profile():
    """
    Update profile/password for Support-Dashboard-invited client users.

    This is UUID-safe and writes to Supabase public.client_users. Legacy
    SQLite users continue to use /api/users/<int:user_id>/profile.
    """
    data = request.get_json(silent=True) or {}
    user_id = data.get('user_id') or data.get('id')

    if not user_id:
        return jsonify({'success': False, 'message': 'user_id is required.'}), 400

    # Self-only — same policy as the legacy /api/users/<id>/profile route:
    # this is "my own profile settings," not an admin-edits-anyone endpoint.
    if str(g.dashboard_user.get('id')) != str(user_id):
        return jsonify({'success': False, 'message': 'You can only update your own profile.'}), 403

    try:
        user = support_cp_db.update_client_user_profile(
            user_id=str(user_id),
            payload=data,
        )
        return jsonify({
            'success': True,
            'message': 'Profile settings saved successfully.',
            'user': user,
            'dashboard_ready': bool(user.get('dashboard_ready')),
            'requires_onboarding': bool(user.get('requires_onboarding')),
            'organization_id': user.get('organization_id'),
            'organization_status': user.get('organization_status'),
        }), 200
    except ValueError as e:
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 400
    except Exception as e:
        logger.exception(f"Client profile update failed for user_id={user_id}")
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 500


@app.route('/api/client/account/password', methods=['PATCH'])
@require_client_dashboard_auth
def api_change_own_dashboard_password():
    """
    Self-service "change my own password" for any Client Dashboard session
    — client_users (admin/HR) or client_staff (manager/staff) — the
    counterpart to /api/client/profile above.

    Identity is read entirely from g.dashboard_user (the decoded JWT set by
    @require_client_dashboard_auth), never from the request body, so unlike
    a generic profile edit there is no user-id-spoofing surface to guard
    here at all. See support_db_client_users.change_own_dashboard_password's
    docstring for the account_type dispatch.
    """
    data = request.get_json(silent=True) or {}
    new_password = str(data.get('new_password') or '').strip()

    if not new_password:
        return jsonify({'success': False, 'message': 'New password is required.'}), 400

    try:
        support_cp_db.change_own_dashboard_password(
            account_type=g.dashboard_user.get('account_type'),
            user_id=g.dashboard_user.get('id'),
            new_password=new_password,
        )
        # Mint a fresh token carrying a fresh session_id so the CALLER's own
        # dashboard doesn't immediately 401 itself out -- change_own_dashboard_password
        # already updated the row; rotate_session (called inside
        # mint_dashboard_token) supersedes whatever session_id was current,
        # which would otherwise include the token this very request came in
        # on. Claims are reused verbatim from g.dashboard_user (the
        # already-verified current token) rather than re-derived, since a
        # password change never changes role/org/scope -- only session_reason
        # differs, so this row's audit trail correctly reads 'password_changed'
        # rather than 'login'.
        fresh_token = mint_dashboard_token(
            {
                'id': g.dashboard_user.get('id'),
                'org_id': g.dashboard_user.get('org_id'),
                'branch_id': g.dashboard_user.get('branch_id'),
            },
            account_type=g.dashboard_user.get('account_type'),
            access_modules=g.dashboard_user.get('access_modules') or [],
            dashboard_scope=g.dashboard_user.get('dashboard_scope'),
            manager_id=g.dashboard_user.get('manager_id'),
            is_admin=g.dashboard_user.get('is_admin', False),
            session_reason='password_changed',
        )
        return jsonify({
            'success': True,
            'message': 'Password updated successfully.',
            'token': fresh_token,
        }), 200
    except ValueError as e:
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 400
    except Exception as e:
        logger.exception(
            f"Password change failed for dashboard_user id={g.dashboard_user.get('id')}"
        )
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 500


@app.route('/api/client/profile/photo', methods=['POST'])
@require_client_dashboard_auth
def api_upload_client_profile_photo():
    """
    Upload profile photo for a Supabase client_users UUID account.
    Stores the file on the Flask server and persists the public URL in Supabase.
    """
    user_id = request.form.get('user_id') or request.form.get('id')
    if not user_id:
        return jsonify({'success': False, 'message': 'user_id is required.'}), 400

    # Self-only, same policy as /api/client/profile.
    if str(g.dashboard_user.get('id')) != str(user_id):
        return jsonify({'success': False, 'message': 'You can only update your own photo.'}), 403

    if 'photo' not in request.files:
        return jsonify({'success': False, 'message': 'No photo provided.'}), 400

    photo = request.files['photo']
    if photo.filename == '':
        return jsonify({'success': False, 'message': 'No file selected.'}), 400

    ext = photo.filename.rsplit('.', 1)[-1].lower() if '.' in photo.filename else ''
    if ext not in {'jpg', 'jpeg', 'png', 'webp'}:
        return jsonify({'success': False, 'message': 'Only jpg, jpeg, png, or webp are allowed.'}), 400

    # Per-route size cap. MAX_CONTENT_LENGTH is the global backstop sized
    # for the embeddings import package; a profile photo needs far less.
    MAX_PHOTO_BYTES = 5 * 1024 * 1024
    photo.stream.seek(0, os.SEEK_END)
    size = photo.stream.tell()
    photo.stream.seek(0)
    if size > MAX_PHOTO_BYTES:
        return jsonify({'success': False, 'message': 'Photo too large. Max size: 5MB.'}), 413

    try:
        photos_dir = Path('static/client_profile_photos')
        photos_dir.mkdir(parents=True, exist_ok=True)

        safe_ext = 'jpg' if ext == 'jpeg' else ext
        filename = secure_filename(f"client_{str(user_id).replace('-', '_')}.{safe_ext}")
        filepath = photos_dir / filename
        photo.save(filepath)

        photo_url = f'/client_profile_photos/{filename}'
        user = support_cp_db.update_client_user_profile(
            user_id=str(user_id),
            payload={
                'profile_image_url': photo_url,
                'profile_image_name': filename,
            },
        )

        return jsonify({
            'success': True,
            'photo_url': photo_url,
            'profile_image_url': photo_url,
            'profileImageUrl': photo_url,
            'profile_image_name': filename,
            'profileImageName': filename,
            'user': user,
        }), 200

    except ValueError as e:
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 400
    except Exception as e:
        logger.exception(f"Client profile photo upload failed for user_id={user_id}")
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 500


@app.route('/client_profile_photos/<path:filename>')
@require_client_dashboard_auth
def serve_client_profile_photo(filename):
    # Filenames are always "client_{uuid-with-underscores}.{ext}" (see
    # api_upload_client_profile_photo — UUIDs never contain underscores
    # themselves, so this is unambiguously reversible). Parse the owning
    # user id back out and enforce the same self-only policy as the rest
    # of the client_users profile routes.
    match = re.fullmatch(r'client_([0-9a-f_]{36})\.(jpg|jpeg|png|webp)', filename, re.IGNORECASE)
    if not match:
        return jsonify({'error': 'No photo found'}), 404

    owner_id = match.group(1).replace('_', '-')
    if str(g.dashboard_user.get('id')) != owner_id:
        return jsonify({'error': 'No photo found'}), 404

    photos_dir = os.path.join(app.root_path, 'static', 'client_profile_photos')
    return send_from_directory(photos_dir, filename)



@app.route('/api/client/onboarding/complete', methods=['POST'])
@require_client_dashboard_auth
def api_client_onboarding_complete():
    """
    Complete onboarding for a Support-Dashboard-invited client user.

    Important: this endpoint does not create organizations, branches, or module
    entitlements. Those are owned by QIntellect Support Dashboard. It only saves
    operational configuration: departments, roles, shifts, cameras, NVR/DVR IP,
    public IP, and related dashboard setup.

    Was completely unauthenticated, with both user_id and organization_id
    trusted straight from the body -- anyone could rewrite any org's
    camera/network/department config by guessing ids. Not in the original
    report; found during this sweep. Fixed self-only (the invited user
    completes their own onboarding, same as change-password) with
    organization_id forced from the verified token.
    """
    data = request.get_json(silent=True) or {}
    user_id = data.get('user_id') or data.get('client_user_id')
    config = data.get('config') or data.get('cfg')

    if not user_id:
        return jsonify({'success': False, 'message': 'user_id is required.'}), 400

    if str(g.dashboard_user.get('id')) != str(user_id):
        return jsonify({'success': False, 'message': 'Forbidden'}), 403

    org_id = str(g.dashboard_user.get('org_id') or '').strip()
    if not org_id:
        return jsonify({'success': False, 'message': 'organization_id is required.'}), 400

    if not isinstance(config, dict):
        return jsonify({'success': False, 'message': 'config must be an object.'}), 400

    try:
        result = support_cp_db.save_client_onboarding_config(
            user_id=str(user_id),
            org_id=str(org_id),
            config=config,
        )
        return jsonify({
            'success': True,
            'message': 'Onboarding completed successfully.',
            **result,
        }), 200
    except ValueError as e:
        return jsonify({'success': False, 'message': str(e)}), 400
    except Exception as e:
        logger.exception(
            f"Client onboarding completion failed for user_id={user_id}, org_id={org_id}"
        )
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/org/retention-policy', methods=['GET'])
@require_client_dashboard_auth
def api_get_retention_policy():
    """org_id is pinned to the authenticated dashboard session, never the
    query string. Previously unauthenticated and org-id-off-the-URL, so any
    caller could read any tenant's data-wipe schedule. Read stays on plain
    auth (the Settings screen shows the current value to any dashboard
    user); the PUT below is admin-only -- see its docstring."""
    raw_organization_id = str(g.dashboard_user.get('org_id') or '').strip()

    if not raw_organization_id:
        return jsonify({'error': 'organization_id is required'}), 400

    # organizations.id is uuid NOT NULL in Supabase — the legacy-SQLite
    # fallback this used to fall through to for a non-UUID org_id is
    # unreachable by any real tenant.
    if _positive_int(raw_organization_id):
        return jsonify({'error': 'organization_id must be a valid UUID'}), 400

    try:
        return jsonify(
            support_cp_db.get_employee_retention_policy(raw_organization_id)
        ), 200
    except ValueError as e:
        return jsonify({'error': str(e), 'message': str(e)}), 404
    except Exception as e:
        logger.exception('Failed to load employee retention policy')
        return jsonify({'error': str(e), 'message': str(e)}), 500


@app.route('/api/org/retention-policy', methods=['PUT'])
@require_client_dashboard_admin
def api_update_retention_policy():
    """org_id is pinned to the authenticated dashboard session, never the
    body. Admin rather than plain auth: this sets how long employee HR
    records survive before automated deletion, so a wrong value here
    destroys data org-wide -- same blast radius as the delete/purge routes
    that already wear this decorator. updated_by is likewise taken from the
    session, not the payload: it is an audit field, and a caller-supplied
    one can be forged to point at someone else."""
    data = request.get_json(silent=True) or {}
    raw_organization_id = str(g.dashboard_user.get('org_id') or '').strip()
    employee_retention_years = data.get('employee_retention_years')
    updated_by = g.dashboard_user.get('id')

    if not raw_organization_id:
        return jsonify({'error': 'organization_id is required'}), 400

    if employee_retention_years is None:
        return jsonify({'error': 'employee_retention_years is required'}), 400

    # organizations.id is uuid NOT NULL in Supabase — the legacy-SQLite
    # fallback this used to fall through to for a non-UUID org_id is
    # unreachable by any real tenant.
    if _positive_int(raw_organization_id):
        return jsonify({'error': 'organization_id must be a valid UUID'}), 400

    try:
        policy = support_cp_db.update_employee_retention_policy(
            org_id=raw_organization_id,
            employee_retention_years=int(employee_retention_years),
            updated_by=str(updated_by) if updated_by else None,
        )

        if not policy:
            return jsonify({'error': 'Organization not found or policy update failed'}), 404

        return jsonify({
            'success': True,
            'message': f"Employee HR retention policy saved for {policy['employee_retention_years']} years.",
            'policy': policy,
        }), 200
    except ValueError as e:
        return jsonify({'error': str(e), 'message': str(e)}), 400
    except Exception as e:
        logger.exception('Failed to update employee retention policy')
        return jsonify({'error': str(e), 'message': str(e)}), 500


# ============================================
# STAFF / USER ENDPOINTS
# ============================================

def _safe_user(u):
    """Return a frontend-safe user with dashboard access aliases.

    The database stores canonical snake_case columns. React route guards and
    older localStorage records also expect camelCase aliases. Keep the aliasing
    here so login, refreshUser, /api/staff, and restore all return the same
    contract.
    """
    if not u:
        return {}

    safe = {k: v for k, v in u.items() if k != 'password'}

    def _array(value):
        if value is None:
            return []
        if isinstance(value, list):
            return [str(item).strip() for item in value if str(item).strip()]
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
                if isinstance(parsed, list):
                    return [str(item).strip() for item in parsed if str(item).strip()]
            except Exception:
                return [item.strip() for item in value.split(',') if item.strip()]
        return []

    access_modules = _array(
        safe.get('access_modules')
        or safe.get('allowedModules')
        or safe.get('moduleAccess')
        or safe.get('accessModules')
    )
    benefits = _array(safe.get('benefits'))

    user_id = safe.get('id')
    profile_image_url = (
        safe.get('profile_image_url')
        or safe.get('profileImageUrl')
        or safe.get('avatarUrl')
        or safe.get('photo_url')
        or ''
    )

    if not profile_image_url and safe.get('photo_path') and user_id:
        profile_image_url = f'/api/users/{user_id}/photo'

    profile_image_name = safe.get('profile_image_name') or safe.get('profileImageName') or ''

    safe['profile_image_url'] = profile_image_url
    safe['profileImageUrl'] = profile_image_url
    safe['avatarUrl'] = profile_image_url
    safe['photo_url'] = profile_image_url
    safe['profile_image_name'] = profile_image_name
    safe['profileImageName'] = profile_image_name

    safe['access_modules'] = access_modules
    safe['allowedModules'] = access_modules
    safe['moduleAccess'] = access_modules
    safe['accessModules'] = access_modules
    safe['benefits'] = benefits

    organization_id = safe.get('organization_id')
    branch_id = safe.get('branch_id')

    safe['organizationId'] = organization_id
    safe['branchId'] = branch_id
    safe['branchName'] = safe.get('branch_name') or ''

    if branch_id is not None:
        safe['allowedBranchIds'] = [branch_id]
    else:
        safe['allowedBranchIds'] = []

    role = str(safe.get('role') or '').lower()

    if role == 'staff':
        safe['dashboardScope'] = 'branch'
        safe['portalAccess'] = {
            'desktopDashboard': True,
            'flutterStaffPortal': True,
        }

    if role == 'admin':
        safe['dashboardScope'] = 'global'
        safe['portalAccess'] = {
            'desktopDashboard': True,
            'flutterStaffPortal': False,
        }

    # Backend-owned dashboard readiness. This is intentionally computed here
    # so login, refreshUser, staff records, and restored users all return the
    # same authorization contract.
    try:
        if user_id and hasattr(db, 'get_user_dashboard_state'):
            dashboard_state = db.get_user_dashboard_state(int(user_id))
            safe.update(dashboard_state)

            if dashboard_state.get('organization_id'):
                safe['organization_id'] = dashboard_state.get('organization_id')
                safe['organizationId'] = dashboard_state.get('organization_id')
    except Exception as dashboard_error:
        logger.warning(f"Could not attach dashboard state to user {user_id}: {dashboard_error}")

    return safe


def _positive_int(value):
    try:
        parsed = int(value)
        return parsed if parsed > 0 else None
    except (TypeError, ValueError):
        return None


def _resolve_organization_id(data=None, user_id=None):
    """
    Resolve organization safely.

    Priority:
    1. Explicit organization_id from request
    2. Organization linked to the admin/current user
    3. None

    This prevents staff rows from being created with organization_id = NULL
    when the frontend localStorage user is stale after login/onboarding.
    """
    data = data or {}

    explicit_org_id = _positive_int(data.get('organization_id'))
    if explicit_org_id:
        return explicit_org_id

    owner_user_id = (
        _positive_int(user_id)
        or _positive_int(data.get('created_by_user_id'))
        or _positive_int(data.get('admin_user_id'))
        or _positive_int(data.get('user_id'))
    )

    if not owner_user_id:
        return None

    try:
        org = db.get_organization_for_user(owner_user_id)
        if org and org.get('id'):
            return int(org['id'])
    except Exception as e:
        logger.warning(f"Could not resolve organization for user {owner_user_id}: {e}")

    return None




def _notification_int(value):
    try:
        parsed = int(value)
        return parsed if parsed > 0 else None
    except (TypeError, ValueError):
        return None


def _branch_module_route(branch_id, module_key, highlight_id=None):
    base = f"/admin/branch/{int(branch_id)}/{module_key}" if branch_id else f"/admin/{module_key}"
    if highlight_id is None:
        return base
    return f"{base}?highlight={highlight_id}"


def _create_dashboard_notification_safely(**kwargs):
    """Best-effort notification creation.

    Business actions must never fail only because notification delivery failed.
    The notification system is durable and backend-owned, but it remains a
    side effect of staff/leave/overtime mutations.
    """
    try:
        if hasattr(db, 'create_notification'):
            return db.create_notification(**kwargs)
    except Exception as e:
        logger.warning(f"Notification creation failed but main action succeeded: {e}")
    return None

@app.route('/api/staff/archived', methods=['GET'])
@require_client_dashboard_auth
def api_get_archived_staff():
    """org_id is pinned to the authenticated dashboard session, never the
    query string -- previously this route trusted organization_id straight
    off the query string with no auth at all, letting any caller enumerate
    another tenant's former employees. Fixed to match api_get_staff's
    pattern exactly (read org from token, branch_id stays a display-only
    filter, team scope enforced on both the Supabase and legacy branches)."""
    dashboard_user = g.dashboard_user
    raw_org_id = str(dashboard_user.get('org_id') or '').strip()
    raw_branch_id = request.args.get('branch_id')
    if not dashboard_user.get('is_admin'):
        raw_branch_id = dashboard_user.get('branch_id') or raw_branch_id
    people_type = (
        request.args.get('people_type')
        or request.args.get('peopleType')
    )

    if not raw_org_id:
        return jsonify({
            'success': False,
            'error': 'organization_id is required for the archived staff directory.',
        }), 400

    numeric_org_id = _positive_int(raw_org_id)
    scope_ids = get_team_scope_ids(dashboard_user)

    if raw_org_id and not numeric_org_id:
        archived = support_cp_db.list_client_staff(
            org_id=raw_org_id,
            branch_id=raw_branch_id,
            role='staff',
            archived=True,
            people_type=people_type,
        )
        archived = filter_rows_by_scope(archived, scope_ids, 'id', 'staff_id')
        return jsonify(archived), 200

    branch_id = _positive_int(raw_branch_id)
    archived_users = db.get_archived_users(
        organization_id=numeric_org_id,
        branch_id=branch_id,
    )
    safe_archived = [_safe_user(user) for user in archived_users]
    # Legacy numeric orgs never mint a 'client_staff' scoped token, so
    # scope_ids is always None here — kept only so this branch can't
    # silently diverge from the UUID branch above, same rationale as
    # api_get_staff.
    safe_archived = filter_rows_by_scope(safe_archived, scope_ids, 'id', 'user_id')

    return jsonify(safe_archived), 200


@app.route('/api/staff/archived/<int:user_id>', methods=['DELETE', 'POST'])
@app.route('/api/staff/archived/<int:user_id>/delete', methods=['POST', 'DELETE'])
@require_client_dashboard_admin
def api_delete_archived_staff_member(user_id):
    """Permanently delete one archived employee from the database.

    This is intentionally separate from normal staff DELETE, which archives.
    Only already-archived employees can be purged here.
    """
    try:
        data = request.get_json(silent=True) or {}
        # organization_id always comes from the verified admin token — never
        # the request body. hard_delete_archived_user refuses the purge if
        # the target doesn't actually belong to that org.
        organization_id = _positive_int(g.dashboard_user.get('org_id'))
        deleted_by = _positive_int(data.get('deleted_by'))

        deleted = db.hard_delete_archived_user(
            user_id=int(user_id),
            organization_id=organization_id,
            deleted_by=deleted_by,
        )

        if not deleted:
            return jsonify({
                'success': False,
                'error': 'Archived employee not found or cannot be permanently deleted.',
            }), 404

        with cache_lock:
            EMBEDDING_CACHE.pop(int(user_id), None)

        return jsonify({
            'success': True,
            'message': 'Archived employee permanently deleted from the database.',
            'deleted_user_id': int(user_id),
            'delete': deleted,
        }), 200

    except Exception as e:
        logger.exception(f"Failed to permanently delete archived staff member {user_id}")
        return jsonify({
            'success': False,
            'error': str(e),
        }), 500


@app.route('/api/staff/archived/bulk-delete', methods=['POST'])
@require_client_dashboard_admin
def api_bulk_delete_archived_staff():
    """Permanently delete selected archived employees from the database."""
    try:
        data = request.get_json(silent=True) or {}
        raw_ids = data.get('user_ids') or []

        if not isinstance(raw_ids, list) or len(raw_ids) == 0:
            return jsonify({
                'success': False,
                'error': 'user_ids must be a non-empty list.',
            }), 400

        user_ids = [str(raw_id).strip() for raw_id in raw_ids if str(raw_id).strip()]

        if not user_ids:
            return jsonify({
                'success': False,
                'error': 'No valid archived employee IDs were provided.',
            }), 400

        # organization_id is always taken from the verified admin token, not
        # the request body, for both branches below — a token minted for one
        # org can never be used to purge another org's archive by supplying
        # a different organization_id in the payload.
        token_org_id = g.dashboard_user.get('org_id')

        raw_org_id = str(data.get('organization_id') or '').strip()
        if raw_org_id and not _positive_int(raw_org_id):
            deleted = []
            skipped = []
            for uid in user_ids:
                try:
                    # delete_client_staff has no org parameter of its own —
                    # verify per-item ownership before purging, same as the
                    # single-item Supabase delete route.
                    current = support_cp_db.get_client_staff_member(uid)
                    if not _dashboard_target_org_matches(g.dashboard_user, current.get('organization_id')):
                        skipped.append(uid)
                        continue
                    support_cp_db.delete_client_staff(uid)
                    deleted.append(uid)
                except Exception:
                    skipped.append(uid)
            result = {
                'deleted_count': len(deleted),
                'deleted_user_ids': deleted,
                'skipped_user_ids': skipped,
            }
            return jsonify({
                'success': True,
                'message': f"Permanently deleted {len(deleted)} archived employees.",
                **result,
            }), 200

        numeric_user_ids = [int(uid) for uid in user_ids if _positive_int(uid)]
        organization_id = _positive_int(token_org_id)
        deleted_by = _positive_int(data.get('deleted_by'))

        result = db.hard_delete_archived_users(
            user_ids=numeric_user_ids,
            organization_id=organization_id,
            deleted_by=deleted_by,
        )

        with cache_lock:
            for uid in result.get('deleted_user_ids', []):
                EMBEDDING_CACHE.pop(int(uid), None)

        return jsonify({
            'success': True,
            'message': f"Permanently deleted {result.get('deleted_count', 0)} archived employees.",
            **result,
        }), 200

    except Exception as e:
        logger.exception('Failed to bulk permanently delete archived staff')
        return jsonify({
            'success': False,
            'error': str(e),
        }), 500


@app.route('/api/staff', methods=['GET'])
@require_client_dashboard_auth
def api_get_staff():
    dashboard_user = g.dashboard_user
    role = request.args.get('role')
    people_type = (
        request.args.get('people_type')
        or request.args.get('peopleType')
    )
    # org_id is now read from the verified dashboard token, never from the
    # query string — see require_client_dashboard_auth's contract. A stray
    # ?organization_id=<other-org> can no longer widen what this request
    # sees. branch_id is still accepted from the query as a *display*
    # filter (e.g. an org-wide admin narrowing to one branch) — it cannot
    # be used to escape team-scope, which is enforced below regardless.
    #
    # A token still carries the caller's own home branch even for admins
    # (client_staff.branch_id), but that must not lock a full-access admin
    # to one branch's staff directory. Only a genuinely branch-scoped
    # (non-admin) account stays pinned to its token branch_id and can't
    # widen it via the query string; an admin sees every branch by default
    # and may narrow to one voluntarily via ?branch_id=.
    raw_org_id = str(dashboard_user.get('org_id') or '').strip()
    raw_branch_id = request.args.get('branch_id')
    if not dashboard_user.get('is_admin'):
        raw_branch_id = dashboard_user.get('branch_id') or raw_branch_id
    user_id = request.args.get('user_id')

    if not raw_org_id:
        return jsonify({
            'success': False,
            'message': 'organization_id is required for staff directory.',
            'error': 'organization_id is required for staff directory.',
            'users': [],
        }), 400

    numeric_org_id = _positive_int(raw_org_id)
    scope_ids = get_team_scope_ids(dashboard_user)

    # Support-created client organizations use Supabase UUIDs.
    if raw_org_id and not numeric_org_id:
        users = support_cp_db.list_client_staff(
            org_id=raw_org_id,
            branch_id=raw_branch_id,
            role=role or 'staff',
            archived=False,
            people_type=people_type,
        )
        users = filter_rows_by_scope(users, scope_ids, 'id', 'staff_id')
        return jsonify(users), 200

    branch_id = _positive_int(raw_branch_id)
    numeric_user_id = _positive_int(user_id)
    organization_id = _resolve_organization_id(
        {'organization_id': raw_org_id},
        user_id=numeric_user_id,
    )

    if not organization_id:
        return jsonify({
            'success': False,
            'message': 'Valid organization_id is required for staff directory.',
            'error': 'Valid organization_id is required for staff directory.',
            'users': [],
        }), 400

    users = db.get_all_users(
        role=role,
        organization_id=organization_id,
        branch_id=branch_id,
    )
    safe_users = [_safe_user(u) for u in users]
    # Legacy numeric orgs never mint a 'client_staff' scoped token
    # (account_type is always 'legacy' for this path), so scope_ids is
    # always None here — filter call kept only so this branch can't
    # silently diverge from the UUID branch above if that ever changes.
    safe_users = filter_rows_by_scope(safe_users, scope_ids, 'id', 'user_id')

    return jsonify(safe_users), 200


@app.route('/api/staff', methods=['POST'])
@require_client_dashboard_auth
def api_add_staff():
    """
    Create a staff member.

    SECURITY: previously trusted organization_id/org_id straight off the
    request body with no auth at all — any caller could create a staff row
    in any organization. org_id is now pinned to the verified Client
    Dashboard token; a body value is accepted only as a match-check, never
    as the source of truth (same contract as api_set_staff_dashboard_scope
    above). branch_id is pinned the same way whenever the token itself is
    branch-locked.

    PERMISSION: creating staff is an HR/admin action, not a "view my
    reports" action — a 'team'-scoped client_staff caller (a manager) is
    rejected here even though their token is otherwise valid. This is a
    different axis from dashboard_scope's team/branch row-visibility
    contract (see client_dashboard_auth.py's docstring on payroll routes
    for the same "different axis" reasoning) and is deliberately enforced
    here rather than folded into get_team_scope_ids, which answers "what
    can this caller see," not "what can this caller do."
    """
    dashboard_user = g.dashboard_user
    if (
        dashboard_user.get('account_type') == 'client_staff'
        and dashboard_user.get('dashboard_scope') == 'team'
    ):
        message = "Creating staff requires branch-level dashboard access or an admin account."
        return jsonify({'success': False, 'error': message, 'message': message}), 403

    data = request.get_json() or {}

    raw_password = str(data.get('password') or '').strip()
    if raw_password:
        if len(raw_password) < 6:
            message = 'Password must be at least 6 characters.'
            return jsonify({'success': False, 'error': message, 'message': message}), 400
        password = raw_password
    else:
        # No password supplied: generate a strong random one instead of
        # falling back to a known, hardcoded default (was '123456' — any
        # staff row created without an explicit password got a guessable
        # credential on a real dashboard login; the login throttle does not
        # help when the password is known in advance). Reuses the same
        # generator the client_users admin-invite flow already uses
        # (support_db_client_users._generate_temp_password), so there is
        # exactly one password-generation implementation in the codebase.
        # Already re-exported on support_cp_db (see support_db.py's import
        # block), so no new import is needed here. Returned once in the
        # 'credentials' block below for the admin to hand to the new staff
        # member, same contract as today.
        password = support_cp_db._generate_temp_password()

    token_org_id = str(dashboard_user.get('org_id') or '').strip()
    body_org_id = str(
        data.get('organization_id')
        or data.get('organizationId')
        or data.get('org_id')
        or ''
    ).strip()
    if body_org_id and body_org_id != token_org_id:
        message = 'organization_id does not match the authenticated session.'
        return jsonify({'success': False, 'error': message, 'message': message}), 400

    # Branch-locked tokens (dashboard_scope='branch' minted with a
    # branch_id) can only create staff in their own branch — a body value
    # is silently overridden rather than checked, since the legacy numeric
    # path defaults branch_id to '' and would otherwise fail this check on
    # every legitimate branch-admin request.
    token_branch_id = dashboard_user.get('branch_id')
    if token_branch_id:
        data = {**data, 'branch_id': token_branch_id}

    raw_org_id = token_org_id
    numeric_org_id = _positive_int(raw_org_id)

    # Supabase-first staff path for Support-created client organizations.
    if raw_org_id and not numeric_org_id:
        try:
            user = support_cp_db.create_client_staff(
                org_id=str(raw_org_id),
                payload={**data, 'password': password},
                created_by=str(data.get('created_by_user_id') or '') or None,
                # Only an existing admin (this session's token) may create
                # a new staff row with account_role='admin'; every other
                # caller can still create account_role='staff' rows freely —
                # see role_permissions.py and support_db_staff.create_client_staff.
                granted_by_is_admin=bool(dashboard_user.get('is_admin')),
            )
            return jsonify({
                'success': True,
                'user': user,
                'credentials': {
                    'email': user.get('email') or data.get('email', ''),
                    'password': password,
                },
            }), 201
        except ValueError as e:
            return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 400
        except Exception as e:
            logger.exception('Supabase staff creation failed')
            return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 500

    organization_id = _resolve_organization_id(data)

    if data.get('role', 'staff') == 'staff' and not organization_id:
        return jsonify({
            'success': False,
            'message': 'Organization could not be resolved for this staff member.'
        }), 400

    uid = db.add_user(
        name=data.get('name', ''),
        email=data.get('email', ''),
        password=password,
        role=data.get('role', 'staff'),
        department=data.get('department', ''),
        phone=data.get('phone', ''),
        notes=data.get('notes', ''),
        cnic=data.get('cnic', ''),
        position=data.get('position', ''),
        salary=float(data.get('salary', 0) or 0),
        benefits=json.dumps(data.get('benefits', [])),
        join_date=data.get('join_date', ''),
        shift=data.get('shift', data.get('shift_label', 'Morning')),
        duty_start=data.get('duty_start', '09:00'),
        duty_end=data.get('duty_end', '18:00'),
        staff_type=data.get('staff_type', 'office'),
        access_modules=json.dumps(data.get('access_modules', [])),
        organization_id=organization_id,
        branch_id=data.get('branch_id'),
        branch_name=data.get('branch_name', ''),
        employee_id=data.get('employee_id'),
        status=data.get('status', 'active'),
        shift_id=data.get('shift_id'),
        shift_label=data.get('shift_label'),
        profile_image_url=data.get('profile_image_url'),
        profile_image_name=data.get('profile_image_name'),
        training_video_url=data.get('training_video_url'),
        training_video_name=data.get('training_video_name'),
    )

    if uid is None:
        return jsonify({
            'success': False,
            'message': 'Staff member already exists or could not be created'
        }), 409

    db.set_salary_config(
        user_id=int(uid),
        basic_salary=float(data.get('salary', 0) or 0),
        allowances=0.0,
        deductions=0.0,
        ot_rate=float(data.get('ot_rate', 0) or 0),
        effective_from=data.get('join_date') or None,
    )

    user = db.get_user_by_id(uid)
    refresh_embedding_cache()

    if user and str(user.get('role') or '').lower() == 'staff':
        branch_id = _notification_int(user.get('branch_id'))
        org_id = _notification_int(user.get('organization_id')) or organization_id
        employee_name = user.get('name') or data.get('name', 'Employee')
        branch_name = user.get('branch_name') or data.get('branch_name', '')
        actor_user_id = _notification_int(data.get('created_by_user_id'))
        _create_dashboard_notification_safely(
            organization_id=org_id,
            branch_id=branch_id,
            module_key='employees',
            event_type='employee_added',
            title='New employee added',
            body=f"{employee_name} was added to {branch_name or 'the branch'}.",
            actor_user_id=actor_user_id,
            actor_name='',
            target_user_id=int(uid),
            target_entity_id=int(uid),
            target_entity_type='employee',
            target_route=_branch_module_route(branch_id, 'employees', uid),
            metadata={
                'employee_id': int(uid),
                'employee_name': employee_name,
                'branch_name': branch_name,
            },
            exclude_user_id=int(uid),
            extra_recipient_user_ids=[actor_user_id] if actor_user_id else None,
        )

    return jsonify({
        'success': True,
        'user': _safe_user(user),
        'credentials': {
            'email': user.get('email') if user else data.get('email', ''),
            'password': password,
        }
    }), 201



@app.route('/api/staff/<staff_id>/dashboard-scope', methods=['PATCH'])
@require_client_dashboard_auth
def api_set_staff_dashboard_scope(staff_id):
    """Sets staff_id's own 'My Team Only' toggle (dashboard_scope: 'branch'
    | 'team') — matches staffApi.ts's setStaffDashboardScope. org_id is
    taken from the verified token (not the request body) so one org's
    session can never flip a scope flag on another org's staff row; the
    body's organization_id is accepted but only checked against the
    token's, never trusted on its own."""
    def _run():
        data = request.get_json(silent=True) or {}
        dashboard_user = g.dashboard_user
        org_id = str(dashboard_user.get('org_id') or '').strip()
        body_org_id = str(data.get('organization_id') or data.get('org_id') or '').strip()
        if body_org_id and body_org_id != org_id:
            raise ValueError('organization_id does not match the authenticated session.')

        scope = data.get('dashboard_scope') or data.get('dashboardScope')
        staff = hierarchy_set_dashboard_scope(org_id, staff_id, scope)
        return jsonify({'success': True, 'staff': staff}), 200

    try:
        return _run()
    except ValueError as exc:
        return jsonify({'success': False, 'error': str(exc), 'message': str(exc)}), 400
    except Exception:
        # Never surface a raw Postgrest/driver exception to the client (a
        # missing-column schema-cache error, for example, would otherwise
        # render verbatim inside the Reporting Hierarchy panel). Log the
        # real cause server-side, return a clean, actionable message.
        logger.exception('Failed to set dashboard scope for staff %s', staff_id)
        message = 'Could not update dashboard visibility. Please try again or contact support.'
        return jsonify({'success': False, 'error': message, 'message': message}), 500


@app.route('/api/client-users/<user_id>/basic', methods=['GET'])
@require_client_dashboard_auth
def api_client_user_basic(user_id):
    """Minimal display-only lookup (name/email/role) for a Client Dashboard
    user. Used by the frontend to resolve leave-request approvers that are
    admin accounts rather than client_staff rows — see
    get_client_user_basic's docstring for why the two tables are separate.

    Auth-gated but not org-scoped: get_client_user_basic's query doesn't
    select org_id, and the payload is display-only (name/email/role, no
    password/session data) — same low-sensitivity bar as a company
    directory listing. If org-scoping is needed later, add org_id to that
    query's select and check it the same way as every other route here.
    """
    try:
        return jsonify(support_cp_db.get_client_user_basic(str(user_id))), 200
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e), 'message': str(e)}), 404
    except Exception as e:
        logger.exception(f'Client user basic lookup failed for user_id={user_id}')
        return jsonify({'success': False, 'error': str(e), 'message': str(e)}), 500


@app.route('/api/staff/<staff_id>', methods=['GET', 'PUT', 'DELETE'])
@require_client_dashboard_auth
def api_client_staff_detail(staff_id):
    """UUID staff endpoint backed by Supabase client_staff."""
    if _positive_int(staff_id):
        return jsonify({'success': False, 'error': 'Use numeric legacy route for SQLite staff.'}), 404

    try:
        # Every branch below reads or mutates one specific staff record —
        # always confirm it belongs to the caller's own org before touching
        # it. A valid token for org A must never reach into org B's staff
        # by guessing/enumerating ids.
        current = support_cp_db.get_client_staff_member(str(staff_id))
        if not _dashboard_target_org_matches(g.dashboard_user, current.get('organization_id')):
            return jsonify({'success': False, 'error': 'Staff member not found.'}), 404

        if request.method == 'GET':
            return jsonify(current), 200

        if request.method == 'PUT':
            data = request.get_json(silent=True) or {}
            user = support_cp_db.update_client_staff(
                str(staff_id),
                data,
                granted_by_is_admin=bool(g.dashboard_user.get('is_admin')),
            )
            return jsonify({'success': True, 'user': user}), 200

        if request.method == 'DELETE':
            # Archiving (soft-delete) an employee is account-lifecycle, not
            # routine data editing — admin only, same bar as the numeric
            # legacy route and the permanent-purge routes below.
            if not g.dashboard_user.get('is_admin'):
                return jsonify({'success': False, 'error': 'Admin privileges required for this action.'}), 403
            data = request.get_json(silent=True) or {}
            archive = support_cp_db.archive_client_staff(
                staff_id=str(staff_id),
                reason=data.get('reason') or 'Archived from Staff Management',
                archived_by=str(data.get('archived_by') or '') or None,
            )
            return jsonify({
                'success': True,
                'message': 'Staff member archived successfully.',
                'archive': archive,
            }), 200

        return jsonify({'success': False, 'error': 'Unsupported method.'}), 405
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e), 'message': str(e)}), 404
    except Exception as e:
        logger.exception(f'Supabase staff detail failed for staff_id={staff_id}')
        return jsonify({'success': False, 'error': str(e), 'message': str(e)}), 500


@app.route('/api/staff/<staff_id>/restore', methods=['POST'])
@require_client_dashboard_admin
def api_restore_client_staff_member(staff_id):
    if _positive_int(staff_id):
        return api_restore_staff_member(int(staff_id))
    try:
        # restore_client_staff has no org parameter of its own — verify
        # the record belongs to the caller's org here before touching it.
        # get_client_staff_member raises ValueError (not None) when the id
        # doesn't exist at all — caught below and turned into the same
        # 404 an org mismatch gets, rather than falling through to the
        # generic except Exception -> 500 below. A missing record and a
        # wrong-org record should look identical to the caller either way
        # (never reveal whether the id exists in another org).
        try:
            current = support_cp_db.get_client_staff_member(str(staff_id))
        except ValueError:
            return jsonify({'success': False, 'error': 'Archived employee not found.'}), 404
        if not _dashboard_target_org_matches(g.dashboard_user, current.get('organization_id')):
            return jsonify({'success': False, 'error': 'Archived employee not found.'}), 404

        data = request.get_json(silent=True) or {}
        restored = support_cp_db.restore_client_staff(
            staff_id=str(staff_id),
            restored_by=str(data.get('restored_by') or '') or None,
        )
        user = support_cp_db.get_client_staff_member(str(staff_id))
        return jsonify({
            'success': True,
            'message': 'Employee restored. Biometric training is required again.',
            'restore': restored,
            'user': user,
        }), 200
    except Exception as e:
        logger.exception(f'Failed to restore Supabase staff {staff_id}')
        return jsonify({'success': False, 'error': str(e), 'message': str(e)}), 500


@app.route('/api/staff/archived/<staff_id>/delete', methods=['POST', 'DELETE'])
@require_client_dashboard_admin
def api_delete_archived_client_staff_member(staff_id):
    if _positive_int(staff_id):
        return api_delete_archived_staff_member(int(staff_id))
    try:
        # delete_client_staff has no org parameter of its own — verify the
        # record belongs to the caller's org before permanently purging it.
        # Same ValueError -> 404 translation as the restore route above —
        # get_client_staff_member raises rather than returning None for a
        # nonexistent id.
        try:
            current = support_cp_db.get_client_staff_member(str(staff_id))
        except ValueError:
            return jsonify({'success': False, 'error': 'Archived employee not found.'}), 404
        if not _dashboard_target_org_matches(g.dashboard_user, current.get('organization_id')):
            return jsonify({'success': False, 'error': 'Archived employee not found.'}), 404

        deleted = support_cp_db.delete_client_staff(str(staff_id))
        return jsonify({
            'success': True,
            'message': 'Archived employee permanently deleted from Supabase.',
            'deleted_user_id': str(staff_id),
            'delete': deleted,
        }), 200
    except Exception as e:
        logger.exception(f'Failed to delete archived Supabase staff {staff_id}')
        return jsonify({'success': False, 'error': str(e), 'message': str(e)}), 500



@app.route('/api/staff/<staff_id>/training-video', methods=['POST'])
def api_staff_training_video(staff_id):
    """Retired: not called anywhere in the current frontend and confirmed
    out of the current architecture (2026-08-14). Sibling of
    /api/enroll/upload-video, retired for the same reason and with the
    same caveat — see that route's docstring if biometric enrollment is
    ever revived."""
    return jsonify({
        'success': False,
        'error': 'This endpoint has been retired.',
    }), 410


@app.route('/api/staff/<staff_id>/photo', methods=['GET', 'POST'])
@require_client_dashboard_auth
def api_staff_photo(staff_id):
    """Serve/upload staff profile photos through the API boundary.

    Why this route exists:
      - React runs on Vite (:5173) and only /api is proxied to Flask.
      - Storing /staff_profile_photos/... makes the browser ask Vite for the file,
        so the image breaks.
      - /api/staff/<uuid>/photo stays stable now and can later be backed by
        Supabase/Railway object storage without changing React components.
    """
    numeric_id = _positive_int(staff_id)
    if numeric_id:
        if request.method == 'POST':
            return upload_user_photo(int(numeric_id))
        return get_user_photo(int(numeric_id))

    # UUID (Supabase) branch — same org-scope discipline as api_client_staff_detail:
    # confirm the target actually belongs to the caller's org before serving
    # or overwriting their photo.
    try:
        staff_row = support_cp_db.get_client_staff_member(str(staff_id))
    except Exception:
        return jsonify({'success': False, 'message': 'Staff member not found.'}), 404
    if not _dashboard_target_org_matches(g.dashboard_user, staff_row.get('organization_id')):
        return jsonify({'success': False, 'message': 'Staff member not found.'}), 404

    photos_dir = Path('static/staff_profile_photos')

    if request.method == 'GET':
        try:
            photos_dir.mkdir(parents=True, exist_ok=True)
            candidate_names = []
            stored_name = secure_filename(str(staff_row.get('profile_image_name') or ''))
            if stored_name:
                candidate_names.append(stored_name)

            # Backward compatibility: earlier code could overwrite
            # profile_image_name with the original upload filename while the
            # saved file was actually staff_<uuid>.<ext>. Do not trust the DB
            # filename as the only source; fall back to deterministic files.
            safe_staff_key = secure_filename(str(staff_id).replace('-', '_'))
            for ext in ('jpg', 'jpeg', 'png', 'webp'):
                candidate_names.append(f'staff_{safe_staff_key}.{ext}')

            seen = set()
            for filename in candidate_names:
                if not filename or filename in seen:
                    continue
                seen.add(filename)
                filepath = photos_dir / filename
                if filepath.exists():
                    return send_from_directory(str(photos_dir.resolve()), filename)

            return jsonify({'success': False, 'message': 'Photo file is missing on server.'}), 404
        except Exception as e:
            logger.exception(f'Supabase staff photo fetch failed for staff_id={staff_id}')
            return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 404

    if 'photo' not in request.files:
        return jsonify({'success': False, 'message': 'No photo provided.'}), 400

    if 'photo' not in request.files:
        return jsonify({'success': False, 'message': 'No photo provided.'}), 400
    photo = request.files['photo']
    if photo.filename == '':
        return jsonify({'success': False, 'message': 'No file selected.'}), 400
    ext = photo.filename.rsplit('.', 1)[-1].lower() if '.' in photo.filename else ''
    if ext not in {'jpg', 'jpeg', 'png', 'webp'}:
        return jsonify({'success': False, 'message': 'Only jpg, jpeg, png, or webp are allowed.'}), 400

    # Per-route size cap. MAX_CONTENT_LENGTH is the global backstop sized
    # for the embeddings import package; a profile photo needs far less.
    MAX_PHOTO_BYTES = 5 * 1024 * 1024
    photo.stream.seek(0, os.SEEK_END)
    size = photo.stream.tell()
    photo.stream.seek(0)
    if size > MAX_PHOTO_BYTES:
        return jsonify({'success': False, 'message': 'Photo too large. Max size: 5MB.'}), 413

    try:
        photos_dir.mkdir(parents=True, exist_ok=True)
        safe_ext = 'jpg' if ext == 'jpeg' else ext
        filename = secure_filename(f"staff_{str(staff_id).replace('-', '_')}.{safe_ext}")

        # Store an API URL, not a /static-style URL and never a browser blob URL.
        cache_buster = int(datetime.now(timezone.utc).timestamp())
        photo_url = f'/api/staff/{str(staff_id)}/photo?v={cache_buster}'
        user = support_cp_db.update_client_staff_photo(str(staff_id), photo_url, filename)

        return jsonify({
            'success': True,
            'photo_url': photo_url,
            'profile_image_url': photo_url,
            'profileImageUrl': photo_url,
            'profile_image_name': filename,
            'profileImageName': filename,
            'user': user,
        }), 200
    except Exception as e:
        logger.exception(f'Supabase staff photo upload failed for staff_id={staff_id}')
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 500


@app.route('/api/staff/<int:user_id>', methods=['GET', 'PUT', 'DELETE'])
@require_client_dashboard_auth
def api_staff_detail(user_id):
    """
    Staff detail endpoint.

    GET:
      Return one staff/user record.

    PUT:
      Update staff/user fields.

    DELETE:
      Archive employee:
      - remove from active Staff Directory
      - delete biometric embeddings immediately
      - disable attendance recognition
      - keep HR records until retention_until
    """
    try:
        if request.method == 'GET':
            user = db.get_user_by_id(int(user_id))

            if not user or not _dashboard_target_org_matches(g.dashboard_user, user.get('organization_id')):
                return jsonify({
                    'success': False,
                    'error': 'Staff member not found.',
                }), 404

            safe_user = _safe_user(user) if '_safe_user' in globals() else {
                key: value for key, value in user.items() if key != 'password'
            }

            return jsonify(safe_user), 200

        if request.method == 'PUT':
            existing = db.get_user_by_id(int(user_id))
            if not existing or not _dashboard_target_org_matches(g.dashboard_user, existing.get('organization_id')):
                return jsonify({
                    'success': False,
                    'error': 'Staff member not found or no valid fields supplied.',
                }), 404

            data = request.get_json(silent=True) or {}

            updated = db.update_user_fields(int(user_id), data)

            if not updated:
                return jsonify({
                    'success': False,
                    'error': 'Staff member not found or no valid fields supplied.',
                }), 404

            user = db.get_user_by_id(int(user_id))

            safe_user = _safe_user(user) if '_safe_user' in globals() else {
                key: value for key, value in user.items() if key != 'password'
            }

            return jsonify({
                'success': True,
                'user': safe_user,
            }), 200

        if request.method == 'DELETE':
            # Account-lifecycle action — admin only, same bar as every
            # other archive/restore/purge route.
            if not g.dashboard_user.get('is_admin'):
                return jsonify({
                    'success': False,
                    'error': 'Admin privileges required for this action.',
                }), 403

            data = request.get_json(silent=True) or {}

            retention_years = data.get('retention_years')
            reason = data.get('reason') or 'Archived from Staff Management'
            archived_by = data.get('archived_by')

            # organization_id always comes from the verified admin token —
            # never the request body — and archive_user_for_retention
            # refuses the archive outright if it doesn't match.
            archived = db.archive_user_for_retention(
                user_id=int(user_id),
                retention_years=retention_years,
                reason=reason,
                archived_by=archived_by,
                organization_id=_positive_int(g.dashboard_user.get('org_id')),
            )

            if not archived:
                return jsonify({
                    'success': False,
                    'error': 'Staff member not found or could not be archived.',
                }), 404

            return jsonify({
                'success': True,
                'message': 'Staff member archived successfully.',
                'archive': archived,
            }), 200

        return jsonify({
            'success': False,
            'error': 'Unsupported method.',
        }), 405

    except Exception as e:
        logger.exception(f"Staff detail endpoint failed for user_id={user_id}")
        return jsonify({
            'success': False,
            'error': str(e),
        }), 500  


@app.route('/api/users/<int:user_id>', methods=['GET'])
def api_get_user(user_id):
    """Retired 2026-08 — unauthenticated legacy-SQLite single-user lookup. No
    active tenant runs on legacy SQLite; use GET /api/staff/<id> (Supabase,
    authenticated) instead. See security-remediation Tier 2."""
    return jsonify({
        'success': False,
        'error': 'This endpoint has been retired. Use GET /api/staff/<id> instead.',
    }), 410


# ============================================
# ATTENDANCE ENDPOINTS
# ============================================

@app.route('/api/attendance', methods=['GET'])
@require_client_dashboard_auth
def api_get_attendance():
    dashboard_user = g.dashboard_user
    raw_org_id = str(dashboard_user.get('org_id') or '').strip()
    # branch_id: same admin-aware resolution as /api/leaves, /api/overtime,
    # /api/staff, /api/v2/payroll/page, /api/attendance/today — an admin's
    # token still carries their own home branch but must not be locked to
    # it; only a genuinely branch-scoped (non-admin) account stays pinned.
    raw_branch_id = request.args.get('branch_id') or request.args.get('branchId')
    if not dashboard_user.get('is_admin'):
        raw_branch_id = dashboard_user.get('branch_id') or raw_branch_id
    people_type = request.args.get('people_type') or request.args.get('peopleType')
    limit = request.args.get('limit', 200, type=int)
    requested_view = request.args.get('view') or request.args.get('teamView')
    scope_ids = get_effective_scope_ids(dashboard_user, requested_view=requested_view)

    # Supabase attendance for Support-created UUID organizations.
    if raw_org_id and not _positive_int(raw_org_id):
        logs = support_cp_db.get_client_attendance_logs(
            org_id=raw_org_id,
            branch_id=raw_branch_id,
            limit=limit,
            people_type=people_type,
            scope_ids=scope_ids,
        )
        return jsonify(logs), 200

    user_id = request.args.get('user_id', type=int)
    start = request.args.get('start')
    end = request.args.get('end')
    if user_id and start and end:
        logs = db.get_attendance_by_user(user_id, start, end)
    elif user_id:
        logs = db.get_attendance_by_user(user_id)
    else:
        logs = db.get_attendance_logs(limit=limit)
    logs = filter_rows_by_scope(logs, scope_ids, 'user_id', 'staff_id', 'id')
    return jsonify(logs)


@app.route('/api/attendance/today', methods=['GET'])
@require_client_dashboard_auth
def api_attendance_today():
    """SECURITY: this route previously had NO auth decorator at all — any
    caller could pull any organization's live attendance feed off the
    query string, with zero scope filtering (a 'team'-scoped manager saw
    the whole org's attendance, not just their team). org_id/branch_id are
    now pinned to the verified Client Dashboard token, same trust boundary
    every other /api/v2 route uses (see client_dashboard_auth.py), and
    dashboard_scope='team' is enforced via get_effective_scope_ids —
    including the same optional ?view=team narrowing 'branch'-scoped
    managers already get on /api/v2/dashboard/overview and
    /api/v2/tenant/summary.
    """
    dashboard_user = g.dashboard_user
    raw_org_id = str(dashboard_user.get('org_id') or '').strip()

    # branch_id: a token still carries the caller's own home branch even
    # for admins (client_staff.branch_id), but that must not lock an
    # org-wide admin to a single branch. Only a genuinely branch-scoped
    # (non-admin) account stays pinned to its token branch_id; an admin
    # may still pass branch_id as a voluntary display filter, same trust
    # boundary /api/staff already uses.
    raw_branch_id = request.args.get('branch_id') or request.args.get('branchId')
    if not dashboard_user.get('is_admin'):
        raw_branch_id = dashboard_user.get('branch_id') or raw_branch_id

    date_value = request.args.get('date') or request.args.get('log_date')
    people_type = request.args.get('people_type') or request.args.get('peopleType')
    limit = request.args.get('limit', 500, type=int)

    requested_view = request.args.get('view') or request.args.get('teamView')
    scope_ids = get_effective_scope_ids(dashboard_user, requested_view=requested_view)

    if not raw_org_id:
        return jsonify({'success': False, 'error': 'organization_id is required', 'message': 'organization_id is required'}), 400

    # Local/cloud node attendance is written to Supabase. The React dashboard
    # must read the same source, otherwise manual/CCTV attendance sync succeeds
    # but the UI still shows absent.
    start = request.args.get('start')
    end = request.args.get('end')
    if not _positive_int(raw_org_id):
        try:
            return jsonify(support_cp_db.get_client_attendance_today(
                org_id=raw_org_id,
                branch_id=raw_branch_id,
                date_value=date_value,
                start=start,
                end=end,
                limit=limit,
                people_type=people_type,
                scope_ids=scope_ids,
            )), 200
        except ValueError as exc:
            return jsonify({'success': False, 'error': str(exc), 'message': str(exc)}), 400
        except Exception as exc:
            logger.exception('Supabase attendance today endpoint failed')
            return jsonify({
                'success': False,
                'error': 'Supabase attendance read failed',
                'message': str(exc),
            }), 503

    organization_id = _positive_int(raw_org_id)
    branch_id = _positive_int(raw_branch_id)
    rows = db.get_attendance_today(organization_id=organization_id, branch_id=branch_id)
    # Legacy numeric orgs never mint a scoped client_staff token (see
    # /api/staff's identical comment) so scope_ids is always None here —
    # filter kept only so this branch can't silently diverge if that
    # ever changes.
    rows = filter_rows_by_scope(rows, scope_ids, 'user_id', 'staff_id', 'id')
    return jsonify(rows)


@app.route('/api/attendance/mark-absent', methods=['POST'])
@require_client_dashboard_auth
def api_mark_absent():
    data = request.get_json() or {}
    user_id = data.get('user_id') or data.get('staff_id') or data.get('staffId')
    # organization_id/branch_id always come from the verified token — a
    # value in the body/query/header is never trusted for scoping, same
    # discipline as every other Tier 1/2 fix.
    raw_org_id = g.dashboard_user.get('org_id') or ''
    raw_branch_id = (
        g.dashboard_user.get('branch_id')
        or data.get('branch_id')
        or data.get('branchId')
        or request.args.get('branch_id')
        or request.args.get('branchId')
    )
    people_type = (
        data.get('people_type')
        or data.get('peopleType')
        or request.args.get('people_type')
        or request.args.get('peopleType')
    )
    date_value = data.get('date') or request.args.get('date') or request.args.get('log_date')

    if not user_id:
        return jsonify({'success': False, 'message': 'user_id is required', 'error': 'user_id is required'}), 400

    raw_org_id = str(raw_org_id or '').strip()
    if raw_org_id and not _positive_int(raw_org_id):
        try:
            return jsonify(support_cp_db.mark_client_staff_absent_today(
                org_id=raw_org_id,
                staff_id=str(user_id),
                branch_id=raw_branch_id,
                people_type=people_type,
                date_value=date_value,
            )), 200
        except ValueError as exc:
            return jsonify({'success': False, 'message': str(exc), 'error': str(exc)}), 400
        except Exception as exc:
            logger.exception('Supabase mark absent failed')
            return jsonify({'success': False, 'message': str(exc), 'error': str(exc)}), 500

    db.mark_user_absent_today(int(user_id))
    return jsonify({'success': True})


@app.route('/api/attendance/<record_id>', methods=['PATCH'])
@require_client_dashboard_auth
def api_update_attendance_record(record_id):
    """Admin edit of one attendance row's check-in, check-out, arrival
    (timing) classification, and/or notes from the Client Dashboard.

    Body (all optional -- only fields present are changed):
      { "check_in"|"checkIn": ISO datetime,
        "check_out"|"checkOut": ISO datetime | "" (clears checkout),
        "arrival_status"|"arrivalStatus"|"check_in_status"|"status":
            "on_time" | "late" | "early" | "unscheduled",
        "notes": string | "" (clears notes) }

    Supabase/UUID organizations only, matching every other attendance
    write route in this file (mark-absent, field/office check-in) --
    the legacy SQLite path never grew a record-level edit and isn't
    expected to.
    """
    dashboard_user = g.dashboard_user
    org_id = str(dashboard_user.get('org_id') or '').strip()
    if not org_id or _positive_int(org_id):
        return jsonify({
            'success': False,
            'message': 'Editing attendance records is only supported for Supabase organizations',
            'error': 'unsupported_organization',
        }), 400

    payload = request.get_json(silent=True) or {}
    try:
        record = support_cp_db.update_client_attendance_record(org_id, record_id, payload)
        return jsonify({'success': True, 'record': record}), 200
    except ValueError as exc:
        return jsonify({'success': False, 'message': str(exc), 'error': str(exc)}), 400
    except Exception as exc:
        logger.exception('Attendance record update failed')
        return jsonify({'success': False, 'message': str(exc), 'error': str(exc)}), 500


# ============================================
# LEAVE ENDPOINTS
# ============================================

@app.route('/api/leaves', methods=['GET'])
@require_client_dashboard_auth
def api_get_leaves():
    dashboard_user = g.dashboard_user
    raw_user_id = request.args.get('user_id') or request.args.get('userId')
    status = request.args.get('status')
    # branch_id: don't let a token's own home branch lock an admin to one
    # branch's leave requests — same admin-aware resolution as /api/staff
    # and /api/v2/payroll/page. Non-admin/branch-scoped accounts stay
    # pinned to their token branch_id regardless of the query string.
    raw_branch_id = request.args.get('branch_id') or request.args.get('branchId')
    if not dashboard_user.get('is_admin'):
        raw_branch_id = dashboard_user.get('branch_id') or raw_branch_id
    raw_org_id = str(dashboard_user.get('org_id') or '').strip()
    # 'view' is a display-preference hint only (?view=team|branch), never
    # an identity list — get_effective_scope_ids always resolves the
    # actual id set from g.dashboard_user's own verified id. Mandatory
    # dashboard_scope='team' filtering behaves identically to the old
    # bare get_team_scope_ids call; this just adds the same optional
    # 'My Team' toggle 'branch'-scoped managers already get on
    # /api/v2/dashboard/overview and /api/v2/tenant/summary.
    requested_view = request.args.get('view') or request.args.get('teamView')
    scope_ids = get_effective_scope_ids(dashboard_user, requested_view=requested_view)

    if not raw_org_id:
        return jsonify({'success': False, 'error': 'organization_id is required', 'message': 'organization_id is required'}), 400

    if raw_org_id and not _positive_int(raw_org_id):
        try:
            rows = support_cp_db.list_client_leave_requests(
                org_id=raw_org_id,
                branch_id=raw_branch_id,
                user_id=raw_user_id,
                status=status,
            )
            rows = filter_rows_by_scope(rows, scope_ids, 'user_id', 'staff_id', 'id')
            return jsonify(rows), 200
        except ValueError as exc:
            return jsonify({'success': False, 'error': str(exc), 'message': str(exc)}), 400
        except Exception as exc:
            logger.exception('Supabase leave list endpoint failed')
            return jsonify({
                'success': False,
                'error': 'Supabase leave read failed',
                'message': str(exc),
            }), 503

    rows = db.get_leave_requests(
        user_id=_positive_int(raw_user_id),
        status=status,
        branch_id=_positive_int(raw_branch_id),
        organization_id=_positive_int(raw_org_id),
    )
    rows = filter_rows_by_scope(rows, scope_ids, 'user_id', 'staff_id', 'id')
    return jsonify(rows)

@app.route('/api/leaves/types', methods=['GET'])
@require_client_dashboard_auth
def api_get_leave_types():
    """Effective, branch-aware leave-type paid/unpaid map for the Leave
    Management filter (and any other dashboard surface that needs to know
    which leave types this org has configured). org_id always comes from
    the authenticated session, never the query string -- same tenant
    boundary api_get_leaves enforces just above. branch_id is optional:
    omit for the org-wide default, pass to layer a branch override on top
    (see support_db_payroll.get_payroll_policy's org > branch fallback).

    Also returns leaveTypeQuotas (annual per-type paid-day allotment) --
    the Leave Management History tab's per-employee "Total Paid Leaves" /
    "Remaining" columns are computed from this alongside leaveTypeRules.
    Additive: existing callers that only read leaveTypeRules are
    unaffected."""
    dashboard_user = g.dashboard_user
    org_id = str(dashboard_user.get('org_id') or '').strip()
    if not org_id:
        return jsonify({'success': False, 'error': 'organization_id is required'}), 400
    raw_branch_id = request.args.get('branch_id') or request.args.get('branchId') or dashboard_user.get('branch_id')
    branch_id = _clean_id_text(raw_branch_id) or None
    try:
        allocations = support_cp_db.get_leave_type_allocations(org_id, branch_id=branch_id)
        return jsonify({'success': True, **allocations}), 200
    except Exception as exc:
        logger.exception('Leave type rules lookup failed for org=%s', org_id)
        return jsonify({'success': False, 'error': str(exc)}), 500


@app.route('/api/leaves', methods=['POST'])
@require_client_dashboard_auth
def api_add_leave():
    """Dashboard-side "add/apply leave on behalf of a staff member". org_id
    is always g.dashboard_user's -- a value in the body is ignored for
    scoping so a caller can never write into another org by editing the
    payload. user_id/staff_id in the body identifies WHO the leave is for,
    and is still required, but a 'team'-scoped caller (a manager) may only
    target someone in their own reporting tree -- get_team_scope_ids is
    the same check /api/leaves GET already uses, so "who can I see" and
    "who can I file leave for" stay in lockstep.
    """
    data = request.get_json() or {}
    dashboard_user = g.dashboard_user
    raw_org_id = str(dashboard_user.get('org_id') or '').strip()
    user_id = data.get('user_id') or data.get('userId') or data.get('staff_id') or data.get('staffId')
    scope_ids = get_team_scope_ids(dashboard_user)

    if not raw_org_id:
        return jsonify({'success': False, 'message': 'organization_id is required'}), 400
    if not user_id:
        return jsonify({'success': False, 'message': 'user_id required'}), 400
    if scope_ids is not None and str(user_id) not in scope_ids:
        return jsonify({'success': False, 'error': 'Not authorized to file leave for this staff member', 'message': 'Not authorized to file leave for this staff member'}), 403

    if raw_org_id and not _positive_int(raw_org_id):
        try:
            leave = support_cp_db.create_client_leave_request(raw_org_id, data)
            return jsonify({'success': True, 'id': leave.get('id'), 'leave': leave}), 201
        except ValueError as exc:
            return jsonify({'success': False, 'message': str(exc), 'error': str(exc)}), 400
        except Exception as exc:
            logger.exception('Supabase leave creation failed')
            return jsonify({'success': False, 'message': str(exc), 'error': str(exc)}), 500

    # Legacy SQLite path: scope_ids (from get_team_scope_ids) are Supabase
    # client_staff UUIDs, a different id space than legacy int user ids, so
    # team-scope can't be verified here -- a 'team'-scoped caller is
    # rejected outright rather than silently treated as unscoped.
    if scope_ids is not None:
        return jsonify({'success': False, 'message': 'Team-scoped accounts cannot use the legacy leave system'}), 403

    user = db.get_user_by_id(int(user_id))
    lid = db.add_leave_request(
        user_id=int(user_id),
        user_name=user['name'] if user else data.get('user_name', ''),
        leave_type=data.get('leave_type', 'annual'),
        start_date=data.get('start_date', ''),
        end_date=data.get('end_date', ''),
        reason=data.get('reason', ''),
    )

    if lid and user:
        branch_id = _notification_int(user.get('branch_id'))
        org_id = _notification_int(user.get('organization_id'))
        employee_name = user.get('name') or data.get('user_name', 'Employee')
        leave_type = data.get('leave_type', 'Leave')
        _create_dashboard_notification_safely(
            organization_id=org_id,
            branch_id=branch_id,
            module_key='leave',
            event_type='leave_applied',
            title='Leave request submitted',
            body=f"{employee_name} applied for {leave_type} leave.",
            actor_user_id=int(user_id),
            actor_name=employee_name,
            target_user_id=int(user_id),
            target_entity_id=lid,
            target_entity_type='leave_request',
            target_route=_branch_module_route(branch_id, 'leave', lid),
            metadata={
                'leave_id': lid,
                'employee_name': employee_name,
                'leave_type': leave_type,
                'start_date': data.get('start_date', ''),
                'end_date': data.get('end_date', ''),
            },
            exclude_user_id=int(user_id),
        )

    return jsonify({'success': True, 'id': lid}), 201


@app.route('/api/leaves/<leave_id>', methods=['PUT'])
@require_client_dashboard_auth
def api_update_leave(leave_id):
    """Approve/reject a leave. org_id always comes from g.dashboard_user,
    never the body. A 'team'-scoped caller (manager) may only decide on a
    leave belonging to someone in their own reporting tree -- read the row
    first (org-scoped, so this also 404s cleanly for a leave_id from
    another org) and check its staff_id against get_team_scope_ids before
    mutating anything.
    """
    data = request.get_json() or {}
    dashboard_user = g.dashboard_user
    raw_org_id = str(dashboard_user.get('org_id') or '').strip()
    scope_ids = get_team_scope_ids(dashboard_user)

    if raw_org_id and not _positive_int(raw_org_id):
        try:
            existing = support_cp_db.get_client_leave_owned_by_org(str(leave_id), raw_org_id)
            owner_id = str(existing.get('staff_id') or existing.get('user_id') or '')
            if scope_ids is not None and owner_id not in scope_ids:
                return jsonify({'success': False, 'error': 'Not authorized to update this leave request', 'message': 'Not authorized to update this leave request'}), 403
            leave = support_cp_db.update_client_leave_status(
                leave_id=str(leave_id),
                org_id=raw_org_id,
                status=data.get('status', 'approved'),
                approved_by=data.get('approved_by', 'Admin'),
            )
            return jsonify({'success': True, 'leave': leave}), 200
        except ValueError as exc:
            return jsonify({'success': False, 'message': str(exc), 'error': str(exc)}), 400

    if scope_ids is not None:
        return jsonify({'success': False, 'message': 'Team-scoped accounts cannot use the legacy leave system'}), 403

    db.update_leave_status(int(leave_id), data.get('status', 'approved'), data.get('approved_by', 'Admin'))
    return jsonify({'success': True})


@app.route('/api/leaves/<leave_id>', methods=['DELETE'])
@require_client_dashboard_auth
def api_delete_leave(leave_id):
    """org_id always comes from g.dashboard_user. Same team-scope ownership
    check as PUT above -- a manager can only delete a leave belonging to
    their own reporting tree, never an arbitrary org-wide leave_id."""
    dashboard_user = g.dashboard_user
    raw_org_id = str(dashboard_user.get('org_id') or '').strip()
    scope_ids = get_team_scope_ids(dashboard_user)

    if raw_org_id and not _positive_int(raw_org_id):
        try:
            existing = support_cp_db.get_client_leave_owned_by_org(str(leave_id), raw_org_id)
            owner_id = str(existing.get('staff_id') or existing.get('user_id') or '')
            if scope_ids is not None and owner_id not in scope_ids:
                return jsonify({'success': False, 'error': 'Not authorized to delete this leave request', 'message': 'Not authorized to delete this leave request'}), 403
            support_cp_db.delete_client_leave_request(str(leave_id), raw_org_id)
            return jsonify({'success': True}), 200
        except ValueError as exc:
            return jsonify({'success': False, 'message': str(exc), 'error': str(exc)}), 400

    if scope_ids is not None:
        return jsonify({'success': False, 'message': 'Team-scoped accounts cannot use the legacy leave system'}), 403

    db.delete_leave_request(int(leave_id))
    return jsonify({'success': True})


# ============================================
# OVERTIME ENDPOINTS
# ============================================

@app.route('/api/overtime', methods=['GET'])
@require_client_dashboard_auth
def api_get_overtime():
    dashboard_user = g.dashboard_user
    raw_user_id = request.args.get('user_id') or request.args.get('userId')
    status = request.args.get('status')
    # branch_id: same admin-aware resolution as /api/leaves, /api/staff,
    # /api/v2/payroll/page — an admin's token still carries their own home
    # branch but must not be locked to it.
    raw_branch_id = request.args.get('branch_id') or request.args.get('branchId')
    if not dashboard_user.get('is_admin'):
        raw_branch_id = dashboard_user.get('branch_id') or raw_branch_id
    raw_org_id = str(dashboard_user.get('org_id') or '').strip()
    requested_view = request.args.get('view') or request.args.get('teamView')
    scope_ids = get_effective_scope_ids(dashboard_user, requested_view=requested_view)

    if not raw_org_id:
        return jsonify({'success': False, 'error': 'organization_id is required', 'message': 'organization_id is required'}), 400

    if raw_org_id and not _positive_int(raw_org_id):
        try:
            rows = support_cp_db.list_client_overtime_requests(
                org_id=raw_org_id,
                branch_id=raw_branch_id,
                user_id=raw_user_id,
                status=status,
            )
            rows = filter_rows_by_scope(rows, scope_ids, 'user_id', 'staff_id', 'id')
            return jsonify(rows), 200
        except ValueError as exc:
            return jsonify({'success': False, 'error': str(exc), 'message': str(exc)}), 400

    rows = db.get_overtime(
        user_id=_positive_int(raw_user_id),
        status=status,
        branch_id=_positive_int(raw_branch_id),
        organization_id=_positive_int(raw_org_id),
    )
    rows = filter_rows_by_scope(rows, scope_ids, 'user_id', 'staff_id', 'id')
    return jsonify(rows)

@app.route('/api/overtime', methods=['POST'])
@require_client_dashboard_auth
def api_add_overtime():
    """Dashboard-side "file overtime on behalf of a staff member". org_id is
    always g.dashboard_user's -- a value in the body is ignored for scoping,
    so a caller can never write into another org by editing the payload.
    Previously this route had no auth at all and took organization_id off
    the body. Mirrors api_add_leave exactly, including the team-scope check:
    a 'team'-scoped caller (a manager) may only file overtime for someone in
    their own reporting tree, so "who can I see" (GET /api/overtime) and
    "who can I file overtime for" stay in lockstep.
    """
    data = request.get_json() or {}
    dashboard_user = g.dashboard_user
    raw_org_id = str(dashboard_user.get('org_id') or '').strip()
    user_id = data.get('user_id') or data.get('userId') or data.get('staff_id') or data.get('staffId')
    scope_ids = get_team_scope_ids(dashboard_user)

    if not raw_org_id:
        return jsonify({'success': False, 'message': 'organization_id is required'}), 400
    if not user_id:
        return jsonify({'success': False}), 400
    if scope_ids is not None and str(user_id) not in scope_ids:
        return jsonify({'success': False, 'error': 'Not authorized to file overtime for this staff member', 'message': 'Not authorized to file overtime for this staff member'}), 403

    if raw_org_id and not _positive_int(raw_org_id):
        try:
            overtime = support_cp_db.create_client_overtime_request(raw_org_id, data)
            return jsonify({'success': True, 'id': overtime.get('id'), 'overtime': overtime}), 201
        except ValueError as exc:
            return jsonify({'success': False, 'message': str(exc), 'error': str(exc)}), 400
        except Exception as exc:
            logger.exception('Supabase overtime creation failed')
            return jsonify({'success': False, 'message': str(exc), 'error': str(exc)}), 500

    user = db.get_user_by_id(int(user_id))
    oid = db.add_overtime(
        user_id=int(user_id),
        user_name=user['name'] if user else data.get('user_name', ''),
        ot_date=data.get('ot_date', ''),
        hours=float(data.get('hours', 0) or 0),
        reason=data.get('reason', ''),
    )

    if oid and user:
        branch_id = _notification_int(user.get('branch_id'))
        org_id = _notification_int(user.get('organization_id'))
        employee_name = user.get('name') or data.get('user_name', 'Employee')
        hours = float(data.get('hours', 0) or 0)
        _create_dashboard_notification_safely(
            organization_id=org_id,
            branch_id=branch_id,
            module_key='overtime',
            event_type='overtime_applied',
            title='Overtime request submitted',
            body=f"{employee_name} applied for {hours:g} overtime hours.",
            actor_user_id=int(user_id),
            actor_name=employee_name,
            target_user_id=int(user_id),
            target_entity_id=oid,
            target_entity_type='overtime_request',
            target_route=_branch_module_route(branch_id, 'overtime', oid),
            metadata={
                'overtime_id': oid,
                'employee_name': employee_name,
                'ot_date': data.get('ot_date', ''),
                'hours': hours,
            },
            exclude_user_id=int(user_id),
        )

    return jsonify({'success': True, 'id': oid}), 201


@app.route('/api/overtime/<ot_id>', methods=['PUT'])
@require_client_dashboard_auth
def api_update_overtime(ot_id):
    """Approve/reject an overtime request. org_id always comes from
    g.dashboard_user, never the body -- previously this route had no auth at
    all, and an empty/absent organization_id fell straight through to the
    legacy db.update_overtime_status call below, so an unauthenticated PUT
    could approve arbitrary overtime. A 'team'-scoped caller may only decide
    on a request belonging to someone in their own reporting tree: read the
    row first (org-scoped, so this also 404s cleanly for an ot_id from
    another org) and check its owner against get_team_scope_ids before
    mutating anything. Mirrors api_update_leave.
    """
    data = request.get_json() or {}
    dashboard_user = g.dashboard_user
    raw_org_id = str(dashboard_user.get('org_id') or '').strip()
    scope_ids = get_team_scope_ids(dashboard_user)

    if not raw_org_id:
        return jsonify({'success': False, 'message': 'organization_id is required'}), 400

    if raw_org_id and not _positive_int(raw_org_id):
        try:
            existing = support_cp_db.get_client_overtime_owned_by_org(str(ot_id), raw_org_id)
            owner_id = str(existing.get('user_id') or existing.get('staff_id') or '')
            if scope_ids is not None and owner_id not in scope_ids:
                return jsonify({'success': False, 'error': 'Not authorized to update this overtime request', 'message': 'Not authorized to update this overtime request'}), 403
            overtime = support_cp_db.update_client_overtime_status(
                overtime_id=str(ot_id),
                org_id=raw_org_id,
                status=data.get('status', 'approved'),
                approved_by=data.get('approved_by', 'Admin'),
                rejection_note=data.get('rejection_note'),
            )
            return jsonify({'success': True, 'overtime': overtime}), 200
        except ValueError as exc:
            return jsonify({'success': False, 'message': str(exc), 'error': str(exc)}), 400

    if scope_ids is not None:
        return jsonify({'success': False, 'message': 'Team-scoped accounts cannot use the legacy overtime system'}), 403

    db.update_overtime_status(int(ot_id), data.get('status', 'approved'), data.get('approved_by', 'Admin'))
    return jsonify({'success': True})




# ─── UUID-safe payroll helpers ────────────────────────────────────────────────
def _clean_id_text(value):
    if value is None:
        return ''
    text = str(value).strip()
    return text


def _is_positive_intlike(value):
    text = _clean_id_text(value)
    if not text:
        return False
    try:
        return int(text) > 0 and str(int(text)) == text
    except (TypeError, ValueError):
        return False


def _salary_request_is_supabase_scoped(organization_id, user_id=None):
    """Return True for Support Dashboard / Supabase UUID tenants or staff IDs."""
    org_text = _clean_id_text(organization_id)
    user_text = _clean_id_text(user_id)
    return bool(org_text and not _is_positive_intlike(org_text)) or bool(
        user_text and not _is_positive_intlike(user_text)
    )


def _is_missing_supabase_table(exc):
    text = str(exc).lower()
    return (
        'salary_configs' in text
        and (
            'could not find' in text
            or 'does not exist' in text
            or 'schema cache' in text
            or 'pgrst205' in text
            or 'pgrst204' in text
        )
    )


def _tenant_salary_map_row(row, staff_lookup=None, breakdown=None, paid_staff_ids=None, effective_ot_rate=None, policy=None):
    """Map one tenant payroll row to the frontend contract.

    client_staff.salary is the base source of truth. salary_configs, when the
    table exists, overrides the base salary/rules for the same staff_id. This
    prevents an empty salary_configs table from hiding real tenant staff payroll.

    breakdown: optional payroll_engine.PayrollBreakdown for this staff member
    over the requested period. When supplied, it is authoritative for
    deductions/net_pay/overtime — the manual 'deductions'/'ot_rate' fields
    on the row become a display-only fallback (used only when no attendance
    period was requested, e.g. the un-scoped /api/salary/<user_id> lookup).

    paid_staff_ids: optional set of staff_ids explicitly marked paid for the
    requested period (support_cp_db.get_paid_payroll_periods) — the only
    legitimate source for the 'status' field; see below.

    effective_ot_rate: the resolved rate actually applied to this staff
    member (individual override > branch override > org default — see
    support_cp_db.resolve_effective_ot_rate). This is what the "OT RATE/HR"
    column should render; the raw 'ot_rate' field below stays the per-staff
    override only, so an edit form can still tell "no override set" (0)
    apart from "override happens to equal the resolved default".
    """
    staff_lookup = staff_lookup or {}
    staff_id = _clean_id_text(
        row.get('staff_id')
        or row.get('user_id')
        or row.get('client_staff_id')
        or row.get('id')
        or ''
    )
    staff = staff_lookup.get(staff_id, {})

    branch_id = _clean_id_text(row.get('branch_id') or staff.get('branch_id')) or None
    branch_name = _clean_id_text(row.get('branch_name') or staff.get('branch_name')) or ''
    department = _clean_id_text(
        row.get('department')
        or row.get('department_name')
        or staff.get('department')
        or staff.get('department_name')
    ) or 'General'

    basic_salary = float(
        row.get('basic_salary')
        if row.get('basic_salary') is not None
        else (staff.get('salary') or 0)
    )
    # Legacy flat number -- kept as an "Other / Manual Adjustment" line
    # rather than migrated away, so a genuine one-off adjustment someone
    # already has on file doesn't silently vanish once named allowance
    # types exist. Named allowances (below) are the type-checked, auditable
    # replacement going forward.
    manual_allowance = float(row.get('allowances') or 0)
    applied_allowances = row.get('applied_allowances')
    allowance_items, named_allowance_total = support_cp_db.resolve_effective_allowances(
        applied_allowances if isinstance(applied_allowances, dict) else {},
        policy or {},
        basic_salary,
    )
    allowances = manual_allowance + named_allowance_total
    ot_rate = float(row.get('ot_rate') or 0)
    resolved_ot_rate = float(effective_ot_rate) if effective_ot_rate is not None else ot_rate

    if breakdown is not None:
        deductions = breakdown.total_deductions
        overtime_amount = breakdown.overtime_amount
        net_pay = max(0, basic_salary + allowances + overtime_amount - deductions)
    else:
        deductions = float(row.get('deductions') or 0)
        overtime_amount = 0.0
        net_pay = max(0, basic_salary + allowances - deductions)

    # Payroll "paid" status must never be read off row.get('status')/
    # staff.get('status') — that column is the staff member's *employment*
    # status (active/inactive), a completely different axis that used to
    # get displayed as if it meant "payroll paid". paid_staff_ids, when
    # supplied by the caller (period-scoped), is the real source of truth;
    # with no period resolvable there's nothing to report paid, so default
    # honestly to Pending rather than always showing Paid.
    status = 'Paid' if paid_staff_ids and staff_id in paid_staff_ids else 'Pending'

    result = {
        'id': row.get('id') or staff_id,
        'user_id': staff_id,
        'staff_id': staff_id,
        'client_staff_id': staff_id,
        'employee_id': row.get('employee_id') or staff.get('employee_id') or staff_id,
        'name': row.get('staff_name') or row.get('name') or staff.get('name') or 'Unknown',
        'staff_name': row.get('staff_name') or row.get('name') or staff.get('name') or 'Unknown',
        'department': department,
        'department_name': department,
        'branch_id': branch_id,
        'backend_branch_id': branch_id,
        'branch_uuid': branch_id,
        'branch_name': branch_name,
        'basic_salary': basic_salary,
        'base_salary': basic_salary,
        'salary': basic_salary,
        'allowances': allowances,
        'manual_allowance': manual_allowance,
        'applied_allowances': applied_allowances if isinstance(applied_allowances, dict) else {},
        'allowances_breakdown': allowance_items,
        'deductions': deductions,
        'ot_rate': ot_rate,
        'effective_ot_rate': resolved_ot_rate,
        'effectiveOtRate': resolved_ot_rate,
        'ot_pay': overtime_amount,
        'effective_from': row.get('effective_from'),
        'updated_at': row.get('updated_at') or staff.get('updated_at') or staff.get('created_at'),
        'net_pay': net_pay,
        'status': status,
        'present_days': row.get('present_days') if row.get('present_days') is not None else 0,
    }
    if breakdown is not None:
        result['payroll_breakdown'] = breakdown.to_dict()
    return result

def _tenant_salary_branch_map(org_id: str) -> tuple[list[dict], dict[str, dict], dict[str, str]]:
    """Return org branches and UI-id→backend-id mapping for payroll routes."""
    result = (
        supabase.table('branches')
        .select('id, name, location')
        .eq('org_id', str(org_id))
        .order('created_at')
        .execute()
    )
    branches = result.data or []
    by_backend = {str(branch.get('id')): branch for branch in branches if branch.get('id')}
    ui_to_backend = {
        str(index): str(branch.get('id'))
        for index, branch in enumerate(branches, start=1)
        if branch.get('id')
    }
    return branches, by_backend, ui_to_backend


def _resolve_tenant_salary_branch_id(org_id: str, raw_branch_id=None):
    text = _clean_id_text(raw_branch_id)
    if not text:
        return None
    _branches, by_backend, ui_to_backend = _tenant_salary_branch_map(org_id)
    if text in by_backend:
        return text
    if text in ui_to_backend:
        return ui_to_backend[text]
    return text


def _tenant_staff_salary_rows(org_id: str, branch_id=None) -> tuple[list[dict], dict[str, dict]]:
    """Load tenant staff rows from Supabase client_staff only."""
    branch_text = _resolve_tenant_salary_branch_id(str(org_id), branch_id)
    query = (
        supabase.table('client_staff')
        .select('*')
        .eq('org_id', str(org_id))
        .eq('role', 'staff')
        .eq('is_archived', False)
        .order('name')
    )
    if branch_text:
        query = query.eq('branch_id', branch_text)
    result = query.execute()
    rows = result.data or []

    branches, by_backend, _ = _tenant_salary_branch_map(str(org_id))
    for row in rows:
        branch = by_backend.get(str(row.get('branch_id') or ''))
        if branch and not row.get('branch_name'):
            row['branch_name'] = branch.get('name') or ''
        row['department'] = row.get('department_name') or row.get('department') or 'General'

    lookup = {_clean_id_text(row.get('id')): row for row in rows if row.get('id')}
    return rows, lookup


def _tenant_salary_configs(organization_id, branch_id=None, period_start=None, period_end=None):
    """Read tenant payroll from Supabase without legacy fallback.

    Source of truth:
    - public.client_staff contains the tenant-owned staff and base salary.
    - public.salary_configs is optional and only overrides payroll rules.

    This means a new Supabase tenant with staff.salary=50000 still shows payroll
    even before a salary_configs row is created.

    period_start/period_end ('YYYY-MM-DD', inclusive): when both are given
    and branch_id resolves to one specific branch, deductions/overtime are
    computed live from real attendance + leave data via payroll_engine
    instead of trusting the manual salary_configs.deductions field. Omitted
    for an "all branches" request — the breakdown query is branch-scoped by
    schema (attendance.branch_id), so a global view falls back to the
    manual figure until a per-branch aggregation is worth adding.
    """
    org_id = _clean_id_text(organization_id)
    if not org_id:
        return []

    staff_rows, staff_lookup = _tenant_staff_salary_rows(org_id, branch_id)
    if not staff_rows:
        return []

    branch_text = _resolve_tenant_salary_branch_id(org_id, branch_id)
    config_rows = []
    try:
        query = supabase.table('salary_configs').select('*').eq('organization_id', org_id)
        if branch_text:
            query = query.eq('branch_id', branch_text)
        result = query.execute()
        config_rows = result.data or []
    except Exception as exc:
        if _is_missing_supabase_table(exc):
            logger.warning('salary_configs table is missing; using client_staff.salary as tenant payroll source')
            config_rows = []
        else:
            raise

    config_by_staff = {
        _clean_id_text(row.get('staff_id') or row.get('user_id') or row.get('client_staff_id')): row
        for row in config_rows
        if _clean_id_text(row.get('staff_id') or row.get('user_id') or row.get('client_staff_id'))
    }

    # Live deduction/OT computation — only possible when scoped to one real
    # branch and a period was requested.
    attendance_by_staff: dict[str, list[dict]] = {}
    leaves_by_staff: dict[str, list[dict]] = {}
    overtime_by_staff: dict[str, float] = {}
    period_start_date = period_end_date = None
    period_resolvable = False
    paid_staff_ids: set[str] = set()
    if branch_text and period_start and period_end:
        try:
            period_start_date = date.fromisoformat(period_start)
            period_end_date = date.fromisoformat(period_end)
            attendance_by_staff = support_cp_db.get_staff_attendance_for_payroll_period(
                org_id, branch_text, period_start, period_end
            )
            leaves_by_staff = support_cp_db.get_approved_leaves_for_payroll_period(
                org_id, branch_text, period_start, period_end
            )
            overtime_by_staff = support_cp_db.get_approved_overtime_hours_for_payroll_period(
                org_id, branch_text, period_start, period_end
            )
            local_node_overtime_by_staff = support_cp_db.get_local_node_overtime_hours_for_payroll_period(
                org_id, branch_text, period_start, period_end
            )
            paid_staff_ids = support_cp_db.get_paid_payroll_periods(org_id, period_start, period_end)
            period_resolvable = True
        except Exception:
            logger.exception('Payroll breakdown computation failed for org=%s branch=%s', org_id, branch_text)
            period_resolvable = False


    # Policy resolution is per-staff-member's OWN branch, not the single
    # requested filter branch (branch_text) — a branch-level override must
    # only ever apply to that branch's staff, including when this is an
    # "All Branches" request spanning many branches. get_payroll_policy is
    # cheap-ish but not free (queries payroll_policy_overrides), so it's
    # memoized per distinct branch/staff for this one request rather than
    # called once per staff row.
    policy_cache: dict[tuple[str | None, str | None], dict] = {}

    def _resolve_policy_for(staff_branch_id, staff_id_for_policy):
        cache_key = (staff_branch_id, staff_id_for_policy)
        cached = policy_cache.get(cache_key)
        if cached is None:
            cached = support_cp_db.get_payroll_policy(
                org_id, branch_id=staff_branch_id, staff_id=staff_id_for_policy
            )
            policy_cache[cache_key] = cached
        return cached

    rows = []
    for staff in staff_rows:
        staff_id = _clean_id_text(staff.get('id'))
        overlay = dict(staff)
        overlay.update(config_by_staff.get(staff_id, {}))
        overlay['staff_id'] = staff_id
        overlay['client_staff_id'] = staff_id
        overlay['user_id'] = staff_id
        overlay['name'] = staff.get('name')
        overlay['employee_id'] = staff.get('employee_id')
        overlay['branch_id'] = overlay.get('branch_id') or staff.get('branch_id')
        overlay['branch_name'] = overlay.get('branch_name') or staff.get('branch_name')
        overlay['department'] = overlay.get('department') or staff.get('department_name') or 'General'
        if 'basic_salary' not in overlay or overlay.get('basic_salary') is None:
            overlay['basic_salary'] = staff.get('salary') or 0

        # Resolved unconditionally (not just when a period breakdown runs)
        # so "OT RATE/HR" is always correct, even before a period is picked.
        policy = _resolve_policy_for(_clean_id_text(overlay.get('branch_id')) or None, staff_id)
        effective_ot_rate = support_cp_db.resolve_effective_ot_rate(overlay, policy)

        breakdown = None
        if period_resolvable:
            basic_salary = float(overlay.get('basic_salary') or 0)
            # Real, approved-this-period OT hours from Overtime Management,
            # plus node-classified overtime the local-node payroll-decision
            # screen has approved (never routes through overtime_requests —
            # see get_local_node_overtime_hours_for_payroll_period).
            ot_hours = overtime_by_staff.get(staff_id, 0.0) + local_node_overtime_by_staff.get(staff_id, 0.0)
            breakdown = payroll_engine.compute_payroll_breakdown(
                base_salary=basic_salary,
                ot_hours=ot_hours,
                ot_rate_per_hour=effective_ot_rate,
                period_start=period_start_date,
                period_end=period_end_date,
                policy=policy,
                attendance_rows=attendance_by_staff.get(staff_id, []),
                leave_rows=leaves_by_staff.get(staff_id, []),
            )
            present_dates = {r['date'] for r in attendance_by_staff.get(staff_id, []) if r.get('date')}
            overlay['present_days'] = len(present_dates)
            overlay['ot_hours'] = ot_hours
            overlay['otHours'] = ot_hours

        rows.append(_tenant_salary_map_row(
            overlay, staff_lookup, breakdown=breakdown, paid_staff_ids=paid_staff_ids,
            effective_ot_rate=effective_ot_rate, policy=policy,
        ))

    return rows

def _upsert_tenant_salary_config(data):
    org_id = _clean_id_text(data.get('organization_id') or data.get('org_id'))
    staff_id = _clean_id_text(
        data.get('staff_id')
        or data.get('client_staff_id')
        or data.get('user_id')
    )

    if not org_id:
        raise ValueError('organization_id is required for tenant payroll salary config')
    if not staff_id:
        raise ValueError('user_id/staff_id is required')

    staff_result = (
        supabase.table('client_staff')
        .select('*')
        .eq('org_id', org_id)
        .eq('id', staff_id)
        .limit(1)
        .execute()
    )
    if not staff_result.data:
        raise ValueError('Staff member does not belong to this organization')

    staff = staff_result.data[0]
    branch_id = _resolve_tenant_salary_branch_id(
        org_id,
        data.get('branch_id') or data.get('backend_branch_id') or staff.get('branch_id'),
    ) or staff.get('branch_id')

    # salary_configs.upsert() below is a full-row replace (Postgres upsert
    # semantics, not a patch) — any column not in `payload` gets written as
    # NULL/default, silently erasing it even if a caller never touched it.
    # To make this endpoint safe for partial updates (e.g. the Edit modal
    # saving only basic_salary + an OT rate override, without resending
    # allowances/deductions), pull the existing row first and treat `data`
    # as a sparse patch on top of it: a key present in `data` overrides the
    # existing value; a key absent from `data` keeps whatever is already
    # stored. This is enforced here, once, rather than relying on every
    # caller to always resend the full row.
    #
    # Tolerate a missing salary_configs table the same way the upsert below
    # already does — an org that never had this table yet should still be
    # able to save (falls back to "no existing row", i.e. every field comes
    # from `data`/defaults), not 500.
    existing: dict = {}
    try:
        existing_result = (
            supabase.table('salary_configs')
            .select('basic_salary,allowances,deductions,ot_rate,applied_allowances')
            .eq('organization_id', org_id)
            .eq('staff_id', staff_id)
            .limit(1)
            .execute()
        )
        existing = (existing_result.data or [{}])[0]
    except Exception as exc:
        if not _is_missing_supabase_table(exc):
            raise

    def _patched_float(key, default=0, allow_negative=False):
        """Sparse-patch a numeric column, rejecting negatives by default.

        basic_salary/allowances/ot_rate are all multiplied by days or hours
        worked in payroll_engine, so a negative doesn't produce a small
        error — it inverts the sign of the period calculation. net_pay is
        floored at 0, which makes the corruption silent: the employee
        simply earns nothing. Reductions belong in `deductions`, which is
        the one field where a caller could legitimately mean "subtract".
        """
        if key in data:
            raw = data.get(key)
            try:
                value = float(raw or 0)
            except (TypeError, ValueError):
                raise ValueError(f'{key} must be a number')
        else:
            existing_value = existing.get(key)
            value = float(existing_value) if existing_value is not None else default

        if value != value or value in (float('inf'), float('-inf')):
            raise ValueError(f'{key} must be a finite number')
        if value < 0 and not allow_negative:
            raise ValueError(f'{key} cannot be negative')
        return value

    basic_salary = _patched_float('basic_salary', default=float(staff.get('salary') or 0))
    allowances = _patched_float('allowances')
    deductions = _patched_float('deductions')
    ot_rate = _patched_float('ot_rate')

    # applied_allowances is jsonb, not a float -- same sparse-patch rule as
    # the numeric fields above: a key present in `data` replaces it wholesale
    # (the Edit modal always sends its complete current selection, same
    # contract as save_payroll_policy), a key absent from `data` keeps
    # whatever is already stored (e.g. an unrelated basic_salary-only save
    # from an older client build must not silently clear allowances).
    if 'applied_allowances' in data:
        applied_allowances = data.get('applied_allowances')
        applied_allowances = applied_allowances if isinstance(applied_allowances, dict) else {}
    else:
        existing_applied = existing.get('applied_allowances')
        applied_allowances = existing_applied if isinstance(existing_applied, dict) else {}

    now = datetime.now(timezone.utc).isoformat()

    # Keep client_staff.salary in sync because it is the base tenant payroll source.
    supabase.table('client_staff').update({
        'salary': basic_salary,
        'updated_at': now,
    }).eq('org_id', org_id).eq('id', staff_id).execute()

    payload = {
        'organization_id': org_id,
        'staff_id': staff_id,
        'branch_id': _clean_id_text(branch_id) or None,
        'staff_name': _clean_id_text(data.get('staff_name') or data.get('name') or staff.get('name')) or None,
        'department': _clean_id_text(data.get('department') or staff.get('department_name') or staff.get('department')) or None,
        'branch_name': _clean_id_text(data.get('branch_name') or staff.get('branch_name')) or None,
        'basic_salary': basic_salary,
        'allowances': allowances,
        'applied_allowances': applied_allowances,
        'deductions': deductions,
        'ot_rate': ot_rate,
        'effective_from': data.get('effective_from') or None,
        'updated_at': now,
    }

    try:
        result = (
            supabase.table('salary_configs')
            .upsert(payload, on_conflict='organization_id,staff_id')
            .execute()
        )
        row = (result.data or [payload])[0]
    except Exception as exc:
        if _is_missing_supabase_table(exc):
            logger.warning('salary_configs table is missing; saved payroll base salary to client_staff only')
            row = payload
        else:
            raise

    refreshed_staff = dict(staff)
    refreshed_staff['salary'] = basic_salary
    refreshed_staff['branch_id'] = branch_id
    # Needed so a just-saved applied_allowances actually resolves to a real
    # amount in this response (the allowance catalog — labels/mode/value —
    # lives on the policy, not on the salary_configs row itself).
    save_policy = support_cp_db.get_payroll_policy(org_id, branch_id=branch_id, staff_id=staff_id)
    # No effective_ot_rate passed here: _tenant_salary_map_row falls back to
    # the raw ot_rate just written, which is correct immediately after a
    # staff-level save (an explicit override is, by definition, the new
    # effective rate). The frontend also force-refreshes the page right
    # after this call (see usePayrollData.updateBaseSalary), which re-pulls
    # the fully policy-resolved value from get_client_payroll_page — so this
    # response only needs to be right for the instant before that refetch
    # lands, not authoritative long-term.
    return _tenant_salary_map_row(row, {staff_id: refreshed_staff}, policy=save_policy)

# ============================================
# SALARY ENDPOINTS
# ============================================
@app.route('/api/salary', methods=['GET'])
@require_client_dashboard_admin
def api_get_all_salary():
    """org_id is pinned to the authenticated admin's dashboard token, never
    the query string -- previously this route trusted organization_id
    straight off the query string with no auth at all, exposing every
    tenant's full compensation table to any caller. Compensation data is
    admin-only (not just any authenticated dashboard user) -- see
    api_get_payroll_policy's rationale, same boundary applies here.

    Also fixes the underlying crash: the legacy-org branch below was never
    written, so a numeric org_id fell off the end of the function with no
    return, which Flask turned into a 500 that leaked a traceback. There is
    no active tenant on legacy SQLite today, but db.get_all_salary_configs
    already exists and is now wired up for structural parity with
    api_get_staff, instead of leaving a silent crash in its place."""
    dashboard_user = g.dashboard_user
    raw_organization_id = str(dashboard_user.get('org_id') or '').strip()
    raw_branch_id = request.args.get('branch_id') or dashboard_user.get('branch_id')
    raw_period_start = request.args.get('period_start')
    raw_period_end = request.args.get('period_end')

    if not raw_organization_id:
        return jsonify({
            'success': False,
            'error': 'organization_id is required.',
        }), 400

    if raw_period_start and raw_period_end:
        date_error = _validate_payroll_period_order(raw_period_start, raw_period_end)
        if date_error:
            return jsonify({'success': False, 'error': date_error}), 400

    # Support-created tenants use UUID organization IDs. Those read only
    # from Supabase salary_configs. Never fall back to legacy SQLite payroll,
    # because that is exactly how a newly-created organization would see
    # stale/unrelated data.
    if _salary_request_is_supabase_scoped(raw_organization_id):
        return jsonify(
            _tenant_salary_configs(
                raw_organization_id,
                raw_branch_id,
                period_start=raw_period_start,
                period_end=raw_period_end,
            )
        ), 200

    salary_configs = db.get_all_salary_configs(
        organization_id=_positive_int(raw_organization_id),
        branch_id=_positive_int(raw_branch_id),
    )
    return jsonify(salary_configs), 200


@app.route('/api/payroll/policy', methods=['GET'])
@require_client_dashboard_auth
def api_get_payroll_policy():
    """org_id is pinned to the authenticated dashboard session, never the
    query string -- same tenant boundary api_get_leaves / api_get_leave_types
    enforce. Previously this route trusted organization_id straight off the
    query string with no auth at all, which let any caller read (and, via
    the PUT below, overwrite) another tenant's payroll policy -- including
    leaveTypeRules, the single source of truth the Leave Management filter
    and mobile Apply-for-Leave form both read. Fixed to match every other
    client-facing route in this file."""
    dashboard_user = g.dashboard_user
    org_id = str(dashboard_user.get('org_id') or '').strip()
    if not org_id:
        return jsonify({'success': False, 'error': 'organization_id is required'}), 400
    # branch_id/staff_id are optional scoping — omitted, this returns the
    # org-wide default (unchanged contract). staff_id, if present, also
    # folds in that individual's own override; see get_payroll_policy's
    # fallback chain (individual > branch > org default).
    branch_id = _clean_id_text(request.args.get('branch_id') or request.args.get('branchId')) or None
    staff_id = _clean_id_text(request.args.get('staff_id') or request.args.get('staffId')) or None
    policy = support_cp_db.get_payroll_policy(org_id, branch_id=branch_id, staff_id=staff_id)
    return jsonify({'success': True, 'policy': policy}), 200


@app.route('/api/payroll/policy', methods=['PUT'])
@require_client_dashboard_auth
def api_save_payroll_policy():
    """org_id is pinned to the authenticated dashboard session, never the
    request body -- see api_get_payroll_policy above for why this changed.
    A value in the body is ignored for scoping so a caller can never write
    into another org's payroll policy by editing the payload."""
    data = request.get_json(silent=True) or {}
    dashboard_user = g.dashboard_user
    org_id = str(dashboard_user.get('org_id') or '').strip()
    if not org_id:
        return jsonify({'success': False, 'error': 'organization_id is required'}), 400
    policy = data.get('policy') or {}
    # Same scoping as GET: omit both to edit the org-wide default (the
    # existing Payroll Rules modal keeps working exactly as before). Pass
    # branch_id to set a branch override, or staff_id for an individual
    # override — see save_payroll_policy for precedence.
    branch_id = _clean_id_text(data.get('branch_id') or data.get('branchId')) or None
    staff_id = _clean_id_text(data.get('staff_id') or data.get('staffId')) or None
    try:
        saved = support_cp_db.save_payroll_policy(org_id, policy, branch_id=branch_id, staff_id=staff_id)
        return jsonify({'success': True, 'policy': saved}), 200
    except ValueError as exc:
        return jsonify({'success': False, 'error': str(exc)}), 400


# After
def _validate_payroll_period_order(period_start: str, period_end: str) -> str | None:
    """Returns an error message if period_end is before period_start (or
    either string isn't a valid ISO date), else None. Route-level guard for
    api_mark_payroll_paid/api_mark_payroll_pending, checked BEFORE
    _compute_staff_payroll_breakdown ever runs -- that function swallows
    every exception (including payroll_engine's own ValueError on an
    inverted period) and returns None, which mark_payroll_paid treats as
    "no snapshot" rather than "reject this request". Rejecting invalid
    input at the door here means we never rely on that broad except to
    also do this route's input validation for it.
    """
    try:
        start = date.fromisoformat(period_start)
        end = date.fromisoformat(period_end)
    except ValueError:
        return 'period_start and period_end must be valid ISO dates (YYYY-MM-DD).'
    if end < start:
        return f'period_end ({period_end}) cannot be before period_start ({period_start}).'
    return None


def _compute_staff_payroll_breakdown(org_id: str, staff_id: str, period_start: str, period_end: str) -> dict | None:
    """Recompute one staff member's PayrollBreakdown for a period, used only
    to snapshot it into payroll_payments at mark-paid time. Returns None if
    the staff row or branch can't be resolved — mark_payroll_paid treats
    that as 'no snapshot', not a failure to mark paid."""
    staff_result = (
        supabase.table('client_staff').select('*')
        .eq('org_id', org_id).eq('id', staff_id).limit(1).execute()
    )
    if not staff_result.data:
        return None
    staff = staff_result.data[0]
    branch_id = _clean_id_text(staff.get('branch_id'))
    if not branch_id:
        return None
    try:
        policy = support_cp_db.get_payroll_policy(org_id, branch_id=branch_id, staff_id=staff_id)
        attendance = support_cp_db.get_staff_attendance_for_payroll_period(org_id, branch_id, period_start, period_end)
        leaves = support_cp_db.get_approved_leaves_for_payroll_period(org_id, branch_id, period_start, period_end)
        overtime = support_cp_db.get_approved_overtime_hours_for_payroll_period(org_id, branch_id, period_start, period_end)
        local_node_overtime = support_cp_db.get_local_node_overtime_hours_for_payroll_period(org_id, branch_id, period_start, period_end)
        breakdown = payroll_engine.compute_payroll_breakdown(
            base_salary=float(staff.get('salary') or 0),
            ot_hours=overtime.get(staff_id, 0.0) + local_node_overtime.get(staff_id, 0.0),
            ot_rate_per_hour=float(policy.get('otRatePerHour') or 0),
            period_start=date.fromisoformat(period_start),
            period_end=date.fromisoformat(period_end),
            policy=policy,
            attendance_rows=attendance.get(staff_id, []),
            leave_rows=leaves.get(staff_id, []),
        )
        return breakdown.to_dict()
    except Exception:
        logger.exception('Breakdown snapshot failed for staff=%s period=%s..%s', staff_id, period_start, period_end)
        return None


@app.route('/api/payroll/mark-paid', methods=['POST'])
@require_client_dashboard_admin
def api_mark_payroll_paid():
    """org_id is pinned to the authenticated dashboard session, never the
    request body -- same tenant boundary api_save_payroll_policy enforces.
    Previously this route had no auth at all and took organization_id
    straight off the body, so anyone could flip any org's payroll rows to
    Paid (and snapshot a computed breakdown into payroll_payments) without
    a session. Admin rather than plain auth: this is a financial-record
    mutation, same tier as api_set_salary / api_get_all_salary. Reading the
    payroll page (/api/v2/payroll/page) stays on plain auth -- unchanged.
    """
    data = request.get_json(silent=True) or {}
    org_id = _clean_id_text(g.dashboard_user.get('org_id'))
    staff_id = _clean_id_text(data.get('staff_id') or data.get('staffId'))
    period_start = _clean_id_text(data.get('period_start') or data.get('periodStart'))
    period_end = _clean_id_text(data.get('period_end') or data.get('periodEnd'))
    if not (org_id and staff_id and period_start and period_end):
        return jsonify({'success': False, 'error': 'organization_id, staff_id, period_start, and period_end are required'}), 400
    date_error = _validate_payroll_period_order(period_start, period_end)
    if date_error:
        return jsonify({'success': False, 'error': date_error}), 400
    breakdown = _compute_staff_payroll_breakdown(org_id, staff_id, period_start, period_end)
    support_cp_db.mark_payroll_paid(org_id, staff_id, period_start, period_end, breakdown=breakdown)
    clear_fast_cache()
    return jsonify({'success': True, 'status': 'Paid'}), 200


@app.route('/api/payroll/mark-pending', methods=['POST'])
@require_client_dashboard_admin
def api_mark_payroll_pending():
    """Unauthenticated sibling of mark-paid above -- same fix, same reason.
    Not in the original audit report, but reachable by exactly the same
    request with one word changed in the path."""
    data = request.get_json(silent=True) or {}
    org_id = _clean_id_text(g.dashboard_user.get('org_id'))
    staff_id = _clean_id_text(data.get('staff_id') or data.get('staffId'))
    period_start = _clean_id_text(data.get('period_start') or data.get('periodStart'))
    period_end = _clean_id_text(data.get('period_end') or data.get('periodEnd'))
    if not (org_id and staff_id and period_start and period_end):
        return jsonify({'success': False, 'error': 'organization_id, staff_id, period_start, and period_end are required'}), 400
    date_error = _validate_payroll_period_order(period_start, period_end)
    if date_error:
        return jsonify({'success': False, 'error': date_error}), 400
    support_cp_db.mark_payroll_pending(org_id, staff_id, period_start, period_end)
    clear_fast_cache()
    return jsonify({'success': True, 'status': 'Pending'}), 200



@app.route('/api/salary/<user_id>', methods=['GET'])
@require_client_dashboard_admin
def api_get_salary(user_id):
    """org_id is pinned to the authenticated admin's token, never the query
    string -- same boundary as GET /api/salary. The legacy branch also
    verifies the target user actually belongs to the caller's org before
    returning anything: get_salary_config() itself has no org filter (it
    only takes a user_id), so without this check an org-A admin could read
    org-B's compensation data just by guessing a numeric user_id."""
    dashboard_user = g.dashboard_user
    raw_organization_id = str(dashboard_user.get('org_id') or '').strip()

    if _salary_request_is_supabase_scoped(raw_organization_id, user_id):
        rows = _tenant_salary_configs(raw_organization_id)
        match = next((row for row in rows if str(row.get('user_id')) == str(user_id)), None)
        return jsonify(match or {}), 200

    target_user = db.get_user_by_id(int(user_id))
    if not target_user or not _dashboard_target_org_matches(
        dashboard_user, target_user.get('organization_id')
    ):
        return jsonify({'error': 'Not found'}), 404

    return jsonify(db.get_salary_config(int(user_id)) or {})


@app.route('/api/salary', methods=['POST'])
@app.route('/api/salary/<user_id>', methods=['PUT'])
@require_client_dashboard_admin
def api_set_salary(user_id=None):
    """org_id is pinned to the authenticated admin's token, never the
    request body -- previously organization_id came straight from the
    payload, so a caller could set it to any org and (paired with a
    staff_id from that org) write into a tenant they don't administer.
    _upsert_tenant_salary_config's own org<->staff ownership check only
    verifies internal consistency of the payload, not that the org is the
    caller's; pinning org_id here closes that gap without touching that
    function. Same fix shape as api_save_payroll_policy above."""
    data = request.get_json() or {}
    user_id = user_id or data.get('user_id')

    if not user_id:
        return jsonify({'success': False, 'message': 'user_id required'}), 400

    dashboard_user = g.dashboard_user
    raw_organization_id = str(dashboard_user.get('org_id') or '').strip()

    if _salary_request_is_supabase_scoped(raw_organization_id, user_id):
        try:
            data['user_id'] = str(user_id)
            data['organization_id'] = raw_organization_id
            salary = _upsert_tenant_salary_config(data)
            return jsonify({'success': True, 'salary': salary}), 200
        except ValueError as exc:
            return jsonify({'success': False, 'message': str(exc)}), 400
        except Exception as exc:
            logger.exception('Tenant salary config save failed')
            return jsonify({'success': False, 'message': str(exc)}), 500

    target_user = db.get_user_by_id(int(user_id))
    if not target_user or not _dashboard_target_org_matches(
        dashboard_user, target_user.get('organization_id')
    ):
        return jsonify({'success': False, 'message': 'Staff member not found.'}), 404

    success = db.set_salary_config(
        user_id=int(user_id),
        basic_salary=float(data.get('basic_salary', 0) or 0),
        allowances=float(data.get('allowances', 0) or 0),
        deductions=float(data.get('deductions', 0) or 0),
        ot_rate=float(data.get('ot_rate', 0) or 0),
        effective_from=data.get('effective_from'),
    )

    if not success:
        return jsonify({
            'success': False,
            'message': 'Failed to save salary config',
        }), 500

    return jsonify({
        'success': True,
        'salary': db.get_salary_config(int(user_id)) or {},
    }), 200


# ============================================
# LEGACY ROUTES (for backward compatibility)
# ============================================

@app.route('/get_staff_list')
def legacy_staff_list():
    return jsonify({
        'success': False,
        'error': 'This endpoint has been retired. Use GET /api/staff instead.',
    }), 410


@app.route('/add_staff', methods=['POST', 'OPTIONS'])
def legacy_add_staff():
    return jsonify({
        'success': False,
        'error': 'Use /api/staff so organization and branch scope are preserved.',
    }), 410

@app.route('/get_attendance_today')
def legacy_get_attendance_today():
    return jsonify({
        'success': False,
        'error': 'This endpoint has been retired. Use GET /api/attendance/today instead.',
    }), 410


@app.route('/get_attendance_today_array')
def legacy_attendance_today_array():
    return jsonify({
        'success': False,
        'error': 'This endpoint has been retired. Use GET /api/attendance/today instead.',
    }), 410


@app.route('/get_pending_leaves')
def legacy_pending_leaves():
    return jsonify({
        'success': False,
        'error': 'This endpoint has been retired. Use GET /api/leaves?status=pending instead.',
    }), 410


@app.route('/update_leave_status', methods=['POST'])
def legacy_update_leave():
    return jsonify({
        'success': False,
        'error': 'This endpoint has been retired. Use the authenticated /api/leaves/<id> update route instead.',
    }), 410


@app.route('/get_detected_name/all')
def legacy_detected_name_all():
    return jsonify({
        'success': False,
        'error': 'This endpoint has been retired. Use GET /api/live-detections instead.',
    }), 410


@app.route('/get_detected_name/nvr')
def legacy_detected_name_nvr():
    return jsonify({
        'success': False,
        'error': 'This endpoint has been retired. Use GET /api/live-detections instead.',
    }), 410


@app.route('/get_detected_name/dvr')
def legacy_detected_name_dvr():
    return jsonify({
        'success': False,
        'error': 'This endpoint has been retired. Use GET /api/live-detections instead.',
    }), 410


@app.route('/get_staff_by_name')
def legacy_get_staff_by_name():
    return jsonify({
        'success': False,
        'error': 'This endpoint has been retired. Use GET /api/staff instead.',
    }), 410


@app.route('/get_attendance_by_name')
def legacy_get_attendance_by_name():
    return jsonify({
        'success': False,
        'error': 'This endpoint has been retired. Use GET /api/attendance/logs instead.',
    }), 410

@app.route('/video_feed/<camera_id>')
def legacy_video_feed(camera_id):
    """
    Legacy compatibility route.
    Uses configured backend camera IDs only.
    """
    return video_stream(camera_id)


@app.route('/api/branches/summary', methods=['GET'])
@require_client_dashboard_auth
def api_get_branch_summary():
    """Return backend-connected global branch comparison metrics.

    UUID org IDs come from Support Dashboard/Supabase client organizations.
    Numeric org IDs keep the legacy SQLite path.
    """
    try:
        # organization_id always comes from the verified token, never the
        # query string — same discipline as every other route here.
        raw_organization_id = str(g.dashboard_user.get('org_id') or '').strip()
        people_type = (
            request.args.get('people_type')
            or request.args.get('peopleType')
            or ''
        ).strip()

        if not raw_organization_id:
            return jsonify({
                'success': False,
                'error': 'organization_id is required',
            }), 400

        # Support-created organizations use Supabase UUIDs.
        # Do not send them into legacy int() SQLite helpers.
        try:
            numeric_org_id = int(raw_organization_id)
        except (TypeError, ValueError):
            numeric_org_id = None

        if numeric_org_id is None:
            summary = support_cp_db.get_client_branch_summary(
                raw_organization_id,
                people_type=people_type or None,
            )
            return jsonify({
                'success': True,
                **summary,
            }), 200

        organization_id = _resolve_organization_id(
            {'organization_id': numeric_org_id},
            user_id=request.args.get('user_id'),
        )

        if not organization_id:
            return jsonify({
                'success': False,
                'error': 'organization_id is required',
            }), 400

        summary = db.get_branch_comparison_summary(int(organization_id), people_type=people_type or None)

        return jsonify({
            'success': True,
            **summary,
        }), 200

    except Exception as e:
        logger.exception('Failed to load branch comparison summary')
        return jsonify({
            'success': False,
            'error': str(e),
        }), 500



# ============================================
# LEGAL DOCUMENT ENDPOINTS — retired 2026-08.
# Terms of Service / Privacy Policy pages, their API, and the Legal/
# frontend module were removed entirely (unauthenticated read+write,
# no active tenant depended on it; see security-remediation Tier 2).
# Stub kept only so any stale client build gets a clear signal instead
# of a raw connection error.
# ============================================

@app.route('/api/legal/<document_type>', methods=['GET', 'POST', 'PUT', 'PATCH'])
def api_legal_document_retired(document_type):
    return jsonify({
        'success': False,
        'error': 'This endpoint has been retired.',
    }), 410


# ============================================
# NOTIFICATION ENDPOINTS
# ============================================

@app.route('/api/notifications', methods=['GET'])
@require_client_dashboard_auth
def api_get_notifications():
    raw_user_id = request.args.get('user_id')
    raw_organization_id = request.args.get('organization_id')
    unread_only = str(request.args.get('unread_only', '')).lower() in {'1', 'true', 'yes'}
    limit = request.args.get('limit', 50, type=int)

    if not _clean_id_text(raw_user_id):
        return jsonify({
            'success': False,
            'error': 'user_id is required',
        }), 400

    if not _dashboard_user_owns_notification_inbox(g.dashboard_user, raw_user_id):
        return jsonify({'success': False, 'error': 'Not authorized to access this inbox.'}), 403

    # Client Dashboard users are UUID Supabase users — read from the
    # Supabase-native notifications/notification_recipients tables (see
    # support_db_notifications.py), org/branch/UUID-scoped.
    if _salary_request_is_supabase_scoped(raw_organization_id, raw_user_id):
        notifications = notifications_db.list_notifications(
            raw_organization_id, raw_user_id, unread_only=unread_only, limit=limit,
        )
        return jsonify({
            'success': True,
            'notifications': notifications,
            'unread_count': notifications_db.get_unread_count(raw_organization_id, raw_user_id),
        }), 200

    if not _is_positive_intlike(raw_user_id) or (
        raw_organization_id and not _is_positive_intlike(raw_organization_id)
    ):
        return jsonify({
            'success': True,
            'notifications': [],
            'unread_count': 0,
        }), 200

    user_id = int(raw_user_id)
    organization_id = _notification_int(raw_organization_id)

    notifications = db.get_notifications_for_user(
        user_id=user_id,
        organization_id=organization_id,
        unread_only=unread_only,
        limit=limit,
    )

    return jsonify({
        'success': True,
        'notifications': notifications,
        'unread_count': db.get_unread_notification_count(
            user_id,
            organization_id=organization_id,
        ),
    }), 200


@app.route('/api/notifications/unread-count', methods=['GET'])
@require_client_dashboard_auth
def api_get_notifications_unread_count():
    raw_user_id = request.args.get('user_id')
    raw_organization_id = request.args.get('organization_id')

    if not _clean_id_text(raw_user_id):
        return jsonify({
            'success': False,
            'error': 'user_id is required',
        }), 400

    if not _dashboard_user_owns_notification_inbox(g.dashboard_user, raw_user_id):
        return jsonify({'success': False, 'error': 'Not authorized to access this inbox.'}), 403

    if _salary_request_is_supabase_scoped(raw_organization_id, raw_user_id):
        return jsonify({
            'success': True,
            'unread_count': notifications_db.get_unread_count(raw_organization_id, raw_user_id),
        }), 200

    if not _is_positive_intlike(raw_user_id) or (
        raw_organization_id and not _is_positive_intlike(raw_organization_id)
    ):
        return jsonify({'success': True, 'unread_count': 0}), 200

    user_id = int(raw_user_id)
    organization_id = _notification_int(raw_organization_id)

    return jsonify({
        'success': True,
        'unread_count': db.get_unread_notification_count(
            user_id,
            organization_id=organization_id,
        ),
    }), 200


@app.route('/api/notifications/<int:notification_id>/read', methods=['POST', 'PUT', 'PATCH'])
@require_client_dashboard_auth
def api_mark_notification_read(notification_id):
    data = request.get_json(silent=True) or {}
    raw_user_id = data.get('user_id') or request.args.get('user_id')
    raw_organization_id = data.get('organization_id') or request.args.get('organization_id')

    if not _clean_id_text(raw_user_id):
        return jsonify({
            'success': False,
            'error': 'user_id is required',
        }), 400

    if not _dashboard_user_owns_notification_inbox(g.dashboard_user, raw_user_id):
        return jsonify({'success': False, 'error': 'Not authorized to access this inbox.'}), 403

    if _salary_request_is_supabase_scoped(raw_organization_id, raw_user_id):
        if not _clean_id_text(raw_organization_id):
            return jsonify({'success': False, 'error': 'organization_id is required'}), 400
        ok = notifications_db.mark_read(raw_organization_id, notification_id, raw_user_id)
        if not ok:
            return jsonify({'success': False, 'error': 'Notification not found for this user.'}), 404
        return jsonify({'success': True}), 200

    if not _is_positive_intlike(raw_user_id):
        return jsonify({'success': True}), 200

    ok = db.mark_notification_read(
        notification_id=int(notification_id),
        user_id=int(raw_user_id),
    )

    if not ok:
        return jsonify({
            'success': False,
            'error': 'Notification not found for this user.',
        }), 404

    return jsonify({'success': True}), 200


@app.route('/api/notifications/mark-all-read', methods=['POST', 'PUT', 'PATCH'])
@require_client_dashboard_auth
def api_mark_all_notifications_read():
    data = request.get_json(silent=True) or {}
    raw_user_id = data.get('user_id') or request.args.get('user_id')
    raw_organization_id = data.get('organization_id') or request.args.get('organization_id')

    if not _clean_id_text(raw_user_id):
        return jsonify({
            'success': False,
            'error': 'user_id is required',
        }), 400

    if not _dashboard_user_owns_notification_inbox(g.dashboard_user, raw_user_id):
        return jsonify({'success': False, 'error': 'Not authorized to access this inbox.'}), 403

    if _salary_request_is_supabase_scoped(raw_organization_id, raw_user_id):
        if not _clean_id_text(raw_organization_id):
            return jsonify({'success': False, 'error': 'organization_id is required'}), 400
        updated = notifications_db.mark_all_read(raw_organization_id, raw_user_id)
        return jsonify({'success': True, 'updated_count': updated}), 200

    if not _is_positive_intlike(raw_user_id) or (
        raw_organization_id and not _is_positive_intlike(raw_organization_id)
    ):
        return jsonify({'success': True, 'updated_count': 0}), 200

    user_id = int(raw_user_id)
    organization_id = _notification_int(raw_organization_id)

    updated_count = db.mark_all_notifications_read(
        user_id=user_id,
        organization_id=organization_id,
    )

    return jsonify({
        'success': True,
        'updated_count': updated_count,
    }), 200


@app.route('/api/notifications/<int:notification_id>/delete', methods=['POST'])
@require_client_dashboard_auth
def api_delete_notification(notification_id):
    data = request.get_json(silent=True) or {}
    raw_user_id = data.get('user_id') or request.args.get('user_id')
    raw_organization_id = data.get('organization_id') or request.args.get('organization_id')

    if not _clean_id_text(raw_user_id):
        return jsonify({
            'success': False,
            'error': 'user_id is required',
        }), 400

    if not _dashboard_user_owns_notification_inbox(g.dashboard_user, raw_user_id):
        return jsonify({'success': False, 'error': 'Not authorized to access this inbox.'}), 403

    if _salary_request_is_supabase_scoped(raw_organization_id, raw_user_id):
        if not _clean_id_text(raw_organization_id):
            return jsonify({'success': False, 'error': 'organization_id is required'}), 400
        deleted = notifications_db.delete_notification(
            raw_organization_id,
            notification_id,
            raw_user_id,
        )
        if not deleted:
            return jsonify({'success': False, 'error': 'Notification not found for this user.'}), 404
        return jsonify({'success': True}), 200

    if not _is_positive_intlike(raw_user_id) or (
        raw_organization_id and not _is_positive_intlike(raw_organization_id)
    ):
        return jsonify({'success': True}), 200

    user_id = int(raw_user_id)
    organization_id = _notification_int(raw_organization_id)

    deleted = db.delete_notification(
        int(notification_id),
        user_id,
        organization_id,
    )
    if not deleted:
        return jsonify({
            'success': False,
            'error': 'Notification not found for this user.',
        }), 404
    return jsonify({'success': True}), 200


@app.route('/api/notifications/bulk-delete', methods=['POST'])
@require_client_dashboard_auth
def api_bulk_delete_notifications():
    data = request.get_json(silent=True) or {}
    notification_ids = data.get('notification_ids') or []
    raw_user_id = data.get('user_id') or request.args.get('user_id')
    raw_organization_id = data.get('organization_id') or request.args.get('organization_id')

    if not _clean_id_text(raw_user_id):
        return jsonify({
            'success': False,
            'error': 'user_id is required',
        }), 400

    if not _dashboard_user_owns_notification_inbox(g.dashboard_user, raw_user_id):
        return jsonify({'success': False, 'error': 'Not authorized to access this inbox.'}), 403

    if _salary_request_is_supabase_scoped(raw_organization_id, raw_user_id):
        if not _clean_id_text(raw_organization_id):
            return jsonify({'success': False, 'error': 'organization_id is required'}), 400
        deleted_count = notifications_db.bulk_delete_notifications(
            raw_organization_id,
            [int(i) for i in notification_ids if isinstance(i, (int, str)) and str(i).isdigit()],
            raw_user_id,
        )
        return jsonify({'success': True, 'deleted_count': deleted_count}), 200

    if not _is_positive_intlike(raw_user_id) or (
        raw_organization_id and not _is_positive_intlike(raw_organization_id)
    ):
        return jsonify({'success': True, 'deleted_count': 0}), 200

    user_id = int(raw_user_id)
    organization_id = _notification_int(raw_organization_id)
    deleted_count = db.bulk_delete_notifications(
        [int(i) for i in notification_ids if isinstance(i, (int, str)) and str(i).isdigit()],
        user_id,
        organization_id,
    )
    return jsonify({'success': True, 'deleted_count': deleted_count}), 200


# ─── Attendance exceptions (late check-in / early-or-late check-out review) ──

@app.route('/api/client/attendance/exceptions', methods=['GET'])
@require_client_dashboard_auth
def api_list_attendance_exceptions():
    """Every attendance row still awaiting admin resolution — the source of
    truth for the Attendance Exceptions screen (not just the notification
    feed, so a dismissed notification never hides a still-pending row)."""
    # organization_id always comes from the verified token, never the
    # query string.
    org_id = g.dashboard_user.get('org_id')
    branch_id = g.dashboard_user.get('branch_id') or request.args.get('branch_id')
    if not _clean_id_text(org_id):
        return jsonify({'success': False, 'error': 'organization_id is required'}), 400
    try:
        rows = attendance_exceptions_db.list_pending_exceptions(org_id, branch_id)
        return jsonify({'success': True, 'exceptions': rows}), 200
    except Exception:
        logger.exception('Failed to list attendance exceptions')
        return jsonify({'success': False, 'error': 'Internal server error'}), 500


@app.route('/api/client/attendance/<attendance_id>/resolve', methods=['POST'])
@require_client_dashboard_admin
def api_resolve_attendance_exception(attendance_id):
    """Admin decision on a held check-in or check-out.

    Body: { leg: 'check_in'|'check_out',
            decision: see support_db_attendance_exceptions.resolve_attendance_exception,
            note?: str }
    """
    payload = request.get_json(silent=True) or {}
    # organization_id and resolved_by always come from the verified admin
    # token, never the request body.
    org_id = g.dashboard_user.get('org_id')
    if not _clean_id_text(org_id):
        return jsonify({'success': False, 'error': 'organization_id is required'}), 400
    try:
        row = attendance_exceptions_db.resolve_attendance_exception(
            org_id,
            attendance_id,
            payload.get('leg'),
            payload.get('decision'),
            note=payload.get('note'),
            resolved_by=g.dashboard_user.get('id'),
        )
        return jsonify({'success': True, 'attendance': row}), 200
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception:
        logger.exception('Failed to resolve attendance exception')
        return jsonify({'success': False, 'error': 'Internal server error'}), 500



# ============================================
# NODE SYNC API — Railway boundary for local/cloud nodes
# ============================================

def _node_api_key_from_request():
    auth = request.headers.get('Authorization') or ''
    if auth.lower().startswith('bearer '):
        return auth.split(' ', 1)[1].strip()
    return (
        request.headers.get('X-Node-API-Key')
        or request.headers.get('x-node-api-key')
        or ''
    ).strip()


@app.route('/v1/activate', methods=['POST'])
def v1_activate_node():
    """Installer exchanges one-time install_token for scoped node_api_key."""
    data = request.get_json(silent=True) or {}
    install_token = data.get('install_token') or data.get('token')
    node_label = data.get('node_label') or data.get('node_id')

    if not install_token:
        return jsonify({'success': False, 'message': 'install_token is required'}), 400

    try:
        activated = support_cp_db.activate_node_with_install_token(
            install_token=str(install_token),
            node_label=str(node_label).strip() if node_label else None,
            railway_api_base_url=request.host_url.rstrip('/'),
        )
        return jsonify({'success': True, **activated}), 200
    except ValueError as e:
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 400
    except Exception as e:
        logger.exception('Node activation failed')
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 500


@app.route('/v1/node/heartbeat', methods=['POST'])
def v1_node_heartbeat():
    node_key = _node_api_key_from_request()
    data = request.get_json(silent=True) or {}
    try:
        result = support_cp_db.node_heartbeat(node_key, data)
        return jsonify(result), 200
    except ValueError as e:
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 401
    except Exception as e:
        logger.exception('Node heartbeat failed')
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 500


@app.route('/v1/node/config', methods=['GET'])
def v1_node_config():
    node_key = _node_api_key_from_request()
    try:
        config = support_cp_db.get_node_config(node_key)
        return jsonify({'success': True, 'config': config}), 200
    except ValueError as e:
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 401
    except Exception as e:
        logger.exception('Node config failed')
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 500


@app.route('/v1/node/push-attendance', methods=['POST'])
def v1_node_push_attendance():
    node_key = _node_api_key_from_request()
    data = request.get_json(silent=True) or {}
    try:
        result = support_cp_db.push_node_attendance(node_key, data)
        return jsonify({'success': True, **result}), 200
    except ValueError as e:
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 401
    except Exception as e:
        logger.exception('Node push attendance failed')
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 500


@app.route('/v1/node/push-embeddings', methods=['POST'])
def v1_node_push_embeddings():
    node_key = _node_api_key_from_request()
    data = request.get_json(silent=True) or {}
    try:
        result = support_cp_db.push_node_embeddings(node_key, data)
        return jsonify({'success': True, **result}), 200
    except ValueError as e:
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 401
    except Exception as e:
        logger.exception('Node push embeddings failed')
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 500


@app.route('/v1/node/poll-manual-instructions', methods=['GET'])
def v1_node_poll_manual_instructions():
    node_key = _node_api_key_from_request()
    try:
        node = support_cp_db.get_node_by_api_key(node_key)
        org_id = str(node.get('org_id'))
        branch_id = str(node.get('branch_id'))
        instructions = attendance_settings_db.list_pending_manual_instructions_for_branch(org_id, branch_id)
        return jsonify({'success': True, 'manual_instructions': instructions}), 200
    except ValueError as e:
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 401
    except Exception as e:
        logger.exception('Node poll manual instructions failed')
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 500


@app.route('/v1/node/ack-manual-instruction', methods=['POST'])
def v1_node_ack_manual_instruction():
    node_key = _node_api_key_from_request()
    data = request.get_json(silent=True) or {}
    instruction_id = data.get('instruction_id') or data.get('id')
    status = data.get('status')
    note = data.get('note') or data.get('notes')
    if not instruction_id or not status:
        return jsonify({'success': False, 'message': 'instruction_id and status are required'}), 400
    try:
        node = support_cp_db.get_node_by_api_key(node_key)
        org_id = str(node.get('org_id'))
        updated = attendance_settings_db.update_manual_instruction_status(org_id, instruction_id, status, note)
        return jsonify({'success': True, 'instruction': updated}), 200
    except ValueError as e:
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 400
    except Exception as e:
        logger.exception('Node ack manual instruction failed')
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 500

@app.route('/api/v2/dashboard/overview', methods=['GET'])
@require_client_dashboard_auth
def api_v2_dashboard_overview():
    """
    Fast dashboard overview snapshot.

    This route must stay aggregate-first:
    - no full staff table loading
    - no payroll full table loading
    - no attendance full table loading
    - no leave full table loading
    - no fake delay

    SECURITY: org_id/branch_id are pinned to the verified Client Dashboard
    token via FastScope.from_dashboard_user — previously this route trusted
    orgId straight off the query string with no auth at all, meaning any
    caller could pull any organization's dashboard snapshot. See
    PATCH_NOTES: fast-path auth bypass.

    Note: cards/totals here now respect 'team' dashboard_scope — a manager
    scoped to their own team sees their team's numbers, not the org/branch's
    (get_team_scope_ids, same self-excluded contract as every other
    scope-sensitive route). An unscoped caller (branch/org admin, or
    dashboard_scope='branch') is unaffected — scope_ids is None for them,
    same as before this change.
    """
    try:
        # 'view' is a display-preference hint only (?view=team|branch),
        # never an identity list — get_effective_scope_ids always resolves
        # the actual id set from g.dashboard_user's own verified id. See
        # its docstring in client_dashboard_auth.py for the full contract.
        requested_view = request.args.get('view') or request.args.get('teamView')
        scope_ids = get_effective_scope_ids(g.dashboard_user, requested_view=requested_view)
        scope = FastScope.from_dashboard_user(g.dashboard_user, request.args, scope_ids=scope_ids)

        dashboard_scope = str(
            request.args.get('scope')
            or request.args.get('dashboardScope')
            or 'global'
        ).strip().lower()

        if dashboard_scope not in {'global', 'branch'}:
            dashboard_scope = 'global'

        if not scope.org_id:
            return jsonify({
                'success': False,
                'message': 'organization_id/orgId is required.',
                'error': 'organization_id/orgId is required.',
                'scope': dashboard_scope,
                'stats': {},
                'staff': [],
                'liveLog': [],
                'shiftDistribution': [],
                'todayStatus': [],
                'weeklyAttendance': [],
                'branchWeeklyAttendance': [],
                'pendingLeaves': [],
                'cctvStatus': [],
                'attendancePerformance': [],
                'branchAttendancePerformance': [],
                'payrollTrends': [],
                'branchPayrollTrends': [],
                'branchPerformance': [],
            }), 400

        people_type = request.args.get('people_type') or request.args.get('peopleType')
        if people_type and getattr(scope, 'org_id', None) and not _positive_int(scope.org_id):
            snapshot = support_cp_db.get_client_dashboard_overview(
                org_id=str(scope.org_id),
                branch_id=getattr(scope, 'branch_id', None),
                days=request.args.get('days', 7, type=int),
                people_type=people_type,
                scope_ids=scope_ids,  # already resolved above via get_effective_scope_ids — was silently dropped
            )
        else:
            snapshot = get_fast_dashboard_overview(
                scope,
                dashboard_scope=dashboard_scope,
            )

        return jsonify({
            'success': True,
            **snapshot,
        }), 200

    except Exception as exc:
        logger.exception('Fast dashboard overview snapshot failed')
        return jsonify({
            'success': False,
            'message': str(exc),
            'error': str(exc),
            'stats': {},
            'staff': [],
            'liveLog': [],
            'shiftDistribution': [],
            'todayStatus': [],
            'weeklyAttendance': [],
            'branchWeeklyAttendance': [],
            'pendingLeaves': [],
            'cctvStatus': [],
            'attendancePerformance': [],
            'branchAttendancePerformance': [],
            'payrollTrends': [],
            'branchPayrollTrends': [],
            'branchPerformance': [],
        }), 500
    


@app.route('/api/v2/payroll/page', methods=['GET'])
@require_client_dashboard_auth
def api_v2_payroll_page():
    """Paginated payroll records for UUID/Supabase tenants.

    Frontend payroll tables call this endpoint for server-side paging. It keeps
    client_staff.salary as the payroll source of truth and overlays optional
    salary_configs without falling back to legacy/demo data for UUID tenants.

    SECURITY: org_id is pinned to the verified token, never the query
    string/X-Organization-Id header — those were previously trusted
    outright, letting any caller page through any org's payroll. Payroll
    is also deliberately left UNSCOPED by dashboard_scope here (matches
    client_dashboard_auth's documented contract: reporting-hierarchy
    visibility is not the same grant as compensation visibility) — a
    'team'-scoped manager still needs an explicit payroll module grant,
    enforced at whatever route/UI gate already checks access_modules for
    payroll, not by this endpoint silently filtering rows.
    """
    dashboard_user = g.dashboard_user
    raw_org_id = str(dashboard_user.get('org_id') or '').strip()
    raw_branch_id = (
        request.args.get('branchId')
        or request.args.get('branch_id')
        or request.args.get('backendBranchId')
        or request.args.get('backend_branch_id')
        or request.args.get('branchUuid')
        or request.args.get('branch_uuid')
    )
    # A token still carries the caller's own home branch even for admins
    # (client_staff.branch_id), but that must not lock a full-access admin
    # to one branch's payroll. Only a genuinely branch-scoped (non-admin)
    # account stays pinned to its token branch_id and can't widen it via
    # the query string; an admin may still narrow to one branch as a
    # voluntary display filter, but sees every branch by default.
    if not dashboard_user.get('is_admin'):
        raw_branch_id = dashboard_user.get('branch_id') or raw_branch_id

    if not raw_org_id:
        return jsonify({'success': False, 'message': 'orgId/organization_id is required'}), 400

    # UUID tenants must use Supabase. Numeric tenants can keep old endpoints.
    if _positive_int(raw_org_id):
        return jsonify({
            'success': False,
            'message': 'Use legacy payroll endpoints for numeric organizations.',
        }), 400

    try:
        page = support_cp_db.get_client_payroll_page(
            raw_org_id,
            branch_id=raw_branch_id,
            page=request.args.get('page', 1),
            page_size=request.args.get('pageSize') or request.args.get('page_size') or 250,
            search=request.args.get('search') or request.args.get('q'),
            sort_by=request.args.get('sortBy') or request.args.get('sort_by') or 'name',
            sort_dir=request.args.get('sortDir') or request.args.get('sort_dir') or 'asc',
            period_start=request.args.get('periodStart') or request.args.get('period_start'),
            period_end=request.args.get('periodEnd') or request.args.get('period_end'),
            people_type=request.args.get('peopleType') or request.args.get('people_type'),
        )
        return jsonify({'success': True, **page}), 200
    except ValueError as e:
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 400
    except Exception as e:
        logger.exception('Payroll page failed')
        return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 500

@app.route('/api/tenant/summary', methods=['GET'])
@require_client_dashboard_auth
def api_tenant_fast_summary():
    """Fast aggregate summary for dashboard/reports/payroll cards.

    This endpoint is intentionally tenant-scoped and aggregate-first. It avoids
    downloading large staff/attendance/payroll tables into React for cards and
    charts. UUID tenants are served from Supabase only; legacy numeric orgs keep
    their existing endpoints.

    SECURITY: org_id is pinned to the verified token (see the /api/v2 twin
    of this route, api_v2_tenant_fast_summary, for the same fix + rationale).
    """
    dashboard_user = g.dashboard_user
    raw_org_id = str(dashboard_user.get('org_id') or '').strip()
    raw_branch_id = request.args.get('branch_id') or request.args.get('branchId')
    if not dashboard_user.get('is_admin'):
        raw_branch_id = dashboard_user.get('branch_id') or raw_branch_id
    days = request.args.get('days', 7, type=int)

    if not raw_org_id:
        return jsonify({'success': False, 'message': 'organization_id is required'}), 400

    # Support-created organizations use UUIDs and must never fall back to
    # legacy SQLite/demo data.
    if not _positive_int(raw_org_id):
        try:
            summary = support_cp_db.get_tenant_fast_summary(
                raw_org_id,
                branch_id=raw_branch_id,
                days=max(1, min(int(days or 7), 90)),
            )
            return jsonify({'success': True, **summary}), 200
        except ValueError as e:
            return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 400
        except Exception as e:
            logger.exception('Fast tenant summary failed')
            return jsonify({'success': False, 'message': str(e), 'error': str(e)}), 500

    return jsonify({
        'success': False,
        'message': 'Fast tenant summary is only enabled for UUID/Supabase organizations.',
    }), 400


def _fast_positive_int(value, default=1, minimum=1, maximum=250):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default

    return max(minimum, min(maximum, parsed))


@app.route('/api/v2/tenant/summary', methods=['GET'])
@require_client_dashboard_auth
def api_v2_tenant_fast_summary():
    """SECURITY: org_id/branch_id pinned to the verified Client Dashboard
    token — previously trusted straight off the query string with no auth
    at all (any caller, any org). See PATCH_NOTES: fast-path auth bypass.

    Cards now respect 'team' dashboard_scope the same way api_v2_dashboard_overview
    does — see get_fast_summary's scope_ids handling. Also honors the same
    opt-in ?view=team convenience narrowing api_v2_dashboard_overview does,
    for 'branch'-scoped managers with direct reports — see
    get_effective_scope_ids in client_dashboard_auth.py."""
    try:
        requested_view = request.args.get('view') or request.args.get('teamView')
        scope_ids = get_effective_scope_ids(g.dashboard_user, requested_view=requested_view)
        scope = FastScope.from_dashboard_user(g.dashboard_user, request.args, scope_ids=scope_ids)

        if not scope.org_id:
            return jsonify({
                'success': False,
                'message': 'organization_id/orgId is required.',
                'error': 'organization_id/orgId is required.',
                'cards': {},
                'totals': {},
                'stats': {},
            }), 400

        summary = get_fast_summary(scope)

        return jsonify({
            'success': True,
            **summary,
        }), 200

    except Exception as exc:
        logger.exception('Fast v2 tenant summary failed')
        return jsonify({
            'success': False,
            'message': str(exc),
            'error': str(exc),
            'cards': {},
            'totals': {},
            'stats': {},
        }), 500


@app.route('/api/v2/<entity>/page', methods=['GET'])
@require_client_dashboard_auth
def api_v2_fast_entity_page(entity):
    """SECURITY: this was the most serious of the /api/v2 gaps — a fully
    unauthenticated, unscoped cross-tenant table reader. Any caller could
    request entity=staff (or attendance/leaves/payroll) with any orgId in
    the query string and get that organization's full paginated table,
    same underlying client_staff rows the Staff Directory shows, with none
    of the auth/scope checks GET /api/staff enforces.

    Now: org_id/branch_id are pinned to the verified token, and for
    entity in {staff, employees, attendance, leaves, payroll} the caller's
    team-scope (get_team_scope_ids — same single source of truth every
    other scope-sensitive route uses, self excluded per its documented
    contract) is pushed into the underlying Supabase query so both the
    returned rows AND the total/hasMore pagination counts are correct for
    a 'team'-scoped manager, not just post-filtered after the fact.
    """
    try:
        scope_ids = get_team_scope_ids(g.dashboard_user)
        scope = FastScope.from_dashboard_user(g.dashboard_user, request.args, scope_ids=scope_ids)

        if not scope.org_id:
            return jsonify({
                'success': False,
                'message': 'organization_id/orgId is required.',
                'error': 'organization_id/orgId is required.',
                'entity': entity,
                'rows': [],
                'total': 0,
                'page': 1,
                'pageSize': 50,
                'offset': 0,
                'hasMore': False,
            }), 400

        page = _fast_positive_int(
            request.args.get('page'),
            default=1,
            minimum=1,
            maximum=1_000_000,
        )

        page_size = _fast_positive_int(
            request.args.get('pageSize') or request.args.get('page_size'),
            default=50,
            minimum=1,
            maximum=250,
        )

        data = get_fast_page(
            entity=entity,
            scope=scope,
            page=page,
            page_size=page_size,
            search=request.args.get('search') or request.args.get('q'),
            sort_by=request.args.get('sortBy') or request.args.get('sort_by'),
            sort_dir=request.args.get('sortDir') or request.args.get('sort_dir') or 'asc',
        )

        status = 200 if data.get('success') is not False else 400
        return jsonify(data), status

    except Exception as exc:
        logger.exception(f'Fast v2 page failed for entity={entity}')
        return jsonify({
            'success': False,
            'message': str(exc),
            'error': str(exc),
            'entity': entity,
            'rows': [],
            'total': 0,
            'page': 1,
            'pageSize': 50,
            'offset': 0,
            'hasMore': False,
        }), 500




@app.route('/api/v2/performance/cache/clear', methods=['POST'])
@require_client_dashboard_auth
def api_v2_clear_fast_cache():
    """Was completely open — any unauthenticated caller could force every
    subsequent /api/v2 request across every tenant back onto the slow
    (uncached) path on demand. Cheap, trivially-triggerable DoS knob for a
    single decorator. Any authenticated dashboard session may still clear
    it; it's a shared perf cache, not a per-tenant resource, so there's no
    finer-grained scoping to add here."""
    clear_fast_cache()
    return jsonify({'success': True}), 200

# If a React production build exists at frontend/dist, serve it as a single-page app (SPA) fallback.
if os.path.isdir(FRONTEND_DIST):
    @app.route('/', defaults={'path': ''})
    @app.route('/<path:path>')
    def serve_spa(path):
        if path.startswith("api/"):
            return jsonify({
                "success": False,
                "error": "API endpoint not found",
                "path": f"/{path}",
            }), 404

        requested = os.path.join(FRONTEND_DIST, path)

        if path and os.path.exists(requested):
            return send_from_directory(FRONTEND_DIST, path)

        return send_from_directory(FRONTEND_DIST, "index.html")


# if __name__ == '__main__':
#     logger.info("\n" + "="*60)
#     logger.info("Flask AI Attendance System - Starting")
#     logger.info("="*60)
    
#     try:
#         db.init_db()
#         logger.info("✓ Database initialized")
#         refresh_embedding_cache()
        
#         logger.info("[*] Warming up AI models (InsightFace)...")
#         get_face_model(MODELS_DIR, prefer_gpu=ENABLE_GPU)
#         logger.info("✓ AI models loaded and warmed up successfully")
        
#     except Exception as e:
#         logger.error(f"✗ Startup initialization failed: {e}")
    
#     logger.info(f"Starting server on http://localhost:5000")
#     logger.info("="*60 + "\n")
    
#     app.run(debug=True, host='0.0.0.0', port=5000, use_reloader=False)

def _startup_init():
    """Runs on import, so it fires under gunicorn (production) and
    under `python app.py` (local dev) alike."""
    logger.info("\n" + "="*60)
    logger.info("Flask AI Attendance System - Starting")
    logger.info("="*60)
    try:
        db.init_db()
        logger.info("✓ Database initialized")
        refresh_embedding_cache()

        logger.info("[*] Warming up AI models (InsightFace)...")
        get_face_model(MODELS_DIR, prefer_gpu=ENABLE_GPU)
        logger.info("✓ AI models loaded and warmed up successfully")
    except Exception as e:
        logger.error(f"✗ Startup initialization failed: {e}")
    logger.info("="*60 + "\n")


_startup_init()

if __name__ == '__main__':
    # Local dev only — Railway/production uses gunicorn (see Dockerfile CMD)
    port = int(os.environ.get('PORT', 5000))

    # debug=True was unconditional here. Werkzeug's debugger doesn't just
    # print a traceback on a 500: it serves an interactive Python console in
    # the browser at the point of the exception. On anything reachable from
    # outside, that is remote code execution, and it is also how a 500 ends
    # up displaying source — the exact "server crashes and shows its secret
    # internal code" finding from the original audit report.
    #
    # Now opt-in: set FLASK_DEBUG=1 for a debugger session. Host follows the
    # same logic — 0.0.0.0 exposes the dev server to your whole LAN, which
    # is rarely what you want on a laptop, so default to loopback and
    # require BIND_HOST=0.0.0.0 to opt in (e.g. to test from a phone).
    debug_enabled = os.environ.get('FLASK_DEBUG', '').strip() in {'1', 'true', 'True'}
    host = os.environ.get('BIND_HOST', '127.0.0.1')
    if debug_enabled and host != '127.0.0.1':
        logger.warning(
            'FLASK_DEBUG=1 with host %s exposes an interactive Python console to '
            'that interface. Use it only on a trusted network.', host,
        )
    logger.info(f"Starting dev server on http://{host}:{port} (debug={debug_enabled})")
    app.run(debug=debug_enabled, host=host, port=port, use_reloader=False)