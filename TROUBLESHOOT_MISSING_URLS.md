# Troubleshooting Missing Image URLs

## Problem
Images process successfully but URLs don't reach the client. UI shows placeholders briefly, then clears them when status API returns without URLs.

## Root Cause Possibilities
1. **Worker return value not persisted** - BullMQ job.returnvalue is null/undefined
2. **S3 publish fails silently** - publishImage() throws but error is caught
3. **Redis timing issue** - Server reads job before worker writes returnvalue
4. **URL construction fails** - S3 region/bucket misconfigured

## Diagnostic Steps

### 1. Check Worker Logs (Railway worker service)
Look for these markers after a job completes:

```
[WORKER] ═══════════ Publishing final enhanced image ═══════════
[PUBLISH] >>> ATTEMPTING S3 UPLOAD <<<
[PUBLISH] ✅ SUCCESS!
[PUBLISH] URL: https://...
[WORKER] Final published: kind=s3 url=https://...
```

Then immediately after:
```
[WORKER] ═══════════ JOB RETURN VALUE ═══════════
[WORKER] imageId: img_...
[WORKER] originalUrl: https://...
[WORKER] resultUrl: https://...  ← THIS MUST NOT BE NULL
[WORKER] stageUrls.2: https://...
```

**If `resultUrl: NULL`** → S3 publish failed. Check:
- S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY set on worker
- Bucket allows ACLs (Object Ownership = "ACLs enabled")
- Credentials have PutObject permission

### 2. Check Server Logs (Railway server service)
When client polls `/api/status/batch?ids=...`, look for:

```
[status/batch] Job job_XXX completed but has no returnvalue
```
OR
```
[status/batch] Job job_XXX returnvalue exists but resultUrl is missing: {...}
```

**If "no returnvalue"** → BullMQ isn't persisting worker return value. Possible causes:
- Worker throws exception after return statement (check for uncaught errors)
- Redis connection issue between worker and BullMQ
- Job timeout (check `WORKER_TIMEOUT` env var)

**If "resultUrl is missing"** → Worker returned an object but `resultUrl` field is undefined. Review worker logs for `[WORKER] CRITICAL:` lines.

### 3. Check Client Network Tab (Browser DevTools)
After images "disappear", inspect the last `/api/status/batch?ids=...` response:

```json
{
  "items": [
    {
      "id": "job_XXX",
      "status": "completed",
      "imageUrl": null,  ← PROBLEM
      "resultUrl": null, ← PROBLEM
      "originalImageUrl": null
    }
  ],
  "done": true
}
```

If both `imageUrl` and `resultUrl` are null, server didn't get URLs from worker.

### 4. Manual Job Inspection
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
