"""Windowless entry point that records startup failures before main imports."""
from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path

# Dedicated, minimal entrypoint for shared_face_engine.model_loader's
# CUDAExecutionProvider safety probe (see model_loader._cuda_provider_probe_
# succeeds). That probe MUST run in a disposable child process — the crash
# it exists to catch (STATUS_STACK_BUFFER_OVERRUN during CUDA provider
# init on some driver/GPU combinations) is a native fault, not a Python
# exception, so an in-process try/except around FaceAnalysis(...) cannot
# protect against it. In a dev/source checkout, sys.executable is a real
# python.exe and the probe can just run `python -c "<script>"`. In a
# frozen build, sys.executable IS this exe — there is no `-c` flag to run
# arbitrary code with, only whatever entrypoint this file defines. This
# flag is that entrypoint: it lets the probe still spawn a real,
# short-lived child process of this same exe, deliberately importing
# nothing from local_node (no cv2, no Flask, no NodeService) so it stays
# fast and can't trip any of local_node's own import-time side effects.
_CUDA_PROBE_FLAG = "--cuda-provider-probe"


def _run_cuda_probe(det_model_path: str) -> None:
    try:
        import onnxruntime as ort

        ort.InferenceSession(det_model_path, providers=["CUDAExecutionProvider"])
        print("OK")
        sys.exit(0)
    except SystemExit:
        raise
    except Exception:
        sys.exit(1)


def _startup_error_path() -> Path:
    base = os.getenv("PROGRAMDATA") or str(Path.home())
    return Path(base) / "QIntellect" / "AttendanceNode" / "logs" / "startup_error.log"


def main() -> None:
    if len(sys.argv) >= 3 and sys.argv[1] == _CUDA_PROBE_FLAG:
        _run_cuda_probe(sys.argv[2])
        return

    try:
        from local_node.main import main as run_node

        run_node()
    except BaseException:
        path = _startup_error_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                handle.write("\n--- local node startup failure ---\n")
                traceback.print_exc(file=handle)
        except OSError:
            pass
        raise


if __name__ == "__main__":
    main()