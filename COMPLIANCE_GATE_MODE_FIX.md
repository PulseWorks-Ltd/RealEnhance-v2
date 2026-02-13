# Compliance Gate Mode Enforcement Fix

## Problem

Images were being blocked at Stage 2 despite all validators being configured in **log-only mode**:

```
[worker] Validator config: structureMode=log, localBlocking=DISABLED, geminiConfirmation=ENABLED, geminiMode=log, sharpSemantic=log, geminiSemantic=log
```

Yet jobs were still failing with:
```
[worker] job failed Error: Gemini semantic validation failed with confidence 1.00: Structural violations detected: All movable furniture, including the table, chairs, grill, and flower pots, has been removed from the deck. This constitutes a structural violation.
```

## Root Cause

The **compliance gate** checks (separate from the unified validator) were throwing errors and blocking jobs **regardless of the `ENABLE_GEMINI_SEMANTIC_VALIDATION` mode setting**.

### Two Compliance Gates Found

1. **Stage 2 Only Path** ([worker.ts:886](worker/src/worker.ts#L886)) - For stage2-only jobs
2. **Full Pipeline Path** ([worker.ts:3378](worker/src/worker.ts#L3378)) - For full pipeline jobs (1A → 1B → 2)

Both were:
- Always running the compliance check via `checkCompliance()`
- Throwing `COMPLIANCE_VALIDATION_FAILED` errors when violations detected
- **Ignoring the `geminiSemanticValidatorMode` configuration**

## Solution

Modified both compliance gates to respect the `ENABLE_GEMINI_SEMANTIC_VALIDATION` environment variable mode:

### Behavior by Mode

| Mode | Behavior |
|------|----------|
| **`null` (disabled)** | Skip compliance check entirely, log that it's disabled |
| **`"log"`** | Run compliance check, log violations, **but allow job to proceed** |
| **`"block"`** | Run compliance check, **block job** if violations detected (original behavior) |

### Changes Made

Both compliance gates now:

1. **Check mode first**: Wrap entire compliance logic in `if (geminiSemanticValidatorMode !== null)`
2. **Log-only mode**: When violations detected in "log" mode:
   ```typescript
   if (shouldBlock && geminiSemanticValidatorMode === "log") {
     nLog(`[worker] ⚠️  Compliance failure detected (confidence ${confidence.toFixed(2)}) mode=log - ALLOWING job to proceed: ${lastViolationMsg}`);
   }
   ```
3. **Block mode**: Only throw error when mode is "block":
   ```typescript
   if (shouldBlock && geminiSemanticValidatorMode === "block") {
     throw complianceError; // Only blocks in "block" mode
   }
   ```

### Modified Files

- [worker/src/worker.ts](worker/src/worker.ts) - Two compliance gate sections fixed:
  - Lines 886-920: Stage 2 Only compliance gate
  - Lines 3378-3455: Full pipeline compliance gate

## Testing

- **Build Status**: ✅ Worker builds successfully with no TypeScript errors
- **Expected Behavior**: 
  - With `ENABLE_GEMINI_SEMANTIC_VALIDATION=log`: Compliance violations will be logged but jobs will proceed
  - With `ENABLE_GEMINI_SEMANTIC_VALIDATION=block`: Compliance violations will block jobs (current behavior)
  - Without setting (null): Compliance checks skip entirely

## Configuration Reference

```bash
# Log compliance violations but don't block
ENABLE_GEMINI_SEMANTIC_VALIDATION=log

# Block jobs with compliance violations (enforcement mode)
ENABLE_GEMINI_SEMANTIC_VALIDATION=block

# Disable compliance checks entirely
# (omit the variable or set to any other value)
```

## Related Components

- **Unified Validator**: Already fixed in previous commit to respect mode (only adds to reasons/score in block mode)
- **Compliance Gate**: Now fixed to respect mode (only throws errors in block mode)
- **Sharp Semantic Validator**: Already respects `SHARP_FINAL_VALIDATOR` mode setting

All validators now consistently honor log/block mode configuration.
