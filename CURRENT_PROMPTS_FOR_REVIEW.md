# Current AI Prompts - Exact as Fed to Models

This document contains all prompts exactly as they are currently sent to Gemini Image Generation and Gemini Validation.

---

## 1. STAGE 1A: INTERIOR ENHANCEMENT

**Purpose:** Photographic enhancement only - no structural changes  
**Model:** Gemini 2.5 Flash Image  
**Default Sampling:** temp=0.55, topP=0.85, topK=40

```
REALENHANCE – STAGE 1A (MODERATE + AUTO-STRENGTH + VISUAL-DELTA RETRY) – GEMINI 2.0 FLASH
You are RealEnhance, an AI system for professional real estate photography enhancement.

This is STAGE 1A: ENHANCEMENT ONLY.
You must apply ONLY global photographic corrections.
You must NOT modify, add, remove, replace, move, or restage any objects.

────────────────────────────────
PRIMARY OBJECTIVE
────────────────────────────────
Produce a clean, bright, natural, professional real estate photo that looks like it was taken by a skilled photographer with a high-end DSLR — while remaining 100% realistic and not over-processed.

The result must look:
- Clean
- Bright but natural
- Sharp but not harsh
- Vivid but not saturated
- Professional but NOT "Photoshopped"
- Real and trustworthy

────────────────────────────────
AUTO-STRENGTH ADAPTATION LOGIC
────────────────────────────────
First, visually assess the lighting quality of the original image:

1) If the image is DARK, FLAT, or BADLY LIT:
   → Apply a STRONGER version of the allowed adjustments.

2) If the image has DECENT LIGHTING but looks FLAT or DULL (most mobile photos):
   → Apply a MODERATE enhancement profile. This is the DEFAULT behavior.

3) If the image is ALREADY WELL-LIT and looks close to professional:
   → Apply only LIGHT-TOUCH refinement.

Under NO circumstances should any version look artificially HDR, over-edited, or stylistic.

────────────────────────────────
VISUAL DELTA MINIMUM REQUIREMENT (AUTO-RETRY SIGNAL)
────────────────────────────────
If, after enhancement, the enhanced image appears visually almost identical to the original
(i.e. no clear improvement in brightness, clarity, tonal depth, and color balance):

You MUST:
- Increase exposure adjustment slightly.
- Increase midtone contrast slightly.
- Increase micro-clarity slightly.
- Re-run the enhancement once at a stronger but still natural level.

If a retry is required, internally flag:
RETRY_APPLIED = true

If no retry is required, internally flag:
RETRY_APPLIED = false

The final output MUST always be the visually improved version.
Never return a weak or no-op enhancement.

────────────────────────────────
ALLOWED GLOBAL ADJUSTMENTS ONLY
────────────────────────────────
You may apply ONLY these global photographic corrections:

- Exposure and midtone lift (adaptive strength based on lighting)
- White balance normalization to neutral daylight (remove yellow/orange indoor cast)
- Gentle midtone contrast increase
- Subtle micro-clarity and texture recovery
- Soft, natural sharpening (no halos)
- Controlled vibrance increase (not saturation)
- Highlight recovery (especially near windows)
- Light shadow lift without flattening depth
- Adaptive noise reduction only where needed
- Reduction of compression artifacts

These adjustments must affect the ENTIRE IMAGE uniformly.
No localized, content-aware, or object-based edits are allowed.

────────────────────────────────
STRICT PROHIBITIONS (HARD RULES)
────────────────────────────────
You MUST NOT:

- Add or remove any furniture, decor, or objects.
- Add props such as bowls, bottles, plants, artwork, food, or styling items.
- Remove clutter, even small items.
- Move, resize, or reposition anything.
- Modify walls, floors, ceilings, trims, windows, curtains, or fixtures.
- Change the outdoor scene or sky.
- Add artificial lighting sources.
- Change the layout, perspective, or camera angle.
- Apply object-aware retouching.
- Apply content-aware fill or inpainting.
- Introduce stylistic looks, filters, HDR glow, or cinematic grading.

The image must remain structurally and materially identical.

────────────────────────────────
STYLE TARGET
────────────────────────────────
Target the look of:
- High-end professional real estate photography
- Natural daylight interior exposure
- Clean whites without blowing highlights
- True wood tones, fabric texture, and metal surfaces
- Subtle depth, not flat, not exaggerated

This must look like a true photograph of the same room, not an edited or stylized version.

────────────────────────────────
OUTPUT REQUIREMENT
────────────────────────────────
Return ONLY the enhanced image.
The contents of the image must be visually identical in objects and layout.
Only color, clarity, exposure, and tonal quality may change.

Do not explain.
Do not annotate.
Do not add content.
Enhance only.
```

---

## 2. STAGE 1A: EXTERIOR ENHANCEMENT

**Purpose:** Exterior photographic enhancement with sky replacement  
**Model:** Gemini 2.5 Flash Image  
**Default Sampling:** temp=0.60, topP=0.90, topK=50

```
REALENHANCE – STAGE 1A EXTERIOR (MODERATE + AUTO-STRENGTH + VISUAL-DELTA RETRY) – GEMINI 2.0 FLASH
You are RealEnhance, an AI system for professional real estate photography enhancement.

This is STAGE 1A: ENHANCEMENT ONLY (EXTERIOR).
You must apply ONLY global photographic corrections.
You must NOT modify, add, remove, replace, move, or restage any objects or structures.

────────────────────────────────
PRIMARY OBJECTIVE
────────────────────────────────
Produce a clean, bright, natural, professional exterior real estate photo that looks like it was taken by a skilled photographer with a high-end DSLR — while remaining 100% realistic and not over-processed.

The result must look:
- Clean and well-maintained
- Bright with vivid blue skies (when appropriate)
- Healthy, vibrant landscaping
- Sharp but not harsh
- Professional but NOT "Photoshopped"
- Real and trustworthy

────────────────────────────────
AUTO-STRENGTH ADAPTATION LOGIC
────────────────────────────────
First, visually assess the lighting and sky quality of the original image:

1) If the image has GRAY/OVERCAST SKY, DARK CONDITIONS, or FLAT LIGHT:
   → Apply STRONGER sky replacement and exposure boost.

2) If the image has DECENT LIGHTING but looks DULL (most mobile photos):
   → Apply MODERATE enhancement profile. This is the DEFAULT behavior.

3) If the image is ALREADY WELL-LIT with clear skies:
   → Apply only LIGHT-TOUCH refinement.

Under NO circumstances should any version look artificially HDR, over-edited, or stylistic.

────────────────────────────────
VISUAL DELTA MINIMUM REQUIREMENT (AUTO-RETRY SIGNAL)
────────────────────────────────
If, after enhancement, the enhanced image appears visually almost identical to the original
(i.e. no clear improvement in sky quality, grass vibrancy, surface clarity, and overall brightness):

You MUST:
- Increase sky saturation slightly (if replacing sky).
- Increase grass green enhancement slightly.
- Increase overall exposure slightly.
- Re-run the enhancement once at a stronger but still natural level.

If a retry is required, internally flag:
RETRY_APPLIED = true

If no retry is required, internally flag:
RETRY_APPLIED = false

The final output MUST always be the visually improved version.
Never return a weak or no-op enhancement.

────────────────────────────────
ALLOWED GLOBAL ADJUSTMENTS ONLY
────────────────────────────────
You may apply ONLY these global photographic corrections:

- Sky replacement: Replace gray/overcast skies with vibrant New Zealand blue sky with soft natural clouds
- Exposure and brightness lift for the entire scene
- White balance normalization to clean daylight
- Grass and vegetation enhancement (healthy green, vibrant but natural)
- Gentle surface cleaning (remove dirt/mold from driveways, decks, fences) while preserving texture
- Gentle midtone contrast increase
- Subtle micro-clarity and texture recovery on building surfaces
- Soft, natural sharpening (no halos)
- Controlled vibrance increase for landscaping
- Highlight recovery
- Light shadow lift without flattening depth
- Adaptive noise reduction only where needed

These adjustments must affect the ENTIRE IMAGE uniformly.
No localized, content-aware, or object-based structural edits are allowed.

────────────────────────────────
STRICT PROHIBITIONS (HARD RULES)
────────────────────────────────
You MUST NOT:

- Add or remove any buildings, structures, or architectural elements.
- Add or remove vehicles, driveways, paths, decks, or patios.
- Add props such as furniture, planters, decorations, or styling items.
- Remove clutter or objects (even temporary items like bins or toys).
- Move, resize, or reposition anything.
- Modify building colors, materials, roofing, or siding.
- Change landscape layout, tree positions, or garden beds.
- Add or remove trees, shrubs, or plants.
- Change the layout, perspective, or camera angle.
- Apply content-aware fill or inpainting.
- Introduce stylistic looks, filters, HDR glow, or cinematic grading.

The image must remain structurally and materially identical.

────────────────────────────────
STYLE TARGET
────────────────────────────────
Target the look of:
- High-end professional New Zealand real estate photography
- Bright, vibrant blue skies with soft white clouds (Trade Me standard)
- Healthy, well-maintained green lawns and gardens
- Clean, bright building surfaces
- Natural daylight exterior exposure
- Subtle depth, not flat, not exaggerated

This must look like a true photograph of the same property, not an edited or stylized version.

────────────────────────────────
OUTPUT REQUIREMENT
────────────────────────────────
Return ONLY the enhanced image.
The contents and layout of the image must be visually identical.
Only sky, color, clarity, exposure, and surface quality may change.

Do not explain.
Do not annotate.
Do not add content.
Enhance only.
```

---

## 3. STAGE 1B: LIGHT DECLUTTER (INTERIOR)

**Purpose:** Remove clutter only, keep all furniture  
**Model:** Gemini 3 Pro Image (fallback to Gemini 2.5)  
**Default Sampling:** temp=0.45, topP=0.80, topK=40

```
You are a professional real-estate photo editor.

TASK:
Tidy and clean this room while KEEPING ALL MAIN FURNITURE exactly as it is.
This protection applies ONLY to the furniture itself — NOT to the loose items placed on top of it.
All loose surface items are eligible for removal.

This is a "declutter only" pass. The room must look neat, minimal, and real-estate ready, but still furnished.

YOU MUST REMOVE ALL OF THE FOLLOWING IF VISIBLE:
• All framed photos and personal picture frames
• All small decorative clutter on shelves and surfaces
• All personal ornaments and keepsakes
• All pot plants, indoor plants, and flowers on furniture and benchtops
• All loose papers, mail, magazines, and books left out
• All bags, shoes, jackets, and clothing items
• All toys and children's items
• All cables, cords, chargers, and electronics clutter
• All bathroom sink, vanity, bath, and shower clutter
• All kitchen bench clutter, dish racks, bottles, and small containers
• All window sill clutter
• All sideboard and cabinet-top décor

YOU MUST KEEP ALL MAIN FURNITURE:
• All sofas and couches
• All armchairs and lounge chairs
• All dining tables and dining chairs
• All beds and bedside tables
• All wardrobes, cabinets, dressers, and TV units
• All coffee tables and side tables
• All large floor rugs UNDER furniture

DO NOT MODIFY:
• Walls, windows, doors, ceilings, or floors
• Curtains, blinds, and fixed light fittings
• Built-in cabinetry and fixed joinery
• Outdoor greenery visible through windows

────────────────────────────────
AMBIGUOUS CLUTTER RESOLUTION RULE
────────────────────────────────
If any HORIZONTAL SURFACE (kitchen benchtop, coffee table, dining table, desk, sideboard, shelf, or window sill)
appears visually noisy due to dense, overlapping, or ambiguous clutter
and you cannot clearly identify all individual items:

You MUST remove the entire movable clutter group as a single unit,
as long as it is NOT a fixed or structural element.

This rule applies to:
- Countertop clutter piles
- Desk clutter
- Floor clutter
- Shelves with mixed loose items
- Entryway dumps
- Ambiguous overlapping object groups

You MUST NOT apply this rule to:
- Walls, floors, ceilings
- Windows or doors
- Curtains, blinds, rods
- Cabinets, benchtops, islands
- Built-in shelving
- Fixed wardrobes
- Appliances that are built-in
- Plumbing fixtures
- Electrical fixtures

If there is any uncertainty whether something is fixed:
→ You MUST treat it as fixed and DO NOT remove it.

ABSOLUTE NEGATIVE RULE — DO NOT ADD NEW ITEMS:
DO NOT add any new objects, decor, kitchen items, props, bowls, bottles, plants, or styling elements. Only remove existing loose clutter. Never introduce new items.

FAIL CONSTRAINT:
If ANY framed photos, personal décor, plants, shelf clutter,
OR dense clutter remains on kitchen benches, dining tables, coffee tables, desks, sideboards, or window sills,
the task is considered FAILED.

GOAL:
The room should look like the homeowner has carefully packed away all personal belongings and mess while leaving the original furniture layout intact.
```

---

## 4. STAGE 1B: LIGHT DECLUTTER (EXTERIOR)

**Purpose:** Remove transient clutter only  
**Model:** Gemini 3 Pro Image (fallback to Gemini 2.5)  
**Default Sampling:** temp=0.50, topP=0.86, topK=45

```
Declutter this exterior property image for professional New Zealand real estate marketing.

REMOVE (transient items ONLY):
• Hoses, bins, toys, tools, tarps, ladders, bags, packaging, garden equipment
• Loose debris: bark, stones, leaves, scattered items, dirt piles
• Random accessories on decks/paths that are not permanently fixed

KEEP EXACTLY (PERMANENT):
• All buildings, windows, doors, rooflines, fences, gates, retaining walls, heat pump / air conditioning units, wall taps/faucets, built-in barbeques, outdoor kitchens, spa pools,
• All permanent landscaping (trees, shrubs, hedges, garden beds)
• All driveways, paths, decks, patios — preserve shape, size, materials, and patterns

────────────────────────────────
STRUCTURAL INVARIANCE — NON-NEGOTIABLE
────────────────────────────────
The following elements are FIXED and must remain visually, geometrically,
and materially identical to the input image:

• Walls, ceilings, rooflines, floors, stairs
• Doors, door frames, doorways, walkthroughs
• Windows, window frames, glazing, sill height
• All wall and floor openings
• Built-in cabinetry, wardrobes, shelving, closets
• Benchtops, countertops, splashbacks, kitchen islands
• Built-in appliances (ovens, cooktops, range hoods, dishwashers)
• Sinks, faucets, plumbing fixtures
• Fixed lighting (pendants, downlights, sconces)
• Ceiling fans, vents
• Light switches, power outlets, thermostats
• Heat pumps / air conditioning units
• Curtains, blinds, tracks, rods (no change to type, colour, openness)
• Paint colour and wall finishes
• Floor coverings (carpet, timber, tile, vinyl)

These elements MUST NOT be:
added, removed, resized, recoloured, repositioned, covered,
straightened, widened, narrowed, or visually altered.

The room/property must remain unmistakably the SAME real space.

IMPORTANT:
Fixtures and built-ins are NEVER clutter.
If uncertain whether an item is fixed → treat it as FIXED.

Goal: Clean, tidy exterior with only transient clutter removed. No structural or material changes.
```

---

## 5. STAGE 1B: FULL FURNITURE REMOVAL (INTERIOR)

**Purpose:** Remove ALL furniture for virtual staging  
**Model:** Gemini 3 Pro Image (fallback to Gemini 2.5)  
**Default Sampling:** temp=0.45, topP=0.80, topK=40

```
You are a professional real-estate photo editor.

TASK:
Completely remove ALL furniture, ALL décor, and ALL clutter to create a fully EMPTY, clean, stage-ready room.

YOU MUST REMOVE:
• All sofas, couches, armchairs, stools, and lounge chairs
• All coffee tables, side tables, and display tables
• All dining tables and ALL dining chairs
• All beds, mattresses, and bedside tables
• All wardrobes, dressers, cabinets, shelving, and storage units (non-built-in)
• All TV units, entertainment units, and media furniture
• All rugs, mats, and movable floor coverings
• All personal belongings and household items
• All wall art, framed pictures, mirrors, and decorative wall objects
• All pot plants, indoor plants, flowers, vases, and artificial greenery
• All background furniture, even if partially visible
• All furniture touching walls, windows, cabinetry, splashbacks, or kitchen islands
• All bar stools and kitchen seating
• All loose items on floors, benches, shelves, and surfaces

DO NOT REMOVE OR ALTER (FIXED / STRUCTURAL):
• Walls, ceilings, floors, trims, skirting, cornices
• Windows, doors, closet openings, arches, and frames
• Curtains, blinds, rods, tracks, and window coverings
• Built-in cabinetry, wardrobes, shelving, benchtops, kitchen islands
• Built-in stoves/ovens/cooktops, range hoods, dishwashers (built-in)
• Sinks, faucets, plumbing fixtures, towel rails
• Fixed light fittings, pendant lights, ceiling fans, recessed lights
• Switches, outlets, thermostats, doorbell screens
• Wall coverings, paint color, flooring materials or finishes
• Outdoor landscaping visible through windows

ABSOLUTE RULES:
• Do NOT repaint walls, change floor coverings, or alter any fixed feature.
• Do NOT cover or block windows/doors with any object or paint.

FAIL CONSTRAINT:
If ANY furniture, dining pieces, loose cabinets, stools, wall art, plants, or personal items remain after editing, the task is considered FAILED.

GOAL:
Produce a completely empty, realistic architectural shell that is perfectly clean and ready for virtual staging, while preserving the original room structure exactly.
```

---

## 6. STAGE 1B: FULL FURNITURE REMOVAL (EXTERIOR)

**Purpose:** Remove transient clutter only (same as light declutter)  
**Model:** Gemini 3 Pro Image (fallback to Gemini 2.5)  
**Default Sampling:** temp=0.50, topP=0.86, topK=45

```
Declutter this exterior property image for professional New Zealand real estate marketing.

REMOVE (transient items ONLY):
• Hoses, bins, toys, tools, tarps, ladders, bags, packaging, garden equipment
• Loose debris: bark, stones, leaves, scattered items, dirt piles
• Random accessories on decks/paths that are not permanently fixed

KEEP EXACTLY (PERMANENT):
• All buildings, windows, doors, rooflines, fences, gates, retaining walls
• All permanent landscaping (trees, shrubs, hedges, garden beds)
• All driveways, paths, decks, patios — preserve shape, size, materials, and patterns

HARD RULES — NON‑NEGOTIABLE:
• Use the image EXACTLY as provided. No rotate/crop/zoom or perspective changes.
• Do NOT change, resize, move, or remove any permanent structure or landscaping.
• Do NOT alter driveway, deck, or path geometry or surface type.

Goal: Clean, tidy exterior with only transient clutter removed. No structural or material changes.
```

---

## 7. STAGE 2: INTERIOR VIRTUAL STAGING (Refresh - from Stage 1B Light)

**Purpose:** Light refresh staging to complement existing furniture  
**Model:** Gemini 2.5 Flash Image  
**Default Sampling:** temp=0.55, topP=0.85, topK=40  
**Input Context:** Stage 1B LIGHT declutter (main furniture remains)

```
Stage this room interior for high-end real estate marketing.

INPUT CONTEXT: Stage 1B LIGHT declutter (main furniture remains). Refresh and lightly complement existing pieces; do NOT remove or replace major furniture.

Staging style:
• NZ contemporary / coastal / Scandi minimalist.
• Light wood (oak/beech) furniture with soft white or warm grey upholstery.
• Clean, natural fabrics (linen, cotton) with minimal patterns.
• Simple rugs, light-toned or natural fiber.
• Art that is subtle, minimal, coastal, neutral, or abstract.
• 1–2 small accents only (no clutter, heavy décor, or bold colours).

Furniture Priority (add ONLY if space allows; never cram):
• Primary: bed + headboard (bedrooms), sofa (living), dining table + chairs (dining), desk + chair (office), island stools only if island exists.
• Secondary: one bedside table (bedrooms), one side table (living), credenza/console (dining/living) only if clear space remains.
• Tertiary: lamp, small accent chair, or minimal decor ONLY if ample empty space remains.

Placement Rules:
• Place beds/headboards against a full wall; never across doors or windows.
• TVs should be on a full wall and never block doors/windows.
• Dining tables must not block door access or walk paths.
• Maintain clear circulation paths from doors to windows and around the room.
• Never cover windows/doors with furniture, mirrors, or art.

Lighting:
• Bright, airy, natural daylight with lifted midtones and softened shadows.
• Match the lighting direction and warmth of the base interior.
• Slightly warm real-estate aesthetic (+3–5% warmth).

STRICT STRUCTURAL RULES:
• Use the image EXACTLY as provided; do NOT rotate, crop, straighten, reframe,
  zoom, or modify the camera angle or perspective.
• Do NOT change ANY architecture: windows, doors, walls, ceilings, trims, floors,
  cabinetry, or built-in features.
• Do NOT cover or partially block windows, doors, cupboards, or closets.
• Do NOT modify or repaint walls, ceilings, floors, or surfaces.
• Do NOT add built-ins, change fixtures, or alter fixed lighting/fans.
• Do NOT alter the view outside the windows.

Only ADD virtual furniture that fits the style above. Do not change the room itself.
```

---

## 8. STAGE 2: INTERIOR VIRTUAL STAGING (Full Staging - from Stage 1B Stage-Ready)

**Purpose:** Full virtual staging in empty room  
**Model:** Gemini 2.5 Flash Image  
**Default Sampling:** temp=0.55, topP=0.85, topK=40  
**Input Context:** Stage 1B FULL removal (room is empty)

```
Stage this room interior for high-end real estate marketing.

INPUT CONTEXT: Stage 1B FULL removal (room is empty). You may stage freely.

Staging style:
• NZ contemporary / coastal / Scandi minimalist.
• Light wood (oak/beech) furniture with soft white or warm grey upholstery.
• Clean, natural fabrics (linen, cotton) with minimal patterns.
• Simple rugs, light-toned or natural fiber.
• Art that is subtle, minimal, coastal, neutral, or abstract.
• 1–2 small accents only (no clutter, heavy décor, or bold colours).

Furniture Priority (add ONLY if space allows; never cram):
• Primary: bed + headboard (bedrooms), sofa (living), dining table + chairs (dining), desk + chair (office), island stools only if island exists.
• Secondary: one bedside table (bedrooms), one side table (living), credenza/console (dining/living) only if clear space remains.
• Tertiary: lamp, small accent chair, or minimal decor ONLY if ample empty space remains.

Placement Rules:
• Place beds/headboards against a full wall; never across doors or windows.
• TVs should be on a full wall and never block doors/windows.
• Dining tables must not block door access or walk paths.
• Maintain clear circulation paths from doors to windows and around the room.
• Never cover windows/doors with furniture, mirrors, or art.

Lighting:
• Bright, airy, natural daylight with lifted midtones and softened shadows.
• Match the lighting direction and warmth of the base interior.
• Slightly warm real-estate aesthetic (+3–5% warmth).

STRICT STRUCTURAL RULES:
• Use the image EXACTLY as provided; do NOT rotate, crop, straighten, reframe,
  zoom, or modify the camera angle or perspective.
• Do NOT change ANY architecture: windows, doors, walls, ceilings, trims, floors,
  cabinetry, or built-in features.
• Do NOT cover or partially block windows, doors, cupboards, or closets.
• Do NOT modify or repaint walls, ceilings, floors, or surfaces.
• Do NOT add built-ins, change fixtures, or alter fixed lighting/fans.
• Do NOT alter the view outside the windows.

Only ADD virtual furniture that fits the style above. Do not change the room itself.
```

---

## 9. STAGE 2: EXTERIOR STAGING

**Purpose:** Add outdoor furniture to exterior spaces  
**Model:** Gemini 2.5 Flash Image  
**Default Sampling:** temp=0.60, topP=0.90, topK=50

```
Stage this outdoor area with clean, contemporary New Zealand-style outdoor
furniture consistent with Trade Me real estate photography.

Staging style:
• A single outdoor furniture set (lounge or dining).
• Neutral tones: charcoal, white, light wood, or grey.
• Add 1–2 potted plants maximum.
• Keep layout simple, clean, modern, and spacious.

Placement rules:
• Only place furniture on valid hard surfaces (decking, patios, concrete slabs).
• Do NOT place furniture on grass, gardens, or driveways.
• Ensure scale, lighting, and shadows perfectly match the scene.
• Do NOT overcrowd the area; NZ staging is minimalistic.

ABSOLUTE STRUCTURAL RULES:
• No rotation/crop/zoom or perspective changes.
• Do NOT modify architecture, building shape, fences, windows, doors, decking,
  landscaping, or permanent structures.
• Do NOT add new structures.
• Only add outdoor furniture and small potted plants.

Goal:
Create a clean, modern, inviting outdoor scene that matches professional NZ
real estate staging.
```

---

## 10. GEMINI STRUCTURAL VALIDATOR PROMPT

**Purpose:** Validate structural integrity after image generation  
**Model:** Gemini 2.0 Flash (text model)  
**Sampling:** temp=0.2, topP=0.5, maxTokens=512  
**Input:** Two images (before/after) as base64  
**Output:** JSON verdict

```
You are a structural integrity judge for real estate imagery.
Return JSON only. No prose outside JSON.

STRUCTURE includes anything fixed to or integral with the property and expected to remain after a tenant/owner leaves. Treat ALL of these as structural:
- Walls, ceilings/rooflines, floors, stairs, columns, beams
- Permanent openings and boundaries: doors, windows, arches, closet openings, garage openings
- Built-ins and fixtures: cabinetry, built-in wardrobes, built-in shelving, kitchen islands, countertops, sinks/faucets, built-in stoves/ovens/cooktops, range hoods
- Fixed electrical/lighting: pendant lights, ceiling fans, wall sconces, recessed lights, light switches, power outlets
- Fixed hardware and coverings: curtains, blinds, curtain rods, rails, door handles, doorbell screens, thermostats
- Mirrors or frames mounted to walls (if they cover openings or replace fixed items)

NON-STRUCTURAL (never hard fail): movable furniture and decor only (beds, sofas, chairs, tables, rugs, pillows, art that is clearly freestanding), and minor style-only changes.

Categories you must choose:
- structure: any structural or fixed item added/removed/changed; counts change in doors/windows; wall openings created/removed; fixtures changed/removed/added; cabinetry/built-ins altered; floor or wall coverings changed.
- opening_blocked: doorway/window fully occluded, painted over, or blocked by objects (including curtains/blinds/mirrors/wall art placed over openings) or path not passable.
- furniture_change: movable furniture/decor added/removed/changed (no fixed items).
- style_only: exposure/brightness/color/style-only change with no object changes.
- unknown: can't tell.

Rules:
- structure => hardFail=true
- opening_blocked => hardFail=true if any opening is fully blocked/painted/covered or no passable path
- furniture_change => hardFail=false (warning only)
- style_only => hardFail=false
- If confidence < 0.65, set hardFail=false (warning)

Output JSON EXACTLY:
{
  "hardFail": boolean,
  "category": "structure"|"opening_blocked"|"furniture_change"|"style_only"|"unknown",
  "reasons": string[],
  "confidence": 0..1 number
}

Stage: [Stage 1A/1B/2]. Scene: [INTERIOR/EXTERIOR].
```

---

## Notes on Prompt Usage

### How Prompts Are Fed to Models:

1. **Image Generation (Stages 1A, 1B, 2):**
   - Format: Multi-part request
   - Part 1: Base64-encoded input image (inline data)
   - Part 2: Prompt text (as shown above)
   - The model receives the image and prompt together

2. **Gemini Validator:**
   - Format: Multi-part request
   - Part 1: Prompt text
   - Part 2: Before image (base64 webp)
   - Part 3: After image (base64 webp)
   - Model returns JSON verdict

### Current Sampling Parameters by Stage:

**Interior:**
- Stage 1A Enhancement: temp=0.55, topP=0.85, topK=40
- Stage 1B Declutter: temp=0.45, topP=0.80, topK=40
- Stage 2 Staging: temp=0.55, topP=0.85, topK=40

**Exterior:**
- Stage 1A Enhancement: temp=0.60, topP=0.90, topK=50
- Stage 1B Declutter: temp=0.50, topP=0.86, topK=45
- Stage 2 Staging: temp=0.60, topP=0.90, topK=50

---

## Next Steps:

1. **Review** these prompts and manually strengthen them
2. **Test** strengthened prompts through Vertex AI for further improvement
3. **Implement** the final optimized prompts back into the application

---

*Document generated: February 6, 2026*  
*Source files:*
- `/worker/src/ai/prompts.nzRealEstate.ts`
- `/worker/src/validators/geminiSemanticValidator.ts`
