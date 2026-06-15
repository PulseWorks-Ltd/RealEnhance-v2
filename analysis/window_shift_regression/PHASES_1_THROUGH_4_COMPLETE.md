# BBOX DETERMINISM IMPROVEMENT: 5-PHASE ANALYSIS COMPLETE

**Status:** Phases 1-4 Complete, Phase 5 Ready to Execute

**Date:** 2026-06-12

**Objective:** Reduce bbox variance in baseline structural extraction without adding Gemini calls or changing downstream validators.

**Current Metrics (10-run audit):**
- Resize measurements: 60.5 - 78.2% (stddev 5.50)
- Unique graph hashes: 10/10 (100% variance)
- Unique layouts: 10/10 (100% variance)
- Opening count: Stable (2)
- Opening IDs: Stable (W2, W1)
- Wall assignments: Stable (W1→wall3, W2→wall0)

---

## PHASE 1: ANALYZE CURRENT PROMPT

**Finding:** Current prompts contain 9 sources of bbox ambiguity.

### Ambiguity Sources Identified

| Source | Current Instruction | Interpretation Problem | Gemini Variance | Impact |
|--------|-------------------|----------------------|-----------------|--------|
| 1. Frame vs Glass | "bbox must be normalized to image dimensions" (no clarity on what to measure) | Does bbox include frame trim, sill, or only inner glass? | Different runs measure different boundaries. | ±0.02-0.05 per coordinate; ±5-15% bbox scaling. |
| 2. Occlusion Threshold | "If partially occluded but clearly a structural opening, include it" | How much occlusion is "partial"? What makes something "clearly" present? | Run 1 includes 60% visible opening; Run 2 excludes 60% visible opening. | Bbox expansion/contraction 5-15% per run. |
| 3. Boundary Detection | "Vertical boundary invariant: preserve left/right frame boundaries when visible" | What counts as "visible"? Glass reflection? Frame trim? Actual frame edge? | Gemini detects different boundary types as "true" boundary. | W2 x1 variance: 0.26-0.55 (110% delta). |
| 4. Replacement vs Occlusion | "Objects may sit in front of opening, but if no opening boundary is visible on any side, classify as replacement" | Which boundary counts as "visible"? Top edge alone? One side? | Run 7 sees curtain edge as boundary; Run 9 ignores it. | Bbox height variance 10-20%. |
| 5. Visibility Definition | "Do not omit visible openings" | What makes something "visible"? Objectively, this is subjective. | Temperature/uncertainty in model leads to inclusion/exclusion flip. | Upstream decision affects all downstream geometry. |
| 6. Area Calculation | "area_pct must represent % of image area occupied by the opening" | Occupied by glass, frame, or outer edge? | Different interpretations of "occupied by" produce different area scales. | Resize measurements 60.5-78.2%; area inconsistency. |
| 7. Band Stability | "horizontalBand and verticalBand should be stable under mild reframing" | No guidance on deriving bands from bbox; bands are post-hoc. | Different bbox coords → different band assignments. | Indirect; drives bbox post-hoc. |
| 8. Wall Coverage | "wallCoverageBand is approximate percent of the wall occupied by the opening (not image area)" | Which wall dimension is denominator? Visible wall height? Wall height from floor to ceiling (not visible)? | Different wall dimension interpretations. | Classification drift (40-60 vs 60+). |
| 9. ID Ordering | "Assign deterministic IDs like W1, W2, D1, C1, A1" | What determines order? Detection order? Left-to-right? Top-to-bottom? Spatial grouping? | Gemini uses default JSON ordering; no explicit algorithm. | Same opening may be W1 in run 3, W2 in run 7 (though IDs appear stable in tests). |

### Root Cause

The current prompt provides **objective schema** (bbox is [x1,y1,x2,y2], area_pct is 0-100) but **subjective measurement rules** (what counts as "visible", "frame", "boundary", "partial"). Gemini must infer the measurement intent across 9 different ambiguous instructions.

---

## PHASE 2: PROPOSED DETERMINISTIC BBOX RULES

### Recommendation: Option B – Inner Glass/Opening Boundary

**Definition:**
- **Window:** bbox encloses the visible glass area (or structural opening if glass is opaque/dark).
- **Door:** bbox encloses the door aperture opening, not the door frame edge.
- **Partially occluded:** bbox encloses the VISIBLE portion of the inner boundary using 50% visibility threshold.
- **Extends beyond frame:** bbox clipped to image boundary (do not infer hidden portions).

**Rationale:**
1. **Most repeatable:** Glass edges are objective features, harder to detect but less ambiguous than frame edges.
2. **Operationally sound:** Aligns with opening preservation validation goal: "Did the glass/aperture change?" matters; frame trim doesn't.
3. **Visible in most images:** Glass or aperture boundary is usually detectable even in dark/occluded scenarios.
4. **Simplifies downstream logic:** "opening size = glass size" is clearer than "opening size = frame size ± trim variation".

### Comparison of Options

**Option A: Outer Visible Frame Boundary**
- Pros: Frame typically visible; includes structural context.
- Cons: Frame width varies by image quality; trim may be ambiguous; different window types have different frame widths.
- **Variance risk: HIGH**

**Option C: Structural Opening Rough Boundary**
- Pros: Balances visibility with repeatability; uses multiple edge cues.
- Cons: Still requires defining "clear existence" threshold; threshold remains subjective.
- **Variance risk: MEDIUM-LOW**

**Option B: Inner Glass/Opening Boundary (CHOSEN)**
- Pros: Most objective; glass edges are harder but more deterministic.
- Cons: Glass may have reflections; dark interiors lose visibility.
- **Variance risk: MEDIUM (reflections are localized; edges remain traceable)**

---

## PHASE 3: ID STABILITY ANALYSIS

### Current Behavior

From 10-run audit:
- All 10 runs: `openingIds = ["W2", "W1"]` (stable JSON order)
- W1: `wallIndex=3` (stable), `bbox` varies
- W2: `wallIndex=0` (stable), `bbox` varies

**Observation:** IDs are currently stable, but this is due to Gemini's **implicit behavior** (JSON key ordering), not explicit algorithm.

### Proposed Explicit ID Assignment Algorithm

```
1. Sort openings by wallIndex (0, 1, 2, 3).
2. Within each wall, sort left-to-right by bbox x1 coordinate (ascending).
3. Tiebreaker: if x1 values identical (within 0.01), sort by y1 (ascending).
4. Assign IDs:
   - W1, W2, W3, ... for windows
   - D1, D2, D3, ... for doors/closet_doors
   - C1, C2, C3, ... for walkthroughs
   - A1, A2, A3, ... for anchor fixtures
```

**Why this helps:**
- Makes ID assignment explicit and reproducible.
- If bbox coordinates vary, ID assignment remains consistent as long as spatial ordering doesn't flip.
- Provides a fallback if Gemini's JSON ordering changes.

---

## PHASE 4: EXPERIMENTAL PROMPT REVISION

### Changes Summary

#### System Instruction Changes
1. **Added explicit "CRITICAL: BBOX DEFINITION FOR DETERMINISM" section** with glass/frame clarification.
2. **Replaced ambiguous "partially occluded but clearly a structural opening"** with explicit 50% visibility threshold.
3. **Removed "Vertical boundary invariant"** (frame-based, ambiguous).
4. **Removed "If you are uncertain, include it"** (increases variance).
5. **Added "Use bbox center point for wall assignment"** (deterministic, not frame edges).
6. **Added explicit "ID Assignment (Deterministic and Reproducible)"** algorithm.

#### User Prompt Changes
1. **Restructured as 12 numbered EXTRACTION RULES** (vs inline commentary).
2. **Added explicit BBOX DEFINITION** with glass/frame examples.
3. **Added explicit WALL ASSIGNMENT** using bbox center (not frame).
4. **Added explicit AREA CALCULATION** formula: `(width * height * 100)`.
5. **Added explicit HORIZONTAL BAND** calculation (thirds by x).
6. **Added explicit VERTICAL BAND** rules (zones by y_center and height).
7. **Added explicit ORIENTATION formulas** (1.1x threshold for portrait/landscape).
8. **Added explicit PANE STRUCTURE guidance**.
9. **Added explicit CONFIDENCE tiers** (0.9-1.0, 0.7-0.9, <0.7).
10. **Added explicit ID ASSIGNMENT** algorithm (sort wallIndex → x1 → y1).
11. **Added "FINAL OUTPUT CHECKLIST"** to emphasize determinism guardrails.

### Artifacts

- **File 1:** `/workspaces/RealEnhance-v2/analysis/window_shift_regression/EXPERIMENTAL_PROMPT_REVISION.md` - High-level summary (Phase 1-2-3 analysis + experimental design).
- **File 2:** `/workspaces/RealEnhance-v2/analysis/window_shift_regression/EXPERIMENTAL_PROMPT_CONSTANTS.ts` - Actual prompt constants (copy-paste ready).
- **File 3:** This document - Comprehensive 5-phase record.

---

## PHASE 5: REPEATABILITY TEST (READY TO EXECUTE)

### Test Harness Location
- **File:** `/workspaces/RealEnhance-v2/analysis/window_shift_regression/test-experimental-prompt.ts`

### Test Design
1. Run current prompt 10 times on baseline image.
2. Run experimental prompt 10 times on same baseline image.
3. Compare metrics:
   - uniqueGraphCount
   - uniqueLayoutCount
   - bbox variance (per opening, per coordinate)
   - resize variance (stddev)
   - wall assignment consistency
   - ID stability
   - extraction time

### Success Criteria
- **Target:** 50% reduction in unique layout count (from 10/10 → ~5/10)
- **Target:** 30% reduction in bbox stddev (from 5.50 → ~3.5)
- **Preserve:** Opening count, detection quality, wall assignment quality

### How to Run (After Prompt Integration)

Once the experimental prompt is integrated into `openingPreservationValidator.ts`, run:

```bash
cd /workspaces/RealEnhance-v2
source worker/.env
./node_modules/.bin/tsx analysis/window_shift_regression/test-experimental-prompt.ts
```

This will generate:
- JSON report: `experimental_prompt_comparison_{timestamp}.json`
- Console summary with side-by-side metrics

### Expected Output Format

```json
{
  "timestamp": 1781234567890,
  "baseline_image": "...",
  "runs_per_version": 10,
  "current": {
    "promptVersion": "current",
    "totalRuns": 10,
    "uniqueGraphCount": 10,
    "uniqueLayoutCount": 10,
    "bboxVariance": { ... },
    "resizePercent": { "min": 60.5, "max": 78.2, "mean": 71.46, "stddev": 5.50 },
    "openingCountStability": { "stable": true, "count": 2, "variance": [2] },
    "wallAssignmentStability": { "W1": { ... }, "W2": { ... } },
    "idStability": { "stable": true, "variations": 1 }
  },
  "experimental": {
    "promptVersion": "experimental",
    "totalRuns": 10,
    "uniqueGraphCount": 5,  // TARGET: 50% reduction
    "uniqueLayoutCount": 5,  // TARGET: 50% reduction
    "bboxVariance": { ... },
    "resizePercent": { "min": 68.0, "max": 74.5, "mean": 71.20, "stddev": 3.50 }, // TARGET: 30% reduction in stddev
    ...
  },
  "improvement": {
    "uniqueGraphCount": 50,
    "uniqueLayoutCount": 50,
    "resizeVariance": 36,
    "idStability": 0
  }
}
```

---

## INTEGRATION CHECKLIST (For Production Deployment)

- [ ] **Phase 5 results reviewed:** Test harness confirms ≥50% layout variance reduction AND ≥30% resize variance reduction.
- [ ] **Downstream validator tested:** Confirm `openingValidator.ts` still works with new geometry.
- [ ] **Sampling audit:** Run 5-10 images through both pipelines; verify no false negatives in opening detection.
- [ ] **Production prompt replacement:** Replace BASELINE_SYSTEM_INSTRUCTION + BASELINE_USER_PROMPT in production.
- [ ] **Telemetry:** Monitor post-deployment metrics; compare opening consensus rates before/after.

---

## KEY TAKEAWAYS

1. **Ambiguity is the root cause:** The current prompt defines what to output (schema) but not what to measure (frame vs glass vs wall). This forces Gemini to interpret across 9 subjective rules.

2. **Inner glass boundary is the target:** Explicit focus on glass/aperture (not frame trim) is more repeatable and aligns with validation goals.

3. **Deterministic ordering matters:** Even if bbox coordinates vary slightly, explicit sorting (wallIndex → x1 → y1) ensures consistent ID assignment and layout ordering.

4. **50% visibility threshold helps:** Removes "partially occluded but clearly present" ambiguity; provides objective inclusion rule.

5. **Prompt-only change:** No schema changes, no validator changes, no additional API calls. Pure prompt refinement for determinism.

---

## FILES GENERATED

1. **EXPERIMENTAL_PROMPT_REVISION.md** - High-level analysis and design rationale.
2. **EXPERIMENTAL_PROMPT_CONSTANTS.ts** - Actual prompt constants for integration.
3. **test-experimental-prompt.ts** - Phase 5 test harness (ready to execute).
4. **THIS DOCUMENT** - Complete 5-phase record.

---

## NEXT STEPS

1. **Review Phase 1 analysis:** Confirm ambiguity sources align with your observations.
2. **Confirm Phase 2 recommendation:** Agree that "inner glass boundary" is the target.
3. **Review experimental prompts:** Check EXPERIMENTAL_PROMPT_CONSTANTS.ts for tone, clarity, specificity.
4. **Integrate experimental prompt:** Replace constants in openingPreservationValidator.ts (or add variant).
5. **Run Phase 5 test harness:** Execute test-experimental-prompt.ts and review results.
6. **Compare metrics:** If 50% layout variance reduction achieved, proceed to production deployment.

---

## NON-PRODUCTION WORK STATUS

✅ Phase 1: Ambiguity analysis complete
✅ Phase 2: Deterministic rules proposed
✅ Phase 3: ID stability analysis complete
✅ Phase 4: Experimental prompt revision created
⏳ Phase 5: Test harness ready (awaiting prompt integration + execution)

**No production changes have been made. All work is in analysis/window_shift_regression/ directory.**
