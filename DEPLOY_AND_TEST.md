# Deploy and Test S3 Configuration

## What Changed

1. **Forced stdout/stderr flushing** - Railway was buffering logs
2. **Visual delimiters** - Box drawing characters make logs unmissable  
3. **Build version marker** - `2025-11-07_16:00_S3_VERBOSE_LOGS` to confirm deployment
4. **process.stdout.write()** instead of console.log() - bypasses Node.js buffering

## Deploy

```bash
git add .
git commit -m "Force stdout flushing for S3 debug logs"
git push
```

## What to Look For

### 1. Check Worker Started with New Build

Look for this EXACT box in worker logs:
```
╔════════════════════════════════════════════════════════════════╗
║                   WORKER STARTING                              ║
╚════════════════════════════════════════════════════════════════╝
[WORKER] BUILD: 2025-11-07_16:00_S3_VERBOSE_LOGS
```

**If you see a different BUILD version**, the old code is still running!

### 2. Check S3 Configuration Box

```
╔════════════════════════════════════════════════════════════════╗
║                   S3 CONFIGURATION                             ║
╚════════════════════════════════════════════════════════════════╝
  S3_BUCKET: realenhance-bucket
  AWS_REGION: ap-southeast-2
  AWS_ACCESS_KEY_ID: ✅ SET (AKIA1234...)
  AWS_SECRET_ACCESS_KEY: ✅ SET
  S3_PUBLIC_BASEURL: NOT SET (will use S3 direct URLs)
  📊 Status: ✅ ENABLED - Images will upload to S3
╚════════════════════════════════════════════════════════════════╝
```

### 3. Test ONE Image

Upload and enhance a single image.

### 4. Look for Publish Logs

You should now see this pattern for EACH image:

```
[WORKER] ═══════════ Publishing original image ═══════════
========================================
[PUBLISH] File: original.jpg
[PUBLISH] S3_BUCKET: realenhance-bucket
[PUBLISH] >>> ATTEMPTING S3 UPLOAD <<<
[PUBLISH] Bucket: realenhance-bucket
[PUBLISH] Region: ap-southeast-2
[PUBLISH] Using explicit AWS credentials (key: AKIA1234...)
[PUBLISH] >>> UPLOADING NOW <<<
[PUBLISH] Destination: s3://realenhance-bucket/realenhance/outputs/1731000000000-original.jpg
[PUBLISH] Size: 2485632 bytes
[PUBLISH] ACL: public-read
[PUBLISH] ✅ SUCCESS!
[PUBLISH] URL: https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/...
========================================

[WORKER] Original published: kind=s3 url=https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/...
```

## If Still No Logs

If you still don't see the `[PUBLISH]` logs after confirming the build version, then:

1. **Railway is caching the old worker container**
   - Solution: In Railway, go to Worker service → Settings → Restart
   
2. **Jobs are queued from before the deployment**
   - Solution: Restart Redis to clear the queue
   - Or wait for old jobs to finish, then test again

3. **The function isn't being called at all**
   - This would mean there's a crash earlier in the pipeline
   - Check for error messages before the publish attempt

## Common Errors to Watch For

### AccessDenied
```
[PUBLISH] ❌ FAILED!
[PUBLISH] Error: Access Denied
[PUBLISH] Error code: AccessDenied
```
**Fix:** Add IAM permissions (see docs/S3_SETUP.md)

### NoSuchBucket
```
[PUBLISH] ❌ FAILED!
[PUBLISH] Error: The specified bucket does not exist
[PUBLISH] Error code: NoSuchBucket
```
**Fix:** Create bucket or fix bucket name

### SignatureDoesNotMatch
```
[PUBLISH] ❌ FAILED!
[PUBLISH] Error: The request signature we calculated does not match
[PUBLISH] Error code: SignatureDoesNotMatch
```
**Fix:** AWS credentials are wrong - regenerate them

## Success Criteria

✅ See new BUILD version in logs  
✅ See S3 Status: ✅ ENABLED  
✅ See `[PUBLISH] >>> ATTEMPTING S3 UPLOAD <<<`  
✅ See `[PUBLISH] ✅ SUCCESS!`  
✅ See `kind=s3` in worker logs  
✅ Image URL starts with `https://realenhance-bucket.s3.`  
✅ Server response size is small (~1-5KB instead of 100-500KB)  

## If It Works

S3 is configured correctly! The app will now:
- Upload full-resolution images to S3
- Return small JSON responses (~2KB)
- Load images much faster
- Support unlimited image sizes

## If It Fails

The error message will tell you exactly what's wrong. Common fixes:

1. **IAM permissions** - User needs `s3:PutObject` and `s3:PutObjectAcl`
2. **Bucket policy** - Add public read policy (see docs/S3_SETUP.md)
3. **Block Public Access** - Must be disabled for public-read ACL
4. **Credentials** - Regenerate if expired or typo in Railway env vars
5. **Region mismatch** - Bucket must be in ap-southeast-2

Share the error logs and I'll help fix the specific issue!
