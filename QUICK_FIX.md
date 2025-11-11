# Quick Fix - Enhanced Images Not Displaying

## TL;DR - Most Likely Fix (30 seconds)

**Problem:** Pipeline runs, S3 upload succeeds, direct URL works, but image doesn't show in app.

**Solution:** Fix S3 CORS configuration.

### Fix It Now:

1. **AWS Console** → S3 → `realenhance-images-v2` → Permissions → CORS
2. **Paste this:**

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

3. **Save** → Test immediately (no deployment needed)

---

## How to Confirm It's Working

### Test 1: Browser Console
```javascript
// In browser console, paste:
fetch('YOUR_S3_IMAGE_URL')
  .then(r => console.log('✅ CORS OK'))
  .catch(e => console.error('❌ CORS blocked'));
```

### Test 2: Run Diagnostic Script
```bash
./test-api-response.sh <JOB_ID>
```

### Test 3: Check Logs
Upload an image, look for:
```javascript
[BATCH] sample: { hasImageUrl: true }  // ← Should be TRUE
[SCHEDULE] Normalized: { normOk: true }  // ← Should be TRUE
```

---

## If CORS Doesn't Fix It

Run the diagnostic script:
```bash
./test-api-response.sh <JOB_ID>
```

Then share:
1. Script output
2. Browser console logs
3. Server logs showing `[status]` lines

See `DIAGNOSIS.md` for complete troubleshooting guide.

---

## Why CORS is Probably the Issue

✅ Your code is architecturally correct:
- Worker uploads to S3 ✓
- Worker returns URL via BullMQ ✓  
- Server reads returnvalue ✓
- Server returns `imageUrl` field ✓
- Client extracts `imageUrl` ✓

❌ But browser blocks S3 request:
- CORS headers missing
- Browser shows broken image icon
- No error in app logs (silent failure)

**Fix the CORS, fix the problem.**
