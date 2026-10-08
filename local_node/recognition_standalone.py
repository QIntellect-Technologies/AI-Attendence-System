"""Standalone face-detection and embedding test for Local Node.

Run with:
    python -m local_node.recognition_standalone --image path\\to\\image.jpg

This uses Local Node's existing model setup and recognition engine. It does
not start the UI, camera workers, attendance pipeline, or cloud sync.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from local_node.recognition_engine import detect_and_extract
from local_node.recognition_worker import best_match as match_enrolled_identity


def detect_faces_and_embeddings(frame: np.ndarray) -> list[dict[str, Any]]:
    """Return face boxes, detector confidence, keypoints, and embeddings."""
    if not isinstance(frame, np.ndarray) or frame.size == 0:
        raise ValueError("frame must be a non-empty NumPy image")
    return detect_and_extract(frame)


def analyze_image(
    image_path: str | Path,
    output_path: str | Path | None = None,
    match_identities: bool = False,
) -> dict[str, Any]:
    """Run detection and optionally compare faces with local enrollments."""
    source = Path(image_path)
    frame = cv2.imread(str(source))
    if frame is None:
        raise ValueError(f"Could not read image: {source}")

    started = time.perf_counter()
    detections = detect_faces_and_embeddings(frame)
    elapsed_ms = (time.perf_counter() - started) * 1000

    faces = []
    annotated = frame.copy() if output_path is not None else None
    for detection in detections:
        x1, y1, x2, y2 = detection["bbox"]
        embedding = detection.get("embedding")
        identity = (
            match_enrolled_identity(embedding)
            if match_identities and embedding is not None else None
        )
        face_result = {
            "bbox": [int(x1), int(y1), int(x2), int(y2)],
            "confidence": float(detection["conf"]),
            "embedding_dimensions": (
                int(np.asarray(embedding).size) if embedding is not None else 0
            ),
        }
        if match_identities:
            face_result["match"] = (
                {
                    "name": identity.get("staff_name"),
                    "people_type": identity["people_type"],
                    "person_code": identity["person_code"],
                    "similarity": float(identity["confidence"]),
                }
                if identity else None
            )
        faces.append(face_result)
        if annotated is not None:
            cv2.rectangle(annotated, (x1, y1), (x2, y2), (0, 200, 0), 2)
            label = (
                identity.get("staff_name") or identity["person_code"]
                if identity else f'{float(detection["conf"]):.2f}'
            )
            cv2.putText(
                annotated,
                label,
                (x1, max(0, y1 - 8)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                (0, 200, 0),
                2,
            )

    if annotated is not None and not cv2.imwrite(str(output_path), annotated):
        raise OSError(f"Could not write annotated image: {output_path}")

    return {
        "image": str(source),
        "face_count": len(faces),
        "inference_ms": round(elapsed_ms, 2),
        "identity_matching_enabled": match_identities,
        "faces": faces,
        "annotated_image": str(output_path) if output_path is not None else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run Local Node face detection and embedding extraction on an image."
    )
    parser.add_argument("--image", required=True, help="Image file to analyze")
    parser.add_argument(
        "--output",
        help="Optional path to save an annotated copy of the image",
    )
    parser.add_argument(
        "--match-enrolled",
        action="store_true",
        help="Compare detected face embeddings with Local Node's enrolled profiles (does not mark attendance)",
    )
    args = parser.parse_args()

    try:
        result = analyze_image(
            args.image,
            args.output,
            match_identities=args.match_enrolled,
        )
    except (OSError, ValueError, RuntimeError) as exc:
        parser.error(str(exc))

    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
