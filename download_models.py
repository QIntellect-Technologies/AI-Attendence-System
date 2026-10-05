"""Download and initialize YOLO and InsightFace models."""

import os
import sys
from pathlib import Path


MODELS_DIR = Path('./models')
MODELS_DIR.mkdir(exist_ok=True)


def download_yolo_model():
    """Download YOLOv8 face detection model."""
    print("[*] Downloading YOLOv8 model for face detection...")
    try:
        from ultralytics import YOLO
        # This will auto-download YOLOv8n (nano) for fast face detection
        model = YOLO('yolov8n.pt')
        print("✓ YOLOv8 model downloaded successfully")
        return model
    except Exception as e:
        print(f"✗ Failed to download YOLOv8: {e}")
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
