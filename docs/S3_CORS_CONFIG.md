# S3 CORS Configuration for RealEnhance

## Problem
Enhanced images upload successfully to S3 and URLs are generated, but the browser cannot load them in the React app due to CORS (Cross-Origin Resource Sharing) restrictions.

## Symptoms
- ✅ Worker logs show successful S3 upload with ETag
- ✅ Opening S3 URL directly in browser works
- ❌ Browser console shows CORS error when app tries to load image
- ❌ Image placeholders appear briefly then disappear

## Solution

### Option 1: AWS Console (Recommended)

1. **Navigate to S3 bucket:**
   - Open AWS Console → S3
   - Find your `realenhance-images-v2` bucket
   - Click on the bucket name

2. **Edit CORS configuration:**
   - Go to "Permissions" tab
   - Scroll to "Cross-origin resource sharing (CORS)"
   - Click "Edit"

3. **Paste this configuration:**

```json
[
  {
    "AllowedHeaders": [
      "*"
    ],
    "AllowedMethods": [
      "GET",
      "HEAD"
    ],
    "AllowedOrigins": [
      "*"
    ],
    "ExposeHeaders": [
      "ETag",
      "Content-Length",
      "Content-Type"
    ],
    "MaxAgeSeconds": 3600
  }
]
```

4. **Click "Save changes"**

### Option 2: AWS CLI

```bash
# Create a file named cors.json with the configuration above, then:
aws s3api put-bucket-cors \
  --bucket realenhance-images-v2 \
  --cors-configuration file://cors.json
```

### Option 3: Production-Ready CORS (More Restrictive)

For production, replace `"*"` with your actual domains:

```json
[
  {
    "AllowedHeaders": [
      "*"
    ],
    "AllowedMethods": [
      "GET",
      "HEAD"
    ],
    "AllowedOrigins": [
      "https://your-production-domain.com",
      "https://your-staging-domain.com",
      "http://localhost:5173"
    ],
    "ExposeHeaders": [
      "ETag",
      "Content-Length",
      "Content-Type"
    ],
    "MaxAgeSeconds": 3600
  }
]
```

## Verification

### Test from browser console:

```javascript
fetch('YOUR_S3_IMAGE_URL')
  .then(r => console.log('✅ CORS OK:', r.status))
  .catch(e => console.error('❌ CORS blocked:', e));
```

### Test from terminal:

```bash
curl -I -H "Origin: http://localhost:5173" \
  "YOUR_S3_IMAGE_URL" | grep -i "access-control"
```

Should output:
```
access-control-allow-origin: *
access-control-allow-methods: GET, HEAD
access-control-expose-headers: ETag, Content-Length, Content-Type
```

## Important Notes

1. **AllowedOrigins: "*"** allows any website to load your images
   - Use this for development/testing
   - Replace with specific domains for production

2. **AllowedMethods** only includes GET and HEAD
   - No write operations allowed from browser
   - Worker uses AWS SDK directly (not subject to CORS)

3. **Changes take effect immediately**
   - No need to restart services
   - May need to clear browser cache

4. **Alternative: CloudFront**
   - For better performance, put CloudFront CDN in front of S3
   - CloudFront can add CORS headers via response headers policy
   - Reduces S3 bandwidth costs

## Related Issues

If CORS is correctly configured but images still don't load:

1. **Check bucket policy** - ensure objects are publicly readable:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "PublicReadGetObject",
         "Effect": "Allow",
         "Principal": "*",
         "Action": "s3:GetObject",
         "Resource": "arn:aws:s3:::realenhance-images-v2/*"
       }
     ]
   }
   ```

2. **Check ACLs** - if using ACLs, objects need `public-read` ACL

3. **Check bucket encryption** - ensure SSE-S3 (not SSE-KMS with custom key)

4. **Test direct access** - open S3 URL in incognito window to bypass cache
