# Wall Descriptor Envelope Validator Regression Test Analysis

## Executive Summary

**Test Status**: ✗ INCONCLUSIVE  
**Results**: 0/1 testable jobs correct (1/5 jobs had test data available)

### Regression Test Execution Results

| Job | Expected | Actual | Status | Wall Descriptors | Notes |
|-----|----------|--------|--------|-----------------|-------|
| job_c11a8e7c | FAIL | PASS | ✗ MISMATCH | 2 extracted | Evidence shows envelope change (37.7% corner retention) but marked PASS |
| job_bb029607 | FAIL | SKIPPED | ⊗ NO DATA | - | Stage 2 URL not available |
| job_4a87f43b | PASS | SKIPPED | ⊗ NO DATA | - | Stage 2 URL not available |
| job_dfbe98aa | PASS | SKIPPED | ⊗ NO DATA | - | Stage 2 URL not available |
| job_81e485e7 | PASS | SKIPPED | ⊗ NO DATA | - | Stage 2 URL not available |

## Detailed Finding: job_c11a8e7c

### Test Configuration
- **Baseline Image**: `/workspaces/RealEnhance-v2/tmp/replay_c11a8e7c/before.jpg` (Stage 1A, 468 KB)
- **Staged Image**: `/workspaces/RealEnhance-v2/tmp/replay_c11a8e7c/after.jpg` (Stage 2, 544 KB)
- **Comparison**: Proper Stage 1A vs Stage 2 image pair ✓

### Wall Descriptor Extraction ✓

Successfully extracted 2 wall descriptors with architectural descriptions:

```json
{
  "wallIndex": 0,
  "visibility": "partial",
  "description": "Wall containing a large window."
},
{
  "wallIndex": 1,
  "visibility": "partial",
  "description": "Continuous flat wall."
}
```

- **Baseline**: 1 opening (Window W1), 0 fixtures, 2 wall descriptors
- **Graph Confidence**: 0.5 (unstable - 2 passes with variance in wallIndex 0 vs 3)
- **Baseline Method**: graph_consensus
- **Duration**: 39,480 ms (2 Gemini calls)

### Envelope Validator Prompt Interpolation ✓

Wall descriptions successfully injected into prompt:

```
Wall envelope descriptions (permanent architectural features):
- front / camera-facing wall (partial visibility): Wall containing a large window.
- right wall (partial visibility): Continuous flat wall.
```

**Prompt Size**: 2,016 characters (sufficient context)

### Envelope Validation Results ✗

Despite evidence of architectural changes, validator returned **PASS** instead of expected **FAIL**:

#### Geometric Failures Detected:
- **Vertical Edge Loss**: TRUE
- **Corner Persistence Failure**: TRUE
- **Worst Retention**: 37.7% (severe loss on column 257)
- **Junction Impact**: 19 junctions analyzed, 1 showed severe persistence failure

#### Gemini Decision Analysis:
```json
{
  "status": "pass",  // ← UNEXPECTED: should consider geometric failures
  "reason": "The staged image retains the exact same permanent architectural wall envelope...",
  "confidence": 1,
  "issueType": "envelope_vertical_edge_loss",  // ← Correct detection
  "hardFail": false,  // ← PROBLEM: geometric failures not escalated to hard fail
  "advisorySignals": [
    "envelope_vertical_edge_loss",
    "envelope_corner_flattened"
  ]
}
```

### Root Cause Analysis

The test reveals three potential issues:

1. **Decision Logic Gap**: Geometric failures (vertical edge loss, corner persistence < 50%) are detected but not properly translated to FAIL status
   - Issue type correctly identifies `envelope_vertical_edge_loss`
   - But `hardFail: false` and `status: pass` contradict the severity
   
2. **Wall Descriptor Influence**: Wall descriptions were successfully extracted and interpolated, but Gemini reasoning states "retains exact same wall envelope"
   - This suggests the wall descriptor context may not be overriding the geometric reasoning
   - OR the Gemini prompt interpretation isn't fully considering architectural context
   
3. **Graph Consensus Instability**: Baseline showed wallIndex variance (0 vs 3) with only 50% confidence
   - This instability may affect the baseline authority
   - Two-pass consensus is borderline for making authoritative architectural claims

### What Works
✓ Wall descriptor extraction: 2 descriptors with visibility and description fields  
✓ Prompt interpolation: Wall descriptions properly formatted in validator context  
✓ Baseline extraction: Multiple passes with graph variance tracking  
✓ Geometric analysis: Vertical edge delta and corner persistence correctly measured  
✓ API integration: Both gemini-2.5-flash and fallback flow operational  

### What Needs Investigation

❌ **Decision Merger**: Why do detected geometric failures not trigger FAIL status?  
- Check: [worker/src/validators/envelopeValidator.ts](worker/src/validators/envelopeValidator.ts#L300-L350) - decision merge logic
- Verify: Hard fail thresholds for corner persistence failures
- Validate: Advisory signals being properly converted to decision impact

❌ **Gemini Reasoning**: Gemini states "exact same wall envelope" despite:
- 19 junction changes
- 37.7% corner persistence failure
- Vertical edge count doubled (10,785 → 20,205)
- Check: Prompt clarity on geometric change implications
- Consider: Whether wall descriptions need to reinforce geometric interpretation

❌ **Confidence Scoring**: Why is confidence=1 (maximum) when geometric failures detected?
- Suggests wall context not affecting confidence model
- May indicate scoring logic runs before geometric checks

## Data Availability Issue

Only 1 out of 5 jobs had Stage 2 test data available locally. The other 4 jobs are blocked on:
- **job_bb029607**: No local or S3 Stage 2 URL available
- **job_4a87f43b**: No local or S3 Stage 2 URL available  
- **job_dfbe98aa**: No local or S3 Stage 2 URL available
- **job_81e485e7**: No local or S3 Stage 2 URL available

Attempted Stage 2 URL inference (replacing "1A" with "2" in S3 paths) returned 404.

## Recommendations

1. **Immediate**: Investigate decision merge logic in envelope validator
   - Focus on: Why geometric failures don't trigger FAIL
   - Verify: Corner persistence threshold (currently < 50% doesn't force hard fail)
   - Consider: Adding explicit geometric failure check before Gemini reasoning

2. **Follow-up**: Obtain Stage 2 URLs for remaining 4 test jobs
   - Would allow full regression test across all 5 production scenarios
   - Enable validation of wall descriptor impact across PASS and FAIL cases

3. **Enhancement**: Strengthen Gemini prompt to explicitly weight geometric evidence
   - Current prompt: Focuses on wall continuity
   - Enhancement: Emphasize that 37.7% corner retention indicates structural change
   - Consideration: Add structured geometric findings to prompt input

4. **Validation**: Test with simpler architectural changes
   - Current test: Significant geometry differences (2x vertical edge count)
   - Next: Test with subtle wall changes to verify discrimination sensitivity

## Test Artifacts

- **Full JSON Report**: `/workspaces/RealEnhance-v2/regression-test-result.json`
- **Test Script**: `/workspaces/RealEnhance-v2/worker/scripts/replay-5-jobs-envelope-with-wall-descriptors.ts`
- **Test Images**: `/workspaces/RealEnhance-v2/tmp/replay_c11a8e7c/`
- **Build Output**: `/workspaces/RealEnhance-v2/worker/dist/`

## Conclusion

Wall descriptor feature is **functionally implemented** (extraction, interpolation, prompt inclusion all working), but the envelope validator's **decision logic may not be appropriately leveraging** the geometric evidence combined with wall context. The regression test is inconclusive due to limited test data, but the one testable case reveals a potential discrimination gap.
