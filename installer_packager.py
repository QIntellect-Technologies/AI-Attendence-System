from __future__ import annotations

import mimetypes
import os
from pathlib import Path
from typing import Any

from flask import Response, send_file


class InstallerArtifactError(RuntimeError):
    pass


def _configured_artifact_path(package_type: str = "exe") -> Path:
    package = str(package_type or "exe").strip().lower()
    if package not in {"exe", "zip"}:
        raise InstallerArtifactError("package_type must be exe or zip")

    env_name = "NODE_INSTALLER_ZIP_PATH" if package == "zip" else "NODE_INSTALLER_EXE_PATH"
    configured = os.getenv(env_name, "").strip()
    if not configured:
        raise InstallerArtifactError(f"{env_name} is not configured. Build the universal node installer first and set {env_name}.")

    path = Path(configured).expanduser().resolve()
    if not path.exists() or not path.is_file():
        raise InstallerArtifactError(f"Configured installer artifact was not found: {path}")
    return path


def installer_filename(branch_name: str | None = None, package_type: str = "exe") -> str:
    suffix = "zip" if str(package_type).lower() == "zip" else "exe"
    clean_branch = "".join(ch if ch.isalnum() or ch in {" ", "-", "_"} else "-" for ch in str(branch_name or "").strip()).strip()
    prefix = "QIntellectAttendanceNodeSetup"
    return f"{prefix}-{clean_branch}.{suffix}" if clean_branch else f"{prefix}.{suffix}"


def send_universal_installer(*, branch_name: str | None = None, package_type: str = "exe", headers: dict[str, str] | None = None) -> Response:
    path = _configured_artifact_path(package_type)
    filename = installer_filename(branch_name, package_type)
    mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    response = send_file(path, mimetype=mime_type, as_attachment=True, download_name=filename, max_age=0)
    for key, value in (headers or {}).items():
        response.headers[key] = value
    response.headers["X-QIntellect-Installer-Mode"] = "universal-prebuilt"
    return response


def build_node_installer_exe(*args: Any, **kwargs: Any) -> Path:
    return _configured_artifact_path("exe")


def build_node_installer_zip(*args: Any, **kwargs: Any) -> Path:
    return _configured_artifact_path("zip")


def node_exe_installer_filename(branch_name: str | None = None) -> str:
    return installer_filename(branch_name, "exe")


def node_installer_filename(branch_name: str | None = None) -> str:
    return installer_filename(branch_name, "zip")
