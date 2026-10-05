"""Download and initialize YOLO and InsightFace models."""

import os
import sys
from pathlib import Path

# ---------------------------------------------------------------
# PyTorch 2.6+ FIX: weights_only now defaults to True which
# blocks loading YOLO .pt files (Ultralytics custom classes).
# We patch torch.load BEFORE importing ultralytics to allow it.
# ---------------------------------------------------------------
try:
    import torch
    _original_torch_load = torch.load
    def _patched_torch_load(f, *args, **kwargs):
        kwargs.setdefault('weights_only', False)
        return _original_torch_load(f, *args, **kwargs)
    torch.load = _patched_torch_load
except Exception:
    pass  # torch not available yet, ultralytics will handle it

# If running as a PyInstaller exe, look for models in bundled directory
if getattr(sys, 'frozen', False):
    _BASE = Path(sys._MEIPASS)
else:
    _BASE = Path(__file__).parent

MODELS_DIR = _BASE / 'models'
_YOLO_PT = _BASE / 'yolov8n.pt'


def download_yolo_model():
    """Download YOLOv8 face detection model."""
    print("[*] Verifying YOLOv8 model for face detection...")
    try:
        from ultralytics import YOLO
        # If yolov8n.pt exists next to exe, use it directly (no download needed)
        yolo_path = str(_YOLO_PT) if _YOLO_PT.exists() else 'yolov8n.pt'
        model = YOLO(yolo_path)
        print(f"✓ YOLOv8 model ready: {yolo_path}")
        return model
    except Exception as e:
        print(f"✗ Failed to load YOLOv8: {e}")
        return None


def download_insightface_model():
    """Download InsightFace model for face embeddings."""
    print("[*] Setting up InsightFace model...")
    try:
        import insightface
        
        # Initialize the model - will auto-download if not present
        model = insightface.app.FaceAnalysis(
            name='buffalo_l',  # Large model, good accuracy
            root=str(MODELS_DIR),
            providers=['CUDAExecutionProvider', 'CPUExecutionProvider']
        )
        model.prepare(ctx_id=0, det_thresh=0.5, det_size=(640, 640))
        print("✓ InsightFace model initialized successfully")
        return model
    except Exception as e:
        print(f"✗ Failed to set up InsightFace: {e}")
        return None


def verify_models():
    """Verify both models are ready."""
    print("\n[*] Verifying models...")
    
    yolo = download_yolo_model()
    insightface = download_insightface_model()
    
    if yolo and insightface:
        print("\n✓✓ All models ready!")
        return True
    else:
        print("\n✗ Some models failed to load")
        return False


if __name__ == '__main__':
    verify_models()
