"""
local_node/scripts/prime_models.py
──────────────────────────────────────────────────────────────────────────────
Build-time utility: downloads InsightFace model weights into a local staging
folder so build.py can bundle them offline into the compiled node.

This script NEVER ships to the client and is not part of the compiled binary.
Run it once on a developer/CI machine with internet access, before build.py.

Usage:
    python -m local_node.scripts.prime_models
"""
from __future__ import annotations

import sys
from pathlib import Path

# Reuse shared_face_engine's own model-loading path (via recognition_engine's
# prime_offline_bundle) rather than hand-building FaceAnalysis + .prepare()
# here. That hand-built version is what silently drifted from runtime
# (missing det_thresh=0.15) and is exactly the kind of duplicated
# re-implementation shared_face_engine's own docstring says it exists to
# prevent — single source of truth means routing through it, not just
# reusing its constants.
from local_node.recognition_engine import prime_offline_bundle
from shared_face_engine import MODEL_NAME

# Staged directly under local_node/ so build.py's --include-data-dir and
# recognition_engine.py's __file__-relative lookup agree on the same path
# without any extra configuration.
STAGING_DIR = Path(__file__).resolve().parents[1] / "_bundled_models"


def prime_models(staging_dir: Path = STAGING_DIR) -> Path:
    """Trigger InsightFace's own downloader against a staging root, via
    the same get_face_model() code path used at runtime.

    InsightFace nests weights as <root>/models/<name>/*.onnx internally
    (ensure_available()) — recognition_engine.py's first-run copy step
    expects that exact nesting, and prime_offline_bundle() preserves it
    since it's the same underlying call.
    """
    staging_dir.mkdir(parents=True, exist_ok=True)
    print(f"[prime_models] Staging InsightFace '{MODEL_NAME}' into: {staging_dir}")

    # prefer_gpu=False (prime_offline_bundle's default) — CPU provider only.
    # This step only needs to trigger the download, never runs inference,
    # and forcing CUDA here would fail on GPU-less build machines for no
    # benefit.
    weights_dir = prime_offline_bundle(staging_dir)

    onnx_files = sorted(weights_dir.glob("*.onnx")) if weights_dir.exists() else []
    if not onnx_files:
        print(f"[prime_models] ERROR: no .onnx files found at {weights_dir} after download.", file=sys.stderr)
        sys.exit(1)

    print(f"[prime_models] OK — {len(onnx_files)} model file(s) staged:")
    for f in onnx_files:
        print(f"  - {f.relative_to(staging_dir)} ({f.stat().st_size / 1_048_576:.1f} MB)")

    return weights_dir


if __name__ == "__main__":
    prime_models()