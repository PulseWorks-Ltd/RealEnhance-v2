# Envelope Validator Regression Test - Quick Reference Summary

**Test Date**: 2026-06-26  
**Total Jobs**: 5  
**Accuracy**: 3/5 (60%)

## Quick Results Table

| Job ID | Expected | Actual | ✓/✗ | Wall Descriptors | Graph Confidence | Hard Fail | Gemini Confidence | Issue Type |
|--------|----------|--------|-----|-----------------|------------------|-----------|-------------------|------------|
| job_c11a8e7c | FAIL | PASS | ✗ | 2 | 0.5 (unstable) | NO | 1.0 | none |
| job_bb029607 | FAIL | PASS | ✗ | 3 | 0.5 (unstable) | NO | 1.0 | none |
| job_4a87f43b | PASS | PASS | ✓ | 2 | - | NO | 1.0 | none |
| job_dfbe98aa | PASS | PASS | ✓ | 3 | 0.5 (unstable) | NO | 1.0 | none |
| job_81e485e7 | PASS | PASS | ✓ | 3 | 0.5 (unstable) | NO | 1.0 | none |

## Discrimination Summary

**Correct PASS Cases**: 3/3 (100%)
- All jobs expecting PASS were correctly identified as PASS

**Correct FAIL Cases**: 0/2 (0%)
- Both jobs expecting FAIL were incorrectly returned as PASS

## Wall Descriptor Extraction Summary

| Job | Wall 0 | Wall 1 | Wall 2 | Wall 3 | Notes |
|-----|--------|--------|--------|--------|-------|
| job_c11a8e7c | (partial) "Continuous flat wall" | - | - | (partial) "Wall containing a single window" | 2 descriptors extracted |
| job_bb029607 | (full) "Continuous wall with a wall-mounted AC unit" | (minimal) "Corner of a continuous wall" | - | (partial) "Wall with a large glass sliding door" | 3 descriptors extracted |
| job_4a87f43b | - | (continuous flat wall) | (continuous flat wall) | - | 2 descriptors extracted |
| job_dfbe98aa | (full) "Continuous flat wall" | (minimal) "Continuous flat wall, visible at corner" | - | (partial) "Wall containing one window" | 3 descriptors extracted |
| job_81e485e7 | (partial) "Wall contains a door on the left, a window in the center..." | (minimal) "Continuous wall corner" | - | (partial) "Wall contains a full-height walkthrough opening" | 3 descriptors + 2 fixtures |

## Decision Path Analysis - Failed Cases

### job_c11a8e7c
```
BASELINE EXTRACTION
├─ Openings: 1 (window, wallIndex variance 0↔3)
├─ Graph Confidence: 0.5 (UNSTABLE)
└─ Wall Descriptors: 2 ✓

GEOMETRIC ANALYSIS
├─ Vertical Edge Loss: false
├─ Corner Persistence: false
└─ No critical failures

GEMINI SEMANTIC (Flash)
├─ Status: PASS
├─ Confidence: 1.0
├─ Reason: "architectural wall envelope remains consistent"
└─ Advisory Signals: none

DECISION MERGE
├─ Hard Fail: NO
├─ Geometric Signal: GEOMETRIC_OK
├─ Semantic Signal: SEMANTIC_PASS
└─ FINAL: PASS ← Expected: FAIL ✗
```

### job_bb029607
```
BASELINE EXTRACTION
├─ Openings: 1 (wallIndex variance 0↔1)
├─ Graph Confidence: 0.5 (UNSTABLE)
└─ Wall Descriptors: 3 ✓ (AC unit, corner, sliding door)

GEOMETRIC ANALYSIS
├─ Vertical Edge Loss: false
├─ Corner Persistence: false
└─ No critical failures

GEMINI SEMANTIC (Flash)
├─ Status: PASS
├─ Confidence: 1.0
├─ Reason: "permanent architectural envelope remains unchanged"
└─ Advisory Signals: none

DECISION MERGE
├─ Hard Fail: NO
├─ Geometric Signal: GEOMETRIC_OK
├─ Semantic Signal: SEMANTIC_PASS
└─ FINAL: PASS ← Expected: FAIL ✗
```

## Key Findings

### Wall Descriptor Feature ✅ OPERATIONAL
- **Extraction**: All jobs extracted 2-3 descriptors with architectural descriptions
- **Interpolation**: Properly formatted into validator prompts (2000-2700 chars)
- **Type Integration**: Correct visibility classifications (full/partial/minimal)
- **Context Provision**: Descriptions included in Gemini semantic prompts

### Discrimination Gap ⚠️ IDENTIFIED
- **FAIL Detection**: 0% (0/2 correct) - Both jobs marked as FAIL should have been detected
- **PASS Detection**: 100% (3/3 correct) - All jobs marked as PASS were correctly identified

### Root Cause Indicators

1. **Graph Consensus Instability** (Affects 4/5 jobs)
   - graphConfidence = 0.5 in most cases
   - Wall index variance between extraction passes
   - May weaken baseline authority

2. **Gemini Semantic Interpretation**
   - Focuses on presence/absence of architectural features
   - May not weight structural geometry changes heavily
   - Wall descriptors help but don't force FAIL when geometry is OK

3. **Geometric Analysis Data**
   - Vertical edge delta results not being captured in failing cases
   - Some image format processing issues (JPG)

4. **Hard Fail Threshold**
   - Never triggered in any test case
   - Corner persistence failures (0.377-0.893) not meeting hard fail criteria

## Recommendations

### For Next Investigation (if required)
1. Verify expected FAIL outcomes are correct for those 2 jobs
2. Investigate graph consensus variance causing 0.5 confidence
3. Test geometric analysis on all image formats
4. Evaluate hard fail thresholds for corner persistence
5. Compare Gemini's semantic output with structural metrics

### Current Status
✅ **Wall descriptor feature is working as designed**
⚠️ **Envelope validator discrimination needs investigation** (not related to wall descriptors)

---

## Test Artifacts

- **Full Diagnostic Report**: [ENVELOPE_VALIDATOR_DIAGNOSTIC_REPORT.md](ENVELOPE_VALIDATOR_DIAGNOSTIC_REPORT.md)
- **JSON Report with Full Traces**: [envelope-diagnostic-full-trace.json](envelope-diagnostic-full-trace.json)
- **Diagnostic Script**: `/workspaces/RealEnhance-v2/worker/scripts/envelope-diagnostic-replay.ts`
- **Test Images**: `/workspaces/RealEnhance-v2/Test Images/Envelope Test Images/`
