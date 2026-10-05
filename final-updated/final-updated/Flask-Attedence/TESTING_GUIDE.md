# 🧪 TESTING GUIDE - NVR Recording Feature

**Last Updated**: May 21, 2026

---

## QUICK START TEST

### Prerequisites
- Flask server running: `python app.py`
- NVR camera accessible at: `rtsp://admin:admin1122@192.168.0.77:554/cam/realmonitor?channel=3&subtype=1`
- DVR camera accessible at: `rtsp://admin:admin1122@192.168.0.77:554/cam/realmonitor?channel=2&subtype=1`

---

## TEST SCENARIO 1: Camera Selection Modal

### Steps
1. Open browser: `http://localhost:5000`
2. Click "👤 Staff Enrollment" tab
3. Enter name: "Test User"
4. Enter email: "test@example.com"
5. Click "Initialize Profile" button
6. Note the User ID (e.g., 33)
7. Click "Record Video (20s)" button

### Expected Result
✅ Camera selection modal opens with two options:
- 📹 NVR Camera (Indigo gradient)
- 📹 DVR Camera (Green gradient)
- Cancel button

### Verification
- [ ] Modal appears with smooth animation
- [ ] Two camera buttons are visible
- [ ] Buttons have correct colors (Indigo and Green)
- [ ] Cancel button works

---

## TEST SCENARIO 2: NVR Recording

### Steps
1. Complete Test Scenario 1
2. Click "📹 NVR Camera" button
3. Recording modal opens
4. Click "Start Recording" button
5. Wait 20 seconds for countdown

### Expected Result
✅ Recording modal shows:
- Recording screen with placeholder
- Status indicator: "🔴 Recording in progress..."
- Countdown timer: 20 → 19 → ... → 0
- Terminal shows: "[RECORDING] Starting 20-second recording from NVR camera..."

### Verification
- [ ] Modal opens with correct camera name
- [ ] Countdown timer displays correctly
- [ ] Status indicator shows recording
- [ ] Terminal logs show NVR camera selected
- [ ] After 20 seconds, extraction screen appears

---

## TEST SCENARIO 3: Extraction Progress

### Steps
1. Complete Test Scenario 2
2. Wait for extraction screen to appear
3. Watch progress bar fill from 0-100%

### Expected Result
✅ Extraction screen shows:
- Spinner animation
- "Extracting Facial Features" title
- Progress bar: 0% → 100%
- "Frames processed: X/100"
- Message: "⏳ This may take 30-60 seconds..."

### Verification
- [ ] Extraction screen appears after recording
- [ ] Progress bar animates smoothly
- [ ] Frame count increases
- [ ] Terminal shows: "[EXTRACTION] Processing video frames..."

---

## TEST SCENARIO 4: Training Progress

### Steps
1. Complete Test Scenario 3
2. Wait for training screen to appear
3. Watch progress bar fill from 0-100%

### Expected Result
✅ Training screen shows:
- Spinner animation
- "Training Biometric Model" title
- Progress bar: 0% → 100%
- "Embeddings stored: X"
- Message: "⏳ Finalizing training..."

### Verification
- [ ] Training screen appears after extraction
- [ ] Progress bar animates smoothly
- [ ] Embeddings count increases (0-50)
- [ ] Terminal shows: "[TRAINING] Training biometric model..."

---

## TEST SCENARIO 5: Completion Screen

### Steps
1. Complete Test Scenario 4
2. Wait for completion screen to appear

### Expected Result
✅ Completion screen shows:
- Large green checkmark: ✓
- "Recording Complete!" title
- Video filename
- Frames extracted count
- Embeddings stored count
- Message: "Ready for live detection!"

### Verification
- [ ] Completion screen appears after training
- [ ] Green checkmark displays
- [ ] Video filename shows (e.g., "nvr_office_enroll_33_1779361522.742425.mp4")
- [ ] Frame count shows (e.g., 516)
- [ ] Embeddings count shows (e.g., 50)
- [ ] Terminal shows: "[SUCCESS] Biometric training completed!"
- [ ] Modal auto-closes after 3 seconds

---

## TEST SCENARIO 6: DVR Recording

### Steps
1. Create new user profile
2. Click "Record Video (20s)"
3. Click "📹 DVR Camera" button
4. Click "Start Recording"
5. Wait for completion

### Expected Result
✅ Same as NVR test, but:
- Modal header shows "DVR Recording"
- Terminal shows: "[RECORDING] Starting 20-second recording from DVR camera..."
- Video filename starts with "dvr_office_" (e.g., "dvr_office_enroll_34_1779361522.742425.mp4")

### Verification
- [ ] DVR camera selected correctly
- [ ] Recording completes successfully
- [ ] Video file created with DVR prefix
- [ ] Terminal shows DVR camera name

---

## TEST SCENARIO 7: Error Handling

### Test 7a: No User ID
1. Click "Record Video (20s)" WITHOUT creating a profile first
2. Expected: Error message "✗ Initialize a User profile first"

### Test 7b: Camera Connection Failure
1. Disconnect NVR camera (or change IP)
2. Try to record
3. Expected: Error message "✗ Recording failed: Cannot connect to NVR camera"

### Test 7c: Invalid User ID
1. Manually enter invalid user ID (e.g., "abc")
2. Try to record
3. Expected: Error message "✗ Invalid user_id"

### Verification
- [ ] Error messages display correctly
- [ ] Terminal shows error logs
- [ ] Modal closes on error
- [ ] User can retry

---

## TEST SCENARIO 8: Terminal Logging

### Steps
1. Open browser console (F12)
2. Go to "Console" tab
3. Complete a full recording cycle

### Expected Terminal Output
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

### Verification
- [ ] All log messages appear
- [ ] Timestamps are correct
- [ ] No error messages
- [ ] Sequence is logical

---

## BACKEND VERIFICATION

### Check Video Files
```bash
# List recorded videos
ls -la uploads/nvr_office_enroll_*.mp4
ls -la uploads/dvr_office_enroll_*.mp4

# Check file size (should be ~50-100 MB for 20 seconds)
du -h uploads/nvr_office_enroll_*.mp4
```

### Check Database
```bash
# Connect to SQLite database
sqlite3 attendance.db

# Check user profiles
SELECT id, name, email, created_at FROM users;

# Check embeddings
SELECT user_id, COUNT(*) as embedding_count FROM embeddings GROUP BY user_id;
```

### Check Logs
```bash
# View application logs
tail -f logs/app.log

# Search for recording events
grep "RECORDING" logs/app.log
grep "SUCCESS" logs/app.log
```

---

## PERFORMANCE METRICS

### Expected Timings
- Camera selection modal: < 100ms
- Recording modal open: < 100ms
- 20-second recording: 20s
- Extraction progress: 30-60s
- Training progress: 10-20s
- Total time: ~60-100 seconds

### Expected File Sizes
- Video file (20s @ 30fps): 50-100 MB
- Database embeddings: ~1-2 KB per embedding

### Expected Resource Usage
- CPU: 20-40% during recording
- Memory: 200-300 MB during extraction
- Disk: 50-100 MB per video

---

## TROUBLESHOOTING

### Issue: Modal doesn't open
**Solution**: 
- Check browser console for errors (F12)
- Verify user ID is set
- Check Flask server is running

### Issue: Recording fails with "Cannot connect to camera"
**Solution**:
- Verify NVR/DVR IP address is correct
- Check network connectivity
- Verify RTSP credentials
- Check firewall settings

### Issue: Extraction/Training takes too long
**Solution**:
- This is normal (30-60 seconds)
- Check CPU usage
- Verify GPU is enabled (if available)

### Issue: Video file not created
**Solution**:
- Check `uploads/` folder exists
- Verify write permissions
- Check disk space
- Check Flask logs for errors

### Issue: Embeddings not stored
**Solution**:
- Check database connection
- Verify `embeddings` table exists
- Check database logs
- Verify user ID is valid

---

## SUCCESS CRITERIA

✅ All tests pass when:
1. Camera selection modal opens and closes correctly
2. NVR recording completes successfully
3. DVR recording completes successfully
4. Extraction progress shows 0-100%
5. Training progress shows 0-50 embeddings
6. Completion screen displays results
7. Modal auto-closes after 3 seconds
8. Video files are created in `uploads/` folder
9. Embeddings are stored in database
10. Terminal logs show all events
11. Error handling works correctly
12. No JavaScript errors in console

---

## NEXT STEPS AFTER TESTING

1. ✅ Verify all test scenarios pass
2. ✅ Check video files are created
3. ✅ Verify embeddings are stored
4. ✅ Test live detection with recorded videos
5. ⏳ Retrain model with NVR data at 6-8 feet
6. ⏳ Verify face recognition is stable (no blinking)

---

**Testing Status**: READY  
**Last Updated**: May 21, 2026
