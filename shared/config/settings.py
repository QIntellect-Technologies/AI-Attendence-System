"""
Single public configuration API for the whole backend.

Aggregates every config submodule and re-exports their flat constant names,
so both `from shared.config.settings import DB_PATH` (new code) and the
`config.py` compatibility shim (`from config import DB_PATH`, existing code)
resolve to the exact same values.
"""
from .paths import *          # noqa: F401,F403
from .log_settings import *   # noqa: F401,F403
from .recognition import *    # noqa: F401,F403
from .enrollment import *     # noqa: F401,F403
from .tracking import *       # noqa: F401,F403
from .flask import *          # noqa: F401,F403
from .performance import *    # noqa: F401,F403
from .database import *       # noqa: F401,F403
from .security import *       # noqa: F401,F403
from .cloud import *          # noqa: F401,F403

from . import paths as PATHS            # noqa: F401
from . import log_settings as LOGGING   # noqa: F401
from . import recognition as RECOGNITION  # noqa: F401
from . import enrollment as ENROLLMENT  # noqa: F401
from . import tracking as TRACKING      # noqa: F401
from . import flask as FLASK            # noqa: F401
from . import performance as PERFORMANCE  # noqa: F401
from . import database as DATABASE      # noqa: F401
from . import security as SECURITY      # noqa: F401
from . import cloud as CLOUD            # noqa: F401

__all__ = (
    PATHS.__all__ + LOGGING.__all__ + RECOGNITION.__all__ + ENROLLMENT.__all__
    + TRACKING.__all__ + FLASK.__all__ + PERFORMANCE.__all__ + DATABASE.__all__
    + SECURITY.__all__ + CLOUD.__all__
    + ["PATHS", "LOGGING", "RECOGNITION", "ENROLLMENT", "TRACKING", "FLASK",
       "PERFORMANCE", "DATABASE", "SECURITY", "CLOUD"]
)
