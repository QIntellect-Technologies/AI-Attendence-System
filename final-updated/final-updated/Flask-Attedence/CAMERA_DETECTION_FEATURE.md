# 📷 Laptop Camera Detection Feature

## Overview
A new page has been added to the QIntellect AI Attendance System that allows you to open your laptop camera and detect faces in real-time. The system will identify if the person is **Imran** or **Hooria** (or any other enrolled staff member).

## What's New

### 1. New Menu Item
- **Location**: Left Sidebar Navigation
- **Label**: 📷 Laptop Camera
- **Icon**: Camera icon
- **Position**: Between "Live AI Streams" and "Verification Test"

### 2. New Page: "Laptop Camera Live Detection"
**URL**: Click the "📷 Laptop Camera" menu item in the sidebar

#### Features:
- **Live Camera Feed Display**
  - Real-time video stream from your laptop camera
  - Live status badge showing "STANDBY" or "LIVE"
  - Professional CCTV-style interface

- **Start/Stop Controls**
  - "Start Camera" button - Opens your laptop camera
  - "Stop Camera" button - Closes the camera stream
  - Browser will request permission to access your camera

- **Real-Time Detection Results Panel**
  - Shows detected faces with names
  - Displays confidence scores (similarity percentage)
  - Color-coded badges:
    - 🟢 **MATCH** (Green) - Successfully identified person
    - 🔵 **UNKNOWN** (Blue) - Face detected but not recognized

- **Detection Statistics**
  - **Imran Detections**: Count of times Imran was detected
  - **Hooria Detections**: Count of times Hooria was detected
  - **Unknown Faces**: Count of unrecognized faces

### 3. How It Works

#### Step-by-Step:
1. Click "📷 Laptop Camera" in the sidebar
2. Click "Start Camera" button
3. Browser will ask for camera permission - **Click "Allow"**
4. Your laptop camera will start streaming
5. The system processes frames every 500ms (2 FPS)
6. Detected faces appear in the "Detection Results" panel
7. Statistics update in real-time
8. Click "Stop Camera" to close the stream

#### Detection Process:
```
Camera Frame → YOLOv8 Face Detection → Face Quality Check → 
InsightFace Embedding Extraction → Compare with Enrolled Profiles → 
Match Result (Imran/Hooria/Unknown)
```

### 4. Technical Implementation

#### Frontend (HTML/JavaScript)
- **File**: `templates/index.html`
- **New Functions**:
  - `startCamera()` - Requests camera access and starts streaming
  - `stopCamera()` - Stops camera stream
  - `startCameraProcessing()` - Processes frames every 500ms
  - `updateCameraDetections()` - Updates UI with detection results

#### Backend (Python/Flask)
- **Existing Endpoint Used**: `/api/recognize/frame`
- **Method**: POST
- **Input**: Image frame from camera
- **Output**: Detected faces with names and confidence scores

#### Key Technologies:
- **WebRTC API**: Browser camera access
- **Canvas API**: Frame capture from video stream
- **YOLOv8**: Face detection
- **InsightFace**: Face embedding extraction
- **Cosine Similarity**: Face matching

### 5. Requirements

#### Browser Requirements:
- Modern browser with WebRTC support (Chrome, Firefox, Edge, Safari)
- HTTPS connection (or localhost for development)
- Camera permission granted

#### System Requirements:
- Enrolled staff profiles (Imran, Hooria, etc.)
- Face embeddings trained for each person
- YOLOv8 and InsightFace models loaded

### 6. Usage Examples

#### Example 1: Check if Imran is Present
1. Go to "📷 Laptop Camera" page
2. Click "Start Camera"
3. Position your face in front of the camera
4. System detects and shows "Imran" with 95% confidence
5. "Imran Detections" counter increments

#### Example 2: Multiple People
1. Multiple faces can be detected simultaneously
2. Each face shows in the results panel
3. Statistics track all detections

#### Example 3: Unknown Person
1. If someone not in the system appears
2. System shows "Unknown" with lower confidence
3. "Unknown Faces" counter increments

### 7. Configuration

#### Frame Processing Rate
- **Current**: 2 FPS (every 500ms)
- **Location**: `startCameraProcessing()` function
- **To Change**: Modify the interval value (500 = 500ms)

#### Camera Resolution
- **Current**: 640x480 (ideal)
- **Location**: `startCamera()` function
- **To Change**: Modify the `width` and `height` values

#### Detection Threshold
- **Current**: Uses `FACE_MATCHING_THRESHOLD` from config
- **Location**: `config.py`
- **Default**: 0.6 (60% similarity)

### 8. Troubleshooting

#### Camera Not Starting
- **Issue**: "Camera access denied"
- **Solution**: 
  - Check browser permissions
  - Allow camera access when prompted
  - Try a different browser
  - Check if camera is already in use

#### No Faces Detected
- **Issue**: "No faces detected" message
- **Solution**:
  - Ensure good lighting
  - Position face clearly in frame
  - Move closer to camera
  - Check if face is partially obscured

#### Wrong Person Detected
- **Issue**: System identifies wrong person
- **Solution**:
  - Re-enroll the person with better video
  - Ensure good lighting during enrollment
  - Check face quality during enrollment
  - Increase enrollment video duration

#### Low Confidence Scores
- **Issue**: Confidence below 60%
- **Solution**:
  - Improve lighting conditions
  - Move closer to camera
  - Ensure face is clearly visible
  - Re-enroll with better quality video

### 9. Performance Notes

- **Frame Processing**: ~500ms per frame (2 FPS)
- **Detection Latency**: ~1-2 seconds from face appearance to identification
- **CPU Usage**: Moderate (depends on system specs)
- **Memory Usage**: ~200-300MB for models

### 10. Security & Privacy

- **Local Processing**: All face detection happens on your server
- **No Cloud Upload**: Frames are not sent to external services
- **Browser Permission**: Camera access requires explicit user permission
- **Session-Based**: Detection data is not stored permanently

### 11. Future Enhancements

Potential improvements:
- [ ] Attendance auto-logging when person detected
- [ ] Snapshot capture and save
- [ ] Recording detection video
- [ ] Multi-camera support
- [ ] Face recognition confidence threshold adjustment
- [ ] Detection history/logs
- [ ] Alert notifications
- [ ] Mobile camera support

### 12. File Changes

#### Modified Files:
1. **templates/index.html**
   - Added new menu item for "📷 Laptop Camera"
   - Added new page view: `camera-detect-view`
   - Added JavaScript functions for camera control
   - Added detection results UI
   - Added statistics display

#### No Backend Changes Required
- Uses existing `/api/recognize/frame` endpoint
- No new database tables needed
- No new configuration required

### 13. Testing Checklist

- [x] Menu item appears in sidebar
- [x] Page loads when clicked
- [x] Camera starts when button clicked
- [x] Browser requests camera permission
- [x] Video stream displays
- [x] Frames are processed
- [x] Detection results appear
- [x] Statistics update
- [x] Camera stops when button clicked
- [x] No console errors

### 14. Support

For issues or questions:
1. Check the troubleshooting section above
2. Review the browser console for errors (F12)
3. Check server logs for backend errors
4. Verify enrolled profiles exist
5. Test with the "Verification Test" page first

---

**Version**: 1.0  
**Date**: May 21, 2026  
**Status**: ✅ Ready for Production
