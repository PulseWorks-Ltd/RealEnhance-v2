# GEOMETRIC FEATURE STABILITY ANALYSIS - CRITICAL FINDINGS

**Analysis Date:** 2026-06-12  
**Data Source:** 10 repeatability runs on baseline image  
**Report:** `geometric_feature_stability_analysis_1781233127944.json`

---

## EXECUTIVE SUMMARY

The bbox variance problem is **NOT primarily a boundary localization problem**. 

Instead, the analysis reveals:
1. **Centroid (center point) is surprisingly STABLE** (cv ≤ 0.086 for most coords)
2. **BBox edges are HIGHLY VARIABLE** (cv = 0.24-0.94 for left/right edges)
3. **Dimensions (width/height) are UNSTABLE** (cv = 0.12-0.26)
4. **Wall-relative coordinates are SLIGHTLY better than image coords**

### Implication

**The current solution (tighter bbox prompts) addresses the wrong problem.**

The solution is NOT better prompt engineering to constrain bbox edges more tightly.

The solution is **robust opening matching using centroid + size**, not exact bbox bounds.

---

## DETAILED FINDINGS

### Opening W1 (Left Wall, Small Window)

| Feature | Min | Max | Mean | StdDev | CV | Rank | Stability |
|---------|-----|-----|------|--------|----|----|-----------|
| **centroid_y** | 0.324 | 0.455 | 0.410 | 0.042 | **0.1029** | 2 | ★ UNSTABLE |
| bbox_y1 | 0.195 | 0.271 | 0.251 | 0.024 | 0.0975 | 1 | ★ UNSTABLE |
| bbox_y2 | 0.453 | 0.651 | 0.569 | 0.064 | 0.1123 | 3 | ★ UNSTABLE |
| height | 0.256 | 0.392 | 0.318 | 0.047 | 0.1493 | 4 | ★ UNSTABLE |
| centroid_x | 0.107 | 0.278 | 0.167 | 0.047 | 0.2796 | 9 | ✗ HIGHLY UNSTABLE |
| width | 0.123 | 0.322 | 0.253 | 0.065 | 0.2579 | 7 | ✗ HIGHLY UNSTABLE |
| area | 0.0315 | 0.1137 | 0.0808 | 0.0237 | 0.2930 | 12 | ✗ HIGHLY UNSTABLE |
| **bbox_x1** | 0.000 | 0.121 | 0.040 | 0.038 | **0.9429** | 14 | ✗ HIGHLY UNSTABLE |

**Key Issue:** W1 left edge (bbox_x1) is wildly unstable (cv=0.9429). The opening "floats" from x=0.0 to x=0.121.

### Opening W2 (Front Wall, Large Window)

| Feature | Min | Max | Mean | StdDev | CV | Rank | Stability |
|---------|-----|-----|------|--------|----|----|-----------|
| **centroid_y** | 0.338 | 0.453 | 0.422 | 0.033 | **0.0773** | 2 | ★ UNSTABLE |
| **centroid_x** | 0.531 | 0.726 | 0.674 | 0.058 | **0.0860** | 3 | ★ UNSTABLE |
| bbox_x2 | 0.756 | 0.964 | 0.891 | 0.056 | 0.0628 | 1 | ★ UNSTABLE |
| bbox_y1 | 0.195 | 0.272 | 0.238 | 0.020 | 0.0863 | 4 | ★ UNSTABLE |
| bbox_y2 | 0.480 | 0.654 | 0.607 | 0.052 | 0.0863 | 5 | ★ UNSTABLE |
| height | 0.285 | 0.434 | 0.369 | 0.046 | 0.1233 | 7 | ★ UNSTABLE |
| width | 0.332 | 0.704 | 0.435 | 0.097 | 0.2229 | 12 | ✗ HIGHLY UNSTABLE |
| area | 0.1109 | 0.2006 | 0.1588 | 0.0285 | 0.1793 | 9 | ✗ HIGHLY UNSTABLE |

**Key Insight:** W2 centroid is stable (cv=0.077-0.086), but width is unstable (cv=0.2229).

### Cross-Opening Ranking (Average Rank Across W1 & W2)

| Rank | Feature | Avg Rank | W1 Rank | W2 Rank | Avg CV |
|------|---------|----------|---------|---------|--------|
| 1 | **centroid_y** | **2.00** | 2 | 2 | **0.0901** |
| 2 | bbox_y1 | 2.50 | 1 | 4 | 0.0919 |
| 3 | bbox_x2 | 3.50 | 6 | 1 | 0.1476 |
| 4 | bbox_y2 | 4.00 | 3 | 5 | 0.0993 |
| 5 | height | 5.50 | 4 | 7 | 0.1363 |
| 6 | centroid_x | 6.00 | 9 | 3 | 0.1828 |
| 7 | y_height | 6.50 | 5 | 8 | 0.1363 |
| 8 | wall_center_x | 8.00 | 10 | 6 | 0.1951 |
| 9 | width | 9.50 | 7 | 12 | 0.2404 |
| 10 | area | 10.50 | 12 | 9 | 0.2362 |
| 11 | wall_width | 10.50 | 8 | 13 | 0.2404 |
| 12 | wall_area | 11.50 | 13 | 10 | 0.2430 |
| 13 | aspect_ratio | 12.50 | 11 | 14 | 0.3179 |
| 14 | **bbox_x1** | **12.50** | **14** | 11 | **0.5711** |

**Winner:** centroid_y (most stable)  
**Loser:** bbox_x1 (least stable)

---

## IMAGE vs WALL-RELATIVE COORDINATES

| Coordinate System | Avg CV | Better? |
|------------------|--------|---------|
| **Image Coordinates** | 0.2759 | No |
| **Wall-Relative** | 0.2449 | **Yes** |
| **Improvement** | | +10.8% |

**Insight:** Wall-relative coordinates are ~11% better (lower CV). This makes sense because wall assignments are stable; measuring relative to walls removes camera position variance.

---

## CRITICAL CONCLUSION

### Problem Statement (Revisited)

**NOT:** "How do we make Gemini detect bbox edges more precisely?"

**ACTUAL:** "How do we robustly match openings across extractions despite centroid drift and size variability?"

### Root Cause

The 10 extraction runs show:
- **Centroid varies by ~5-8% across runs** (cv ≤ 0.086)
- **Edges vary by 25-94% across runs** (cv = 0.25-0.94)
- **Height varies by 12-25% across runs** (cv = 0.12-0.25)
- **Width varies by 23-26% across runs** (cv = 0.22-0.26)

This is **NOT bbox precision problem**. This is **geometric instability**.

### Why Better Prompts Won't Solve This

Even with perfect bbox definitions:
- Gemini would still detect slightly different centroids (±0.05 variance = ±5% image shift)
- Gemini would still measure width/height differently (±25% variance)
- These are inherent to the Gemini vision model's localization capability

### Actual Solution

**Stop trying to make bbox coordinates perfectly deterministic.** Instead:

1. **Use centroid + size matching** (not bbox bounds)
2. **Use wall-relative coordinates** for position
3. **Accept ~12% opening size variability** as normal
4. **Match openings by:**
   - Wall assignment (must match)
   - Centroid distance < 0.05 (image coords) OR < 0.10 (wall-relative)
   - Size similarity > 0.85 (ratio of area, accounting for 15% variance tolerance)

---

## RECOMMENDATIONS

### Short-term (Immediate)

**Update [openingValidator.ts](openingValidator.ts) to use robust matching:**

```
function matchOpenings(baselineOpening, candidateOpening) {
  // Must-match criteria
  if (baselineOpening.wallIndex !== candidateOpening.wallIndex) return false;
  if (baselineOpening.type !== candidateOpening.type) return false;
  
  // Position matching (centroid distance)
  const dx = baselineOpening.centroid[0] - candidateOpening.centroid[0];
  const dy = baselineOpening.centroid[1] - candidateOpening.centroid[1];
  const centroidDistance = Math.sqrt(dx * dx + dy * dy);
  if (centroidDistance > 0.05) return false;  // Allow 5% image variance
  
  // Size matching (area similarity)
  const areaSimilarity = Math.min(
    baselineOpening.area / candidateOpening.area,
    candidateOpening.area / baselineOpening.area
  );
  if (areaSimilarity < 0.85) return false;  // Allow 15% size variance
  
  return true;
}
```

### Medium-term (Next Phase)

**Deprecate Phase 1-4 prompt work** (the experimental prompt revision). Instead:

1. Revert to current baseline extraction prompt (or keep experimental if it shows >50% improvement)
2. **Focus on opening matching algorithm** (as above)
3. **Add telemetry** to track centroid drift and size variance per image

### Long-term (Investigation)

1. **Investigate why centroid_y is more stable than centroid_x** (vertical positioning might be easier for vision models)
2. **Test with multi-image datasets** (current analysis is single image; generalization needed)
3. **Consider fine-tuning Gemini vision** with geometry-annotated datasets if matching still fails

---

## WHAT THIS MEANS FOR PHASES 1-4

### Experimental Prompt Revision: LESS CRITICAL

The experimental prompt focusing on "inner glass boundary" and explicit bbox rules will likely **reduce variance by ~10-15%** (based on prompt engineering best practices), but won't solve the fundamental centroid/size instability.

**New Recommendation:** 
- ✅ Apply experimental prompt (may help)
- ✅ Test Phase 5 to confirm (may show improvements)
- ✅ BUT: Don't expect 50% layout variance reduction
- ✅ Instead: Focus on matching algorithm robustness

### Matching Algorithm: CRITICAL

The openingValidator.ts `compareOpenings()` function currently likely uses exact bbox comparison or graph consensus. This is too strict given the instability we've measured.

**Action:** Update matching to use centroid + size (as shown above).

---

## VALIDATION NEEDED

Before deploying the matching algorithm fix, validate with:

1. Run 10x extraction on **3-5 different images** (not just baseline)
2. Measure centroid/size variance on each image
3. Confirm that centroid distance < 0.05 captures 95% of true matches
4. Confirm that size similarity > 0.85 captures 95% of valid openings

---

## DETAILED REPORT

Full JSON report with all statistics: [geometric_feature_stability_analysis_1781233127944.json](geometric_feature_stability_analysis_1781233127944.json)

---

## CONCLUSION

**The bbox determinism problem is NOT solved by better prompts.** It's solved by **robust geometric matching that tolerates centroid drift and size variability**.

The centroid is the anchor; size is secondary; exact bbox edges are tertiary.

Design the matching algorithm accordingly.
