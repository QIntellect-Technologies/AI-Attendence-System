"""
Self-contained face recognition entry point for the local node.

This module is intentionally thin. All model loading, detection, and
embedding extraction logic lives in shared_face_engine (bundled into this
node's Nuitka build — see local_node/build/build.py), so Trainer Desktop
and Local Node are guaranteed to always use the same model version,
detection threshold, and quality scoring. Only the local-node-specific
concern lives here: getting the Nuitka-bundled ONNX weights out of the
onefile bundle and into a persistent, writable app-data directory before
shared_face_engine ever tries to load them.
"""
from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any

import numpy as np

from local_node.config_store import MODELS_DIR, ensure_app_dirs
# Import from the shared_face_engine PACKAGE, not the model_loader
# submodule — shared_face_engine/__init__.py's own docstring requires
# this ("never reach into submodules directly") specifically so model
# version/detection params can't drift between consumers.
from shared_face_engine import MODEL_NAME, get_face_model, is_gpu_enabled
from shared_face_engine.embedding import detect_and_extract as _shared_detect_and_extract

logger = logging.getLogger(__name__)

class FaceEngineUnavailableError(RuntimeError):
    """Raised when the detection model itself failed to load or run —
    distinct from a clean 'ran fine, zero faces in frame' result, which
    returns []. Callers that only know how to handle [] can't tell those
    two cases apart otherwise, which is exactly what hid this bug."""

# Bundled by build.py via --include-data-dir. Resolved relative to this
# module's own __file__, which Nuitka guarantees works identically in source
# and compiled (standalone/onefile) modes — no frozen/dev branching needed.
_BUNDLED_MODELS_DIR = Path(__file__).resolve().parent / "_bundled_models"


def _ensure_models_staged() -> None:
    """
    Copy pre-downloaded weights from the Nuitka onefile bundle into the
    persistent app-data MODELS_DIR, on first run only.

    This is deliberately separate from shared_face_engine.model_loader's own
    stage_models(), which only looks for weights bundled inside
    shared_face_engine itself (used by the Trainer Desktop build) — this
    local-node build does not include that path, only local_node/_bundled_models
    (see build.py). Once weights land under MODELS_DIR from this function,
    shared_face_engine's own stage_models() call inside get_face_model()
    finds them already present and no-ops, so the two staging mechanisms
    never conflict.
    """
    target = MODELS_DIR / "models" / MODEL_NAME
    if target.exists() and any(target.glob("*.onnx")):
        return  # already staged from a previous run

    source = _BUNDLED_MODELS_DIR / "models" / MODEL_NAME
    if not source.exists():
        logger.warning(
            f"No bundled weights found at {source}; shared_face_engine will "
            f"attempt its own online download. Run prime_models.py before building."
        )
        return

    logger.info(f"Staging bundled InsightFace weights into {target}")
    target.mkdir(parents=True, exist_ok=True)
    for file in source.glob("*.onnx"):
        shutil.copy2(file, target / file.name)


def get_insightface_model(prefer_gpu: bool = True) -> Any:
    ensure_app_dirs()
    _ensure_models_staged()
    return get_face_model(MODELS_DIR, prefer_gpu=prefer_gpu)


def is_gpu_active() -> bool:
    return is_gpu_enabled()


def detect_and_extract(frame: np.ndarray) -> list[dict[str, Any]]:
    """Returns [{'bbox': (x1,y1,x2,y2), 'conf': float, 'embedding': np.ndarray}, ...].
    Raises FaceEngineUnavailableError if the model itself failed — callers
    must not treat that the same as a clean empty detection."""
    ensure_app_dirs()
    _ensure_models_staged()
    try:
        return _shared_detect_and_extract(frame, MODELS_DIR)
    except Exception as exc:
        logger.error(f"Face detection/extraction failed: {exc}")
        raise FaceEngineUnavailableError(str(exc)) from exc
    

def warmup() -> None:
    """Load and cache the singleton model synchronously, on the main
    thread, before any camera worker thread is created. This is the actual
    fix for the startup race: by the time camera_stream_manager spawns one
    thread per enabled camera, get_face_model() is already warm everywhere,
    so the concurrent-first-load race in model_loader.py can't occur during
    normal startup. Call this once from NodeService.start()."""
    ensure_app_dirs()
    _ensure_models_staged()
    get_insightface_model()


def prime_offline_bundle(staging_dir: Path, prefer_gpu: bool = False) -> Path:
    """For local_node.scripts.prime_models to call at build-prep time.

    NOT the same job as warmup()/get_insightface_model() above — those
    operate on THIS machine's runtime MODELS_DIR and only ever COPY
    already-bundled weights (via _ensure_models_staged /
    shared_face_engine.stage_models). Populating local_node/_bundled_models
    in the first place — the offline payload build.py bundles into the
    exe — requires an actual download, and shared_face_engine has no
    function for "download into an arbitrary directory" as such; what it
    has is get_face_model(), which triggers InsightFace's own downloader
    as a side effect of constructing+preparing FaceAnalysis against
    whatever root you give it, if weights aren't already there.

    Routing through get_face_model() here (instead of prime_models.py
    hand-building FaceAnalysis + .prepare() itself, as it used to) means
    this uses the exact same construction and det_size/det_thresh as
    runtime, not a second, independently-maintained copy of that call —
    the actual bug that produced the previous DET_SIZE/INSIGHTFACE_MODEL
    import error was this duplication existing at all, not just the
    names being wrong.

    prefer_gpu defaults to False deliberately: this only needs to trigger
    a download, never runs real inference, and probing/requiring CUDA
    here would fail on GPU-less build/CI machines for no benefit.
    """
    model = get_face_model(staging_dir, prefer_gpu=prefer_gpu)
    weights_dir = staging_dir / "models" / MODEL_NAME
    logger.info(
        "Primed InsightFace model '%s' into %s (GPU=%s)",
        MODEL_NAME, staging_dir, is_gpu_enabled(),
    )
    del model  # only the on-disk weights matter to the caller
    return weights_dir