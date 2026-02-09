# Gemini Stage 2 Validation Prompt - Empty Room Staging (FULL STAGING MODE)

**Trigger Condition:** `sourceStage === "1B-stage-ready"` (empty/decluttered room from Stage 1B)

**Source:** [worker/src/validators/geminiSemanticValidator.ts](worker/src/validators/geminiSemanticValidator.ts#L121-L246) lines 121-246

**API Configuration:**
- Model: `gemini-2.0-flash`
- Temperature: `0.2`
- TopP: `0.5`
- MaxOutputTokens: `512`

---

## Exact Prompt Text Sent to Gemini

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

4. STAGING INTENT VALIDATION (MODE: FULL STAGING)
The BEFORE image is an EMPTY/DECLUTTERED room. The AFTER image should contain NEW furniture appropriate for staging.
- FULL STAGING MODE: Empty room must now contain appropriate furniture for the room type.
  Missing furniture in empty areas is FAILURE. Inappropriate furniture type is FAILURE.

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

## Code Verification

**Template Variables Resolution:**
```typescript
// From geminiSemanticValidator.ts lines 121-127
const isFullStaging = sourceStage === "1B-stage-ready";  // TRUE for empty room
const stagingModeInstruction = isFullStaging
  ? "The BEFORE image is an EMPTY/DECLUTTERED room. The AFTER image should contain NEW furniture appropriate for staging."
  : "The BEFORE image contains EXISTING furniture. The AFTER image should show ALL furniture REPLACED with modern equivalents.";

const stagingIntentRule = isFullStaging
  ? "- FULL STAGING MODE: Empty room must now contain appropriate furniture for the room type.\n  Missing furniture in empty areas is FAILURE. Inappropriate furniture type is FAILURE."
  : "- REFRESH STAGING MODE: ALL existing furniture must be replaced with new furniture.\n  Reusing original furniture without replacement → furniture_change, hardFail: true\n  Partially replaced furniture → furniture_change, hardFail: true";
```

**Substitution in Prompt:**
```typescript
// Line 201 in template:
4. STAGING INTENT VALIDATION (MODE: ${isFullStaging ? 'FULL STAGING' : 'REFRESH STAGING'})
${stagingModeInstruction}
${stagingIntentRule}

// Resolves to:
4. STAGING INTENT VALIDATION (MODE: FULL STAGING)
The BEFORE image is an EMPTY/DECLUTTERED room. The AFTER image should contain NEW furniture appropriate for staging.
- FULL STAGING MODE: Empty room must now contain appropriate furniture for the room type.
  Missing furniture in empty areas is FAILURE. Inappropriate furniture type is FAILURE.
```

**Call Chain:**
1. Worker calls validation with `sourceStage: "1B-stage-ready"`
2. `runGeminiSemanticValidator()` calls `buildPrompt(stage="2", sceneType, sourceStage="1B-stage-ready")`
3. `buildPrompt()` sets `isFullStaging = true` and substitutes dynamic text
4. Assembled prompt sent to `models.generateContent()` at line 476

**Images Sent:**
- BEFORE: Empty/decluttered room from Stage 1B output
- AFTER: Staged room with furniture from Stage 2 output

---

## Key Differences: Empty Room vs Existing Furniture

| Aspect | Empty Room (1B-stage-ready) | Existing Furniture (1A/1B-light) |
|--------|----------------------------|----------------------------------|
| **Mode Line** | `MODE: FULL STAGING` | `MODE: REFRESH STAGING` |
| **Instruction** | "BEFORE is EMPTY/DECLUTTERED... AFTER should contain NEW furniture" | "BEFORE contains EXISTING... AFTER should show ALL REPLACED" |
| **Failure Rule** | "Missing furniture in empty areas is FAILURE" | "Reusing original furniture → furniture_change, hardFail: true" |
| **Intent** | Add appropriate staging furniture | Replace all existing furniture |

---

## Verification Status

✅ **CONFIRMED ACTIVE** - This is the exact prompt sent to Gemini 2.0 Flash when validating Stage 2 output from an empty room (sourceStage="1B-stage-ready").

No environment variables, overrides, or config modifications affect this prompt. The code at [worker/src/validators/geminiSemanticValidator.ts](worker/src/validators/geminiSemanticValidator.ts) line 121-246 is the single source of truth.
