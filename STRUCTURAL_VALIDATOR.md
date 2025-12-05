# OpenCV Structural Validator - Integration Guide

## Overview

The RealEnhance v2.0 structural validator uses **OpenCV** via a **Python microservice** to detect architectural line changes between original and enhanced images. This ensures that real estate photos maintain proper geometry during AI enhancement.

## Architecture

```
┌─────────────┐         ┌──────────────────┐         ┌─────────────────┐
│   Worker    │  HTTP   │  OpenCV Service  │  OpenCV │  Line Detection │
│ (TypeScript)│ ──────► │   (Python)       │ ──────► │  Hough Lines    │
└─────────────┘         └──────────────────┘         └─────────────────┘
```

### Components

1. **Python FastAPI Microservice** (`opencv-validator/`)
   - FastAPI HTTP server
   - OpenCV line detection (Canny + Hough)
   - Structural analysis and scoring

2. **TypeScript Client** (`worker/src/validators/structureValidatorClient.ts`)
   - HTTP client to call Python service
   - Unified validation interface
   - Mode-based blocking logic

3. **Worker Integration** (`worker/src/worker.ts`)
   - Calls validator after publishing final image
   - Handles blocking/logging modes
   - Graceful error handling

## Deployment

### Step 1: Deploy Python Microservice

#### Option A: Railway (Recommended)

1. Create new project on Railway
2. Connect your GitHub repository
3. Set root directory: `opencv-validator`
4. Railway auto-detects `Dockerfile` and deploys
5. Copy the public URL (e.g., `https://opencv-validator-production.up.railway.app`)

#### Option B: Docker

```bash
cd opencv-validator
docker build -t opencv-validator .
docker run -p 8000:8000 opencv-validator
```

#### Option C: Local Development

```bash
cd opencv-validator
pip install -r requirements.txt
python app.py
# Service runs on http://localhost:8000
```

### Step 2: Configure Worker Environment Variables

Add these to your worker's `.env` file or deployment environment:

```bash
# REQUIRED: URL of the OpenCV validator service
STRUCTURE_VALIDATOR_URL=https://opencv-validator-production.up.railway.app

# REQUIRED: Operation mode
# - "off"   = Validator disabled, no checks run
# - "log"   = Run validation, log results, never block images
# - "block" = Run validation, block images if suspicious
STRUCTURE_VALIDATOR_MODE=log

# OPTIONAL: Sensitivity threshold in degrees (default: 5.0)
# Lower = more strict, higher = more permissive
# Recommended: 5.0 for testing, 8.0 for production
STRUCTURE_VALIDATOR_SENSITIVITY=5.0
```

### Step 3: Verify Integration

1. Process a test image through RealEnhance
2. Check worker logs for validation output:

```
[structureValidator] Validating structure (mode=log, sensitivity=5.0°)
[structureValidator] Original: https://s3.amazonaws.com/...
[structureValidator] Enhanced: https://s3.amazonaws.com/...
[structureValidator] Validation complete in 287ms
[structureValidator] Deviation: 2.3° (vertical: 1.2°, horizontal: 1.1°)
[structureValidator] Suspicious: false
[structureValidator] === STRUCTURAL VALIDATION RESULT ===
[structureValidator] Mode: log
[structureValidator] Deviation Score: 2.3°
[structureValidator] Vertical Shift: 1.2°
[structureValidator] Horizontal Shift: 1.1°
[structureValidator] Suspicious: false
[structureValidator] Message: Structural validation passed: 2.30° deviation
[structureValidator] Original lines: 145 total (67 vertical, 52 horizontal)
[structureValidator] Enhanced lines: 142 total (65 vertical, 51 horizontal)
[structureValidator] ✓ Structural validation passed
```

## Operation Modes

### Mode: `off`
- **Behavior**: Validator completely disabled
- **Use case**: Quick testing, bypass validation
- **Logs**: Minimal ("Validator disabled")

### Mode: `log` (Recommended for initial deployment)
- **Behavior**: Run validation, log detailed results, **never block images**
- **Use case**:
  - Initial deployment and tuning
  - Monitoring structural quality without blocking production
  - Collecting baseline metrics
- **Logs**: Full validation details
- **Result**: All images proceed regardless of score

### Mode: `block` (Production after tuning)
- **Behavior**: Run validation, **block suspicious images** from reaching users
- **Use case**: Production enforcement after threshold tuning
- **Logs**: Full validation details + blocking warnings
- **Result**: Suspicious images rejected, job marked as failed

## Validation Algorithm

### 1. Line Detection
- **Canny Edge Detection**: Detects edges with thresholds [60, 150]
- **Hough Line Transform**: Finds straight lines in edge map
  - Min line length: 80 pixels (captures window frames, doors)
  - Max line gap: 10 pixels (tolerates small breaks)

### 2. Line Classification
- **Vertical lines**: 80° ≤ |angle| ≤ 100° (walls, door frames, wardrobes)
- **Horizontal lines**: |angle| ≤ 10° or |angle| ≥ 170° (ceiling, floor, countertops)

### 3. Structural Scoring

```
verticalShift = |avgVerticalEnhanced - avgVerticalOriginal|
horizontalShift = |avgHorizontalEnhanced - avgHorizontalOriginal|
deviationScore = verticalShift + horizontalShift
```

**Interpretation:**
- `deviationScore < 3°`: Excellent preservation
- `3° ≤ deviationScore < 5°`: Good preservation
- `5° ≤ deviationScore < 8°`: Suspicious, may have structural changes
- `deviationScore ≥ 8°`: High likelihood of geometry changes

### 4. Threshold Decision

```python
isSuspicious = deviationScore > sensitivity_threshold
```

Default threshold: **5.0°**

## Tuning Recommendations

### Phase 1: Data Collection (Mode = `log`)
1. Deploy with `STRUCTURE_VALIDATOR_MODE=log`
2. Process 50-100 real images
3. Review logs to understand typical deviation scores
4. Look for patterns:
   - What's the typical score for good images?
   - What's the score for images with obvious problems?

### Phase 2: Threshold Tuning
Based on collected data, adjust sensitivity:

```bash
# More strict (fewer false negatives, more false positives)
STRUCTURE_VALIDATOR_SENSITIVITY=3.0

# Balanced (recommended starting point)
STRUCTURE_VALIDATOR_SENSITIVITY=5.0

# More permissive (fewer false positives, more false negatives)
STRUCTURE_VALIDATOR_SENSITIVITY=8.0
```

### Phase 3: Blocking Mode (Mode = `block`)
1. Once confident in threshold, enable blocking:
   ```bash
   STRUCTURE_VALIDATOR_MODE=block
   ```
2. Monitor closely for first 24 hours
3. Adjust threshold if needed

## Monitoring

### Key Metrics to Track

1. **Deviation Score Distribution**
   - Median, P50, P95, P99
   - Typical range for your image set

2. **Suspicious Rate**
   - % of images flagged as suspicious
   - Target: < 5% in log mode before enabling blocking

3. **False Positive Rate**
   - Images flagged but look correct
   - Review manually and adjust threshold

4. **False Negative Rate**
   - Images with obvious geometry issues but passed
   - May need stricter threshold

### Log Monitoring

Search for these patterns in worker logs:

```bash
# All validation results
grep "\[structureValidator\]"

# Suspicious images (even in log mode)
grep "Suspicious: true"

# Blocked images (only in block mode)
grep "BLOCKING IMAGE"

# Validator errors
grep "structureValidator.*error"
```

## Troubleshooting

### Validator Not Running

**Symptom:** No `[structureValidator]` logs

**Fixes:**
1. Check `STRUCTURE_VALIDATOR_MODE` is set to `log` or `block` (not `off`)
2. Check `STRUCTURE_VALIDATOR_URL` is set
3. Verify OpenCV service is deployed and healthy: `curl https://your-service-url/health`

### All Images Flagged as Suspicious

**Symptom:** Every image shows `Suspicious: true`

**Fixes:**
1. Threshold too low - increase `STRUCTURE_VALIDATOR_SENSITIVITY` to 8.0 or 10.0
2. Review actual deviation scores - if all scores are legitimately high, there may be a systematic issue with image processing

### Validator Service Errors

**Symptom:** Logs show "Validation service unreachable"

**Fixes:**
1. Check OpenCV service is running: `curl https://your-service-url/health`
2. Check network connectivity from worker to service
3. Check Railway deployment logs for Python service errors
4. Verify image URLs are publicly accessible

### High Latency

**Symptom:** Validation takes > 2 seconds

**Fixes:**
1. Ensure OpenCV service is deployed in same region as worker
2. Check image sizes - very large images (>4K) may be slow
3. Consider scaling up OpenCV service (more CPU/memory)
4. Check Railway deployment resources

## API Reference

### POST /validate-structure

**Request:**
```json
{
  "originalUrl": "https://s3.amazonaws.com/.../original.jpg",
  "enhancedUrl": "https://s3.amazonaws.com/.../enhanced.jpg",
  "sensitivity": 5.0
}
```

**Response:**
```json
{
  "original": {
    "count": 145,
    "verticalCount": 67,
    "horizontalCount": 52,
    "verticalAngles": [89.2, 90.1, 88.7, ...],
    "horizontalAngles": [1.2, 0.8, 179.3, ...],
    "avgVerticalAngle": 89.3,
    "avgHorizontalAngle": 1.2
  },
  "enhanced": {
    "count": 142,
    "verticalCount": 65,
    "horizontalCount": 51,
    "verticalAngles": [89.1, 89.9, 88.5, ...],
    "horizontalAngles": [1.5, 1.1, 179.1, ...],
    "avgVerticalAngle": 89.1,
    "avgHorizontalAngle": 1.5
  },
  "verticalShift": 0.2,
  "horizontalShift": 0.3,
  "deviationScore": 0.5,
  "isSuspicious": false,
  "message": "Structural validation passed: 0.50° deviation"
}
```

## Environment Variables Reference

### Worker Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STRUCTURE_VALIDATOR_URL` | Yes | - | URL of OpenCV validator service |
| `STRUCTURE_VALIDATOR_MODE` | Yes | `log` | Operation mode: `off`, `log`, or `block` |
| `STRUCTURE_VALIDATOR_SENSITIVITY` | No | `5.0` | Deviation threshold in degrees |

### OpenCV Service Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `8000` | HTTP server port (Railway overrides) |
| `LOG_LEVEL` | No | `INFO` | Python logging level |

## Migration from Sharp Validator

The original Sharp-based validator in `lineEdgeValidator.ts` has been replaced with the OpenCV microservice. Key differences:

| Feature | Sharp Validator | OpenCV Validator |
|---------|----------------|------------------|
| **Technology** | Pure TypeScript/Sharp | Python FastAPI + OpenCV |
| **Edge Detection** | Custom Sobel implementation | OpenCV Canny + Hough |
| **Line Detection** | Sampling-based heuristic | Probabilistic Hough Line Transform |
| **Accuracy** | Moderate | High (industry standard) |
| **Performance** | ~67ms | ~200-500ms |
| **Maintenance** | Custom code | Well-tested library |
| **Deployment** | Same process as worker | Separate microservice |

The Sharp validator can be safely removed or kept as a fallback.

## Support

For issues or questions:
1. Check worker logs for validation errors
2. Check OpenCV service logs (Railway dashboard)
3. Verify environment variables are set correctly
4. Test validator endpoint directly: `curl https://your-service-url/health`

## License

Part of RealEnhance v2.0 - Internal use only
