# Stage 2 Prompt Audit — General-vs-Room-Specific Classification

Read-only analysis. No Gemini calls made in this task. No production code changed.

## Phase 1 — Revert confirmation + baseline re-establishment

**Git scope check (`git diff main --stat`, current branch `feature/stage2-gemini-furniture-layer`, HEAD `365d79a8`):**
Every changed file is under `tmp/` or `Test Images/Bedroom (Baseline)/`, plus one line in `.worktrees/main` (a git submodule pointer that just tracks which commit of `main` this worktree checkout is pinned to — bookkeeping, not code). No file under `worker/`, `server/`, `client/`, or `shared/` differs from `main`. `main` itself has not been touched. Uncommitted working-tree changes are exactly the artifacts from the last task (`test_anchor_only_staging.ts` and its output images) — nothing else pending.

**No code revert was needed or performed** — confirmed, per the above.

**Methodological correction (the actual point of Phase 1):** `tmp/test_anchor_only_staging.ts` is not being built on further. The next phase restarts from the real, unmodified production prompt.

**Important finding while re-confirming that baseline:** every trimmed prompt built earlier tonight (`test_layout_guided_staging.ts`, `test_planner_guided_staging.ts`, `test_framing_wording_variant.ts`, `test_anchor_only_staging.ts`) was built on the structure of **`STAGE2_PROMPT_NANO_BANANA`** (`worker/src/pipeline/stage2.ts:755-812`) — a short, self-contained alternate prompt variant. That variant is **not** the one actually used in production. `worker/src/pipeline/stage2.ts:814-815` gates it behind `process.env.STAGE2_PROMPT_VARIANT === "nano"`, and the real `worker/.env` has `STAGE2_PROMPT_VARIANT="grok"` (checked directly — line 7 and line 136 of `worker/.env`). Since `"grok" !== "nano"`, the actual default is **`STAGE2_PROMPT_LEGACY`** (`stage2.ts:746-753`), which resolves to `buildStage2PromptNZStyle()` in `worker/src/ai/prompts.nzRealEstate.ts:1785`. For a bedroom with the default `sourceStage: "1A"`, that resolves to **full mode** → `buildStage2FullPromptNZ()` (`worker/src/ai/prompts/stage2/full.prompt.ts:88`), wrapped with `insertStructureRules()` (`prompts.nzRealEstate.ts:1896-1908`).

This means **everything tested tonight was exploring a different, much simpler prompt than the one actually in production.** That doesn't invalidate tonight's findings about orientation/framing/secondary-item reasoning, but it does mean none of tonight's trimmed prompts have been reconciled against the real prompt's existing rules — see the conflict flagged in category A below (surface eligibility filter).

`STAGE2_PROMPT_NANO_BANANA` itself is audited only briefly at the end of this document (§5) since it was already the de facto basis for tonight's work; the full line-by-line audit below targets the real default, `STAGE2_PROMPT_LEGACY` (full mode).

---

## Phase 2 — Full prompt text (as actually assembled for a bedroom, full mode)

Source: `worker/src/ai/prompts/stage2/full.prompt.ts:88-147` (`buildStage2FullPromptNZ`), combining blocks from `worker/src/ai/prompts/stage2/sharedArchitecturalLock.ts:1-104`, plus `windowGeometryProtectionBlock` + `surfaceEligibilityFilterBlock` from `worker/src/ai/prompts.nzRealEstate.ts:1831-1890`, inserted per `insertStructureRules()` at `prompts.nzRealEstate.ts:1896-1908`.

**Assembly note (a real, previously-undocumented quirk found while re-confirming this):** `insertStructureRules()` first tries to insert the window/surface-eligibility blocks right after the literal string `"Architectural geometry must remain identical to the original image."` — but that exact string does not appear anywhere in either `full.prompt.ts` or `refresh.prompt.ts` (confirmed via `grep`). So that branch never fires; the code always falls through to the second branch, inserting the blocks immediately before the `"FULL-SPECIFIC RULES"` heading. The prompt below reflects what is *actually* assembled (the fallback path), not the first branch's intent. Not a bug I'm fixing here (read-only task) — just flagging so the audit matches real behavior.

```
ROLE: Interior Virtual Staging Specialist — NZ Real Estate

TASK:
This is a FULL staging problem (from empty baseline).
Synthesize a complete, realistic layout from scratch for the selected room type.

────────────────────────────────
ARCHITECTURAL IMMMUTABILITY — HARD LOCK
────────────────────────────────
Preserve exactly:
- walls, ceilings, floors, trims, coves, soffits, beams, columns
- windows, doors, frames, reveals, openings, glazing
- built-in cabinetry, islands, vanities, fixed shelving, fixed fixtures
- structural room footprint, wall positions, opening geometry

Do NOT:
- add/remove/move/resize walls, windows, doors, or openings
- create partitions, bulkheads, room splits, recesses, or new planes
- alter built-in footprints or fixed fixture geometry
- repaint/retile/re-floor to conceal structural edits

Maintain all existing installed ceiling lighting and fixtures unchanged.
Do not introduce new ceiling-mounted or hanging light fixtures.

🔒 Architectural Priority Clarification

Do NOT modify wall returns, wall angles, corner geometry, window side margins, or window height for aesthetic balance.
Do NOT adjust sill height or window proportions to accommodate furniture.
If furniture conflicts with architecture, reposition or resize the furniture instead.
Furniture must adapt to the room. The room must never adapt to furniture.

────────────────────────────────
STRUCTURAL HARDENING LAYER — V2
────────────────────────────────
GEOMETRIC ENVELOPE LOCK — ZERO TOLERANCE
The architectural envelope must remain visually and geometrically identical.
You must NOT:
• change wall positions, lengths, or angles
• alter corner locations
• modify ceiling height or plane geometry
• change window-to-wall ratio
• change door-to-wall ratio
• alter visible wall spacing
• adjust depth perspective or compression
• modify vanishing point alignment
Perspective lines, wall intersections, and opening proportions must align
with the original image.
ANTI-OPTIMIZATION RULE
Do NOT "improve" room proportions.
Do NOT straighten perspective.
Do NOT rebalance structural lighting.
Do NOT extend wall planes for compositional symmetry.
Do NOT reinterpret spatial depth.
Structure overrides staging decisions.
STRUCTURAL PRIORITY ORDER
1. Architectural envelope (highest priority)
2. Openings and built-ins
3. Camera geometry
4. Furniture placement
5. Decorative styling (lowest)
If any staging action conflicts with structure:
→ Preserve structure.

────────────────────────────────
STRUCTURAL IDENTITY LOCK — ZERO ADDITIONS
────────────────────────────────
You must NOT add, remove, replace, resize, restyle, or reposition any of the following:
• Ceiling-mounted lighting fixtures (pendants, downlights, fans, surface mounts)
• Plumbing fixtures (faucets, taps, mixers, sink hardware)
• Fixed appliances
• Wall-mounted HVAC units
• Curtain rails, rods, tracks, blind housings
Existing fixture count, type, and position must remain identical.
If staging includes a dining table, do NOT add a new pendant or ceiling light above it unless a pendant already exists in that position in the input image.
If curtains or drapes are visible in the input image, they must remain present.
Do NOT remove window fabric coverings during staging.
Do NOT introduce new functional zones beyond the user-selected room type.
If the selected room type is "kitchen + living", do NOT add dining.
If the selected room type is "living", do NOT add office or dining.
Stage only the explicitly selected room type(s).
Do not expand room function.

────────────────────────────────
CAMERA IMMUTABILITY — HARD LOCK
────────────────────────────────
Maintain exact camera geometry:
- same viewpoint
- same perspective
- same focal length / field-of-view
- same framing and crop

Do NOT introduce camera shift, re-angle, zoom, or recrop.

────────────────────────────────
FIXED-FINISH IMMUTABILITY — ABSOLUTE
────────────────────────────────
All permanent room finishes must remain visually identical to the source image.

The following elements must retain their exact:
- color
- tone
- material identity
- texture
- reflectivity
- finish appearance
- surface patterning
- visual age/wear characteristics

APPLIES TO:
- Flooring (all types: tile, wood, stone, carpet, linoleum)
- Cabinetry and built-in joinery
- Benchtops / countertops
- Splashbacks / backsplashes
- Vanities and fixed surfaces
- Built-in shelving and storage
- Fireplaces and mantels
- Wall paint, wallpaper, and surface finishes
- Ceiling finishes and textures
- Tile finishes (kitchen, bathroom, laundry)
- Appliance exterior finishes
- Any permanently attached or built-in materials

🚫 STRICTLY PROHIBITED — ZERO TOLERANCE:
- Recoloring finishes
- Brightening or darkening materials
- Warming or cooling tones
- Repainting or resurfacing
- Restaining or refinishing
- Retiling or replacing surface materials
- Restyle or modernizing finishes
- Luxury-upgrading appearance
- Visually reinterpreting materials
- Material tone drift or color shift
- Texture alteration or surface refinement
- Visual "refreshing" or "enhancement"
- Aesthetic harmonization of fixed finishes
- Altering material appearance through grading or relighting

CRITICAL PRINCIPLE
Staging style must ALWAYS adapt to existing finishes.
Existing finishes must NEVER be altered to match staging style.
If style conflicts with existing finishes, choose different furniture/décor — never modify the room.

EXPOSURE NORMALIZATION ONLY
Lighting correction may improve overall image exposure and realism only.
This must NOT result in any visual change to fixed room materials or finishes.
Pixel-perfect color matching required for all permanent room elements.

FULL-SYNTHESIS LOGIC — MANDATORY
- Create a layout from scratch from visible geometry.
- Establish anchor hierarchy and focal composition.
- Define circulation flow first, then place primary furniture.
- Choose furniture scale relative to room size and camera depth.
- Populate empty planes with coherent, room-appropriate staging.

ROOM-TYPE TARGET
Stage as: bedroom
Selected room type is authoritative for furniture program.

[LIVING ROOM FOCAL POINT RULE — only appended when room type includes "living"/"lounge"; omitted here since room type is bedroom]

[LAYOUT CONTEXT block — only appended in full mode when a layoutContext object is supplied by the caller; advisory-only, dynamic per-job data, not audited as a fixed instruction]

🔒 WINDOW GEOMETRY PROTECTION — STRICT (HIGH PRIORITY)

Window frame geometry must remain pixel-identical to the original image.

Do NOT:
• Resize windows
• Shift window position
• Alter frame thickness
• Soften or blur frame edges
• Cover or crop frame edges with curtains
• Add sheer or backing layers behind curtains that obscure frame boundaries

Furniture may sit in front of windows, but:
• Window geometry (size, position, height, width) must remain EXACTLY unchanged.
• Window frames and visible glass must remain clearly visible.
• Do NOT fully block, seal, or visually remove the opening.
• Do NOT alter sill height or window proportions.
• Avoid excessive obstruction that would appear architecturally unrealistic.

Curtain Rules:
• Curtains must hang OUTSIDE visible frame edges
• Curtain fabric must NOT intrude into the interior frame area
• Maintain full visibility of:
    - Left vertical frame edge
    - Right vertical frame edge
    - Top lintel
    - Bottom sill line

If correct curtain placement cannot be achieved without altering geometry:
→ Omit curtains entirely.

Architectural preservation overrides decorative styling.

🔒 SURFACE ELIGIBILITY FILTER — PRE-PLACEMENT GATE

Before placing any new furniture, perform this eligibility check.

1. WALL ELIGIBILITY (CASEGOODS & LARGE FURNITURE)

Large vertical furniture (dressers, tallboys, cabinets, shelving units,
bookcases, wardrobes, display units) may ONLY be placed against walls
that meet ALL of the following:

• Wall is fully visible from floor to ceiling
• Wall is continuous and not cropped by the frame edge
• No visible door frame, hinge, handle, track, or hardware
• No partial return wall suggesting an adjoining opening
• No corner termination where the adjacent wall is not fully visible

A wall is NOT eligible if:

• It is partially cropped by the camera frame
• It ends in a corner where the adjoining wall is not fully shown
• It suggests a recessed opening or possible closet location
• Any portion of door hardware or framing is visible nearby

If uncertain whether a wall is fully safe:
→ Do NOT place large furniture on that wall.

Only use clearly visible, continuous, unobstructed walls.

FULL-SPECIFIC RULES
- Do not leave core target zone unstaged.
- Preserve access to doors/windows/openings and traffic flow.
- Keep built-ins/fixed fixtures unchanged and unobstructed.
- Use realistic furniture footprints and contact shadows.
- Prefer coherent full composition over sparse accessory-only staging.

FURNITURE ADDITION CONSTRAINTS

Do NOT add any seating of any type (bar stools, chairs, benches) to or around kitchen islands.

KITCHEN MICRO-STAGING POLICY (APPLIES TO ANY VISIBLE KITCHEN ZONE)
- No new floor furniture in kitchen areas.
- Do NOT add dining tables, chairs, stools, benches, islands, carts, or freestanding cabinets in kitchen areas.
- Kitchen additions are limited to countertop / window-sill / open-shelf styling only.
- Maximum kitchen additions per image:
  * Small appliances: up to 2 total (e.g., kettle, toaster, coffee machine, blender)
  * Decor/accessories: up to 3 total (e.g., vase, fruit bowl, cookbooks, utensil holder, knife block, oven gloves, dish towel)
- Keep all kitchen additions physically grounded, realistic, and modest in scale.

ROOM-TYPE CONDITIONING
- If selected room type is kitchen only: apply only the kitchen micro-staging policy in kitchen areas; do NOT add any other furniture in kitchen areas.
- If selected room type includes kitchen + living or kitchen + dining: stage the non-kitchen zone normally, but kitchen zone remains micro-staging only with the limits above.

STYLE PROFILE
NZ Contemporary / Scandi Minimalist.
Neutral palette, natural textures, listing-safe realism.

────────────────────────────────
OUTPUT
────────────────────────────────
Return only the edited image.
```

*(`refresh.prompt.ts` — the sibling prompt used for 1B-sourced/"refresh" staging on rooms already partly furnished — is not audited line-by-line here, since tonight's Bedroom 12 testing was a from-empty-baseline "full" scenario. It shares the same shared-lock blocks; its refresh-specific rules would need a separate pass before being used for that pipeline stage.)*

---

## 🚩 Critical finding: an existing production rule directly conflicts with tonight's edge-cropping experiments

The **SURFACE ELIGIBILITY FILTER** block (classified A below) explicitly states a wall is **NOT eligible** for large furniture if *"It is partially cropped by the camera frame"* or *"ends in a corner where the adjoining wall is not fully shown."* Tonight's entire framing/edge-cropping investigation (`test_layout_guided_staging.ts` v2, the planner's `anchorFramingInstruction`, `test_framing_wording_variant.ts`) was built around the opposite idea — deliberately placing the bed against a wall that *is* partially cropped by the frame edge, because that's what a direct visual inspection of Bedroom 12 called for. **These two are in direct opposition.** If tonight's framing logic were ever merged into the real prompt without resolving this, they would fight each other, and the outcome would depend on which text the model weights more heavily — not a reliable outcome either way. This needs a deliberate decision (change the production rule, treat it as an explicit exception path, or drop the edge-cropping idea) before any of tonight's framing work goes further. Flagging it here since it surfaced directly from this audit; no action taken on it in this task.

---

## Classification

### A — General structural locks (always keep, regardless of room contents)

| # | Exact text | Justification |
|---|---|---|
| A1 | "walls, ceilings, floors, trims, coves, soffits, beams, columns" (Preserve exactly list) | Universal architectural envelope categories; every room has walls/ceiling/floor, and the others are cheap no-ops when absent. |
| A2 | "windows, doors, frames, reveals, openings, glazing" (Preserve exactly list) | This is the exact category-level clause whose *absence* caused the door-fabrication failure in the last test. Must never be dropped. |
| A3 | "structural room footprint, wall positions, opening geometry" | General envelope/geometry protection, room-agnostic. |
| A4 | "add/remove/move/resize walls, windows, doors, or openings" (Do NOT list) | Same class as A2 — the single most load-bearing line in the whole audit given tonight's failure. |
| A5 | "create partitions, bulkheads, room splits, recesses, or new planes" | Prevents inventing new architectural planes; general to any room. |
| A6 | "repaint/retile/re-floor to conceal structural edits" | General anti-gaming clause; doesn't depend on room contents. |
| A7 | "Maintain all existing installed ceiling lighting and fixtures unchanged." | Phrased as "existing" — protects whatever's there without needing to know what that is; general. |
| A8 | "Do not introduce new ceiling-mounted or hanging light fixtures." | General "no new fixtures" rule — same protective class as A2/A4. |
| A9 | "Do NOT modify wall returns, wall angles, corner geometry, window side margins, or window height for aesthetic balance." | General geometry-category protection; safe no-op if no windows present. |
| A10 | "Do NOT adjust sill height or window proportions to accommodate furniture." | Same as A9. |
| A11 | "If furniture conflicts with architecture, reposition or resize the furniture instead. Furniture must adapt to the room. The room must never adapt to furniture." | Core general philosophy statement, room-agnostic. |
| A12 | "The architectural envelope must remain visually and geometrically identical." | General. |
| A13 | "change wall positions, lengths, or angles" / "alter corner locations" / "modify ceiling height or plane geometry" / "change window-to-wall ratio" / "change door-to-wall ratio" / "alter visible wall spacing" / "adjust depth perspective or compression" / "modify vanishing point alignment" (full "You must NOT" list) | All general geometry/camera protections, independent of specific room contents. |
| A14 | "Perspective lines, wall intersections, and opening proportions must align with the original image." | General. |
| A15 | "Do NOT 'improve' room proportions." / "Do NOT straighten perspective." / "Do NOT rebalance structural lighting." / "Do NOT extend wall planes for compositional symmetry." / "Do NOT reinterpret spatial depth." / "Structure overrides staging decisions." (Anti-optimization rule) | All general meta-rules against "helpful" AI over-editing; room-agnostic. |
| A16 | "STRUCTURAL PRIORITY ORDER" (1–5 list + "Preserve structure" fallback) | General priority-ordering meta-rule. |
| A17 | "• Ceiling-mounted lighting fixtures (pendants, downlights, fans, surface mounts)" (Structural Identity Lock bullet) | Phrased as a lighting-fixture category with no specific instance named; general "whatever's installed, don't touch/add" protection, same class as A7/A8. |
| A18 | "Existing fixture count, type, and position must remain identical." | General summary line that makes the whole Structural Identity Lock list safe regardless of which specific fixture types are present. |
| A19 | "Do NOT introduce new functional zones beyond the user-selected room type." / "Stage only the explicitly selected room type(s)." / "Do not expand room function." | General scope-discipline rule — applies no matter which room type is selected (the two "If room type is X, don't add Y" examples immediately following these are classified B, not A — see below). |
| A20 | Full CAMERA IMMUTABILITY block (viewpoint/perspective/focal length/framing/crop, "Do NOT introduce camera shift, re-angle, zoom, or recrop.") | Universally general; this is the exact language every trimmed prompt tonight already reused successfully. |
| A21 | "All permanent room finishes must remain visually identical to the source image." | General. |
| A22 | "color / tone / material identity / texture / reflectivity / finish appearance / surface patterning / visual age/wear characteristics" (the "must retain their exact" list) | General category list, doesn't name a specific instance. |
| A23 | "Flooring (all types: tile, wood, stone, carpet, linoleum)" (APPLIES TO list) | Every room has flooring. |
| A24 | "Wall paint, wallpaper, and surface finishes" (APPLIES TO list) | Every room has wall surfaces. |
| A25 | "Ceiling finishes and textures" (APPLIES TO list) | Every room has a ceiling. |
| A26 | Full "STRICTLY PROHIBITED — ZERO TOLERANCE" list (recoloring, brightening/darkening, warming/cooling, repainting, restaining, retiling, restyling, luxury-upgrading, reinterpreting, tone drift, texture alteration, "refreshing", harmonization, grading/relighting) | All describe forbidden *actions* on whatever finishes exist, not specific fixture types; general. |
| A27 | "Staging style must ALWAYS adapt to existing finishes." / "Existing finishes must NEVER be altered to match staging style." / "If style conflicts with existing finishes, choose different furniture/décor — never modify the room." | General meta-principle. |
| A28 | "EXPOSURE NORMALIZATION ONLY" block (all 3 lines) | General. |
| A29 | "Create a layout from scratch from visible geometry." / "Establish anchor hierarchy and focal composition." / "Choose furniture scale relative to room size and camera depth." / "Populate empty planes with coherent, room-appropriate staging." | General process instructions, not tied to any specific item. |
| A30 | "Define circulation flow first, then place primary furniture." | Directly the "don't block pathways/doorways" principle — highly relevant to this whole investigation's original failure mode (furniture/doorway conflicts). General, must keep. |
| A31 | "Do not leave core target zone unstaged." | General staging-completeness rule. |
| A32 | "Preserve access to doors/windows/openings and traffic flow." | General — directly the "don't block the doorway" rule this entire investigation exists to protect. One of the most important lines in the whole prompt for this project's purposes. |
| A33 | "Keep built-ins/fixed fixtures unchanged and unobstructed." | Phrased generically (no specific noun), cheap no-op if absent, directly protects the AC-unit-obstruction failure mode from tonight's tests. |
| A34 | "Use realistic furniture footprints and contact shadows." | General rendering-quality instruction. |
| A35 | "Prefer coherent full composition over sparse accessory-only staging." | General staging-density guidance. |
| A36 | "Window frame geometry must remain pixel-identical to the original image." | Redundant with A9/A10/A13 but still general (window-as-category, not instance-specific). |
| A37 | "Resize windows" / "Shift window position" / "Alter frame thickness" / "Soften or blur frame edges" (Window Geometry Do NOT list, first 4 of 6) | General window-geometry protection (the remaining 2 items in this same bullet list are curtain-specific — see B below). |
| A38 | "Window geometry (size, position, height, width) must remain EXACTLY unchanged." / "Window frames and visible glass must remain clearly visible." / "Do NOT fully block, seal, or visually remove the opening." / "Do NOT alter sill height or window proportions." / "Avoid excessive obstruction that would appear architecturally unrealistic." ("Furniture may sit in front of windows, but:" list) | General opening-protection — the same protective *class* as A2/A4 (don't seal/remove an opening), just window-specific phrasing. Important precedent: shows the real prompt already generalizes this idea for windows; the same generalization is what was missing for the new-door case in the last test. |
| A39 | "Architectural preservation overrides decorative styling." | General meta-principle, closes out the window block. |
| A40 | Full SURFACE ELIGIBILITY FILTER block (wall-eligibility checklist for large furniture, both the "meets ALL of" and "NOT eligible if" lists, plus "If uncertain... do not place") | General — applies to "large vertical furniture" as a category and "walls" as a category, no specific room item named. **See the conflict flagged above: this block actively prohibits the edge-cropped placement tonight's framing experiments were built around.** |

### B — Room-specific item instructions (conditional on baseline-detected presence), grouped by item type

**Plumbing / kitchen-bathroom fixtures**
- "Plumbing fixtures (faucets, taps, mixers, sink hardware)" (Structural Identity Lock bullet) — only exists in kitchens/bathrooms/laundries; a bedroom has none. Safe to omit when baseline shows no plumbing fixtures.
- "Fixed appliances" (Structural Identity Lock bullet) — kitchen/laundry-specific.

**HVAC**
- "Wall-mounted HVAC units" (Structural Identity Lock bullet) — **directly relevant to Bedroom 12's own AC1 fixture**; only meaningful when an HVAC unit is baseline-detected, but should be actively included whenever the baseline does show one (as it did tonight).

**Window coverings / curtains**
- "Curtain rails, rods, tracks, blind housings" (Structural Identity Lock bullet) — only relevant if curtain/blind hardware is present (Bedroom 12 does have a curtain rail — include when detected).
- "If curtains or drapes are visible in the input image, they must remain present. Do NOT remove window fabric coverings during staging." — already self-conditioning text ("if... visible"); a good existing model for how to write a B-class rule. Bedroom 12 has curtains, so this applies to it specifically.
- "Cover or crop frame edges with curtains" / "Add sheer or backing layers behind curtains that obscure frame boundaries" (2 of 6 items in the Window Geometry Do NOT list) — only meaningful when curtains are present/being staged.
- Full "Curtain Rules" block (hang outside frame edges, don't intrude into interior frame area, maintain visibility of frame edges/lintel/sill) — only relevant when curtains exist or are being added.
- "If correct curtain placement cannot be achieved without altering geometry: → Omit curtains entirely." — same group.

**Dining / pendant lighting**
- "If staging includes a dining table, do NOT add a new pendant or ceiling light above it unless a pendant already exists in that position in the input image." — only relevant for dining scenarios; irrelevant to a bedroom.

**Room-type scope conditioning**
- "If the selected room type is \"kitchen + living\", do NOT add dining." — only relevant for that specific room-type combination.
- "If the selected room type is \"living\", do NOT add office or dining." — only relevant for living rooms.

**Living-room anchor/TV placement**
- Full "LIVING ROOM FOCAL POINT RULE" block (sofa/sectional as anchor, TV/media console conditional on wall eligibility, fallback to conversation grouping/fireplace/view) — irrelevant to a bedroom. Worth noting: the codebase **already implements this correctly as a conditional block** (only appended when room type includes "living"/"lounge" — `full.prompt.ts:91-101`). This is a good existing precedent for how the "only include if baseline extraction found X" lookup this task is building toward should work.

**Built-in cabinetry / joinery / storage**
- "built-in cabinetry, islands, vanities, fixed shelving, fixed fixtures" (Preserve exactly list, specific nouns only — "fixed fixtures" is flagged separately in C) — cabinetry/islands/vanities/shelving are genuinely conditional on presence; a bedroom typically has none of these (built-in wardrobes would be an exception worth baseline-detecting for).
- "alter built-in footprints or fixed fixture geometry" (Do NOT list) — null-op if no built-ins exist; safe to keep conditional, though cheap enough to always include if preferred.
- "Cabinetry and built-in joinery" (Fixed-Finish APPLIES TO list) — kitchen/bathroom/laundry/study-specific.
- "Benchtops / countertops" (APPLIES TO list) — kitchen/bathroom-specific.
- "Splashbacks / backsplashes" (APPLIES TO list) — kitchen/bathroom-specific.
- "Built-in shelving and storage" (APPLIES TO list) — conditional on presence.
- "Tile finishes (kitchen, bathroom, laundry)" (APPLIES TO list) — self-scoped to those room types already.
- "Appliance exterior finishes" (APPLIES TO list) — kitchen/laundry-specific.

**Fireplace**
- "Fireplaces and mantels" (Fixed-Finish APPLIES TO list) — the task's own canonical B example; irrelevant unless a fireplace is baseline-detected.

**Kitchen island / kitchen zone staging**
- "Do NOT add any seating of any type (bar stools, chairs, benches) to or around kitchen islands." — irrelevant without a kitchen island present.
- Full "KITCHEN MICRO-STAGING POLICY" block (no new floor furniture, item-type prohibitions, countertop/sill/shelf-only additions, numeric caps on appliances/decor) — self-scoped already ("APPLIES TO ANY VISIBLE KITCHEN ZONE"), another good existing precedent for conditional-block design.
- "ROOM-TYPE CONDITIONING" (kitchen-only / kitchen+living / kitchen+dining rules) — same group, irrelevant to bedroom.

### C — Ambiguous / unsure (flagged, not guessed)

| # | Exact text | Why it's ambiguous |
|---|---|---|
| C1 | "fixed fixtures" (last item in "Preserve exactly: built-in cabinetry, islands, vanities, fixed shelving, fixed fixtures") | Too broad/generic a catch-all to confidently classify. It could be doing real general-category work (protecting *any* fixture not enumerated elsewhere, similar in spirit to A2's "openings" catch-all) or it could just be a vague restatement of the specific nouns already listed next to it. Dropping it when "no built-ins present" risks silently losing protection for some fixture type nobody thought to name explicitly — exactly the failure pattern from the door-fabrication test. Needs a human call on intent before it's safely conditionable. |
| C2 | "Vanities and fixed surfaces" (Fixed-Finish APPLIES TO list) | "Vanities" alone would be clean B (bathroom-specific), but "fixed surfaces" tacked onto the same bullet is broad enough to plausibly cover things well outside bathrooms (any built-in countertop-like surface). Splitting this bullet requires knowing whether "fixed surfaces" was meant as a synonym for vanity-adjacent surfaces or as its own general catch-all. |
| C3 | "Any permanently attached or built-in materials" (last item, Fixed-Finish APPLIES TO list) | Reads as a deliberate general catch-all (protect anything permanently attached, whatever it is) — which would argue for A — but it's positioned at the end of an otherwise room-specific list (cabinetry, benchtops, splashbacks, vanities, fireplaces) and could just as easily be intended as "any other item like the ones just listed," i.e., still implicitly built-in/kitchen-bathroom-oriented. Given the stakes (this is the exact kind of ambiguity that produced tonight's failure), this should get a human decision rather than an assumed classification. |

---

## Count summary

| Category | Count (individual clauses/bullets, not full blocks) |
|---|---|
| A — General structural lock | 40 entries (A1–A40; several bundle multiple bullet points sharing one justification) |
| B — Room-specific (grouped into 9 item-type groups) | 9 groups, ~24 individual clauses total |
| C — Ambiguous, unresolved | 3 |

---

## What this means for the "only include if baseline extraction found X" system

- Every line under **A** must ship in every trimmed prompt, for every room, unconditionally. This is the fixed core.
- Every group under **B** should be gated on the corresponding baseline-extraction signal: HVAC block only when an `ac_unit`-type (or similar) fixture is in the baseline; window-covering block only when curtains/blinds are detected; fireplace/kitchen-island/built-in blocks only when those types appear; living-room and kitchen-zone blocks only for matching room types (already implemented this way in production for those two cases — reuse that pattern).
- **C1–C3 need a human decision before the lookup table is built** — guessing wrong here reproduces exactly the failure this whole audit exists to prevent.
- The **A40 / edge-cropping conflict** needs to be resolved (or at minimum explicitly acknowledged and decided on) before any of tonight's framing-instruction work is considered mergeable, independent of the B/C conditional-inclusion work.

---

## §5 — Brief note on `STAGE2_PROMPT_NANO_BANANA` (the variant tonight's tests were actually built on)

Source: `worker/src/pipeline/stage2.ts:755-812`. Structurally much simpler than `STAGE2_PROMPT_LEGACY`: one "Structural Priority Rule" paragraph (≈A-class, general), an "Allowed Items" category list (not a preservation instruction, so not classified), a "Strict Prohibitions" section that mixes general clauses (walls/openings/floors/ceilings — A-class) with explicitly room-specific ones already labeled as such in the source text ("Kitchen islands, cabinetry", "Fireplaces, mantels and hearths", "Closets and their doors", "Faucets, sinks, tubs, and showers" — all B-class, kitchen/bathroom-specific), plus the same Camera & Perspective Constraint language reused verbatim in every test tonight (A-class). It does **not** contain anything resembling the SURFACE ELIGIBILITY FILTER, so it doesn't carry the edge-cropping conflict found above — but that's precisely because it's a smaller, less battle-tested prompt than the real default, not because the conflict doesn't exist in production.
