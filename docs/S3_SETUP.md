# S3 Configuration Guide

## Current Status

Your app currently uses **data URL fallback** (Base64-encoded images in JSON responses). This works but has limitations:
- Images resized to 800px max (reduced quality)
- 10MB JSON payload limit
- Slower response times

**S3 storage** allows:
- Full-resolution images
- Faster loading
- Lower server bandwidth
- No payload size limits

## Prerequisites

1. **AWS Account** with S3 access
2. **S3 Bucket** created (you have: `realenhance-bucket`)
3. **IAM User** with programmatic access

## Step 1: Create IAM User (if not done)

1. Go to AWS Console → IAM → Users
2. Click "Create user"
3. Username: `realenhance-s3-uploader`
4. Enable "Programmatic access"
5. Click "Next"

## Step 2: Set IAM Permissions

Attach this inline policy to your IAM user:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:PutObjectAcl",
        "s3:GetObject"
      ],
      "Resource": "arn:aws:s3:::realenhance-bucket/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": "arn:aws:s3:::realenhance-bucket"
    }
  ]
}
```

## Step 3: Configure S3 Bucket

### Bucket Settings

1. **Region**: Must match `AWS_REGION` (you have: `ap-southeast-2`)
2. **Block Public Access**: DISABLE for public-read ACLs to work
   - Go to bucket → Permissions → Block public access
   - Uncheck "Block public ACLs" 
   - Uncheck "Block public bucket policies"

### Bucket Policy

Add this policy to allow public read access:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::realenhance-bucket/*"
    }
  ]
}
```

### CORS Configuration

Add this CORS policy to allow browser access:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": ["*"],
    "ExposeHeaders": ["ETag"]
  }
]
```

## Step 4: Railway Environment Variables

Set these in Railway → Worker service → Variables:

### Required Variables

```bash
S3_BUCKET=realenhance-bucket
AWS_REGION=ap-southeast-2
AWS_ACCESS_KEY_ID=AKIA...  # From IAM user
AWS_SECRET_ACCESS_KEY=...   # From IAM user
```

### Optional Variables

```bash
# Prefix for all uploaded files (default: realenhance/outputs)
S3_PREFIX=realenhance/outputs

# ACL for uploaded files (default: public-read)
# Options: public-read, bucket-owner-full-control, private
S3_ACL=public-read

# Use CloudFront or custom domain (optional)
# S3_PUBLIC_BASEURL=https://cdn.yourdomain.com
```

## Step 5: Deploy & Test

1. **Deploy to Railway**
   ```bash
   git add .
   git commit -m "Add S3 configuration with diagnostics"
   git push
   ```

2. **Check Worker Logs**
   - Go to Railway → Worker service → Logs
   - Look for startup message:
   ```
   [worker] S3 Configuration:
     S3_BUCKET: realenhance-bucket
     AWS_REGION: ap-southeast-2
     AWS_ACCESS_KEY_ID: SET (AKIA1234...)
     AWS_SECRET_ACCESS_KEY: SET
     S3 Status: ✓ ENABLED
   ```

3. **Test Enhancement**
   - Upload and enhance an image
   - Check worker logs for:
   ```
   [publish] Attempting S3 upload: bucket=realenhance-bucket, region=ap-southeast-2
   [publish] Uploading to s3://realenhance-bucket/... (2485632 bytes)
   [publish] S3 upload successful: https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/...
   ```

## Troubleshooting

### Issue: "Access Denied" error

**Cause**: IAM user doesn't have permission to upload

**Fix**: 
- Check IAM policy includes `s3:PutObject` and `s3:PutObjectAcl`
- Verify policy Resource matches your bucket name

### Issue: "NoSuchBucket" error

**Cause**: Bucket name or region mismatch

**Fix**:
- Verify `S3_BUCKET` matches actual bucket name (case-sensitive)
- Verify `AWS_REGION` matches bucket region
- Check bucket exists in AWS Console

### Issue: Images upload but return 403 when accessed

**Cause**: Bucket doesn't allow public read

**Fix**:
- Disable "Block public access" in bucket settings
- Add bucket policy (see Step 3)
- Or use `S3_ACL=bucket-owner-full-control` and serve through CloudFront

### Issue: Still seeing data URLs

**Cause**: S3 upload is silently failing

**Fix**:
- Check worker logs for `[publish] S3 upload FAILED` messages
- Verify all 4 required env vars are set in Railway
- Run local test: `npx tsx worker/src/scripts/test-s3.ts` with env vars

### Issue: CORS errors in browser

**Cause**: S3 bucket doesn't allow browser access

**Fix**:
- Add CORS configuration to bucket (see Step 3)

## Local Development

To test S3 locally:

1. **Create `.env` file** in worker directory:
   ```bash
   S3_BUCKET=realenhance-bucket
   AWS_REGION=ap-southeast-2
   AWS_ACCESS_KEY_ID=AKIA...
   AWS_SECRET_ACCESS_KEY=...
   ```

2. **Run test script**:
   ```bash
   cd worker
   npx tsx src/scripts/test-s3.ts
   ```

3. **Start worker with .env**:
   ```bash
   # Install dotenv-cli
   npm install -g dotenv-cli
   
   # Start worker
   cd worker
   dotenv -e .env pnpm start
   ```

## Production Best Practices

### Use CloudFront (Recommended)

CloudFront provides:
- Faster global delivery
- HTTPS by default
- Custom domain support
- Lower S3 egress costs

Setup:
1. Create CloudFront distribution pointing to S3 bucket
2. Set `S3_PUBLIC_BASEURL=https://d123456.cloudfront.net`
3. Use `S3_ACL=bucket-owner-full-control` (no public bucket policy needed)

### Environment Variables

In Railway:
- Store credentials as **secrets** (Railway auto-hides values)
- Never commit credentials to git
- Rotate AWS keys periodically

### Monitoring

Check these metrics:
- Worker logs for S3 errors
- S3 bucket size (CloudWatch)
- S3 request metrics (CloudWatch)
- Image load times in browser DevTools

## Cost Estimation

Approximate AWS S3 costs (ap-southeast-2 region):

- **Storage**: $0.025/GB/month
  - 1000 enhanced images (~3MB each) = 3GB = $0.075/month
- **PUT requests**: $0.0055 per 1000 requests
  - 1000 images = $0.0055
- **GET requests**: $0.00044 per 1000 requests
  - 10,000 views = $0.0044
- **Data transfer OUT**: $0.114/GB (first 10TB)
  - 1000 downloads (3MB each) = 3GB = $0.34

**Total for 1000 images/month**: ~$0.43/month

Add CloudFront for better rates on data transfer.

## Support

If you encounter issues:
1. Check Railway worker logs first
2. Verify IAM permissions in AWS Console
3. Test locally with `test-s3.ts` script
4. Verify bucket settings (public access, CORS, region)
