# Testing Specific Job: job_38e68049-4a27-4dd0-975b-1201e1e575b2

## What Worker Logged (You Can See This)

✅ **Original URL:**
```
https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1762892653456-realenhance-job_38e68049-4a27-4dd0-975b-1201e1e575b2-1762892653252-mft9ikifbjp.jpg
```

✅ **Enhanced URL (1A):**
```
https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1762892654691-realenhance-job_38e68049-4a27-4dd0-975b-1201e1e575b2-1762892653252-mft9ikifbjp-1A.webp
```

✅ **Worker returned this structure:**
```javascript
{
  ok: true,
  imageId: "...",
  jobId: "job_38e68049-4a27-4dd0-975b-1201e1e575b2",
  originalUrl: "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1762892653456...",
  resultUrl: "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1762892654691...",
  stageUrls: {
    "1A": "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1762892654691...",
    "1B": null,
    "2": "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1762892654691..."
  }
}
```

---

## What Should Happen Next (Check These)

### Step 1: BullMQ Captures Return Value

When worker finishes, BullMQ should store the return value in Redis.

**To verify:** Check if worker logs show:
```
[worker] completed job job_38e68049-4a27-4dd0-975b-1201e1e575b2 → https://realenhance-bucket.s3...
```

If you see this → Worker successfully returned the value ✅

---

### Step 2: Server Reads Return Value

When client requests status, server should read from BullMQ.

**To verify:** Check Railway **server logs** for:
```
[status] Job job_38e68049-4a27-4dd0-975b-1201e1e575b2 returnvalue: {
  hasReturnvalue: true,
  resultUrl: 'https://realenhance-bucket.s3...',
  originalUrl: 'https://realenhance-bucket.s3...',
  stageUrlsKeys: [ '1A', '2' ]
}
```

**If you see `hasReturnvalue: false`** → BullMQ didn't capture the worker's return value ❌

**If you DON'T see this log at all** → Client never requested this job's status ❌

---

### Step 3: Server Returns URL to Client

Server should respond with:
```json
{
  "id": "job_38e68049-4a27-4dd0-975b-1201e1e575b2",
  "status": "completed",
  "imageUrl": "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1762892654691...",
  "resultUrl": "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1762892654691...",
  "originalImageUrl": "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1762892653456...",
  "resultImages": ["https://..."],
  "stageUrls": { "1A": "...", "2": "..." }
}
```

**To verify:** Open browser DevTools → Network tab → Find request to:
- `/api/status/job_38e68049-4a27-4dd0-975b-1201e1e575b2` OR
- `/api/status/batch?ids=job_38e68049-4a27-4dd0-975b-1201e1e575b2`

Click on it → Preview tab → Check if `imageUrl` field exists

**If `imageUrl` is null/missing** → Server didn't get returnvalue from BullMQ ❌

---

### Step 4: Client Receives and Processes URL

Browser console should show:
```javascript
[BATCH] Received status update: {
  totalItems: 1,
  completed: 1,
  sample: {
    id: 'job_38e68049-4a27-4dd0-975b-1201e1e575b2',
    status: 'completed',
    hasImageUrl: true,  // ← KEY: Should be TRUE
    imageUrlPreview: 'https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1762892654691...'
  }
}

[SCHEDULE] Processing item: {
  index: 0,
  hasResult: true,
  imageUrl: 'https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1762892654691...'
}

[SCHEDULE] Normalized: {
  normOk: true,  // ← KEY: Should be TRUE
  normImage: 'https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1762892654691...'
}
```

**If `hasImageUrl: false`** → Server response didn't include URL ❌

**If `normOk: false`** → Client couldn't extract URL from response structure ❌

---

### Step 5: Browser Loads Image from S3

Browser tries to fetch the image. If CORS is misconfigured, you'll see:
```
Access to fetch at 'https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/...' 
from origin 'https://your-app.com' has been blocked by CORS policy
```

**To test manually:** Open browser console and run:
```javascript
fetch('https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1762892654691-realenhance-job_38e68049-4a27-4dd0-975b-1201e1e575b2-1762892653252-mft9ikifbjp-1A.webp')
  .then(r => console.log('✅ CORS OK:', r.status))
  .catch(e => console.error('❌ CORS BLOCKED:', e));
```

---

## Where URLs Are Getting Lost

Based on your symptom (URLs visible in worker logs but not in UI), the break is happening in one of these places:

### Most Likely: BullMQ Not Persisting Return Value

**Cause:** Worker crashes after returning but before BullMQ saves to Redis

**How to check:**
1. Look for worker errors AFTER the "JOB RETURN VALUE" log
2. Check if worker logs show `[worker] completed job ...`
3. Check server logs for `hasReturnvalue: false`

**Fix:** Make sure worker doesn't crash, ensure Redis connection is stable

---

### Second Most Likely: CORS Blocking Browser

**Cause:** S3 bucket doesn't allow browser to load images

**How to check:**
1. Browser console shows CORS error
2. Network tab shows request failed with CORS error
3. Image element shows broken icon

**Fix:** Add CORS configuration to S3 bucket (see QUICK_FIX.md)

---

### Less Likely: Client Not Polling This Job

**Cause:** Job ID not included in batch polling request

**How to check:**
1. Server logs DON'T show any `[status]` line for this job
2. Network tab DON'T show requests with this job ID

**Fix:** Check client's jobIdToIndexRef mapping, verify job was added to state

---

## Action Items for YOU

1. **Share your Railway server logs** - Look for lines with `[status]` and this job ID
   - Specifically around the time this job completed
   - Should show whether returnvalue was present

2. **Share your browser console logs** - Look for `[BATCH]` and `[SCHEDULE]` lines
   - Should show whether client received the URL
   - Should show whether normalization succeeded

3. **Check browser Network tab** - Find the status API request
   - Preview the response JSON
   - Check if `imageUrl` field exists and has a value

4. **Test S3 URL directly** - Run this in browser console:
   ```javascript
   fetch('https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1762892654691-realenhance-job_38e68049-4a27-4dd0-975b-1201e1e575b2-1762892653252-mft9ikifbjp-1A.webp')
   ```

Once you share these logs, I can pinpoint exactly where the chain breaks.
