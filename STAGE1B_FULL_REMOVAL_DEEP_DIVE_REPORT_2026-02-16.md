# Stage 1B Full Furniture Removal Deep-Dive Report
Date: 2026-02-16
Branch: fix/rollback-to-last-stable

## Executive Summary
The Stage 1B full-removal path has multiple instability vectors that can produce "room identity drift" (outputs that look like a different room), especially on retries.

Most important findings:
1. **Retry-specific prompt mutation exists** in Stage 1B full mode and can make later attempts substantially more destructive.
2. **Sampling and model behavior can drift** across attempts (attempt index, model fallback, config/env overrides), even when prompt text appears the same.
3. **Validator retry path is not fully deterministic** and includes at least one implementation mismatch (computed retry sampling not actually passed into Stage 1B reruns).
4. **Current validator mode in recent logs is advisory (`log`)**, so extreme Stage 1B outputs are often not blocked before publish.

---

## Scope and Method
Reviewed call flow and retry behavior across:
- `worker/src/worker.ts`
- `worker/src/pipeline/stage1B.ts`
- `worker/src/ai/prompts.nzRealEstate.ts`
- `worker/src/ai/gemini.ts`
- `worker/src/ai/runWithImageModelFallback.ts`
- `worker/src/validators/validationModes.ts`

Also cross-checked runtime behavior in:
- `logs.1771204888923.log`
- `logs.1770890601882.log`

---

## 1) How Stage 1B full prompt is called (baseline)

### Call path
1. Worker determines `declutterMode` from payload and overrides (`worker.ts` around Stage 1B block).
2. For full removal, `declutterMode = "stage-ready"`.
3. Stage 1B invocation happens through `runStage1B(path1A, options)`.
4. `runStage1B` selects full prompt via `buildStage1BPromptNZStyle(...)`.
5. Prompt is further modified by runtime append blocks (curtain-rail conditions, and retry reinforcement for higher attempts).
6. Gemini generation executes via `enhanceWithGemini(... stage: "1B" ...)` using Stage 1B model strategy (primary + fallback).

### Baseline non-retry parameters (attempt 0)
- Prompt: full Stage 1B prompt + curtain-rail append block.
- Sampling from `stage1B.ts`: temp ~0.24, topP 0.70, topK 30 **unless overridden**.
- Model strategy from `gemini.ts`: Stage 1B primary `gemini-3-pro-image-preview`, fallback `gemini-2.5-flash-image`.

---

## 2) What changes when retries are validator-triggered

## A. Local/unified validation retry loop (`runStage1BWithValidation`)
Differences from attempt 0:
1. **Attempt index increases** (`attempt = stage1BAttempts - 1`).
2. **Retry temperature decreases** in `stage1B.ts` for attempts >=1 (`baseTemp * 0.9`).
3. **Prompt mutation for attempt >=2** in `stage1B.ts`:
   - Appends:
     - "RETRY REMOVAL REINFORCEMENT"
     - "If uncertain whether built-in or movable — treat as movable and remove."
4. Same Stage 1A baseline input is reused (good).

### Why this matters
The retry-only instruction to treat uncertain items as removable can push the model from conservative declutter into structural over-removal / reinterpretation. This is exactly the type of instruction that can produce "new room" feel.

## B. Gemini-confirmation retry loop (`worker.ts`)
After Stage 1B output is generated, Gemini confirmation may trigger reruns.

Observed differences/issues:
1. Code computes reduced retry sampling (`geminiRetryTemp/topP/topK`) each retry.
2. **But those reduced values are not passed to `runStage1B`**. The rerun call still uses base Stage1B path/options and inherited sampling chain.
3. Reruns pass `attempt: geminiRetries`, which still changes Stage1B internal behavior via attempt index.
4. Reruns pass `declutterMode: declutterMode` (original mode), not explicitly the effective final mode in fallback scenarios.

### Why this matters
Retry behavior is partially inconsistent with intent. The system believes it is tightening sampling, but Stage 1B reruns are not receiving those explicit retry sampling values.

---

## 3) Instability vectors (ranked)

## Critical (highest probability / impact)

### 1) Retry-only destructive prompt reinforcement
Location: `worker/src/pipeline/stage1B.ts`

Condition:
- Applies only when full mode and `attemptIndex >= 2`.

Risk:
- Injects aggressive instruction to remove uncertain items as movable.
- Can erase ambiguous but important structures and visually re-interpret room geometry.

Why this aligns with your symptom:
- You reported severe instability in full removal, not light mode.
- This branch is full-mode-specific and retry-specific.

### 2) Validator publishing policy currently permissive in observed logs
Location: `worker/src/validators/validationModes.ts` + runtime logs

Observed in logs:
- `structureMode=log`, `localBlocking=DISABLED`, `geminiMode=log` in recent runs.
- Unified validation shows `effective=log blocking=OFF`.

Risk:
- Even when validators detect suspicious outputs, wild Stage 1B can survive and publish.
- Perception becomes "prompt instability" because no hard gate is stopping outliers.

### 3) Sampling/model variability path in Stage 1B
Locations: `stage1B.ts`, `gemini.ts`, `runWithImageModelFallback.ts`, `adminConfig.ts`

Risk contributors:
- Retry temp drift by attempt index.
- Stage1B primary/fallback model differences (`Gemini 3` vs `2.5`).
- Hidden sampling overrides from:
  - payload `options.sampling` (`jobSampling`),
  - `gemini.config.json` admin sampling,
  - env vars (`GEMINI_TEMP`, `GEMINI_TOP_P`, scene variants, etc).

Impact:
- Two jobs with same user intent can run materially different generation settings.

## High (important but secondary)

### 4) Contradictory window-treatment logic in full-removal call construction
Location: `worker/src/pipeline/stage1B.ts`

Base full prompt says window treatments must remain unchanged.
Then runtime append can say curtains may be changed/replaced when `curtainRailLikely` is true/unknown.

Risk:
- Contradictory instruction set in same prompt increases generative ambiguity.
- Can produce large perceptual room changes (window zone heavily influences room identity).

### 5) Gemini-confirm retry implementation mismatch
Location: `worker/src/worker.ts` (Stage 1B Gemini retry loop)

Risk:
- Retry parameters calculated but not wired into Stage1B call.
- Behavior differs from design expectation and can complicate debugging/consistency.

---

## 4) Is retry call path different from first pass? (direct answer)
Yes, in meaningful ways.

For full Stage 1B, retry-triggered calls differ by:
- Attempt index (changes temp and output path suffix).
- Prompt mutation (attempt >=2 adds aggressive removal reinforcement).
- Potential model fallback occurrence per attempt.
- Potentially different effective sampling due to override chain.

So retry path is not equivalent to first pass; it is a modified generation regime.

---

## 5) Evidence from current logs

Recent logs show:
- Full mode is active in affected batches: `[stage1B] Attempt 1/3 mode=stage-ready`.
- Stage 1B model strategy includes fallback: `primary=gemini-3-pro-image-preview, fallback=gemini-2.5-flash-image`.
- Validator modes in these runs are advisory (`log`) rather than hard blocking.

This combination allows unstable full-removal outliers to pass through more often.

---

## 6) Recommended stabilization actions (priority order)

## P0 — Immediate safety
1. **Remove or soften retry-only destructive reinforcement** in `stage1B.ts`.
   - Especially: "If uncertain whether built-in or movable — treat as movable and remove."
2. **Make Stage1B validator blocking enforceable for full removal**, at least for severe structural risks.
   - Keep light mode more permissive if desired.

## P1 — Determinism + consistency
3. **Normalize Stage 1B sampling source of truth**:
   - Either lock Stage1B full to fixed sampling in code,
   - or log every override source and reject conflicting overrides in production.
4. **Pin Stage1B full to one model for a trial window** (or strict fallback policy only on transport/API failure).

## P2 — Retry correctness
5. **Fix Gemini-confirm retry wiring** so computed retry sampling values are actually passed into Stage1B reruns.
6. **Ensure retry reruns preserve effective mode** (avoid mode regressions in fallback contexts).

## P3 — Prompt coherence
7. Resolve curtain-treatment contradiction:
   - Full prompt should have one clear rule set for windows/curtains.
   - Avoid allowing runtime append to contradict hard-lock prompt text.

---

## 7) Suggested instrumentation to confirm root cause quickly
Add per-attempt structured logs for Stage 1B full runs:
- `attemptIndex`
- `declutterMode`
- `promptHash` (hash final prompt after all runtime appends)
- `modelUsed` (primary vs fallback)
- `effectiveSampling` + source (`explicit/config/env/default`)
- `validatorOutcome` and block decision

This will make instability attributable in one pass.

---

## 8) Bottom line
Your diagnosis is valid: this is not just a Stage 2 issue. Stage 1B full-removal has retry-specific and runtime-override behaviors that can materially destabilize outputs. The biggest red flag is retry-time prompt hardening that biases removal of uncertain structures, combined with permissive validator mode in recent runs.

If you want, I can now implement a minimal hardening patch set (P0+P1) and keep behavior otherwise unchanged.