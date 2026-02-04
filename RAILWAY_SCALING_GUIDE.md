# Railway Worker Scaling Configuration

## Overview
This document explains how to scale the RealEnhance worker horizontally using Railway replicas for high-concurrency image processing.

---

## Current Configuration

### Single Worker
- **Concurrency per worker**: 2 images
- **Total capacity**: 2 concurrent images
- **Memory**: ~2-4GB per worker
- **CPU**: 2-4 vCPU

### Limitations
- With 50 users uploading 10 images each = 500 images
- Single worker at concurrency=2 would take ~42 hours (500 ÷ 2 ÷ 6 images/hr)

---

## Horizontal Scaling with Railway

### Architecture
```
                    ┌──────────────┐
                    │  Redis Queue │
                    │   (BullMQ)   │
                    └──────┬───────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
   ┌────▼─────┐      ┌────▼─────┐      ┌────▼─────┐
   │ Worker 1 │      │ Worker 2 │  ... │ Worker N │
   │ (conc=2) │      │ (conc=2) │      │ (conc=2) │
   └──────────┘      └──────────┘      └──────────┘
```

**Key Points:**
- All workers connect to **same Redis instance**
- Each worker pulls jobs from **shared BullMQ queue**
- No coordination needed - BullMQ handles distribution
- Workers are **stateless** - can scale up/down dynamically

---

## Railway Plans & Scaling

### Hobby Plan (Current)
- **Max replicas**: 6 workers
- **Total concurrency**: 6 × 2 = **12 images**
- **Cost**: $5/month
- **Use case**: Development, low-volume testing

**Time to process 500 images:**
- 500 images ÷ 12 concurrent = ~42 batches
- ~3 minutes per batch = **~2 hours total**

### Pro Plan (Recommended for Production)
- **Max replicas**: 10-50 workers (configurable)
- **Total concurrency**: 50 × 2 = **100 images**
- **Cost**: $20-100/month (based on usage)
- **Use case**: Production with 50+ concurrent users

**Time to process 500 images:**
- 500 images ÷ 100 concurrent = 5 batches
- ~3 minutes per batch = **~15 minutes total**

---

## Configuration Steps

### 1. Railway Project Setup

**Environment Variables** (shared across all replicas):
```bash
# Redis connection (shared queue)
REDIS_URL=redis://redis.railway.internal:6379
REDIS_PRIVATE_URL=redis://...

# Worker configuration
WORKER_CONCURRENCY=2          # Per-worker concurrency
NODE_ENV=production

# Memory optimization
NODE_OPTIONS=--max-old-space-size=8192  # 8GB heap

# AI APIs
GEMINI_API_KEY=your_key
STABILITY_API_KEY=your_key    # Optional

# S3 storage
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=ap-southeast-2
S3_BUCKET=...
```

### 2. Worker Service Configuration

**railway.json** (in `/worker` directory):
```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS",
    "buildCommand": "pnpm install && pnpm run build"
  },
  "deploy": {
    "startCommand": "node dist/worker.js",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 300,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

### 3. Resource Allocation

**Per Worker Replica:**
```
CPU: 4-8 vCPU (recommended 8 for image processing)
Memory: 8 GB RAM (recommended minimum)
Disk: 10 GB (for temp files)
```

**Rationale:**
- Each image at 4K = ~50MB in memory
- Concurrency=2 = 100MB for images
- Sharp processing overhead = ~200MB
- Node.js heap + buffers = ~300MB
- **Total: ~600MB per concurrent job × 2 = 1.2GB minimum**
- **8GB provides comfortable headroom + OS overhead**

### 4. Enable Horizontal Scaling

**Via Railway Dashboard:**
1. Navigate to worker service
2. Go to "Settings" → "Scaling"
3. Set "Replicas" to desired count:
   - **Hobby Plan**: 1-6 replicas
   - **Pro Plan**: 1-50 replicas

**Via Railway CLI:**
```bash
railway up --replicas 6  # Hobby plan max
railway up --replicas 20 # Pro plan
```

### 5. Auto-Scaling (Pro Plan Only)

```json
{
  "autoscaling": {
    "enabled": true,
    "minReplicas": 2,
    "maxReplicas": 20,
    "targetCPUUtilization": 70,
    "targetMemoryUtilization": 80
  }
}
```

**Behavior:**
- Scales up when CPU > 70% or Memory > 80%
- Scales down when utilization drops
- Maintains 2-20 replicas based on load

---

## Monitoring & Observability

### Health Check Endpoint

Add to worker:
```typescript
// worker/src/health.ts
import express from 'express';
import { getMemoryStats } from './utils/memory-monitor';

const app = express();

app.get('/health', (req, res) => {
  const memory = getMemoryStats();
  res.json({
    status: 'healthy',
    memory,
    uptime: process.uptime(),
    workerConcurrency: process.env.WORKER_CONCURRENCY || 2
  });
});

app.listen(3001, () => {
  console.log('[Health] Endpoint listening on :3001');
});
```

### Logs & Metrics

**Railway Dashboard** shows per-replica:
- CPU usage %
- Memory usage (MB)
- Network I/O
- Logs (stdout/stderr)

**Key Metrics to Watch:**
- **Queue depth**: Should stay < 100 jobs
- **Memory per worker**: Should stay < 80% of allocated
- **Job completion rate**: Images/minute
- **Failed job rate**: Should be < 1%

---

## Cost Estimation

### Hobby Plan ($5/month)
```
6 workers × $0 (included) = $0 compute
Redis managed = $5
Total: $5/month
Capacity: 12 concurrent images
```

### Pro Plan (Example: 20 workers)
```
20 workers × 8GB × $0.00001/GB/min = ~$200/month compute
Redis managed = $10/month
Total: $210/month
Capacity: 40 concurrent images
Peak throughput: ~480 images/hour
```

**Break-even Analysis:**
- 50 users × 10 images = 500 images processed in 15 minutes
- Cost per image: $210/month ÷ 50,000 images = **$0.0042/image**
- Competitive with cloud function costs (AWS Lambda: $0.005-0.01/image)

---

## Optimization Tips

### 1. Queue Priorities
```typescript
// High-paying customers get priority
await enhanceQueue.add('enhance', payload, {
  priority: user.plan === 'enterprise' ? 1 : 2
});
```

### 2. Rate Limiting Per User
```typescript
// Limit concurrent jobs per user to prevent monopolization
const userJobCount = await redis.get(`user:${userId}:active_jobs`);
if (userJobCount > 10) {
  throw new Error('Too many concurrent jobs');
}
```

### 3. Memory-Based Scaling
```typescript
// In worker, trigger scale-up signal if memory critical
if (isMemoryCritical()) {
  await redis.publish('worker:scale', JSON.stringify({
    action: 'scale_up',
    reason: 'high_memory',
    currentReplicas: process.env.RAILWAY_REPLICA_ID
  }));
}
```

### 4. Batch Prioritization
```typescript
// Small batches (1-5 images) get priority over large batches
const priority = payload.batchTotal <= 5 ? 1 : 2;
```

---

## Deployment Checklist

- [ ] Set all environment variables in Railway dashboard
- [ ] Configure worker concurrency (WORKER_CONCURRENCY=2)
- [ ] Set memory limit (NODE_OPTIONS=--max-old-space-size=8192)
- [ ] Enable health check endpoint
- [ ] Set replica count (start with 2-4)
- [ ] Configure auto-scaling thresholds (Pro plan)
- [ ] Set up monitoring/alerting
- [ ] Test with load (10 concurrent users)
- [ ] Monitor queue depth and memory usage
- [ ] Adjust replicas based on actual usage

---

## Troubleshooting

### Issue: Workers not picking up jobs
**Solution:** Check Redis connection:
```bash
railway run printenv | grep REDIS_URL
```

### Issue: High memory usage
**Solution:** Reduce WORKER_CONCURRENCY to 1:
```bash
railway variables --set WORKER_CONCURRENCY=1
```

### Issue: Jobs failing with timeout
**Solution:** Increase health check timeout:
```json
{
  "deploy": {
    "healthcheckTimeout": 600
  }
}
```

### Issue: Uneven load distribution
**Solution:** BullMQ handles this automatically. If issues persist:
1. Check all workers are connected to same Redis instance
2. Verify no worker is stuck (restart problematic replica)
3. Check queue priorities aren't causing starvation

---

## Summary

**Recommended Production Setup:**
- **Plan**: Railway Pro ($20-100/month)
- **Replicas**: 10-20 workers (auto-scale)
- **Per-worker**: 8GB RAM, 8 vCPU, concurrency=2
- **Total capacity**: 20-40 concurrent images
- **Throughput**: ~240-480 images/hour
- **Handles**: 50-100 concurrent users comfortably

**Scaling Path:**
1. Start: 2 workers (4 concurrent images)
2. Growth: 6 workers (12 concurrent - Hobby max)
3. Production: 20 workers (40 concurrent - Pro plan)
4. Enterprise: 50+ workers (100+ concurrent - Custom plan)
