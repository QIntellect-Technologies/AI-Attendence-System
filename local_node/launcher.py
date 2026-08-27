"""Windowless entry point that records startup failures before main imports."""
from __future__ import annotations

import os
import traceback
from pathlib import Path


def _startup_error_path() -> Path:
    base = os.getenv("PROGRAMDATA") or str(Path.home())
    return Path(base) / "QIntellect" / "AttendanceNode" / "logs" / "startup_error.log"


def main() -> None:
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
