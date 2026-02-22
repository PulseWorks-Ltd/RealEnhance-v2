# Structural Diff Audit: `ee7df995` vs `HEAD`

**Pre-split commit:** `ee7df995` — "Stage 2 Interior Prompt Hierarchy Rewrite"  
**HEAD commit:** `8b59cefa` — "Removed Dormant Stage 2 Legacy Prompt"  
**Commits between:** 12 commits (see `git log --oneline ee7df995..HEAD`)  
**Audit date:** 2026-02-22

---

## 1. Summary Table

| Component | Pre-split (`ee7df995`) | Current HEAD | Changed? | Risk Impact |
|---|---|---|---|---|
| Stage 2 Full prompt — total lines | ~600 (monolithic in `prompts.nzRealEstate.ts`) | ~45 (`full.prompt.ts` + shared) | **YES — reduced ~92%** | **CRITICAL** |
| Stage 2 Refresh prompt — total lines | ~600 (same monolithic function, refresh branch) | ~43 (`refresh.prompt.ts` + shared) | **YES — reduced ~93%** | **CRITICAL** |
| GEOMETRIC_ENVELOPE_LOCK_BLOCK | Injected into Stage 2 Full + Refresh | Defined but **dead code** — never injected | **YES — removed from runtime** | Critical |
| OPENING_CONTINUITY_LOCK_BLOCK | Injected into Stage 2 Full + Refresh | Defined but **dead code** | **YES — removed from runtime** | Critical |
| ROOM_VOLUME_CONSERVATION_BLOCK | Injected into Stage 2 Full + Refresh | Defined but **dead code** | **YES — removed from runtime** | Critical |
| HIERARCHY_OF_AUTHORITY_BLOCK | Injected into Stage 2 Full + Refresh | Defined but **dead code** | **YES — removed from runtime** | Critical |
| ANTI_OPTIMIZATION_SAFETY_RULE_BLOCK | Injected into Stage 2 Full + Refresh | Defined but **dead code** | **YES — removed from runtime** | High |
| CAMERA_LOCK_BLOCK (verbose) | Injected into Stage 2 Full + Refresh | Replaced by compact `STAGE2_CAMERA_IMMUTABILITY_BLOCK` | **YES — replaced** | Moderate |
| ARCHITECTURAL SHELL + MASS LOCK + IMMUTABLE ELEMENTS | Full block set (~150 lines) in Stage 2 | Replaced by compact `STAGE2_ARCHITECTURAL_IMMUTABILITY_BLOCK` (~17 lines) | **YES — replaced (reduced ~89%)** | High |
| Multi-zone constraint system | `buildMultiZoneConstraintBlock()` + `HARDENED_MULTI_ZONE_FULL_BLOCK` + `multiRoomScopeLock` | **Completely absent** | **YES — removed** | Critical |
| Room type furniture enforcement | Full block with per-room requirements | **Completely absent** | **YES — removed** | Critical |
| Kitchen zone restrictions | Full block with numeric distances + island seating prohibition | **Completely absent** | **YES — removed** | High |
| Critical opening clearance rule (75–90cm) | Present | **Completely absent** | **YES — removed** | High |
| Image boundary placement rule | Present | **Completely absent** | **YES — removed** | High |
| Casegoods wall visibility rule | Present | **Completely absent** | **YES — removed** | Moderate |
| Bed/headboard wall anchoring rule | Present | **Completely absent** | **YES — removed** | Moderate |
| Structural fixture identity lock (pendant lights) | Present | **Completely absent** | **YES — removed** | Moderate |
| Wall-mounted additions prohibited | Present | **Completely absent** | **YES — removed** | Moderate |
| Furniture priority order | Present | **Completely absent** | **YES — removed** | Moderate |
| PRIMARY OBJECTIVE / ROOM TYPE AUTHORITY | Present | **Completely absent** | **YES — removed** | High |
| LayoutContext block format | 40+ line rich block with zone list, features, risk flags, priority ladder | Compact 7-line advisory block | **YES — reduced** | Moderate |
| MODEL params in prompt text | `Temperature: 0.25 TopP: 0.70 TopK: 30` embedded in prompt text | Absent (params still correct in pipeline) | YES — removed from text | Low |
| Stage 2 Full validator | Long monolithic (augmentable zones, refresh history, structural category separation, evidence injection) | 32-line minimal (`validateStage2Full()`) | **YES — reduced ~90%** | **CRITICAL** |
| Stage 2 Refresh validator | Same long monolithic (full mode branch) | 32-line minimal (`validateStage2Refresh()`) | **YES — reduced ~90%** | **CRITICAL** |
| Stage 1B structural validator | Absent | `validateStage1BStructure()` + `STAGE1B_HARDENED_STRUCTURAL_PROMPT` added | YES — added | Positive |
| Stage 1B prompt — ARCHITECTURAL_BOUNDARY_PROTECTION | "NON-NEGOTIABLE" — absolute prohibition | "STRUCTURAL SAFETY RULE" — conditional removal allowed | **YES — softened** | Moderate |
| Stage 1B declutter thresholds | `maxRemainingPercent=20`, `absoluteAfterBlock=6`, `surfaceAfterBlock=3` | `maxRemainingPercent=35`, `absoluteAfterBlock=10`, `surfaceAfterBlock=5` | **YES — all softened** | Note for 1B |
| Stage 2 pipeline sampling (stage2.ts) | Full: `temp=0.25 topP=0.70 topK=30`, Refresh: `temp=0.30 topP=0.73 topK=31` | Identical | **No change** | None |
| Stage 2 pipeline orchestration | `buildStage2PromptNZStyle()` call, mode detection logic | Identical call | **No change** | None |

---

## 2. Structural Block Ordering Comparison

### Stage 2 Full — Pre-split (`ee7df995`) — Block Order

```
1.  ROLE: Virtual Staging Specialist — NZ Real Estate
2.  TASK: [mode-specific task instruction]
3.  MODEL: Temperature: 0.25 / TopP: 0.70 / TopK: 30  ← embedded in prompt text
4.  GEOMETRIC_ENVELOPE_LOCK_BLOCK
5.  OPENING_CONTINUITY_LOCK_BLOCK
6.  ROOM_VOLUME_CONSERVATION_BLOCK
7.  HIERARCHY_OF_AUTHORITY_BLOCK
8.  ANTI_OPTIMIZATION_SAFETY_RULE_BLOCK
9.  [layoutContextBlock — if USE_GEMINI_LAYOUT_PLANNER=1 + useFullStaging]  ← position 9
10. CAMERA_LOCK_BLOCK
11. STRUCTURAL FIXTURE IDENTITY LOCK (pendant lights, ceiling fixtures)
12. BED PLACEMENT — HEADBOARD & WALL ANCHORING RULE
13. ROOM TYPE → FURNITURE SET ENFORCEMENT (with kitchen-specific rules, island seating)
14. ROOM TYPE SAFETY OVERRIDE
15. STRUCTURE FIRST LAYOUT CONSTRAINT
16. STRUCTURAL HARDLOCK RULES (islands, counters, vanities — NEVER moved)
17. ARCHITECTURAL SHELL — DO NOT TOUCH
18. ARCHITECTURAL MASS LOCK — ABSOLUTE
19. IMMUTABLE ELEMENTS — HARD LOCK (comprehensive list including flooring identity, window treatments, lighting, wall fixtures, built-ins, exterior view)
20. ROOM_FIRST_FRAMING_BLOCK
21. PRIMARY OBJECTIVE — USER INTENT FIRST
22. ROOM TYPE AUTHORITY — HARD RULE
23. SINGLE_ROOM_LOCK (roomTypeLockBlock)
24. ROOM_FUNCTION_PRESERVATION_LOCK
25. buildMultiZoneConstraintBlock("full") — dynamic multi-zone system
26. multiRoomScopeLock — "Stage exactly BOTH selected room-function zones. Do NOT downgrade either..."
27. KITCHEN ZONE FURNITURE RESTRICTIONS (proximity rules, island seating prohibition, surface footprint rule)
28. FULL STAGING MODE section:
      - furniture scale rule
      - wall art placement rule
      - HARDENED_MULTI_ZONE_FULL_BLOCK (if multi-zone)
29. CRITICAL OPENING CLEARANCE RULE (75–90 cm sliding door clearance, numeric)
30. IMAGE BOUNDARY & SCENE CONTINUATION RULE
31. CASEGOODS PLACEMENT — WALL VISIBILITY RULE
32. WALL-MOUNTED ADDITIONS — PROHIBITED
33. FURNITURE PLACEMENT PRIORITY ORDER
34. STYLE PROFILE (detailed: light wood, linen, coastal art, specific items)
35. RENDERING & PHYSICS
36. FAIL CONDITIONS
37. OUTPUT: Return ONLY the refreshed image.
```

**Approximate token length: ~900–1100 tokens**  
**STRICT/HARD/NON-NEGOTIABLE marker count: ~28**  
**Distinct structural blocks: 37**

---

### Stage 2 Full — Current HEAD — Block Order

```
1.  ROLE: Interior Virtual Staging Specialist — NZ Real Estate
2.  TASK: Full staging from empty baseline description (4 lines)
3.  FULL-SYNTHESIS LOGIC — MANDATORY (5 bullets)
4.  ROOM-TYPE TARGET (2 lines)
5.  STAGE2_ARCHITECTURAL_IMMUTABILITY_BLOCK (17 lines)
6.  STAGE2_CAMERA_IMMUTABILITY_BLOCK (9 lines)
7.  [layoutContextBlock — if USE_GEMINI_LAYOUT_PLANNER=1 + resolvedMode=full]  ← position 7
8.  FULL-SPECIFIC RULES (5 bullets)
9.  STYLE PROFILE (2 lines)
10. OUTPUT: Return only the edited image.
```

**Approximate token length: ~200–280 tokens (excludes layout block)**  
**STRICT/HARD/NON-NEGOTIABLE marker count: ~3**  
**Distinct structural blocks: 10**

---

### Stage 2 Refresh — Pre-split (`ee7df995`) — Block Order

Same as Full above with blocks 1–37, except:  
- Position 2: TASK = "Refresh with full furniture authority..."  
- Position 3: MODEL = Temperature: 0.33 / TopP: 0.78 / TopK: 34 (in prompt text, different from actual API values)  
- Position 9: layoutContextBlock is STRUCTURALLY ABSENT (no layout context for refresh)  
- Position 20: FULL FURNITURE REFRESH AUTHORITY — STRICT block (refresh-specific)  
- Position 28: REFRESH MODE section (replace each item, consistency rule)  
- Generates from same function body using `isFullStaging = false` branch

---

### Stage 2 Refresh — Current HEAD — Block Order

```
1.  ROLE: Interior Furniture Refresh Specialist — NZ Real Estate
2.  TASK: Refresh from furnished/decluttered baseline (4 lines)
3.  REFRESH LOGIC — MANDATORY (5 bullets: preserve anchor geometry, density, circulation)
4.  ROOM-TYPE TARGET (2 lines)
5.  STAGE2_ARCHITECTURAL_IMMUTABILITY_BLOCK (17 lines)
6.  STAGE2_CAMERA_IMMUTABILITY_BLOCK (9 lines)
7.  REFRESH-SPECIFIC RULES (5 bullets: walkways, built-ins, openings, grounding, avoid over-staging)
8.  STYLE PROFILE (2 lines)
9.  OUTPUT: Return only the edited image.
```

**Approximate token length: ~160–220 tokens**  
**STRICT/HARD/NON-NEGOTIABLE marker count: ~2**  
**Distinct structural blocks: 9**

---

## 3. Gating Behavior Diff

### What was gated pre-split and is still gated the same way

| Gate | Pre-split condition | Current condition | Change |
|---|---|---|---|
| layout context injection (pipeline) | `isFullStaging && USE_GEMINI_STAGE2==="1" && USE_GEMINI_LAYOUT_PLANNER==="1"` | `resolvedMode==="full" && USE_GEMINI_STAGE2==="1" && USE_GEMINI_LAYOUT_PLANNER==="1"` | No behavioral change |
| layout context injection (prompt builder) | `if (isFullStaging && opts?.layoutContext)` | `if (resolvedMode === "full" && opts?.layoutContext)` | No behavioral change |
| Multi-room lock (MULTI_ROOM_LOCK vs SINGLE_ROOM_LOCK) | Selected by `MULTI_ROOM_TYPES.has(canonicalRoomType)` | **ABSENT — not gated, not selected — defunct** | **Removed** |
| HARDENED_MULTI_ZONE_FULL_BLOCK | Gated: full mode + `MULTI_ROOM_TYPES.has(canonicalRoomType)` | **ABSENT** | **Removed** |
| Multi-zone constraint block | Gated: `MULTI_ROOM_TYPES.has(canonicalRoomType)` | **ABSENT** | **Removed** |
| Kitchen island seating prohibition | Always-on in FULL mode | **ABSENT** | **Removed** |
| Forced refresh for multi-zone room types | Pre-split: full mode allowed for `kitchen_dining`, `kitchen_living` etc | Current: `forceRefreshMode` for these types → never full | **Changed: new gating added** |
| Stage 1B `validateStage1BStructure` | Absent | Always called | **Added** |

### Forced refresh mode (new gating added post-split)

Pre-split: `isFullStaging = explicitMode ? explicitMode === "full" : sourceStage === "1A"`  
→ A `sourceStage === "1A"` job with `roomType = "kitchen_dining"` would still enter FULL mode.

Current: 
```typescript
const refreshOnlyRoomTypes = new Set(["multiple_living", "kitchen_dining", "kitchen_living", "living_dining"]);
const forceRefreshMode = refreshOnlyRoomTypes.has(canonicalRoomType);
const resolvedMode = explicitMode ? explicitMode : (sourceStage === "1A" && !forceRefreshMode ? "full" : "refresh");
```
→ A `sourceStage === "1A"` job with `roomType = "kitchen_dining"` now **force-routes to REFRESH** even from empty baseline.

**Behavioral difference confirmed**: Multi-zone room types from 1A source now receive the refresh prompt (5-rule minimum) instead of the full prompt. Whether this is appropriate depends on whether those rooms actually had furniture at stage 1A start, but structurally it is a new gate that did not exist pre-split.

---

## 4. True Differences — Confirmed from Code

### A. Structural Core Blocks in Stage 2

| Block | Present Pre-split | Present Current | Status |
|---|---|---|---|
| GEOMETRIC_ENVELOPE_LOCK_BLOCK | ✅ Position 4 | ❌ Defined, not injected | **Dead code** |
| OPENING_CONTINUITY_LOCK_BLOCK | ✅ Position 5 | ❌ Defined, not injected | **Dead code** |
| ROOM_VOLUME_CONSERVATION_BLOCK | ✅ Position 6 | ❌ Defined, not injected | **Dead code** |
| HIERARCHY_OF_AUTHORITY_BLOCK | ✅ Position 7 | ❌ Defined, not injected | **Dead code** |
| ANTI_OPTIMIZATION_SAFETY_RULE_BLOCK | ✅ Position 8 | ❌ Defined, not injected | **Dead code** |
| CAMERA_LOCK_BLOCK (verbose) | ✅ Position 10 | ❌ | Replaced by compact version |
| STAGE2_CAMERA_IMMUTABILITY_BLOCK | ❌ | ✅ Position 6 | **New — compact** |
| STRUCTURAL FIXTURE IDENTITY LOCK | ✅ Position 11 | ❌ | **Removed** |
| ARCHITECTURAL SHELL block | ✅ Position 17 | ❌ | Absorbed into compact version |
| ARCHITECTURAL MASS LOCK | ✅ Position 18 | ❌ | Absorbed into compact version |
| IMMUTABLE ELEMENTS — HARD LOCK | ✅ Position 19 (~80 lines) | ❌ | Absorbed into compact version |
| STAGE2_ARCHITECTURAL_IMMUTABILITY_BLOCK | ❌ | ✅ Position 5 (17 lines) | **New — compact replacement** |
| STRUCTURAL HARDLOCK RULES | ✅ Position 16 | ❌ | **Removed** |
| ROOM_FIRST_FRAMING_BLOCK | ✅ Position 20 | ❌ Defined, not injected | **Dead code** |
| HARDENED_MULTI_ZONE_FULL_BLOCK | ✅ Conditional, full+multi | ❌ Defined, not injected | **Dead code** |
| MULTI_ROOM_LOCK / SINGLE_ROOM_LOCK | ✅ Position 23 | ❌ Defined, not injected | **Dead code** |
| ROOM_FUNCTION_PRESERVATION_LOCK | ✅ Position 24 | ❌ Defined, not injected | **Dead code** |

### B. Ordering Changes (Full mode only)

**Pre-split:** Structural locks appear at positions 4–10 (near top), BEFORE layout context (position 9), BEFORE furniture rules (positions 11–28), BEFORE mode-specific section (position 28).

**Current:** Structural locks appear at positions 5–6 (compact replacements), BEFORE layout context (position 7), BEFORE mode-rules (positions 8). Layout context position is identical relative ordering (always after structural locks).

**Conclusion:** Relative ordering of structural-before-layout-before-mode logic is preserved in the new compact structure. However, absolute content is ~92% reduced.

### C. Layout Context Block Format

**Pre-split format (40+ lines):**
```
────────────────────────────────
LAYOUT CONTEXT — STRONG SPATIAL GUIDANCE (DO NOT OVERRIDE STRUCTURE)
(Vision Pre-Pass Spatial Guidance)
────────────────────────────────

⚠️ CRITICAL: This is spatial guidance, NOT a rule set.
If any layout hint conflicts with visible architecture...

Room Type Detection: ${ctx.room_type_guess}
(NOTE: User-selected room type "${room}" takes precedence — do NOT override)
Open Plan: ${...}
Layout Complexity: ${...}
Occlusion Risk: ${...}
Confidence: ${...}

Zones Detected (max 4): [list]
Major Fixed Features (max 6): [list]
Primary Focal Wall: ${...}
Staging Risk Flags (max 4): [list]

ADVISORY USAGE: [4 bullets]
[Multi-zone conditional block if applicable]

ABSOLUTE PRIORITY:
1. Visible architectural structure (highest)
2. User-selected room type (must stage as ${room})
3. Structural lock rules
4. Layout context hints (lowest — advisory only)

If planner hints conflict with structure → IGNORE HINTS.
────────────────────────────────
```

**Current format (7 lines):**
```
LAYOUT CONTEXT (ADVISORY ONLY)
- room_type_guess: ${...}
- open_plan: ${...}
- layout_complexity: ${...}
- primary_focal_wall: ${...}
- staging_risk_flags: ${...}

Use this as soft spatial guidance only.
If any hint conflicts with visible architecture, preserve architecture.
```

**Behavioral changes:**
- Zone list (`ctx.zones`) no longer injected
- Major fixed features (`ctx.major_fixed_features`) no longer injected
- Occlusion risk no longer injected
- Confidence score no longer injected
- Multi-zone conditional block within layout context removed
- ABSOLUTE PRIORITY ladder removed
- "STRONG SPATIAL GUIDANCE" label → "ADVISORY ONLY"

### D. Multi-Zone Logic Differences

| Component | Pre-split | Current | Change |
|---|---|---|---|
| `buildMultiZoneConstraintBlock()` | Called with "full" or "refresh" mode | **Not called for Stage 2** | Removed |
| `HARDENED_MULTI_ZONE_FULL_BLOCK` | Injected in FULL+multi-zone | Not injected | Removed |
| `multiRoomScopeLock` | "Stage exactly BOTH…Do NOT downgrade either zone to accessories-only" | Not present | Removed |
| `ZONE_CONFIGS_FULL` / `ZONE_CONFIGS_REFRESH` | Used by constraint builder | Still defined — not used in Stage 2 | Dead code |
| BASE_MULTI_ZONE_BLOCK | Used by constraint builder | Still defined — not used in Stage 2 | Dead code |
| Force-refresh for multi-zone types | No forced refresh from 1A source | New: `forceRefreshMode` forces refresh for `kitchen_dining`, `kitchen_living`, `living_dining`, `multiple_living` | **New gating** |

**Net effect:** Stage 2 Full now sends the same 10-block prompt for both single-room and multi-zone room types. No differentiation exists.

### E. Validator Differences

#### Stage 2 Full Validator — Pre-split

Construction in `geminiSemanticValidator.ts::buildPrompt` assembled:
- `buildStage2ContextHeader("FULL_STAGE_ONLY")` (context header with before/after image context)
- `stagingIntentRule` = "Empty room must now contain appropriate furniture for the room type. Missing furniture in empty areas is FAILURE."
- `refreshHistoryContext` (declutter-aware interpretation block)
- `refreshStructuralCategorySeparation` (structural vs furnished category separation)
- Multiple additional sub-blocks including: augmentable zones rule, immutable anchor rule, boundary-adjacent logic, evidence injection, confirmation behavior
- Total: ~300–400 lines of validator prompt

#### Stage 2 Full Validator — Current HEAD

```typescript
const validatorPrompt = resolvedValidationMode === "FULL_STAGE_ONLY"
  ? validateStage2Full()
  : validateStage2Refresh();
return `${contextHeader}\n\n${validatorPrompt}`;
```

`validateStage2Full()` returns 32 lines:
- 5 decision rules
- 4 hard fail conditions (same as refresh, no mode-specific rules)
- JSON schema

**Missing from current Stage 2 Full validator:**
- No "missing furniture = FAILURE" rule
- No augmentable zones distinction
- No declutter-aware context
- No immutable anchor rule
- No boundary-adjacent logic
- No evidence injection gating
- No confirmation loop behavior
- No refresh history context

**Critical gap:** The validator no longer checks whether the FULL staging attempt actually staged the room. A Gemini output that returns an empty/unchanged room could pass validation if no structural violations occurred.

#### Stage 2 Refresh Validator — Pre-split vs Current

Same reduction pattern. Pre-split refresh validator included:
- "Preserved anchors may remain and be restyled. New complementary furniture/decor additions are allowed in augmentable zones. Do NOT treat expected additions as structural drift."
- Structural category separation
- Immutable anchor geometry lock
- Augmentable zones definition

Current: 32-line minimal — functionally equivalent to full validator with only wording difference. No augmentable zone logic.

#### Stage 1B Validators — Added post-split

`validateStage1BStructure()` is a **new function** added between ee7df995 and HEAD:
- Zero-tolerance envelope lock
- Openings lock
- Camera lock
- Numeric signal enforcement ("err toward hardFail true")
- Temperature=0, TopP=0.1 (extremely conservative)
- This is an ADDITIONAL validation pass — additive, not replacement

Stage 1B declutter effectiveness validator thresholds:
- `maxRemainingPercent`: **20 → 35** (softer — allows 75% more residual)
- `absoluteAfterBlock`: **6 → 10** (softer)
- `surfaceAfterBlock`: **3 → 5** (softer)

### F. Runtime Injection Differences

| Injection | Pre-split | Current | Change |
|---|---|---|---|
| Style directive (from stage2.ts pipeline) | Appended to prompt if `styleDirective` set | **Check stage2.ts — unchanged** | No change |
| Window covering branch | Appended if window covering logic triggered | **Check stage2.ts — unchanged** | No change |
| Retry tightening block | Appended on retry attempts | **Check stage2.ts — unchanged** | No change |
| `buildStage2ContextHeader()` prepended to validator | Present | Present (unchanged) | No change |
| Evidence injection in validator | Yes — via `shouldInjectEvidence()` + `createEmptyEvidence()` | Same infrastructure, still called | No change to gating |

**Note:** The stage2.ts pipeline was NOT in the changed files list between ee7df995 and HEAD. All runtime injection logic (style directive, window covering, retry tightening, evidence injection) is therefore unchanged.

### G. Model Parameters

| Parameter | Pre-split (API call) | Pre-split (prompt text) | Current (API call) | Change |
|---|---|---|---|---|
| Full temp | 0.25 | "Temperature: 0.25" in prompt | 0.25 | No change |
| Full topP | 0.70 | "TopP: 0.70" in prompt | 0.70 | No change |
| Full topK | 30 | "TopK: 30" in prompt | 30 | No change |
| Refresh temp | 0.30 | "Temperature: 0.33" in prompt* | 0.30 | No change |
| Refresh topP | 0.73 | "TopP: 0.78" in prompt* | 0.73 | No change |
| Refresh topK | 31 | "TopK: 34" in prompt* | 31 | No change |

*Note: Pre-split prompt TEXT contained temperature=0.33, topP=0.78, topK=34 for refresh — these were in the prompt content itself, not the actual API parameters (which were 0.30/0.73/31). The informational values in the prompt text were internally inconsistent with the API call values. The prompt text values have since been removed — actual API values unchanged.

### H. Prompt Length and Structural Density

| Metric | Pre-split Stage 2 Full | Current Stage 2 Full | Change |
|---|---|---|---|
| Lines | ~600 | ~45 | −92% |
| Approximate tokens | ~900–1100 | ~200–280 | −73–75% |
| "STRICT" / "HARD" / "NON-NEGOTIABLE" markers | ~28 | ~3 | −89% |
| Distinct named sections | ~37 | ~10 | −73% |
| Room-type specific constraints | Yes (bedroom, kitchen, living, dining, office) | No | Removed |
| Numeric rules (cm measurements, thresholds) | Yes (75–90cm door clearance, >2m kitchen separation) | No | Removed |
| Multi-zone specific language | Yes (both zones, hardened anchor) | No | Removed |
| Structural redundancy level | High (same element covered by 3+ blocks) | Low (each element in 1 block) | Reduced |

---

## 5. Risk Assessment

### Does the split change generation hierarchy?

**Yes — materially.** Pre-split placed 5 heavy structural lock blocks (positions 4–8) before any furniture guidance. These blocks each independently enforced geometric/envelope/volume invariance. Current places 2 compact blocks (17 + 9 lines) covering the same territory. The coverage is substantially reduced in specificity.

### Does it increase structural redundancy?

**No — it dramatically reduced it.** Pre-split: ~8 different blocks each stating "do not alter walls" in different framings. Current: 1 compact block. This is a structural simplification, not enrichment.

### Does it move full-mode logic deeper?

**No — full-mode logic is now at position 3 (FULL-SYNTHESIS LOGIC), earlier in the prompt than pre-split position 28 (FULL STAGING MODE section).** However, the logic itself has been stripped from ~30 rules to 5 bullets.

### Does it increase cognitive load?

**No — it reduces it.** Compact prompt is less dense. Whether this is better or worse for the model depends on how the model uses the constraints.

### Does it alter validator enforcement?

**Yes — significantly.** Stage 2 Full validator lost all room-staging completeness checking. A valid-structure but unstaged output could now pass. No "missing furniture = FAILURE" logic remains.

### Does it introduce new hard requirements?

**New gate only:** `forceRefreshMode` for multi-zone types from 1A source. No new generation-side hard requirements — all direction is net reduction.

---

## 6. Probable Regression Path for Stage 2 Full-from-Empty

Based strictly on the diff, the following removed elements are candidates for regression in full staging from empty baseline:

1. **No room-type furniture enforcement** — Nothing explicitly requires the model to place a sofa for "living_room", a bed for "bedroom", a dining table for "dining_room". The only guidance is "ROOM-TYPE TARGET: Stage as: ${room}. Selected room type is authoritative." — a single 2-line block vs. the pre-split's comprehensive per-room enforcement list.

2. **No multi-zone anchoring requirement** — `HARDENED_MULTI_ZONE_FULL_BLOCK` required "MUST instantiate both anchor points" and "MUST NOT downgrade either zone." This is completely absent.

3. **No staging completeness check in validator** — The validator no longer enforces that an empty room was actually staged. If Gemini returns an unchanged image, it will pass structural validation.

4. **No scale/density guidance** — "FURNITURE SCALE RULE: Use large-format pieces in large rooms. Do NOT undersize main furniture" is absent. Model may default to sparse/minimal.

5. **Compact architectural block may be insufficient for full synthesis** — `STAGE2_ARCHITECTURAL_IMMUTABILITY_BLOCK` was designed as a constraint (don't break structure) not as a synthesis guide. Full staging requires positive instruction ("here is what to add and where") alongside structural constraints. The synthesis guidance is now only the 5-bullet "FULL-SYNTHESIS LOGIC" block, which is extremely sparse.

6. **Kitchen restrictions absent** — If room type is `kitchen_dining`, the model has no constraint against adding island seating or extending counters.

---

## 7. Confirmed Dead Code (Post-Split)

The following constants are **defined** in `worker/src/ai/prompts.nzRealEstate.ts` but are **not used anywhere** in the current source tree (verified by full-source grep):

- `GEOMETRIC_ENVELOPE_LOCK_BLOCK` (line 428)
- `OPENING_CONTINUITY_LOCK_BLOCK` (line 474)
- `ROOM_VOLUME_CONSERVATION_BLOCK` (line 506)
- `HIERARCHY_OF_AUTHORITY_BLOCK` (line 532)
- `ANTI_OPTIMIZATION_SAFETY_RULE_BLOCK` (line 550)
- `CAMERA_LOCK_BLOCK` (line 316)
- `HARDENED_MULTI_ZONE_FULL_BLOCK` (line 175)
- `SINGLE_ROOM_LOCK` (line 284)
- `MULTI_ROOM_LOCK` (line 295)
- `ROOM_FUNCTION_PRESERVATION_LOCK` (line 306)
- `ROOM_FIRST_FRAMING_BLOCK` (line 358)
- `ZONE_CONFIGS_FULL`, `ZONE_CONFIGS_REFRESH`, `BASE_MULTI_ZONE_BLOCK` (multi-zone system)

These were all Stage 2 generation blocks. They remain in the file as artifacts of the split.

---

## 8. Final Conclusion

**Did the split materially change behavior?**

**Yes.** The split reduced the Stage 2 generation prompt by ~92% and the Stage 2 validator by ~90%. The reduction was not conservative trimming of redundancy — it removed:

- All room-type-specific furniture requirements
- All multi-zone staging enforcement
- All kitchen, bedroom, and living room placement rules
- All numeric clearance rules
- All structural fixture identity locks
- All image boundary placement guards
- All rendering/physics/fail-condition checks
- Validator completeness checking (missing furniture no longer a failure)

The compact replacement covers architectural immutability at a summary level but does not provide the synthesis guidance required to reliably produce correct full-staging results from an empty room. The missing content was not redundant — it was operationally distinct. 

The regression in Stage 2 Full-from-empty behavior is likely caused by the combination of:
1. Insufficient positive generation instruction (what to add and where)
2. Absent room-type furniture enforcement (what furniture must appear)
3. Absent completeness validation (whether the result was actually staged)
