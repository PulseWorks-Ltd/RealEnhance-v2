# Diagnosis from Your Logs - Nov 12, 2025# Troubleshooting Missing Image URLs



## What Your Logs Revealed## Problem

Images process successfully but URLs don't reach the client. UI shows placeholders briefly, then clears them when status API returns without URLs.

### ✅ Worker is Working Perfectly

## Root Cause Possibilities

From your Railway worker logs:1. **Worker return value not persisted** - BullMQ job.returnvalue is null/undefined

```2. **S3 publish fails silently** - publishImage() throws but error is caught

[WORKER] Original published: kind=s3 url=https://realenhance-bucket...3. **Redis timing issue** - Server reads job before worker writes returnvalue

[WORKER] Final published: kind=s3 url=https://realenhance-bucket...4. **URL construction fails** - S3 region/bucket misconfigured

[worker] completed job job_20ea1df2-56fd-49a8-be02-0234b0538ffe → https://realenhance-bucket...

```## Diagnostic Steps



**This proves:**### 1. Check Worker Logs (Railway worker service)

- Worker uploads to S3 successfully ✅Look for these markers after a job completes:

- Worker gets S3 URLs back ✅  

- Worker completes jobs ✅```

[WORKER] ═══════════ Publishing final enhanced image ═══════════

### ❓ Server Logs Missing Key Debug Info[PUBLISH] >>> ATTEMPTING S3 UPLOAD <<<

[PUBLISH] ✅ SUCCESS!

Server logs show requests but NOT the returnvalue debug logs.[PUBLISH] URL: https://...

[WORKER] Final published: kind=s3 url=https://...

**This suggests:** BullMQ's `returnvalue` is likely empty.```



## 🔧 What I Just FixedThen immediately after:

```

Added enhanced logging to both server and worker. Now when you deploy:[WORKER] ═══════════ JOB RETURN VALUE ═══════════

[WORKER] imageId: img_...

**Worker will log:**[WORKER] originalUrl: https://...

```[WORKER] resultUrl: https://...  ← THIS MUST NOT BE NULL

[worker] ✅ Result captured by BullMQ: { hasResultUrl: true, ... }[WORKER] stageUrls.2: https://...

``````

OR

```**If `resultUrl: NULL`** → S3 publish failed. Check:

[worker] ❌ NO RESULT captured - BullMQ returnvalue will be empty!- S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY set on worker

```- Bucket allows ACLs (Object Ownership = "ACLs enabled")

- Credentials have PutObject permission

**Server will log:**

```### 2. Check Server Logs (Railway server service)

[status/batch] Job xyz returnvalue: {When client polls `/api/status/batch?ids=...`, look for:

  exists: true/false,

  resultUrl: 'https://...' or 'MISSING'```

}[status/batch] Job job_XXX completed but has no returnvalue

``````

OR

## 🚀 Deploy and Test```

[status/batch] Job job_XXX returnvalue exists but resultUrl is missing: {...}

1. **Commit and push:**```

   ```bash

   git add -A**If "no returnvalue"** → BullMQ isn't persisting worker return value. Possible causes:

   git commit -m "Add enhanced BullMQ returnvalue logging"- Worker throws exception after return statement (check for uncaught errors)

   git push- Redis connection issue between worker and BullMQ

   ```- Job timeout (check `WORKER_TIMEOUT` env var)



2. **Wait for Railway redeploy** (both services)**If "resultUrl is missing"** → Worker returned an object but `resultUrl` field is undefined. Review worker logs for `[WORKER] CRITICAL:` lines.



3. **Upload one test image**### 3. Check Client Network Tab (Browser DevTools)

After images "disappear", inspect the last `/api/status/batch?ids=...` response:

4. **Check logs for the new debug output**

```json

5. **Share these specific log lines:**{

   - Worker: `[worker] ✅/❌ Result captured`  "items": [

   - Server: `[status/batch] Job xyz returnvalue:`    {

   - Browser Network tab: Response from `/api/status/batch`      "id": "job_XXX",

      "status": "completed",

These logs will definitively show where URLs are being lost.      "imageUrl": null,  ← PROBLEM

      "resultUrl": null, ← PROBLEM

## 🎯 Most Likely Issue      "originalImageUrl": null

    }

**BullMQ not persisting returnvalue** (60% probability)  ],

  "done": true

**Possible causes:**}

- BullMQ version mismatch between server and worker```

- Redis connection drops during job completion

- Return value not being captured properlyIf both `imageUrl` and `resultUrl` are null, server didn't get URLs from worker.



**Once we see the new logs, I can provide the exact fix.**### 4. Manual Job Inspection

Use the debug endpoint:
```bash
curl -s "https://YOUR-SERVER/api/debug/job/job_XXX" | jq
```

Expected output:
```json
{
  "id": "job_XXX",
  "state": "completed",
  "payload": { "imageId": "...", "type": "enhance" },
  "returnvalue": {
    "resultUrl": "https://...",  ← MUST EXIST
    "originalUrl": "https://...",
    "stageUrls": { "1A": "...", "1B": null, "2": "..." }
  }
}
```

If `returnvalue` is `null`, BullMQ didn't capture the worker's return value.

## Quick Fixes

### If S3 publish fails
1. Verify all S3 env vars are set on WORKER service (not just server)
2. Test S3 manually:
```bash
# SSH into worker container or use Railway CLI
curl -X PUT "https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/test.txt" \
  --aws-sigv4 "aws:amz:${AWS_REGION}:s3" \
  --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}" \
  -d "test"
```

### If returnvalue is missing
1. Check worker doesn't crash after return (tail logs for stack traces)
2. Verify Redis is reachable from worker:
```bash
# In worker container
redis-cli -u $REDIS_URL ping
# Should return PONG
```
3. Increase job timeout if processing is slow:
   - Set `WORKER_TIMEOUT=600000` (10 min) on worker service

### If URLs are returned but client doesn't show them
1. Check browser console for React errors
2. Verify `normalizeBatchItem` in `batch-processor.tsx` line ~20 is checking `it.imageUrl`
3. Test single image (not batch) to isolate batch-specific logic

## Verification After Fix
1. Upload 1-2 test images
2. Watch worker logs for `[WORKER] JOB RETURN VALUE` section - confirm `resultUrl` has a URL
3. Watch server logs - should NOT see warning about missing returnvalue
4. Check `/api/status/batch` response in browser DevTools - `imageUrl` and `resultUrl` should have values
5. Images should render in UI

## Environment Checklist
**Worker must have:**
- S3_BUCKET
- AWS_REGION (e.g., `ap-southeast-2`)
- AWS_ACCESS_KEY_ID
- AWS_SECRET_ACCESS_KEY
- REDIS_URL or REDIS_PRIVATE_URL

**Server must have:**
- Same S3 credentials (for original upload)
- REDIS_URL or REDIS_PRIVATE_URL (same Redis as worker)

**Bucket must:**
- Allow ACLs (Object Ownership = "Object writer" or "Bucket owner preferred")
- NOT have "Block all public access" enabled (for now)
- Grant PutObject + GetObject to IAM user
