# Floating-furniture check fixtures

Original (empty) photo + traced furniture outline from the owner-labelled merge test
(Reshape Check Review/merge_test, Oct 2026). Used by worker/tests/stage2MaskedReshapeChecks.test.ts.

- Bedroom_14 — chest of drawers floats above the real floor (should be flagged)
- Bedroom_07 — left end of the chest of drawers floats over the skirting (should be flagged)
- Bedroom_11 — good, everything grounded
- Bedroom_12 — good, everything grounded (owner pair #26)
- Bedroom_05 — bedside table floats (production run); also has Gemini's raw and the merged final.
  Used by the floor-patch test: the table sits between a pillar edge and the bed, so Gemini's own
  floor/skirting can be kept under it with the joins hidden (should be patched, not re-staged).

Bedroom_14 and Bedroom_07 also carry Gemini's raw (2_staged_raw.webp) for the floor-patch test;
both should NOT be patched (chest against open wall / chest carries on to the floor) -> re-stage.

- Kitchen_01_a1 — TV unit on legs; the cabinet end overhangs past its right leg (raised by design).
  Should NOT be flagged (production false alarm, Oct 2026).
- Kitchen_01_a2 — same room, re-stage: the TV unit's front-left leg stands on the skirting and the
  right legs end on the wall line. Should be flagged.

- Bedroom_OpenDoor_a1 / _a2 — single bed beside a door left wide open into the room (production,
  Oct 2026, both attempts failed). The "floor line" in those columns is the bottom of the open door
  leaf, in front of the bed, so the bed looked like it floated. The empty photo shows the same carpet
  in the gap as below the line. Should NOT be flagged.

- Living_SofaUnderWindow — production living room (Oct 2026) that fell back to 1A: the sofa's arm
  overhangs its legs against the wall under a window, and the empty photo shows floor in that gap,
  just darker by the wall (0.73x). Should NOT be flagged. The mask is the final (slightly grown) one.

- Bedroom_BedsideOverBeigeWall — production f5b2478d attempt 2 (Oct 2026): bedside table ends 5.2% above
  the real floor, over a beige wall that matches the light grey carpet in brightness and colour (1.24x).
  Passed as "standing on floor" until the texture test (smooth wall 0.46x the carpet's texture).
  Should be flagged. Also carries Gemini's picture (2_staged_raw.jpg) for the re-seat test.
