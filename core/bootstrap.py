# core/bootstrap.py
"""Process-wide startup fixes that MUST run before any other import.
Both concerns here are ordering bugs: encoding must be fixed before any
logger.info() call happens, and CUDA DLL dirs must be registered before
onnxruntime is imported anywhere in the import graph (including
transitively, via shared_face_engine.model_loader)."""
from __future__ import annotations
import logging
import os
import sys
from pathlib import Path


def enforce_utf8_stdio() -> None:
    """Force UTF-8 on stdio streams to prevent UnicodeEncodeError on
    Windows consoles defaulting to cp1252."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure") and stream.encoding.lower() != "utf-8":
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")


def register_cuda_dll_dirs() -> None:
    if not hasattr(os, "add_dll_directory"):
        return
    package_names = ("cuda_runtime", "cudnn", "cublas", "cufft", "curand")
    registered = []
    for name in package_names:
        try:
            module = __import__(f"nvidia.{name}", fromlist=[name])
        except ImportError:
            continue
        dll_dir = Path(module.__file__).resolve().parent / "bin"
        if dll_dir.is_dir():
            os.add_dll_directory(str(dll_dir))
            registered.append(name)
    logging.getLogger(__name__).info(
        "Registered CUDA DLL directories: %s", ", ".join(registered) or "none"
    )