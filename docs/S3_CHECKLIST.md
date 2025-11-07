# S3 Quick Troubleshooting Checklist

## Before Deploying

- [ ] S3 bucket exists and is in correct region
- [ ] IAM user has `s3:PutObject` and `s3:PutObjectAcl` permissions
- [ ] Bucket "Block Public Access" settings allow public ACLs
- [ ] Bucket policy allows public read (or using CloudFront)
- [ ] CORS configuration added to bucket

## Railway Configuration

- [ ] `S3_BUCKET` set to exact bucket name
- [ ] `AWS_REGION` matches bucket region
- [ ] `AWS_ACCESS_KEY_ID` set correctly
- [ ] `AWS_SECRET_ACCESS_KEY` set correctly
- [ ] Variables set on **worker service** (not server)

## After Deploying

- [ ] Check worker startup logs show "S3 Status: ✓ ENABLED"
- [ ] Process an image
- [ ] Check worker logs for "[publish] S3 upload successful"
- [ ] Verify image URL starts with `https://` (not `data:`)
- [ ] Test image URL in browser (should load)

## Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| "S3 Status: ❌ DISABLED" in logs | Env vars not set in Railway | Add all 4 required S3 env vars to worker service |
| "Access Denied" in logs | IAM permissions missing | Add s3:PutObject and s3:PutObjectAcl to IAM policy |
| "NoSuchBucket" in logs | Wrong bucket name or region | Verify S3_BUCKET and AWS_REGION match actual bucket |
| Images still Base64 | S3 upload failing silently | Check for "[publish] S3 upload FAILED" in logs |
| 403 when viewing image | Bucket not public | Disable "Block public access" and add bucket policy |
| CORS errors in browser | Missing CORS config | Add CORS policy to S3 bucket |

## Quick Test

Run locally with your Railway credentials:

```bash
cd worker
export S3_BUCKET=realenhance-bucket
export AWS_REGION=ap-southeast-2
export AWS_ACCESS_KEY_ID=<your-key>
export AWS_SECRET_ACCESS_KEY=<your-secret>
npx tsx src/scripts/test-s3.ts
```

If this succeeds, your credentials and bucket are configured correctly.
If this fails, fix the reported issue before deploying to Railway.
