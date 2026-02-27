# Validator Architecture Map (Stage 1A → 1B → 2)

## Scope
This document defines the validator inventory currently used by the worker pipeline, with:
- canonical names,
- mapping to team-friendly names,
- exact execution order,
- and what each validator does.

---

## Quick Answer
You currently have **more** than the 6 validator groups you listed.

Your list is directionally correct, but it collapses a few distinct validators into single buckets (especially in Stage 1A and Stage 2).

---

## Canonical Validator Inventory

## Stage 1A

### 1) Stage 1A Content-Diff Validator
- **Code**: `worker/src/pipeline/stage1A.ts` (`runStage1AContentDiff` usage)
- **Purpose**: Compares Stage 1A primary output against expected content behavior; can trigger reroute/fallback policy.
- **Type**: local, deterministic check.

### 2) Stage 1A Structural Validator
- **Code**: `worker/src/validators/stage1AValidator.ts` (`validateStage1AStructural`), invoked from `worker/src/pipeline/stage1A.ts`
- **Purpose**: Ensures architectural classes stay consistent (walls/windows/doors/floor, plus exterior structural classes).
- **Type**: local structural check; fail-open behavior in Stage 1A pipeline path.

### 3) Stage 1A Black-Border Fatal Guard (sanity gate)
- **Code**: `worker/src/worker.ts` (`detectBlackBorder`)
- **Purpose**: Hard safety check to fail malformed Stage 1A output.
- **Type**: local hard guard (not semantic classification, but operationally a validator gate).

---

## Stage 1B

### 4) Stage 1B Local Structural Signals
- **Code**: `worker/src/worker.ts` (`detectWallPlaneExpansion`, `runSemanticStructureValidator`, opening delta logic)
- **Purpose**: Produces local evidence/signals (wall expansion, opening drift) used for escalation and decisions.
- **Type**: local evidence gate.

### 5) Stage 1B Gemini Structure Validator
- **Code**: `worker/src/validators/geminiSemanticValidator.ts` (`validateStage1BStructure`)
- **Purpose**: Gemini adjudication for Stage 1B structural integrity with opening significance/tolerance handling.
- **Type**: Gemini adjudicator for Stage 1B.

### 6) Stage 1B Declutter Heuristic Validator (log-only)
- **Code**: `worker/src/worker.ts` (`estimateClutterHeuristic`)
- **Purpose**: Scores declutter effectiveness (signal/observability, non-blocking).
- **Type**: local advisory heuristic.

---

## Stage 2

### 7) Stage 2 Unified Local Validator Stack
- **Code**: `worker/src/validators/runValidation.ts` (`runUnifiedValidation`)
- **Includes**:
  - windows validator,
  - walls validator,
  - global edge IoU,
  - structural-mask IoU (`validateStage2Structural`),
  - line-edge validator,
  - anchor-region validators,
  - stage-aware validator path (when enabled).
- **Purpose**: Primary local structural evidence + score + reasons/warnings.
- **Type**: local multi-check orchestrator.

### 8) Stage 2 Gemini Semantic Validator (inside unified validation)
- **Code**: `worker/src/validators/runValidation.ts` → `runGeminiSemanticValidator`
- **Purpose**: Gemini semantic adjudication integrated into unified pass (policy-driven: always/on_local_fail/never).
- **Type**: Gemini semantic adjudicator in unified pipeline.

### 9) Stage 2 Sharp Semantic Validator (post-unified signal)
- **Code**: `worker/src/validators/semanticStructureValidator.ts`, called from `worker/src/worker.ts`
- **Purpose**: Local semantic openings/wall drift signal; contributes reasons for confirm/composite logic.
- **Type**: local advisory signal.

### 10) Stage 2 Masked-Edge Validator (post-unified signal)
- **Code**: `worker/src/validators/maskedEdgeValidator.ts`, called from `worker/src/worker.ts`
- **Purpose**: Local masked architectural drift/openings signal; contributes reasons for confirm/composite logic.
- **Type**: local advisory signal.

### 11) Stage 2 Composite Local Validator
- **Code**: `worker/src/worker.ts` (`evaluateCompositeLocalValidator` + retry/fallback handling)
- **Purpose**: Combines local structural metrics into PASS/FAIL for retry/fallback behavior.
- **Type**: local composite decision layer.

### 12) Stage 2 Topology Gemini Check
- **Code**: `worker/src/worker.ts` (`runStructuralTopologyCheck`)
- **Purpose**: Separate Gemini topology pass to detect recess/plane/corner topology violations.
- **Type**: independent Gemini topology validator.

### 13) Stage 2 Final Gemini Confirmation Validator
- **Code**: `worker/src/validators/confirmWithGeminiStructure.ts` (`confirmWithGeminiStructure`)
- **Prompt source**: `buildFinalFixtureConfirmPrompt` in `worker/src/validators/geminiSemanticValidator.ts`
- **Purpose**: Final adjudication pass using local findings + evidence-gated context.
- **Type**: final Gemini confirmation layer.

---

## Mapping to Your Names

## Your Name: Stage 1A local validators
- **Recommended split**:
  - Stage 1A Content-Diff Validator
  - Stage 1A Structural Validator
  - Stage 1A Black-Border Guard

## Your Name: Stage 1B Gemini validator
- **Matches**: Stage 1B Gemini Structure Validator
- **Plus**: Stage 1B has extra local signal layers (wall/opening + declutter heuristic).

## Your Name: Stage 2 local validators
- **Recommended split**:
  - Stage 2 Unified Local Validator Stack
  - Stage 2 Sharp Semantic Validator
  - Stage 2 Masked-Edge Validator

## Your Name: Stage 2 composite validator
- **Matches**: Stage 2 Composite Local Validator

## Your Name: Stage 2 Gemini validator
- **Matches**: Stage 2 Gemini Semantic Validator (inside unified validation)

## Your Name: Final validator / Gemini semantic validator
- **Recommended split**:
  - Stage 2 Gemini Semantic Validator (unified pass)
  - Stage 2 Final Gemini Confirmation Validator (separate final pass)

---

## Execution Order (Simplified)

1. Stage 1A generation
2. Stage 1A content-diff + structural checks + black-border guard
3. Stage 1B generation
4. Stage 1B local structural signals
5. Stage 1B Gemini structure adjudication
6. Stage 1B declutter heuristic logging
7. Stage 2 generation attempt
8. Stage 2 unified local validator stack
9. Stage 2 local post-signals (semantic + masked-edge)
10. Stage 2 composite local decision (retry/fallback path)
11. Stage 2 topology Gemini check (when threshold-triggered)
12. Stage 2 Gemini semantic adjudication (policy-driven unified pass)
13. Stage 2 final Gemini confirmation pass

---

## Practical Naming Set (Team-Friendly)
If you want one standard naming scheme for docs, logs, and audits, use:

- Stage 1A Content-Diff
- Stage 1A Structural
- Stage 1A Output Guard
- Stage 1B Local Structural Signals
- Stage 1B Gemini Structural
- Stage 1B Declutter Heuristic
- Stage 2 Unified Local Stack
- Stage 2 Gemini Semantic (Unified)
- Stage 2 Semantic Signal
- Stage 2 Masked-Edge Signal
- Stage 2 Composite Decision
- Stage 2 Topology Gemini
- Stage 2 Final Gemini Confirmation

This avoids conflating the two Stage 2 Gemini passes and makes incident/debug reviews much clearer.
