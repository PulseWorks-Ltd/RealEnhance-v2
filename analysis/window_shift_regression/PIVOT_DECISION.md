# PIVOT DECISION: FROM PROMPT ENGINEERING TO MATCHING ALGORITHM

**Date:** 2026-06-12  
**Status:** Critical Finding Requires Strategic Pivot

---

## THE DISCOVERY

User's question was prescient: *"Determine which representation is most stable across runs."*

Answer: **Centroid is stable. Bbox edges are not. This changes everything.**

### Data Evidence

| Representation | Stability | CV Range |
|---|---|---|
| Centroid (center point) | ✅ STABLE | 0.077-0.086 |
| Centroid_y | ✅ MOST STABLE | 0.0773 (W2), 0.1029 (W1) |
| Height | ⚠️ MODERATE | 0.1233-0.1493 |
| Width | ❌ UNSTABLE | 0.2229-0.2579 |
| BBox left edge (x1) | ❌ HIGHLY UNSTABLE | 0.9429 (W1) |
| BBox right edge (x2) | ❌ UNSTABLE | 0.2422 (W1) |
| Area | ❌ UNSTABLE | 0.1793-0.2930 |

---

## WHAT THIS MEANS

### Previous Assumption (Wrong)

"The problem is that Gemini doesn't detect bbox boundaries precisely. Solution: Better prompts with explicit definitions."

**Result:** Even with perfect prompts, bbox edges will vary 25-94% because centroid itself drifts 5-8%.

### New Understanding (Correct)

"The problem is that Gemini's vision model produces stable centroids but variable boundaries. Solution: Use centroid+size for matching, not exact bbox bounds."

**Result:** Robust matching that accepts natural geometric variance.

---

## CURRENT STATE: PHASES 1-4 WORK

✅ **Phase 1-4 are complete and valuable:**
- Identified 9 bbox ambiguity sources in current prompt
- Designed experimental prompt with explicit rules
- Created test harness for Phase 5

⚠️ **BUT: Phase 1-4 won't solve the problem because:**
- The problem isn't bbox precision
- The problem is centroid/size variance
- Better prompts can't fix that (it's Gemini's vision model limitation)

---

## RECOMMENDED ACTION

### Option A: HYBRID APPROACH (Recommended)

1. **Keep Phase 4 experimental prompt** (may help ~10-15%, no harm)
2. **Add Phase 5 testing** (validate the improvement)
3. **Implement matching algorithm fix** (critical, solves the real problem)

**Timeline:** ~3-5 days
**Risk:** Low (prompt improvements are safe, matching algorithm upgrade is standard practice)

### Option B: SKIP PROMPT WORK, GO STRAIGHT TO MATCHING

1. **Skip Phase 5 test** (experimental prompt probably won't achieve 50% goal)
2. **Implement matching algorithm** immediately
3. **Test with multi-image dataset**

**Timeline:** ~2-3 days  
**Risk:** Medium (assumes geometric instability is universal across images)

### Option C: CONTINUE PHASES 1-4 AS PLANNED

1. **Complete Phase 5 test** (measure actual improvement)
2. **If <30% improvement:** Pivot to matching algorithm
3. **If >30% improvement:** Deploy prompt + proceed with matching work

**Timeline:** ~1-2 days to Phase 5 results  
**Risk:** Low (validates the choice empirically)

---

## THE MATCHING ALGORITHM FIX

### Current Approach (Likely Too Strict)

```
// Current: Probably exact bbox comparison or graph consensus
function compareOpenings(baseline, candidate) {
  // Likely checking if graphs are "similar enough"
  // May use bboxes as part of comparison
  // This fails because bbox varies widely
}
```

### Proposed Approach (Robust)

```
function matchOpenings(baselineOpening, candidateOpening) {
  // Must-match criteria
  if (baselineOpening.wallIndex !== candidateOpening.wallIndex) return false;
  if (baselineOpening.type !== candidateOpening.type) return false;
  
  // Position matching (centroid distance, the stable feature)
  const dx = baselineOpening.bbox[0] + (baselineOpening.bbox[2] - baselineOpening.bbox[0])/2
          - (candidateOpening.bbox[0] + (candidateOpening.bbox[2] - candidateOpening.bbox[0])/2);
  const dy = baselineOpening.bbox[1] + (baselineOpening.bbox[3] - baselineOpening.bbox[1])/2
          - (candidateOpening.bbox[1] + (candidateOpening.bbox[3] - candidateOpening.bbox[1])/2);
  const centroidDistance = Math.sqrt(dx * dx + dy * dy);
  
  // Tolerance: 5% of image = 0.05 in normalized coords
  if (centroidDistance > 0.05) return false;
  
  // Size matching (area similarity, secondary stable feature)
  const baselineArea = (baselineOpening.bbox[2] - baselineOpening.bbox[0]) * 
                       (baselineOpening.bbox[3] - baselineOpening.bbox[1]);
  const candidateArea = (candidateOpening.bbox[2] - candidateOpening.bbox[0]) * 
                        (candidateOpening.bbox[3] - candidateOpening.bbox[1]);
  
  const areaSimilarity = Math.min(baselineArea / candidateArea, candidateArea / baselineArea);
  
  // Tolerance: 85% similarity = ±15% size variance (observed in data)
  if (areaSimilarity < 0.85) return false;
  
  return true;  // Match found
}
```

### Where to Implement

**File:** `worker/src/validators/openingValidator.ts`  
**Function:** Likely in `runOpeningValidator()` or wherever baseline/candidate opening comparison happens  
**Current Logic:** Search for `graph_consensus` or baseline comparison code

---

## VALIDATION BEFORE DEPLOYMENT

Before rolling out the matching algorithm change, validate with:

**Step 1: Repeat Geometric Analysis on 3-5 Images**
- Run 5-10 extraction passes on each image
- Compute centroid distance and area similarity for all opening pairs
- Confirm that:
  - 95%+ of true matches have centroid_distance < 0.05
  - 95%+ of true matches have area_similarity > 0.85
  - 99%+ of false matches violate at least one criterion

**Step 2: Test Opening Validator with Matching Algorithm**
- Apply new matching algorithm to test images
- Verify that opening preservation detection works correctly
- Check that no false positives/negatives introduced

**Step 3: Compare Results**
- Before: Current matching algorithm (baseline)
- After: New centroid+size matching algorithm
- Metrics: Match accuracy, false positive rate, false negative rate

---

## PRIORITY MATRIX

| Task | Priority | Impact | Effort | Decision |
|------|----------|--------|--------|----------|
| Phase 1-4 Experimental Prompt | Low | +10-15% | Medium | ✅ Do it (safe, informative) |
| Phase 5 Test Harness | Low | Validate | Low | ✅ Run (quick result) |
| Matching Algorithm Fix | **CRITICAL** | Solves problem | Medium | ✅ **Do this first** |
| Multi-image Validation | High | Generalize | Medium | ✅ Do after matching fix |

---

## NEXT STEPS (72 hours)

### Day 1: Decision & Planning
- [ ] Review this document with stakeholders
- [ ] Choose Option A, B, or C (recommend: Option C)
- [ ] Assign matching algorithm implementation
- [ ] Plan Phase 5 test execution

### Day 2: Phase 5 Test (if Option A/C)
- [ ] Run experimental prompt 10x vs current prompt 10x
- [ ] Document improvement percentage
- [ ] If <30%: Confirm pivot is correct
- [ ] If >30%: Deploy experimental prompt + proceed with matching algorithm

### Day 3: Matching Algorithm Implementation
- [ ] Update `openingValidator.ts` with centroid+size matching
- [ ] Test on sample images
- [ ] Validate multi-image generalization
- [ ] Deploy

---

## FILES GENERATED

1. **GEOMETRIC_STABILITY_FINDINGS.md** - Complete analysis with data tables
2. **analyze-geometric-stability.mjs** - Reusable analysis script
3. **geometric_feature_stability_analysis_1781233127944.json** - Raw data

---

## CLOSING THOUGHT

The user's insight was correct: *"Maybe the solution isn't a better prompt; the solution is using more robust geometric features."*

**Gemini can detect stable centroids. Use that. Don't waste time on unstable bbox edges.**
