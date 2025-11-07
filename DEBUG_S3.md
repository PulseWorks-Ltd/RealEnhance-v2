# Debug S3 Upload - What to Look For

## Deploy and Test

1. **Push changes:**
   ```bash
   git add .
   git commit -m "Add verbose S3 logging"
   git push
   ```

2. **Wait for Railway to deploy** (check deployment status)

3. **Upload 1 test image** in your app

4. **Check Railway Worker Logs**

## What You'll See

### ✅ If S3 is Working:

```
[worker] Publishing original image...
========================================
[PUBLISH] File: test.jpg
[PUBLISH] S3_BUCKET: realenhance-bucket
[PUBLISH] >>> ATTEMPTING S3 UPLOAD <<<
[PUBLISH] Bucket: realenhance-bucket
[PUBLISH] Region: ap-southeast-2
[PUBLISH] Using explicit AWS credentials (key: AKIA1234...)
[PUBLISH] >>> UPLOADING NOW <<<
[PUBLISH] Destination: s3://realenhance-bucket/realenhance/outputs/1731000000000-test.jpg
[PUBLISH] Size: 2485632 bytes
[PUBLISH] ACL: public-read
[PUBLISH] ✅ SUCCESS!
[PUBLISH] URL: https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/...
========================================
[worker] Original: kind=s3 url=https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/...
```

### ❌ If S3 is Failing:

```
[worker] Publishing original image...
========================================
[PUBLISH] File: test.jpg
[PUBLISH] S3_BUCKET: realenhance-bucket
[PUBLISH] >>> ATTEMPTING S3 UPLOAD <<<
[PUBLISH] Bucket: realenhance-bucket
[PUBLISH] Region: ap-southeast-2
[PUBLISH] Using explicit AWS credentials (key: AKIA1234...)
[PUBLISH] >>> UPLOADING NOW <<<
[PUBLISH] Destination: s3://realenhance-bucket/realenhance/outputs/1731000000000-test.jpg
[PUBLISH] Size: 2485632 bytes
[PUBLISH] ACL: public-read
[PUBLISH] ❌ FAILED!
[PUBLISH] Error: Access Denied
[PUBLISH] Error code: AccessDenied
[PUBLISH] Full error: {...}
[PUBLISH] >>> FALLING BACK TO DATA URL <<<
========================================
[PUBLISH] Generating data URL fallback...
[PUBLISH] Original size: 2485632 bytes
[PUBLISH] Resized: 2485632 -> 145632 bytes (142KB)
[PUBLISH] Data URL created: 195KB
========================================
[worker] Original: kind=data-url url=data:image/webp;base64,UklGRmx...
```

## Common Errors and Fixes

### Error: "Access Denied" / Code: AccessDenied

**Problem:** IAM user doesn't have permission to upload

**Fix:**
1. Go to AWS Console → IAM → Users → [your user]
2. Add inline policy (see docs/S3_SETUP.md Step 2)
3. Make sure it includes `s3:PutObject` and `s3:PutObjectAcl`

### Error: "NoSuchBucket"

**Problem:** Bucket name is wrong or bucket doesn't exist

**Fix:**
1. Go to AWS Console → S3
2. Verify bucket exists
3. Check exact spelling: `realenhance-bucket`
4. Make sure `S3_BUCKET` env var matches exactly

### Error: "InvalidBucketName"

**Problem:** Bucket name contains invalid characters

**Fix:** 
- Bucket names must be lowercase, no underscores
- Use hyphens instead: `realenhance-bucket` not `realenhance_bucket`

### Error: "SignatureDoesNotMatch"

**Problem:** AWS credentials are incorrect

**Fix:**
1. Go to AWS Console → IAM → Users → Security credentials
2. Create new access key
3. Update `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in Railway

### Error: "InvalidAccessKeyId"

**Problem:** Access key ID is wrong or expired

**Fix:**
1. Verify access key in AWS Console
2. Check for typos in Railway environment variable
3. Create new access key if expired

### Still Using Data URLs (kind=data-url)?

**Problem:** S3 upload is silently failing

**Fix:**
1. Look for the error message in worker logs
2. The new logging will show **exactly** what's wrong
3. Follow the specific error fix above

## Verify S3 Configuration

In Railway, check these environment variables on the **worker** service:

- ✅ `S3_BUCKET=realenhance-bucket`
- ✅ `AWS_REGION=ap-southeast-2`
- ✅ `AWS_ACCESS_KEY_ID=AKIA...` (20 characters)
- ✅ `AWS_SECRET_ACCESS_KEY=...` (40 characters)

## Test Manually

You can also test S3 from your local dev container:

```bash
cd worker
export S3_BUCKET=realenhance-bucket
export AWS_REGION=ap-southeast-2
export AWS_ACCESS_KEY_ID=<your-key>
export AWS_SECRET_ACCESS_KEY=<your-secret>
npx tsx src/scripts/test-s3.ts
```

This will tell you immediately if your credentials and bucket are configured correctly.

## Next Steps

Once you see the logs, paste them here and I'll help fix the specific issue!
