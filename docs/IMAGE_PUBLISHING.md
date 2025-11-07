# Image Publishing Configuration

## Current Issue

Without S3 configured, the worker falls back to data URLs for image results. For full-size images, these can be 2-5MB+ base64-encoded, causing:
- HTTP response size limits exceeded
- Browser memory/performance issues  
- Failed image displays in the UI

## Temporary Workaround (Active)

The worker now automatically resizes images to 800px max dimension when using data URL fallback. This keeps data URLs under ~500KB, allowing the app to function.

**Limitation**: Images are downsized from their original enhanced quality.

## Production Solution: Configure S3

### Option 1: AWS S3

1. **Create S3 Bucket**:
   ```bash
   aws s3 mb s3://realenhance-outputs --region us-east-1
   ```

2. **Set Bucket Policy** (public read):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "PublicRead",
         "Effect": "Allow",
         "Principal": "*",
         "Action": "s3:GetObject",
         "Resource": "arn:aws:s3:::realenhance-outputs/*"
       }
     ]
   }
   ```

3. **Create IAM User** with `PutObject` permission:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "s3:PutObject",
           "s3:PutObjectAcl"
         ],
         "Resource": "arn:aws:s3:::realenhance-outputs/*"
       }
     ]
   }
   ```

4. **Set Railway Environment Variables** (worker service):
   ```
   S3_BUCKET=realenhance-outputs
   AWS_REGION=us-east-1
   AWS_ACCESS_KEY_ID=AKIA...
   AWS_SECRET_ACCESS_KEY=...
   S3_ACL=public-read
   S3_PREFIX=outputs
   ```

5. **Optional CDN**:
   ```
   S3_PUBLIC_BASEURL=https://cdn.yourdomain.com
   ```

### Option 2: Cloudflare R2 (Recommended - Free egress)

1. **Create R2 Bucket** in Cloudflare dashboard

2. **Get R2 Credentials**:
   - Go to R2 → Manage R2 API Tokens
   - Create API token with "Object Read & Write" permissions

3. **Set Railway Environment Variables**:
   ```
   S3_BUCKET=realenhance-outputs
   AWS_REGION=auto
   AWS_ACCESS_KEY_ID=<R2 Access Key ID>
   AWS_SECRET_ACCESS_KEY=<R2 Secret Access Key>
   AWS_ENDPOINT_URL=https://<account-id>.r2.cloudflarestorage.com
   S3_PUBLIC_BASEURL=https://<bucket>.r2.dev
   S3_ACL=public-read
   ```

### Option 3: Railway Volumes (Not Recommended)

Railway volumes are persistent but:
- Not designed for serving public assets
- Require custom serving logic
- No CDN/geo-distribution

## Implementation Details

The `worker/src/utils/publish.ts` file:
- Checks for `S3_BUCKET` environment variable
- If present, uploads to S3/R2 using AWS SDK
- If absent, falls back to resized data URL with warning
- Uses `@aws-sdk/client-s3` (needs to be installed)

## Installing AWS SDK

For S3 support, install in worker:

```bash
cd worker
pnpm add @aws-sdk/client-s3
```

Then rebuild and redeploy.

## Verification

After configuring S3, check worker logs for:
```
[worker] final published kind=s3 url=https://...
```

Instead of:
```
[publish] No S3 configured - using resized data URL
```

## Cost Estimates

**AWS S3**:
- Storage: ~$0.023/GB/month
- PUT requests: $0.005 per 1,000
- GET requests: $0.0004 per 1,000
- Data transfer out: $0.09/GB (first 10TB)

**Cloudflare R2** (Recommended):
- Storage: $0.015/GB/month
- PUT requests: Free
- GET requests: Free
- Data transfer out: **FREE** (unlimited)

For ~1000 images/month at 2MB average:
- AWS S3: ~$2.30/month (storage + transfer)
- Cloudflare R2: ~$0.03/month (storage only)
