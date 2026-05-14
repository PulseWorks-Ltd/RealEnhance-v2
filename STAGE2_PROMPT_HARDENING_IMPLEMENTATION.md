# STAGE 2 PROMPT ARCHITECTURE HARDENING
## Implementation Summary

**Date:** May 14, 2026  
**Scope:** Stage 2 interior staging prompts only  
**Objective:** Eliminate semantic loopholes for unintended finish modification  

---

## CHANGES IMPLEMENTED

### 1. GLOBAL SHARED BLOCK: FIXED-FINISH IMMUTABILITY

**File:** `/workspaces/RealEnhance-v2/worker/src/ai/prompts/stage2/sharedArchitecturalLock.ts`

**Change:** Added new export `STAGE2_FIXED_FINISH_IMMUTABILITY_BLOCK`

**Purpose:** Establish global immutability principle for all room types

**Content:**
- Explicit list of all elements that must retain exact appearance
- Specific prohibition of: recoloring, brightening, warming, modernizing, repainting, resurfacing, restyle, replacing, visually reinterpreting, enhancing luxury/material quality, grading/relighting
- Critical principle: "Staging style must ALWAYS adapt to existing finishes. Existing finishes must NEVER be altered to match staging style."
- Exposure normalization only (no visual change to permanent materials)

**Impact:** Provides authoritative reference block that applies to ALL room types, ensuring consistency

---

### 2. REFRESH PROMPT INTEGRATION

**File:** `/workspaces/RealEnhance-v2/worker/src/ai/prompts/stage2/refresh.prompt.ts`

**Changes:**
1. Added import for `STAGE2_FIXED_FINISH_IMMUTABILITY_BLOCK`
2. Inserted global block into prompt construction flow (after `VISIBLE_EXTENT_LOCK_BLOCK`)
3. Block precedes kitchen-specific rules, establishing global context before room-specific intensification

**Impact:** 
- All refresh mode prompts (all room types) now include global finish immutability principle
- Kitchen receives additional specialized rules on top of global rules
- Consistent across bedroom, living room, dining, office, and other refresh scenarios

---

### 3. FULL STAGING PROMPT INTEGRATION

**File:** `/workspaces/RealEnhance-v2/worker/src/ai/prompts/stage2/full.prompt.ts`

**Changes:**
1. Added import for `STAGE2_FIXED_FINISH_IMMUTABILITY_BLOCK`
2. Inserted global block into prompt construction flow (after `STAGE2_CAMERA_IMMUTABILITY_BLOCK`)
3. Block applies to full staging operations from empty baseline

**Impact:**
- Empty-room full staging now includes global finish immutability principle
- Prevents modernization/reinterpretation even in synthetic staging from baseline
- Consistent protection across all Stage 2 staging modes

---

### 4. ROOM-SPECIFIC PROMPT HARDENING

**File:** `/workspaces/RealEnhance-v2/worker/src/ai/prompt.ts` (Room conditioning section)

#### 4.1 BEDROOM (Removed semantic pressure)

**Old:** `"Bedroom: quality bedding, nightstands/lamps, minimal clutter; soft cohesive palette."`

**New:** `"Bedroom: quality bedding, nightstands/lamps, minimal clutter. Achieved through furniture and décor, NOT by modifying room finishes."`

**Reason:** Removed "cohesive palette" which could subtly permit wall color/tone drift to harmonize with bedding  
**Impact:** Clarifies that all visual cohesion is achieved through furniture/décor, not finish modification

---

#### 4.2 LIVING ROOM (Removed spatial optimization pressure)

**Old:** `"Living: conversational seating, coffee table, plant/books; balanced layout."`

**New:** `"Living room: conversational seating, coffee table, plant/books. Furniture placement creates layout flow; DO NOT adjust wall/ceiling/flooring appearance for balance."`

**Reason:** "Balanced layout" could trigger spatial optimization of finishes  
**Impact:** Explicit prohibition prevents wall/ceiling/floor appearance adjustments under balance guise

---

#### 4.3 DINING ROOM (Added finish preservation)

**Old:** `"Dining: table with appropriate number of chairs; simple centerpiece; correct spacing."`

**New:** `"Dining room: table with appropriate chairs; simple centerpiece. Wall finishes, flooring, and cabinetry are immutable. Stage furniture around existing finishes, never alter them."`

**Reason:** Original had no finish preservation language; "correct spacing" could justify spatial optimization of finishes  
**Impact:** Explicit finish immutability statement prevents buffet/cabinetry modernization

---

#### 4.4 BATHROOM (Major restructuring - from "no staging" to explicit micro-staging)

**Old:** `"Bathroom: no staging; return image as-is (quality was already enhanced in Stage 1)."`

**New:** 
```
"Bathroom: MICRO-STAGING ONLY. Allowed: towels, soap, candles, trays, small plants, folded linens, 
minimal countertop styling. NOT allowed: furniture, benches, cabinetry, fixture changes. 
All tile, vanities, fixtures, flooring remain LOCKED."
```

**Reason:** 
- Previous language was brittle (protection by omission)
- New language is explicit and resilient to prompt evolution
- Clear whitelist (allowed items) + blacklist (prohibited actions)
- Explicitly locks all built-in materials

**Impact:** Bathroom finishes now protected by explicit rule, not just absence of staging directive

---

#### 4.5 OFFICE (Removed modernization language)

**Old:** `"Office: professional desk setup, tidy accessories, minimal decor."`

**New:** `"Office: desk setup, work chair, tidy accessories. Professional appearance achieved through furniture placement, NOT by modernizing or upgrading room finishes. All cabinetry, shelving, and existing finishes remain unchanged."`

**Reason:** "Professional" is high-risk semantic trigger for finish modernization/upgrading  
**Impact:** Explicit prohibition prevents aesthetic "professionalization" of finishes

---

### 5. FLOORING LANGUAGE HARDENING

**File:** `/workspaces/RealEnhance-v2/worker/src/ai/prompt.ts` (Immutable elements section)

**Old:**
```
"You may clean or subtly enhance the appearance of the same flooring,
but do not substitute it with a different material or style."
```

**New:**
```
"Flooring appearance must remain PIXEL-IDENTICAL to the source image.
No tone shifts, color adjustments, brightness changes, or texture refinement are permitted.
Only realism preservation (exact preservation) is allowed — zero appearance modification."
```

**Reason:** "Subtly enhance" is ambiguous loophole permitting tone drift, brightening, refinement  
**Impact:** Absolute prohibition on any flooring appearance modification

---

### 6. GLOBAL MATERIAL MODERNIZATION PROHIBITION

**File:** `/workspaces/RealEnhance-v2/worker/src/ai/prompt.ts` (New block in immutable elements)

**Added:**
```
⛔ MATERIAL MODERNIZATION PROHIBITION — ABSOLUTE

Do NOT attempt to 'modernize', 'refresh', 'upgrade', 'brighten', 'warm', or 'enhance' the perceived
luxury/quality/appearance of ANY built-in finishes or fixed materials under ANY circumstances.

[Specific examples for kitchen, bathroom, flooring, tile, counters, walls, fireplaces, appliances]

Material identity and finish appearance preservation overrides ALL aesthetic optimization objectives.
Staging style MUST adapt to existing finishes. Finishes MUST NEVER adapt to staging style.
```

**Reason:** Explicitly blocks latent generative behaviors (modernize, refresh, upgrade, brighten, enhance)  
**Impact:** Direct prohibition of observed behaviors that caused kitchen counter recoloring

---

### 7. MULTI-ZONE LANGUAGE CLARIFICATION

**File:** `/workspaces/RealEnhance-v2/worker/src/ai/prompt.ts` (Interior staging rules)

**Old:**
```
"Multi-zone staging: This image contains multiple functional zones (e.g., open-plan living/dining, 
lounge/office combo). Stage EACH distinct area appropriately with cohesive style across zones."
```

**New:**
```
"Multi-zone staging: This image contains multiple functional zones (e.g., open-plan living/dining, 
lounge/office combo). Stage EACH zone appropriately with coordinated furniture style and consistent décor. 
Finish preservation applies independently to each zone—do NOT harmonize or adjust zone finishes to unify appearance."
```

**Reason:** "Cohesive style across zones" could justify finish harmonization to unify materials  
**Impact:** Explicit prohibition prevents cross-zone finish adjustments; coordination applies to furniture/décor only

---

## ARCHITECTURAL PRINCIPLES REINFORCED

### 1. Room Authority (Universal)
- The room is authoritative
- Staging adapts to the room
- The room never adapts to the staging

### 2. Finish Immutability (Universal)
- All permanent room finishes must remain visually identical
- Staging style must adapt to existing finishes
- Existing finishes must never be altered to match staging style

### 3. Exposure Normalization Only (Universal)
- Lighting adjustments may improve overall image realism only
- Must NOT result in visual change to fixed materials/finishes
- Pixel-perfect color matching required

### 4. Room-Type Intensity Scaling
- **Bedroom/Living Room:** Full furniture + décor staging allowed; finishes locked
- **Dining Room:** Table + chairs staging; finishes and built-ins locked
- **Office:** Desk setup staging; finishes and cabinetry locked
- **Kitchen:** Micro-staging only (countertop accessories); finishes and cabinetry strictly frozen
- **Bathroom:** Micro-staging only (towels, accessories); all fixtures and finishes strictly frozen

---

## PROTECTION MATRIX: BEFORE vs AFTER

| Element | Before | After |
|---------|--------|-------|
| Kitchen cabinets | Vulnerable (modernization possible) | LOCKED (explicit freeze) |
| Bathroom tile/vanity | Protected by omission (brittle) | LOCKED (explicit micro-staging + freeze) |
| Flooring tone | Vulnerable ("subtly enhance" loophole) | LOCKED (pixel-identical requirement) |
| Bedroom walls | Vulnerable ("cohesive palette" drift) | LOCKED (finish-modification clarification) |
| Office cabinetry | Vulnerable ("professional" modernization) | LOCKED (explicit prohibition) |
| Dining built-ins | Vulnerable (minimal guidance) | LOCKED (explicit preservation rule) |
| Multi-zone finishes | Vulnerable ("cohesive style" harmonization) | LOCKED (independent zone preservation) |
| Material appearance | Vulnerable (multiple loopholes) | LOCKED (explicit modernization prohibition) |

---

## SEMANTIC LOOPHOLES ELIMINATED

### Closed Loopholes:

1. ✅ **"Cohesive palette"** → Replaced with furniture/décor focus
2. ✅ **"Professional aesthetic"** → Explicitly tied to furniture, not finishes
3. ✅ **"Balanced layout"** → Explicitly prohibits finish adjustments
4. ✅ **"Subtly enhance"** → Replaced with pixel-identical requirement
5. ✅ **"Cohesive style across zones"** → Clarified as furniture coordination only
6. ✅ **"Lighting and color balance may affect appearance"** → Removed (replaced with finish freeze)
7. ✅ **"Bathroom: return as-is"** → Replaced with explicit micro-staging rules
8. ✅ **Implicit modernization permission** → Blocked with explicit prohibition
9. ✅ **Appearance modification for luxury/premium effect** → Blocked globally
10. ✅ **"Refresh/modernize/brighten/upgrade" finishes** → Explicitly prohibited

---

## VALIDATION CHECKLIST

✅ Global STAGE2_FIXED_FINISH_IMMUTABILITY_BLOCK created and exported  
✅ Block integrated into refresh.prompt.ts  
✅ Block integrated into full.prompt.ts  
✅ Bedroom language updated (removed "cohesive palette")  
✅ Living room language updated (removed "balanced layout" permission)  
✅ Dining room language updated (added explicit finish preservation)  
✅ Bathroom language updated (micro-staging + explicit freeze)  
✅ Office language updated (removed "professional" modernization trigger)  
✅ Flooring language updated (pixel-identical requirement)  
✅ Material modernization prohibition added globally  
✅ Multi-zone language clarified (furniture coordination, not finish harmonization)  
✅ Existing structural locks preserved (not weakened)  
✅ Exterior prompt routes remain untouched  

---

## EXPECTED OUTCOMES

### Kitchen Finishes:
- Counters will NOT recolor
- Cabinets will NOT brighten/modernize
- Backsplash will remain exact same tone
- Flooring will NOT shift in tone

### Bathroom Finishes:
- Tile will remain visually identical
- Vanity will NOT be enhanced/modernized
- Fixtures will NOT change appearance
- Grout will NOT be "refined"

### Bedroom/Living Finishes:
- Wall colors will remain locked
- Flooring will NOT brighten for "balance"
- Built-ins will NOT be "harmonized" with décor
- Feature finishes will remain unchanged

### Office Finishes:
- Cabinetry will NOT be "professionalized"
- Shelving will NOT be "refined"
- Wall finishes will NOT be upgraded
- Existing materials will remain as-is

### Multi-Zone Finishes:
- Each zone's finishes remain independent
- NO cross-zone tone harmonization
- NO material unification adjustments
- Coordination applies to furniture/décor only

---

## FILES MODIFIED

1. `/workspaces/RealEnhance-v2/worker/src/ai/prompts/stage2/sharedArchitecturalLock.ts`
   - Added `STAGE2_FIXED_FINISH_IMMUTABILITY_BLOCK` export

2. `/workspaces/RealEnhance-v2/worker/src/ai/prompts/stage2/refresh.prompt.ts`
   - Added import for shared block
   - Integrated block into prompt flow

3. `/workspaces/RealEnhance-v2/worker/src/ai/prompts/stage2/full.prompt.ts`
   - Added import for shared block
   - Integrated block into prompt flow

4. `/workspaces/RealEnhance-v2/worker/src/ai/prompt.ts`
   - Updated bedroom room-type guidance
   - Updated living room room-type guidance
   - Updated dining room room-type guidance
   - Updated bathroom room-type guidance (major restructuring)
   - Updated office room-type guidance
   - Updated flooring language (removed "subtly enhance")
   - Added global material modernization prohibition
   - Updated multi-zone language clarification

---

## SCOPE BOUNDARIES

✅ **IN SCOPE:** Stage 2 interior staging prompts  
✅ **PROTECTED:** Kitchen, bathroom, bedroom, living, dining, office room types  
✅ **HARDENED:** Finish preservation across all modes  

❌ **OUT OF SCOPE:** Stage 1A (before processing)  
❌ **OUT OF SCOPE:** Stage 1B (enhancement, already complete)  
❌ **OUT OF SCOPE:** Exterior enhancement prompts  
❌ **OUT OF SCOPE:** Validators or execution logic  
❌ **OUT OF SCOPE:** Routing logic  
❌ **OUT OF SCOPE:** Exterior image processing (already excluded)  

---

## TESTING RECOMMENDATIONS

### Priority 1: Kitchen
- Test kitchen with modern furniture + existing cabinetry
- Verify cabinets do NOT lighten/brighten
- Verify counters retain exact tone

### Priority 2: Bathroom
- Test bathroom with warm minimalist décor
- Verify tile and vanity remain visually identical
- Verify "micro-staging" interpreted correctly (towels, not furniture)

### Priority 3: Bedroom + Living
- Test with "cohesive" style pressure
- Verify walls do NOT shift tone to match décor
- Verify flooring does NOT brighten/warm

### Priority 4: Office
- Test office with contemporary furniture
- Verify cabinetry does NOT appear "professionalized"
- Verify finishes remain unchanged despite style pressure

### Priority 5: Multi-Zone
- Test open-plan kitchen/living
- Verify zones retain independent finish profiles
- Verify NO cross-zone tone harmonization

---

**Implementation Status:** ✅ COMPLETE  
**Ready for Testing:** YES  
**Ready for Deployment:** Pending test validation  

