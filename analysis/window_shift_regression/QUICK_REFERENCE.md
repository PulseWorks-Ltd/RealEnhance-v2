# QUICK REFERENCE: GEOMETRIC STABILITY ANALYSIS

## The Key Finding

**Centroid is STABLE. BBox edges are NOT.**

```
OPENING W2 (Front Wall, Large Window):
  Centroid_y:   cv = 0.0773  ✅ Very Stable
  Centroid_x:   cv = 0.0860  ✅ Very Stable
  Height:       cv = 0.1233  ⚠️  Moderate
  Width:        cv = 0.2229  ❌ Unstable
  BBox_x1:      cv = 0.1993  ❌ Unstable
  Area:         cv = 0.1793  ❌ Unstable
```

## The Implication

**Problem is NOT:** "Gemini doesn't detect bbox boundaries precisely"  
**Problem IS:** "Gemini detects stable centroids but variable sizes/edges"

**Solution is NOT:** "Tighter prompts with better bbox definitions"  
**Solution IS:** "Robust matching using centroid + size, not bbox bounds"

## The Pivot

**Phases 1-4 (Prompt Engineering):** Reduced from HIGH priority to OPTIONAL
- Experimental prompt may help ~10-15%
- Won't solve the fundamental centroid/size instability
- Still good to test (Phase 5)
- But matching algorithm fix is MORE CRITICAL

**Matching Algorithm Fix:** Elevated to CRITICAL priority
- Use centroid distance < 0.05 (not exact bbox match)
- Use area similarity > 0.85 (not exact area match)
- This tolerates the observed variance

## Evidence Summary

| Feature | W1 CV | W2 CV | Avg CV | Rank |
|---------|-------|-------|--------|------|
| **centroid_y** | 0.1029 | 0.0773 | **0.0901** | **#1** |
| bbox_y1 | 0.0975 | 0.0863 | 0.0919 | #2 |
| bbox_x2 | 0.2422 | 0.0628 | 0.1525 | #3 |
| ... | | | | |
| **bbox_x1** | 0.9429 | 0.1993 | **0.5711** | **#14** |

**Conclusion:** Vertical centroids are most stable. Left edge (x1) is wildly unstable.

## What Changed

### Before Geometric Analysis
- User complained: bbox variance between 10 runs (60.5%-78.2% resize)
- Team response: "Better prompts with explicit bbox rules"
- Plan: Phases 1-4 experimental prompt revision

### After Geometric Analysis
- Root cause identified: Centroid drifts 5-8%, edges drift 25-94%
- Correct response: "Robust centroid+size matching algorithm"
- New plan: Pivot to matching algorithm + optional prompt improvement

## Recommended Next Step

**Option C (RECOMMENDED):** Do both
1. Complete Phase 5 test (validate prompt improvement)
2. Implement matching algorithm fix (solve real problem)
3. Multi-image validation (ensure generalization)

**Timeline:** 3-5 days  
**Risk:** Low  
**Benefit:** Solves problem + validates prompt engineering value

## Implementation Snippet

```javascript
function matchOpenings(baseline, candidate) {
  // Must match
  if (baseline.wallIndex !== candidate.wallIndex) return false;
  
  // Centroid within 5%
  const dx = (baseline.x1+baseline.x2)/2 - (candidate.x1+candidate.x2)/2;
  const dy = (baseline.y1+baseline.y2)/2 - (candidate.y1+candidate.y2)/2;
  if (Math.sqrt(dx*dx + dy*dy) > 0.05) return false;
  
  // Area within 15% tolerance
  const bArea = (baseline.x2-baseline.x1) * (baseline.y2-baseline.y1);
  const cArea = (candidate.x2-candidate.x1) * (candidate.y2-candidate.y1);
  if (Math.min(bArea/cArea, cArea/bArea) < 0.85) return false;
  
  return true;
}
```

## Files to Review

1. **GEOMETRIC_STABILITY_FINDINGS.md** - Complete analysis
2. **PIVOT_DECISION.md** - Strategic decision framework
3. **analyze-geometric-stability.mjs** - Reusable analysis script
4. **geometric_feature_stability_analysis_*.json** - Raw data + report

## Key Quote

> "The bbox variance problem is NOT solved by better prompts. It's solved by robust geometric matching that tolerates centroid drift and size variability."

---

**Generated:** 2026-06-12  
**Status:** Ready for stakeholder review
