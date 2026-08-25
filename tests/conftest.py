"""
conftest.py — isolates support_db_attendance_exceptions from its DB-layer
siblings (supabase_client, support_db_hierarchy, support_db_notifications)
so these are true unit tests: no real Supabase connection, no bcrypt/cv2/
torch pulled in transitively. Each test gets a fresh MagicMock for
get_supabase() via the `sb` fixture and can assert against it directly.
"""
import sys
import types
from unittest.mock import MagicMock

import pytest


def _install_stub(name: str, **attrs):
    if name in sys.modules:
        return sys.modules[name]
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    sys.modules[name] = mod
    return mod


# supabase_client.get_supabase() is called fresh inside every function under
# test, so the stub's get_supabase must always return the SAME mock object
# for a given test -- tests patch this via the `sb` fixture below.
_current_sb = MagicMock()
_install_stub("supabase_client", get_supabase=lambda: _current_sb)
_install_stub("support_db_hierarchy", resolve_notification_target=MagicMock(return_value=None))
_install_stub("support_db_notifications", create_notification=MagicMock())


@pytest.fixture
def sb():
    """Fresh Supabase mock per test. Reset instead of reassigned so the
    lambda captured in supabase_client's stub keeps returning this object."""
    _current_sb.reset_mock(return_value=True, side_effect=True)
    return _current_sb


@pytest.fixture(autouse=True)
def _reset_hierarchy_notifications_mocks():
    import support_db_hierarchy as hierarchy_db
    import support_db_notifications as notifications_db
    hierarchy_db.resolve_notification_target.reset_mock(return_value=True, side_effect=True)
    hierarchy_db.resolve_notification_target.return_value = None
    notifications_db.create_notification.reset_mock(return_value=True, side_effect=True)
    yield