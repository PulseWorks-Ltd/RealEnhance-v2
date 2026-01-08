# Auto Failure Analysis Feature

## Overview

The Auto Failure Analysis feature uses the Gemini API to automatically analyze failed or degraded enhancement jobs. When a job fails validation, the system collects validator logs, job metadata, and before/after images, sends them to Gemini, and receives a structured diagnosis with actionable recommendations.

**Key Features:**
- 🤖 **Automatic Analysis** - Triggered automatically when jobs fail (configurable)
- 📊 **Structured Output** - JSON schema with primary issue, evidence, assessment, and recommendations
- 🔒 **Admin-Only** - Internal tool, not customer-facing
- 🎯 **Actionable** - Provides specific recommendations for fixes
- 🖼️ **Image Analysis** - Includes before/after images for visual comparison
- 📝 **Audit Trail** - Stores all analysis results with full history

---

## Architecture

### Components

1. **Storage** (`shared/src/analysis/storage.ts`)
   - File-based storage for analysis results
   - Functions: `createAnalysis`, `completeAnalysis`, `failAnalysis`, `getLatestAnalysisForJob`

2. **Gemini Service** (`server/src/services/geminiAnalysis.ts`)
   - Gemini API integration
   - Prompt template with strict JSON output schema
   - Image fetching and base64 conversion
   - Sensitive data redaction

3. **Data Packager** (`server/src/services/analysisDataPackager.ts`)
   - Collects job data, validator results, logs, and image URLs
   - Generates pre-signed S3 URLs for image access
   - Extracts relevant metadata

4. **Orchestrator** (`server/src/services/analysisOrchestrator.ts`)
   - Main entry point for running analysis
   - Handles auto-trigger logic
   - Manages idempotency

5. **Admin API** (`server/src/routes/adminAnalysis.ts`)
   - REST endpoints for manual triggers and retrieval
   - Rate limiting and authentication
   - Admin-only access control

---

## Setup

### 1. Get Gemini API Key

1. Visit [Google AI Studio](https://aistudio.google.com/apikey)
2. Create a new API key
3. Copy the key

### 2. Configure Environment Variables

Add to `server/.env`:

```bash
# Gemini API for Auto Failure Analysis
GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE
GEMINI_MODEL_ANALYSIS=gemini-2.0-flash-exp
ANALYSIS_ENABLED=true
ANALYSIS_RUN_ON_FAILURE=true
ANALYSIS_MAX_IMAGES=3
ANALYSIS_TIMEOUT_MS=30000
ANALYSIS_REDACT=true
```

**Environment Variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | (required) | Your Gemini API key |
| `GEMINI_MODEL_ANALYSIS` | `gemini-2.0-flash-exp` | Gemini model to use |
| `ANALYSIS_ENABLED` | `true` | Enable/disable analysis feature |
| `ANALYSIS_RUN_ON_FAILURE` | `true` | Auto-trigger on job failure |
| `ANALYSIS_MAX_IMAGES` | `3` | Max images to send to Gemini |
| `ANALYSIS_TIMEOUT_MS` | `30000` | API timeout in milliseconds |
| `ANALYSIS_REDACT` | `true` | Redact sensitive data from logs |

### 3. Install Dependencies

The Gemini SDK is already installed via:
```bash
pnpm add @google/generative-ai --filter @realenhance/server
```

### 4. Build Shared Package

```bash
pnpm --filter @realenhance/shared run build
```

---

## Usage

### Automatic Trigger

When `ANALYSIS_RUN_ON_FAILURE=true`, analysis automatically runs when a job reaches `FAILED` or `DEGRADED` status.

**Idempotency:** Won't create duplicate analyses if one already exists within 1 hour.

### Manual Trigger (Admin Only)

**API Endpoint:**
```bash
POST /api/admin/jobs/:jobId/analysis/run
```

**Example:**
```bash
curl -X POST http://localhost:5000/api/admin/jobs/job_123/analysis/run \
  -H "Cookie: realsess=..." \
  -H "Content-Type: application/json"
```

**Response:**
```json
{
  "analysis": {
    "id": "analysis_uuid",
    "jobId": "job_123",
    "status": "COMPLETE",
    "trigger": "MANUAL",
    "model": "gemini-2.0-flash-exp",
    "createdAt": "2026-01-08T08:00:00.000Z",
    "completedAt": "2026-01-08T08:00:15.000Z",
    "promptVersion": "analysis-v1",
    "inputSummary": { ... },
    "output": { ... }
  }
}
```

---

## API Endpoints

### POST /api/admin/jobs/:jobId/analysis/run
**Auth:** Required (Admin only)
**Rate Limit:** 10 requests/minute per user
**Description:** Manually trigger analysis for a job

**Response:** Analysis object

---

### GET /api/admin/jobs/:jobId/analysis/latest
**Auth:** Required (Admin only)
**Description:** Get latest analysis for a job

**Response:**
```json
{
  "analysis": { ... }
}
```

**Status Codes:**
- `200` - Success
- `404` - No analysis found
- `401` - Not authenticated
- `403` - Not admin

---

### GET /api/admin/jobs/:jobId/analysis/history
**Auth:** Required (Admin only)
**Description:** Get all analyses for a job (sorted newest first)

**Response:**
```json
{
  "analyses": [ ... ]
}
```

---

### GET /api/admin/analysis/recent
**Auth:** Required (Admin only)
**Query Params:** `limit` (default: 50)
**Description:** Get recent analyses across all jobs

---

### GET /api/admin/analysis/:analysisId
**Auth:** Required (Admin only)
**Description:** Get specific analysis by ID

---

### GET /api/admin/analysis/config
**Auth:** Required (Admin only)
**Description:** Get current analysis configuration

**Response:**
```json
{
  "config": {
    "enabled": true,
    "configured": true,
    "model": "gemini-2.0-flash-exp",
    "promptVersion": "analysis-v1",
    "maxImages": 3,
    "timeoutMs": 30000,
    "redact": true,
    "autoTrigger": true
  }
}
```

---

## Output Schema

Gemini returns structured JSON with this schema:

```typescript
{
  "job_summary": {
    "stages_run": ["1A", "1B", "2"],
    "final_outcome": "PASS" | "FAIL" | "DEGRADED"
  },
  "primary_issue": "string (one sentence)",
  "supporting_evidence": [
    "Evidence point 1",
    "Evidence point 2"
  ],
  "assessment": {
    "classification": "REAL_IMAGE_ISSUE" | "SYSTEM_ISSUE" | "MIXED" | "INSUFFICIENT_EVIDENCE",
    "confidence": "LOW" | "MEDIUM" | "HIGH",
    "notes": "Additional context"
  },
  "recommended_actions": {
    "prompt_changes": [
      "Specific prompt adjustment suggestions"
    ],
    "validator_adjustments": [
      "Validator threshold or logic changes"
    ],
    "pipeline_logic_changes": [
      "Workflow improvements"
    ],
    "model_changes": [
      "Model selection or tuning suggestions"
    ]
  },
  "do_not_recommend": [
    "Actions to avoid"
  ]
}
```

### Classification Types

- **REAL_IMAGE_ISSUE** - Low quality source, extreme lighting, corrupted file, unsupported content
- **SYSTEM_ISSUE** - Model hallucination, validator bug, pipeline error, resource timeout
- **MIXED** - Both real image problems AND system issues
- **INSUFFICIENT_EVIDENCE** - Not enough data to determine root cause

---

## Testing

### Test on a Failed Job

1. **Find a failed job ID:**
   ```bash
   # Check job_analysis.json for recent failures
   cat server/data/jobs.json | grep -A 20 "FAILED"
   ```

2. **Manually trigger analysis:**
   ```bash
   curl -X POST http://localhost:5000/api/admin/jobs/{JOB_ID}/analysis/run \
     -H "Cookie: realsess=YOUR_SESSION_COOKIE" \
     -H "Content-Type: application/json"
   ```

3. **Check the result:**
   ```bash
   curl http://localhost:5000/api/admin/jobs/{JOB_ID}/analysis/latest \
     -H "Cookie: realsess=YOUR_SESSION_COOKIE"
   ```

4. **View in database:**
   ```bash
   cat server/data/job_analysis.json | jq '.'
   ```

### Test Auto-Trigger

1. **Ensure settings:**
   ```bash
   ANALYSIS_ENABLED=true
   ANALYSIS_RUN_ON_FAILURE=true
   ```

2. **Create a job that will fail** (e.g., upload corrupted image)

3. **Wait for job to complete and fail**

4. **Check if analysis was created:**
   ```bash
   cat server/data/job_analysis.json | jq '.[] | select(.trigger=="AUTO_ON_FAIL")'
   ```

---

## Security

### Authentication
- All endpoints require authenticated session
- Admin role required (`owner` or `admin`)
- JWT-based session validation

### Rate Limiting
- **Manual triggers:** 10 requests/minute per user
- In-memory rate limiting (for production, use Redis)
- 429 status code when limit exceeded

### Data Redaction
When `ANALYSIS_REDACT=true`:
- API keys, tokens, secrets are redacted
- AWS credentials are masked
- Pre-signed URLs have 1-hour expiry
- Full URLs not stored long-term, only S3 keys

### Access Control
```typescript
requireAuth(req, res, next)  // Must be logged in
requireAdmin(req, res, next) // Must have admin role
rateLimit(req, res, next)    // Rate limiting
```

---

## Data Storage

**File:** `server/data/job_analysis.json`

**Structure:**
```json
{
  "analysis_uuid_1": {
    "id": "analysis_uuid_1",
    "jobId": "job_123",
    "status": "COMPLETE",
    "trigger": "MANUAL",
    "model": "gemini-2.0-flash-exp",
    "createdAt": "2026-01-08T08:00:00.000Z",
    "completedAt": "2026-01-08T08:00:15.000Z",
    "promptVersion": "analysis-v1",
    "inputSummary": { ... },
    "output": { ... },
    "rawText": "Full AI response...",
    "error": null
  }
}
```

**Retention:** No automatic cleanup (consider implementing later)

---

## Troubleshooting

### Issue: "Analysis feature not enabled or configured"

**Cause:** Missing or invalid `GEMINI_API_KEY`

**Fix:**
```bash
# Check environment
echo $GEMINI_API_KEY

# Should output your key, not "YOUR_GEMINI_API_KEY_HERE"
# Add to .env if missing
```

---

### Issue: "Failed to parse AI response"

**Cause:** Gemini returned invalid JSON or didn't follow schema

**Fix:**
- Check `rawText` field in failed analysis
- Verify prompt version is up to date
- May need to adjust temperature or model parameters

---

### Issue: "Analysis timeout after 30000ms"

**Cause:** Gemini API taking too long

**Fix:**
```bash
# Increase timeout
ANALYSIS_TIMEOUT_MS=60000

# Or reduce max images
ANALYSIS_MAX_IMAGES=2
```

---

### Issue: "Failed to fetch image"

**Cause:** S3 URLs expired or inaccessible

**Fix:**
- Check S3 configuration
- Verify pre-signed URL generation
- Images should be accessible for 1 hour

---

## Future Enhancements

- [ ] Admin UI panel for viewing analyses
- [ ] Batch analysis for multiple jobs
- [ ] Analysis dashboard with trends
- [ ] Export analyses to CSV/PDF
- [ ] Webhook notifications for high-confidence issues
- [ ] Integration with error tracking systems
- [ ] Automatic ticket creation for system issues
- [ ] Analysis result caching and deduplication
- [ ] Support for custom prompt templates
- [ ] A/B testing of different models

---

## Files Changed

### New Files Created:
1. `shared/src/analysis/types.ts` - TypeScript types
2. `shared/src/analysis/storage.ts` - Database operations
3. `server/src/services/geminiAnalysis.ts` - Gemini API service
4. `server/src/services/analysisDataPackager.ts` - Data collection
5. `server/src/services/analysisOrchestrator.ts` - Orchestration logic
6. `server/src/routes/adminAnalysis.ts` - API endpoints
7. `AUTO_FAILURE_ANALYSIS.md` - This documentation

### Modified Files:
1. `server/src/index.ts` - Added admin analysis router
2. `server/.env` - Added Gemini environment variables
3. `server/package.json` - Added @google/generative-ai dependency

### New Data File:
- `server/data/job_analysis.json` - Stores analysis results

---

## Cost Considerations

**Gemini API Pricing (as of Jan 2026):**
- Gemini 2.0 Flash: Very low cost per request
- Text input: ~$0.00001 per 1K characters
- Image input: ~$0.0001 per image
- Text output: ~$0.00003 per 1K characters

**Typical Analysis Cost:**
- ~3 images + logs: ~$0.0005 per analysis
- 100 analyses/day: ~$0.05/day = ~$1.50/month

**Recommendations:**
- Use `gemini-2.0-flash-exp` for cost efficiency
- Set `ANALYSIS_MAX_IMAGES=2` to reduce image costs
- Only enable auto-trigger in production if needed
- Monitor usage in Google Cloud Console

---

## Support

For issues or questions:
1. Check this documentation
2. Review error logs in `server/data/job_analysis.json`
3. Check Gemini API status
4. Verify environment configuration

---

**Last Updated:** January 8, 2026
**Prompt Version:** analysis-v1
**Default Model:** gemini-2.0-flash-exp
