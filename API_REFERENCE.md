# 📚 API REFERENCE

Complete API documentation for Flask AI Attendance System.

---

## Authentication

Currently no authentication required. For production, add API keys:

```bash
pip install Flask-HTTPAuth
```

---

## Base URL

```
http://localhost:5000/api
```

---

## Response Format

All responses are JSON:

```json
{
    "success": true,
    "data": {},
    "error": null,
    "timestamp": "2026-05-18T10:30:00"
}
```

---

## Endpoints

### Health & System

#### Health Check
```
GET /api/health
```

**Response:**
```json
{
    "status": "healthy",
    "timestamp": "2026-05-18T10:30:00"
}
```

---

#### System Status
```
GET /api/system/health
```

**Response:**
```json
{
    "status": "healthy",
    "database": "ok",
    "models": "ok",
    "timestamp": "2026-05-18T10:30:00"
}
```

---

### Enrollment

#### Create User
```
POST /api/enroll/create-user
Content-Type: application/json

{
    "name": "John Doe",
    "email": "john@example.com",
    "phone": "+1234567890",
    "department": "HR"
}
```

**Response:**
```json
{
    "success": true,
    "user_id": 1,
    "name": "John Doe",
    "message": "User created successfully"
}
```

**Error:**
```json
{
    "error": "User already exists",
    "code": 409
}
```

---

#### Upload Enrollment Video
```
POST /api/enroll/upload-video
Content-Type: multipart/form-data

Form data:
- video: <video file> (required)
- user_id: 1 (required)
```

**Response:**
```json
{
    "success": true,
    "user_id": 1,
    "embeddings_count": 35,
    "total_frames_processed": 60,
    "avg_quality": 0.85,
    "spoof_detections": 0,
    "warnings": [],
    "message": "Successfully stored 35 embeddings"
}
```

**Warnings:**
```json
{
    "success": false,
    "error": "Insufficient valid faces detected (3/5)",
    "issues": [
        "Frame 0: Low quality - ['blurry']",
        "Frame 15: Possible spoof detected"
    ]
}
```

---

#### Check Enrollment Status
```
GET /api/enroll/status/1
```

**Response:**
```json
{
    "enrolled": true,
    "user_id": 1,
    "embeddings_count": 35,
    "created_at": "2026-05-18T10:00:00",
    "message": "User enrolled with 35 embeddings"
}
```

---

### Recognition

#### Recognize Face in Photo
```
POST /api/recognize/frame
Content-Type: multipart/form-data

Form data:
- image: <image file> (JPG, PNG, etc.)
```

**Response:**
```json
{
    "recognized": true,
    "detections": [
        {
            "face_bbox": [100, 150, 250, 350],
            "detected_confidence": 0.95,
            "matched_user": "John Doe",
            "similarity": 0.88,
            "is_match": true,
            "quality_score": 0.92,
            "quality_issues": [],
            "is_spoof": false,
            "spoof_confidence": 0.15
        }
    ],
    "total_faces_detected": 1,
    "timestamp": "2026-05-18T10:30:00"
}
```

**Multiple Faces:**
```json
{
    "recognized": true,
    "detections": [
        {
            "face_bbox": [100, 150, 250, 350],
            "matched_user": "John Doe",
            "similarity": 0.88,
            "is_match": true
        },
        {
            "face_bbox": [300, 200, 400, 400],
            "matched_user": "Unknown",
            "similarity": 0.42,
            "is_match": false
        }
    ],
    "total_faces_detected": 2,
    "timestamp": "2026-05-18T10:30:00"
}
```

**No Faces:**
```json
{
    "recognized": false,
    "detected_faces": 0,
    "message": "No faces detected",
    "timestamp": "2026-05-18T10:30:00"
}
```

---

#### Recognize from RTSP Stream
```
POST /api/recognize/rtsp
Content-Type: application/json

{
    "rtsp_url": "rtsp://192.168.1.100:554/stream",
    "frames": 20
}
```

**Response:**
```json
{
    "status": "completed",
    "recognized_users": [
        "John Doe",
        "Jane Smith",
        "John Doe"
    ],
    "frames_processed": 20,
    "timestamp": "2026-05-18T10:30:00"
}
```

---

### Dashboard & Statistics

#### Get All Users
```
GET /api/users
```

**Response:**
```json
{
    "users": [
        {
            "id": 1,
            "name": "John Doe",
            "email": "john@example.com",
            "created_at": "2026-05-18T09:00:00"
        }
    ]
}
```

---

#### Get Statistics
```
GET /api/stats
```

**Response:**
```json
{
    "total_users": 25,
    "today_attendance": 18,
    "unique_users_today": 15,
    "total_logs": 1250,
    "avg_confidence": 0.87,
    "recent_entries": [
        {
            "name": "John Doe",
            "timestamp": "2026-05-18T10:25:00",
            "confidence": 0.91
        }
    ],
    "timestamp": "2026-05-18T10:30:00"
}
```

---

#### Get Attendance Logs
```
GET /api/attendance/logs?limit=50
```

**Response:**
```json
{
    "logs": [
        {
            "id": 1250,
            "name": "John Doe",
            "detected_name": "John Doe",
            "confidence": 0.91,
            "timestamp": "2026-05-18T10:25:00",
            "source": "frame"
        }
    ]
}
```

---

#### Get User Attendance History
```
GET /api/attendance/user/1?days=7
```

**Response:**
```json
{
    "user_id": 1,
    "days": 7,
    "logs": [
        {
            "id": 1250,
            "timestamp": "2026-05-18T10:25:00",
            "confidence": 0.91,
            "source": "frame"
        }
    ]
}
```

---

## Error Codes

| Code | Meaning | Example |
|------|---------|---------|
| 200 | OK | Successful request |
| 201 | Created | User created successfully |
| 400 | Bad Request | Missing required field |
| 409 | Conflict | User already exists |
| 413 | Payload Too Large | File exceeds 500MB |
| 500 | Internal Error | Model loading failed |

---

## Rate Limiting (Optional)

Add to `app.py`:

```python
from flask_limiter import Limiter
limiter = Limiter(app, key_func=get_remote_address)

@limiter.limit("10 per minute")
def recognize_face_frame():
    pass
```

---

## CORS

CORS is enabled for all origins. To restrict:

```python
CORS(app, resources={r"/api/*": {"origins": ["http://localhost:3000"]}})
```

---

## Pagination (Future)

```
GET /api/attendance/logs?limit=50&offset=100
```

---

## Filtering (Future)

```
GET /api/attendance/logs?user_id=1&date=2026-05-18&confidence=0.8
```

---

## cURL Examples

### Create User
```bash
curl -X POST http://localhost:5000/api/enroll/create-user \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Doe",
    "email": "john@example.com"
  }'
```

### Upload Video
```bash
curl -X POST http://localhost:5000/api/enroll/upload-video \
  -F "video=@enrollment.mp4" \
  -F "user_id=1"
```

### Recognize Photo
```bash
curl -X POST http://localhost:5000/api/recognize/frame \
  -F "image=@photo.jpg"
```

### Get Stats
```bash
curl http://localhost:5000/api/stats
```

---

## Python Client Example

```python
import requests

API_BASE = "http://localhost:5000/api"

# Create user
resp = requests.post(f"{API_BASE}/enroll/create-user", json={
    "name": "John Doe",
    "email": "john@example.com"
})
user_id = resp.json()["user_id"]

# Upload video
with open("enrollment.mp4", "rb") as f:
    files = {"video": f}
    data = {"user_id": user_id}
    resp = requests.post(f"{API_BASE}/enroll/upload-video", files=files, data=data)
    print(resp.json())

# Recognize
with open("photo.jpg", "rb") as f:
    files = {"image": f}
    resp = requests.post(f"{API_BASE}/recognize/frame", files=files)
    print(resp.json())
```

---

**Complete API documentation ✓**
