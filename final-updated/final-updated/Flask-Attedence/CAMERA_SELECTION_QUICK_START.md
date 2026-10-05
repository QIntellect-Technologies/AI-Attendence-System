# Camera Selection - Quick Start

**Status**: ✅ READY TO USE

---

## 🎯 What's New

**You can now choose which camera to record from:**
- NVR Camera
- DVR Camera

---

## 🚀 Quick Start (2 Minutes)

### 1. Start App
```bash
python app.py
```

### 2. Open Browser
```
http://localhost:5000
```

### 3. Go to Staff Enrollment
Click "👤 Staff Enrollment"

### 4. Create Profile
- Enter name and email
- Click "Initialize Profile"

### 5. Click "Record Video (20s)"
- **NEW**: Camera selection modal opens!

### 6. Select Camera
```
Select Camera
Choose which camera to record from

[📹 NVR Camera]
Record from NVR Office

[📹 DVR Camera]
Record from DVR Office
```

- Click "NVR Camera" or "DVR Camera"

### 7. Recording Modal Opens
- Shows selected camera name
- Click "Start Recording"

### 8. Wait for Recording
- 20-second countdown
- Extraction progress
- Training progress

### 9. Completion
- Shows results
- Video ready

### 10. Extract Biometrics
- Click "Extract & Train Biometrics"

---

## 📊 What You'll See

### Screen 1: Camera Selection
```
Select Camera
Choose which camera to record from

[📹 NVR Camera]
Record from NVR Office

[📹 DVR Camera]
Record from DVR Office

[Cancel]
```

### Screen 2: Recording (NVR or DVR)
```
📹 NVR Recording (or DVR Recording)
Record 20 seconds from your NVR camera (or DVR camera)

[Recording screen glows green]
🔴 Recording in progress...
Time remaining: 15s

15
seconds remaining
```

### Screen 3: Extraction
```
⏳ Extracting Facial Features
Processing video frames...

Frames processed: 75/100
[████████████████░░░░░░░░░░░░░░░░░░]
```

### Screen 4: Training
```
⏳ Training Biometric Model
Storing facial embeddings...

Embeddings stored: 42
[████████████████████░░░░░░░░░░░░░░░░]
```

### Screen 5: Complete
```
✓ Recording Complete!

📹 Video recorded: nvr_office_enroll_37_1779361522.742425.mp4
🎯 Frames extracted: 516
✓ Embeddings stored: 50

Ready for live detection!
```

---

## ✨ Key Features

✅ **Choose Camera** - NVR or DVR  
✅ **Professional UI** - Beautiful selection modal  
✅ **Correct Recording** - Records from your choice  
✅ **Proper Logging** - Shows which camera  
✅ **Video Naming** - Filename shows camera type  
✅ **Progress Tracking** - Shows extraction and training  
✅ **Auto-Close** - Modal closes after completion  

---

## 🎬 Complete Workflow

```
1. Click "Record Video (20s)"
   ↓
2. Select NVR or DVR
   ↓
3. Recording modal opens
   ↓
4. Click "Start Recording"
   ↓
5. Backend records from selected camera (20s)
   ↓
6. Extraction progress shows
   ↓
7. Training progress shows
   ↓
8. Completion screen shows results
   ↓
9. Modal auto-closes
   ↓
10. Video ready for processing
```

---

## 📝 Terminal Output

### NVR Recording
```
[RECORDING] Starting 20s recording from NVR for user 37
[RECORDING] Completed: 516 frames recorded from NVR
[SUCCESS] NVR recording completed: nvr_office_enroll_37_1779361522.742425.mp4
```

### DVR Recording
```
[RECORDING] Starting 20s recording from DVR for user 37
[RECORDING] Completed: 516 frames recorded from DVR
[SUCCESS] DVR recording completed: dvr_office_enroll_37_1779361522.742425.mp4
```

---

## 🎯 Button Changes

### Before
```
[Record from NVR (20s)]
```

### After
```
[Record Video (20s)]
```

Now opens camera selection modal!

---

## ✅ Testing

1. Start app: `python app.py`
2. Go to Staff Enrollment
3. Create profile
4. Click "Record Video (20s)"
5. Select NVR or DVR
6. Click "Start Recording"
7. Wait for completion
8. See video in dropzone

---

## 🎓 Understanding

### Why Camera Selection?
- You have both NVR and DVR
- Different cameras, different quality
- User chooses which one to use
- Flexibility in recording source

### How It Works
1. User clicks button
2. Modal asks which camera
3. User selects camera
4. Backend records from selected camera
5. Video saved with camera type in filename

### Benefits
- ✅ Flexibility
- ✅ Clarity
- ✅ Tracking
- ✅ Debugging

---

## 🚀 You're Ready!

The camera selection feature is ready to use:

```bash
python app.py
# Navigate to http://localhost:5000
# Go to Staff Enrollment
# Click "Record Video (20s)"
# Select NVR or DVR
# Start recording!
```

**Enjoy the camera selection feature!** 🎬

---

**Last Updated**: May 21, 2026
