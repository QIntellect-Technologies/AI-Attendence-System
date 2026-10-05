# ⚡ QUICK TEST: Flickering Fix

**What to Test**: Does the face stay locked on "Imran Khalid" without flickering to "Unknown"?  
**Duration**: 5 minutes  
**Equipment**: NVR camera at 6-8 feet distance

---

## TEST SETUP

1. **Start the Flask app**
   ```bash
   python app.py
   ```

2. **Open the web interface**
   - Go to `http://localhost:5000`
   - Make sure Imran Khalid is enrolled (has embeddings in database)

3. **Open the terminal/logs**
   - Watch for track IDs and names in real-time
   - Look for patterns like: Track 17, Track 18, Track 19 (different IDs = flickering)

---

## TEST 1: Walk in Front of Camera (2 minutes)

### Setup
- Stand 6-8 feet from NVR camera
- Make sure your face is clearly visible

### Action
1. Walk slowly left to right
2. Walk slowly right to left
3. Stop and stand still
4. Turn head left and right (but stay in frame)

### Expected Results
- ✅ Green bounding box follows your face
- ✅ Name shows "Imran Khalid" (or your name if enrolled)
- ✅ **SAME TRACK ID** throughout (e.g., always Track 17)
- ✅ NO flickering to "Unknown"
- ✅ NO flickering to different track IDs

### What to Look For (BEFORE FIX)
```
[4:25:00] Track 17: Imran Khalid detected (0.62)
[4:25:01] Track 18: Unknown detected (FLICKER!)
[4:25:02] Track 19: Imran Khalid detected (FLICKER!)
[4:25:03] Track 20: Unknown detected (FLICKER!)
```

### What to Look For (AFTER FIX)
```
[4:25:00] Track 17: Imran Khalid detected (0.62) - LOCK ESTABLISHED
[4:25:01] Track 17: Imran Khalid tracked (same track)
[4:25:02] Track 17: Imran Khalid tracked (same track)
[4:25:03] Track 17: Imran Khalid tracked (same track)
```

---

## TEST 2: Turn Head Away (1 minute)

### Setup
- Stand in front of camera
- Make sure your face is clearly visible

### Action
1. Look at camera (face visible)
2. Turn head away (face not visible)
3. Wait 1-2 seconds
4. Turn back to camera

### Expected Results
- ✅ Green bounding box persists even when head turned
- ✅ Name stays "Imran Khalid"
- ✅ **SAME TRACK ID** throughout
- ✅ NO "Unknown" appears when head turned
- ✅ Bounding box reappears immediately when you turn back

### What to Look For (BEFORE FIX)
```
[4:25:00] Track 17: Imran Khalid detected (0.62)
[4:25:01] Track 18: Unknown detected (head turned - FLICKER!)
[4:25:02] Track 19: Imran Khalid detected (turned back)
```

### What to Look For (AFTER FIX)
```
[4:25:00] Track 17: Imran Khalid detected (0.62)
[4:25:01] Track 17: Imran Khalid tracked (grace period active, head turned)
[4:25:02] Track 17: Imran Khalid tracked (redetected)
```

---

## TEST 3: Multiple People (1 minute)

### Setup
- Get another person to stand with you
- Both should be 6-8 feet from camera

### Action
1. Both stand in front of camera
2. Walk around each other
3. One person leaves
4. Other person stays

### Expected Results
- ✅ Each person gets their own track
- ✅ Names are correct (if both enrolled)
- ✅ NO confusion between identities
- ✅ Bounding boxes don't flicker or swap

### What to Look For (BEFORE FIX)
```
[4:25:00] Track 17: Imran Khalid detected
[4:25:01] Track 18: Unknown detected (other person)
[4:25:02] Track 19: Imran Khalid detected (FLICKER!)
[4:25:03] Track 20: Unknown detected (FLICKER!)
```

### What to Look For (AFTER FIX)
```
[4:25:00] Track 17: Imran Khalid detected
[4:25:01] Track 18: Unknown detected (other person)
[4:25:02] Track 17: Imran Khalid tracked (same track)
[4:25:03] Track 18: Unknown tracked (same track)
```

---

## TEST 4: Person Leaves and Returns (1 minute)

### Setup
- Stand in front of camera
- Make sure your face is clearly visible

### Action
1. Stand in front of camera (face visible)
2. Walk out of frame
3. Wait 2+ seconds
4. Walk back in

### Expected Results
- ✅ When you leave: Bounding box disappears after 1.5 seconds
- ✅ When you return: New track created (different track ID)
- ✅ Quickly recognized as "Imran Khalid"
- ✅ NO flickering when returning

### What to Look For (BEFORE FIX)
```
[4:25:00] Track 17: Imran Khalid detected
[4:25:05] Track 17 expires (left frame)
[4:25:07] Track 18: Unknown detected (returned)
[4:25:08] Track 19: Imran Khalid detected (FLICKER!)
[4:25:09] Track 20: Unknown detected (FLICKER!)
```

### What to Look For (AFTER FIX)
```
[4:25:00] Track 17: Imran Khalid detected
[4:25:05] Track 17 expires (left frame)
[4:25:07] Track 18: Unknown detected (returned)
[4:25:08] Track 18: Imran Khalid detected (quickly recognized)
[4:25:09] Track 18: Imran Khalid tracked (stable)
```

---

## PASS/FAIL CRITERIA

### ✅ PASS (Fix is working)
- [ ] Test 1: Same track ID throughout walk, no flickering
- [ ] Test 2: Same track ID when head turned, no "Unknown" appears
- [ ] Test 3: Each person has own track, no confusion
- [ ] Test 4: New track created when returning, quickly recognized

### ❌ FAIL (Fix not working)
- [ ] Different track IDs for same person (flickering)
- [ ] "Unknown" appears when it shouldn't
- [ ] Bounding box disappears and reappears
- [ ] Multiple tracks for same person

---

## DEBUGGING

### If Test Fails

1. **Check the logs**
   ```bash
   tail -f logs/app.log
   ```
   Look for track IDs and names

2. **Check the terminal output**
   - Look for "LOCK ESTABLISHED" messages
   - Look for track ID changes

3. **Check the database**
   - Make sure Imran Khalid is enrolled
   - Make sure embeddings exist

4. **Check the camera**
   - Make sure NVR camera is working
   - Make sure you're 6-8 feet away
   - Make sure lighting is good

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Still flickering | Fix not applied | Check app.py lines 630-730 |
| No face detected | Camera not working | Check NVR URL in config.py |
| Always "Unknown" | Not enrolled | Enroll Imran Khalid first |
| Bounding box disappears | Grace period too short | Check line 786 (should be 1.5s) |

---

## WHAT TO REPORT

If the fix works:
```
✅ FLICKERING FIX SUCCESSFUL
- Test 1: PASS (same track ID, no flickering)
- Test 2: PASS (grace period working)
- Test 3: PASS (multiple people tracked correctly)
- Test 4: PASS (new track created, quickly recognized)
```

If the fix doesn't work:
```
❌ FLICKERING FIX FAILED
- Test 1: FAIL (different track IDs: 17, 18, 19, 20)
- Logs show: Track 17 "Imran Khalid", Track 18 "Unknown", Track 19 "Imran Khalid"
- Issue: Same person getting multiple track IDs
```

---

**Duration**: 5 minutes  
**Difficulty**: Easy  
**Equipment**: NVR camera, laptop with Flask app  
**Status**: Ready to test

