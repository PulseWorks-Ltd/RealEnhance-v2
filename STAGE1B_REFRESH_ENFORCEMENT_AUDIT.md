# Stage 1B + Stage 2 Refresh — Deterministic Structural & Enforcement Audit

> **Scope**: Code-only inventory. No changes proposed. All line/block references are from the current HEAD.  
> **Context**: Stage 2 Full hardening was completed in a prior session; this audit maps the equivalent territory for Stage 1B (both sub-modes) and Stage 2 Refresh.

---

## 1. Stage 1B — Generation Prompts

### 1.1 Light Declutter — `buildLightDeclutterPromptNZStyle`

**Source**: `worker/src/ai/prompts.nzRealEstate.ts:1218`  
**Injected at runtime by**: `worker/src/pipeline/stage1B.ts:78` (declutterMode === "light")

**Final runtime block order** (base function + appended blocks):

| # | Block | Source |
|---|-------|--------|
| 1 | REALENHANCE — STAGE 1B: LIGHT DECLUTTER header + TASK | `buildLightDeclutterPromptNZStyle()` |
| 2 | PRIMARY OBJECTIVE (listing-ready presentation) | `buildLightDeclutterPromptNZStyle()` |
| 3 | NO NEW OBJECTS | `buildLightDeclutterPromptNZStyle()` |
| 4 | DECLUTTER OBJECT CLASS RULES — LIGHT MODE (always/never/tidy) | `buildLightDeclutterPromptNZStyle()` |
| 5 | WALL ITEM DECLUTTER — LIGHT MODE | `buildLightDeclutterPromptNZStyle()` |
| 6 | STRUCTURE SAFETY — LIGHT MODE | `buildLightDeclutterPromptNZStyle()` |
| 7 | DO NOT TOUCH / REMOVE ONLY summary | `buildLightDeclutterPromptNZStyle()` |
| 8 | SAFE MODE (if unsure → keep) | `buildLightDeclutterPromptNZStyle()` |
| 9 | SURFACE RESTORATION | `buildLightDeclutterPromptNZStyle()` |
| 10 | BED & SOFT FURNISHING TIDY — REQUIRED WHEN MESSY | `buildLightDeclutterPromptNZStyle()` |
| 11 | PRESENTATION TIDYING — REQUIRED WHEN NEEDED | `buildLightDeclutterPromptNZStyle()` |
| 12 | ABSOLUTE PROHIBITIONS | `buildLightDeclutterPromptNZStyle()` |
| 13 | `STAGE1B_ARCHITECTURAL_IMMUTABILITY_CONSTRAINT` | `buildLightDeclutterPromptNZStyle()` |
| 14 | OUTPUT | `buildLightDeclutterPromptNZStyle()` |
| 15 | **WINDOW COVERING HARD PROHIBITION** *(conditional: railLikely === false)* | `stage1B.ts:93–101` |
|    | **OR WINDOW COVERING LIMITED FLEXIBILITY** *(conditional: railLikely === true or "unknown")* | `stage1B.ts:102–116` |
| 16 | CRITICAL CAMERA AND STRUCTURE RULES | `stage1B.ts:118–131` |

**Order note**: TASK (block 1) and PRIMARY OBJECTIVE (block 2) precede `STAGE1B_ARCHITECTURAL_IMMUTABILITY_CONSTRAINT` (block 13). The structural lock is 13 of 16 total blocks — near the end.

---

### 1.2 Stage-Ready (Structured Retain) — `buildStage1BPromptNZStyle`

**Source**: `worker/src/ai/prompts.nzRealEstate.ts:825`  
**Injected at runtime by**: `worker/src/pipeline/stage1B.ts:82` (declutterMode === "stage-ready")

**Final runtime block order**:

| # | Block | Source |
|---|-------|--------|
| 1 | STAGE 1B — FULL FURNITURE REMOVAL header | `buildStage1BPromptNZStyle()` |
| 2 | ROOM TYPE CONTEXT | `buildStage1BPromptNZStyle()` |
| 3 | TASK + ANCHOR RULE summary | `buildStage1BPromptNZStyle()` |
| 4 | PRIMARY OBJECTIVE (near-empty architectural shell) | `buildStage1BPromptNZStyle()` |
| 5 | CAMERA & PERSPECTIVE LOCK (strict) | `buildStage1BPromptNZStyle()` |
| 6 | NEWLY REVEALED AREA RULE — structural continuation only | `buildStage1BPromptNZStyle()` |
| 7 | COLOR PRESERVATION — LOCKED | `buildStage1BPromptNZStyle()` |
| 8 | ARCHITECTURAL SHELL — PRESERVE & PROTECT (built-ins, fixtures, window treatments, mirrors, wall plates) | `buildStage1BPromptNZStyle()` |
| 9 | STRUCTURAL HARDLOCK RULES (kitchen islands never converted) | `buildStage1BPromptNZStyle()` |
| 10 | BUILT-IN VS LOOSE FURNITURE DISTINCTION (beds = always removable) | `buildStage1BPromptNZStyle()` |
| 11 | ARCHITECTURE HINTS — context_only, removal_only, no_completion, no_inference | `buildStage1BPromptNZStyle()` |
| 12 | TARGETS FOR REMOVAL | `buildStage1BPromptNZStyle()` |
| 13 | PARTIAL ANCHOR PRESERVATION | `buildStage1BPromptNZStyle()` |
| 14 | ANCHOR SELECTION PRIORITY (dominance > visibility) | `buildStage1BPromptNZStyle()` |
| 15 | ARCHITECTURAL BOUNDARY PROTECTION | `buildStage1BPromptNZStyle()` |
| 16 | FUNCTIONAL ANCHOR LIMIT (1 per zone) | `buildStage1BPromptNZStyle()` |
| 17 | QUALITY RULES (floor/wall rebuild matching) | `buildStage1BPromptNZStyle()` |
| 18 | `STAGE1B_ARCHITECTURAL_IMMUTABILITY_CONSTRAINT` | `buildStage1BPromptNZStyle()` |
| 19 | OUTPUT | `buildStage1BPromptNZStyle()` |
| 20 | **WINDOW TREATMENT HARD LOCK** (preserve all window treatments exactly) | `stage1B.ts:85–91` |
| 21 | CRITICAL CAMERA AND STRUCTURE RULES | `stage1B.ts:118–131` |

**Order note**: TASK (block 3) and functional anchor rules (blocks 12–16) precede `STAGE1B_ARCHITECTURAL_IMMUTABILITY_CONSTRAINT` (block 18). Structural lock is 18 of 21 blocks.

**`STAGE1B_ARCHITECTURAL_IMMUTABILITY_CONSTRAINT` content** (`prompts.nzRealEstate.ts:810`):
- Do NOT modify walls, ceilings, floors, or architectural planes
- Do NOT extend, shrink, reshape, or repaint walls
- Do NOT alter room proportions
- Do NOT change camera position, perspective, or field of view
- You may only REMOVE clutter or small movable items

---

## 2. Stage 1B — Validator Prompts

### 2.1 Light Declutter validator — `buildStage1BLightDeclutterValidatorPrompt`

**Source**: `worker/src/validators/geminiSemanticValidator.ts:~958`

**Block injection order**:

| # | Block | Type |
|---|-------|------|
| 1 | Role header + input fields | Setup |
| 2 | Curtain fabric change WARNING ONLY rule (style_only if existing rail) | Conditional warning downgrade |
| 3 | `STAGE1B_LIGHT_DECLUTTER_FURNITURE_RULE_BLOCK` constant | Furniture category rules |
| 4 | BUILT-IN DOWNGRADE RULE: `if builtInDetected AND (structuralAnchorCount < 2 OR confidence < 0.85) → hardFail = false` | **Downgrade path** |
| 5 | furniture_change → hardFail: false (warning) | **Downgrade path** |
| 6 | DECISION RULES: `If confidence < 0.75 → hardFail = false` | **Confidence downgrade** |
| 7 | Hard fail conditions list | Enforcement |
| 8 | OUTPUT JSON schema | Format |

### 2.2 Structured Retain validator — `buildStage1BStructuredRetainValidatorPrompt`

**Source**: `worker/src/validators/geminiSemanticValidator.ts:~1181`

**Block injection order**:

| # | Block | Type |
|---|-------|------|
| 1 | Role header + input fields | Setup |
| 2 | `STAGE1B_STRUCTURED_RETAIN_FURNITURE_RULE_BLOCK` constant | Furniture category rules (differs from Light Declutter) |
| 3 | BUILT-IN DOWNGRADE RULE: `if builtInDetected AND (structuralAnchorCount < 2 OR confidence < 0.85) → hardFail = false` | **Downgrade path** |
| 4 | Boundary-adjacent furniture downgrade: `if boundary-adjacent AND structure intact → classify as furniture_change advisory` | **Downgrade path (Structured Retain only)** |
| 5 | DECISION RULES: `If confidence < 0.75 → hardFail = false` | **Confidence downgrade** |
| 6 | Hard fail conditions list | Enforcement |
| 7 | OUTPUT JSON schema | Format |

---

## 3. Stage 1B — Gating Matrix

### 3.1 Always-on

| Gate | File |
|------|------|
| `validateStage1BStructural` local validator | `validators/stage1BValidator.ts` |
| Gemini semantic validator (per `geminiPolicy`) | `validators/geminiSemanticValidator.ts` |
| `summarizeGeminiSemantic()` second category filter | `validators/runValidation.ts:73` |

### 3.2 Conditional

| Gate | Condition |
|------|-----------|
| Drift evidence injected | wallPercent > 35 OR maskedEdgePercent > 55 OR angleDegrees > 25 |
| Gemini model tier MEDIUM/HIGH | risk level assessment ≠ LOW |
| `structuredRetainFurnitureDowngrade` runtime downgrade | mode === STRUCTURED_RETAIN AND boundary-adjacent furniture |
| WINDOW TREATMENT HARD LOCK appended to generation prompt | declutterMode === "stage-ready" |
| WINDOW COVERING HARD PROHIBITION appended to generation prompt | railLikely === false AND declutterMode === "light" |
| WINDOW COVERING LIMITED FLEXIBILITY appended | railLikely === true or "unknown" AND declutterMode === "light" |
| `geminiPolicy === "on_local_fail"` skips Gemini entirely | no local failures detected |

---

## 4. Stage 1B — All Structural Downgrade Paths

All paths in `worker/src/validators/geminiSemanticValidator.ts`, runtime block (lines ~2063–2093), in the **Stage 1B/1A `else` branch**:

### D1 — Confidence gate
```
Location: geminiSemanticValidator.ts ~line 2075
Condition: lowConfidence === true  (where lowConfidence = confidence < MIN_CONFIDENCE = 0.75)
Effect: hardFail = false
Modes: Stage 1B (both sub-modes) + Stage 1A
Applies even if: category === "structure"
```

### D2 — Built-in anchor count gate
```
Location: geminiSemanticValidator.ts ~line 2078
Condition: builtInDetected === true AND structuralAnchorCount < 2
Effect: hardFail = false
Modes: Stage 1B (both sub-modes) + Stage 1A
```

### D3 — Built-in low confidence gate
```
Location: geminiSemanticValidator.ts ~line 2081
Condition: builtInLowConfidence === true  (builtInDetected AND confidence < BUILTIN_HARDFAIL_CONFIDENCE = 0.85)
Effect: hardFail = false
Modes: Stage 1B (both sub-modes) + Stage 1A
```

### D4 — Structured Retain boundary-adjacent furniture downgrade
```
Location: geminiSemanticValidator.ts ~line 2083
Condition: structuredRetainFurnitureDowngrade === true  (mode === STRUCTURED_RETAIN AND boundary-adjacent furniture with intact structure)
Effect: hardFail = false
Modes: Stage 1B STRUCTURED_RETAIN only
```

### D5 — summarizeGeminiSemantic() second category filter (GLOBAL)
```
Location: runValidation.ts:73
Code: const hard = verdict.hardFail && (category === "structure" || category === "opening_blocked")
Effect: Any verdict where hardFail=true but category is NOT "structure" or "opening_blocked" is silently downgraded to hard=false
Modes: ALL modes — Stage 1A, 1B, Stage 2 Refresh, Stage 2 Full
```

---

## 5. Stage 1B — All Confidence-Based Fail-Open Logic

| Threshold | Constant | Variable | Location | Scope |
|-----------|----------|----------|----------|-------|
| `< 0.75` | `MIN_CONFIDENCE` | `lowConfidence` | `geminiSemanticValidator.ts:15` + runtime ~2075 | Stage 1B + 1A only |
| `< 0.85` | `BUILTIN_HARDFAIL_CONFIDENCE` | `builtInLowConfidence` | `geminiSemanticValidator.ts:17` + runtime ~2081 | Stage 1B + 1A only |
| Both thresholds also appear explicitly in the validator prompt text | Prompt text teaches the model to self-report downgrade eligibility | — | Prompt builder functions | Prompt |

---

## 6. Stage 1B — violationType Remapping

**None.** `normalizeStage2FullStructuralViolationType()` is gated on `isStage2Full === true`. For Stage 1B, `isStage2Full = false` always, so no remapping occurs. The parsed `violationType` is passed through verbatim.

---

## 7. Stage 1B — Dead Blocks

None found. All defined constant blocks (`STAGE1B_LIGHT_DECLUTTER_FURNITURE_RULE_BLOCK`, `STAGE1B_STRUCTURED_RETAIN_FURNITURE_RULE_BLOCK`, `STAGE1B_ARCHITECTURAL_IMMUTABILITY_CONSTRAINT`) are injected in their respective prompt builders.

---

---

## 8. Stage 2 Refresh — Generation Prompt

**Source**: `worker/src/ai/prompts/stage2/refresh.prompt.ts`  
**Function**: `buildStage2RefreshPromptNZ(roomType)`

**Final runtime block order**:

| # | Block | Note |
|---|-------|------|
| 1 | REFRESH LOGIC (furniture swap/position rules, refresh-specific staging instructions) | ⚠️ Before structural lock |
| 2 | ROOM-TYPE TARGET (target furnishing standards for room type) | ⚠️ Before structural lock |
| 3 | `STAGE2_ARCHITECTURAL_IMMUTABILITY_BLOCK` (walls/ceilings/floors/windows/doors/built-ins lock) | Shared block |
| 4 | `STAGE2_CAMERA_IMMUTABILITY_BLOCK` (viewpoint/perspective/framing lock) | Shared block |
| 5 | REFRESH-SPECIFIC RULES | |
| 6 | STYLE PROFILE | |
| 7 | `STAGE2_OUTPUT_FORMAT_BLOCK` ("Return only the edited image") | |

**ORDER INVERSION**: REFRESH LOGIC (block 1) and ROOM-TYPE TARGET (block 2) appear **before** `STAGE2_ARCHITECTURAL_IMMUTABILITY_BLOCK` (block 3) and `STAGE2_CAMERA_IMMUTABILITY_BLOCK` (block 4).

**Missing vs Stage 2 Full generation prompt**:

| Block | Present in Full | Present in Refresh |
|-------|----------------|--------------------|
| `STAGE2_ARCHITECTURAL_IMMUTABILITY_BLOCK` | ✅ (position 1) | ✅ (position 3) |
| `STRUCTURAL_HARDENING_LAYER_V2` | ✅ (position 2) | ❌ |
| `STRUCTURAL_IDENTITY_LOCK_BLOCK` | ✅ (position 3) | ❌ |
| `STAGE2_CAMERA_IMMUTABILITY_BLOCK` | ✅ (position 4) | ✅ (position 4) |
| Fixture/curtain/zone expansion identity rules | ✅ (via `STRUCTURAL_IDENTITY_LOCK_BLOCK`) | ❌ |

---

## 9. Stage 2 Refresh — Validator Prompt

**Source**: `worker/src/validators/stage2/refresh.validator.ts`  
**Function**: `validateStage2Refresh()`

**Final runtime block order**:

| # | Block | Content |
|---|-------|---------|
| 1 | DECISION RULES (5 rules) | General structural assessment guidance |
| 2 | HARD FAIL CONDITIONS (4 conditions) | opening added/removed/sealed/moved; wall/room-boundary shift; built-in footprint changed; structural camera shift |
| 3 | OUTPUT JSON schema | `{ pass, reason, confidence }` |

**Missing vs Stage 2 Full validator** (`full.validator.ts`):

| Block | Present in Full | Present in Refresh |
|-------|----------------|--------------------|
| `GEOMETRIC_ENVELOPE_RULE` | ✅ | ❌ |
| `STRUCTURAL_ENFORCEMENT_RULE` (pendant/fan/downlight, plumbing, curtain system, opening/built-in/camera/envelope drift) | ✅ | ❌ |
| Occlusion/reveal protection block | ✅ | ❌ |
| Ceiling fixture enforcement (pendant/fan/downlight add/remove) | ✅ | ❌ |
| Plumbing fixture enforcement | ✅ | ❌ |
| Curtain/drape/rail distinction enforcement | ✅ | ❌ |
| Functional zone expansion rule | ✅ | ❌ |
| 11-item hard fail list | ✅ | Only 4 items |
| `buildFinalFixtureConfirmPrompt` (structural confirm step) | ✅ (via `confirmWithGeminiStructure`) | ❌ (not called for Refresh) |

---

## 10. Stage 2 Refresh — Gating Matrix

### 10.1 Always-on

| Gate | File |
|------|------|
| Local structural validators (mask, openings, anchor check) | `validators/runValidation.ts` |
| Gemini semantic validator (per `geminiPolicy`) | `validators/geminiSemanticValidator.ts` |
| `summarizeGeminiSemantic()` second category filter | `validators/runValidation.ts:73` |

### 10.2 Conditional

| Gate | Condition |
|------|-----------|
| Drift evidence | **NOT injected for Stage 2 at all** — `gateEvidenceForGemini()` excludes drift for stage 2 regardless of mode |
| Openings/anchors evidence | Injected when openings changed or anchors changed |
| `STAGE2_SEMANTIC_OVERRIDE_GATE` | Can clear local block if: Gemini passes AND anchors unchanged AND openings unchanged AND structuralMask passed AND walls passed — applies to ALL Stage 2 modes including Refresh |
| `confirmWithGeminiStructure` | Called for stage2 jobs, uses `buildFinalFixtureConfirmPrompt` as promptOverride — but `confirmedFail = geminiBlocking ? !pass : false` (fails open when `geminiBlocking=false`) |
| `geminiPolicy === "on_local_fail"` | Skips Gemini entirely for clean-local jobs |

---

## 11. Stage 2 Refresh — All Structural Downgrade Paths

All paths in `worker/src/validators/geminiSemanticValidator.ts`, Stage 2 structure block (runs **before** the Stage 2 Full override):

### R1 — builtInDowngradeAllowed gate (Stage 2 gate — applies to REFRESH)
```
Location: geminiSemanticValidator.ts ~line 2071
Code: if (category === "structure" && builtInDowngradeAllowed) { hardFail = false }
Condition: builtInDowngradeAllowed from parsed Gemini response
Effect: hardFail = false even for category === "structure"
Modes: Stage 2 ALL — Full AND Refresh
Blocked for: Stage 2 Full ONLY (terminal override at ~line 2082 re-forces hardFail=true after this block)
Status: ACTIVE for Stage 2 Refresh — not blocked by any override
```

### R2 — summarizeGeminiSemantic() second category filter (GLOBAL)
```
Location: runValidation.ts:73
Code: const hard = verdict.hardFail && (category === "structure" || category === "opening_blocked")
Effect: Any verdict where category is not "structure" or "opening_blocked" has hard forced to false
Modes: ALL modes including Stage 2 Refresh
```

### R3 — STAGE2_SEMANTIC_OVERRIDE_GATE (Stage 2 only)
```
Location: runValidation.ts ~line 1015
Effect: Clears local structural block when Gemini semantic verdicts pass + local conditions met
Condition: semanticPass AND anchorsChanged=false AND openingsChanged=false AND structuralMask passed AND walls passed
Modes: Stage 2 ALL — Full AND Refresh
```

---

## 12. Stage 2 Refresh — Confidence-Based Fail-Open Logic

**None at runtime.** The confidence downgrade paths (D1–D3 above) are in the Stage 1B/1A `else` branch and do not execute for Stage 2 jobs.

**However**: The Refresh validator prompt itself currently does NOT instruct the model to self-report a confidence value in the output schema — the schema is `{ pass, reason, confidence }` but no explicit confidence thresholds appear in the Refresh validator prompt text (unlike Stage 1B validator prompts which explicitly state `If confidence < 0.75 → hardFail = false`).

---

## 13. Stage 2 Refresh — violationType Remapping

**None.** `normalizeStage2FullStructuralViolationType()` (added in the Stage 2 Full hardening session) is gated on `isStage2Full === true`. For Refresh jobs, `opts.validationMode === "REFRESH_OR_DIRECT"`, so `isStage2Full === false`. The parsed `violationType` is passed through verbatim.

---

## 14. Stage 2 Refresh — Dead Blocks

The following constants are defined in `worker/src/validators/stage2/full.validator.ts` but are **not referenced** in `refresh.validator.ts`:

- `GEOMETRIC_ENVELOPE_RULE`
- `STRUCTURAL_ENFORCEMENT_RULE`

These constants are not exported and are not accessible to `refresh.validator.ts` without explicit import. They are not dead within `full.validator.ts`, but their equivalent logic is absent from the Refresh path.

---

## 15. Cross-Cutting: validationMode Resolution Gap

**Location**: `geminiSemanticValidator.ts` — `buildPrompt()` vs `runGeminiSemanticValidator()` / `isStage2Full` detection

**Gap**:
```
buildPrompt(): resolvedValidationMode = validationMode ?? (sourceStage === "1A" ? "FULL_STAGE_ONLY" : "REFRESH_OR_DIRECT")
isStage2Full(): opts.stage === "2" && opts.validationMode === "FULL_STAGE_ONLY"
```

If a Stage 2 job has `sourceStage === "1A"` but `validationMode` is not explicitly passed in `opts`, then:
- `buildPrompt()` selects the `FULL_STAGE_ONLY` prompt template (correct intent)
- `isStage2Full` evaluates `opts.validationMode`, which is `undefined` → returns `false`
- The Stage 2 Full terminal override block never fires
- The `builtInDowngradeAllowed` path at ~line 2071 runs and can downgrade structure verdicts

This gap means the FULL_STAGE_ONLY enforcement relies on callers explicitly passing `validationMode: "FULL_STAGE_ONLY"`.

---

## 16. Summary Tables

### 16.1 Hard-fail enforcement comparison

| Feature | Stage 2 Full | Stage 2 Refresh | Stage 1B Light | Stage 1B Structured Retain |
|---------|-------------|----------------|----------------|---------------------------|
| Terminal structural override (runtime) | ✅ | ❌ | ❌ | ❌ |
| violationType normalization (runtime) | ✅ | ❌ | ❌ | ❌ |
| builtInDowngradeAllowed path blocked | ✅ (overridden after) | ❌ active | ❌ N/A (different branch) | ❌ N/A |
| Confidence gate (< 0.75) | ❌ blocked | ❌ N/A | ✅ active | ✅ active |
| Built-in anchor count gate | ❌ blocked | ❌ N/A | ✅ active | ✅ active |
| Built-in confidence gate (< 0.85) | ❌ blocked | ❌ N/A | ✅ active | ✅ active |
| `GEOMETRIC_ENVELOPE_RULE` in validator | ✅ | ❌ | ❌ | ❌ |
| `STRUCTURAL_ENFORCEMENT_RULE` in validator | ✅ | ❌ | ❌ | ❌ |
| Ceiling fixture enforcement in validator | ✅ | ❌ | ❌ | ❌ |
| Structural identity lock in generation | ✅ | ❌ | N/A | N/A |
| Structural lock before staging logic (gen) | ✅ | ❌ ORDER INVERSION | N/A | N/A |

### 16.2 All downgrade paths at-a-glance

| ID | Path | Stage 2 Full | Stage 2 Refresh | Stage 1B |
|----|------|-------------|-----------------|----------|
| R1 | `builtInDowngradeAllowed → hardFail=false` | Overridden ✅ | ACTIVE ⚠️ | N/A (different branch) |
| D1 | confidence < 0.75 → hardFail=false | Blocked ✅ | Blocked ✅ | ACTIVE ⚠️ |
| D2 | builtInDetected && anchors < 2 → hardFail=false | Blocked ✅ | Blocked ✅ | ACTIVE ⚠️ |
| D3 | builtInLowConfidence → hardFail=false | Blocked ✅ | Blocked ✅ | ACTIVE ⚠️ |
| D4 | structuredRetainFurnitureDowngrade → hardFail=false | Blocked ✅ | N/A | ACTIVE (STRUCTURED_RETAIN only) ⚠️ |
| D5 | summarizeGeminiSemantic category filter | ACTIVE | ACTIVE | ACTIVE |
| R3 | STAGE2_SEMANTIC_OVERRIDE_GATE | ACTIVE | ACTIVE | N/A |

---

*Audit completed. All findings are from static code reading only. No runtime behavior was tested.*
