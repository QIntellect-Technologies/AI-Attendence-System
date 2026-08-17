# ---- Stage 1: build the support-dashboard frontend ----
FROM node:20-slim AS frontend-build
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build
# Output assumed at /frontend/dist — adjust if your vite.config.ts outDir differs

# ---- Stage 2: backend runtime ----
FROM python:3.10-slim
WORKDIR /app

# System deps for OpenCV / face-recognition stack
# (original Dockerfile had a typo here: "libgl1-gl ibsm6" is not a valid package)
# build-essential is required to compile insightface's Cython extension
# (mesh_core_cython.cpp) during pip install — it needs g++.
# The rest are OpenCV's common runtime .so dependencies on a minimal
# Debian slim base — added together to avoid discovering them one at a time.
RUN apt-get update && apt-get install -y \
    build-essential \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    libgomp1 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && apt-get purge -y build-essential \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY . .

# Bake the InsightFace model into the image at build time instead of
# downloading it on every container start/redeploy (was taking ~4 min at
# runtime, well past the healthcheck timeout, causing restart loops).
RUN python download_models.py

# Bring in the built frontend so Flask's SPA fallback (frontend/dist) can serve it
COPY --from=frontend-build /frontend/dist ./frontend/dist

RUN mkdir -p logs uploads models

# Railway injects $PORT at runtime — do not hardcode 5000
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://localhost:{os.environ.get(\"PORT\",8080)}/api/health')"

# gunicorn, not the Flask dev server: single worker keeps the face-model
# warm-up cache in one process; increase --threads if you need more concurrency
# JSON exec form wrapping sh -c: keeps proper SIGTERM handling on
# restarts/redeploys while still allowing ${PORT} shell expansion
CMD ["sh", "-c", "gunicorn app:app --bind 0.0.0.0:${PORT:-8080} --workers 1 --threads 4 --timeout 120"]