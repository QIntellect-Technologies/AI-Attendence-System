# 👤 USER FLOW GUIDE - NVR Recording Feature

**Complete step-by-step guide with visual descriptions**

---

## FLOW DIAGRAM

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. STAFF ENROLLMENT PAGE                                        │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 1. Create Staff Profile                                     │ │
│ │ Full Name: [Imran Khalid________________]                   │ │
│ │ Email: [imran@example.com________________]                  │ │
│ │ [Initialize Profile]                                        │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 2. Upload Enrollment Video                                  │ │
│ │ User ID: [33_____]                                          │ │
│ │ [Extract & Train] [Record Video (20s)]                      │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                            ↓
                    User clicks "Record Video (20s)"
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. CAMERA SELECTION MODAL                                       │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 📷 Select Camera                                            │ │
│ │ Choose which camera to record from                          │ │
│ │                                                             │ │
│ │ ┌─────────────────────────────────────────────────────────┐ │ │
│ │ │ 📹 NVR Camera                                           │ │ │
│ │ │ Record from NVR Office                                  │ │ │
│ │ └─────────────────────────────────────────────────────────┘ │ │
│ │                                                             │ │
│ │ ┌─────────────────────────────────────────────────────────┐ │ │
│ │ │ 📹 DVR Camera                                           │ │ │
│ │ │ Record from DVR Office                                  │ │ │
│ │ └─────────────────────────────────────────────────────────┘ │ │
│ │                                                             │ │
│ │ [Cancel]                                                    │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                            ↓
                    User selects camera
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. RECORDING MODAL - READY STATE                                │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🎥 NVR Recording                                            │ │
│ │ Record 20 seconds from your NVR camera                      │ │
│ │                                                             │ │
│ │ ┌─────────────────────────────────────────────────────────┐ │ │
│ │ │                                                         │ │ │
│ │ │              Ready to record                           │ │ │
│ │ │              (16:9 aspect ratio)                       │ │ │
│ │ │                                                         │ │ │
│ │ └─────────────────────────────────────────────────────────┘ │ │
│ │                                                             │ │
│ │ [Start Recording] [Cancel]                                  │ │
│ │                                                             │ │
│ │ ℹ️ Position the person 6-8 feet from the NVR camera        │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                            ↓
                    User clicks "Start Recording"
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. RECORDING MODAL - RECORDING STATE                            │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🎥 NVR Recording                                            │ │
│ │ Record 20 seconds from your NVR camera                      │ │
│ │                                                             │ │
│ │ ┌─────────────────────────────────────────────────────────┐ │ │
│ │ │                                                         │ │ │
│ │ │              Ready to record                           │ │ │
│ │ │              (16:9 aspect ratio)                       │ │ │
│ │ │                                                         │ │ │
│ │ └─────────────────────────────────────────────────────────┘ │ │
│ │                                                             │ │
│ │ ┌─────────────────────────────────────────────────────────┐ │ │
│ │ │ 🔴 Recording in progress...                             │ │ │
│ │ │ Time remaining: 20s                                     │ │ │
│ │ └─────────────────────────────────────────────────────────┘ │ │
│ │                                                             │ │
│ │ [Start Recording] [Cancel]  (disabled)                      │ │
│ │                                                             │ │
│ │ ℹ️ Position the person 6-8 feet from the NVR camera        │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                            ↓
                    Countdown: 20 → 19 → ... → 0
                    (20 seconds of recording)
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. RECORDING MODAL - EXTRACTION STATE                           │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🎥 NVR Recording                                            │ │
│ │ Record 20 seconds from your NVR camera                      │ │
│ │                                                             │ │
│ │ ┌─────────────────────────────────────────────────────────┐ │ │
│ │ │                                                         │ │ │
│ │ │         Extracting Facial Features                     │ │ │
│ │ │         Processing video frames...                     │ │ │
│ │ │                                                         │ │ │
│ │ │         Frames processed: 75/100                       │ │ │
│ │ │         [████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] │ │ │
│ │ │                                                         │ │ │
│ │ │         ⏳ This may take 30-60 seconds...              │ │ │
│ │ │                                                         │ │ │
│ │ └─────────────────────────────────────────────────────────┘ │ │
│ │                                                             │ │
│ │ [Start Recording] [Cancel]  (disabled)                      │ │
│ │                                                             │ │
│ │ ℹ️ Position the person 6-8 feet from the NVR camera        │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                            ↓
                    Progress: 0% → 100%
                    (30-60 seconds)
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 6. RECORDING MODAL - TRAINING STATE                             │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🎥 NVR Recording                                            │ │
│ │ Record 20 seconds from your NVR camera                      │ │
│ │                                                             │ │
│ │ ┌─────────────────────────────────────────────────────────┐ │ │
│ │ │                                                         │ │ │
│ │ │         Training Biometric Model                       │ │ │
│ │ │         Storing facial embeddings...                   │ │ │
│ │ │                                                         │ │ │
│ │ │         Embeddings stored: 38                          │ │ │
│ │ │         [████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] │ │ │
│ │ │                                                         │ │ │
│ │ │         ⏳ Finalizing training...                      │ │ │
│ │ │                                                         │ │ │
│ │ └─────────────────────────────────────────────────────────┘ │ │
│ │                                                             │ │
│ │ [Start Recording] [Cancel]  (disabled)                      │ │
│ │                                                             │ │
│ │ ℹ️ Position the person 6-8 feet from the NVR camera        │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                            ↓
                    Progress: 0% → 100%
                    Embeddings: 0 → 50
                    (10-20 seconds)
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 7. RECORDING MODAL - COMPLETION STATE                           │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🎥 NVR Recording                                            │ │
│ │ Record 20 seconds from your NVR camera                      │ │
│ │                                                             │ │
│ │ ┌─────────────────────────────────────────────────────────┐ │ │
│ │ │                                                         │ │ │
│ │ │                        ✓                               │ │ │
│ │ │                                                         │ │ │
│ │ │              Recording Complete!                       │ │ │
│ │ │                                                         │ │ │
│ │ │  📹 Video recorded:                                    │ │ │
│ │ │     nvr_office_enroll_33_1779361522.742425.mp4         │ │ │
│ │ │  🎯 Frames extracted: 516                              │ │ │
│ │ │  ✓ Embeddings stored: 50                               │ │ │
│ │ │                                                         │ │ │
│ │ │  Ready for live detection!                             │ │ │
│ │ │                                                         │ │ │
│ │ └─────────────────────────────────────────────────────────┘ │ │
│ │                                                             │ │
│ │ [Done] [Cancel]                                             │ │
│ │                                                             │ │
│ │ ℹ️ Position the person 6-8 feet from the NVR camera        │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                            ↓
                    Auto-close after 3 seconds
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 8. BACK TO STAFF ENROLLMENT PAGE                                │
│                                                                 │
│ ✓ Video file saved to uploads/ folder                          │
│ ✓ Embeddings stored in database                                │
│ ✓ Ready for live detection                                     │
│                                                                 │
│ Next: Click "Extract & Train Biometrics" to use the video      │
└─────────────────────────────────────────────────────────────────┘
```

---

## DETAILED STEPS

### Step 1: Create Staff Profile

**What You See**:
```
Full Name: [________________]
Email Address: [________________]
[Initialize Profile]
```

**What You Do**:
1. Enter full name (e.g., "Imran Khalid")
2. Enter email (e.g., "imran@example.com")
3. Click "Initialize Profile"

**What Happens**:
- System creates user profile
- Assigns unique User ID (e.g., 33)
- User ID appears in "Associated Profile User ID" field
- Terminal shows: "[OK] User 'Imran Khalid' created. ID assigned: 33"

---

### Step 2: Click "Record Video (20s)" Button

**What You See**:
```
[Extract & Train Biometrics] [Record Video (20s)]
```

**What You Do**:
- Click "Record Video (20s)" button

**What Happens**:
- Camera selection modal opens
- Terminal shows: "[RECORDING] Camera selection modal opened"

---

### Step 3: Select Camera

**What You See**:
```
┌─────────────────────────────────────────┐
│ 📷 Select Camera                        │
│ Choose which camera to record from      │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ 📹 NVR Camera                       │ │
│ │ Record from NVR Office              │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ 📹 DVR Camera                       │ │
│ │ Record from DVR Office              │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ [Cancel]                                │
└─────────────────────────────────────────┘
```

**What You Do**:
- Click "📹 NVR Camera" or "📹 DVR Camera"

**What Happens**:
- Camera selection modal closes
- Recording modal opens with selected camera
- Terminal shows: "[RECORDING] Selected camera: NVR" (or DVR)

---

### Step 4: Recording Modal Opens

**What You See**:
```
┌─────────────────────────────────────────┐
│ 🎥 NVR Recording                        │
│ Record 20 seconds from your NVR camera  │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │                                     │ │
│ │      Ready to record                │ │
│ │      (16:9 aspect ratio)            │ │
│ │                                     │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ [Start Recording] [Cancel]              │
│                                         │
│ ℹ️ Position the person 6-8 feet from   │
│    the NVR camera for best results     │
└─────────────────────────────────────────┘
```

**What You Do**:
- Click "Start Recording" button

**What Happens**:
- Recording starts
- Countdown timer appears
- Status indicator shows "🔴 Recording in progress..."
- Terminal shows: "[RECORDING] Starting 20-second recording from NVR camera..."

---

### Step 5: Recording in Progress

**What You See**:
```
┌─────────────────────────────────────────┐
│ 🎥 NVR Recording                        │
│ Record 20 seconds from your NVR camera  │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │                                     │ │
│ │      Ready to record                │ │
│ │      (16:9 aspect ratio)            │ │
│ │                                     │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ 🔴 Recording in progress...             │
│ Time remaining: 20s                     │
│                                         │
│ [Start Recording] [Cancel]  (disabled)  │
│                                         │
│ ℹ️ Position the person 6-8 feet from   │
│    the NVR camera for best results     │
└─────────────────────────────────────────┘
```

**What Happens**:
- Countdown timer: 20 → 19 → 18 → ... → 1 → 0
- Recording happens in background
- Buttons are disabled
- After 20 seconds, extraction screen appears

---

### Step 6: Extraction Progress

**What You See**:
```
┌─────────────────────────────────────────┐
│ 🎥 NVR Recording                        │
│ Record 20 seconds from your NVR camera  │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │                                     │ │
│ │  Extracting Facial Features         │ │
│ │  Processing video frames...         │ │
│ │                                     │ │
│ │  Frames processed: 75/100           │ │
│ │  [████████░░░░░░░░░░░░░░░░░░░░░░░░] │ │
│ │                                     │ │
│ │  ⏳ This may take 30-60 seconds...  │ │
│ │                                     │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ [Start Recording] [Cancel]  (disabled)  │
│                                         │
│ ℹ️ Position the person 6-8 feet from   │
│    the NVR camera for best results     │
└─────────────────────────────────────────┘
```

**What Happens**:
- Progress bar fills from 0% to 100%
- Frame counter increases: 0 → 100
- Terminal shows: "[EXTRACTION] Processing video frames..."
- After extraction completes, training screen appears

---

### Step 7: Training Progress

**What You See**:
```
┌─────────────────────────────────────────┐
│ 🎥 NVR Recording                        │
│ Record 20 seconds from your NVR camera  │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │                                     │ │
│ │  Training Biometric Model           │ │
│ │  Storing facial embeddings...       │ │
│ │                                     │ │
│ │  Embeddings stored: 38              │ │
│ │  [████████████░░░░░░░░░░░░░░░░░░░░] │ │
│ │                                     │ │
│ │  ⏳ Finalizing training...          │ │
│ │                                     │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ [Start Recording] [Cancel]  (disabled)  │
│                                         │
│ ℹ️ Position the person 6-8 feet from   │
│    the NVR camera for best results     │
└─────────────────────────────────────────┘
```

**What Happens**:
- Progress bar fills from 0% to 100%
- Embeddings counter increases: 0 → 50
- Terminal shows: "[TRAINING] Training biometric model..."
- After training completes, completion screen appears

---

### Step 8: Completion Screen

**What You See**:
```
┌─────────────────────────────────────────┐
│ 🎥 NVR Recording                        │
│ Record 20 seconds from your NVR camera  │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │                                     │ │
│ │                  ✓                  │ │
│ │                                     │ │
│ │          Recording Complete!        │ │
│ │                                     │ │
│ │  📹 Video recorded:                 │ │
│ │     nvr_office_enroll_33_...mp4     │ │
│ │  🎯 Frames extracted: 516           │ │
│ │  ✓ Embeddings stored: 50            │ │
│ │                                     │ │
│ │  Ready for live detection!          │ │
│ │                                     │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ [Done] [Cancel]                         │
│                                         │
│ ℹ️ Position the person 6-8 feet from   │
│    the NVR camera for best results     │
└─────────────────────────────────────────┘
```

**What Happens**:
- Green checkmark displays: ✓
- Video filename shows
- Frame count shows: 516
- Embeddings count shows: 50
- Terminal shows: "[SUCCESS] Biometric training completed!"
- Modal auto-closes after 3 seconds

---

### Step 9: Back to Enrollment Page

**What You See**:
- Modal has closed
- Back to Staff Enrollment page
- Video file saved to `uploads/` folder
- Embeddings stored in database
- Ready for live detection

**What Happens**:
- Video file: `uploads/nvr_office_enroll_33_1779361522.742425.mp4`
- Embeddings: 50 stored in database
- User profile ready for live detection

---

## TERMINAL OUTPUT

### Complete Recording Session

```
[RECORDING] Camera selection modal opened
[RECORDING] Selected camera: NVR
[RECORDING] NVR recording modal opened
[RECORDING] Starting 20-second recording from NVR camera...
[SUCCESS] NVR recording completed: nvr_office_enroll_33_1779361522.742425.mp4
[INFO] Starting biometric extraction...
[EXTRACTION] Processing video frames...
[TRAINING] Training biometric model...
[SUCCESS] Biometric training completed!
[INFO] Extracted 516 frames, stored 50 embeddings
```

---

## TIMING

| Step | Duration | What's Happening |
|------|----------|------------------|
| 1. Create Profile | < 1s | User profile created |
| 2. Camera Selection | < 1s | Modal opens |
| 3. Recording Modal | < 1s | Modal opens |
| 4. Recording | 20s | Video recorded from camera |
| 5. Extraction | 30-60s | Faces extracted from video |
| 6. Training | 10-20s | Embeddings stored |
| 7. Completion | 3s | Results displayed, auto-close |
| **Total** | **~60-100s** | **Complete workflow** |

---

## SUCCESS INDICATORS

✅ **Recording Successful When**:
- Countdown timer reaches 0
- Terminal shows: "[SUCCESS] NVR recording completed"
- Video filename appears in completion screen

✅ **Extraction Successful When**:
- Progress bar reaches 100%
- Frame counter shows: "Frames processed: 100/100"
- Training screen appears

✅ **Training Successful When**:
- Progress bar reaches 100%
- Embeddings counter shows: "Embeddings stored: 50"
- Completion screen appears with checkmark

✅ **Overall Success When**:
- Completion screen displays all results
- Modal auto-closes after 3 seconds
- Video file exists in `uploads/` folder
- Embeddings stored in database

---

**Last Updated**: May 21, 2026  
**Status**: ✅ COMPLETE AND WORKING
