# Light Declutter Mode Implementation

## Summary
Added a new "Declutter Only" light mode that removes clutter and mess while keeping all main furniture intact. This is in addition to the existing "Stage Ready" mode that removes everything.

## Changes Made

### 1. Shared Types (`shared/src/types.ts`)
- Added `declutterMode?: "light" | "stage-ready"` to `EnhanceJobPayload.options`
- This field controls which declutter behavior is used in Stage 1B

### 2. Client UI (`client/src/components/batch-processor.tsx`)
- Added state: `const [declutterMode, setDeclutterMode] = useState<"light" | "stage-ready">("stage-ready")`
- Added radio button UI that appears when declutter checkbox is enabled:
  - **Declutter Only (Remove Clutter)** - Keeps furniture, removes mess
  - **Stage Ready (Empty Room)** - Removes all furniture and clutter (default)
- Updated FormData submission to send `declutterMode` when declutter is enabled

### 3. Server (`server/src/routes/upload.ts`)
- Read `declutterModeForm` from request body
- Added normalization logic: if declutter is enabled and no mode specified, default to `"stage-ready"` for backward compatibility
- Pass `declutterMode` to worker job payload

### 4. Worker Prompt (`worker/src/ai/prompts.nzRealEstate.ts`)
- Created new function: `buildLightDeclutterPromptNZStyle()`
- Light mode prompt removes:
  - Loose items on surfaces (dishes, bottles, papers, toys, etc.)
  - Clutter on floors (shoes, bags, clothes, etc.)
  - Visible mess (stains, trash, dirty laundry)
  - Excess small ornaments creating visual noise
- Light mode keeps:
  - ALL main furniture (sofas, beds, tables, chairs, etc.)
  - Rugs and large decor
  - All built-ins and fixtures
  - All appliances (including countertop items)
  - Decorative elements (cushions, throws, major wall art)

### 5. Worker Pipeline (`worker/src/pipeline/stage1B.ts`)
- Added `declutterMode?: "light" | "stage-ready"` parameter to `runStage1B()`
- Branches prompt selection based on mode:
  - `light` → `buildLightDeclutterPromptNZStyle()`
  - `stage-ready` → `buildStage1BPromptNZStyle()` (existing full removal)
- Updated function documentation to reflect dual modes

### 6. Worker Orchestration (`worker/src/worker.ts`)
- Read `declutterMode` from job payload with default fallback to `"stage-ready"`
- Pass mode to `runStage1B()` function
- Updated logging to show which mode is being used

## Backward Compatibility
- **Default behavior preserved**: Old jobs without `declutterMode` default to `"stage-ready"` (full removal)
- **Single-pass implementation**: Light mode uses only one Gemini call (not dual-pass)
- **No breaking changes**: Existing code paths continue to work as before

## Implementation Details
- **Single-pass**: Light mode is NOT dual-pass like the heavy declutter variant
- **Minimal changes**: Surgical additions without refactoring existing code
- **Type safety**: TypeScript enforces correct mode values throughout the stack
- **UI/UX**: Radio buttons only appear when declutter checkbox is enabled
- **Prompt engineering**: Light mode explicitly preserves all main furniture while targeting clutter

## Testing Notes
- Client build: ✅ Successful (5.92s)
- Server build: ✅ Successful
- Worker build: ✅ Successful
- No TypeScript errors in any modified files

## Files Modified
1. `shared/src/types.ts`
2. `client/src/components/batch-processor.tsx`
3. `server/src/routes/upload.ts`
4. `worker/src/ai/prompts.nzRealEstate.ts`
5. `worker/src/pipeline/stage1B.ts`
6. `worker/src/worker.ts`

## Usage Flow
1. User enables "Remove furniture & clutter" checkbox
2. Radio buttons appear with two options
3. User selects either "Declutter Only" or "Stage Ready" (default)
4. Client sends `declutter=true` and `declutterMode="light"|"stage-ready"`
5. Server normalizes and passes to worker
6. Worker selects appropriate prompt based on mode
7. Gemini processes with mode-specific instructions
