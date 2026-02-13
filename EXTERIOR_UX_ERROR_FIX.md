# Exterior Image UX Error Message Fix

## Problem
Exterior images were showing a misleading failure message in the batch processor UI when they successfully completed at Stage 1A or 1B without proceeding to Stage 2 (staging).

### Symptoms
- Red "Error" badge displayed
- Message: "We couldn't provide the staged image, but a decluttered image is available."
- Retry button shown
- User confusion: The image didn't actually fail, it's just that exterior staging is intentionally blocked

### Root Cause
Exterior images are currently blocked from Stage 2 (virtual staging) by design. When a user requests full pipeline processing (1A → 1B → 2) on exterior images:

1. **Worker Behavior**: Correctly skips Stage 2 for exterior images without suitable outdoor staging areas (see `worker/src/worker.ts` line 2370)
2. **Client UI Issue**: Was showing error message whenever `isError` was true AND partial outputs (Stage 1A/1B) were available

The error message specifically mentioned "staged image" which doesn't apply to exterior images that were never supposed to be staged.

## Solution

### Change Made
Modified [client/src/components/batch-processor.tsx](client/src/components/batch-processor.tsx#L5496) to only show the staging failure message when Stage 2 was actually expected:

**Before:**
```tsx
{isError && (stage1BUrl || stage1AUrl) && (
  <p className="mt-1 text-xs text-rose-600">
    {stage1BUrl ? "We couldn't provide the staged image..." : "..."}
  </p>
)}
```

**After:**
```tsx
{isError && (stage1BUrl || stage1AUrl) && stage2Expected && (
  <p className="mt-1 text-xs text-rose-600">
    {stage1BUrl ? "We couldn't provide the staged image..." : "..."}
  </p>
)}
```

### How It Works
The `stage2Expected` variable (line 5208) correctly determines if Stage 2 was expected:
```tsx
const stage2Expected = requestedStage2 && sceneLabel !== "exterior" && stagingAllowed;
```

For exterior images:
- `sceneLabel === "exterior"` → `sceneLabel !== "exterior"` is `false`
- Therefore `stage2Expected = false`
- The error message about staged images is now hidden

## Testing
- **Build Status**: ✅ Client builds successfully with no TypeScript errors
- **Expected Behavior**: Exterior images that complete at Stage 1A/1B will no longer show the confusing "couldn't provide staged image" message

## Notes
- If exterior images still show the red "Error" badge (separate from the message), that would indicate the job status itself is being set to "failed" by the worker, which would require additional investigation
- This fix specifically addresses the misleading error message about staging for images that were never supposed to be staged
- Interior images that fail to complete Stage 2 will still correctly show the error message

## Related Code
- Worker staging logic: [worker/src/worker.ts](worker/src/worker.ts#L2370) (exterior staging skip)
- Client error display: [client/src/components/batch-processor.tsx](client/src/components/batch-processor.tsx#L5496)
- Stage 2 expectation logic: [client/src/components/batch-processor.tsx](client/src/components/batch-processor.tsx#L5208)
