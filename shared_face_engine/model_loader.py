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
import os
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

# Detection input size. Deliberately the SAME for GPU and CPU-only
# installs — dropping this on CPU-only boxes would cut real detection
# range (a distant/small face shrinks below what the detector's anchors
# can reliably pick up at a smaller input size), which matters more for
# this app than raw CPU cost: an attendance system that quietly stops
# noticing people who aren't standing close to the camera is a worse
# outcome than a busier CPU. If a CPU-only box needs to trade range for
# speed, that should be a deliberate per-install decision (e.g. an env
# override), not a silent default baked in here.
DETECTION_SIZE = (640, 640)

DEFAULT_PROVIDERS = [
    "CUDAExecutionProvider",
    "CPUExecutionProvider",
]

CPU_ONLY_PROVIDER = [
    "CPUExecutionProvider",
]


def _default_intra_op_threads(use_gpu: bool) -> int:
    """How many threads onnxruntime's own thread pool gets for this
    session. QINTELLECT_NODE_ORT_THREADS overrides this per-install for a
    box that needs different tuning than the general default below.

    GPU case: the GPU carries the actual matrix math, so ONNX's CPU
    thread pool only needs enough headroom for the pre/post-processing
    around it (resize, anchor decode, NMS, alignment) — and it has to
    stay SMALL, because it's competing with every other camera's
    reader/processor/detector threads for the same physical cores. 2 is
    the value that was field-tested against a real 90%+ CPU box with
    several GPU-accelerated cameras running (see model_loader history) —
    it isn't a rough guess.

    CPU-only case: there's no GPU to lean on, so onnxruntime's CPU
    execution provider IS the inference engine, and it should get most
    of the machine. It doesn't need to reserve room for a second
    simultaneous inference, though — every camera's detection call is
    serialized through embedding.py's _inference_lock, so at most ONE
    inference runs at any instant regardless of camera count. What it
    does need to leave alone is a couple of cores for the concurrently
    running reader/processor threads of the OTHER cameras (RTSP decode,
    resize, JPEG encode don't stop just because this camera is the one
    currently running inference).
    """
    override = os.getenv("QINTELLECT_NODE_ORT_THREADS", "").strip()
    if override:
        try:
            parsed = int(override)
            if parsed > 0:
                return parsed
        except ValueError:
            pass

    if use_gpu:
        return 2

    cores = os.cpu_count() or 4
    return max(2, min(6, cores - 2))

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

        # Only 'detection' and 'recognition' are ever used (see
        # embedding.py: detect_and_extract only reads face.bbox,
        # face.det_score, face.embedding). buffalo_l's other three
        # modules — genderage, landmark_3d_68, landmark_2d_106 — were
        # loading and running on every single frame for output nobody
        # reads: 3 extra ONNX sessions warmed up at startup, and 3 extra
        # forward passes (plus their own CPU-side pre/post-processing)
        # per detected face, on every camera, every detection pass. On a
        # CPU-bound or GPU-light-but-CPU-heavy box with several cameras
        # running concurrently, that's the majority of the wasted CPU —
        # cutting it here is worth more than any single downstream tweak.
        allowed_modules = ["detection", "recognition"]

        # Each of insightface's ONNX sessions defaults its own intra-op
        # thread pool to the machine's full core count — with 5 model
        # files previously loaded (now 2) x several concurrent camera
        # detector threads all wanting CPU time for pre/post-processing
        # around the GPU calls, those thread pools compete with each
        # other and with the reader/processor/MJPEG threads for the same
        # physical cores. Capping each session's thread count keeps that
        # contention from dominating the CPU the way it did at 90%+
        # utilization with only 3-5 cameras running — see
        # _default_intra_op_threads() for the GPU vs CPU-only reasoning.
        # Wrapped defensively: not every insightface/onnxruntime version
        # forwards sess_options through FaceAnalysis the same way, and a
        # startup crash here would be far worse than slightly-too-many
        # threads.
        sess_options = ort.SessionOptions()
        sess_options.intra_op_num_threads = _default_intra_op_threads(use_gpu)
        sess_options.inter_op_num_threads = 1

        try:
            try:
                model = insightface.app.FaceAnalysis(
                    name=MODEL_NAME, root=str(models_root), providers=providers,
                    allowed_modules=allowed_modules, sess_options=sess_options,
                )
            except TypeError:
                # This insightface version doesn't forward sess_options
                # through FaceAnalysis.__init__ — fall back to
                # allowed_modules only, which is the bigger win anyway and
                # universally supported.
                logger.warning(
                    "Installed insightface version doesn't accept sess_options "
                    "via FaceAnalysis(); continuing without explicit ORT thread "
                    "limits (allowed_modules restriction still applied)."
                )
                model = insightface.app.FaceAnalysis(
                    name=MODEL_NAME, root=str(models_root), providers=providers,
                    allowed_modules=allowed_modules,
                )
            model.prepare(ctx_id=0 if use_gpu else -1, det_size=DETECTION_SIZE, det_thresh=0.15)
        except Exception:
            logger.exception("Failed to load InsightFace model.")
            raise

        _gpu_enabled = use_gpu
        _face_model = model
        logger.info(
            "InsightFace loaded successfully. GPU=%s, det_size=%s, ort_intra_op_threads=%s",
            _gpu_enabled, DETECTION_SIZE, sess_options.intra_op_num_threads,
        )
        return _face_model


def _cuda_provider_probe_succeeds(models_root: Path, timeout: int = 30) -> bool:
    """Run a minimal CUDAExecutionProvider session-creation test in a
    subprocess, since the crash mode we've seen (STATUS_STACK_BUFFER_OVERRUN)
    kills the process natively with no Python-catchable exception — an
    in-process try/except cannot protect against this."""
    import subprocess
    import sys

    if getattr(sys, "frozen", False) or "__compiled__" in globals():
        # sys.executable is the node exe here, so the subprocess probe would
        # relaunch the application instead of running Python. Skip it and let
        # provider init happen normally.
        return True

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