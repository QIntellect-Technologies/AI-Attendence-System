"""
shared_face_engine/model_loader.py

Shared InsightFace model loader used by:

- Trainer Desktop
- Local Node

The backend never imports this module.

Features
--------
✓ Singleton model instance
✓ GPU -> CPU automatic fallback
✓ Bundled model staging
✓ Reusable from any application
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any
import threading
import insightface
import numpy as np

logger = logging.getLogger(__name__)

# --------------------------------------------------------
# Configuration
# --------------------------------------------------------

MODEL_NAME = "buffalo_l"

DETECTION_SIZE = (640, 640)

DEFAULT_PROVIDERS = [
    "CUDAExecutionProvider",
    "CPUExecutionProvider",
]

CPU_ONLY_PROVIDER = [
    "CPUExecutionProvider",
]

# --------------------------------------------------------
# Singleton
# --------------------------------------------------------

_face_model: Any | None = None

_gpu_enabled: bool = False

_model_lock = threading.Lock()
_stage_lock = threading.Lock()

# --------------------------------------------------------
# Helpers
# --------------------------------------------------------


def _bundled_model_path() -> Path:
    """
    shared_face_engine/
        bundled_models/
            models/
                buffalo_l/
    """
    return (
        Path(__file__).resolve().parent
        / "bundled_models"
        / "models"
        / MODEL_NAME
    )


def _target_model_path(models_root: Path) -> Path:
    """
    models/

        models/

            buffalo_l/
    """
    return models_root / "models" / MODEL_NAME


def stage_models(models_root: Path) -> None:
    """
    Copy bundled ONNX models into the runtime models directory.
    Trainer and Local Node both call this. If models already exist,
    nothing happens. Locked so two threads never copy the same files
    concurrently on first run.
    """
    destination = _target_model_path(models_root)

    if destination.exists() and any(destination.glob("*.onnx")):
        return

    with _stage_lock:
        if destination.exists() and any(destination.glob("*.onnx")):
            return

        source = _bundled_model_path()
        if not source.exists():
            logger.warning("Bundled InsightFace models were not found: %s", source)
            return

        logger.info("Copying bundled InsightFace models...")
        destination.mkdir(parents=True, exist_ok=True)
        for file in source.glob("*.onnx"):
            shutil.copy2(file, destination / file.name)
        logger.info("Models staged successfully.")


def _gpu_available(model: Any) -> bool:
    """
    Verify CUDA is actually usable.

    Merely selecting CUDAExecutionProvider
    does not guarantee inference uses it.
    """

    try:

        dummy = np.zeros((640, 640, 3), dtype=np.uint8)

        model.get(dummy)

        detector = model.models.get("detection")

        session = getattr(detector, "session", None)

        if session is None:
            return False

        providers = session.get_providers()

        return "CUDAExecutionProvider" in providers

    except Exception as exc:

        logger.warning(
            "CUDA verification failed: %s",
            exc,
        )

        return False


# --------------------------------------------------------
# Public API
# --------------------------------------------------------


import onnxruntime as ort

# shared_face_engine/model_loader.py

def get_face_model(models_root: Path, prefer_gpu: bool = True):
    global _face_model, _gpu_enabled

    if _face_model is not None:
        return _face_model

    with _model_lock:
        if _face_model is not None:
            return _face_model

        stage_models(models_root)

        available = ort.get_available_providers()
        use_gpu = prefer_gpu and "CUDAExecutionProvider" in available
        providers = DEFAULT_PROVIDERS if use_gpu else CPU_ONLY_PROVIDER

        logger.info("Loading InsightFace model (%s), GPU=%s...", MODEL_NAME, use_gpu)

        if use_gpu:
            # onnxruntime-gpu 1.17.0's CUDA execution provider is known to
            # hard-crash (STATUS_STACK_BUFFER_OVERRUN, not a catchable
            # Python exception) during provider init on some driver/GPU
            # combinations — confirmed on this deployment's RTX 2060.
            # A subprocess probe is the only way to detect this before
            # it takes down the real process, since an in-process crash
            # here would kill app.py itself with no traceback.
            if not _cuda_provider_probe_succeeds(models_root):
                logger.warning(
                    "CUDAExecutionProvider failed a startup safety probe "
                    "(native crash risk on this driver/GPU) — falling "
                    "back to CPU."
                )
                use_gpu = False
                providers = CPU_ONLY_PROVIDER

        try:
            model = insightface.app.FaceAnalysis(name=MODEL_NAME, root=str(models_root), providers=providers)
            model.prepare(ctx_id=0 if use_gpu else -1, det_size=DETECTION_SIZE, det_thresh=0.15)
        except Exception:
            logger.exception("Failed to load InsightFace model.")
            raise

        _gpu_enabled = use_gpu
        _face_model = model
        logger.info("InsightFace loaded successfully. GPU=%s", _gpu_enabled)
        return _face_model


def _cuda_provider_probe_succeeds(models_root: Path, timeout: int = 30) -> bool:
    """Run a minimal CUDAExecutionProvider session-creation test in a
    subprocess, since the crash mode we've seen (STATUS_STACK_BUFFER_OVERRUN)
    kills the process natively with no Python-catchable exception — an
    in-process try/except cannot protect against this."""
    import subprocess
    import sys

    det_model = _target_model_path(models_root) / "det_10g.onnx"
    if not det_model.exists():
        return False

    probe_script = (
        "import onnxruntime as ort\n"
        f"sess = ort.InferenceSession(r'{det_model}', providers=['CUDAExecutionProvider'])\n"
        "print('OK')\n"
    )
    try:
        result = subprocess.run(
            [sys.executable, "-c", probe_script],
            capture_output=True, timeout=timeout,
        )
        return result.returncode == 0 and b"OK" in result.stdout
    except subprocess.TimeoutExpired:
        return False


def unload_model() -> None:
    """
    Release singleton.

    Mainly useful for tests.
    """

    global _face_model

    global _gpu_enabled

    _face_model = None

    _gpu_enabled = False


def is_gpu_enabled() -> bool:
    """
    Returns True if CUDA is actually being used.
    """

    return _gpu_enabled