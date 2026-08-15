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
RUN apt-get update && apt-get install -y \
    libgl1 \
    libsm6 \
    libxext6 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

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