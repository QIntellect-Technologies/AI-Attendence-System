import os
import json
from pathlib import Path

_RUNTIME_CACHE = None


def _load_runtime_file():
    """
    Optional local config file:
    config/runtime.json
    """
    path = Path(__file__).resolve().parents[2] / "runtime.json"

    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    return {}


def get_runtime_config():
    global _RUNTIME_CACHE

    if _RUNTIME_CACHE is not None:
        return _RUNTIME_CACHE

    config = {
        "node_id": os.getenv("NODE_ID", "node-default"),
        "supabase_url": os.getenv("SUPABASE_URL", ""),
        "supabase_key": os.getenv("SUPABASE_SERVICE_KEY", ""),
        "storage_bucket": os.getenv("SUPABASE_STORAGE_BUCKET", "attendai-media"),
        "cameras": _load_runtime_file().get("cameras", {})
    }

    _RUNTIME_CACHE = config
    return config