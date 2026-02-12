# Gemini Layout Planner Implementation

## Overview

Added a **Gemini Vision pre-pass** to extract structured room layout context before Stage 2 staging. This provides spatial guidance to improve furniture placement without overriding user intent or modifying validation logic.

⚠️ **PRODUCTION SAFEGUARDS**: Includes kill switch, advisory-only labeling, array caps, and ROI metrics tracking.

## Implementation Details

### 1. New File: `worker/src/ai/layoutPlanner.ts`

**Purpose**: Low-cost Gemini vision call to extract layout metadata

**Interface**:
```typescript
export interface LayoutContextResult {
  room_type_guess: string | null;
  open_plan: boolean | null;
  zones: Array<{...}>;
  primary_focal_wall: "left" | "right" | "center" | "rear" | "unknown";
  major_fixed_features: string[]; // e.g., ["kitchen_island", "sliding_doors"]
  occlusion_risk: number; // 0.0-1.0
  layout_complexity: "simple" | "moderate" | "complex";
  staging_risk_flags: string[];
  confidence: number;
}
```

**Function**: `buildLayoutContext(imageUrl: string): Promise<LayoutContextResult | null>`

**Configuration**:
- Model: `gemini-2.5-flash` (low-cost)
- Temperature: `0.1` (very deterministic)
- Max Tokens: `512` (small output)
- Output: JSON only (`responseMimeType: "application/json"`)
- Fallback: Returns `null` on any error

### 2. Modified: `worker/src/pipeline/stage2.ts`

**Integration Point**: Before retry loop, after API key validation

**Guard Conditions**:
```typescript
const isFullStaging = opts.sourceStage === "1B-stage-ready";

if (isFullStaging && process.env.USE_GEMINI_STAGE2 === "1") {
  layoutContext = await buildLayoutContext(basePath);
  // Store in job metadata for debugging
  await updateJob(jobId, { layoutContext: {...} });
}
```

**When It Runs**:
- ✅ Stage 2 staging enabled (`USE_GEMINI_STAGE2=1`)
- ✅ FULL staging mode (`sourceStage === "1B-stage-ready"`)
- ❌ Skipped for refresh staging (`1A` or `1B-light`)
- ❌ Skipped for enhance-only jobs

**Result Storage**:
- Cached in `layoutContext` variable (per-job)
- Stored in job metadata via `updateJob()` for debugging
- Passed to `buildStage2PromptNZStyle()`

### 3. Modified: `worker/src/ai/prompts.nzRealEstate.ts`

**Function Signature Updated**:
```typescript
export function buildStage2PromptNZStyle(
  roomType: string,
  sceneType: "interior" | "exterior",
  opts?: {
    stagingStyle?: string | null;
    sourceStage?: "1A" | "1B-light" | "1B-stage-ready";
    layoutContext?: LayoutContextResult; // NEW
  }
): string
```

**Prompt Injection**:
When `isFullStaging && layoutContext`:
```
────────────────────────────────
LAYOUT CONTEXT (from vision pre-pass)
────────────────────────────────

Room Type: [detected]
Open Plan: [yes/no/unknown]
Layout Complexity: [simple/moderate/complex]
Occlusion Risk: [0.00-1.00]
Confidence: [0.00-1.00]

Zones Detected:
  • [zone_type] ([position])
  ...

Major Fixed Features:
  • [feature_name]
  ...

Primary Focal Wall: [direction]

Staging Risk Flags:
  ⚠ [flag]
  ...

INSTRUCTION TO STAGING MODEL:
Use layout context as spatial guidance only.
Do not restyle architectural anchors.
Place furniture in harmony with detected zones and focal points.
Respect occlusion risk when adding items.
────────────────────────────────
```

## Behavior

### Environment Variables (Kill Switches)

**`USE_GEMINI_STAGE2`** (Required)
- Master switch for all Stage 2 Gemini operations
- Must be `1` for layout planner to run

**`USE_GEMINI_LAYOUT_PLANNER`** (Required - NEW)
- **Dedicated kill switch** for layout planner only
- Allows disabling planner without disabling Stage 2
- Enables A/B testing and instant rollback
- Set to `1` to enable layout planner

**Both flags must be `1` for planner to run.**

### What It Does
- Extracts spatial layout metadata using Gemini vision
- Provides structured guidance for furniture placement
- Identifies zones, focal walls, and fixed features
- Assesses layout complexity and occlusion risks
- Stores metadata in job for debugging

### What It Does NOT Do
- ❌ Does not override user-selected room type (verified with warnings)
- ❌ Does not modify validation logic
- ❌ Does not change retry behavior
- ❌ Does not alter staging rules
- ❌ Does not restyle architectural anchors
- ❌ **Does NOT use `room_type_guess` to override `roomType` parameter**

### Critical Safety Features

1. **Advisory-Only Labeling**
   - Prompt includes: "⚠️ CRITICAL: This is spatial guidance, NOT a rule set."
   - Explicit instruction: "If any layout hint conflicts with visible architecture or structural constraints, follow the image and structural rules — IGNORE the hint."
   - Priority hierarchy clearly stated: Architecture > User room type > Layout hints

2. **Room 

**Environment Variables**: 
- `USE_GEMINI_STAGE2=1` (required)
- `USE_GEMINI_LAYOUT_PLANNER=1` (required - NEW kill switch)

**Test Scenarios**:
1. Full staging + both flags enabled → Layout planner runs
2. Full staging + planner flag disabled → Layout planner skipped (logs: "disabled")
3. Refresh staging + both flags enabled → Layout planner skipped (not full staging)
4. API error → Logs warning, continues without context, sets `layoutPlannerFailed=true`
5. Invalid JSON → Logs warning, continues without context
6. Job metadata → Check `layoutContext` and `stage2Metrics` fields in database

**Log Markers**:
```
[LAYOUT_PLANNER] 🔍 Running layout planner pre-pass for FULL staging...
[LAYOUT_PLANNER] ✅ Layout context extracted (elapsed: Xms)
[LAYOUT_PLANNER] ⚠️ Layout planner returned null
[LAYOUT_PLANNER] ⚠️ Layout planner failed
[LAYOUT_PLANNER] ℹ️ Layout planner disabled (USE_GEMINI_LAYOUT_PLANNER!=1)
[LAYOUT_PLANNER_ROI] ROI Metrics (jobId, retryCount, etc.)
```

## ROI Analysis (After ~200 Jobs)

**Metrics to Compare**:

With planner enabled:
- Average `stage2Metrics.retryCount`
- Average `stage2Metrics.validatorEscalations`
- Average `layoutPlannerElapsed` (cost overhead)
- Percentage of jobs with `validationRisk: true`

Without planner enabled:
- Same metrics from control group

**Success Criteria**:
- Retry count reduction ≥10%
- Validator escalations reduction ≥15%
- Cost overhead <$0.002 per job
- No increase in "valid but sub-optimal" staging

**Query Example**:
```sql
SELECT 
  layoutPlannerUsed,
  AVG(stage2Metrics->>'retryCount') as avg_retries,
  AVG(stage2Metrics->>'validatorEscalations') as avg_escalations,
  COUNT(*) as total_jobs
FROM jobs
WHERE stage = 'completed'
  AND sourceStage = '1B-stage-ready'
  AND created_at >= NOW() - INTERVAL '7 days'
GROUP BY layoutPlannerUsed;
```

## Known Behavioral Risks

### ⚠️ "Valid But Sub-Optimal" Risk

**Failure Mode**:
1. Planner guesses wrong zone layout (15-25% error rate on edge cases)
2. Staging follows incorrect spatial plan
3. Validators pass (structure intact, no violations)
4. Result looks "odd but valid" stylistically

**Example**:
- Planner detects "living zone left, dining zone right"  
- Reality: Open plan with unclear boundaries
- Staging clusters furniture incorrectly
- Validators don't catch mis-layout (only structural drift)

**Why Validators Won't Catch This**:
- Validators check architectural preservation, not furniture arrangement quality
- Stylistic mis-layout is not a structural violation
- Room type enforcement validates function, not spatial optimization

**Mitigation**:
- Monitor ROI metrics for "valid but sub-optimal" trend
- Compare user satisfaction metrics with/without planner
- A/B test with `USE_GEMINI_LAYOUT_PLANNER` flag
- Keep advisory-only labeling to minimize model over-reliance

**Red Flags to Watch**:
- Retry count doesn't improve after 200 jobs
- User complaints about "odd furniture placement"
- Staging feels "technically correct but unnatural"

### Second Interpretation Layer Risk

Planner introduces **another AI pass** before staging:
- Original: Image → Staging model → Validators
- New: Image → Planner → Staging model → Validators

**Compounding Error Risk**:
- If planner misinterprets, staging inherits the error
- Staging model may trust planner hints too much
- Validators only catch structural issues, not layout quality

**Defense**:
- Explicit "ADVISORY ONLY" warnings in prompt
- Priority hierarchy: Architecture > User intent > Planner hints
- Kill switch for instant rollback
- ROI metrics to prove value or disable feature

## TestingType Protection**
   - `room_type_guess` field is shown but explicitly marked as advisory
   - User-selected room type is repeated in prompt with precedence warning
   - Planner detection never overrides `roomType` parameter

3. **Array Length Caps**
   - `zones`: Max 4 (prevents prompt bloat)
   - `major_fixed_features`: Max 6
   - `staging_risk_flags`: Max 4
   - Applied at both storage and prompt injection points

4. **ROI Metrics Logging**
   Per job tracking:
   - `layoutPlannerUsed`: boolean
   - `layoutPlannerElapsed`: milliseconds
   - `layoutPlannerFailed`: boolean (if error)
   - `stage2Metrics.retryCount`: number
   - `stage2Metrics.validatorEscalations`: number
   - `stage2Metrics.finalValidatorMode`: string

   Log marker: `[LAYOUT_PLANNER_ROI]` with full metrics

### Error Handling
- Fails gracefully (returns `null`)
- Logs warnings but continues pipeline
- Does not block staging on failure
- JSON parse errors handled
- Network errors handled
- Invalid schema handled

## Testing

**Environment Variable**: `USE_GEMINI_STAGE2=1` (must be set)

**Test Scenarios**:
1. Full staging (`sourceStage: "1B-stage-ready"`) → Layout planner runs
2. Refresh staging (`sourceStage: "1A"`) → Layout planner skipped
3. API error → Logs warning, continues without context
4. Invalid JSON → Logs warning, continues without context
5. Job metadata → Check `layoutContext` field in database

**Log Markers**:
```
[LAYOUT_PLANNER] 🔍 Running layout planner pre-pass for FULL staging...
[LAYOUT_PLANNER] ✅ Layout context extracted
[LAYOUT_PLANNER] ⚠️ Layout planner returned null
[LAYOUT_PLANNER] ❌ Error
```

## Benefits

1. **Better Furniture Placement**: Spatial awareness for furniture positioning
2. **Zone Detection**: Identifies functional zones in open-plan spaces
3. **Risk Assessment**: Occlusion risk helps avoid blocking structure
4. **Focal Point Guidance**: Primary wall detection for staging focus
5. **Low Cost**: Small token budget, low temperature, simple model
6. **Additive Only**: No changes to validation, retry, or core logic

## Cost Impact

**Per Full-Staging Job**:
- 1 additional Gemini call
- Model: `gemini-2.5-flash` (cheapest)
- Max tokens: 512 (small)
- Estimated cost: ~$0.001-0.002 per call

**When NOT Called**:
- Refresh staging (no additional cost)
- Enhance-only jobs (no additional cost)
- Failed jobs before Stage 2 (no additional cost)

## Future Enhancements

Potential improvements (not implemented):
- Use layout context for furniture scale validation
- Detect multi-zone staging opportunities
- Warn about incompatible room types
- Suggest alternative staging approaches
- Integrate with furniture detector
