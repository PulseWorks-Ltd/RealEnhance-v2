# Envelope Validator - Decision Path Trace Analysis

## Overview

This document traces the exact decision path for each job, from baseline extraction through final validator result, to identify where discrimination succeeded and where it failed.

---

## ✅ Correct Case: job_4a87f43b (PASS ← PASS)

```
INPUT
├─ Baseline: 1782337784628-...o6v436g60or.jpg
└─ Staged: 1782337784628-...o6v436g60or-stage2.jpg

┌─────────────────────────────────────────────────────────────┐
│ STAGE 1: BASELINE STRUCTURAL EXTRACTION                    │
│                                                             │
│ Extract: Pass 1 → Gemini analyzes baseline image          │
│ Result: 1 window detected at wallIndex 0                  │
│                                                             │
│ Extract: Pass 2 → Gemini re-analyzes for consensus       │
│ Result: 1 window detected at wallIndex 0                  │
│                                                             │
│ Graph Consensus: graphHash Match ✓                         │
│ → STABLE baseline (confidence suitable for authority)      │
│                                                             │
│ Wall Descriptors Extracted: 2                              │
│ ├─ Wall 1: "continuous flat wall"                          │
│ └─ Wall 2: "continuous flat wall"                          │
│                                                             │
│ ✓ Output: StructuralBaseline {                             │
│     openings: [W1@wallIdx0],                               │
│     wallDescriptors: [WD1, WD2]                            │
│   }                                                        │
└─────────────────────────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────────────────────────┐
│ STAGE 2: PROMPT INTERPOLATION                              │
│                                                             │
│ Build envelope context from baseline:                      │
│ - Opening reference: "W1: window, wall 0, left_third"     │
│ - Wall descriptions: [WD1, WD2] inserted                   │
│ - Architectural anchors provided                           │
│                                                             │
│ ✓ Interpolated Prompt Length: ~2000 chars                 │
│ ✓ Wall context: INCLUDED                                  │
└─────────────────────────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────────────────────────┐
│ STAGE 3: ENVELOPE GEOMETRIC ANALYSIS                       │
│                                                             │
│ Vertical Edge Delta:                                       │
│ - Compare baseline vs staged for vertical edges           │
│ - Retention metrics: ACCEPTABLE                            │
│ - Corner persistence: OK                                   │
│                                                             │
│ Result: geometricFailure = FALSE                           │
│ → No advisory signals emitted                              │
│ → Proceed to semantic analysis                             │
└─────────────────────────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────────────────────────┐
│ STAGE 4: SEMANTIC REVIEW (Gemini Flash)                    │
│                                                             │
│ Input: [Baseline image, Staged image, Prompt context]     │
│                                                             │
│ Gemini Analysis:                                           │
│ ✓ Verifies opening still present                          │
│ ✓ Confirms wall planes match                              │
│ ✓ Checks ceiling/floor continuity                         │
│ ✓ Validates architectural envelope preserved             │
│                                                             │
│ Decision: PASS                                             │
│ Confidence: 1.0                                            │
│ Reasoning: "consistent with baseline description"         │
└─────────────────────────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────────────────────────┐
│ STAGE 5: DECISION MERGE                                    │
│                                                             │
│ geometricSignal: GEOMETRIC_OK (no failures)               │
│ semanticSignal: SEMANTIC_PASS (Gemini says pass)         │
│ hardFailFlag: false (no critical geometric failures)     │
│                                                             │
│ Merge Logic:                                               │
│   if (hardFailFlag) return FAIL                            │
│   else return semanticSignal                               │
│                                                             │
│ Decision: PASS                                             │
│ Status: FINAL                                              │
│ Confidence: 1.0                                            │
│                                                             │
│ ✓ CORRECT: Expected PASS, returned PASS                  │
│ ✓ Discrimination: SUCCESS                                 │
└─────────────────────────────────────────────────────────────┘

OUTPUT: EnvelopeValidatorResult {
  status: 'pass',
  confidence: 1.0,
  issueType: 'none',
  hardFail: false
}
```

---

## ❌ Failed Case 1: job_c11a8e7c (FAIL ← PASS)

```
INPUT
├─ Baseline: 1782337783609-...ijp1zscim9.jpg
└─ Staged: 1782337783609-...ijp1zscim9-stage2.jpg

┌─────────────────────────────────────────────────────────────┐
│ STAGE 1: BASELINE STRUCTURAL EXTRACTION                    │
│                                                             │
│ Extract: Pass 1 → Gemini analyzes baseline image          │
│ Result: 1 window detected at wallIndex 0                  │
│         bbox: [0.1643, 0.301, 0.5031, 0.6223]            │
│                                                             │
│ Extract: Pass 2 → Gemini re-analyzes for consensus       │
│ Result: 1 window detected at wallIndex 3 ⚠️ VARIANCE!   │
│         bbox: [0.1802, 0.325, 0.4604, 0.6312]            │
│                                                             │
│ Graph Consensus Analysis:                                 │
│ ├─ graphHash: DIFFERENT between passes                    │
│ ├─ graphConfidence: 0.5 (UNSTABLE) ⚠️                    │
│ ├─ wallIndexVariance: 1 (0 vs 3)                          │
│ └─ bboxVariance: 1 (coordinates differ)                   │
│                                                             │
│ Wall Descriptors Extracted: 2                              │
│ ├─ Wall 0: "Continuous flat wall"                          │
│ └─ Wall 3: "Wall containing a single window"               │
│                                                             │
│ ⚠️ Output: StructuralBaseline {                            │
│     openings: [W1@wallIdx0_or_3], ← UNCERTAIN             │
│     wallDescriptors: [WD0, WD3],                          │
│     graphConfidence: 0.5 ← UNSTABLE                       │
│   }                                                        │
└─────────────────────────────────────────────────────────────┘
           ↓ [Authority is reduced due to instability]
┌─────────────────────────────────────────────────────────────┐
│ STAGE 2: PROMPT INTERPOLATION                              │
│                                                             │
│ Build envelope context from baseline:                      │
│ - Opening reference: "W1: window, wall ? (0 or 3)"       │
│ - Wall descriptions: [WD0: flat wall, WD3: window wall]  │
│ - Baseline authority: REDUCED (graphConfidence=0.5)      │
│                                                             │
│ ✓ Interpolated Prompt Length: ~2016 chars                │
│ ✓ Wall context: INCLUDED but UNCERTAIN                    │
│ ⚠️ Baseline authority: WEAK                               │
└─────────────────────────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────────────────────────┐
│ STAGE 3: ENVELOPE GEOMETRIC ANALYSIS                       │
│                                                             │
│ Vertical Edge Delta: [Data not properly captured]         │
│ - Analysis runs but metrics not propagated                │
│ - No geometric failures detected in this case             │
│                                                             │
│ Result: geometricFailure = FALSE ⚠️                        │
│ ✗ Potential Issue: Geometric changes may not be detected  │
└─────────────────────────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────────────────────────┐
│ STAGE 4: SEMANTIC REVIEW (Gemini Flash)                    │
│                                                             │
│ Input: [Baseline image, Staged image, Prompt context]     │
│        [Note: Baseline authority is uncertain]            │
│                                                             │
│ Gemini Analysis:                                           │
│ ? Looks at baseline image                                 │
│ ? Looks at staged image                                   │
│ ? Compares against wall descriptions                      │
│ ? Evaluates architectural features                        │
│                                                             │
│ Gemini Interpretation:                                    │
│ "The architectural wall envelope, including the walls,    │
│  ceiling, floor, and the window opening on the left wall,│
│  remains consistent with the baseline description."       │
│                                                             │
│ ✓ Window is still present (wall descriptor mentioned it)  │
│ ✓ Walls are continuous (wall descriptors confirmed)       │
│ ✓ Ceiling/floor look the same                             │
│ → All key architectural anchors from descriptors verified │
│                                                             │
│ Decision: PASS ← DECISION MADE HERE                       │
│ Confidence: 1.0                                            │
│ Reasoning: "all features match baseline description"      │
│                                                             │
│ ✗ PROBLEM: Gemini returned PASS despite expected FAIL     │
│ Possible causes:                                           │
│ a) Architectural changes are not visually obvious         │
│ b) Gemini's interpretation of "preserved" too liberal     │
│ c) Baseline authority (0.5) not factored into Gemini      │
│ d) Wall descriptors provided strong feature anchoring     │
└─────────────────────────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────────────────────────┐
│ STAGE 5: DECISION MERGE                                    │
│                                                             │
│ geometricSignal: GEOMETRIC_OK (no failures detected)      │
│ semanticSignal: SEMANTIC_PASS (Gemini decided PASS)      │
│ hardFailFlag: false (not triggered)                       │
│                                                             │
│ Merge Logic:                                               │
│   if (hardFailFlag) return FAIL  ← Not triggered          │
│   else return semanticSignal     ← Takes this path        │
│                                                             │
│ Decision: PASS                                             │
│ Status: FINAL                                              │
│ Confidence: 1.0                                            │
│                                                             │
│ ✗ INCORRECT: Expected FAIL, returned PASS                │
│ ✗ Discrimination: FAILED                                  │
└─────────────────────────────────────────────────────────────┘

OUTPUT: EnvelopeValidatorResult {
  status: 'pass',  ← SHOULD BE 'fail'
  confidence: 1.0,
  issueType: 'none',
  hardFail: false,
  advisorySignals: []
}

DECISION PATH FAILURE POINT:
┗━━ STAGE 4: Semantic Review
    ┗━━ Gemini decision: PASS
        ┗━━ No override mechanism to force FAIL
            ┗━━ Hard fail thresholds not met
                ┗━━ Final result: PASS (INCORRECT)
```

---

## ❌ Failed Case 2: job_bb029607 (FAIL ← PASS)

```
INPUT
├─ Baseline: 1782337783430-...5pbiinwfb7c.jpg
└─ Staged: 1782337783430-...5pbiinwfb7c-stage2.jpg

┌─────────────────────────────────────────────────────────────┐
│ STAGE 1: BASELINE STRUCTURAL EXTRACTION                    │
│                                                             │
│ Extract: Pass 1 → Gemini analyzes baseline image          │
│ Result: 1 opening detected at wallIndex 0                 │
│                                                             │
│ Extract: Pass 2 → Gemini re-analyzes for consensus       │
│ Result: 1 opening detected at wallIndex 1 ⚠️ VARIANCE!   │
│                                                             │
│ Graph Consensus:                                          │
│ ├─ graphHash: DIFFERENT between passes ⚠️                │
│ ├─ graphConfidence: 0.5 (UNSTABLE)                       │
│ ├─ wallIndexVariance: 1                                   │
│ ├─ bboxVariance: 1                                        │
│ └─ Extraction Calls: 2 (consensus mode)                   │
│                                                             │
│ Wall Descriptors Extracted: 3                              │
│ ├─ Wall 0 (full): "Continuous wall with wall-mounted AC"  │
│ ├─ Wall 1 (minimal): "Corner of a continuous wall"        │
│ └─ Wall 3 (partial): "Wall with large glass sliding door" │
│                                                             │
│ ⚠️ Output: StructuralBaseline {                            │
│     openings: [opening@wallIdx0_or_1], ← UNCERTAIN       │
│     wallDescriptors: [WD0, WD1, WD3],                    │
│     graphConfidence: 0.5 ← UNSTABLE                      │
│   }                                                        │
│                                                             │
│ NOTE: Rich wall descriptors including AC unit features    │
└─────────────────────────────────────────────────────────────┘
           ↓ [Unstable baseline, but rich descriptors]
┌─────────────────────────────────────────────────────────────┐
│ STAGE 2: PROMPT INTERPOLATION                              │
│                                                             │
│ Build envelope context:                                   │
│ - Opening: "opening (location uncertain)"                │
│ - Wall 0: "Continuous wall with wall-mounted AC unit"    │
│ - Wall 1: "Corner of a continuous wall"                   │
│ - Wall 3: "Wall with large glass sliding door"            │
│                                                             │
│ ✓ Interpolated Prompt: Strong architectural context      │
│ ✓ Specific features: AC unit, sliding door               │
│ ⚠️ Baseline authority: 0.5 (unstable)                    │
└─────────────────────────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────────────────────────┐
│ STAGE 3: ENVELOPE GEOMETRIC ANALYSIS                       │
│                                                             │
│ Vertical Edge Delta: [Analysis runs]                      │
│ - Geometric failures: Not significantly triggered         │
│ - Result: geometricFailure = FALSE ⚠️                    │
│                                                             │
│ ✗ PROBLEM: Geometric analysis may not capture changes    │
└─────────────────────────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────────────────────────┐
│ STAGE 4: SEMANTIC REVIEW (Gemini Flash)                    │
│                                                             │
│ Input: [Images + Rich descriptors of AC unit & door]      │
│                                                             │
│ Gemini Analysis:                                           │
│ "The permanent architectural envelope, including the     │
│  front wall with the wall-mounted AC unit and the left   │
│  wall with the large glass sliding door, remains         │
│  unchanged."                                              │
│                                                             │
│ ✓ AC unit still visible (WD0 mentioned it)               │
│ ✓ Sliding door still present (WD3 mentioned it)          │
│ ✓ Walls continuous (WD0, WD1 described them)             │
│ → Feature verification approach used by Gemini           │
│                                                             │
│ Decision: PASS ← DECISION MADE HERE                       │
│ Confidence: 1.0                                            │
│ Reasoning: "all architectural features preserved"         │
│                                                             │
│ ✗ PROBLEM: Semantic decision based on feature presence   │
│ ✗ Not on structural geometry changes                      │
│ ✗ Wall descriptors may have anchored features TOO WELL   │
└─────────────────────────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────────────────────────┐
│ STAGE 5: DECISION MERGE                                    │
│                                                             │
│ geometricSignal: GEOMETRIC_OK                             │
│ semanticSignal: SEMANTIC_PASS                             │
│ hardFailFlag: false                                        │
│                                                             │
│ Decision: PASS                                             │
│                                                             │
│ ✗ INCORRECT: Expected FAIL, returned PASS                │
│ ✗ Discrimination: FAILED                                  │
└─────────────────────────────────────────────────────────────┘
```

---

## Decision Path Anomalies

### Pattern 1: Unstable Graph Consensus (Affects Both Failed Cases)
**When**: Baseline extraction shows graphConfidence=0.5
**Impact**: 
- Baseline authority weakened
- Wall indices differ between passes
- Geometric anchoring becomes uncertain

**Result**: Gemini may over-weight explicit wall descriptors as source of truth instead of prioritizing structural geometry

### Pattern 2: Gemini Feature Verification Approach
**Observed**: Gemini explicitly confirms:
- "AC unit still visible"
- "Sliding door still present"  
- "Window still there"

**Problem**: This feature-checking approach doesn't validate structural changes, only architectural fixture presence

**Solution**: Either provide geometric metrics to Gemini or escalate to pro model when geometric analysis inconclusive

### Pattern 3: Hard Fail Threshold Never Triggered
**Expected**: hardFail = true when significant geometric changes detected
**Observed**: hardFail = false in ALL cases
**Implication**: 
- Thresholds too high
- Geometric analysis not reporting failures properly
- Or geometric failures genuinely not present in test images

---

## Key Insight: Wall Descriptors' Role in Decision Path

### ✅ Positive Impact (Correct Cases)
- Provide architectural context that aligns with actual structure
- Help Gemini confirm "baseline preserved"
- Enable consistent discrimination

### ⚠️ Potential Issue (Failed Cases)
- May over-anchor Gemini's evaluation to feature presence
- If AC unit/door/window still present, Gemini returns PASS
- Doesn't force evaluation of structural geometry changes
- Creates a "feature checkbox" approach instead of geometric validation

---

## Recommendation for Decision Path Investigation

**Priority 1**: Verify expected FAIL outcomes are correct
- Visually inspect test images for architectural changes
- Confirm job_c11a8e7c and job_bb029607 should actually result in FAIL

**Priority 2**: Investigate Gemini's semantic reasoning
- Is Gemini evaluating architectural features or structural geometry?
- Should wall descriptors influence semantic decision weighting?
- Need tighter coupling between geometric and semantic signals

**Priority 3**: Address baseline instability
- Why graphConfidence = 0.5 in most cases?
- Should we require higher consensus before using baseline?
- Effect on wall descriptor reliability

**Priority 4**: Validate hard fail triggers
- Are geometric failure thresholds appropriate?
- Should geometric failures always escalate to pro model?
- When should hard fail override semantic decision?
