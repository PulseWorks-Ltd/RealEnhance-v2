# Stage 2 Prompt Audit — STAGE2_PROMPT_NANO_BANANA (real production prompt)

Read fresh from `worker/src/pipeline/stage2.ts:755-812` (the `STAGE2_PROMPT_NANO_BANANA` template literal, confirmed exact boundaries via direct `Read`).

**For the record (not re-litigating, just noting):** `worker/.env` still has `STAGE2_PROMPT_VARIANT=grok` locally (lines 7 and 136), which doesn't match `"nano"`. This task proceeds on the user's explicit confirmation that nano-banana is the real production prompt — the local dev `.env` may simply not reflect actual deployment config. Flagging once for the record, not challenging it further.

All prior audit findings against `STAGE2_PROMPT_LEGACY` (the SURFACE ELIGIBILITY FILTER / casegoods analysis from the last two tasks) apply to a prompt variant not in use here and are **not** carried into this rebuild.

## Full source text (verbatim, `stage2.ts:755-812`)

```
Virtual Staging Instructions for nano banana (or Pro)

As an advanced virtual staging AI, your only role is to add realistic, correctly-scaled furniture and decor to the provided room photo. You are to act only as an decorator, placing items within the unchanging physical structure of the room.

STRUCTURAL PRIORITY RULE — NON-NEGOTIABLE

Structural integrity is the highest-priority requirement.

You must preserve all architectural elements exactly:

* walls, ceilings, floors, doors, windows, openings, built-ins, and camera geometry.

If staging conflicts with structure:

* structure always takes priority,
* but you must still produce a high-quality, fully staged, listing-ready result.

Do not default to sparse or minimal staging.
Instead, adapt placement, scale, and composition to resolve conflicts.

I. Allowed Items:
You are allowed to add, but are not limited to, the following categories of items:

Furniture: Sofas, armchairs, coffee tables, dining tables, chairs, beds, dressers, nightstands, desks, office chairs, bookcases.

Decor: Area rugs, floor lamps, table lamps, framed artwork (placed on open wall space, not windows/doors), decorative objects (vases, books, bowls), pillows, and throws.

All added items must be rendered with realistic lighting and shadows that match the room, and must be in the correct perspective for the photo. All items must be to-scale.

II. Strict Prohibitions (Negative Constraints):
You are explicitly and completely prohibited from making ANY changes, of any kind, to the core structure, appearance, or built-in elements of the room itself. You must not add, remove, resize, extend, re-color, or alter in ANY way, the following:

Walls: No changes to their location, dimension, surface texture, or existing finish. (Do not repaint or apply wallpaper, as that is not virtual staging). No adding or removing walls.

Openings: Do not alter the existence, size, or shape of any windows, doors, doorways, archways, or skylights. Do not paint or change frames, glass, or hardware. Do not cover them. This includes keeping the floor area immediately in front of and within the swing-path of any door entirely clear of furniture, rugs, or decor.

Floors & Ceilings: Do not alter the floor material (e.g., hardwood, carpet, tile) or the ceiling (e.g., paint, texture, tray ceilings). Only place rugs and furniture on top of the existing floor.

Built-Ins: Do not change any permanent built-in features, including but not limited to:
Kitchen islands, cabinetry, and countertops.
Built-in shelves, entertainment centers, or window seats.
Fireplaces, mantels, and hearths.
Closets and their doors.

Fixtures & Features: Do not change, remove, or alter existing:
Faucets, sinks, tubs, and showers.
Pendant lights, chandeliers, recessed lighting, or ceiling fans.
HVAC vents, thermostats, switches, or outlets.
Baseboards, crown molding, and railings.

View: Do not change the existing view through windows or doors.

III. Core Principle:
The photo of the room must remain an exact structural and architectural copy of the original. Your function is limited entirely to placing a realistic layer of furniture and decor within this unchanging, permanent framework. Do not extend, expand, contract, or warp any space or element of the original photo. Only place furniture and decor in logical, realistic positions within the room.

Camera & Perspective Constraint:
The camera viewpoint, lens perspective, and framing of the image must remain exactly the same as in the original photo. Do not zoom, crop, rotate, widen, narrow, or otherwise shift the camera position or perspective. The final staged image must appear as though the exact same photo was taken from the same camera position, with furniture simply placed into the scene.
```

Not classified (not preservation/structural instructions, orthogonal to the taxonomy): the title line; "I. Allowed Items" list (permissive content, superseded by the freedom clause in the Phase 2 rebuild, not a lock).

## Classification

### A — General structural lock (16 entries)

| # | Exact text | Justification |
|---|---|---|
| A1 | "your only role is to add realistic, correctly-scaled furniture and decor to the provided room photo. You are to act only as an decorator, placing items within the unchanging physical structure of the room." | General role/scope framing, room-agnostic. |
| A2 | "Structural integrity is the highest-priority requirement." | General meta-principle. |
| A3 | "You must preserve all architectural elements exactly: walls, ceilings, floors, doors, windows, openings, built-ins, and camera geometry." | The category-level "doors, windows, openings" clause here is functionally equivalent to the one whose omission caused the door fabrication. "Built-ins" is unqualified/generic in this line (no enumerated sub-types), so it's a safe, general, cheap-if-absent catch-all — kept whole, not paraphrased. |
| A4 | "If staging conflicts with structure: structure always takes priority, but you must still produce a high-quality, fully staged, listing-ready result." | General priority rule. |
| A5 | "Do not default to sparse or minimal staging. Instead, adapt placement, scale, and composition to resolve conflicts." | General staging-density guidance; also directly relevant to the Phase 3 "did A-locks make it sparse" check — this line is the built-in counterweight against that. |
| A6 | "All added items must be rendered with realistic lighting and shadows that match the room, and must be in the correct perspective for the photo. All items must be to-scale." | General rendering-quality instruction, not item-specific. |
| A7 | "You are explicitly and completely prohibited from making ANY changes, of any kind, to the core structure, appearance, or built-in elements of the room itself. You must not add, remove, resize, extend, re-color, or alter in ANY way, the following:" | General lead-in establishing the absolute tone for everything under it. |
| A8 | "Walls: No changes to their location, dimension, surface texture, or existing finish. (Do not repaint or apply wallpaper, as that is not virtual staging). No adding or removing walls." | Universal — every room has walls. |
| A9 | "Openings: Do not alter the existence, size, or shape of any windows, doors, doorways, archways, or skylights. Do not paint or change frames, glass, or hardware. Do not cover them. This includes keeping the floor area immediately in front of and within the swing-path of any door entirely clear of furniture, rugs, or decor." | **This is the exact clause that was missing from `test_anchor_only_staging.ts`.** That prompt only listed the specific known opening IDs (A1, D1) individually — it never included this category-level "do not alter the EXISTENCE of any window/door/doorway/archway/skylight" prohibition. Restoring this line is the actual fix. |
| A10 | "Floors & Ceilings: Do not alter the floor material (e.g., hardwood, carpet, tile) or the ceiling (e.g., paint, texture, tray ceilings). Only place rugs and furniture on top of the existing floor." | Universal. |
| A11 | "Do not change any permanent built-in features, including but not limited to:" (lead-in only) | General principle, stands independently of which examples follow — "including but not limited to" signals it's not an exhaustive/exclusive list. |
| A12 | "Fixtures & Features: Do not change, remove, or alter existing:" (lead-in only) | Same reasoning as A11. |
| A13 | "HVAC vents, thermostats, switches, or outlets." | Included conservatively — see C1 below for why this isn't a confident A classification, but it's cheap to keep and may partially protect switches/outlets even if it doesn't clearly cover Bedroom 12's AC unit. |
| A14 | "Baseboards, crown molding, and railings." | Near-universal architectural trim, present in the large majority of rooms; treated as general rather than conditioned on a specific baseline detection. |
| A15 | "View: Do not change the existing view through windows or doors." | General, self-conditioning ("if a view exists" is implicit; no-op otherwise). |
| A16 | Full "III. Core Principle" paragraph + full "Camera & Perspective Constraint" paragraph | Fully general, room-agnostic; this exact camera-constraint text has already been reused verbatim and proven reliable in every test tonight. |

### B — Room-specific item instructions (6 entries, grouped)

| Group | Exact text | Present in Bedroom 12? |
|---|---|---|
| Kitchen | "Kitchen islands, cabinetry, and countertops." | No — not in baseline extraction. |
| Built-in storage/media | "Built-in shelves, entertainment centers, or window seats." | No. |
| Fireplace | "Fireplaces, mantels, and hearths." | No. |
| Closets | "Closets and their doors." | No — not detected in baseline (A1/D1/AC1 only). |
| Bathroom/plumbing | "Faucets, sinks, tubs, and showers." | No. |
| Ceiling lighting fixtures | "Pendant lights, chandeliers, recessed lighting, or ceiling fans." | No — Bedroom 12's ceiling fixture is a flush-mount, which isn't literally any of the four named types (see C2). |

**Answering the task's direct question: zero B clauses apply to Bedroom 12.** Nano-banana's B-content is a short, clean list (6 items across 2 sub-sections), and none of it matches anything in this room's baseline. This is a much smaller B-category than the legacy prompt had — confirms nano-banana really is the "shorter/simpler" prompt as expected, and the B-conditional-inclusion mechanism has literally nothing to contribute for this specific room.

### C — Ambiguous (2 entries, flagged not guessed)

| # | Exact text | Why ambiguous |
|---|---|---|
| C1 | "HVAC vents, thermostats, switches, or outlets." | Bedroom 12 has a wall-mounted split-system AC unit (AC1) visible in every generated image tonight. "HVAC vents" in ordinary usage usually means ducted airflow grilles, not a substantial wall-mounted head unit — it's genuinely unclear whether this phrase would lead Gemini to treat AC1 as protected. Given this room specifically has the exact fixture type in question, this is a consequential ambiguity, not an academic one. Not reclassified to A or B — kept in the rebuilt prompt anyway (see Phase 2) as a conservative, low-cost inclusion, but its adequacy is explicitly one of the things to watch for in the Phase 3 image. |
| C2 | "Pendant lights, chandeliers, recessed lighting, or ceiling fans." | Bedroom 12's actual ceiling fixture is a flush-mount light, which isn't literally named in this list. Unclear whether Gemini would read this list as exhaustive (leaving flush-mounts unprotected) or as illustrative of "ceiling light fixtures" generally (in which case it would extend protection). Classified B above (since none of the 4 *named* types are present) but flagged here because the room does have *an* unlisted ceiling fixture that this clause's coverage is uncertain for. |

## Count summary

| Category | Count |
|---|---|
| A | 16 |
| B | 6 (0 apply to Bedroom 12) |
| C | 2 |
