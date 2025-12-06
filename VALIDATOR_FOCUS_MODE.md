# Validator Focus Mode - Implementation Summary

## Overview

The RealEnhance worker now supports **VALIDATOR_FOCUS mode**, which outputs concise, structured logs containing only validation-related information when enabled. This mode suppresses all normal worker logs and focuses exclusively on validation metrics.

## Enabling VALIDATOR_FOCUS Mode

Set the environment variable:

```bash
VALIDATOR_FOCUS=1
```

Or:

```bash
VALIDATOR_FOCUS=true
```

## Expected Output Format

When `VALIDATOR_FOCUS=1`, each image/job produces logs matching this structure:

```
════════ IMAGE VALIDATION SESSION ════════
[VAL][job=job_123] label="Image 1 – enhanced_Rental 01"
[VAL][job=job_123] originalUrl=https://...
[VAL][job=job_123] stage1AUrl=https://...
[VAL][job=job_123] stage1BUrl=https://...
[VAL][job=job_123] stage2Url=https://...
[VAL][job=job_123] finalUrl=https://...

[VAL][job=job_123] UnifiedStructural: FAILED (score=0.366)
[VAL][job=job_123]   stage=2 scene=interior
[VAL][job=job_123]   windows=0.000 (window_size_change)
[VAL][job=job_123]   walls=1.000 (ok)
[VAL][job=job_123]   globalEdge=0.307/0.600
[VAL][job=job_123]   structuralIoU=0.000/0.300
[VAL][job=job_123]   lineEdgeScore=0.695 – Structural issues detected
[VAL][job=job_123]   failures=Window validation failed; Global edge IoU too low; Structural IoU too low
```

## Implementation

### Files Created

#### 1. `worker/src/config.ts` (NEW)

Centralized worker configuration:

```typescript
export const VALIDATOR_FOCUS =
  process.env.VALIDATOR_FOCUS === "1" || process.env.VALIDATOR_FOCUS === "true";
```

#### 2. `worker/src/logger.ts` (NEW)

Logging utilities that respect VALIDATOR_FOCUS mode:

```typescript
/**
 * Validator-focused log - only outputs when VALIDATOR_FOCUS is enabled
 */
export function vLog(...args: any[]) {
  if (VALIDATOR_FOCUS) {
    console.log(...args);
  }
}

/**
 * Normal log - only outputs when VALIDATOR_FOCUS is disabled
 */
export function nLog(...args: any[]) {
  if (!VALIDATOR_FOCUS) {
    console.log(...args);
  }
}
```

### Files Modified

#### 3. `worker/src/validators/runValidation.ts`

**Added:**
- Import `vLog` and `nLog`
- `logUnifiedValidationCompact()` function for compact output
- Converted all internal console.log to `nLog()`

**New Function:**

```typescript
export function logUnifiedValidationCompact(
  jobId: string,
  result: UnifiedValidationResult,
  stage: string,
  sceneType: string
)
```

This function outputs the compact unified validation format shown above.

#### 4. `worker/src/validators/index.ts`

**Added:**
- Export for `logUnifiedValidationCompact`

#### 5. `worker/src/worker.ts`

**Added:**
- Imports for `vLog`, `nLog`, `VALIDATOR_FOCUS`, `logUnifiedValidationCompact`
- Session header logging (lines 143-149)
- URL logging after each stage:
  - Stage 1A URL (line 403)
  - Stage 1B URL (line 744)
  - Stage 2 URL (line 558)
  - Final URL (lines 809, 818)
- Compact unified validation output (lines 595-604)
- Converted normal worker logs to use `nLog()`

**Key Integration Points:**

```typescript
// Session header
if (VALIDATOR_FOCUS) {
  vLog("════════ IMAGE VALIDATION SESSION ════════");
  vLog(`[VAL][job=${payload.jobId}] label="${imageLabel}"`);
  vLog(`[VAL][job=${payload.jobId}] originalUrl=${remoteUrl || origPath}`);
}

// Stage URLs
vLog(`[VAL][job=${payload.jobId}] stage1AUrl=${pub1AUrl}`);
vLog(`[VAL][job=${payload.jobId}] stage1BUrl=${pub1BUrl}`);
vLog(`[VAL][job=${payload.jobId}] stage2Url=${pub2Url}`);
vLog(`[VAL][job=${payload.jobId}] finalUrl=${pubFinalUrl}`);

// Compact validation output
if (VALIDATOR_FOCUS && unifiedValidation) {
  vLog(""); // Blank line for readability
  logUnifiedValidationCompact(
    payload.jobId,
    unifiedValidation,
    validationStage,
    sceneLabel === "exterior" ? "exterior" : "interior"
  );
}
```

## Log Sections

### 1. Session Header

```
════════ IMAGE VALIDATION SESSION ════════
[VAL][job=job_123] label="Image Name"
[VAL][job=job_123] originalUrl=https://...
```

Logged at the start of each job after the original image is resolved.

### 2. Stage URLs

```
[VAL][job=job_123] stage1AUrl=https://...
[VAL][job=job_123] stage1BUrl=https://...
[VAL][job=job_123] stage2Url=https://...
[VAL][job=job_123] finalUrl=https://...
```

Logged as each stage is published. Not all stages may be present depending on job options:
- Stage 1A: Always present
- Stage 1B: Only if declutter option enabled
- Stage 2: Only if virtualStage option enabled
- Final: The final output (may be same as 1A, 1B, or 2)

### 3. Unified Structural Validation

```
[VAL][job=job_123] UnifiedStructural: PASSED/FAILED (score=0.XXX)
[VAL][job=job_123]   stage=2 scene=interior
[VAL][job=job_123]   windows=0.XXX (ok|reason)
[VAL][job=job_123]   walls=0.XXX (ok|reason)
[VAL][job=job_123]   globalEdge=0.XXX/0.XXX
[VAL][job=job_123]   structuralIoU=0.XXX/0.XXX
[VAL][job=job_123]   lineEdgeScore=0.XXX – message
[VAL][job=job_123]   failures=reason1; reason2; ...
```

Logged after unified validation completes (Stage 2 only in current implementation).

**Field Descriptions:**
- **UnifiedStructural**: Overall pass/fail and aggregate score
- **stage**: Which stage was validated (1A, 1B, or 2)
- **scene**: Scene type (interior or exterior)
- **windows**: Window validator score and status
- **walls**: Wall validator score and status
- **globalEdge**: Global edge IoU score / threshold
- **structuralIoU**: Structural mask IoU score / threshold
- **lineEdgeScore**: Line/edge detection score and message
- **failures**: List of failure reasons (only if validation failed)

## Suppressed Logs in VALIDATOR_FOCUS Mode

When `VALIDATOR_FOCUS=1`, the following log types are **suppressed**:

- S3 upload progress
- Gemini request timing
- Chunk-by-chunk processing
- Polling updates
- Mask preprocessing details
- Region editor logs
- File path dumps
- Redis normalization logs
- All `process.stdout.write()` and normal `console.log()` calls

Only `vLog()` calls are visible.

## Normal Mode (VALIDATOR_FOCUS=0 or unset)

When `VALIDATOR_FOCUS` is not set or is `0`:
- All normal worker logs appear
- Validation logs appear in verbose format
- `vLog()` calls are suppressed
- `nLog()` calls are shown

## Usage Examples

### Enable Validator Focus Mode in Railway

1. Go to Railway worker service settings
2. Add environment variable: `VALIDATOR_FOCUS=1`
3. Deploy
4. View logs - only validation logs will appear

### Disable Validator Focus Mode

1. Remove `VALIDATOR_FOCUS` environment variable
2. Or set `VALIDATOR_FOCUS=0`
3. Deploy
4. View logs - normal verbose logs will appear

### Search/Filter Logs

When `VALIDATOR_FOCUS=1`, search for:

```bash
# All validation sessions
"IMAGE VALIDATION SESSION"

# Specific job
"[VAL][job=job_123]"

# Failed validations
"FAILED"

# Specific validator failures
"windows=" AND "window_"
"globalEdge="
"structuralIoU="

# URLs for specific job
"[VAL][job=job_123]" AND "Url="
```

## Benefits

1. **Focused Metrics Collection**: Only validation data, no noise
2. **Easy Parsing**: Structured format for automated analysis
3. **Compact Output**: Reduced log volume, faster search
4. **Per-Job Tracking**: Clear job ID in every log line
5. **Side-by-Side Comparison**: Easy to compare validation metrics across images
6. **Production Safe**: No code changes needed to switch modes

## Integration with Existing Systems

### Backward Compatible

- Existing code continues to work without changes
- Default behavior (VALIDATOR_FOCUS=0) unchanged
- No breaking changes to log parsing tools

### Future Enhancements

Potential additions for VALIDATOR_FOCUS mode:

1. **Stage 1B Structural Validator Compact Output** (currently not implemented)
   ```
   [VAL][job=job_123] Stage1BStructural: PASSED (scene=interior, ...)
   ```

2. **Classic Structure Validator Compact Output** (currently not implemented)
   ```
   [VAL][job=job_123] ClassicStructure: deviation=35.60° (vert=33.26°, ...)
   ```

3. **Gemini Compliance Compact Output** (currently part of normal flow)
   ```
   [VAL][job=job_123] GeminiCompliance: PASSED/FAILED
   ```

4. **JSON Output Mode**
   ```bash
   VALIDATOR_FOCUS=json
   ```
   Would output JSON objects instead of formatted text.

## Testing

### Verify VALIDATOR_FOCUS=1 Output

1. Set `VALIDATOR_FOCUS=1`
2. Run worker with a test job
3. Check logs contain only:
   - Session header
   - URLs
   - Unified validation output
4. Verify no S3, Gemini, or other verbose logs appear

### Verify VALIDATOR_FOCUS=0 Output

1. Set `VALIDATOR_FOCUS=0` or unset
2. Run worker with a test job
3. Check logs contain:
   - All normal worker logs
   - S3 upload details
   - Gemini request timing
   - Verbose validation output
4. Verify no `[VAL][job=...]` logs appear

## File Summary

| File | Type | Purpose |
|------|------|---------|
| `worker/src/config.ts` | NEW | Configuration flags including VALIDATOR_FOCUS |
| `worker/src/logger.ts` | NEW | Logging utilities (vLog, nLog) |
| `worker/src/validators/runValidation.ts` | MODIFIED | Added compact logging function |
| `worker/src/validators/index.ts` | MODIFIED | Export compact logging function |
| `worker/src/worker.ts` | MODIFIED | Integrated validator focus mode |

## Build Status

✅ **TypeScript compilation:** Success
✅ **No breaking changes:** Backward compatible
✅ **Environment-based toggle:** No code changes needed

---

**Implementation Date**: 2024-12-05
**Status**: Ready for Deployment
**Environment Variable**: `VALIDATOR_FOCUS=1`
