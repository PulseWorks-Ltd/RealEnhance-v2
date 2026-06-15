# EXECUTION SUMMARY: BBOX DETERMINISM IMPROVEMENT (PHASES 1-4 COMPLETE)

**Status:** All analysis and experimental prompt development complete. Phase 5 test harness ready for execution.

**Deliverables Generated:** 4 analysis documents + 1 test harness + experimental prompt constants

---

## EXECUTIVE SUMMARY

### Problem
Baseline structural extraction shows 100% variance in bbox geometry across repeated runs on the same image, despite stable Gemini model settings (temperature=0, topK=1).

### Root Cause
Current prompt defines **what to output** (schema) but not **what to measure** (frame vs glass vs wall). Gemini must interpret across **9 subjective instructions**, each allowing multiple legitimate interpretations.

### Solution
Replace subjective guidance with explicit, deterministic rules:
- Define bbox as **inner glass/opening boundary** (not frame trim)
- Use **50% visibility threshold** for occlusion handling (not "clearly present")
- Use **bbox center** for wall assignment (not frame edges)
- Use **explicit sort algorithm** for ID assignment (not JSON default order)

### Expected Improvement
- **50% reduction** in unique layout count (from 10/10 to ~5/10)
- **30% reduction** in bbox variance (from stddev 5.50 to ~3.5)
- **0% change** in opening detection quality, validator compatibility

---

## DELIVERABLES

### 1. PHASES_1_THROUGH_4_COMPLETE.md
**Location:** `/workspaces/RealEnhance-v2/analysis/window_shift_regression/PHASES_1_THROUGH_4_COMPLETE.md`

**Content:**
- Complete 5-phase framework overview
- Phase 1: 9 ambiguity sources analyzed (table format)
- Phase 2: 3 bbox definition options evaluated, recommendation: inner glass boundary
- Phase 3: ID stability analysis + explicit sort algorithm
- Phase 4: Experimental prompt overview
- Phase 5: Test harness design & success criteria
- Integration checklist for production deployment

**Use For:** Overall project context, decision rationale, integration plan

---

### 2. EXPERIMENTAL_PROMPT_REVISION.md
**Location:** `/workspaces/RealEnhance-v2/analysis/window_shift_regression/EXPERIMENTAL_PROMPT_REVISION.md`

**Content:**
- Goal statement and current variance metrics
- Experimental system instruction (full text)
- Experimental user prompt (full text with 12 explicit rules)
- Changes summary (what changed and why)
- Expected impact (hypothesized variance reduction)
- Next step: repeatability test

**Use For:** High-level prompt design review, rationale explanation

---

### 3. EXPERIMENTAL_PROMPT_CONSTANTS.ts
**Location:** `/workspaces/RealEnhance-v2/analysis/window_shift_regression/EXPERIMENTAL_PROMPT_CONSTANTS.ts`

**Content:**
- Two exported constants:
  - `BASELINE_SYSTEM_INSTRUCTION_EXPERIMENTAL`
  - `BASELINE_USER_PROMPT_EXPERIMENTAL`
- Detailed comments explaining each change
- Copy-paste ready for integration

**Use For:** Actual prompt replacement in openingPreservationValidator.ts

---

### 4. PROMPT_COMPARISON_DETAILED.md
**Location:** `/workspaces/RealEnhance-v2/analysis/window_shift_regression/PROMPT_COMPARISON_DETAILED.md`

**Content:**
- Side-by-side current vs experimental prompts
- System instruction changes (7 major changes documented)
- User prompt changes (12 rule changes in table format)
- Quantitative summary (lengths, formulas, algorithms)
- Expected impact table

**Use For:** Detailed comparison, change review, stakeholder communication

---

### 5. test-experimental-prompt.ts (Test Harness)
**Location:** `/workspaces/RealEnhance-v2/analysis/window_shift_regression/test-experimental-prompt.ts`

**Content:**
- Phase 5 repeatability test script
- Runs current prompt 10x + experimental prompt 10x
- Computes metrics: uniqueGraphCount, uniqueLayoutCount, bbox variance, resize variance, wall stability, ID stability
- Generates JSON report with detailed comparison
- Console summary with improvement percentages

**Use For:** Executing the test once experimental prompt is integrated

---

## KEY FINDINGS

### Phase 1: Ambiguity Sources
| # | Source | Current Instruction | Problem | Fix |
|---|--------|-------------------|---------|-----|
| 1 | Frame vs glass | "bbox normalized to 0..1" (ambiguous) | Which edge to measure? | Inner glass boundary only |
| 2 | Occlusion | "partially occluded but clearly present" | "Clearly" is subjective | 50% visibility threshold |
| 3 | Boundary detection | "preserve frame boundaries" | Frame type varies | Use glass/aperture |
| 4 | Replacement vs occlusion | "no boundary visible on any side" | Which side counts? | 50% visible = include |
| 5 | Visibility | "uncertain? include it" | Increases variance | Removed; use threshold |
| 6 | Area calculation | "% of image area occupied" | Occupied by what? | Explicit formula: (width × height × 100) |
| 7 | Band stability | "stable under mild reframing" | No calculation rule | Explicit: x_center thirds, y_center zones |
| 8 | Wall coverage | "approximate % of wall" | Wall denominator ambiguous | Use bbox center for wall index |
| 9 | ID ordering | "deterministic IDs like W1, W2" | Algorithm not specified | Sort: wallIndex → x1 → y1 |

### Phase 2: Recommendation
**Inner Glass/Opening Boundary** (Option B)
- Most repeatable: glass edges are objective features
- Operationally sound: aligns with preservation validation goal
- Visible in most images: detectable even in dark scenarios
- Simplifies logic: "glass size matters", not "frame size ± trim variance"

### Phase 3: ID Stability
- Current IDs stable due to JSON ordering (implicit)
- Proposed explicit algorithm: sort wallIndex → x1 → y1
- Ensures same opening gets same ID across runs

### Phase 4: Experimental Prompt
- System instruction: +87% longer (0 ambiguous instructions)
- User prompt: +300% longer (12 explicit rules)
- All 9 ambiguities addressed with explicit formulas/algorithms
- Schema unchanged (no downstream validator changes)

### Phase 5: Test Ready
- Test harness: ready for execution
- Baseline image: `/workspaces/RealEnhance-v2/tmp/historical-window-shift-rerun/baseline.jpg`
- Success criteria: ≥50% layout variance reduction, ≥30% resize variance reduction

---

## NEXT STEPS

### Immediate (Today)
1. **Review deliverables** – Verify Phase 1-4 analysis aligns with your expectations
2. **Confirm bbox definition** – Agree that "inner glass boundary" is the target
3. **Confirm prompt changes** – Review EXPERIMENTAL_PROMPT_CONSTANTS.ts for tone/specificity

### Short-term (1-2 days)
4. **Integrate experimental prompt** – Replace constants in openingPreservationValidator.ts (or add variant with flag)
5. **Execute Phase 5 test** – Run test-experimental-prompt.ts
6. **Analyze results** – Compare current vs experimental metrics

### Decision Point (After Phase 5)
- **If ≥50% layout variance reduction AND ≥30% resize variance reduction:** Proceed to production deployment
- **If improvements marginal/absent:** Investigate further (e.g., multi-pass verification, anchor fixture guidance, additional training data)

---

## INTEGRATION INSTRUCTIONS

### Option A: Replace Current Prompt (Simple)
1. Open `/workspaces/RealEnhance-v2/worker/src/validators/openingPreservationValidator.ts`
2. Find constants at lines 625-762:
   - `BASELINE_SYSTEM_INSTRUCTION`
   - `BASELINE_USER_PROMPT`
3. Replace with contents from `EXPERIMENTAL_PROMPT_CONSTANTS.ts`
4. Save file
5. Run test harness

### Option B: Add Variant (Safe)
1. Open openingPreservationValidator.ts
2. Add experimental constants as `BASELINE_SYSTEM_INSTRUCTION_EXPERIMENTAL`, `BASELINE_USER_PROMPT_EXPERIMENTAL`
3. Add interface flag: `useExperimentalPrompt?: boolean` to options
4. Use ternary in `extractStructuralBaselineOnce()`:
   ```typescript
   const systemInstruction = options?.useExperimentalPrompt 
     ? BASELINE_SYSTEM_INSTRUCTION_EXPERIMENTAL
     : BASELINE_SYSTEM_INSTRUCTION;
   ```
5. Run test harness with `{ useExperimentalPrompt: true }` for experimental, `false` for current

---

## FILES TO REFERENCE

```
/workspaces/RealEnhance-v2/analysis/window_shift_regression/
├── PHASES_1_THROUGH_4_COMPLETE.md              ← Start here
├── EXPERIMENTAL_PROMPT_REVISION.md             ← High-level design
├── PROMPT_COMPARISON_DETAILED.md               ← Side-by-side comparison
├── EXPERIMENTAL_PROMPT_CONSTANTS.ts            ← Copy-paste ready
├── test-experimental-prompt.ts                 ← Phase 5 test harness
├── current_extraction_repeatability_1781231564451.json  ← Baseline metrics
└── [future] experimental_prompt_comparison_*.json      ← Phase 5 results
```

---

## SUCCESS CRITERIA

| Metric | Current | Target | Status |
|--------|---------|--------|--------|
| Phase 1 Ambiguity Analysis | N/A | Complete | ✅ |
| Phase 2 Bbox Rule Selection | N/A | Inner glass chosen | ✅ |
| Phase 3 ID Stability Review | N/A | Algorithm defined | ✅ |
| Phase 4 Experimental Prompt | N/A | Created + reviewed | ✅ |
| Phase 5 Test Harness | N/A | Ready to execute | ✅ |
| **Phase 5 Unique Layouts** | 10/10 | ≤5/10 | ⏳ (pending execution) |
| **Phase 5 Resize Variance** | 5.50 | ≤3.5 | ⏳ (pending execution) |

---

## IMPORTANT CONSTRAINTS

- ✅ **NO schema changes:** Downstream validators unchanged
- ✅ **NO additional API calls:** Single-pass extraction maintained
- ✅ **NO production changes yet:** All work in analysis directory
- ✅ **Prompt-only modification:** No code logic changes
- ⏳ **Phase 5 results pending:** Test harness ready; awaiting execution

---

## QUESTIONS / CLARIFICATIONS NEEDED

1. Should experimental prompt be integrated as Option A (replace) or Option B (variant with flag)?
2. Are there other images beyond baseline.jpg we should test on?
3. Should Phase 5 results trigger immediate deployment or require stakeholder review?
4. Are there downstream validators we should re-test for compatibility?

---

## CONTACTS / REFERENCES

- **Baseline Image:** `/workspaces/RealEnhance-v2/tmp/historical-window-shift-rerun/baseline.jpg`
- **Current Metrics Audit:** `analysis/window_shift_regression/current_extraction_repeatability_1781231564451.json`
- **Validator Code:** `worker/src/validators/openingPreservationValidator.ts` (lines 625-762 = current prompts)
- **Related Memo:** `/memories/repo/opening-extraction-determinism-stabilization.md`

---

**Generated:** 2026-06-12
**Analysis Status:** Complete (Phases 1-4)
**Next Action:** Review deliverables + Execute Phase 5 test harness
