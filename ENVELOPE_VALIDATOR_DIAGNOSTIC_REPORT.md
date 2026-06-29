# Envelope Validator Diagnostic Report - Full Test Replay

**Execution Date**: 2026-06-26  
**Test Configuration**: Local Stage 1A baseline vs Stage 2 candidate images  
**Test Status**: ✅ COMPLETE  
**Overall Accuracy**: 3/5 (60%)

---

## Executive Summary

### Results Overview

| Job | Expected | Actual | Correct | Notes |
|-----|----------|--------|---------|-------|
| job_c11a8e7c | **FAIL** | PASS | ❌ | Architectural change not detected |
| job_bb029607 | **FAIL** | PASS | ❌ | Architectural change not detected |
| job_4a87f43b | **PASS** | PASS | ✅ | Correct discrimination |
| job_dfbe98aa | **PASS** | PASS | ✅ | Correct discrimination |
| job_81e485e7 | **PASS** | PASS | ✅ | Correct discrimination |

### Key Finding
The wall descriptor feature is **working correctly** (extraction ✓, prompt interpolation ✓), but the envelope validator is **failing to discriminate architectural changes in 2/5 cases**. Both failing cases return PASS when they should return FAIL, indicating the validator may not be sensitive enough to detect the architectural modifications in those specific test cases.

---

## Detailed Analysis by Job

### ✅ CORRECT: job_4a87f43b (Expected PASS → Got PASS)

**Baseline Extraction:**
- Openings: 1
- Fixtures: 0  
- Wall Descriptors: 2
  - Wall 1: "continuous flat wall"
  - Wall 2: "continuous flat wall"

**Envelope Validator Decision**: PASS (Confidence: 1, Hard Fail: false)

**Rationale**: No architectural changes between images. Wall descriptors properly extracted and included in prompt context.

---

### ✅ CORRECT: job_dfbe98aa (Expected PASS → Got PASS)

**Baseline Extraction:**
- Openings: 1
- Fixtures: 0
- Wall Descriptors: 3
  - Wall 0 (full): "Continuous flat wall"
  - Wall 1 (minimal): "Continuous flat wall, visible at corner"
  - Wall 3 (partial): "Wall containing one window"

**Envelope Validator Decision**: PASS (Confidence: 1, Hard Fail: false)

**Geometric Signals:**
- Corner persistence failure: YES (worstRetention: 0.893)
- Junction count: 8
- Advisory signal: envelope_corner_flattened
- Yet decision: PASS

**Analysis**: Despite geometric corner persistence failures being detected and emitted as advisory signals, the validator correctly determined this represents styling/furniture changes, not architectural changes. Wall descriptors helped establish architectural baseline.

---

### ✅ CORRECT: job_81e485e7 (Expected PASS → Got PASS)

**Baseline Extraction:**
- Openings: 3 (window W1, door D1, walkthrough A1)
- Fixtures: 2 (kitchen island, built-in cabinet)
- Wall Descriptors: 3
  - Wall 0 (partial): "Wall contains a door on the left, a window in the center, and built-in kitchen cabinetry on the right"
  - Wall 1 (minimal): "Continuous wall corner"
  - Wall 3 (partial): "Wall contains a full-height walkthrough opening"

**Envelope Validator Decision**: PASS (Confidence: 1, Hard Fail: false)

**Special Note**: Vertical edge delta analysis failed (image format issue for JPG processing), so validator relied purely on semantic Gemini analysis. Still returned correct PASS decision.

**Analysis**: Complex room with multiple openings and fixtures. Wall descriptors provided rich architectural context. Validator correctly identified no architectural changes despite furniture/staging differences.

---

### ❌ INCORRECT: job_c11a8e7c (Expected FAIL → Got PASS)

**Images Compared:**
- Baseline: `1782337783609-realenhance-job_c11a8e7c-ef3b-48c9-9782-3bb41cc12023-1782337782818-ijp1zscim9.jpg`
- Staged: `1782337783609-realenhance-job_c11a8e7c-ef3b-48c9-9782-3bb41cc12023-1782337782818-ijp1zscim9-stage2.jpg`

**Baseline Extraction:**
- Openings: 1 (window W1 at wallIndex 0 or 3 with variance)
- Fixtures: 0
- Wall Descriptors: 2
  - Wall 0 (partial): "Continuous flat wall"
  - Wall 3 (partial): "Wall containing a single window"

**Graph Consensus Status**: UNSTABLE (graphConfidence: 0.5)
- Pass 1: Detected window at wallIndex 0
- Pass 2: Detected window at wallIndex 3
- Variance: wallIndex disagreement between passes

**Envelope Validator Decision**: PASS (Confidence: 1, Hard Fail: false)

**Gemini Response:**
```
"The architectural wall envelope, including the walls, ceiling, floor, 
and the window opening on the left wall, remains consistent with the 
baseline description. All observed changes are due to furniture, decor, 
and staging objects, which are permissible."
```

**Decision Path Trace:**
1. Baseline extraction: ✓ Completed (2 wall descriptors)
2. Geometric analysis: No significant geometric failures detected
3. Semantic review: Gemini evaluated images and returned PASS
4. Decision merge: No hard fail flag, so semantic decision stands

**Root Cause Analysis:**

The validator is returning PASS because:
1. **Geometric analysis shows no significant failures** (or data not being properly captured)
2. **Gemini's semantic evaluation** interprets the images as having the same architectural envelope
3. **Hard fail threshold not met** - confidence is 1, so hard fail flag is not set
4. **No escalation to pro model** - flash model decision is sufficient

**Why Expected FAIL?**
Based on the test image filenames and directory structure (baseline vs -stage2), this job was marked as expecting FAIL. However, Gemini's evaluation suggests the architectural envelope is indeed preserved, implying:
- Either the "expected FAIL" annotation is incorrect
- Or there ARE architectural changes that Gemini is not detecting despite wall descriptor context
- Or the images are being interpreted too liberally by Gemini's reasoning

---

### ❌ INCORRECT: job_bb029607 (Expected FAIL → Got PASS)

**Images Compared:**
- Baseline: `1782337783430-realenhance-job_bb029607-dcd8-4614-997c-406d2ed33142-1782337782828-5pbiinwfb7c.jpg`
- Staged: `1782337783430-realenhance-job_bb029607-dcd8-4614-997c-406d2ed33142-1782337782828-5pbiinwfb7c-stage2.jpg`

**Baseline Extraction:**
- Openings: 1
- Fixtures: 0
- Wall Descriptors: 3
  - Wall 0 (full): "Continuous wall with a wall-mounted AC unit"
  - Wall 1 (minimal): "Corner of a continuous wall"
  - Wall 3 (partial): "Wall with a large glass sliding door"

**Graph Consensus Status**: UNSTABLE (graphConfidence: 0.5)
- Pass 1-2: Opening detection varies in wallIndex, horizontalBand
- Variance present in signature and bbox

**Envelope Validator Decision**: PASS (Confidence: 1, Hard Fail: false)

**Gemini Response:**
```
"The permanent architectural envelope, including the front wall with 
the wall-mounted AC unit and the left wall with the large glass sliding 
door, remains unchanged. All visible wall planes and the ceiling/floor 
continuity match the baseline description."
```

**Root Cause Analysis:**

Identical pattern to job_c11a8e7c:
1. Baseline extraction successful with detailed wall descriptors (AC unit, sliding door)
2. Geometric analysis not detecting significant failures
3. Gemini semantic evaluation returns PASS
4. Wall descriptors are being properly included in prompt but not forcing FAIL decision

**Hypothesis:** 
Both jobs that should FAIL have specific architectural features noted in wall descriptors (window, AC unit, sliding door) that Gemini is explicitly checking for preservation. When Gemini verifies these features are still present, it returns PASS regardless of other potential differences.

The wall descriptors are working as designed - they're being extracted and interpolated into the prompt. However, Gemini's interpretation of "architectural preservation" may be too focused on the presence/absence of fixtures rather than structural geometry changes.

---

## Wall Descriptor Feature Assessment

### Extraction ✅ WORKING
All 5 jobs successfully extracted 2-3 wall descriptors each:
- Proper visibility classification (full/partial/minimal)
- Descriptive text capturing architectural features
- Integration with baseline type system

### Interpolation ✅ WORKING  
Descriptors properly formatted in envelope validator prompt:
```
Wall envelope descriptions (permanent architectural features):
- front / camera-facing wall (partial visibility): Wall containing a large window.
- right wall (partial visibility): Continuous flat wall.
```

Prompt lengths: 2,000-2,700 characters (sufficient context)

### Discrimination ⚠️ PARTIAL
- ✅ Correctly marks PASS for jobs with genuine architectural preservation
- ✅ Correctly identifies advisory signals (corner persistence failures)
- ❌ May not be sufficient to override semantic reasoning when Gemini evaluates images differently

---

## Decision Path for Incorrect Results

### Common Pattern in Failed Cases (job_c11a8e7c, job_bb029607)

```
Stage 1: Baseline Extraction
  ↓ (2 wall descriptors extracted, unstable graph consensus)
  
Stage 2: Geometric Analysis
  ↓ (Analysis runs but no critical geometric failures detected)
  
Stage 3: Semantic Review (Gemini Flash)
  ↓ Gemini Decision: PASS
    Reason: "Architectural features preserved"
    Confidence: 1
    
Stage 4: Decision Merge
  ↓ hardFail = false (geometric not severe enough)
  ↓ semanticDecision = "pass"
  ↓ Final: "pass" (no override)
```

### Why Not Escalating to Pro Model?
The decision is made at Flash model stage with confidence=1, so:
- No escalation flag set  
- Pro model (gemini-2.5-pro) not called
- Only semantic signal considered

---

## Potential Root Causes for Discrimination Gap

### 1. Graph Consensus Instability (Priority: HIGH)
Both failing jobs show graphConfidence=0.5 (unstable):
- Wall descriptor variance between extraction passes
- Could affect baseline authority
- May lead to weaker architectural anchoring

**Evidence:**
- job_c11a8e7c: wallIndex variance (0 vs 3)
- job_bb029607: wallIndex variance + bbox variance

### 2. Gemini Semantic Interpretation (Priority: HIGH)
Gemini may be interpreting "architectural envelope preservation" too narrowly:
- Checking if specific features (window, door, AC unit) still exist
- Not adequately weighting structural geometry changes
- Wall descriptors help but don't override semantic reasoning

**Evidence:**
- Both incorrect results: Gemini explicitly confirms architectural features are preserved
- Advisory signals from geometric analysis are noted but don't change final decision
- Confidence stays at 1 despite corner persistence failures

### 3. Geometric Analysis Data Capture (Priority: MEDIUM)
In diagnostic script, geometric metrics showing as N/A:
- Vertical edge delta may not be running on all images
- JPG format issues noted in job_81e485e7 logs
- Metrics not being properly passed through to decision logic

**Evidence:**
- job_81e485e7 logs show: "Input buffer contains unsupported image format"
- Geometric metrics show 0 values in diagnostic output

### 4. Hard Fail Threshold (Priority: MEDIUM)
Hard fail flag never set in any of these cases:
- May need tighter thresholds
- Corner persistence failures (0.377, 0.769, 0.893) not triggering hard fail
- Advisory signals emitted but not escalated

**Evidence:**
- All jobs: hardFail=false regardless of geometric failures
- Advisory signals present but treated as non-blocking

---

## Recommendations (Diagnostic Phase - No Modifications Yet)

### For Understanding the Discrimination Gap

1. **Verify Expected Outcomes**
   - Confirm job_c11a8e7c and job_bb029607 should actually FAIL
   - Review original test data annotations
   - Inspect images visually to determine if architectural changes are real

2. **Investigate Graph Consensus Variance**
   - Why do wall indices vary between extraction passes?
   - Does unstable baseline affect descriptor reliability?
   - Should we increase minimum consensus threshold?

3. **Test Gemini's Interpretation**
   - Send wall descriptors separately to Gemini for evaluation
   - Ask: "Given these architectural features, do both images represent the same room?"
   - Compare semantic evaluation with structural metrics

4. **Enhance Geometric Metrics Capture**
   - Verify vertical edge delta runs on all image formats
   - Ensure metrics are passed through decision logic
   - Test with pre-converted image formats if JPG causes issues

### For Validation of Wall Descriptor Feature

The wall descriptor feature itself is working correctly:
- ✅ Extraction from baseline images
- ✅ Prompt interpolation  
- ✅ Semantic context provision to Gemini
- ✅ Proper type integration

The discrimination gap is in the **envelope validator's decision logic**, not in wall descriptor functionality.

---

## Test Infrastructure

### Local Test Images Used
Located in: `/workspaces/RealEnhance-v2/Test Images/Envelope Test Images/`

Image Pairs:
1. job_c11a8e7c: ijp1zscim9.jpg + ijp1zscim9-stage2.jpg
2. job_bb029607: 5pbiinwfb7c.jpg + 5pbiinwfb7c-stage2.jpg
3. job_4a87f43b: o6v436g60or.jpg + o6v436g60or-stage2.jpg
4. job_dfbe98aa: 5lps3vswgap.jpg + 5lps3vswgap-stage2.jpg
5. job_81e485e7: xhrrckilo2.jpg + xhrrckilo2-stage2.jpg

### Diagnostic Artifacts
- Full report: `/workspaces/RealEnhance-v2/worker/reports/envelope-diagnostic-full-trace.json`
- Script: `/workspaces/RealEnhance-v2/worker/scripts/envelope-diagnostic-replay.ts`
- Execution log: `/tmp/diagnostic-run.log`

---

## Conclusion

The wall descriptor architecture has been successfully implemented and is functioning as designed. Wall descriptors are:
- ✅ Extracted from baseline images with architectural descriptions
- ✅ Integrated into envelope validator prompts
- ✅ Properly formatted with visibility classifications
- ✅ Providing context to semantic analysis

However, the overall envelope validator discrimination capability remains at 60% accuracy (3/5 correct). The gap is not caused by wall descriptor deficiency, but rather by:
1. Possible misalignment of expected vs. actual test outcomes
2. Graph consensus instability affecting baseline reliability
3. Gemini's semantic reasoning potentially over-weighting architectural feature presence vs. structural changes
4. Possible geometric analysis data capture issues with certain image formats

**This is a DIAGNOSTIC PASS ONLY** - No code modifications were made. This report identifies the specific decision paths and potential improvement areas for future investigation.
