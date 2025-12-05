# OpenCV Validator Deployment Guide

## Quick Start

### 1. Deploy to Railway

```bash
# From project root
cd opencv-validator

# Create new Railway project (one-time)
railway login
railway init

# Deploy
railway up
```

Railway will:
- Auto-detect the Dockerfile
- Build the Python image
- Deploy to a public URL
- Provide a URL like: `https://opencv-validator-production-abc123.up.railway.app`

### 2. Configure Worker

Add to worker's environment variables (`.env` or deployment platform):

```bash
STRUCTURE_VALIDATOR_URL=https://your-railway-url.up.railway.app
STRUCTURE_VALIDATOR_MODE=log
STRUCTURE_VALIDATOR_SENSITIVITY=5.0
```

### 3. Test

```bash
# Health check
curl https://your-railway-url.up.railway.app/health

# Test validation (replace URLs with real S3 URLs)
curl -X POST https://your-railway-url.up.railway.app/validate-structure \
  -H "Content-Type: application/json" \
  -d '{
    "originalUrl": "https://s3.amazonaws.com/.../original.jpg",
    "enhancedUrl": "https://s3.amazonaws.com/.../enhanced.jpg"
  }'
```

## Alternative Deployment Options

### Docker (Self-hosted)

```bash
# Build
docker build -t opencv-validator .

# Run
docker run -d \
  -p 8000:8000 \
  --name opencv-validator \
  opencv-validator

# Check logs
docker logs opencv-validator
```

### Heroku

```bash
# Create app
heroku create opencv-validator-yourname

# Deploy
git subtree push --prefix opencv-validator heroku main

# Or using Dockerfile
heroku stack:set container
git push heroku main
```

### AWS ECS / Fargate

1. Push image to ECR:
```bash
aws ecr create-repository --repository-name opencv-validator
docker tag opencv-validator:latest <account>.dkr.ecr.us-east-1.amazonaws.com/opencv-validator:latest
docker push <account>.dkr.ecr.us-east-1.amazonaws.com/opencv-validator:latest
```

2. Create ECS service with:
   - Task definition using ECR image
   - ALB with health check `/health`
   - Auto-scaling if needed

### Google Cloud Run

```bash
# Build and push
gcloud builds submit --tag gcr.io/PROJECT_ID/opencv-validator

# Deploy
gcloud run deploy opencv-validator \
  --image gcr.io/PROJECT_ID/opencv-validator \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated
```

## Environment Configuration

### Required (Railway)
None - Railway auto-detects `PORT`

### Optional
```bash
LOG_LEVEL=INFO  # DEBUG, INFO, WARNING, ERROR
```

## Monitoring

### Health Check
```bash
curl https://your-service-url/health
# Expected: {"status": "healthy"}
```

### API Docs
Visit: `https://your-service-url/docs`

Interactive Swagger UI for testing

### Logs

**Railway:**
- View in Railway dashboard
- Or: `railway logs`

**Docker:**
```bash
docker logs -f opencv-validator
```

## Scaling

### Railway
- Auto-scales based on traffic
- Default: 1 instance, scales to 10
- Configure in Railway dashboard

### Docker/ECS
- Run multiple containers behind load balancer
- Recommended: 2-4 instances for production

### Performance
- Average response time: 200-500ms
- Throughput: ~10-20 requests/second per instance
- Memory: ~200MB per instance
- CPU: 1 vCPU recommended

## Security

### Network
- Service should be publicly accessible (reads from S3)
- No authentication required (internal service)
- Consider VPC if deploying to AWS/GCP

### CORS
Not needed - service is HTTP API, not browser-accessed

### Rate Limiting
Consider adding rate limiting if exposed publicly:
```python
# Add to app.py
from slowapi import Limiter
limiter = Limiter(key_func=lambda: request.client.host)

@app.post("/validate-structure")
@limiter.limit("10/minute")
async def validate_structure(...):
    ...
```

## Troubleshooting

### Container won't start
```bash
# Check logs
docker logs opencv-validator

# Common issues:
# - Port already in use: Change -p 8000:8000 to -p 8001:8000
# - Missing dependencies: Rebuild image
```

### Out of memory
```bash
# Increase Docker memory limit
docker run -m 1g opencv-validator

# Or on Railway: Increase plan tier
```

### Slow responses
- Check image sizes (should be < 5MB)
- Ensure deployed in same region as worker
- Scale horizontally (add more instances)

## Cost Estimates

### Railway
- Hobby Plan: $5/month (512MB RAM, 1 vCPU)
- Starter Plan: $20/month (8GB RAM, 8 vCPUs)
- Recommended: Starter Plan for production

### AWS Fargate
- ~$15/month (0.25 vCPU, 0.5GB RAM, always on)
- ~$30/month (0.5 vCPU, 1GB RAM, always on)

### Google Cloud Run
- Free tier: 2M requests/month
- Beyond: ~$0.40 per 1M requests
- Recommended: Very cost-effective for variable traffic

## Maintenance

### Updates
```bash
# Pull latest code
git pull

# Rebuild
docker build -t opencv-validator .

# Redeploy
railway up  # or your deployment method
```

### Dependencies
Update `requirements.txt` periodically:
```bash
pip install --upgrade opencv-python-headless fastapi uvicorn
pip freeze > requirements.txt
```

### Monitoring
Set up alerts for:
- Service downtime (health check fails)
- High error rate (500 responses)
- Slow responses (>2 seconds)
