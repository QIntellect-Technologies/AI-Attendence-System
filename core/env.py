# core/env.py
"""Shared .env loading for anything that touches Supabase/DB config outside
of app.py's own Flask bootstrap — standalone verification scripts,
one-off admin scripts, etc. app.py loads its own env directly since it
has additional bootstrap ordering constraints (see core/bootstrap.py);
this exists so every other entrypoint doesn't repeat that call site."""
from __future__ import annotations

from dotenv import load_dotenv


def load_env() -> None:
    load_dotenv()