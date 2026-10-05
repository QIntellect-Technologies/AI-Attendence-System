# 🚀 QUICK START

Get the Flask AI Attendance system running in 5 minutes.

## 1. Setup Environment

```bash
# Navigate to project
cd e:\ImranProjects\QIntellectProjects\Flask-Attedence

# Create virtual environment
python -m venv venv

# Activate
venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

**Estimated time: 5-10 minutes** (depending on internet speed)

## 2. Download Models

```bash
python download_models.py
```

This downloads:
- YOLOv8 nano (~45 MB)
- InsightFace buffalo_l (~220 MB)

**Estimated time: 5-15 minutes** (depending on internet speed)

## 3. Initialize Database

```bash
python database.py
```

Creates `attendance.db` with all tables.

## 4. Run Tests

```bash
python test.py
```

Expected output:
```
==================================================
Flask AI Attendance System - Test Suite
==================================================

✓ PASS: Model Loading
✓ PASS: Database Operations
✓ PASS: Embedding Comparison
✓ PASS: Embedding Aggregation

Total: 4/4 passed
==================================================
```

## 5. Start Server

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

## 6. Open Web UI

Open browser → http://localhost:5000

---

## ✅ You're Ready!

### Next Steps:

1. **Enroll a User**
   - Click "📝 Enrollment"
   - Enter name → "✓ Create User"
   - Upload 15-sec video → "🎥 Upload & Train"
   - Wait for success message

2. **Test Recognition**
   - Click "🔍 Recognition"
   - Upload a photo → "📷 Recognize Face"
   - See matched user + confidence %

3. **Check Attendance**
   - Click "📊 Dashboard"
   - "📋 Load Logs" to see records

---

## 🔗 API Examples

### Enroll User
```bash
curl -X POST http://localhost:5000/api/enroll/create-user \
  -H "Content-Type: application/json" \
  -d '{"name": "John Doe", "email": "john@example.com"}'
```

### Upload Video
```bash
curl -X POST http://localhost:5000/api/enroll/upload-video \
  -F "video=@video.mp4" \
  -F "user_id=1"
```

### Recognize Photo
```bash
curl -X POST http://localhost:5000/api/recognize/frame \
  -F "image=@photo.jpg"
```

### Get Statistics
```bash
curl http://localhost:5000/api/stats
```

---

## 📁 Key Files

| File | Purpose |
|------|---------|
| `app.py` | Flask web server |
| `face_processor.py` | YOLO + InsightFace |
| `database.py` | SQLite operations |
| `templates/index.html` | Web UI |
| `requirements.txt` | Python packages |
| `test.py` | Verification tests |

---

## ⚠️ Troubleshooting

**Problem: Models fail to download**
- Check internet connection
- Try running again: `python download_models.py`

**Problem: "No faces detected"**
- Ensure face is clearly visible in video
- Try a different angle
- Increase video to 30+ seconds

**Problem: Port 5000 already in use**
- Edit `app.py`: Change `port=5000` to `port=5001`

**Problem: Out of memory**
- Reduce `max_frames` in `face_processor.py`
- Lower `frames` in web UI

---

## 📖 Full Documentation

See `README.md` for comprehensive guide.

---

**Ready to go! 🎉**
