# Open-Plan Living/Dining: Zoning + Multi-Anchor Design

Investigation phase only. No production code. Test image: `Test Images/Living (Baseline)/Rental 03.jpg`.

## Prerequisite finding — flag before anything else

`worker/src/pipeline/stage2.ts:669-672`: `refreshOnlyRoomTypes` includes `"living_dining"` (and `multiple_living`, `kitchen_dining`, `kitchen_living`), and these are force-routed to `resolvedPromptMode = "refresh"` unless the caller explicitly overrides via `opts.stage2Mode`/`opts.promptMode`. The `anchor_locked` gate (`USE_ANCHOR_LOCKED_PROMPT`) only fires when `resolvedPromptMode === "full"`.

**Practical consequence: as the pipeline is wired today, nothing built from this investigation is reachable for a `living_dining` job, regardless of the `STAGE2_PROMPT_VARIANT` flag.** This wasn't a constraint bedroom ever had. Two possible readings, and I don't think it's my call which is right:
1. This routing was a deliberate product decision — open-plan rooms were judged too complex/risky for from-scratch synthesis, so they're always refined from an existing (1B-light/1B-stage-ready) partially-furnished state instead. If so, full-synthesis zoning+multi-anchor planning may not even be the right target — the real need might be a *refresh-mode* version of this logic (adjust/complete an already-partially-furnished open-plan room) rather than a *full* version (stage an empty one from scratch).
2. Or it was a reasonable default at the time that's now worth revisiting now that there's a validated full-synthesis anchor pattern for at least one room type.

**This needs your decision before implementation, not mine.** Tonight's Part 3 prototype proceeds as if targeting full-mode (matching the bedroom pattern, since that's what's proven), but that choice should be revisited explicitly if you want this to become a real integration.

## Part 1 recap — kitchen-proximity signal

Real. `A1` (walkthrough, wallIndex 0) is 32.65% of frame area, spans x=[0.585,1.0] to the frame's right edge, 40-60% wall coverage. `W2` (window) sits bbox-nested inside A1. Two light fixtures (F2, F3) also on wallIndex 0. Together these are strong circumstantial evidence A1 is the kitchen pass-through and W2/F2/F3 belong to the kitchen space beyond it — but this is *inferred* from size/position/nesting, not a first-class fact the schema states. `StructuralOpeningType` has no "leads to kitchen" category, and nothing in the extraction prompt asks the model to reason about what's beyond an opening.

**Implication for the heuristic:** it can't be "read off" existing baseline data as a boolean flag today. It needs a new, explicit question asked directly — see zoning extraction schema below. Framed as a confidence-scored signal, not an assumed-present fact, since plenty of real photos won't have this cue at all (a fully self-contained living/dining room with no visible kitchen access). Fallback when absent: no directional bias — pick the dining zone by the same general-purpose floor-geometry rule used when there's no stronger signal (see below).

## Zoning approach

**Proposal: a dedicated zoning extraction call, not a client-side geometric heuristic derived from wall data alone.**

I considered deriving zones purely from wall-visibility output (e.g., "split the floor at the room's midpoint" or "cluster by which walls are near each other"), but rejected it as the primary method: floor-plan zoning is a genuinely visual/spatial judgment (where does the space *feel* like it breaks into two areas — a change in flooring, a change in ceiling treatment, furniture-implied traffic flow, sightlines) that an LLM looking at the actual photo can reason about directly, the same reason wall-visibility itself was built as its own dedicated call layered on baseline extraction rather than derived client-side. A purely geometric client-side rule (e.g. naive floor-area bisection) would be blind to genuine visual cues and likely wrong as often as right.

Proposed schema (same pattern as wall-visibility: reference baseline IDs, don't re-detect):

```json
{
  "zones": [
    {
      "id": "zone_living",
      "purpose": "living",
      "floorRegion": { "polygon": [[x,y], ...] },
      "borderingWallIndices": [3, 0],
      "reasoning": "..."
    },
    {
      "id": "zone_dining",
      "purpose": "dining",
      "floorRegion": { "polygon": [[x,y], ...] },
      "borderingWallIndices": [0, 1],
      "reasoning": "..."
    }
  ],
  "kitchenSignal": {
    "present": boolean,
    "openingId": string | null,
    "confidence": number,
    "evidence": string
  }
}
```

`floorRegion` polygons give real, inspectable geometry for the overlay (same visual-QA discipline as every wall/opening overlay tonight). `kitchenSignal` makes the proximity heuristic explicit and falsifiable per-image instead of assumed.

**Zone-to-wall assignment:** each zone claims the *portion* of a wall's usable segments that falls within its floor region — this reuses wall-visibility's existing `usableSegments` machinery rather than replacing it; zoning determines which segments are "in scope" for which anchor item, not a new wall-geometry mechanism.

**Fallback with no kitchen signal:** default to the zone nearer the room's primary entry/walkthrough opening in general (not kitchen-specific) as dining, since dining areas conventionally sit nearer circulation paths than the deeper seating nook — a weaker, general heuristic, not a fabricated kitchen cue. Flagged as an assumption, not validated tonight (this test image has a signal, so the fallback path isn't exercised here).

## Multi-anchor coherence

**Dining zone (table):** a materially different placement paradigm than bedroom's "against a wall," not a copy-paste. Dining tables are typically freestanding with clearance on multiple sides for chairs, not headboard-against-wall. Proposed rule: center the table within the dining zone's `floorRegion` (inset from any bordering wall/opening enough for chair clearance — reuse the existing `MIN_USABLE_FRACTION_FOR_ANCHOR`-style threshold, but applied to the zone's floor area rather than a single wall's width), oriented so its long axis runs parallel to the nearest bordering wall (reads as intentional, not skewed).

**Living zone (sofa + TV, planned as a pair, not independently):** propose picking the TV wall first — the qualifying wall within the living zone with the largest clear segment, same selection logic as bedroom's `planBedroomAnchor` but scoped to living-zone walls only — then picking the sofa's wall/position specifically to face that TV wall (not "face into the room" generically, which is what would happen if sofa and TV were planned independently and merged after). This is the concrete mechanism for "coherence": TV placement is computed first and becomes an input to sofa orientation, not two parallel decisions reconciled afterward.

**Open question, not decided here:** what happens when the living zone has no wall clearly suitable for a TV at all (small zone, every wall interrupted by openings)? Bedroom's answer for "no wall qualifies" was fallback-to-default-prompt. For living-only that's fine; for a *paired* decision it's less obvious — does no-TV-wall mean fall back entirely, or degrade to "sofa faces the window/room" without a TV? Flagging rather than guessing; Part 3's prototype handles the case actually present in the test image, not this one.

## Summary of assumptions needing your input

1. Full-mode vs. refresh-mode target (the prerequisite finding above) — biggest one.
2. Fallback dining-zone rule when no kitchen signal exists (proposed but unvalidated tonight).
3. Behavior when the living zone has no TV-qualifying wall (not encountered in tonight's test image, so not resolved).
