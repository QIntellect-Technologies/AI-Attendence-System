"""
Flask AI Attendance System
- Enrollment: Upload video, extract embeddings, store profile
- Recognition: Camera/RTSP feed, detect faces, match against profiles, log attendance
"""

from flask import Flask, request, jsonify, render_template, send_from_directory, Response
from flask_cors import CORS
import os
import sys
import json
import numpy as np
from datetime import datetime, timedelta
from pathlib import Path

_THIS_DIR = str(Path(__file__).resolve().parent)
_ROOT_DIR = str(Path(__file__).resolve().parent.parent.parent)
_FLASK_DIR = os.path.join(_THIS_DIR, "Flask-Attedence")

if _FLASK_DIR in sys.path:
    sys.path.remove(_FLASK_DIR)
sys.path.insert(0, _FLASK_DIR)

if _THIS_DIR not in sys.path:
    sys.path.append(_THIS_DIR)
if _ROOT_DIR not in sys.path:
    sys.path.append(_ROOT_DIR)

if "config" in sys.modules and not hasattr(sys.modules["config"], "ALLOWED_EXTENSIONS"):
    del sys.modules["config"]

import database as db
import face_processor as fp
from download_models import verify_models      
from logger_config import get_logger
from config import (
    UPLOAD_FOLDER, ALLOWED_EXTENSIONS, IMAGE_EXTENSIONS,
    MAX_CONTENT_LENGTH, FACE_MATCHING_THRESHOLD,
    MIN_ENROLLMENT_FRAMES, OPTIMAL_FACES_PER_VIDEO,
    MIN_VIDEO_DURATION, MAX_VIDEO_DURATION,
    NVR_OFFICE_URL, DVR_OFFICE_URL, WEBCAM_URL,
    TRACK_MAX_AGE_SECONDS, TRACK_ACTIVE_IOU_THRESHOLD, TRACK_LOST_IOU_THRESHOLD,
    TRACK_ACTIVE_DIST_FACTOR, TRACK_LOST_DIST_FACTOR,
    TRACK_ACTIVE_MIN_DIST, TRACK_LOST_MIN_DIST,
    TRACK_UNKNOWN_RETRY_INTERVAL, TRACK_AI_INTERVAL
)

logger = get_logger(__name__)

# Initialize Flask app with absolute template & static folders
TEMPLATE_DIR = os.path.join(_FLASK_DIR, "templates")
STATIC_DIR = os.path.join(_FLASK_DIR, "static")
app = Flask(__name__, template_folder=TEMPLATE_DIR, static_folder=STATIC_DIR)
CORS(app)

import threading

# Global in-memory cache for enrolled face embeddings to avoid SQLite query bottlenecks inside live streams
EMBEDDING_CACHE = {}  # {user_id: {"name": name, "aggregate_embedding": np.array}}
LATEST_STREAM_DETECTIONS = []  # Thread-safe real-time detections queue for the sidebar ticker
DETECTED_USERS_SESSION = set()  # Permanent session dedup — each user shown only once
MANUALLY_ABSENT_USERS = set()  # Users manually marked absent until they leave and re-enter the frame
cache_lock = threading.Lock()

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
            aggregate_emb = fp.compute_aggregate_embedding(user_embs)
            new_cache[user['id']] = {
    'name': user['name'],
    'department': user.get('department', ''),
    'aggregate_embedding': aggregate_emb
}
        with cache_lock:
            EMBEDDING_CACHE = new_cache
        logger.info(f"✓ Cached aggregate profiles for {len(new_cache)} users in memory.")
    except Exception as e:
        logger.error(f"✗ Failed to refresh embedding cache: {e}")

# Configuration
UPLOAD_FOLDER.mkdir(exist_ok=True)

app.config['UPLOAD_FOLDER'] = str(UPLOAD_FOLDER)
app.config['MAX_CONTENT_LENGTH'] = MAX_CONTENT_LENGTH


def allowed_file(filename):
    """Check if file extension is allowed."""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


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


# ============================================
# ENROLLMENT ENDPOINTS
# ============================================

@app.route('/api/enroll/create-user', methods=['POST'])
def create_user():
    """Create a new user for enrollment."""
    data = request.get_json()
    name = data.get('name')
    email = data.get('email')
    
    if not name:
        return jsonify({'error': 'Name is required'}), 400
    
    user_id = db.add_user(name, email)
    if user_id:
        return jsonify({
            'success': True,
            'user_id': user_id,
            'name': name,
            'message': f'User {name} created successfully'
        }), 201
    else:
        return jsonify({'error': f'User {name} already exists'}), 409


@app.route('/api/enroll/upload-video', methods=['POST'])
def upload_enrollment_video():
    """Upload 15sec enrollment video and extract embeddings."""
    try:
        if 'video' not in request.files:
            return jsonify({'error': 'No video provided'}), 400
        
        user_id = request.form.get('user_id')
        if not user_id:
            return jsonify({'error': 'user_id is required'}), 400
        
        try:
            user_id = int(user_id)
        except ValueError:
            return jsonify({'error': 'Invalid user_id'}), 400
        
        video_file = request.files['video']
        
        if video_file.filename == '':
            return jsonify({'error': 'No selected file'}), 400
        
        if not allowed_file(video_file.filename):
            return jsonify({
                'error': f'Allowed formats: {", ".join(ALLOWED_EXTENSIONS)}'
            }), 400
        
        # Save uploaded video
        filename = secure_filename(f"{user_id}_{datetime.now().timestamp()}.mp4")
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        video_file.save(filepath)
        
        logger.info(f"Processing enrollment video: {filepath}")
        
        try:
            # Process enrollment video with advanced checks
            result = fp.process_enrollment_video(filepath, max_frames=120)
            
            if not result['success']:
                logger.warning(f"Enrollment processing failed: {result.get('error')}")
                return jsonify({
                    'error': result.get('error', 'No faces detected in video'),
                    'details': result.get('issues', [])
                }), 400
            
            embeddings = result['embeddings']
            
            if len(embeddings) < MIN_ENROLLMENT_FRAMES:
                return jsonify({
                    'error': f'Insufficient valid faces detected ({len(embeddings)}/{MIN_ENROLLMENT_FRAMES})',
                    'issues': result.get('issues', [])
                }), 400
            
            # Store embeddings with quality scores
            for embedding in embeddings:
                embedding_list = embedding.tolist()
                db.store_embedding(user_id, embedding_list, filename)
            
            logger.info(f"✓ Stored {len(embeddings)} embeddings for user {user_id}")
            
            # Refresh cache dynamically
            refresh_embedding_cache()
            
            return jsonify({
                'success': True,
                'user_id': user_id,
                'embeddings_count': len(embeddings),
                'total_frames_processed': result['total_frames'],
                'avg_quality': result.get('avg_quality', 0),
                'spoof_detections': result.get('spoof_issues', 0),
                'warnings': result.get('issues', []),
                'message': f'Successfully stored {len(embeddings)} embeddings'
            }), 200
        
        except Exception as e:
            logger.error(f"Video processing failed: {e}")
            return jsonify({'error': f'Processing failed: {str(e)}'}), 500
        finally:
            # Clean up uploaded video after processing
            try:
                if os.path.exists(filepath):
                    os.remove(filepath)
                    logger.debug(f"Cleaned up video file: {filepath}")
            except Exception as e:
                logger.warning(f"Failed to cleanup video: {e}")
    
    except Exception as e:
        logger.error(f"Enrollment endpoint error: {e}")
        return jsonify({'error': 'Internal server error'}), 500


@app.route('/api/enroll/status/<int:user_id>', methods=['GET'])
def enrollment_status(user_id):
    """Check enrollment status for a user."""
    embeddings = db.get_embeddings_for_user(user_id)
    
    if len(embeddings) == 0:
        return jsonify({
            'enrolled': False,
            'user_id': user_id,
            'embeddings_count': 0,
            'message': 'User not yet enrolled'
        }), 200
    
    return jsonify({
        'enrolled': True,
        'user_id': user_id,
        'embeddings_count': len(embeddings),
        'created_at': embeddings[0]['created_at'],
        'message': f'User enrolled with {len(embeddings)} embeddings'
    }), 200


# ============================================
# RECOGNITION ENDPOINTS
# ============================================

@app.route('/api/recognize/frame', methods=['POST'])
def recognize_face_frame():
    """
    Recognize face in a single frame.
    POST image data (base64 or file) -> returns matched user or 'unknown'
    """
    try:
        if 'image' not in request.files:
            return jsonify({'error': 'No image provided'}), 400
        
        image_file = request.files['image']
        
        try:
            import cv2
            # Read image
            image_bytes = image_file.read()
            nparr = np.frombuffer(image_bytes, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            
            if frame is None:
                return jsonify({'error': 'Invalid image'}), 400
            
            # Detect faces and extract embeddings simultaneously
            face_results = fp.detect_and_extract_insightface(frame)
            logger.info(f"Detected {len(face_results)} faces in recognition frame")
            
            if len(face_results) == 0:
                return jsonify({
                    'recognized': False,
                    'detected_faces': 0,
                    'message': 'No faces detected'
                }), 200
            
            results = []
            
            for i, face_dict in enumerate(face_results):
                x1, y1, x2, y2 = face_dict['bbox']
                conf = face_dict['conf']
                test_embedding = face_dict['embedding']
                
                # Assess face quality
                quality_info = fp.assess_face_quality(frame, (x1, y1, x2, y2))
                
                # Check for spoofing
                spoof_info = fp.detect_spoofing(frame, (x1, y1, x2, y2))
                
                if test_embedding is None:
                    results.append({
                        'face_bbox': [x1, y1, x2, y2],
                        'detected_confidence': float(conf),
                        'matched_user': 'Unknown',
                        'similarity': 0.0,
                        'is_match': False,
                        'quality_score': float(quality_info['score']),
                        'is_spoof': bool(spoof_info['is_spoof']),
                        'error': 'Could not extract embedding'
                    })
                    continue
                
                # Compare against all enrolled users
                best_match = None
                best_similarity = -1
                
                all_users = db.get_all_users()
                for user in all_users:
                    user_embeddings = db.get_embeddings_for_user(user['id'])
                    
                    if len(user_embeddings) == 0:
                        continue
                    
                    # Compute aggregate embedding
                    user_embs = [np.array(emb['embedding']) for emb in user_embeddings]
                    aggregate_emb = fp.compute_aggregate_embedding(user_embs)
                    
                    # Compare
                    similarity, is_match = fp.compare_embeddings(
                        aggregate_emb, test_embedding,
                        threshold=FACE_MATCHING_THRESHOLD
                    )
                    
                    if is_match and similarity > best_similarity:
                        best_similarity = similarity
                        best_match = user
                
                results.append({
                    'face_bbox': [x1, y1, x2, y2],
                    'detected_confidence': float(conf),
                    'matched_user': best_match['name'] if best_match else 'Unknown',
                    'similarity': float(best_similarity) if best_similarity >= 0 else 0.0,
                    'is_match': bool(best_match is not None),
                    'quality_score': float(quality_info['score']),
                    'quality_issues': quality_info.get('issues', []),
                    'is_spoof': bool(spoof_info['is_spoof']),
                    'spoof_confidence': float(spoof_info.get('confidence', 0))
                })
                
                # Log attendance if matched and not a spoof
                if best_match and not spoof_info['is_spoof']:
                    db.log_attendance(
                        best_match['id'],
                        best_match['name'],
                        float(best_similarity),
                        'frame'
                    )
                    logger.info(f"Logged attendance: {best_match['name']} ({best_similarity:.3f})")
            
            return jsonify({
                'recognized': len([r for r in results if r['is_match']]) > 0,
                'detections': results,
                'total_faces_detected': len(face_results),
                'timestamp': datetime.now().isoformat()
            }), 200
        
        except Exception as e:
            logger.error(f"Recognition processing error: {e}")
            return jsonify({'error': f'Recognition failed: {str(e)}'}), 500
    
    except Exception as e:
        logger.error(f"Recognition endpoint error: {e}")
        return jsonify({'error': 'Internal server error'}), 500


@app.route('/api/recognize/rtsp', methods=['POST'])
def recognize_rtsp_stream():
    """
    Recognize faces from RTSP stream (e.g., NVR, DVR, IP camera).
    Run in background or return stream setup info.
    """
    data = request.get_json()
    rtsp_url = data.get('rtsp_url')
    frames_to_process = data.get('frames', 10)
    
    if not rtsp_url:
        return jsonify({'error': 'rtsp_url is required'}), 400
    
    try:
        import cv2
        cap = cv2.VideoCapture(rtsp_url)
        
        if not cap.isOpened():
            return jsonify({'error': 'Cannot connect to RTSP stream'}), 400
        
        results = []
        frame_count = 0
        
        while frame_count < frames_to_process:
            ret, frame = cap.read()
            
            if not ret:
                break
            
            # Detect faces and extract embeddings simultaneously
            face_results = fp.detect_and_extract_insightface(frame)
            
            for face_dict in face_results:
                x1, y1, x2, y2 = face_dict['bbox']
                test_embedding = face_dict['embedding']
                
                if test_embedding is None:
                    continue
                
                # Find best match
                best_match = None
                best_similarity = -1
                
                all_users = db.get_all_users()
                for user in all_users:
                    user_embeddings = db.get_embeddings_for_user(user['id'])
                    
                    if len(user_embeddings) == 0:
                        continue
                    
                    user_embs = [np.array(emb['embedding']) for emb in user_embeddings]
                    aggregate_emb = fp.compute_aggregate_embedding(user_embs)
                    similarity, is_match = fp.compare_embeddings(aggregate_emb, test_embedding, threshold=FACE_MATCHING_THRESHOLD)
                    
                    if similarity > best_similarity:
                        best_similarity = similarity
                        best_match = user if is_match else None
                
                if best_match:
                    results.append(best_match['name'])
                    db.log_attendance(
                        best_match['id'],
                        best_match['name'],
                        float(best_similarity),
                        'rtsp'
                    )
            
            frame_count += 1
        
        cap.release()
        
        return jsonify({
            'status': 'completed',
            'recognized_users': results,
            'frames_processed': frame_count,
            'timestamp': datetime.now().isoformat()
        }), 200
    
    except Exception as e:
        return jsonify({'error': f'RTSP recognition failed: {str(e)}'}), 500


@app.route('/api/live-detections', methods=['GET'])
def get_live_detections():
    global LATEST_STREAM_DETECTIONS
    with cache_lock:
        return jsonify({"detections": LATEST_STREAM_DETECTIONS})


def remove_live_detection_for_user(user_id: int):
    """Remove a user from the live detection sidebar after manual absent marking."""
    global LATEST_STREAM_DETECTIONS, DETECTED_USERS_SESSION, MANUALLY_ABSENT_USERS
    with cache_lock:
        LATEST_STREAM_DETECTIONS = [
            det for det in LATEST_STREAM_DETECTIONS if det.get('user_id') != user_id
        ]
        DETECTED_USERS_SESSION.discard(user_id)
        MANUALLY_ABSENT_USERS.add(user_id)

    with active_readers_lock:
        for reader in active_stream_readers.values():
            with reader.lock:
                reader.tracked_faces = {
                    tid: t for tid, t in reader.tracked_faces.items()
                    if t.get('user_id') != user_id
                }


class CameraStreamReader:
    """
    High-performance dual-threaded camera reader:
    - Thread 1 (Grabber): Continuously grabs the latest frame at 30 FPS from the NVR/DVR.
      This completely eliminates OpenCV buffer delay and lagging.
    - Thread 2 (AI Worker): Processes the latest frame asynchronously for face detection 
      and recognition in the background, updating detections without blocking the stream.
    """
    def __init__(self, camera_id, rtsp_url):
        import cv2
        import threading
        import os
        
        self.camera_id = camera_id
        self.rtsp_url = rtsp_url
        
        self.is_webcam = isinstance(rtsp_url, int) or (isinstance(rtsp_url, str) and rtsp_url.isdigit())
        if self.is_webcam:
            self.rtsp_url = int(rtsp_url)
            logger.info(f"Initializing USB Webcam (Index: {self.rtsp_url}) using CAP_DSHOW...")
            self.cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_DSHOW)
        else:
            # Set low-delay TCP parameters BEFORE initializing the VideoCapture to eliminate buffer lag
            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay"
            self.cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_FFMPEG)
            
        self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        
        self.latest_frame = None
        self.latest_detections = []
        self.tracked_faces = {}  # track_id -> dict for locking face identities
        self.next_track_id = 1
        self.last_logged = {}  # {user_id: timestamp}
        self.running = True
        self.viewers_count = 0  # Active viewer tracking
        
        self.lock = threading.Lock()
        
        # Thread 1: Camera Frame Grabber (Runs at ~30-60Hz, never blocks for AI)
        self.grabber_thread = threading.Thread(target=self._grabber_loop, daemon=True)
        self.grabber_thread.start()
        
        # Thread 2: Asynchronous AI Worker (Runs at ~3Hz, processes frames in background)
        self.ai_thread = threading.Thread(target=self._ai_loop, daemon=True)
        self.ai_thread.start()

    def _grabber_loop(self):
        import time
        import cv2
        import os
        
        # Set low-latency and TCP options for FFmpeg backend
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay"
        
        while self.running:
            if not self.cap.isOpened():
                if self.is_webcam:
                    logger.warning(f"[{self.camera_id}] Webcam closed. Re-opening with CAP_DSHOW...")
                    self.cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_DSHOW)
                else:
                    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay"
                    self.cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_FFMPEG)
                self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                time.sleep(1)
                continue
                
            # Flush FFMPEG/OpenCV socket buffer completely to ensure 0.0 seconds of latency
            if not self.is_webcam:
                for _ in range(5):
                    self.cap.grab()
                ret, frame = self.cap.retrieve()
            else:
                ret, frame = self.cap.read()
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
            
            # Only run AI if we have active viewers and a valid frame
            if self.viewers_count > 0 and frame_to_process is not None:
                if (current_time - last_ai_time) > ai_interval:
                    last_ai_time = current_time
                    
                    try:
                        # ALL-IN-ONE High-Speed Face Detection & Extraction
                        face_results = fp.detect_and_extract_insightface(frame_to_process)
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
                                
                                with cache_lock:
                                    cache_items = list(EMBEDDING_CACHE.items())
                                    
                                for uid, cache_data in cache_items:
                                    aggregate_emb = cache_data['aggregate_embedding']
                                    similarity, is_match = fp.compare_embeddings(aggregate_emb, test_embedding, threshold=FACE_MATCHING_THRESHOLD)
                                    
                                    if is_match and similarity > best_similarity:
                                        best_similarity = similarity
                                        best_match = (uid, cache_data)
                                        
                                if best_match:
                                    uid, cache_data = best_match
                                    with cache_lock:
                                        is_manually_absent = uid in MANUALLY_ABSENT_USERS

                                    if is_manually_absent:
                                        logger.info(f"[_ai_loop - Stream {self.camera_id} - Track {tid}] Suppressed manual absent user ID {uid}; keeping track as Unknown")
                                    else:
                                        name = cache_data['name']
                                        user_id = uid
                                        similarity_score = best_similarity
                                        
                                        track["name"] = name
                                        track["user_id"] = user_id
                                        track["similarity"] = similarity_score
                                        
                                        logger.info(f"[_ai_loop - Stream {self.camera_id} - Track {tid}] LOCK ESTABLISHED: '{name}' (ID: {uid}) with Cosine Similarity {best_similarity:.4f}")
                                        
                                        # ============================================
                                        # FACE CROP → BASE64 for sidebar ticker photo
                                        # ============================================
                                        face_crop_b64 = None
                                        try:
                                            fh, fw = frame_to_process.shape[:2]
                                            fx1 = max(0, x1)
                                            fy1 = max(0, y1)
                                            fx2 = min(fw, x2)
                                            fy2 = min(fh, y2)
                                            crop = frame_to_process[fy1:fy2, fx1:fx2]
                                            if crop.size > 0:
                                                crop_resized = cv2.resize(crop, (80, 80))
                                                _, buf = cv2.imencode('.jpg', crop_resized, [cv2.IMWRITE_JPEG_QUALITY, 85])
                                                face_crop_b64 = "data:image/jpeg;base64," + base64.b64encode(buf).decode('utf-8')
                                        except Exception as ce:
                                            logger.warning(f"Face crop extraction failed: {ce}")
                                        
                                        # Push to the global real-time sidebar ticker
                                        global LATEST_STREAM_DETECTIONS
                                        detection_entry = {
    "name": name,
    "timestamp": datetime.now().isoformat(),
    "confidence": float(best_similarity),
    "source": f"stream_{self.camera_id}",
    "face_crop": face_crop_b64,
    "user_id": uid,
    "department": cache_data.get('department', '')
}
                                        
                                        global DETECTED_USERS_SESSION
                                        with cache_lock:
                                            if uid not in DETECTED_USERS_SESSION:
                                                DETECTED_USERS_SESSION.add(uid)
                                                LATEST_STREAM_DETECTIONS.insert(0, detection_entry)
                                                LATEST_STREAM_DETECTIONS = LATEST_STREAM_DETECTIONS[:10]
                                                                                     
                                        # Log attendance per camera source once per day
                                        stream_source = f'stream_{self.camera_id}'
                                        if not db.is_user_present_today(user_id, source=stream_source):
                                            db.log_attendance(
                                                user_id,
                                                name,
                                                float(best_similarity),
                                                stream_source
                                            )
                                            logger.info(f"[_ai_loop - Stream {self.camera_id} - Track {tid}] DB Attendance written for '{name}' ({stream_source})")
                                else:
                                    logger.info(f"[_ai_loop - Stream {self.camera_id} - Track {tid}] Biometric verification complete: No match (Highest: {best_similarity:.4f})")
                            else:
                                if name == "Unknown":
                                    logger.warning(f"[_ai_loop - Stream {self.camera_id} - Track {tid}] InsightFace embedding extraction returned None (blurry, bad angle, or dark)")
                                    
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

                        # If a manually absent user has left the scene entirely, allow them to be recognized again later.
                        with cache_lock:
                            active_suppressed = {
                                t.get('user_id') for t in self.tracked_faces.values() if t.get('user_id') in MANUALLY_ABSENT_USERS
                            }
                            for uid in list(MANUALLY_ABSENT_USERS):
                                if uid not in active_suppressed:
                                    MANUALLY_ABSENT_USERS.discard(uid)
                        
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
        self.cap.release()


active_stream_readers = {}
active_readers_lock = threading.Lock()

def get_or_create_reader(camera_id, rtsp_url):
    """Retrieve or spin up a background RTSP stream reader."""
    global active_stream_readers
    with active_readers_lock:
        if camera_id in active_stream_readers:
            if active_stream_readers[camera_id].running:
                return active_stream_readers[camera_id]
        
        logger.info(f"[*] Starting background thread stream reader for: {camera_id}")
        reader = CameraStreamReader(camera_id, rtsp_url)
        active_stream_readers[camera_id] = reader
        return reader


@app.route('/api/stream/<camera_id>')
def video_stream(camera_id):
    """Real-time video streaming with asynchronous face detection overlay."""
    rtsp_url = None
    if camera_id == 'nvr_office':
        rtsp_url = NVR_OFFICE_URL
    elif camera_id == 'dvr_office':
        rtsp_url = DVR_OFFICE_URL
    elif camera_id == 'webcam':
        rtsp_url = WEBCAM_URL
    else:
        rtsp_url = request.args.get('url')
        
    if not rtsp_url and rtsp_url != 0:
        return jsonify({'error': 'Invalid camera_id or missing url'}), 400
        
    reader = get_or_create_reader(camera_id, rtsp_url)
    
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
                        offline_frame, "CAMERA STANDBY / RECONNECTING...", (70, 240),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 165, 255), 2, cv2.LINE_AA
                    )
                    ret_encode, jpeg = cv2.imencode('.jpg', offline_frame)
                    if ret_encode:
                        yield (b'--frame\r\n'
                               b'Content-Type: image/jpeg\r\n\r\n' + jpeg.tobytes() + b'\r\n')
                    time.sleep(0.5)
                    continue
                    
                # Do not draw bounding boxes on the live feed to reduce the perception of lag.
                # Detection results are shown in the sidebar/ticker instead.
                ret_encode, jpeg = cv2.imencode('.jpg', frame)
                if not ret_encode:
                    continue
                    
                yield (b'--frame\r\n'
                       b'Content-Type: image/jpeg\r\n\r\n' + jpeg.tobytes() + b'\r\n')
                time.sleep(0.033)
        finally:
            with reader.lock:
                reader.viewers_count = max(0, reader.viewers_count - 1)
            
    return Response(generate_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')


# ============================================
# ADMIN/DASHBOARD ENDPOINTS
# ============================================

@app.route('/api/users', methods=['GET'])
def get_users():
    users = db.get_all_users()
    return jsonify({'users': users}), 200


@app.route('/api/users/<int:user_id>/update', methods=['POST'])
@app.route('/api/users/<int:user_id>', methods=['PUT'])
def api_update_user(user_id):
    try:
        data = request.get_json()
        name = data.get('name')
        email = data.get('email')
        phone = data.get('phone')
        department = data.get('department')
        notes = data.get('notes')
        
        if not name:
            return jsonify({'error': 'Name is required'}), 400
            
        success = db.update_user(user_id, name, email, phone, department, notes)
        
        if success:
            refresh_embedding_cache()
            return jsonify({'success': True, 'message': f"User '{name}' updated successfully"}), 200
        else:
            return jsonify({'error': 'User not found or update failed'}), 404
    except Exception as e:
        logger.error(f"API update user error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/users/<int:user_id>/delete', methods=['POST'])
@app.route('/api/users/<int:user_id>', methods=['DELETE'])
def api_delete_user(user_id):
    try:
        success = db.delete_user(user_id)
        if success:
            with cache_lock:
                if user_id in EMBEDDING_CACHE:
                    del EMBEDDING_CACHE[user_id]
                    logger.info(f"Evicted user ID {user_id} from EMBEDDING_CACHE")
            return jsonify({'success': True, 'message': f'User ID {user_id} deleted successfully'}), 200
        else:
            return jsonify({'error': 'User not found or deletion failed'}), 404
    except Exception as e:
        logger.error(f"API delete user error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/users/<int:user_id>/mark-absent', methods=['POST'])
def api_mark_user_absent(user_id):
    try:
        success = db.mark_user_absent_today(user_id)
        if success:
            remove_live_detection_for_user(user_id)
            return jsonify({'success': True, 'message': f'User ID {user_id} marked absent for today'}), 200
        else:
            return jsonify({'error': 'Failed to mark user absent'}), 400
    except Exception as e:
        logger.error(f"API mark absent error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/users/<int:user_id>/mark-present', methods=['POST'])
def api_mark_user_present(user_id):
    try:
        success = db.mark_user_present_today(user_id)
        if success:
            return jsonify({'success': True, 'message': f'User ID {user_id} marked present for today'}), 200
        else:
            return jsonify({'error': 'Failed to mark user present'}), 400
    except Exception as e:
        logger.error(f"API mark present error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/attendance/logs', methods=['GET'])
def get_attendance_logs():
    limit = request.args.get('limit', 100, type=int)
    logs = db.get_attendance_logs(limit)
    return jsonify({'logs': logs}), 200


@app.route('/api/attendance/user/<int:user_id>', methods=['GET'])
def get_user_attendance(user_id):
    days = request.args.get('days', 7, type=int)
    logs = db.get_attendance_by_user(user_id, days)
    return jsonify({'user_id': user_id, 'logs': logs, 'days': days}), 200


@app.route('/api/stats', methods=['GET'])
def get_stats():
    try:
        stats = db.get_attendance_statistics()
        users = db.get_all_users()
        return jsonify({
            'total_users': len(users),
            'today_attendance': stats.get('today_count', 0),
            'unique_users_today': stats.get('unique_users_today', 0),
            'total_logs': stats.get('total_records', 0),
            'avg_confidence': stats.get('avg_confidence', 0),
            'recent_entries': stats.get('recent_entries', []),
            'timestamp': datetime.now().isoformat()
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
            fp.get_yolo_model()
            fp.get_insightface_model()
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
    try:
        db.init_db()
        models_ok = verify_models()
        if models_ok:
            refresh_embedding_cache()
            return jsonify({'status': 'initialized', 'database': 'ready', 'models': 'ready', 'message': 'System ready'}), 200
        else:
            refresh_embedding_cache()
            return jsonify({'status': 'partial', 'database': 'ready', 'models': 'incomplete', 'message': 'Database ready but some models failed'}), 202
    except Exception as e:
        return jsonify({'status': 'failed', 'error': str(e)}), 500


@app.errorhandler(413)
def request_entity_too_large(error):
    return jsonify({'error': 'File too large. Max size: 500MB'}), 413

@app.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Endpoint not found'}), 404

@app.errorhandler(500)
def internal_error(error):
    return jsonify({'error': 'Internal server error'}), 500


import base64 as _b64

@app.route('/api/users/<int:user_id>/photo', methods=['POST'])
def upload_user_photo(user_id):
    """Upload professional profile photo for a user."""
    if 'photo' not in request.files:
        return jsonify({'error': 'No photo provided'}), 400
    photo = request.files['photo']
    if photo.filename == '':
        return jsonify({'error': 'No file selected'}), 400
    
    # Validate extension
    ext = photo.filename.rsplit('.', 1)[-1].lower()
    if ext not in ['jpg', 'jpeg', 'png', 'webp']:
        return jsonify({'error': 'Only jpg/png/webp allowed'}), 400
    
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
        
        db.save_user_photo(user_id, str(filepath))
        return jsonify({
            'success': True,
            'photo_url': f'/profile_photos/{filename}'
        }), 200
        
    except Exception as e:
        logger.error(f"Photo upload error: {e}")
        return jsonify({'error': f'Photo processing failed: {str(e)}'}), 500

@app.route('/api/users/<int:user_id>/photo', methods=['GET'])
def get_user_photo(user_id):
    """Serve profile photo for a user."""
    photo_path = db.get_user_photo(user_id)
    if not photo_path or not os.path.exists(photo_path):
        return jsonify({'error': 'No photo found'}), 404
    
    directory = os.path.dirname(os.path.abspath(photo_path))
    filename = os.path.basename(photo_path)
    return send_from_directory(directory, filename)

@app.route('/profile_photos/<path:filename>')
def serve_profile_photo_direct(filename):
    photos_dir = os.path.join(_FLASK_DIR, 'static', 'profile_photos')
    if os.path.exists(os.path.join(photos_dir, filename)):
        return send_from_directory(photos_dir, filename)
    photos_dir_alt = os.path.join(app.root_path, 'static', 'profile_photos')
    return send_from_directory(photos_dir_alt, filename)


# ============================================
# AUTH ENDPOINTS
# ============================================

@app.route('/api/login', methods=['POST'])
def api_login():
    data = request.get_json() or {}
    email = data.get('email', data.get('username', '')).strip()
    password = data.get('password', '').strip()
    if not email or not password:
        return jsonify({'success': False, 'message': 'Email and password required'}), 400
    user = db.authenticate_user(email, password)
    if not user:
        return jsonify({'success': False, 'message': 'Invalid credentials'}), 401
    safe = {k: v for k, v in user.items() if k != 'password'}
    return jsonify({'success': True, 'user': safe})


@app.route('/api/change-password', methods=['POST'])
def api_change_password():
    data = request.get_json() or {}
    user_id = data.get('user_id')
    new_pass = data.get('new_password', '')
    if not user_id or not new_pass:
        return jsonify({'success': False}), 400
    db.change_password(int(user_id), new_pass)
    return jsonify({'success': True})


# ============================================
# STAFF / USER ENDPOINTS
# ============================================

def _safe_user(u):
    return {k: v for k, v in u.items() if k != 'password'} if u else {}


@app.route('/api/staff', methods=['GET'])
def api_get_staff():
    role = request.args.get('role')
    users = db.get_all_users(role=role)
    return jsonify([_safe_user(u) for u in users])


@app.route('/api/staff', methods=['POST'])
def api_add_staff():
    data = request.get_json() or {}
    uid = db.add_user(
        name=data.get('name', ''),
        email=data.get('email', ''),
        password=data.get('password', '123456'),
        role=data.get('role', 'staff'),
        department=data.get('department', ''),
        phone=data.get('phone', ''),
        notes=data.get('notes', ''),
        cnic=data.get('cnic', ''),
        position=data.get('position', ''),
        salary=float(data.get('salary', 0) or 0),
        join_date=data.get('join_date', ''),
    )
    if uid is None:
        return jsonify({'success': False, 'message': 'Email already exists'}), 409
    return jsonify({'success': True, 'user': _safe_user(db.get_user_by_id(uid))}), 201


@app.route('/api/users/<int:user_id>', methods=['GET'])
def api_get_user(user_id):
    user = db.get_user_by_id(user_id)
    if not user:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(_safe_user(user))


# ============================================
# ATTENDANCE ENDPOINTS
# ============================================

@app.route('/api/attendance', methods=['GET'])
def api_get_attendance():
    user_id = request.args.get('user_id', type=int)
    limit = request.args.get('limit', 200, type=int)
    start = request.args.get('start')
    end = request.args.get('end')
    if user_id and start and end:
        logs = db.get_attendance_by_user(user_id, start, end)
    elif user_id:
        logs = db.get_attendance_by_user(user_id)
    else:
        logs = db.get_attendance_logs(limit=limit)
    return jsonify(logs)


@app.route('/api/attendance/today', methods=['GET'])
def api_attendance_today():
    return jsonify(db.get_attendance_today())


@app.route('/api/attendance/mark-absent', methods=['POST'])
def api_mark_absent():
    data = request.get_json() or {}
    user_id = data.get('user_id')
    if not user_id:
        return jsonify({'success': False}), 400
    user_id = int(user_id)
    success = db.mark_user_absent_today(user_id)
    if success:
        remove_live_detection_for_user(user_id)
    return jsonify({'success': success})


# ============================================
# LEAVE ENDPOINTS
# ============================================

@app.route('/api/leaves', methods=['GET'])
def api_get_leaves():
    user_id = request.args.get('user_id', type=int)
    status = request.args.get('status')
    return jsonify(db.get_leave_requests(user_id=user_id, status=status))


@app.route('/api/leaves', methods=['POST'])
def api_add_leave():
    data = request.get_json() or {}
    user_id = data.get('user_id')
    if not user_id:
        return jsonify({'success': False, 'message': 'user_id required'}), 400
    user = db.get_user_by_id(int(user_id))
    lid = db.add_leave_request(
        user_id=int(user_id),
        user_name=user['name'] if user else data.get('user_name', ''),
        leave_type=data.get('leave_type', 'annual'),
        start_date=data.get('start_date', ''),
        end_date=data.get('end_date', ''),
        reason=data.get('reason', ''),
    )
    return jsonify({'success': True, 'id': lid}), 201


@app.route('/api/leaves/<int:leave_id>', methods=['PUT'])
def api_update_leave(leave_id):
    data = request.get_json() or {}
    db.update_leave_status(leave_id, data.get('status', 'approved'), data.get('approved_by', 'Admin'))
    return jsonify({'success': True})


@app.route('/api/leaves/<int:leave_id>', methods=['DELETE'])
def api_delete_leave(leave_id):
    db.delete_leave_request(leave_id)
    return jsonify({'success': True})


# ============================================
# OVERTIME ENDPOINTS
# ============================================

@app.route('/api/overtime', methods=['GET'])
def api_get_overtime():
    user_id = request.args.get('user_id', type=int)
    status = request.args.get('status')
    return jsonify(db.get_overtime(user_id=user_id, status=status))


@app.route('/api/overtime', methods=['POST'])
def api_add_overtime():
    data = request.get_json() or {}
    user_id = data.get('user_id')
    if not user_id:
        return jsonify({'success': False}), 400
    user = db.get_user_by_id(int(user_id))
    oid = db.add_overtime(
        user_id=int(user_id),
        user_name=user['name'] if user else data.get('user_name', ''),
        ot_date=data.get('ot_date', ''),
        hours=float(data.get('hours', 0) or 0),
        reason=data.get('reason', ''),
    )
    return jsonify({'success': True, 'id': oid}), 201


@app.route('/api/overtime/<int:ot_id>', methods=['PUT'])
def api_update_overtime(ot_id):
    data = request.get_json() or {}
    db.update_overtime_status(ot_id, data.get('status', 'approved'), data.get('approved_by', 'Admin'))
    return jsonify({'success': True})


# ============================================
# SALARY ENDPOINTS
# ============================================

@app.route('/api/salary', methods=['GET'])
def api_get_all_salary():
    return jsonify(db.get_all_salary_configs())


@app.route('/api/salary/<int:user_id>', methods=['GET'])
def api_get_salary(user_id):
    return jsonify(db.get_salary_config(user_id) or {})


@app.route('/api/salary', methods=['POST'])
@app.route('/api/salary/<int:user_id>', methods=['PUT'])
def api_set_salary(user_id=None):
    data = request.get_json() or {}
    user_id = user_id or data.get('user_id')
    if not user_id:
        return jsonify({'success': False}), 400
    db.set_salary_config(
        user_id=int(user_id),
        basic_salary=float(data.get('basic_salary', 0) or 0),
        allowances=float(data.get('allowances', 0) or 0),
        deductions=float(data.get('deductions', 0) or 0),
        ot_rate=float(data.get('ot_rate', 0) or 0),
    )
    return jsonify({'success': True})


# ============================================
# LEGACY ROUTES (for backward compatibility)
# ============================================

@app.route('/get_staff_list')
def legacy_staff_list():
    return jsonify([_safe_user(u) for u in db.get_all_users()])


@app.route('/add_staff', methods=['POST', 'OPTIONS'])
def legacy_add_staff():
    data = request.get_json() or {}
    uid = db.add_user(
        name=data.get('name', ''), email=data.get('email', ''),
        password=data.get('password', '123456'), role=data.get('role', 'staff'),
        department=data.get('department', ''), phone=data.get('phone', ''),
        notes=data.get('notes', ''), cnic=data.get('cnic', ''),
        position=data.get('position', ''), salary=float(data.get('salary', 0) or 0),
        join_date=data.get('join_date', '')
    )
    if uid is None:
        return jsonify({'success': False, 'message': 'Email already exists'}), 409
    return jsonify({'success': True, 'id': uid})


@app.route('/get_attendance_today')
def legacy_get_attendance_today():
    stats = db.get_attendance_statistics()
    users = db.get_all_users()
    present = [u for u in users if db.is_user_present_today(u['id'])]
    absent = [u for u in users if not db.is_user_present_today(u['id'])]
    return jsonify({
        'present': [_safe_user(u) for u in present],
        'absent': [_safe_user(u) for u in absent],
        'total': stats['total_users'],
        'present_count': stats['present_today'],
        'absent_count': stats['absent_today'],
    })


@app.route('/get_attendance_today_array')
def legacy_attendance_today_array():
    return jsonify(db.get_attendance_today())


@app.route('/get_pending_leaves')
def legacy_pending_leaves():
    return jsonify(db.get_leave_requests(status='pending'))


@app.route('/update_leave_status', methods=['POST'])
def legacy_update_leave():
    data = request.get_json() or {}
    db.update_leave_status(data.get('leave_id'), data.get('status', 'approved'), 'Admin')
    return jsonify({'success': True})


@app.route('/get_detected_name/all')
def legacy_detected_name_all():
    with cache_lock:
        dets = list(LATEST_STREAM_DETECTIONS)
    return jsonify({
        'nvr': dets, 'dvr': dets, 'detections': dets,
        'name': dets[0]['name'] if dets else 'No Detection',
    })


@app.route('/get_detected_name/nvr')
def legacy_detected_name_nvr():
    return jsonify({'camera': 'nvr', 'detected_names': [], 'names': []})


@app.route('/get_detected_name/dvr')
def legacy_detected_name_dvr():
    return jsonify({'camera': 'dvr', 'detected_names': [], 'names': []})


@app.route('/get_staff_by_name')
def legacy_get_staff_by_name():
    name = request.args.get('name', '').strip().lower()
    users = db.get_all_users()
    match = next((u for u in users if u['name'].strip().lower() == name), None)
    if match:
        return jsonify({k: v for k, v in match.items() if k != 'password'})
    return jsonify({'error': 'Not found'}), 404


@app.route('/get_attendance_by_name')
def legacy_get_attendance_by_name():
    name = request.args.get('name', '').strip().lower()
    logs = db.get_attendance_logs(limit=500)
    matched = [l for l in logs if l.get('user_name', '').strip().lower() == name]
    return jsonify(matched)


@app.route('/video_feed/nvr_raw')
def legacy_nvr_raw():
    return video_stream('nvr_office')


@app.route('/video_feed/dvr_raw')
def legacy_dvr_raw():
    return video_stream('dvr_office')


if __name__ == '__main__':
    logger.info("\n" + "="*60)
    logger.info("Flask AI Attendance System - Starting")
    logger.info("="*60)
    
    try:
        db.init_db()
        logger.info("✓ Database initialized")
        refresh_embedding_cache()
        
        logger.info("[*] Warming up AI models (InsightFace)...")
        fp.get_insightface_model()
        logger.info("✓ AI models loaded and warmed up successfully")
        
        import os
        if os.environ.get('WERKZEUG_RUN_MAIN') == 'true' or not app.debug:
            logger.info("[*] Proactively initializing background camera stream readers (non-blocking)...")
            # Webcam starts immediately (no network timeout)
            get_or_create_reader('webcam', WEBCAM_URL)
            logger.info("[OK] Webcam stream reader ready.")
            # NVR/DVR RTSP streams are slow to connect — start them in daemon threads
            # so they don't block Flask from starting and serving webcam requests
            def _prewarm_rtsp():
                try:
                    get_or_create_reader('nvr_office', NVR_OFFICE_URL)
                    get_or_create_reader('dvr_office', DVR_OFFICE_URL)
                except Exception as ex:
                    logger.warning(f"[RTSP pre-warm] Could not connect: {ex}")
            threading.Thread(target=_prewarm_rtsp, daemon=True).start()
    except Exception as e:
        logger.error(f"✗ Startup initialization failed: {e}")
    
    port = int(os.environ.get("CAMERA_ENGINE_PORT", 5001))
    logger.info(f"Starting camera engine server on http://localhost:{port}")
    logger.info("="*60 + "\n")
    
    app.run(debug=True, host='0.0.0.0', port=port, use_reloader=False)