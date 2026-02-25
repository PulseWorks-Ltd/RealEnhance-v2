# Stage 1B Block Audit (2026-02-25)

## Scope
This audit maps why Stage 1B images are blocked, including:
- Local validator metrics and thresholds
- Severity/risk classification
- Escalation conditions to Gemini
- Gemini prompt/payload/response handling
- Final pass/block mapping

No blocking behavior was changed. Temporary logging was added behind `VALIDATOR_AUDIT=1`.

## Step 1 — Stage 1B validator execution pipeline

### Actual Stage 1B blocking path
1. `worker/src/worker.ts` generates Stage 1B candidate image (`runStage1B(...)`).
2. Local numeric checks run:
   - `detectWallPlaneExpansion(path1A, candidate)`
   - `runSemanticStructureValidator(...)`
3. `ValidationEvidence` packet is built from local readings.
4. Gemini Stage 1B validator runs via:
   - `validateStage1BStructure(path1A, candidate, stage1BStructuralEvidence)`
5. Final hard block is computed in worker using combined conditions:
   - `structureResult.hardFail`
   - `wallDelta.hardFail`
   - opening removal hard fail
   - suspicious wall expansion hard fail
6. If hard fail and retries exhausted, job falls back to Stage 1A output.

### Files requested vs current locations
- `worker/src/validators/stageAwareValidator.ts` is currently located at `worker/src/validators/structural/stageAwareValidator.ts`.
- `runValidation.ts`, `stage2StructuralValidator.ts`, `confirmWithGeminiStructure.ts` are active but primarily Stage 2 / unified paths.
- Stage 1B blocking in current main worker path is governed by `validateStage1BStructure` + worker-level deterministic guards.

## Step 2 — Local validator metrics collected (Stage 1B path)

### Metrics collected per Stage 1B attempt
- Wall-plane metrics (`worker/src/worker.ts`):
  - `baselineArea`
  - `candidateArea`
  - `deltaRatio`
  - `newWallRatio`
  - `planeExpansionRatio`
- Semantic/opening metrics (`worker/src/validators/semanticStructureValidator.ts`):
  - `windows.before`, `windows.after`, `windows.change`
  - `doors.before`, `doors.after`, `doors.change`
  - `walls.driftRatio`
  - `openings.created`, `openings.closed`
- Stage 1B opening-significance metrics (`worker/src/validators/geminiSemanticValidator.ts`):
  - `maxAreaDeltaRatio`
  - `maxCentroidShiftRatio`
  - `maxAspectRatioDeltaRatio`
  - `countChanged`
  - `stateChanged`

### Thresholds and bands used
- Wall plane hard fail:
  - `newWallRatio > 0.03` => hard fail
- Additional suspicious wall expansion flag:
  - `planeExpansionRatio > 0.15` => treated as hard-fail contributor in worker
- SemanticStructureValidator pass thresholds:
  - wall drift `< 0.12`
  - no window/door count change
  - no opening create/close flags
- Opening significance tolerances:
  - `OPENING_AREA_DELTA_THRESHOLD = 0.08`
  - `OPENING_CENTROID_SHIFT_THRESHOLD = 0.03`
  - `OPENING_ASPECT_RATIO_DELTA_THRESHOLD = 0.05`
  - Below these + no count/state change => `opening_minor_drift` tolerated
- Stage 1B Gemini confidence thresholds:
  - `MIN_CONFIDENCE = 0.75`
  - `BUILTIN_HARDFAIL_CONFIDENCE = 0.85`

### Severity classification
- Severity for audit is derived from deterministic risk classifier (`classifyRisk(...)`):
  - `HIGH`: openings delta OR anchor changes OR structural flags with anchor evidence
  - `MEDIUM`: wall drift > 35 OR masked edge drift > 55 OR angle > 25, plus advisory cases
  - `LOW`: none of the above

## Step 3 — Escalation logic

### Stage 1B escalation to Gemini
- In current Stage 1B worker flow, Gemini structural validation is called on every Stage 1B candidate via `validateStage1BStructure(...)`.
- Additional signal injection into prompt happens when:
  - evidence gating is enabled for job
  - AND any of:
    - opening removal suspected
    - suspicious wall expansion
    - opening count delta != 0

### Outcome gates (Stage 1B)
- `LOG ONLY`: semantic helper validator itself is log-only.
- `RETRY`: any `effectiveHardFail` retries until `STAGE1B_MAX_ATTEMPTS`.
- `GEMINI CONFIRMATION`: effectively always executed in Stage 1B path (`validateStage1BStructure`).
- `HARD BLOCK`: when `effectiveHardFail` remains true and attempts exhausted.

## Step 4 — Gemini escalation prompt (Stage 1B)

### Prompt template used
- Base prompt: `STAGE1B_HARDENED_STRUCTURAL_PROMPT`
- Optional appended local signal block when evidence injection condition is true.

### Variables injected
- `openingRemovalDetected`
- `suspiciousWallExpansion`
- `openingCountDelta`

### Structural wording present
Prompt includes strict language for:
- opening preservation / opening removal
- structural envelope lock
- camera/perspective shifts
- wall/geometry changes
- built-in geometric envelope lock

## Step 5 — Gemini response handling and decision mapping

### Fields read
- `hardFail`
- `category`
- `reasons[]`
- `confidence`
- `violationType`
- optional built-in/anchor fields

### Mapping logic (Stage 1B)
- Parsed output normalized by `parseGeminiSemanticText(...)`.
- For Stage 1B:
  - `wall_change`, `camera_shift`, `opening_change` are geometric hard-fail classes.
  - opening-change can be downgraded to tolerated minor drift if significance checks pass.
- Worker computes final `effectiveHardFail` by combining Gemini and deterministic local guards.

### Fail-open vs fail-closed
- Stage 1B Gemini validator `validateStage1BStructure(...)` catch path currently returns `hardFail: true` (fail-closed on runtime error).
- `confirmWithGeminiStructure.ts` (used in Stage 2 confirmation path) supports fail-open via `GEMINI_CONFIRM_FAIL_OPEN`.

## Step 6 — Temporary debug logging added

### Guard flag
- `VALIDATOR_AUDIT=1`

### Added logs (Stage 1B)
- In `worker/src/worker.ts`:
  - job/image/stage/attempt
  - local metrics
  - risk severity
  - local hard-fail contributors
  - escalation reason
  - Gemini normalized response
  - final decision (PASS/BLOCK)
- In `worker/src/validators/geminiSemanticValidator.ts`:
  - request payload (model, generationConfig, full prompt text, image mime + byte lengths)
  - raw Gemini response text
  - mapped Gemini decision
  - error decision path

## Step 7 — Config thresholds and env controls

### Stage 1B specific
- `STAGE1B_MAX_ATTEMPTS` (default 2)
- `GEMINI_VALIDATOR_MODEL_STRONG` (default `gemini-2.5-flash`)
- `VALIDATOR_AUDIT` (new temporary audit switch)

### Risk/severity and unified validator controls
- `LOCAL_VALIDATOR_MODE`, `GEMINI_VALIDATOR_MODE`
- `GEMINI_CONFIRM_FAIL_OPEN` (confirm path)
- Stage-aware config in `stageAwareConfig.ts`:
  - gate min signals, IoU pixel ratios, edge mode, retry max, stage thresholds

## Step 8 — Why Stage 1B gets blocked (root causes)

Primary Stage 1B block causes in current code:
1. `newWallRatio > 0.03` in wall-plane expansion detector
2. opening removal detected and significant
3. suspicious wall expansion (`planeExpansionRatio > 0.15`)
4. Gemini Stage 1B verdict hard fail (`wall_change` / `opening_change` / `camera_shift` classes)
5. Any of the above persisting after retries (`STAGE1B_MAX_ATTEMPTS`)

---

## How to run the audit logs
Set environment variable and run worker:
- `VALIDATOR_AUDIT=1`

Then inspect logs for sections beginning with:
- `[VALIDATOR AUDIT]`
- `[VALIDATOR AUDIT][GEMINI_STAGE1B_REQUEST]`
- `[VALIDATOR AUDIT][GEMINI_STAGE1B_RESPONSE_RAW]`
- `[VALIDATOR AUDIT][GEMINI_STAGE1B_DECISION]`

This gives per-image metrics, severity, escalation reason, prompt/payload, Gemini response, and final pass/block.
