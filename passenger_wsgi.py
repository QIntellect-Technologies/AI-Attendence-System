"""
passenger_wsgi.py
──────────────────────────────────────────────────────────────────────────
cPanel/Passenger entry point for the QIntellect Flask backend.

This file is cPanel-specific and is never read by Railway/Docker — that
path still calls `gunicorn app:app` exactly as it does today (see
Dockerfile CMD). Do not delete or repurpose the Dockerfile/railway.json
for this; this file lives alongside them.

cPanel's "Setup Python App" auto-creates a stub file with this exact name
in the application root you choose (e.g. api.yourdomain.com's root) the
moment you click "Create". Passenger's contract is simple: it imports this
module and looks for a module-level WSGI callable named `application`.
Flask's `app` object already *is* a WSGI callable — so we just re-export it
under the name Passenger expects. Nothing else needs to change: the
`if __name__ == "__main__":` block at the bottom of app.py never executes
here, because Passenger imports this module, it doesn't run app.py as a
script — so there's no port clash and no need to touch app.py.

Setup instructions (cPanel → Setup Python App):
  1. Create the app with application root = wherever you upload this
     backend's files (recommend: NOT public_html directly — e.g. a
     sibling folder like `qintellect-api`, with the subdomain's document
     root pointed at it).
  2. When cPanel scaffolds its own passenger_wsgi.py stub, replace its
     contents with this file verbatim.
  3. Use the "Run Pip Install" button (reads requirements.txt in the venv
     cPanel created) instead of a manual pip command — you don't have a
     terminal, this is the equivalent.
  4. Set required env vars (SUPABASE_URL, SUPABASE_KEY, JWT secret, etc.)
     in the "Environment variables" section of the same Setup Python App
     screen, rather than relying on a .env file being picked up — this
     keeps secrets out of anything File Manager might expose and doesn't
     depend on config.py's load_dotenv() finding the file at the cwd
     Passenger happens to use.
  5. Click "Restart" after any code or dependency change — Passenger
     caches the loaded app process and will not pick up edits otherwise.
"""

import sys
import os

# Ensure the app root (this file's directory) is importable regardless of
# the cwd Passenger launches with.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import app as application  # noqa: E402  (import after sys.path fix, by necessity)
