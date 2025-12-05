# RealEnhance Validator Log-Only Mode

## Overview

The RealEnhance worker now supports a **log-only validator mode** that allows all non-Gemini validators to run and collect metrics without blocking images or affecting the user-facing pipeline. This enables safe metric collection in production for threshold tuning and validator effectiveness analysis.

## Quick Start

### Production Configuration (Log-Only Mode)

Set these environment variables on your worker service (Railway):

```bash
# Enable log-only mode for all validators
VALIDATOR_MODE=log

# Optional: Override specific validator types
STRUCTURE_VALIDATOR_MODE=log
REALISM_VALIDATOR_MODE=off

# OpenCV structural validator (existing config)
STRUCTURE_VALIDATOR_URL=https://your-opencv-service.railway.app
STRUCTURE_VALIDATOR_SENSITIVITY=5.0
```

### Development/Testing Configuration

```bash
# Disable all validators during development
VALIDATOR_MODE=off

# Or enable blocking mode for testing
VALIDATOR_MODE=block
STRUCTURE_VALIDATOR_MODE=block
```

## Validator Modes

The validator system supports four modes:

| Mode | Behavior | Use Case |
|------|----------|----------|
| `off` | Validator does not run | Development, debugging |
| `log` | **Validator runs and logs results, NEVER blocks images** | Production metric collection |
| `retry` | Validator can trigger automatic retries (not yet implemented) | Future: smart retry logic |
| `block` | Validator can block/reject images that fail validation | Testing, strict quality control |

## Environment Variables

### Global Configuration

- **`VALIDATOR_MODE`** (default: `off`)
  - Global default mode for all validators
  - Valid values: `off`, `log`, `retry`, `block`
  - Example: `VALIDATOR_MODE=log`

### Validator-Specific Configuration

These override the global `VALIDATOR_MODE` for specific validator types:

- **`STRUCTURE_VALIDATOR_MODE`** (default: inherits from `VALIDATOR_MODE`)
  - Controls all structural validators (edge IoU, dimension checks, window validation, etc.)
  - Applies to: Stage1A, Stage1B, Stage2 structural checks
  - Example: `STRUCTURE_VALIDATOR_MODE=log`

- **`REALISM_VALIDATOR_MODE`** (default: inherits from `VALIDATOR_MODE`)
  - Controls Gemini-based realism validators
  - **Note:** Currently DISABLED by design (see Gemini Validators section)
  - Example: `REALISM_VALIDATOR_MODE=off`

### OpenCV Structural Validator (Stage 2 Only)

The OpenCV structural validator uses the `STRUCTURE_VALIDATOR_MODE` setting:

- **`STRUCTURE_VALIDATOR_URL`** (required)
  - URL of the Python FastAPI OpenCV microservice
  - Example: `STRUCTURE_VALIDATOR_URL=https://opencv-validator.railway.app`

- **`STRUCTURE_VALIDATOR_SENSITIVITY`** (default: `5.0`)
  - Deviation threshold in degrees
  - Higher = more permissive, lower = more strict
  - Example: `STRUCTURE_VALIDATOR_SENSITIVITY=5.0`

## Validator Types and Coverage

### Structural Validators (Non-Gemini)

These validators run in log-only mode and collect metrics:

#### Stage 1A Validators
- **Edge IoU Check**: Compares edge maps between base and enhanced images
  - Threshold: `STAGE1A_MIN_EDGE_IOU` (default: 0.65)
  - Detects: Major structural changes, cropping, dimension changes
- **Brightness Difference**: Measures overall brightness shift
  - Detects: Over/under exposure
- **Dimension Match**: Ensures output matches input dimensions
  - Detects: Unexpected resizing, aspect ratio changes

#### Stage 1B Validators
- **Structural IoU with Mask**: Uses architectural mask to focus on walls/structure
  - Detects: Wall removal, structural geometry changes
- **Window Validation**: Tracks window positions and presence
  - Detects: Missing windows, window position shifts
- **Dimension Match**: Same as Stage 1A

#### Stage 2 Validators
- **Structural IoU with Mask**: Architecture must remain unchanged during staging
  - Threshold: More relaxed than 1B (allows furniture addition)
  - Detects: Unintentional wall/structure changes
- **Window Validation**: Windows must remain unchanged
  - Detects: Furniture blocking windows, window removal
- **OpenCV Line Detection** (Python microservice):
  - Hough Line Transform for architectural feature detection
  - Detects: Vertical line shifts (walls), horizontal line shifts (ceiling/floor)
  - Returns: Deviation score in degrees

### Gemini-Based Validators (Currently Disabled)

These validators are **intentionally disabled** to prevent Gemini API calls during the log-only testing phase:

- **Realism Validator**: Checks furniture scale, lighting, floating objects
  - Status: ❌ DISABLED (returns `ok: true` with warning)
  - Will be re-enabled after log-only phase

- **Exterior Surface Validator**: Validates outdoor surfaces and furniture
  - Status: ❌ DISABLED in unified-validator.ts
  - Will be re-enabled after log-only phase

## Log Output Format

### Structural Validators (Stage 1A, 1B, 2)

```
[validator:stage1A] Running structural validation (mode=log, scene=interior)
[validator:stage1A] === Validation Result ===
[validator:stage1A] Stage: stage1A
[validator:stage1A] Scene: interior
[validator:stage1A] Mode: log
[validator:stage1A] OK: false
[validator:stage1A] Reason: structural_change
[validator:stage1A] Details: {
  "edgeIoU": 0.58,
  "brightnessDiff": 0.12,
  "sizeMismatch": false
}
[validator:stage1A] ⚠️ Validation failed but not blocking (log-only mode)
[validator:stage1A] Failure reason: structural_change
[validator:stage1A] =======================
```

### OpenCV Structural Validator (Stage 2)

```
[structureValidator] === STRUCTURAL VALIDATION RESULT ===
[structureValidator] Mode: log
[structureValidator] Deviation Score: 50.88°
[structureValidator] Vertical Shift: 48.22°
[structureValidator] Horizontal Shift: 2.66°
[structureValidator] Suspicious: true
[structureValidator] Message: Structural deviation detected: 50.88° (threshold: 5.0°)
[structureValidator] Original lines: 142 total (78 vertical, 64 horizontal)
[structureValidator] Enhanced lines: 98 total (51 vertical, 47 horizontal)
[structureValidator] ⚠️ Structural deviation detected but not blocking (mode=log)
```

## Implementation Details

### Validator Mode Architecture

The validator mode system is implemented in [worker/src/validators/validatorMode.ts](worker/src/validators/validatorMode.ts):

```typescript
export type ValidatorMode = "off" | "log" | "retry" | "block";
export type ValidatorKind = "global" | "structure" | "realism";

export function getValidatorMode(kind: ValidatorKind = "global"): ValidatorMode {
  // Returns the configured mode with precedence:
  // 1. Kind-specific env var (e.g., STRUCTURE_VALIDATOR_MODE)
  // 2. Global VALIDATOR_MODE
  // 3. Default: "off"
}

export function isValidatorEnabled(kind: ValidatorKind): boolean {
  return getValidatorMode(kind) !== "off";
}

export function shouldValidatorBlock(kind: ValidatorKind): boolean {
  return getValidatorMode(kind) === "block";
}

export function isLogOnlyMode(kind: ValidatorKind): boolean {
  return getValidatorMode(kind) === "log";
}
```

### Integration Points

#### 1. validators/index.ts
Main structural validator orchestration with mode support:

```typescript
export async function validateStageOutput(
  stage: StageName,
  basePath: string,
  outputPath: string,
  context: { sceneType: "interior" | "exterior"; roomType?: string; jobId?: string }
): Promise<ValidationResult> {
  const mode = getValidatorMode("structure");

  if (!isValidatorEnabled("structure")) {
    return { ok: true, reason: "validator_disabled", mode };
  }

  // Run validation
  const result = await validateStage(...);

  // In log-only mode, override failures to ok=true
  if (!result.ok && isLogOnlyMode("structure")) {
    console.warn(`⚠️ Validation failed but not blocking (log-only mode)`);
    result.ok = true;
  }

  return result;
}
```

#### 2. validators/structureValidatorClient.ts
OpenCV microservice client with mode support:

```typescript
export async function runStructuralCheck(
  originalUrl: string,
  enhancedUrl: string
): Promise<StructureValidationResult> {
  const result = await validateStructure(originalUrl, enhancedUrl);

  // Log results
  console.log("[structureValidator] === STRUCTURAL VALIDATION RESULT ===");
  console.log(`[structureValidator] Mode: ${result.mode}`);
  console.log(`[structureValidator] Deviation Score: ${result.deviationScore}°`);

  // Block only if mode=block AND suspicious
  if (result.mode === "block" && result.isSuspicious) {
    throw new Error(`Structural validation failed: ${result.message}`);
  }

  return result;
}
```

#### 3. validators/realism.ts
Gemini-based realism validator (currently disabled):

```typescript
export async function validateRealism(
  finalPath: string
): Promise<{ ok: boolean; notes?: string[]; disabled?: boolean }> {
  const mode = getValidatorMode("realism");

  // DISABLED: Prevent Gemini calls during log-only testing
  console.warn("[realism-validator] Gemini-based realism validator is DISABLED by design");
  return {
    ok: true,
    notes: ["Gemini-based realism validator temporarily disabled"],
    disabled: true,
  };
}
```

## Startup Configuration

The worker logs validator configuration on startup:

```
[validator-config] === Validator Configuration ===
[validator-config] VALIDATOR_MODE: log
[validator-config] STRUCTURE_VALIDATOR_MODE: (not set)
[validator-config] REALISM_VALIDATOR_MODE: off
[validator-config] Resolved modes:
[validator-config]   - global: log
[validator-config]   - structure: log
[validator-config]   - realism: off
[validator-config] ================================
```

## Monitoring and Metrics

### What to Monitor

1. **Validation Failure Rates**
   - Track `ok: false` in log-only mode
   - Identify which validators trigger most often
   - Analyze deviation scores and thresholds

2. **Threshold Tuning**
   - Review edge IoU distributions
   - Analyze brightness difference ranges
   - Evaluate OpenCV deviation scores

3. **False Positives**
   - Images that pass user QA but fail validators
   - May indicate thresholds are too strict

4. **False Negatives**
   - Images that fail user QA but pass validators
   - May indicate thresholds are too lenient or validators missing edge cases

### Sample Queries (Railway Logs)

```
# Find all validator failures
"Validation failed but not blocking"

# Find high deviation scores
"Deviation Score:" AND "°"

# Find structural changes
"Reason: structural_change"

# Find dimension mismatches
"Reason: dimension_change"

# Find OpenCV suspicious detections
"Suspicious: true"
```

## Roadmap

### Phase 1: Log-Only Collection (Current)
- ✅ All non-Gemini validators run in log mode
- ✅ Gemini validators disabled
- ✅ Structured logging for all results
- ✅ OpenCV validator integrated
- 🎯 Goal: Collect 1-2 weeks of production metrics

### Phase 2: Threshold Tuning
- Analyze collected metrics
- Adjust thresholds based on false positive/negative rates
- Update `VALIDATION_THRESHOLDS` in config.ts
- Re-enable in log mode with new thresholds

### Phase 3: Selective Blocking
- Enable blocking mode for high-confidence validators
- Start with most accurate validators (e.g., dimension checks)
- Gradually enable blocking for others

### Phase 4: Gemini Validator Re-enablement
- Re-enable realism validator in log mode
- Collect Gemini validator metrics
- Evaluate cost vs. benefit
- Enable blocking if justified

### Phase 5: Retry Logic (Future)
- Implement `retry` mode
- Automatically retry failed images with adjusted parameters
- Smart retry strategies based on failure type

## Troubleshooting

### Validators Not Running

**Check:**
1. `VALIDATOR_MODE` is set to `log` or `block`
2. Startup logs show correct configuration
3. Search logs for `[validator:` to confirm execution

**Fix:**
```bash
# Ensure mode is set
VALIDATOR_MODE=log
```

### OpenCV Validator 502 Errors

**Check:**
1. `STRUCTURE_VALIDATOR_URL` is set correctly
2. OpenCV service is deployed and running
3. Railway assigned PORT is being used

**Fix:**
See [opencv-validator/DEPLOYMENT.md](opencv-validator/DEPLOYMENT.md)

### Validators Blocking Images in Log Mode

**This should never happen!** If it does:

**Check:**
1. Verify `STRUCTURE_VALIDATOR_MODE=log` (not `block`)
2. Check logs for `BLOCKING IMAGE` messages
3. Verify [validators/index.ts:216-220](worker/src/validators/index.ts#L216-L220) override logic

**Report:** This is a critical bug - file immediately

### Missing Validator Logs

**Check:**
1. Validators are enabled (`VALIDATOR_MODE` not `off`)
2. Stage is actually running (check for `[stage1A]`, `[stage1B]`, `[stage2]` logs)
3. Images are being processed (not using Sharp-only fallback)

## Files Modified

| File | Purpose |
|------|---------|
| [worker/src/validators/validatorMode.ts](worker/src/validators/validatorMode.ts) | Core mode configuration system |
| [worker/src/validators/index.ts](worker/src/validators/index.ts) | Structural validator orchestration with mode support |
| [worker/src/validators/structureValidatorClient.ts](worker/src/validators/structureValidatorClient.ts) | OpenCV client with mode support |
| [worker/src/validators/realism.ts](worker/src/validators/realism.ts) | Disabled Gemini realism validator |
| [worker/src/worker.ts](worker/src/worker.ts) | Added validator config logging at startup |

## Contributing

When adding new validators:

1. Import and use `getValidatorMode()` to check mode
2. Use `isValidatorEnabled()` to check if validator should run
3. Use `isLogOnlyMode()` to override failures in log mode
4. Log results consistently (see existing validators for format)
5. Add validator to appropriate kind (`structure`, `realism`, or add new kind)
6. Update this document

## Support

For questions or issues:
- Check Railway logs for validator output
- Review [STRUCTURAL_VALIDATOR.md](STRUCTURAL_VALIDATOR.md) for OpenCV validator details
- File GitHub issues for bugs or enhancement requests
