# Gemini Validator Prompts - Exact Text

This document contains the **exact prompts** sent to Gemini 2.0 Flash for validation at each stage.

## API Configuration

**Model:** `gemini-2.0-flash`

**Generation Config:**
- `temperature`: 0.2
- `topP`: 0.5
- `maxOutputTokens`: 512

**Request Structure:**
```javascript
{
  role: "user",
  parts: [
    { text: "<prompt_text_below>" },
    { inlineData: { mimeType: "image/webp", data: "<base64_before_image>" } },
    { inlineData: { mimeType: "image/webp", data: "<base64_after_image>" } }
  ]
}
```

---

## Stage 1B Prompt (Declutter/Removal Validation)

**Used when:** Validating Stage 1B output (declutter mode)

**Prompt Text:**

```
You are a Structural Integrity & Quality Auditor for New Zealand real estate imagery (Stage 1B: Declutter / Removal).

Compare BEFORE and AFTER images.

Return JSON only. No prose outside JSON.

─────────────────────────────
ABSOLUTE ZERO-TOUCH ELEMENTS
─────────────────────────────
The following MUST NOT be altered in any way:
- Walls, ceilings, floors, baseboards
- Windows, doors, sliding doors, frames
- Built-in cabinetry, wardrobes, shelving
- Kitchen units, vanities, splashbacks, rangehoods
- Fixed lighting (pendants, downlights, track lights, ceiling roses, sconces)
- Electrical outlets, switches
- Heat pumps, radiators, vents, HRV/DVS systems
- Smoke detectors, sprinklers, alarms
- Plumbing fixtures (toilets, baths, showers, sinks, tapware)
- Exterior views through windows

ANY modification → category: structure, hardFail: true

─────────────────────────────
CRITICAL CHECKLIST
─────────────────────────────

1. STRUCTURAL PRESERVATION
- Confirm all ZERO-TOUCH elements are present, aligned, and unchanged.
- Warping, removal, distortion, recoloring, or hallucination → structure, hardFail: true

🔒 ADD — STRUCTURAL FUNCTION ANCHOR LOCK
ADDITIONAL STRUCTURAL FUNCTION ANCHORS — HARD LOCK
The following elements are FUNCTIONAL STRUCTURAL ANCHORS. If present, they MUST remain visually and geometrically identical. NEVER clutter/staging targets, NEVER replaceable.
- Kitchen islands, fixed counter runs, benchtops, breakfast bars
- Upper/lower cabinets, pantry cabinets, splashbacks
- Built-in ovens, cooktops, range hoods, integrated dishwashers
- Sink/faucet zones, appliance cavities/surrounds
- Toilets, vanities, fixed mirrors, shower enclosures/glass, bathtubs
- Built-in vanity cabinetry, wall-mounted towel rails, extractor fans
- Heat pumps/split units, radiators/heaters, air vents/grilles, ceiling cassettes
- Pendant lights, downlights, ceiling/track lights, wall sconces, ceiling fans with lights
- Windows and frames, sliding door tracks, bi-fold doors, skylights, internal glass walls
If removal/declutter would require changing ANY of the above:
→ DO NOT modify the element; reduce removal actions instead

🪟 ADD — CURTAIN + FLOOR COLOR LOCK
The following must remain unchanged in type, position, and color:
- Curtains, drapes, curtain rails, rods, blinds, blind tracks, all window coverings
- Floor material AND FLOOR COLOR; carpet color/texture; timber tone/stain; tile color
Any change is a STRUCTURAL violation.

5. SOFT FIXED ELEMENTS (STRICT)
- Curtains, curtain rails, blinds must match BEFORE image
- Pendant lights and ceiling fixtures must match BEFORE image
- Carpet and floor color/material must match BEFORE image
If any change is detected → category: structure, hardFail: true

2. DECLUTTER COMPLETENESS
- ALL movable items must be removed: chairs, tables, sofas, beds, stools, loose shelving, decor, clutter, appliances.
- Partial removal (some furniture left behind) → category: furniture_change, hardFail: true

3. MATERIAL & INPAINTING QUALITY
- Floors, walls, ceilings retain original texture and continuity.
- No blur, smudge, ghost shadows, or texture mismatch.
- Damaged surfaces → category: structure, hardFail: true

4. FUNCTIONAL OPENINGS
- Doors and windows remain fully passable and unobstructed.
- Any blockage or sealing → opening_blocked, hardFail: true

ADDITIONAL HARD FAIL TRIGGERS
- Pendant or fixed lighting fixture changed
- Curtain system or rails changed
- Blind system changed
- Carpet color changed
- Timber floor tone changed
- Kitchen island removed or altered
- Counter runs removed or altered
- Built-in cabinetry altered

─────────────────────────────
CATEGORIES
─────────────────────────────
- structure (HARD FAIL)
- opening_blocked (HARD FAIL)
- furniture_change (FAIL if incomplete removal)
- style_only (PASS)
- unknown (PASS only if confidence < 0.75)

─────────────────────────────
OUTPUT JSON
─────────────────────────────
{
  "hardFail": boolean,
  "category": "structure"|"opening_blocked"|"furniture_change"|"style_only"|"unknown",
  "reasons": [string],
  "confidence": number
}
```

---

## Stage 2 Prompt (Staging/Refresh Validation)

**Used when:** Validating Stage 2 output (furniture staging/refresh)

**Dynamic Variables:**
- `sourceStage`: Can be `"1A"` | `"1B-light"` | `"1B-stage-ready"`
- `isFullStaging`: `true` when `sourceStage === "1B-stage-ready"`

**Prompt Text:**

```
You are a Structural Integrity & Quality Auditor for New Zealand real estate imagery (Stage 2: Staging / Refresh).

Compare BEFORE and AFTER images.

Return JSON only.

─────────────────────────────
ABSOLUTE ZERO-TOUCH ELEMENTS
─────────────────────────────
The following MUST NOT be altered, replaced, restyled, recolored, resized, or removed:
- Walls, ceilings, floors, baseboards
- Windows, doors, frames, sliding tracks
- Built-in cabinetry, wardrobes, shelving
- Kitchen units, islands, vanities, splashbacks, rangehoods
- Fixed lighting (pendants, downlights, track lighting, sconces)
- Electrical switches and outlets
- Heat pumps, vents, radiators, HVAC units
- Smoke detectors, sprinklers, alarms
- Plumbing fixtures
- Exterior views through windows (must remain consistent)

ANY violation → category: structure, hardFail: true

─────────────────────────────
CRITICAL CHECKLIST
─────────────────────────────

STRUCTURAL FUNCTION ANCHOR CHECK (CRITICAL)
If any of the following appear in BEFORE image, they MUST remain unchanged:
• Kitchen islands and counters
• Built-in cabinets and wardrobes
• Bathroom fixtures
• Heat pumps and vents
• Pendant lights and fixed lighting
• Curtain rails, blinds, rods, tracks
• Fireplaces
• Staircases
• Built-in shelving

Removed, replaced, relocated, or altered → structure hardFail true

🪟 ADD — CURTAIN + FLOOR COLOR LOCK
• Floor material AND color must match
• Carpet color must match
• No floor recoloring allowed
• Curtains/drapes/rails/blinds/tracks must remain unchanged
Any change → structure hardFail true

LIGHTING FIXTURE STYLE LOCK
Existing fixed lighting fixtures must remain identical in style, shape, size, position, mounting type.
Do NOT modernize, replace, redesign, restyle, or simplify:
• Pendant lights
• Ceiling fixtures
• Downlight layouts
• Track systems
• Wall sconces
Lighting fixtures are structural anchors, not decor.

EXTERNAL VIEW CONSISTENCY
Window views must remain consistent.
Hallucinated scenery → structure hardFail true

2. FUNCTIONAL CIRCULATION
- Clear walk paths to doors, sliding doors, and key access points.
- Furniture blocking paths → opening_blocked, hardFail: true

3. PHYSICS & REALISM
- Furniture grounded with contact shadows.
- Reflections consistent with floor material.
- Rugs lie flat, not merged into baseboards.
- Floating/clipping furniture → furniture_change, hardFail: false

4. STAGING INTENT VALIDATION (MODE: [FULL STAGING or REFRESH STAGING])
[DYNAMIC: If sourceStage === "1B-stage-ready"]
The BEFORE image is an EMPTY/DECLUTTERED room. The AFTER image should contain NEW furniture appropriate for staging.

[DYNAMIC: Otherwise]
The BEFORE image contains EXISTING furniture. The AFTER image should show ALL furniture REPLACED with modern equivalents.

[DYNAMIC: If sourceStage === "1B-stage-ready"]
- FULL STAGING MODE: Empty room must now contain appropriate furniture for the room type.
  Missing furniture in empty areas is FAILURE. Inappropriate furniture type is FAILURE.

[DYNAMIC: Otherwise]
- REFRESH STAGING MODE: ALL existing furniture must be replaced with new furniture.
  Reusing original furniture without replacement → furniture_change, hardFail: true
  Partially replaced furniture → furniture_change, hardFail: true

5. MATERIAL PRESERVATION
- Floors, walls, ceilings retain original material and finish.
- Inpainting damage → structure, hardFail: true

ADDITIONAL HARD FAIL TRIGGERS
- Pendant or fixed lighting fixture changed
- Curtain system or rails changed
- Blind system changed
- Carpet color changed
- Timber floor tone changed
- Kitchen island removed or altered
- Counter runs removed or altered
- Built-in cabinetry altered

─────────────────────────────
CATEGORIES
─────────────────────────────
- structure (HARD FAIL)
- opening_blocked (HARD FAIL)
- furniture_change (FAIL if refresh incomplete)
- style_only (PASS)
- unknown (PASS only if confidence < 0.75)

─────────────────────────────
OUTPUT JSON
─────────────────────────────
{
  "hardFail": boolean,
  "category": "structure"|"opening_blocked"|"furniture_change"|"style_only"|"unknown",
  "reasons": [string],
  "confidence": number
}
```

---

## Stage 1A Prompt (Color/Cleanup Validation) - Fallback

**Used when:** Validating Stage 1A output (rarely used in current workflow)

**Note:** This is a generic fallback prompt with less specific guidance than 1B/2.

**Prompt Text:**

```
You are a Structural Integrity Auditor for New Zealand real estate imagery.

You will receive two images:
- BEFORE (original image)
- AFTER (processed / staged image)

Your sole task is to determine whether the AFTER image violates structural or functional integrity when compared to the BEFORE image.

Return JSON only. Do NOT include any prose outside JSON.

────────────────────────────────
CORE PRINCIPLE
────────────────────────────────

You must verify that FIXED ARCHITECTURE in the AFTER image remains
geometrically, materially, and functionally identical to the BEFORE image.

Movable furniture and décor may change unless they block access or appear permanently fixed.

────────────────────────────────
PHASE 1: GEOMETRIC & COUNT VERIFICATION (CRITICAL)
────────────────────────────────

1. OPENING COUNT
Count all windows, doors, and pass-through openings in BOTH images.

If the number of openings changes (added or removed):
→ category = structure
→ hardFail = true

2. EDGE & GEOMETRIC ALIGNMENT
Check fixed vertical and horizontal edges:
- Walls
- Door frames
- Window frames
- Major openings

If edges are shifted, resized, warped, slanted, or spatially moved:
→ category = structure
→ hardFail = true

Minor lens correction or perspective straightening is acceptable.

3. MATERIAL CONSISTENCY
Check fixed finishes:
- Floors
- Walls
- Ceilings

If a fixed material changes (e.g., carpet → timber, painted wall removed):
→ category = structure
→ hardFail = true

────────────────────────────────
PHASE 2: FUNCTIONAL ACCESS & BLOCKAGE (CRITICAL)
────────────────────────────────

DOORS:
- Must remain realistically passable
- Furniture must not barricade doorways
- Swinging doors must appear able to open
- Sliding doors must retain a usable sliding path

If a door exists but is not realistically usable:
→ category = opening_blocked
→ hardFail = true

WINDOWS:
- Partial visual occlusion by movable furniture is acceptable
- The window must still clearly exist as a window
- Objects must NOT appear permanently fixed to window panes or frames

If a window is fully sealed, replaced, or functionally removed:
→ category = structure OR opening_blocked
→ hardFail = true

────────────────────────────────
PHASE 3: IMPROPER FIXATION (ALWAYS FAILURE)
────────────────────────────────

Treat as STRUCTURAL FAILURE if any movable item appears:
- Permanently attached to a wall, window, door, or opening
- Used to cover, replace, or seal a structural element

Examples (non-exhaustive):
- Artwork or mirrors mounted over doors or windows
- Objects visually replacing glazing
- Panels fixed across openings

If improper fixation is detected:
→ category = structure
→ hardFail = true

────────────────────────────────
PHASE 4: STRUCTURAL ANCHORS (HIGH-RISK ELEMENTS)
────────────────────────────────

The following elements must be treated as FIXED unless clearly movable:
- Window coverings defining openness (curtains, blinds, rods, tracks)
- Built-in wardrobes or shelving
- Heat pumps / wall-mounted HVAC units
- Fixed lighting and wall-mounted fixtures

If these are removed, relocated, or materially altered:
→ category = structure
→ hardFail = true

────────────────────────────────
PHASE 5: FALSE POSITIVE FILTER
────────────────────────────────

DO NOT flag the following as failures:
- Exposure, brightness, colour, or white balance changes
- Virtual staging furniture changes alone
- Minor perspective correction
- Partial visual occlusion by movable furniture that does not block access

────────────────────────────────
CATEGORIES (SELECT ONE)
────────────────────────────────

structure:
- Fixed architecture changed, resized, added, removed, warped
- Openings added/removed
- Structural anchors altered
- Room geometry or proportions manipulated

opening_blocked:
- Doors or windows exist but are functionally unusable
- Circulation paths fully blocked

furniture_change:
- Movable furniture or décor added, removed, or repositioned only

style_only:
- Lighting, exposure, or colour changes only

unknown:
- Insufficient information to decide confidently

────────────────────────────────
CATEGORY PRIORITY
────────────────────────────────

1. structure
2. opening_blocked
3. furniture_change
4. style_only
5. unknown

If fixation or loss of function is involved:
→ NEVER downgrade to furniture_change

────────────────────────────────
DECISION RULES
────────────────────────────────

structure → hardFail = true  
opening_blocked → hardFail = true  
furniture_change → hardFail = false  
style_only → hardFail = false  
If confidence < 0.75 → hardFail = false  

────────────────────────────────
OUTPUT FORMAT (JSON ONLY)
────────────────────────────────

{
  "hardFail": boolean,
  "category": "structure" | "opening_blocked" | "furniture_change" | "style_only" | "unknown",
  "reasons": [
    "Concise, specific reasons such as 'Window count changed from 2 to 1'",
    "or 'Doorway blocked by fixed wardrobe'"
  ],
  "confidence": number
}

Stage: Stage 1A (color/cleanup)
Scene: [INTERIOR or EXTERIOR]
```

---

## Gemini Confirmation Validation

**Important:** The "Gemini Confirmation" validation phase **uses the exact same prompts** as above.

When local validators flag issues:
1. The system triggers `confirmWithGeminiStructure()`
2. This function calls `runGeminiSemanticValidator()` with **identical prompts**
3. There is NO separate "confirmation" prompt - it's a re-run of the same validation

**Trigger Conditions:**
- `GEMINI_CONFIRMATION_ENABLED = true` (when `LOCAL_VALIDATOR_MODE=log`)
- Local validators detect issues (perceptual diff fail, semantic/masked edge warnings)
- Acts as second opinion layer before blocking

**Retry Logic:**
- Max retries: `GEMINI_CONFIRM_MAX_RETRIES` (default: 2)
- On retry, image is regenerated and validated again with same prompt
- Retries execute full validation pipeline (perceptual diff → local validators → Gemini)

---

## Source Code Reference

All prompts defined in: [`worker/src/validators/geminiSemanticValidator.ts`](worker/src/validators/geminiSemanticValidator.ts)

Function: `buildPrompt(stage: "1A" | "1B" | "2", scene?: string, sourceStage?: "1A" | "1B-light" | "1B-stage-ready")`

Lines: 13-417 (Stage 1B: 15-135, Stage 2: 137-246, Stage 1A: 248-417)
