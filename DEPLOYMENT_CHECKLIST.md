# Deployment Checklist

## ✅ Completed
- [x] Identified root cause: Data URLs too large without S3
- [x] Implemented auto-resize fallback for data URLs  
- [x] Added @aws-sdk/client-s3 as optional dependency
- [x] Verified worker builds successfully
- [x] Verified Docker build succeeds
- [x] Created documentation for S3/R2 setup

## 🚀 Ready to Deploy

### Step 1: Commit and Push
```bash
git add .
git commit -m "Fix image publishing: Add auto-resize fallback and S3 support"
git push
```

### Step 2: Verify Railway Deployment
- Railway will auto-deploy the worker
- Check build logs - should succeed
- Check worker runtime logs for:
  - `[worker] ready and listening`
  - `[publish] No S3 configured - using resized data URL` (if S3 not set)

### Step 3: Test Image Enhancement
1. Go to your app URL
2. Upload a test image
3. Select "Only enhance image quality" (Stage 1A)
4. Click enhance
5. Should see 800px preview result

### Step 4: Configure S3/R2 (Optional, for Full Quality)

#### Recommended: Cloudflare R2
1. Create R2 bucket in Cloudflare
2. Get API token (R2 → Manage R2 API Tokens)
3. Add to Railway worker service env vars:
   ```
   S3_BUCKET=realenhance-outputs
   AWS_REGION=auto
   AWS_ACCESS_KEY_ID=<R2 key>
   AWS_SECRET_ACCESS_KEY=<R2 secret>
   AWS_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com
   S3_PUBLIC_BASEURL=https://<bucket>.r2.dev
   ```
4. Redeploy worker
5. Test again - should see full resolution

## 📝 Files Changed

```
worker/src/utils/publish.ts        - Auto-resize for data URL fallback
worker/package.json                - Added @aws-sdk/client-s3
docs/IMAGE_PUBLISHING.md           - S3/R2 setup guide
FIX_SUMMARY.md                     - Issue analysis and fix
```

## 🔍 Verification Commands

### Check if S3 is working (after configuration):
```bash
# Railway CLI
railway logs --service worker | grep "published kind"

# Should see:
# [worker] final published kind=s3 url=https://...
```

### Check data URL fallback (before S3 configuration):
```bash
railway logs --service worker | grep "No S3 configured"

# Should see:
# [publish] No S3 configured - using resized data URL (234567 bytes)
```

## 💰 Cost Estimates

| Solution | Monthly Cost (1000 images) |
|----------|---------------------------|
| Data URL fallback | Free (800px limit) |
| Cloudflare R2 | ~$0.03 (full quality) |
| AWS S3 | ~$2.30 (full quality) |

## 📚 Documentation

- **Full S3/R2 Setup**: `docs/IMAGE_PUBLISHING.md`
- **Fix Details**: `FIX_SUMMARY.md`
- **This Checklist**: `DEPLOYMENT_CHECKLIST.md`

## ⚠️ Known Limitations

### With Data URL Fallback (No S3):
- Images limited to 800px max dimension
- Still high quality (WebP 85%), but not full resolution
- Warning logged for each image

### With S3/R2 Configured:
- Full resolution preserved
- Faster loading (no base64 overhead)
- Better scalability
- Small monthly cost

## 🎯 Success Criteria

- [ ] Worker deploys successfully
- [ ] Can upload and enhance images
- [ ] Results display in UI
- [ ] No HTTP errors in server logs
- [ ] No out-of-memory errors

## 🐛 Troubleshooting

### If images still don't show:
1. Check Railway worker logs for errors
2. Check browser console for network errors
3. Verify job completes: `GET /api/status/job_<id>`
4. Check if `resultUrl` is present in response

### If build fails:
1. Verify all files committed
2. Check Railway build logs
3. Ensure Docker build works locally first

### If S3 not working:
1. Verify environment variables set correctly
2. Check IAM/R2 permissions
3. Test bucket access with AWS CLI
4. Check worker logs for S3 upload errors
