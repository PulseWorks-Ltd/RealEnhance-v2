# Auto Failure Analysis - Quick Start Guide

## 🚀 Get Started in 5 Minutes

This guide will get the Auto Failure Analysis feature running on your system.

---

## Step 1: Get Gemini API Key (2 minutes)

1. Visit [Google AI Studio](https://aistudio.google.com/apikey)
2. Click "Create API Key"
3. Copy the key (starts with `AI...`)

---

## Step 2: Configure Environment (1 minute)

Open `server/.env` and add your API key:

```bash
# Replace YOUR_GEMINI_API_KEY_HERE with your actual key
GEMINI_API_KEY=AIza...your_key_here
```

The other analysis settings are already configured with sensible defaults:
```bash
GEMINI_MODEL_ANALYSIS=gemini-2.0-flash-exp
ANALYSIS_ENABLED=true
ANALYSIS_RUN_ON_FAILURE=true
ANALYSIS_MAX_IMAGES=3
ANALYSIS_TIMEOUT_MS=30000
ANALYSIS_REDACT=true
```

---

## Step 3: Build & Start (2 minutes)

```bash
# Build shared package (includes analysis types)
pnpm --filter @realenhance/shared run build

# Start Redis (if not already running)
redis-server --daemonize yes

# Start server
cd server && npm run dev
```

---

## Step 4: Test It!

### Find a Failed Job

```bash
# List failed jobs
cat server/data/jobs.json | grep -B 5 "FAILED" | grep jobId
```

### Run Analysis

```bash
# Use the test script
npx tsx server/scripts/test-analysis.ts job_YOUR_JOB_ID_HERE
```

**Example Output:**
```
🧪 Testing Auto Failure Analysis Feature

1️⃣  Checking configuration...
   Config: {
     "enabled": true,
     "configured": true,
     ...
   }
✅ Configuration OK

2️⃣  Running analysis for job: job_123

🤖 Calling Gemini API...
✅ Analysis completed in 8.43s

📊 Analysis Results:

============================================================
PRIMARY ISSUE:
============================================================
Stage 1B declutter removed excessive structural elements

============================================================
ASSESSMENT:
============================================================
Classification: SYSTEM_ISSUE
Confidence: HIGH
Notes: Declutter intensity appears too aggressive for this image type

============================================================
RECOMMENDED ACTIONS:
============================================================

Prompt Changes:
  1. Reduce declutter intensity from 'heavy' to 'standard'
  2. Add explicit instruction to preserve walls and windows

Validator Adjustments:
  1. Lower line-edge validator threshold from 0.8 to 0.6
  2. Add structural element detection before declutter

...
```

---

## 🎯 What Just Happened?

1. ✅ Script connected to Gemini API
2. ✅ Collected job data, validator logs, and images
3. ✅ Sent to Gemini for analysis
4. ✅ Received structured diagnosis
5. ✅ Saved to `server/data/job_analysis.json`

---

## 💡 Using via API

### Manual Trigger (Admin Only)

```bash
curl -X POST http://localhost:5000/api/admin/jobs/job_123/analysis/run \
  -H "Cookie: realsess=YOUR_SESSION_COOKIE" \
  -H "Content-Type: application/json"
```

### Get Latest Analysis

```bash
curl http://localhost:5000/api/admin/jobs/job_123/analysis/latest \
  -H "Cookie: realsess=YOUR_SESSION_COOKIE"
```

---

## 🤖 Auto-Trigger

Analysis automatically runs when jobs fail if `ANALYSIS_RUN_ON_FAILURE=true` (default).

**How it works:**
1. Job completes with `FAILED` or `DEGRADED` status
2. System checks if analysis already exists
3. If not, triggers analysis in background
4. Result saved to database
5. Accessible via API

**To enable in your code:**
```typescript
import { autoTriggerAnalysisOnFailure } from "./services/analysisOrchestrator.js";

// After job completion
if (job.status === "FAILED" || job.status === "DEGRADED") {
  await autoTriggerAnalysisOnFailure(job.jobId, job.status);
}
```

---

## 📊 View Results

### In Database
```bash
cat server/data/job_analysis.json | jq '.'
```

### In UI (Component Ready)
```tsx
import { JobAnalysisPanel } from "@/components/JobAnalysis";

// Add to your job detail page
<JobAnalysisPanel jobId={job.jobId} />
```

---

## 🔧 Troubleshooting

### "Analysis feature not enabled"

**Fix:**
```bash
# Check env var is set
echo $GEMINI_API_KEY

# Should output your key, not "YOUR_GEMINI_API_KEY_HERE"
# If empty, add to .env and restart server
```

### "Failed to parse AI response"

**This is rare but can happen. Fix:**
```bash
# Check the rawText in job_analysis.json
# The AI may have returned markdown instead of pure JSON

# Try with different model:
GEMINI_MODEL_ANALYSIS=gemini-1.5-pro
```

### "Rate limit exceeded"

**Wait 1 minute or increase limit in code:**
```typescript
// server/src/routes/adminAnalysis.ts
const RATE_LIMIT_MAX_REQUESTS = 20; // Increase from 10
```

---

## 📚 Full Documentation

- **Complete Guide:** `AUTO_FAILURE_ANALYSIS.md`
- **Implementation Details:** `ANALYSIS_IMPLEMENTATION_SUMMARY.md`
- **API Reference:** See `AUTO_FAILURE_ANALYSIS.md` API section

---

## ✅ Checklist

- [ ] Got Gemini API key
- [ ] Added to `server/.env`
- [ ] Built shared package
- [ ] Started server
- [ ] Tested with failed job
- [ ] Verified analysis in `job_analysis.json`

---

## 🎉 You're Done!

The Auto Failure Analysis feature is now active and will automatically analyze failed jobs.

**Next Steps:**
- Review analyses to improve your pipeline
- Add UI component to job detail pages
- Customize prompts if needed
- Monitor Gemini API usage

---

**Questions?** Check `AUTO_FAILURE_ANALYSIS.md` for detailed troubleshooting.
