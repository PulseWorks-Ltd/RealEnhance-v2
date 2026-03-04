# Stage 1B Full Removal: Prompt + Validator Logic (Complete Copy Draft)

This document captures the current Stage 1B full furniture removal prompt (interior) and the complete runtime validation logic chain used in worker orchestration.

## 1) Exact Stage 1B Full Furniture Removal Prompt (Interior)

Source function: `buildStage1BPromptNZStyle(...)`.

```text
STAGE 1B — FULL FURNITURE REMOVAL (INTERIOR)

────────────────────────────────
RULE PRIORITY ORDER (HIGHEST → LOWEST)
────────────────────────────────

1. Architectural geometry and openings must remain visually identical.
2. If furniture removal risks altering geometry, openings, boundary seams, or perspective → preserve the furniture.
3. Removal of non-anchor movable furniture is required only when it can be done without structural risk.
4. Creating an empty room is secondary to preserving architectural integrity.
5. Anchor selection applies only after structural safety is satisfied.

    ROOM TYPE CONTEXT:
    This room is classified as: ${roomType || "unknown"}.

    Only preserve a dominant anchor that is appropriate for this room type.

    If no appropriate anchor is visible in the input image:
    → Do NOT create one.
    → Leave the room empty.

    Stage1B must be strictly subtractive.
    You are forbidden from adding any new furniture object not present in the input image.

TASK:
Remove all movable furniture that can be removed WITHOUT risking architectural or opening alteration, while preserving the single most functionally dominant furniture piece per clearly defined room zone. The room structure, fixtures, and finishes must remain intact.

    PRIMARY OBJECTIVE:
    Create a minimal architectural shell where structurally safe.
    Preserve architecture, built-ins, fixtures, and window treatments exactly.

────────────────────────────────
STRUCTURAL & CAMERA LOCK — ABSOLUTE
────────────────────────────────

The following must remain visually identical:
• Camera position, angle, height, and lens perspective
• Wall positions, floor boundaries, ceiling geometry
• Window and door openings (including partial visibility)
• Built-in architectural elements

Surface reconstruction is permitted ONLY behind removed furniture
and must exactly match surrounding visible structure.

If reconstruction would require uncertain inference of openings,
preserve the furniture instead.

YOUR ONLY JOB: Remove furniture and reconstruct the matching surfaces that were behind it. NOTHING MORE.

    NON-NEGOTIABLE LOCKS — DO NOT ADD OR CREATE ANYTHING:

  ────────────────────────────────
  NEWLY REVEALED AREA RULE — STRUCTURAL CONTINUATION ONLY
  ────────────────────────────────

  If wall, ceiling, or floor areas become visible due to furniture removal:

  • ONLY extend already-visible wall, ceiling, or floor surfaces
  • Match exact texture, material, color, and lighting
  • Preserve original geometry precisely

  You must NEVER:

  • Create or extend doorways
  • Create or extend windows
  • Add arches, alcoves, niches, or openings
  • Complete partially visible frames
  • Infer recessed spaces as openings
  • Extend shadow lines into structural features

  If uncertain whether a region is an opening or solid wall:

  → Default to solid wall continuation.
  → Never assume an opening exists.

  If a doorway or window was not clearly visible in the input image,
  it must NOT appear in the output image.

  Structural hallucination is a failure condition.

You must NOT add, create, or invent ANY structural features:
- Do NOT create new windows, doors, openings, arches, or alcoves
- Do NOT add built-in features, fixtures, or joinery that don't already exist
- Do NOT invent architectural elements or structural details
- Do NOT extend openings beyond their original visible boundaries
- ONLY reveal surfaces that were hidden behind furniture
- When furniture blocks part of a window/door, only extend to its ORIGINAL edges
- When uncertain what's behind furniture, recreate matching wall/floor patterns — NEVER invent openings

If you add ANY structural feature that wasn't already visible, the task is FAILED.

COLOR PRESERVATION — LOCKED

Wall, floor, and ceiling colors must remain IDENTICAL to the input image:
- Do NOT change wall colors, paint tones, or wallpaper colors
- Do NOT change floor colors, carpet tones, or flooring colors
- Do NOT change ceiling colors or paint
- Do NOT brighten, darken, or shift any surface colors
- When reconstructing behind furniture, match the EXACT surrounding wall/floor/ceiling color
- Wall colors = LOCKED | Floor colors = LOCKED | Ceiling colors = LOCKED

ARCHITECTURAL SHELL — PRESERVE & PROTECT

You must KEEP all fixed elements exactly as they are:

Surfaces: Walls, ceilings, continuous floor surfaces (including wall-to-wall carpets), skirting boards, trims, cornices, door frames, arches, closet openings.

Built-in Joinery: Kitchen cabinets, islands, built-in wardrobes (floor-to-ceiling), recessed shelving, fireplaces.

Fixtures: Ceiling lights (pendants/fans), recessed lighting, wall sconces, switches, outlets, thermostats, vents, radiators, towel rails.

WINDOW TREATMENTS — STRUCTURAL
Curtains, blinds, and rods must remain unchanged.
Treat window treatments as fixed elements.
Do NOT remove, replace, resize, restyle, or reposition them.

Mirrors: Keep large wall-mounted or glued mirrors (bathroom vanities, built-in wardrobe doors). Remove only small decorative framed mirrors.

SMALL WALL FIXTURES — STRICT PRESERVATION (CRITICAL)

Light switches, power outlets, wall plates, control panels, thermostats,
data ports, and similar small wall-mounted fixtures are FIXED ELEMENTS.

You must NOT:
• add new switches or outlets
• duplicate switches or outlets
• move switch or outlet positions
• invent missing wall controls
• “complete” partially visible switch plates
• generate new wall hardware when reconstructing surfaces

If a switch or outlet was hidden behind removed furniture:
→ reconstruct the wall surface cleanly
→ do NOT add a replacement fixture.

If uncertain whether a wall detail is a fixture:
→ leave the wall plain.

STRUCTURAL HARDLOCK RULES — MUST FOLLOW

Treat the following as permanent built-in structures, NOT removable objects:
- kitchen islands
- built-in counters
- fixed cabinetry
- bench units
- vanities
- built-in storage
- fixed appliances
- structural fixtures

These must NEVER be:
- removed
- replaced
- converted
- restaged
- resized
- moved
- relabeled as furniture

Kitchen islands must NEVER be converted into dining tables or staging furniture.

BUILT-IN VS LOOSE FURNITURE — IMPORTANT DISTINCTION

Beds, bed frames, mattresses, and bedroom furniture are ALWAYS considered loose removable furniture — even if heavy or made of timber.

Do NOT classify beds or bed frames as built-in joinery.

Only treat an item as built-in if it is visibly attached to walls, floors, or structure with no gaps and no independent frame.

Freestanding beds are NEVER built-ins and should be removed in stage-ready declutter mode when clearly identifiable as freestanding.

Similarly, freestanding furniture items like:
- wardrobes (not built into walls)
- dressers and chests of drawers
- bedside tables
- desks (unless visibly integrated into wall units)
- bookcases (unless built-in shelving)

are ALL removable furniture — remove them completely.

ARCHITECTURE HINTS — CONTEXT ONLY, REMOVAL ONLY

Architecture hints (built-in detection, fixture identification) are provided as
context to help you decide what to KEEP — never what to ADD.

  context_only = true
  removal_only = true
  no_completion = true
  no_inference = true

If any architecture hint conflicts with visible pixels → trust the pixels.
Never add cabinetry, fixtures, or structures that are not clearly visible
in the input image. Do NOT complete partially visible structures.
Do NOT infer hidden built-ins from context clues.

CRITICAL SAFETY RULES:

If unsure whether an item is built-in → treat it as fixed.
If an item is clearly freestanding furniture (including beds), remove it.
Do NOT remove built-in structures or fixed architectural elements. Declutter applies only to movable objects and furniture.
Do NOT alter wall finishes, flooring materials, or structural features.
Do NOT move or cover windows, doors, or architectural elements.
Preserve outdoor items and landscaping visible through windows.

TARGETS FOR REMOVAL (ERASE ALL NON-DOMINANT MOVABLE ITEMS)

Remove movable furniture, decor, rugs, plants, clutter, and personal items only where structural boundaries remain unambiguous:

• Preserve exactly ONE functionally dominant furniture piece per clearly defined room zone.

PARTIAL ANCHOR PRESERVATION — CRITICAL

If a primary anchor furniture item is visible in the BEFORE image,
even if:

• partially cropped by the frame
• partially obscured by clutter
• only one section of a sectional is visible
• positioned at the edge of the image
• visually dominant but not fully in view

It must be retained in the AFTER image.

Do NOT remove a partially visible anchor and replace it with new furniture.
Do NOT invent substitute anchor furniture.
Do NOT recompose the room by deleting the dominant anchor.
Anchor removal for aesthetic improvement is prohibited.

If multiple anchor pieces are visible, retain the most visually dominant anchor
based on size, floor contact area, and visual weight.

Structured-retain declutter removes clutter — not anchor furniture.

ANCHOR SELECTION PRIORITY — STRICT HIERARCHY

Anchor selection must follow this strict order:

1. Determine dominance primarily by physical scale, floor contact area, visual mass, and functional importance within the room.

2. If a clearly dominant large-scale anchor exists, it must be retained — even if partially cropped or positioned at the image edge.

3. A smaller fully visible item must NOT outrank a larger partially visible dominant anchor.

4. Visibility clarity alone does NOT override dominance.

5. Central positioning is a last-resort tie-breaker only when scale and dominance are genuinely equal.

Dominance takes precedence over visibility.

ARCHITECTURAL BOUNDARY PROTECTION — NON-NEGOTIABLE

When removing furniture, preserve architectural boundary integrity.

Do NOT remove any furniture item if it:

Touches or overlaps a visible window frame

Touches or overlaps a sliding door frame

Touches or overlaps floor-to-ceiling glass

Obscures a wall-to-window vertical seam

Obscures a door frame vertical seam

Obscures a visible exterior-view transition

Covers a visible wall corner where surface continuation is uncertain

If removal would require inferring what exists behind a window, sliding door, glass panel, or structural seam with less than high certainty, do NOT remove that furniture item.

When this rule conflicts with the goal of making the room empty,
preserving architecture takes precedence.

Preserve the item and treat it as structurally adjacent.

Never fabricate, extend, or reconstruct glass, windows, or door geometry without clear visible evidence.

Architectural boundaries take precedence over decluttering completeness.

A zone is a visually distinct functional area (e.g., lounge area, dining area) separated by layout, furniture grouping, or spatial orientation.

Dominant functional anchors by room type:

Living room:
→ Keep the primary sofa OR the main seating anchor (the piece that defines the seating area).
→ Remove all secondary seating (armchairs, recliners, ottomans, side chairs).

Bedroom:
→ Keep the bed.
→ Remove all other freestanding furniture.

Dining:
→ Keep the dining table.
→ Remove additional storage and loose items.

Office:
→ Keep the primary desk.
→ Remove all secondary furniture.

Kitchen:
→ Built-ins remain as already specified. Remove all loose movable items.

If uncertain which item is dominant:
→ Keep the item most central to the room’s primary function.
→ Remove all other movable items.

ANCHOR SELECTION GOAL

Strive to preserve a single dominant movable anchor item per zone.

However:
If removal of additional movable items risks structural instability,
minor residual furniture may remain.

Declutter completeness is secondary to structural integrity.
Residual movable items are acceptable if structural safety is preserved.

Do NOT preserve multiple similar furniture pieces.
Do NOT preserve secondary seating.
Do NOT preserve decorative or auxiliary furniture.

QUALITY RULES:
Rebuild floors, skirting, walls, lighting artifacts naturally with matching texture and sharpness.
When reconstructing walls, prefer clean blank wall over adding any wall hardware.

If constraints conflict, prioritize preserving the original image geometry exactly.
Never reinterpret, simplify, or regenerate the room layout to resolve ambiguity.

SAFETY FAIL RULES:

OUTPUT:
Return only the empty room image.
```

## 2) Complete Stage 1B Runtime Logic Copy (Generation + Validation)

### 2.1 Generation entry and prompt routing

- Stage 1B generation entry: `runStage1B(...)` in `worker/src/pipeline/stage1B.ts`.
- Requires explicit `declutterMode` in `{ "light", "stage-ready" }`; invalid/missing mode throws hard error.
- Prompt selection:
  - `light` → `buildLightDeclutterPromptNZStyle(...)`.
  - `stage-ready` → `buildStage1BPromptNZStyle(...)` (the full-removal/anchor-retain prompt above).
- Additional window-treatment suffix logic is appended from `curtainRailLikely` context.
- Sampling:
  - Stage-ready uses `STAGE1B_FULL_SAMPLING`.
  - Light mode uses reduced defaults (`topP 0.70`, `topK 30`, retry temp reduction).
- Generation uses `enhanceWithGemini(..., { stage: "1B", declutter: true, modelReason: "declutter:<mode>", promptOverride })`.
- If Gemini fails/unavailable, function falls back to a Sharp cleanup transform and still returns an output path (fail-open generation behavior).

### 2.2 Worker Stage 1B orchestration

In `worker/src/worker.ts`, Stage 1B is orchestrated with these phases:

1. Determine routing/declutter mode from furnished gate and payload.
2. Run `runStage1BWithValidation(mode, attempt)`.
3. Validate using `runUnifiedValidation(...)` with:
   - `stage: "1B"`
   - `geminiPolicy: VALIDATION_BLOCKING_ENABLED ? "never" : "on_local_fail"`
   - `stage1BValidationMode: mode === "stage-ready" ? "STRUCTURED_RETAIN" : "LIGHT_DECLUTTER"`
4. Evaluate local failures/hard-fail source and retry/fallback rules.
5. Optionally run Stage1B declutter-effectiveness validator.
6. Optionally run Gemini confirmation layer with retry loop.
7. Publish 1B on success; otherwise complete partial job with Stage 1A fallback.

### 2.3 Unified validation behavior for Stage 1B

`runUnifiedValidation(...)` in `worker/src/validators/runValidation.ts`:

- Executes local stack (unless SSIM early-exit escalates directly):
  - perceptual diff (SSIM gate)
  - windows validator
  - walls validator
  - global edge IoU
  - line/edge validator
  - anchor region validators
- Aggregates evidence + risk classification.
- Runs Gemini semantic validator per policy (`always`, `on_local_fail`, `never`).
- Computes `hardFail` and `blockSource`:
  - `gemini` if Gemini hard fail in block mode,
  - else `local` if enforce mode and local aggregate fails.
- Returns `UnifiedValidationResult` with reasons, warnings, evidence, risk level, and model used.

### 2.4 Stage 1B Gemini semantic validator mode mapping

`runGeminiSemanticValidator(...)` in `worker/src/validators/geminiSemanticValidator.ts`:

- Stage1B mode type:
  - `LIGHT_DECLUTTER`
  - `STRUCTURED_RETAIN`
- Prompt mapping:
  - `STRUCTURED_RETAIN` → `buildStage1BStructuredRetainValidatorPrompt(...)`
  - otherwise → `buildStage1BLightDeclutterValidatorPrompt(...)`
- Parses JSON verdict and applies hard-fail enforcement rules:
  - `MIN_CONFIDENCE = 0.75`
  - built-in hard-fail confidence guard `0.85`
  - Stage-aware category + violation-type hard-fail logic (openings/walls/camera are strict)
  - furniture/style categories are downgraded non-hard-fail.

### 2.5 Stage 1B declutter-effectiveness validator

`runStage1BDeclutterEffectivenessValidator(...)` and `evaluateStage1BDeclutterEffectiveness(...)` in `worker/src/validators/stage1BDeclutterEffectiveness.ts`:

- Gemini compares before/after and returns:
  - before clutter count
  - after clutter count
  - remaining clutter percent
  - remaining surface clutter count
  - confidence
- Thresholds (env-configurable, defaults shown):
  - `STAGE1B_DECLUTTER_CONFIDENCE_MIN = 0.8`
  - `STAGE1B_DECLUTTER_PERCENT_BASELINE_MIN = 5`
  - `STAGE1B_DECLUTTER_PERCENT_AFTER_MIN = 3`
  - `STAGE1B_DECLUTTER_MAX_REMAINING_PERCENT = 20`
  - `STAGE1B_DECLUTTER_ABSOLUTE_AFTER_BLOCK = 6`
  - `STAGE1B_DECLUTTER_SURFACE_AFTER_BLOCK = 3`
- Block triggers when confidence-eligible and any gate trips:
  - remaining percent too high,
  - absolute after clutter too high,
  - surface clutter too high.
- On parse/error, validator is fail-open and returns non-blocking baseline metrics unless external logic blocks on derived reasons.

### 2.6 Retry + fallback rules (worker Stage 1B loop)

From `worker/src/worker.ts` Stage 1B loop:

- Local/Gemini hard fail while retries remain:
  - retry Stage 1B up to `STAGE1B_MAX_ATTEMPTS`.
- If stage-ready mode exhausts retries:
  - switch to light fallback once and retry from attempt 1.
- If exhausted after fallback:
  - complete partial job, final output Stage 1A, with reason code.
- Declutter-effectiveness block follows same retry/fallback/exhaustion pattern.
- Error path (exceptions) follows same retry/fallback/exhaustion pattern.

Reason codes emitted include:

- `stage1b_runtime_exceeded`
- `stage1b_retries_exhausted`
- `stage1b_local_block_exhausted`
- `stage1b_declutter_block_exhausted`
- `stage1b_error_exhausted`
- `stage1b_gemini_exhausted`

### 2.7 Gemini confirmation layer after local Stage 1B pass/advisory

In `worker/src/worker.ts` using `confirmWithGeminiStructure(...)`:

- Trigger condition: `GEMINI_CONFIRMATION_ENABLED && stage1BNeedsConfirm && path1B`.
- Uses stage key `stage1b` and local reasons/evidence.
- If Gemini confirms fail and blocking enabled:
  - reruns Stage 1B with retry loop up to `GEMINI_CONFIRM_MAX_RETRIES`.
  - retries reduce sampling parameters progressively.
- If retries exhausted and still blocked:
  - publish/use Stage 1A as final safe fallback.

## 3) Fidelity notes

- This is a direct extraction draft from live source files at time of writing.
- The Stage 1B interior prompt above is intentionally copied as text, including strict anchor-retain behavior (one dominant anchor per zone) and subtractive-only constraints.