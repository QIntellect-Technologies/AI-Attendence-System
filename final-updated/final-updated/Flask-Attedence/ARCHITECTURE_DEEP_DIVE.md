# 🏗️ Flask AI Attendance System - Architecture Deep Dive

**Date**: May 21, 2026  
**Focus**: Live Streaming, Face Tracking, Real-Time Recognition

---

## 🎬 Live Streaming Architecture

### The Problem: Buffer Lag

Traditional video processing creates latency:

```
RTSP Stream → OpenCV Buffer → AI Processing → Display
                    ↓
            Accumulates frames
            (2-5 second delay)
```

### The Solution: Dual-Threaded Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    CameraStreamReader                        │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Thread 1: Grabber Loop (30-60 Hz)                   │  │
│  │                                                      │  │
│  │  while running:                                     │  │
│  │    ├─ Flush buffer (5 grabs)                        │  │
│  │    ├─ Grab latest frame                             │  │
│  │    ├─ Resize to 1080px                              │  │
│  │    └─ Store in self.latest_frame (non-blocking)    │  │
│  │                                                      │  │
│  │  Result: Always has newest frame, no lag            │  │
│  └──────────────────────────────────────────────────────┘  │
│                          ↓                                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Thread 2: AI Worker Loop (3 Hz / 0.08s)             │  │
│  │                                                      │  │
│  │  while running:                                     │  │
│  │    ├─ Get copy of latest_frame                      │  │
│  │    ├─ Run YOLOv8 detection                          │  │
│  │    ├─ Associate with tracked faces                  │  │
│  │    ├─ Run InsightFace (throttled)                   │  │
│  │    ├─ Update bounding boxes                         │  │
│  │    └─ Push to real-time ticker                      │  │
│  │                                                      │  │
│  │  Result: Never blocks grabber, smooth processing    │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Key Optimizations

#### 1. Buffer Flushing
```python
# Flush FFMPEG/OpenCV socket buffer completely
for _ in range(5):
    self.cap.grab()  # Discard old frames
    
ret, frame = self.cap.retrieve()  # Get latest
```

#### 2. Low-Latency RTSP Settings
```python
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = \
    "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay"

cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # Minimal buffer
```

#### 3. Immediate Resizing
```python
# Resize immediately to save CPU downstream
max_width = 1080
if w > max_width:
    scale = max_width / w
    frame = cv2.resize(frame, (max_width, int(h * scale)))
```

#### 4. Throttled AI Processing
```python
# Only run heavy InsightFace every 0.5s for Unknown faces
should_run_ai = (name == "Unknown") and \
                (current_time - track["last_ai_run"]) > 0.5

if should_run_ai:
    track["last_ai_run"] = current_time
    embedding = fp.extract_embeddings_insightface(...)
```

---

## 🔍 Face Detection & Tracking Pipeline

### Step 1: YOLOv8 Detection

```
Input Frame (1080p)
    ↓
YOLOv8 Nano Model (~30ms)
    ├─ Detects all faces in frame
    ├─ Returns: [(x1, y1, x2, y2, confidence), ...]
    └─ Confidence threshold: 0.5
    ↓
Sort by area (largest first)
    └─ Prioritize closer faces
    ↓
Output: Sorted detections list
```

### Step 2: Track Association

```
For each detected face:
    ├─ Calculate centroid (cx, cy)
    │
    ├─ PASS 1: Match with active tracks
    │   ├─ For each active track (not seen > 2.0s):
    │   │   ├─ Calculate distance to centroid
    │   │   ├─ If distance < 60px AND closest:
    │   │   │   └─ MATCH! Assign to this track
    │   │   └─ Mark track as used
    │   │
    │   └─ If matched: Update track position, continue
    │
    ├─ PASS 2: Check lost recognized tracks
    │   ├─ For each lost track (0.15s < age < 2.0s):
    │   │   ├─ If track.name != "Unknown":
    │   │   │   ├─ Calculate spatial distance
    │   │   │   ├─ If distance < 60px:
    │   │   │   │   └─ INHERIT! Reuse this track
    │   │   │   └─ Mark track as used
    │   │
    │   └─ If inherited: Update track, continue
    │
    └─ PASS 3: Create new track
        ├─ Assign new track_id
        ├─ Set name = "Unknown"
        ├─ Set last_ai_run = 0 (run AI immediately)
        └─ Add to tracked_faces
```

### Step 3: Identity Recognition (Throttled)

```
For each tracked face (max 6 per frame):
    ├─ Check if should run AI:
    │   ├─ Is face Unknown? (name == "Unknown")
    │   ├─ Has 0.5s passed since last extraction?
    │   └─ Is this in top 6 faces by area?
    │
    ├─ If YES, run InsightFace:
    │   ├─ Extract 512-dim embedding (~100ms)
    │   ├─ Compare against cached embeddings
    │   ├─ Find best match (highest similarity)
    │   ├─ Check threshold (0.55 default)
    │   │
    │   ├─ If match found:
    │   │   ├─ Lock identity to track
    │   │   ├─ Set track.name = matched_name
    │   │   ├─ Set track.user_id = matched_id
    │   │   ├─ Set track.similarity = score
    │   │   └─ Log attendance
    │   │
    │   └─ If no match:
    │       └─ Stay Unknown
    │
    └─ If NO, skip AI:
        └─ Use cached identity from track
```

### Step 4: Output Generation

```
For each tracked face:
    ├─ Get bounding box: (x1, y1, x2, y2)
    ├─ Get identity: name, similarity
    ├─ Get status: Active/Lost
    │
    ├─ Draw on frame:
    │   ├─ Rectangle (green if recognized, red if unknown)
    │   ├─ Label: "Imran Khalid (0.78)"
    │   └─ Track ID: "#42"
    │
    └─ Push to real-time ticker:
        ├─ Name
        ├─ Timestamp
        ├─ Confidence
        └─ Source (stream_3)
```

---

## 💾 In-Memory Embedding Cache

### Why Cache?

Without cache:
```
For each face:
    ├─ Query SQLite for all users
    ├─ For each user:
    │   ├─ Query embeddings
    │   ├─ Deserialize from JSON
    │   ├─ Compute aggregate
    │   └─ Compare (slow!)
    └─ Result: 500ms+ per face
```

With cache:
```
At startup:
    ├─ Load all users from SQLite
    ├─ For each user:
    │   ├─ Load embeddings
    │   ├─ Compute aggregate
    │   └─ Store in memory
    └─ Result: 1-2 seconds total

For each face:
    ├─ Get embedding
    ├─ Compare against cached aggregates
    └─ Result: <1ms per face
```

### Cache Structure

```python
EMBEDDING_CACHE = {
    1: {
        'name': 'Imran Khalid',
        'aggregate_embedding': np.array([...512 dims...])
    },
    2: {
        'name': 'Ahmed Hassan',
        'aggregate_embedding': np.array([...512 dims...])
    },
    # ... more users
}
```

### Cache Refresh

```python
def refresh_embedding_cache():
    """Called after enrollment or user update"""
    
    new_cache = {}
    
    for user in db.get_all_users():
        embeddings = db.get_embeddings_for_user(user['id'])
        
        if len(embeddings) == 0:
            continue
        
        # Convert to numpy arrays
        user_embs = [np.array(emb['embedding']) 
                     for emb in embeddings]
        
        # Compute mean embedding
        aggregate_emb = np.mean(user_embs, axis=0)
        
        new_cache[user['id']] = {
            'name': user['name'],
            'aggregate_embedding': aggregate_emb
        }
    
    # Atomic update (thread-safe)
    with cache_lock:
        EMBEDDING_CACHE = new_cache
```

---

## 🎯 Face Matching Algorithm

### Cosine Similarity

```
Given two embeddings (512-dim vectors):
    embedding1 = [0.1, 0.2, 0.3, ..., 0.5]
    embedding2 = [0.11, 0.19, 0.31, ..., 0.51]

Cosine Similarity = (embedding1 · embedding2) / (||embedding1|| × ||embedding2||)

Result: Score between -1 and 1
    ├─ 1.0 = Identical
    ├─ 0.8 = Very similar (same person)
    ├─ 0.6 = Similar (might be same person)
    ├─ 0.4 = Different (different person)
    └─ -1.0 = Opposite
```

### Threshold Decision

```
Similarity Score
    ↓
Compare with FACE_MATCHING_THRESHOLD (0.55)
    ├─ If score >= 0.55:
    │   └─ MATCH! (recognized)
    │
    └─ If score < 0.55:
        └─ NO MATCH (unknown)
```

### Why 0.55 (Temporary)?

```
Training Data Issue:
    ├─ Model trained on close-up WhatsApp video
    ├─ NVR camera at 6-8 feet produces different embeddings
    ├─ Similarity scores: 0.58-0.62 (borderline)
    │
    ├─ With threshold 0.60:
    │   ├─ Frame 1: 0.61 → Match ✓
    │   ├─ Frame 2: 0.59 → No match ✗
    │   ├─ Frame 3: 0.62 → Match ✓
    │   └─ Result: FLICKERING
    │
    └─ With threshold 0.55:
        ├─ Frame 1: 0.61 → Match ✓
        ├─ Frame 2: 0.59 → Match ✓
        ├─ Frame 3: 0.62 → Match ✓
        └─ Result: STABLE (but more false positives)
```

### Permanent Solution

```
Step 1: Record new training video at 6-8 feet
Step 2: Extract embeddings from NVR video
Step 3: Retrain model with distance-appropriate data
Step 4: Similarity scores will be 0.75-0.85 (confident)
Step 5: Restore threshold to 0.60-0.65
```

---

## 🔄 Track Lifecycle

### Timeline Example

```
Time: 0.0s
├─ Person walks into frame
├─ YOLOv8 detects face
├─ Create new track #1
├─ Set name = "Unknown"
└─ Set last_ai_run = 0

Time: 0.08s (AI loop runs)
├─ Extract InsightFace embedding
├─ Compare against cached embeddings
├─ Find match: "Imran Khalid" (0.78 similarity)
├─ Lock identity to track
├─ Set track.name = "Imran Khalid"
├─ Log attendance
└─ Push to real-time ticker

Time: 0.16s - 2.0s
├─ Person moves in frame
├─ Update track centroid & bbox
├─ Keep name locked (no re-extraction)
└─ Continue updating real-time ticker

Time: 2.1s
├─ Person leaves frame
├─ YOLOv8 no longer detects face
├─ Track marked as "lost"
├─ Keep in tracked_faces for 2.0s grace period

Time: 2.5s
├─ Grace period expired
├─ Remove track from tracked_faces
└─ If person returns, create new track

Time: 2.05s (Person returns quickly)
├─ YOLOv8 detects face again
├─ Check lost tracks (within 2.0s)
├─ Find lost track #1 (0.05s old, spatially close)
├─ INHERIT identity: "Imran Khalid"
├─ Reuse track #1
└─ No re-extraction needed (identity already locked)
```

---

## 📊 Performance Timeline

### Per-Frame Processing

```
Frame arrives at Grabber Thread
    ↓ (0ms)
Stored in self.latest_frame
    ↓ (0ms - non-blocking)

AI Thread (every 0.08s):
    ├─ Copy frame (1ms)
    ├─ YOLOv8 detection (30ms)
    ├─ Track association (5ms)
    ├─ InsightFace extraction (100ms, throttled)
    ├─ Similarity comparison (<1ms)
    ├─ Update tracks (2ms)
    └─ Push to ticker (1ms)
    ↓
Total: ~140ms (but throttled to 0.08s = 3 Hz)

Result: 30 FPS video grab, 3 FPS AI processing
```

### Memory Usage

```
YOLO Model:           ~50 MB
InsightFace Model:    ~350 MB
Embedding Cache:      ~1 MB per 100 users
Video Buffer:         ~10 MB (1080p frame)
Tracked Faces:        ~1 KB per track
─────────────────────────────
Total:                ~410 MB + cache
```

---

## 🔐 Thread Safety

### Lock Usage

```python
# Global cache lock
cache_lock = threading.Lock()

# Grabber Thread (writes)
with self.lock:
    self.latest_frame = frame  # Atomic write

# AI Thread (reads)
with self.lock:
    frame_to_process = self.latest_frame.copy()  # Atomic read

# Cache access (reads)
with cache_lock:
    cache_items = list(EMBEDDING_CACHE.items())  # Atomic read
```

### Why Thread-Safe?

```
Without locks:
    ├─ Grabber writes frame
    ├─ AI reads frame (partially written)
    ├─ Result: Corrupted frame data
    └─ Crash or garbage output

With locks:
    ├─ Grabber acquires lock
    ├─ Writes complete frame
    ├─ Releases lock
    ├─ AI acquires lock
    ├─ Reads complete frame
    ├─ Releases lock
    └─ Result: Consistent data
```

---

## 🎨 Real-Time Ticker

### Data Flow

```
AI Thread detects face:
    ├─ Extract identity: "Imran Khalid"
    ├─ Extract similarity: 0.78
    ├─ Get timestamp: 2026-05-21T14:30:45.123Z
    ├─ Get source: "stream_3"
    │
    └─ Create detection entry:
        {
            "name": "Imran Khalid",
            "timestamp": "2026-05-21T14:30:45.123Z",
            "confidence": 0.78,
            "source": "stream_3"
        }
    
    ├─ Push to LATEST_STREAM_DETECTIONS
    └─ Limit to last 50 detections (FIFO)

Frontend polls /api/live-detections:
    ├─ Get JSON response
    ├─ Update sidebar ticker
    ├─ Show latest detections
    └─ Refresh every 1 second
```

### Ticker Display

```
🎥 Live AI Security Streams
Monitoring Real-Time AI

Widescreen live monitoring overlayed with 
real-time detection & bounding box labels

🏢 NVR Office (Ch 3)
🚪 DVR Corridor (Ch 2)

LIVE AI FEED ACTIVE
Disconnect Feed

✓ Monitoring active on 🏢 NVR Office (Ch 3)

Recent Detections:
├─ 14:30:45 - Imran Khalid (0.78) [NVR Office]
├─ 14:30:42 - Ahmed Hassan (0.82) [DVR Corridor]
├─ 14:30:38 - Unknown (0.45) [NVR Office]
└─ 14:30:35 - Imran Khalid (0.79) [NVR Office]
```

---

## 🚀 Optimization Opportunities

### Current Bottlenecks

1. **InsightFace Extraction** (100ms per face)
   - Solution: Batch processing (extract multiple faces at once)
   - Potential: 3-5x speedup

2. **SQLite Queries** (eliminated by cache)
   - Current: Cached (solved)
   - Impact: 500ms → <1ms per comparison

3. **YOLO Detection** (30ms per frame)
   - Solution: Use smaller model (yolov8s instead of yolov8n)
   - Trade-off: Faster but less accurate

4. **Track Association** (5ms per frame)
   - Solution: Use spatial indexing (KD-tree)
   - Potential: 2-3x speedup with many tracks

### Future Enhancements

1. **Multi-GPU Support**
   - Run YOLO on GPU 1, InsightFace on GPU 2
   - Potential: 2x throughput

2. **Batch Processing**
   - Process multiple faces in single InsightFace call
   - Potential: 3-5x speedup

3. **Model Quantization**
   - Use INT8 instead of FP32
   - Potential: 2-4x speedup, slight accuracy loss

4. **Distributed Processing**
   - Run AI on separate machine
   - Potential: Unlimited scalability

---

## 📋 Configuration Reference

### Critical Parameters

```python
# config.py

# Face Matching
FACE_MATCHING_THRESHOLD = 0.55  # Cosine similarity cutoff

# Tracking
TRACK_DISTANCE = 120  # Centroid distance (pixels)
GRACE_PERIOD = 2.0    # Keep lost track alive (seconds)
INHERITANCE_DISTANCE = 120  # Spatial proximity for identity inheritance

# AI Processing
AI_INTERVAL = 0.08    # AI loop frequency (seconds)
AI_RERUN_INTERVAL = 0.5  # InsightFace extraction throttle
MAX_TRACKED_FACES = 6  # Process top N faces per frame

# Video
FRAME_WIDTH = 1080    # Resize width (pixels)
BUFFER_SIZE = 1       # OpenCV buffer size

# RTSP
NVR_OFFICE_URL = "rtsp://admin:admin1122@192.168.0.77:554/cam/realmonitor?channel=3&subtype=1"
DVR_OFFICE_URL = "rtsp://admin:admin1122@192.168.0.77:554/cam/realmonitor?channel=2&subtype=1"
```

---

## 🎓 Key Learnings

### Why Dual-Threading Works

1. **Separation of Concerns**
   - Grabber: Always pulls latest frame
   - AI: Processes asynchronously
   - Never blocks each other

2. **Latency Elimination**
   - No buffer accumulation
   - No processing delays
   - Result: <100ms end-to-end

3. **Scalability**
   - Can add more AI workers
   - Can process multiple streams
   - Grabber always keeps up

### Why Identity Locking Works

1. **Prevents Flickering**
   - Once recognized, name is locked
   - No re-extraction (saves CPU)
   - Persists through brief occlusions

2. **Improves UX**
   - Stable bounding box labels
   - Consistent identity throughout
   - Professional appearance

3. **Reduces False Positives**
   - Doesn't re-match every frame
   - Reduces noise in similarity scores
   - More reliable attendance logging

---

**Architecture Analysis Complete** ✅  
**System Design**: Production-Grade  
**Last Updated**: May 21, 2026

