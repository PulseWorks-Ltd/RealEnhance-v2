# STAGE 2 PROMPT SYSTEM AUDIT FINDINGS
## Comprehensive Review of Room-Type-Specific Loopholes and Inconsistencies

**Audit Date:** May 14, 2026  
**Scope:** All Stage 2 prompt files (refresh.prompt.ts, full.prompt.ts, prompt.ts)  
**Focus:** Built-in finish preservation, semantic reinterpretation risks, and room-type inconsistencies

---

## EXECUTIVE SUMMARY

The Stage 2 prompt system exhibits **significant inconsistencies** in how different room types are treated regarding built-in finish preservation.

- **Kitchen (post-fix):** Now has strong, explicit freeze language
- **Bathroom:** Completely protected (no staging allowed)
- **Bedroom, Living Room, Dining Room, Office:** Rely on generic architectural freeze language WITHOUT room-specific finish locks
- **Outdoor:** Strong structure-building prohibition but weaker finish preservation language

**Risk Pattern:** Rooms dominated by BUILT-IN FINISHES (bathrooms, laundries, kitchens, offices with built-ins) are **underprotected** compared to furniture-centric rooms.

**Critical Finding:** The absence of explicit room-specific finish-preservation blocks for non-kitchen built-in-heavy rooms creates a **semantic loophole** where generative models may:
- Attempt aesthetic modernization of fixtures
- Subtly shift material appearance
- "Harmonize" existing finishes with staging style
- Enhance perceived luxury of built-in surfaces

---

## ROOM-TYPE ANALYSIS

### 1. KITCHEN

**Preservation Strength:** `STRONG` ✅  
**Risk Level:** `LOW` (post-fix)  
**Status:** Recently hardened with explicit KITCHEN FIXED-FINISH FREEZE block

#### Prompt Structure:
```
KITCHEN FIXED-FINISH FREEZE — ABSOLUTE
- Lists specific elements: cabinetry, benchtops, splashbacks, flooring, islands, shelving, wall paint, tile, appliance finishes
- Explicitly prohibits: recolor, brighten, warm, modernize, repaint, resurface, restyle, replace, 
  visually reinterpret, enhance perceived luxury/material quality, alter material appearance through grading
- REMOVED loophole: "Only lighting and color balance may affect their appearance"
- ADDED safeguard: "If staging style conflicts with existing kitchen finishes, adapt the décor and 
  accessories to the existing finishes — never alter the finishes to match the staging style"
- ADDED latent-behavior blocker: "Do NOT visually 'refresh', 'modernize', 'brighten', or 
  'luxury-upgrade' kitchen finishes"
```

#### Micro-Staging Policy (unchanged):
- Strict limits on additions (2 appliances, 3 decor items max)
- No floor furniture
- Countertop/shelf styling only

#### Assessment:
- Explicit finish freeze language is now **comparable to structural freeze language**
- Specifically targets latent model behaviors (refresh, modernize, brighten, upgrade)
- "Appearance modification loophole" has been removed
- Styling-over-preservation rule prevents subtle drift

**Recommendation:** Keep as-is; monitor for compliance. This is now a gold standard.

---

### 2. BATHROOM

**Preservation Strength:** `STRONG` ✅  
**Risk Level:** `LOW`  
**Status:** Protected through exclusion

#### Prompt Conditioning:
```
"Bathroom: no staging; return image as-is (quality was already enhanced in Stage 1)."
```

#### Assessment:
- **No staging is allowed**, so finish modification is structurally impossible
- Protects all built-ins: tubs, showers, fixtures, tiles, cabinetry
- However, this is "protection by omission," not by explicit rule

#### Risks & Loopholes:
- If model interpretation evolves to treat "return image as-is" as "apply minimal staging," bathroom finishes could be exposed
- No explicit **BATHROOM FIXED-FINISH FREEZE** block to prevent future drift
- No mention that wall tiles, flooring, cabinetry are immutable
- Vulnerable to prompt instruction expansion or conflicting global rules

#### Why This Is Risky:
1. Bathrooms have **dense built-in elements** (tiles, fixtures, cabinetry)
2. Current protection depends on correct interpretation of "no staging" across all future prompt evolution
3. If ambiguity arises, bathroom finishes (tile color, grout, fixture finish) lack explicit immutability language

**Recommendation:** 
- Add explicit **BATHROOM FIXED-FINISH FREEZE** block mirroring kitchen language
- State: "Do NOT modify, recolor, or visually alter: tile, grout, fixtures, cabinetry, flooring, wall finishes"

---

### 3. BEDROOM

**Preservation Strength:** `MODERATE`  
**Risk Level:** `MEDIUM`  
**Status:** Relies on generic rules; lacks room-specific finish locks

#### Prompt Conditioning:
```
"Bedroom: quality bedding, nightstands/lamps, minimal clutter; soft cohesive palette."

BED / HEADBOARD STRUCTURAL RULE:
- Bed placement rules
- Furniture-centric, not finish-centric

Generic Rules (apply to all rooms):
- ARCHITECTURAL FREEZE block (architectural, not finishes)
- FLOORING IDENTITY LOCK (strict, but brief)
- BUILT-IN FEATURES list (generic, not bedroom-specific)
```

#### Assessment:
- Bedroom protection is **furniture-focused** (headboard placement, scale)
- Relies on **generic global immutable elements list** for finish protection
- **NO bedroom-specific finish-preservation language**

#### Identified Loopholes:

1. **Wall Paint/Finish Ambiguity:**
   - Generic rule: "Wall paint, wallpaper, textures" are "LOCKED"
   - But what about "enhancing" wall appearance for "cohesion with bedding"?
   - Possible interpretation: Paint appearance could be slightly modified to create visual harmony
   - Risk: Subtle wall color/tone drift during furniture staging

2. **Flooring Appearance Modification:**
   - Generic FLOORING IDENTITY LOCK: "You may clean or subtly enhance the appearance of the same flooring"
   - "Subtly enhance" is ambiguous — could allow:
     - Brightening of hardwood to appear more premium
     - Slight color shift to match decor style
     - Visual "upgrade" of worn flooring appearance

3. **Ceiling Finish (Not Mentioned):**
   - Bedroom has popcorn/textured ceilings that could be "brightened" or "modernized"
   - Generic finish language doesn't explicitly prohibit ceiling finish reinterpretation

4. **Built-In Cabinetry/Wardrobes:**
   - If bedroom has built-in wardrobes or shelving:
     - Generic rule: "Do NOT remove or alter"
     - But "alter" doesn't explicitly prohibit visual reinterpretation (recolor, refinish appearance)

5. **"Soft Cohesive Palette" Pressure:**
   - The bedroom rule states: "quality bedding, nightstands/lamps, minimal clutter; **soft cohesive palette**"
   - "Cohesive palette" could subtly influence model to adjust existing finishes to match style
   - If original bedroom walls are cream/warm and staging style is cool/minimalist, model might "adjust" wall appearance for cohesion

#### Why Bedrooms Are Lower Risk Than Bathrooms/Kitchens:
- Bedrooms are **furniture-centric** (bed is anchor, dominates scene)
- Fixed finishes are **secondary** to furniture placement
- Model focuses on bed placement/scale rather than finish aesthetics
- But this is **architectural accident**, not explicit protection

**Recommendation:**
- Add **bedroom-specific finish freeze** for rooms with:
  - Built-in cabinetry
  - Feature walls
  - Popcorn ceilings
  - Or simply: Add a standing rule for bedrooms similar to kitchen

---

### 4. LIVING ROOM / LOUNGE

**Preservation Strength:** `MODERATE`  
**Risk Level:** `MEDIUM`  
**Status:** Minimal room-specific finish language

#### Prompt Conditioning:
```
"Living: conversational seating, coffee table, plant/books; balanced layout."

LIVING ROOM FOCAL POINT RULE (full.prompt.ts only):
- Primary anchor must be sofa/sectional
- TV/media is optional only on uninterrupted walls
- Conversation grouping or fireplace as alternatives
```

#### Assessment:
- **No finish-preservation language specific to living rooms**
- Relies entirely on generic architectural freeze
- NO reference to fireplace finish preservation, wall color immutability, or flooring treatment

#### Identified Loopholes:

1. **Feature Walls:**
   - If living room has painted accent wall or feature finish:
   - Generic rule doesn't explicitly protect "feature finishes"
   - Could be subtly "modernized" to match furniture style

2. **Fireplace Finishes:**
   - If fireplace has stone, tile, brick, or painted finish:
   - Generic list mentions "fireplaces, mantels" but not finish preservation
   - Could be visually "brightened", "warmed", or "refined" during staging

3. **Flooring Style Pressure:**
   - "Balanced layout" pressure could lead to:
     - Subtle brightening of dark hardwood to create "balance"
     - Slight tone shift of tile/stone to appear more premium

4. **Material "Harmonization":**
   - "Balanced layout" + furniture staging could encourage:
     - Flooring appearing warmer/cooler to match furniture tones
     - Wall color appearing richer/lighter to frame seating arrangement
     - Wood tones being "adjusted" for visual cohesion

#### Why Living Rooms Are High Risk:
- Living rooms contain **multiple finish types** (flooring, walls, fireplaces, built-in shelving)
- Large, open surfaces encourage "aesthetic optimization" pressure
- Furniture staging dominates prompt, finishes are secondary concern
- "Balanced layout" language invites style-harmonization logic

**Recommendation:**
- Add explicit living-room finish preservation language
- If fireplace present, add: "Do NOT modify fireplace materials, colors, or finish appearance"
- Add wall-specific rule: "Do NOT adjust wall color appearance to match furniture palette"

---

### 5. DINING ROOM

**Preservation Strength:** `WEAK`  
**Risk Level:** `MEDIUM-HIGH`  
**Status:** Minimal room-specific guidance

#### Prompt Conditioning:
```
"Dining: table with appropriate number of chairs; simple centerpiece; correct spacing."
```

#### Assessment:
- **Extremely minimal room-specific language**
- No mention of finish preservation
- No guidance on wall/ceiling/flooring protection
- Relies entirely on generic rules

#### Identified Loopholes:

1. **"Simple Centerpiece" Pressure:**
   - Could encourage subtle wall color adjustment to create backdrop for centerpiece
   - Ceiling appearance could be "refined" for visual interest

2. **"Correct Spacing" Optimization:**
   - Spatial optimization language could subtly encourage:
     - Wall appearance brightening for openness
     - Flooring appearance shift for visual flow
     - Ceiling tone adjustment for height perception

3. **Built-in Cabinetry/Buffets:**
   - If dining room has built-in buffet or cabinetry:
   - No explicit finish preservation language
   - Could be visually "upgraded" to frame dining table

#### Why Dining Rooms Are High Risk:
- Smallest amount of room-specific guidance in all room types
- "Simple centerpiece" + "correct spacing" language invites spatial optimization
- Dining rooms often have built-in storage (buffets, china cabinets) with finish risk
- No explicit material/finish immutability language

**Recommendation:**
- Add explicit dining-room finish preservation block
- State: "Wall finishes, flooring, ceiling, and any built-in cabinetry must remain visually unchanged"
- Clarify: "Do NOT adjust wall/ceiling/floor appearance for visual balance or spatial optimization"

---

### 6. OFFICE / STUDY

**Preservation Strength:** `WEAK`  
**Risk Level:** `MEDIUM-HIGH`  
**Status:** Minimal room-specific guidance

#### Prompt Conditioning:
```
"Office: professional desk setup, tidy accessories, minimal decor."
```

#### Assessment:
- **Minimal room-specific language**
- "Professional" + "tidy" language invites potential finish optimization
- No explicit finish preservation guidance
- Relies on generic rules

#### Identified Loopholes:

1. **"Professional" Aesthetic Pressure:**
   - "Professional" could encourage subtle modernization of finishes
   - Walls could be "refined" to appear more corporate/premium
   - Flooring could be "enhanced" to appear more upscale
   - Cabinetry/shelving could be visually "upgraded"

2. **"Tidy Accessories" Pressure:**
   - Could encourage wall appearance "cleaning" or tone refinement
   - Ceiling appearance could be subtly brightened

3. **Built-in Shelving/Cabinetry Risk:**
   - Offices often have built-in shelving, cabinetry, or feature walls
   - No explicit finish preservation language
   - "Professional" aesthetic could encourage visual "upgrade" of built-ins

#### Why Offices Are High Risk:
- **"Professional" language is semantically loaded** with modernization/luxury implications
- Offices are often **renovation candidates** (subtle finish updates)
- Prompt doesn't explicitly protect existing finishes
- "Professional" could trigger latent model tendency to "upgrade" appearance

**Recommendation:**
- Add explicit office-specific finish preservation block
- Explicitly state: "Professional appearance is achieved through furniture and layout, NOT by modifying existing finishes"
- Add: "Do NOT refresh, modernize, or upgrade office finishes"
- Protect built-ins: "If built-in cabinetry/shelving exists, it must remain visually unchanged"

---

### 7. OUTDOOR / PATIO / DECK

**Preservation Strength:** `STRONG` (for structures) / `MODERATE` (for finishes)  
**Risk Level:** `MEDIUM`  
**Status:** Strong structure building prohibition; weaker finish language

#### Prompt Conditioning:
```
[EXTERIOR STAGING – SIMPLE BINARY DECISION]

CRITICAL - ZERO TOLERANCE FOR STRUCTURE BUILDING:
- DO NOT build, create, add, or construct ANY decks, platforms, patios, terraces, or elevated surfaces
- DO NOT create new hard surfaces where none existed
- ONLY work with surfaces that ALREADY EXIST in the original photo

(Detailed rules about surface types, accessibility, vegetation, etc.)
```

#### Assessment:
- **Excellent** at preventing new structure creation
- **Minimal language** for protecting existing finish appearance
- No explicit rule for deck stain color, patio surface tone, facade color, siding finish

#### Identified Loopholes:

1. **Existing Deck/Patio Finish:**
   - If staging occurs on existing deck:
   - No explicit rule preventing subtle tone shift (brightening weathered wood, refining stone)
   - Could "modernize" outdoor surface appearance

2. **House Facade/Siding:**
   - No mention of protecting facade finish, paint color, or material appearance
   - Could be subtly adjusted for visual cohesion with outdoor staging

3. **Landscaping/Planter Finishes:**
   - No mention of protecting existing plant material, pot colors, or natural element appearance

#### Why Outdoor Is Medium Risk:
- Structure building is well-protected
- But **finish/appearance language is weak**
- Outdoor materials (wood, stone, paint) are weathered, creating pressure for "enhancement"
- "Natural elements" language vague on preservation

**Recommendation:**
- Add explicit outdoor finish preservation language
- State: "Do NOT modify appearance of existing decks, patios, fencing, siding, or landscaping"
- Add: "Weathered or aged finishes must remain as-is; do NOT brighten, stain-shift, or modernize"

---

### 8. MULTI-ROOM / OPEN-PLAN

**Preservation Strength:** `MODERATE`  
**Risk Level:** `MEDIUM`  
**Status:** Minimal multi-room-specific guidance

#### Prompt Conditioning:
```
[INTERIOR MULTI-ANGLE CONSISTENCY] (if same room, different angle)
[for multiple-living-areas/multi_living]
"Multi-zone staging: This image contains multiple functional zones (e.g., open-plan living/dining, 
lounge/office combo). Stage EACH distinct area appropriately with cohesive style across zones."
```

#### Assessment:
- "Cohesive style across zones" language is **high-risk**
- Could encourage finish harmonization across multiple spaces
- Each zone individually protected, but cross-zone harmony language creates loophole

#### Identified Loopholes:

1. **"Cohesive Style Across Zones" Pressure:**
   - Open-plan kitchen/living: Wall color could be adjusted for visual continuity
   - Living/dining: Flooring tone could be shifted to unify spaces
   - Living/office: Wall finishes could be "refined" to create harmony

2. **Finish Coordination:**
   - Multi-zone prompt could encourage:
     - Slight brightening of darker zone to match lighter zone
     - Tone adjustment of finishes to appear unified
     - Visual "upgrade" of lower-quality finishes in secondary zones

#### Why Multi-Room Is High Risk:
- "Cohesive style" is powerful aesthetic instruction
- Multiple zones create finish-consistency pressure
- Could justify subtle reinterpretation of finishes in name of visual unity
- Each zone has individual finish rules, but cross-zone harmony lacks explicit prohibition

**Recommendation:**
- Reword "cohesive style" to "consistent functionality"
- Add explicit rule: "Style cohesion must be achieved through furniture and decor, NOT by modifying existing finishes"
- Add: "Each zone's finishes (walls, flooring, cabinetry) remain locked independently"

---

## COMPARATIVE RISK MATRIX

| Room Type | Preservation Strength | Risk Level | Primary Risk | Secondary Risk |
|-----------|----------------------|-----------|-------------|----------------|
| Kitchen | STRONG ✅ | LOW | (none, hardened) | — |
| Bathroom | STRONG ✅ | LOW | Protection by omission (brittle) | Expansion of "no staging" interpretation |
| Bedroom | MODERATE | MEDIUM | "Cohesive palette" pressure | Flooring "subtle enhance" ambiguity |
| Living Room | MODERATE | MEDIUM | Feature wall/fireplace drift | "Balanced layout" optimization |
| Dining Room | WEAK | MEDIUM-HIGH | "Simple centerpiece" + "correct spacing" | Buffet/built-in finish upgrade |
| Office | WEAK | MEDIUM-HIGH | "Professional" aesthetic pressure | Finish "modernization" for premium appearance |
| Outdoor | STRONG (structure) / MODERATE (finish) | MEDIUM | Existing surface finish brightening | Facade/siding tone shift |
| Multi-Zone | MODERATE | MEDIUM | "Cohesive style" finish harmonization | Cross-zone tone/color unification |

---

## PATTERN ANALYSIS: SEMANTIC LOOPHOLES

### Identified High-Risk Semantic Patterns

#### 1. **"Aesthetic Optimization" Language**
- Phrases: "balanced layout", "cohesive palette", "correct spacing", "professional", "simple centerpiece"
- Risk: Allows reinterpretation of finishes as part of "optimization"
- Rooms affected: Living room, dining room, office, multi-zone

#### 2. **"Enhancement" Language**
- Phrases: "subtly enhance", "refine", "improve", "brighten", "modernize"
- Risk: Ambiguous permission for finish appearance modification
- Rooms affected: Bedroom (flooring), outdoor (surfaces)

#### 3. **"Harmony/Cohesion" Language**
- Phrases: "cohesive palette", "balanced", "unified", "harmonize"
- Risk: Justifies finish drift in service of visual continuity
- Rooms affected: Living room, bedroom, multi-zone

#### 4. **"Appearance Modification" Loopholes (FIXED in Kitchen)**
- Phrases: "may affect their appearance", "lighting and color balance"
- Risk: Ambiguous permission to change finish appearance
- Former location: Kitchen (NOW REMOVED ✅)
- Residual locations: Generic "flooring can be subtly enhanced"

#### 5. **"Material Modernization" Language (Implicit)**
- Phrases: "professional", "premium", "luxury", "upscale", "contemporary"
- Risk: Invites latent generative behavior to upgrade material appearance
- Rooms affected: Office, living room (implied by "scandi minimalist" style guidance)

---

## VULNERABILITIES SUMMARY

### High-Risk Semantic Vulnerabilities

| Vulnerability | Location | Severity | Example |
|---------------|----------|----------|---------|
| "Cohesive palette" pressure | Bedroom, living room, multi-zone | HIGH | Wall color shift to match furniture |
| "Professional" modernization | Office | HIGH | Cabinetry appearance "upgrade" |
| "Balanced/correct spacing" | Living room, dining room | HIGH | Flooring tone shift for spatial harmony |
| "Subtly enhance" flooring | Generic rules (all rooms) | MEDIUM | Hardwood brightening, stone refinish |
| "Cohesive style across zones" | Multi-zone | HIGH | Cross-zone finish harmonization |
| No bathroom finish freeze | Bathroom | MEDIUM | Future prompt drift exposure |
| No dining room specifics | Dining room | MEDIUM | Buffet/cabinetry finish upgrade |
| Outdoor facade ambiguity | Outdoor | MEDIUM | Siding/paint tone shift |

---

## ROOT CAUSE ANALYSIS

### Why Kitchen Issue Occurred & Why Other Rooms Remain Vulnerable

**Kitchen Issue Root Cause:**
1. Generic rules listed "built-in material identity"
2. But added loophole: "lighting and color balance may affect appearance"
3. Model interpreted this as permission to recolor counters/cabinets for "visual balance"
4. Applied aesthetic optimization logic to fixed finishes

**Why Other Rooms Remain Vulnerable:**
1. **Generic rules are insufficient** for preventing semantic reinterpretation
2. **Semantic pressure points** (professional, balanced, cohesive) lack explicit prohibition
3. **Built-in-heavy rooms** lack room-specific finish freezes
4. **Finish protection is architectural**, not aesthetic — model sees both as valid optimization targets
5. **Absence of negative examples** for specific room types

---

## RECOMMENDED FIXES (CONCEPTUAL, NOT IMPLEMENTATION)

### Tier 1: Critical (Immediate)

#### 1.1 BATHROOM FIXED-FINISH FREEZE
**Status:** BATHROOM currently protected by "no staging" but vulnerable to prompt drift
```
Add explicit block:
BATHROOM FIXED-FINISH FREEZE — ABSOLUTE
- Tile, grout, fixtures, cabinetry, flooring, wall finishes must remain visually identical
- Do NOT modify, recolor, brighten, or refine any bathroom surface
```

#### 1.2 OFFICE FIXED-FINISH FREEZE
**Status:** OFFICE lacks any explicit finish language
```
Add explicit block:
OFFICE FIXED-FINISH FREEZE
- Do NOT visually "professionalize" or "modernize" existing finishes
- Cabinetry, shelving, wall finishes, flooring remain locked
- Professional appearance is achieved through furniture, NOT through finish enhancement
- Explicitly prohibit latent behaviors: refresh, modernize, brighten, upgrade, refine
```

#### 1.3 Remove/Clarify "Cohesive Palette" Pressure (Bedroom)
**Status:** Creates subtle finish-modification permission
```
Current: "quality bedding, nightstands/lamps, minimal clutter; soft cohesive palette"
Proposed: "quality bedding, nightstands/lamps, minimal clutter — achieved through furniture and decor, 
NOT by modifying existing finishes"
```

### Tier 2: Important (High Priority)

#### 2.1 LIVING ROOM FINISH PRESERVATION
**Status:** No room-specific finish language
```
Add explicit block:
LIVING ROOM FINISH PRESERVATION
- Wall colors, fireplace finishes, flooring, ceiling must remain visually identical
- "Balanced layout" is achieved through furniture placement, NOT through finish adjustment
- Do NOT brighten, warm, refine, or modernize finishes
- Fireplace materials/colors are locked
```

#### 2.2 DINING ROOM FINISH PRESERVATION
**Status:** Weakest room-type guidance
```
Add explicit block:
DINING ROOM FINISH PRESERVATION
- Wall finishes, flooring, ceiling, and cabinetry must remain visually identical
- "Simple centerpiece" and "correct spacing" achieved through furniture, NOT finish modification
- Do NOT adjust finishes for visual balance or spatial cohesion
```

#### 2.3 Clarify MULTI-ZONE "Cohesive Style"
**Status:** High-risk semantic permission for cross-zone harmonization
```
Current: "Stage EACH distinct area appropriately with cohesive style across zones"
Proposed: "Stage EACH distinct area appropriately with consistent functional style across zones. 
Cohesion achieved through furniture/decor, NOT by modifying zone finishes to harmonize materials or colors."
```

#### 2.4 Remove "Subtly Enhance" Ambiguity (Flooring)
**Status:** Allows generative reinterpretation of flooring appearance
```
Current: "You may clean or subtly enhance the appearance of the same flooring"
Proposed: "Flooring appearance must remain pixel-identical to input. Only realism preservation allowed, 
no tone shifts, color adjustments, or brightness changes."
```

### Tier 3: Supporting (Medium Priority)

#### 3.1 OUTDOOR FINISH PRESERVATION
**Status:** Strong structure rules, weak finish rules
```
Add explicit block:
OUTDOOR FINISH PRESERVATION
- Existing deck, patio, siding, and landscaping finishes must remain visually identical
- Do NOT brighten weathered surfaces, refine stone/tile, or modernize exterior finishes
- All existing architectural and finish elements are locked
```

#### 3.2 Generic BUILT-IN MODERNIZATION PROHIBITION
**Status:** Add to exhaustive immutable elements list
```
Add line:
Do NOT attempt to "modernize", "refresh", "upgrade", "brighten", or "enhance" the perceived 
luxury/quality of any built-in finishes or fixed materials under ANY circumstances.
Material identity preservation overrides aesthetic optimization objectives.
```

---

## CONSISTENCY RECOMMENDATIONS

### Make All High-Risk Room Types Match Kitchen Rigor

**Pattern for Finish-Heavy Rooms:**
```
[ROOM-TYPE FIXED-FINISH FREEZE — ABSOLUTE]

[List specific room elements]

The following elements must retain their exact:
- color / tone
- material identity
- texture / finish appearance

DO NOT:
- recolor
- brighten
- warm
- modernize
- repaint / resurface
- restyle
- enhance perceived luxury/material quality

[Room-specific pressure point]
If staging style conflicts with existing [room elements], adapt the décor to the existing 
finishes — never alter the finishes to match the staging style.

Exposure normalization only. No visual reinterpretation permitted.
```

Apply to:
1. Kitchen ✅ (already done)
2. Bathroom ⚠️ (needs explicit freeze block)
3. Office ⚠️ (needs explicit freeze block)
4. Living Room (if fireplace/feature walls present)
5. Dining Room (if built-in cabinetry present)

---

## MONITORING & TESTING RECOMMENDATIONS

### Suggested Validation Tests

#### Test 1: Kitchen Cabinets Color Preservation
- Input: Kitchen with warm-tone cabinetry
- Staging: Cool minimalist style
- Expected: Cabinets retain warm tone (NOT shifted to cool)
- Risk: "Modernization" pressure to harmonize colors

#### Test 2: Bathroom Tile Appearance Stability
- Input: Aged/worn tile bathroom
- Expected: Tile appearance remains identical (NOT brightened/refined)
- Risk: "Professional" or "clean" aesthetic pressure

#### Test 3: Office Cabinetry Finish Lock
- Input: Office with darker wood cabinetry
- Staging: Bright minimalist style
- Expected: Cabinetry finish unchanged (NOT lightened/modernized)
- Risk: "Professional" + "premium" pressure

#### Test 4: Bedroom Wall Color Consistency
- Input: Bedroom with warm beige walls
- Staging: Cool modern style with cool-toned furniture
- Expected: Wall color unchanged (NOT shifted cool)
- Risk: "Cohesive palette" pressure

#### Test 5: Multi-Zone Finish Harmonization
- Input: Open-plan kitchen (warm tone) + living room (cool tone)
- Expected: Each zone retains original tone (NOT unified to single tone)
- Risk: "Cohesive style across zones" pressure

#### Test 6: Outdoor Deck Surface Preservation
- Input: Weathered deck
- Staging: Contemporary outdoor furniture
- Expected: Deck appearance unchanged (NOT brightened/modernized)
- Risk: "Enhancement" pressure

---

## CONCLUSION

The Stage 2 prompt system shows **significant inconsistency** in finish protection across room types:

### Protected Rooms:
- **Kitchen** ✅ (now strong, explicit freeze)
- **Bathroom** ✅ (protected by omission, but brittle)

### Moderately Protected:
- **Bedroom** (relies on generic rules + furniture focus)
- **Living Room** (generic rules only; feature finishes at risk)

### Underprotected:
- **Dining Room** (minimal guidance)
- **Office** (dangerous "professional" pressure + minimal guidance)
- **Outdoor** (finish language weak despite strong structure rules)
- **Multi-Zone** (explicit permission for "cohesive style" creates finish-drift risk)

### Root Issues:
1. **Generic rules insufficient** for semantic safety across all model behaviors
2. **Room-specific semantic pressure points** lack explicit prohibitions
3. **Built-in-heavy rooms** lack explicit finish freezes
4. **Finish appearance language** allows reinterpretation as "optimization"

### Strategic Recommendation:
Apply **Kitchen's hardened approach** to other high-risk rooms (bathroom, office, dining, living room with built-ins) to create **consistent finish preservation** across all room types and eliminate semantic loopholes.

---

**AUDIT COMPLETE**

