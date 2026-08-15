# 🎯 Flask AI Attendance System

A complete AI-powered attendance system using **InsightFace** for face embeddings and **YOLOv8** for face detection. Users enroll by uploading a 15-second video, embeddings are extracted and trained, then real-time recognition works via camera, RTSP streams (NVR/DVR), or uploaded photos.

---

## 🎯 Features

✅ **Enrollment Pipeline**
- Users create accounts
- Upload 15-second video
- Automatic face detection (YOLO) + embedding extraction (InsightFace)
- Aggregated embedding profile stored in SQLite

✅ **Real-Time Recognition**
- Recognize faces from uploaded photos
- RTSP stream recognition (NVR/DVR/IP cameras)
- Match against enrolled user profiles
- Confidence-based matching (cosine similarity)

✅ **Attendance Logging**
- Automatic attendance records with timestamp
- Confidence scores
- Source tracking (frame, RTSP, camera)
- Query attendance by user or date range

✅ **Admin Dashboard**
- View all enrolled users
- Attendance statistics
- Recent activity logs
- User management

---

## 🚀 Installation

### Prerequisites
- Python 3.8+
- CUDA Toolkit 11.8+ (for GPU acceleration, optional)
- Git

### Step 1: Clone and Setup

```bash
# Navigate to project directory
cd e:\ImranProjects\QIntellectProjects\Flask-Attedence

# Create virtual environment
python -m venv venv

# Activate virtual environment
# On Windows:
venv\Scripts\activate
# On Linux/Mac:
source venv/bin/activate

# Upgrade pip
pip install --upgrade pip
```

### Step 2: Install Dependencies

```bash
pip install -r requirements.txt
```

**Note:** If you have a GPU and CUDA installed, the `torch` and `onnxruntime-gpu` packages will use GPU acceleration. Otherwise, they'll fall back to CPU.

### Step 3: Download Models

```bash
python download_models.py
```

This will:
- Download YOLOv8 nano model (~45 MB)
- Download InsightFace buffalo_l model (~220 MB)
- Verify both models load correctly

Models are cached in `./models/` directory.

### Step 4: Initialize Database

```bash
python database.py
```

This creates `attendance.db` with tables for users, embeddings, and attendance logs.

---

## 💾 Project Structure

```
Flask-Attedence/
├── app.py                      # Main Flask application
├── database.py                 # SQLite database + ORM
├── face_processor.py           # YOLO + InsightFace pipeline
├── download_models.py          # Model download script
├── requirements.txt            # Python dependencies
├── attendance.db              # SQLite database (auto-created)
├── templates/
│   └── index.html             # Web UI
├── uploads/                   # Temporary video uploads
├── models/                    # Cached models (auto-created)
└── README.md                  # This file
```

---

## ▶️ Running the Application

### Start the Flask Server

```bash
python app.py
```

Output:
```
============================================================
Flask AI Attendance System
============================================================
Starting server on http://localhost:5000
Initialize: POST http://localhost:5000/api/init
============================================================
```

### Access the Web UI

Open your browser and go to:
```
http://localhost:5000
```

The dashboard loads automatically and initializes the system on page load.

---

## 📋 Usage Guide

### 1️⃣ Enrollment

**Step A: Create User**
1. Go to "📝 Enrollment" card
2. Enter full name and email (optional)
3. Click "✓ Create User"
4. User ID is auto-filled

**Step B: Upload Video**
1. Select a 15-second video (MP4, AVI, MOV, MKV)
2. User ID is pre-filled
3. Click "🎥 Upload & Train"
4. Wait for processing (extracts frames → detects faces → computes embeddings)
5. Success message shows embeddings stored

**Requirements for enrollment video:**
- Duration: 10-60 seconds (optimal: 15 sec)
- Frame rate: 24+ FPS
- Face: Clear, front-facing, good lighting
- Background: Can be any, but less distracting is better
- Format: MP4, AVI, MOV, MKV

### 2️⃣ Recognition

#### **Option A: Upload Photo**
1. Go to "🔍 Recognition" card
2. Upload a photo
3. Click "📷 Recognize Face"
4. Results show matched user + confidence %

#### **Option B: RTSP Stream (NVR/DVR/Camera)**
1. Enter RTSP URL (e.g., `rtsp://192.168.1.100:554/stream`)
2. Set frames to process (default 10)
3. Click "📹 Start Recognition"
4. Recognized users are listed with timestamps

**RTSP URL Examples:**
- **Hikvision NVR:** `rtsp://admin:password@192.168.1.100:554/Streaming/Channels/101`
- **Dahua DVR:** `rtsp://admin:admin123@192.168.1.50:554/live`
- **IP Camera:** `rtsp://192.168.1.99:554/stream`

### 3️⃣ Dashboard

- **📈 Load Statistics:** Shows total users, today's attendance, total records
- **📋 Load Logs:** Shows last 20 attendance records with confidence scores

---

## 🔌 API Endpoints

### Enrollment

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/enroll/create-user` | Create new user |
| POST | `/api/enroll/upload-video` | Upload and train from video |
| GET | `/api/enroll/status/<user_id>` | Check enrollment status |

**Example: Create User**
```bash
curl -X POST http://localhost:5000/api/enroll/create-user \
  -H "Content-Type: application/json" \
  -d '{"name": "John Doe", "email": "john@example.com"}'
```

**Example: Upload Video**
```bash
curl -X POST http://localhost:5000/api/enroll/upload-video \
  -F "video=@enrollment.mp4" \
  -F "user_id=1"
```

### Recognition

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/recognize/frame` | Recognize face in photo |
| POST | `/api/recognize/rtsp` | Recognize from RTSP stream |

**Example: Recognize Photo**
```bash
curl -X POST http://localhost:5000/api/recognize/frame \
  -F "image=@photo.jpg"
```

**Example: RTSP Recognition**
```bash
curl -X POST http://localhost:5000/api/recognize/rtsp \
  -H "Content-Type: application/json" \
  -d '{
    "rtsp_url": "rtsp://192.168.1.100:554/stream",
    "frames": 10
  }'
```

### Dashboard

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users` | List all users |
| GET | `/api/attendance/logs?limit=100` | Get recent logs |
| GET | `/api/attendance/user/<user_id>?days=7` | Get user attendance |
| GET | `/api/stats` | Get system statistics |

---

## ⚙️ Configuration

Edit these values in the code:

### Face Matching Threshold (face_processor.py)
```python
similarity, is_match = fp.compare_embeddings(emb1, emb2, threshold=0.6)
```
- **0.6+**: Stricter matching (fewer false positives)
- **0.5-0.6**: Balanced
- **<0.5**: Loose matching (more matches, more false positives)

### Max Upload Size (app.py)
```python
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024  # 500MB
```

### Video Processing (face_processor.py)
```python
embeddings = fp.process_enrollment_video(filepath, max_frames=60)
```
- **60 frames**: More embeddings = more robust profile
- **30 frames**: Faster but less accurate
- **120+ frames**: Very slow but very robust

---

## 🐛 Troubleshooting

### 1. "No faces detected in video"
- Ensure face is clearly visible
- Check lighting (avoid backlit scenes)
- Try different angles
- Increase video duration to 30+ seconds

### 2. "Cannot connect to RTSP stream"
- Verify RTSP URL is correct
- Check camera IP and port
- Ensure camera is on same network
- Try `ffplay rtsp://...` to test stream first

### 3. Poor recognition accuracy
- Enroll with multiple angles (front, 45°, side)
- Ensure good lighting during enrollment
- Increase `threshold` for stricter matching
- Re-enroll if changes to face (glasses, beard, etc.)

### 4. Slow performance
- Use YOLOv8n (nano) for CPU — already configured
- Reduce `max_frames` in enrollment
- Process fewer frames in RTSP recognition
- Install GPU drivers (CUDA) if available

### 5. Out of memory errors
- Reduce `max_frames` in enrollment
- Process video in smaller chunks
- Reduce RTSP frame processing count

---

## 📊 Database Schema

### users
```sql
id (INTEGER, PK)
name (TEXT, UNIQUE)
email (TEXT)
created_at (TIMESTAMP)
active (INTEGER, default 1)
```

### embeddings
```sql
id (INTEGER, PK)
user_id (INTEGER, FK → users.id)
embedding (BLOB, JSON-encoded 512-dim vector)
source_video (TEXT)
created_at (TIMESTAMP)
```

### attendance
```sql
id (INTEGER, PK)
user_id (INTEGER, FK → users.id)
detected_name (TEXT)
confidence (REAL, 0-1)
timestamp (TIMESTAMP)
source (TEXT, 'frame'/'rtsp'/etc)
```

---

## 🎓 How It Works

### Enrollment Flow
```
User uploads video
       ↓
Extract frames (every Nth frame)
       ↓
Detect faces with YOLOv8
       ↓
Extract embeddings with InsightFace (512-dim)
       ↓
Aggregate embeddings (mean → normalize)
       ↓
Store in SQLite + attendance log
```

### Recognition Flow
```
Input: Photo or RTSP frame
       ↓
Detect faces with YOLOv8
       ↓
Extract embedding with InsightFace
       ↓
Compare against all enrolled profiles (cosine similarity)
       ↓
Match if similarity > threshold (0.6 default)
       ↓
Log attendance with timestamp + confidence
```

---

## 🔒 Security Considerations

- **No password storage** — add authentication layer in production
- **No encryption** — add encryption for sensitive data
- **No rate limiting** — add rate limits to API
- **Local deployment** — NVR/camera URLs should be on private network
- **Database backup** — regularly backup `attendance.db`

---

## 📈 Performance Notes

| Component | Hardware | Speed |
|-----------|----------|-------|
| YOLO Detection | GPU (RTX 3060) | 5-10 ms |
| YOLO Detection | CPU (i7) | 50-100 ms |
| InsightFace Embedding | GPU | 10-15 ms |
| InsightFace Embedding | CPU | 100-200 ms |
| Video Processing | GPU | 1-2 sec for 60 frames |
| Video Processing | CPU | 5-10 sec for 60 frames |

---

## 🚀 Future Enhancements

- [ ] Web-based live camera feed recognition
- [ ] Multi-face enrollment (multiple angles)
- [ ] Expression/emotion detection
- [ ] Age/gender classification
- [ ] Anti-spoofing (detect photos/videos)
- [ ] Batch import users
- [ ] PDF attendance reports
- [ ] Email notifications
- [ ] Mobile app
- [ ] Integration with door locks / gates

---

## 📞 Support

For issues or questions, check:
1. **Logs**: Check Flask console output
2. **Database**: Query `attendance.db` directly
3. **Models**: Run `python download_models.py` again
4. **RTSP**: Test URL with `ffplay rtsp://...`

---

## 📄 License

MIT License — Feel free to use and modify.

---

**Made with ❤️ using Flask, YOLO, and InsightFace**
