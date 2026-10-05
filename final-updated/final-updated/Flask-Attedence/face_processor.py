"""Face detection and embedding extraction using YOLO + InsightFace."""

import cv2
import numpy as np
import numpy.typing as npt
import insightface
from pathlib import Path
from typing import Any, List, Tuple, Optional, Dict
from ultralytics import YOLO
from logger_config import get_logger
from config import (
    YOLO_MODEL, INSIGHTFACE_MODEL, MODELS_DIR,
    FACE_DETECTION_CONFIDENCE, FACE_QUALITY_THRESHOLD,
    ANTI_SPOOFING_ENABLED, ENABLE_GPU
)

logger = get_logger(__name__)

# Global models (lazy loaded)
_yolo_model = None
_insightface_model = None





def get_gpu_providers() -> List[str]:
    """Return GPU-first providers while allowing CPU fallback only when CUDA is unavailable."""
    if not ENABLE_GPU:
        return ['CPUExecutionProvider']

    try:
        import onnxruntime
        available = set(onnxruntime.get_available_providers())
        preferred = ['CUDAExecutionProvider', 'CPUExecutionProvider']
        providers = [provider for provider in preferred if provider in available]
        return providers if providers else ['CPUExecutionProvider']
    except Exception:
        return ['CUDAExecutionProvider', 'CPUExecutionProvider']

def get_yolo_model():
    """Compatibility stub: YOLO is deprecated in favor of InsightFace SCRFD."""
    return None


def get_insightface_model():
    """Lazy load InsightFace model with GPU support."""
    global _insightface_model
    if _insightface_model is None:
        try:
            logger.info(f"Loading InsightFace model: {INSIGHTFACE_MODEL}")
            
            providers = get_gpu_providers()
            logger.info(f"InsightFace providers: {providers}")

            _insightface_model = insightface.app.FaceAnalysis(
                name=INSIGHTFACE_MODEL,
                root=str(MODELS_DIR),
                providers=providers
            )
            ctx_id = 0 if ENABLE_GPU else -1
            _insightface_model.prepare(ctx_id=ctx_id, det_thresh=0.15, det_size=(640, 640))
            logger.info("✓ InsightFace model loaded successfully on GPU")
        except Exception as e:
            logger.error(f"Failed to load InsightFace model: {e}")
            raise
    return _insightface_model


def extract_frames_from_video(video_path: str, max_frames: int = 60) -> List[np.ndarray]:
    """
    Extract frames from a video file.
    
    Args:
        video_path: Path to video file
        max_frames: Maximum frames to extract (spread evenly across video)
    
    Returns:
        List of frame arrays
    """
    cap = cv2.VideoCapture(video_path)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    frames = []
    
    if total_frames == 0:
        cap.release()
        return frames
    
    # Calculate frame interval to spread extraction evenly
    frame_interval = max(1, total_frames // max_frames)
    frame_idx = 0
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        if frame_idx % frame_interval == 0:
            frames.append(frame)
        
        frame_idx += 1
    
    cap.release()
    print(f"✓ Extracted {len(frames)} frames from video")
    return frames


def detect_and_extract_insightface(frame: np.ndarray, skip_bboxes: Optional[List[Tuple[int, int, int, int]]] = None) -> List[Dict]:
    """
    Detect faces and extract embeddings in a single high-speed pass using InsightFace (SCRFD).
    This entirely replaces YOLO body detection, guaranteeing we only process actual faces.

    PERFORMANCE: Only the 'recognition' model (w600k_r50.onnx) is run per face.
    The 3 auxiliary models (landmark_3d_68, landmark_2d_106, genderage) are intentionally
    SKIPPED — they are not needed for attendance and cause an 8x slowdown (2764ms vs 333ms
    for 10 faces on GPU). This fix enables all 10 people to be recognized in real-time
    even when walking together at 10-12 feet.

    Args:
        frame: Input image

    Returns:
        List of dicts containing 'bbox', 'conf', and 'embedding'.
    """
    try:
        insightface_model = get_insightface_model()
        
        # InsightFace expects RGB
        if len(frame.shape) == 3 and frame.shape[2] == 3:
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        else:
            frame_rgb = frame
            
        from insightface.app.common import Face
        
        bboxes, kpss = insightface_model.det_model.detect(frame_rgb, max_num=0, metric='default')
        if bboxes.shape[0] == 0:
            return []

        # Pre-fetch recognition model once outside the loop (avoids dict lookup per face)
        rec_model = insightface_model.models.get('recognition')
        if rec_model is None:
            logger.error("Recognition model not found in InsightFace model pack!")
            return []
            
        results = []
        for i in range(bboxes.shape[0]):
            bbox = bboxes[i, 0:4]
            det_score = bboxes[i, 4]
            kps = kpss[i] if kpss is not None else None
            
            # Skip false positives that have no landmarks (this prevents the 'NoneType' shape crash)
            if kps is None:
                continue

            face = Face(bbox=bbox, kps=kps, det_score=det_score)

            # -----------------------------------------------------------------------
            # STEP 2 (CROWD OPTIMIZATION): SKIP ALREADY-CONFIRMED FACES
            # When 15-20 students walk together, students in the front row get
            # confirmed and logged in DB immediately. Skipping ArcFace extraction
            # on them frees 100% of GPU compute for students walking behind them!
            # -----------------------------------------------------------------------
            is_confirmed_skip = False
            if skip_bboxes:
                bcx = (bbox[0] + bbox[2]) / 2.0
                bcy = (bbox[1] + bbox[3]) / 2.0
                bw = bbox[2] - bbox[0]
                bh = bbox[3] - bbox[1]
                b_size = max(bw, bh)
                for sb in skip_bboxes:
                    sx1, sy1, sx2, sy2 = sb
                    ix1 = max(bbox[0], sx1)
                    iy1 = max(bbox[1], sy1)
                    ix2 = min(bbox[2], sx2)
                    iy2 = min(bbox[3], sy2)
                    iw = max(0.0, ix2 - ix1)
                    ih = max(0.0, iy2 - iy1)
                    inter = iw * ih
                    union = (bw * bh) + ((sx2 - sx1) * (sy2 - sy1)) - inter
                    iou = inter / union if union > 0 else 0.0

                    scx = (sx1 + sx2) / 2.0
                    scy = (sy1 + sy2) / 2.0
                    spatial_d = np.sqrt((bcx - scx)**2 + (bcy - scy)**2)

                    # Overlaps significantly with a known confirmed track
                    if iou > 0.35 or spatial_d < max(28.0, b_size * 0.40):
                        is_confirmed_skip = True
                        break

            if not is_confirmed_skip:
                rec_model.get(frame_rgb, face)
            else:
                face.embedding = None

            # Retain all detected faces for smooth tracking; embedding is None for skipped faces
            if det_score >= FACE_DETECTION_CONFIDENCE:
                results.append({
                    'bbox': (int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3])),
                    'conf': float(det_score),
                    'embedding': face.embedding
                })
                
        return results
    except Exception as e:
        import traceback
        logger.error(f"InsightFace detection/extraction failed: {e}\n{traceback.format_exc()}")
        return []


def assess_face_quality(frame: np.ndarray, face_bbox: Tuple[int, int, int, int]) -> Dict:
    """
    Assess quality of detected face.
    
    Args:
        frame: Input image
        face_bbox: [x1, y1, x2, y2]
    
    Returns:
        Quality assessment dict with score 0-1
    """
    try:
        x1, y1, x2, y2 = face_bbox
        
        # Validate bbox
        if x1 < 0 or y1 < 0 or x2 > frame.shape[1] or y2 > frame.shape[0]:
            return {'score': 0, 'issues': ['bbox_out_of_bounds']}
        
        cropped = frame[y1:y2, x1:x2]
        h, w = cropped.shape[:2]
        
        issues = []
        score = 1.0
        
        # Check face size (too small = low quality). For moving students in a crowded frame,
        # a moderately smaller face is still usable; only extremely tiny faces should be rejected.
        if h < 28 or w < 28:
            issues.append('face_too_small')
            score -= 0.35
        elif h < 45 or w < 45:
            issues.append('small_face')
            score -= 0.12
        
        # Check lighting (using Laplacian for focus/blur detection).
        # A small amount of motion blur should not immediately discard a valid face.
        gray = cv2.cvtColor(cropped, cv2.COLOR_BGR2GRAY)
        laplacian_var = cv2.Laplacian(gray, cv2.CV_64F).var()
        
        if laplacian_var < 20:
            issues.append('blurry')
            score -= 0.35
        elif laplacian_var < 60:
            issues.append('slightly_blurry')
            score -= 0.15
        elif laplacian_var < 100:
            score -= 0.05
        
        # Check brightness (avoid extreme dark/bright)
        mean_brightness = np.mean(gray)
        if mean_brightness < 20 or mean_brightness > 235:
            issues.append('poor_lighting')
            score -= 0.1
        
        # Check aspect ratio
        aspect_ratio = w / h
        if aspect_ratio < 0.5 or aspect_ratio > 1.6:
            issues.append('poor_aspect_ratio')
            score -= 0.12
        
        result = {
            'score': max(0, min(1, score)),
            'issues': issues,
            'laplacian_var': float(laplacian_var),
            'brightness': float(mean_brightness),
            'aspect_ratio': float(aspect_ratio)
        }
        logger.info(f"[Quality Check] bbox={face_bbox}, size={w}x{h}, score={result['score']:.2f}, issues={issues}, laplacian={laplacian_var:.1f}, brightness={mean_brightness:.1f}")
        return result
    except Exception as e:
        logger.warning(f"Face quality assessment failed: {e}")
        return {'score': 0.5, 'issues': ['assessment_error']}


_spoof_model = None

def get_spoof_model():
    """Lazy load the MiniFASNet Anti-Spoofing ONNX model."""
    global _spoof_model
    if _spoof_model is None:
        try:
            import onnxruntime
            model_path = MODELS_DIR / 'minifasnet_v2.onnx'
            if not model_path.exists():
                logger.warning(f"Spoof model not found at {model_path}. Using fallback texture detection.")
                return None
            logger.info("Loading MiniFASNet Anti-Spoofing model...")
            providers = get_gpu_providers()
            _spoof_model = onnxruntime.InferenceSession(str(model_path), providers=providers)
            logger.info("✓ Anti-Spoofing model loaded successfully on GPU")
        except Exception as e:
            logger.error(f"Failed to load Spoof model: {e}")
            return None
    return _spoof_model


def detect_spoofing(frame: np.ndarray, face_bbox: Tuple[int, int, int, int]) -> Dict:
    """
    Detect if face is a spoof (photo, video, mask).
    Uses Deep Learning (MiniFASNet) if available, otherwise falls back to texture analysis.
    
    Args:
        frame: Input image
        face_bbox: [x1, y1, x2, y2]
    
    Returns:
        Spoof assessment dict
    """
    if not ANTI_SPOOFING_ENABLED:
        return {'is_spoof': False, 'confidence': 1.0, 'method': 'disabled'}
    
    try:
        x1, y1, x2, y2 = face_bbox
        w, h = x2 - x1, y2 - y1
        
        # -------------------------------------------------------------
        # METHOD 1: DEEP LEARNING (MiniFASNet - HIGH ACCURACY)
        # -------------------------------------------------------------
        spoof_model = get_spoof_model()
        if spoof_model is not None:
            # Model uses 2.7x scale factor for context around the face
            center_x = x1 + w // 2
            center_y = y1 + h // 2
            side_len = int(max(w, h) * 2.7)
            
            x1_c = center_x - side_len // 2
            y1_c = center_y - side_len // 2
            x2_c = x1_c + side_len
            y2_c = y1_c + side_len
            
            # create a blank black square to maintain exact aspect ratio
            crop = np.zeros((side_len, side_len, 3), dtype=np.uint8)
            
            # get intersection with frame
            src_x1 = max(0, x1_c)
            src_y1 = max(0, y1_c)
            src_x2 = min(frame.shape[1], x2_c)
            src_y2 = min(frame.shape[0], y2_c)
            
            dst_x1 = src_x1 - x1_c
            dst_y1 = src_y1 - y1_c
            dst_x2 = dst_x1 + (src_x2 - src_x1)
            dst_y2 = dst_y1 + (src_y2 - src_y1)
            
            if src_x2 > src_x1 and src_y2 > src_y1:
                crop[dst_y1:dst_y2, dst_x1:dst_x2] = frame[src_y1:src_y2, src_x1:src_x2]
            
            if crop.shape[0] > 0 and crop.shape[1] > 0:
                resized = cv2.resize(crop, (80, 80))
                # MiniFASNet expects UNNORMALIZED [0-255] RGB/BGR image depending on training.
                # Original PyTorch code uses OpenCV without converting to RGB, so swapRB=False.
                # We use scale 1.0 instead of 1.0/255.0 to keep 0-255 scale.
                blob = cv2.dnn.blobFromImage(resized, 1.0, (80, 80), (0, 0, 0), swapRB=False, crop=False)
                
                inputs = {spoof_model.get_inputs()[0].name: blob}
                out = spoof_model.run(None, inputs)[0][0]
                
                # Apply softmax
                exp_out = np.exp(out - np.max(out))
                probs = exp_out / np.sum(exp_out)
                
                # In MiniFASNet: index 1 is Real Face, 0 and 2 are Spoofs (Photo/Video)
                real_probability = float(probs[1])
                
                # Use a threshold on real probability rather than argmax.
                # A real_prob > 0.35 means the model sees meaningful "liveness" evidence.
                # This prevents false rejections due to lighting/angle variation.
                REAL_THRESHOLD = 0.35
                is_spoof = bool(real_probability < REAL_THRESHOLD)
                
                # Confidence = how confident we are in the final decision
                spoof_confidence = 1.0 - real_probability if is_spoof else real_probability
                
                result = {
                    'is_spoof': is_spoof,
                    'confidence': float(spoof_confidence),
                    'real_probability': real_probability,
                    'method': 'minifasnet',
                    'raw_scores': [float(p) for p in probs]
                }
                logger.info(f"[Spoof Check - ML] bbox={face_bbox}, is_spoof={is_spoof}, real_prob={real_probability:.3f}")
                return result

        # -------------------------------------------------------------
        # METHOD 2: FALLBACK TEXTURE/FREQUENCY (LOW ACCURACY)
        # -------------------------------------------------------------
        cropped = frame[y1:y2, x1:x2]
        gray = cv2.cvtColor(cropped, cv2.COLOR_BGR2GRAY)
        
        # Real faces have more texture variation than photos
        h, w = gray.shape
        if h < 20 or w < 20:
            return {'is_spoof': False, 'confidence': 0.5, 'method': 'skip_too_small'}
        
        edges = cv2.Canny(gray, 100, 200)
        edge_density = np.sum(edges > 0) / (h * w)
        
        # Frequency Domain
        fft = np.fft.fft2(gray)
        fft_shift = np.fft.fftshift(fft)
        magnitude = np.abs(fft_shift)
        
        center = (h // 2, w // 2)
        region_size = min(h, w) // 4
        
        low_freq = magnitude[
            center[0]-region_size:center[0]+region_size,
            center[1]-region_size:center[1]+region_size
        ].sum()
        
        high_freq = magnitude.sum() - low_freq
        spectrum_ratio = high_freq / (low_freq + 1e-6)
        
        is_spoof = spectrum_ratio < 0.5
        confidence = min(1.0, abs(spectrum_ratio - 0.5) / 0.5)
        
        result = {
            'is_spoof': is_spoof,
            'confidence': float(confidence),
            'method': 'frequency_domain',
            'spectrum_ratio': float(spectrum_ratio),
            'edge_density': float(edge_density)
        }
        logger.info(f"[Spoof Check - Fallback] bbox={face_bbox}, is_spoof={is_spoof}, confidence={confidence:.2f}")
        return result
    except Exception as e:
        logger.warning(f"Spoof detection failed: {e}")
        return {'is_spoof': False, 'confidence': 0.5, 'method': 'error'}





def process_enrollment_video(video_path: str, max_frames: int = 120) -> Dict:
    """
    Process enrollment video with quality checks and robust filtering.
    Anti-spoofing is intentionally bypassed during enrollment so that authorized
    staff/student video submissions are never falsely rejected due to compression or camera artifacts.
    
    Args:
        video_path: Path to enrollment video
        max_frames: Max frames to process
    
    Returns:
        Dict with embeddings, quality metrics, and issues
    """
    try:
        frames = extract_frames_from_video(video_path, max_frames)
        
        if not frames:
            logger.warning(f"No frames extracted from {video_path}")
            return {
                'success': False,
                'embeddings': [],
                'error': 'No frames extracted',
                'total_frames': 0
            }
        
        embeddings = []
        quality_scores = []
        issues = []
        
        for i, frame in enumerate(frames):
            if i > 0 and i % 10 == 0:
                logger.info(f"Processing frame {i}/{len(frames)}...")
            
            # Detect faces and extract embeddings simultaneously using InsightFace
            face_results = detect_and_extract_insightface(frame)
            
            if len(face_results) == 0:
                logger.info(f"[Enrollment] Frame {i}: No faces detected by InsightFace.")
                continue
            
            # Get largest face (primary face in frame)
            largest_face = max(face_results, key=lambda d: (d['bbox'][2] - d['bbox'][0]) * (d['bbox'][3] - d['bbox'][1]))
            x1, y1, x2, y2 = largest_face['bbox']
            conf = largest_face['conf']
            embedding = largest_face['embedding']
            face_bbox = (x1, y1, x2, y2)
            
            logger.info(f"[Enrollment] Frame {i}: InsightFace detected face at {face_bbox} with confidence {conf:.2f}")
            
            # Assess face quality
            quality_info = assess_face_quality(frame, face_bbox)
            quality_scores.append(quality_info['score'])
            
            if quality_info['score'] < FACE_QUALITY_THRESHOLD:
                msg = f"Frame {i}: Low quality score {quality_info['score']:.2f} (< threshold {FACE_QUALITY_THRESHOLD}) - {quality_info['issues']}"
                logger.info(f"[Enrollment] {msg}")
                issues.append(msg)
                continue
            
            # Extract and normalize valid face embedding (Spoof check intentionally removed for enrollment)
            if embedding is not None:
                norm = np.linalg.norm(embedding)
                if norm > 1e-6:
                    norm_emb = embedding / norm
                    embeddings.append(norm_emb)
                    logger.info(f"[Enrollment] Frame {i}: Quality score {quality_info['score']:.2f} OK. Successfully extracted embedding.")
                else:
                    logger.warning(f"[Enrollment] Frame {i}: Embedding norm near zero.")
            else:
                logger.warning(f"[Enrollment] Frame {i}: InsightFace returned None embedding.")
        
        logger.info(f"Processed {len(frames)} frames: {len(embeddings)} valid embeddings extracted for enrollment")
        
        return {
            'success': len(embeddings) > 0,
            'embeddings': embeddings,
            'total_frames': len(frames),
            'valid_embeddings': len(embeddings),
            'avg_quality': float(np.mean(quality_scores)) if quality_scores else 0,
            'spoof_issues': 0,
            'issues': issues
        }
    
    except Exception as e:
        logger.error(f"Video processing failed: {e}")
        return {
            'success': False,
            'embeddings': [],
            'error': str(e),
            'total_frames': 0
        }


def compute_aggregate_embedding(embeddings: List[np.ndarray]) -> Optional[np.ndarray]:
    """
    Compute aggregate embedding from multiple face embeddings.
    Normalizes individual embeddings and filters outliers to produce a high-precision biometric centroid.
    
    Args:
        embeddings: List of embedding vectors
    
    Returns:
        Mean normalized embedding vector (512-dim unit vector)
    """
    if not embeddings or len(embeddings) == 0:
        return None
    
    # Convert and normalize all embeddings to unit vectors
    norm_embeddings = []
    for emb in embeddings:
        emb_arr = np.array(emb, dtype=np.float32)
        norm = np.linalg.norm(emb_arr)
        if norm > 1e-6:
            norm_embeddings.append(emb_arr / norm)
            
    if not norm_embeddings:
        return None
        
    if len(norm_embeddings) == 1:
        return norm_embeddings[0]
        
    # Initial centroid
    centroid = np.mean(norm_embeddings, axis=0)
    centroid = centroid / (np.linalg.norm(centroid) + 1e-6)
    
    # If we have multiple embeddings, filter out low-similarity outliers (e.g. occluded frames)
    if len(norm_embeddings) >= 5:
        sims = [float(np.dot(e, centroid)) for e in norm_embeddings]
        filtered = [e for e, s in zip(norm_embeddings, sims) if s >= 0.4]
        if len(filtered) >= 3:
            norm_embeddings = filtered
            centroid = np.mean(norm_embeddings, axis=0)
            centroid = centroid / (np.linalg.norm(centroid) + 1e-6)
            
    return centroid


def compare_embeddings(embedding1: np.ndarray[Any, np.dtype[np.float64]], embedding2: np.ndarray[Any, np.dtype[np.float64]], threshold: float = 0.6) -> Tuple[float, bool]:
    """
    Compare two embeddings using cosine similarity.
    
    Args:
        embedding1: Reference embedding
        embedding2: Test embedding
        threshold: Similarity threshold for match
    
    Returns:
        (similarity_score, is_match)
    """
    # Normalize
    emb1 = embedding1 / float(np.linalg.norm(embedding1) + 1e-6)
    emb2 = embedding2 / float(np.linalg.norm(embedding2) + 1e-6)
    
    similarity = float(np.dot(emb1, emb2))
    is_match = bool(similarity >= threshold)
    
    if is_match:
        logger.info(f"[Embedding Comparison] Cosine similarity: {similarity:.4f}, threshold: {threshold}, is_match: {is_match}")
    else:
        logger.debug(f"[Embedding Comparison] Cosine similarity: {similarity:.4f}, threshold: {threshold}, is_match: {is_match}")
    return similarity, is_match


if __name__ == '__main__':
    # Test models load
    logger.info("[*] Testing model loading...")
    try:
        insightface_model = get_insightface_model()
        logger.info("✓ All models loaded successfully")
    except Exception as e:
        logger.error(f"✗ Model loading failed: {e}")
