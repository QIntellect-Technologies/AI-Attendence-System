from __future__ import annotations

import mimetypes
import os
import re
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
    """Build the user-facing download filename.

    Takes a human-readable BRANCH NAME — never an install-token payload.
    Callers used to pass the token dict returned by
    create_branch_install_token(), which str()'d into the filename and
    leaked id / org_id / branch_id / token_hash to the user's Downloads
    folder (a ~200-char name and a needless disclosure of the token hash).
    Non-string input is now dropped rather than stringified so that class
    of bug cannot come back silently.
    """
    suffix = "zip" if str(package_type).lower() == "zip" else "exe"
    prefix = "QIntellectAttendanceNodeSetup"

    if not isinstance(branch_name, str):
        branch_name = ""

    clean_branch = "".join(
        ch if ch.isalnum() or ch in {" ", "-", "_"} else "-"
        for ch in branch_name.strip()
    )
    # Collapse runs of separators left behind by the substitution above and
    # trim them from the ends, so "Dera Gazi Khan" stays readable and
    # something like "Main / Branch" doesn't become "Main---Branch".
    clean_branch = re.sub(r"[-\s]{2,}", "-", clean_branch).strip(" -_")
    # Windows Explorer truncates long names in the download shelf; keep the
    # branch fragment short enough that the .exe suffix stays visible.
    clean_branch = clean_branch[:40].strip(" -_")

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