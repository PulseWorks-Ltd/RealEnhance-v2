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
