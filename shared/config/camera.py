from .runtime import get_runtime_config

def get_camera_url(camera_name: str) -> str:
    """
    Fetch camera RTSP URL from runtime configuration.
    No credentials are stored in source code.
    """
    cameras = get_runtime_config().get("cameras", {})
    if camera_name not in cameras:
        raise KeyError(f"Camera '{camera_name}' not configured")

    return cameras[camera_name]