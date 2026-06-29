# Envelope Baseline Verification Report - job_bb029607

## Baseline Architectural Model
Canonical Baseline Architectural Model
- Camera orientation: unknown
- Visible wall planes: front wall, left wall, right wall
Front wall
- front wall is fully visible
- front wall joins the left wall at a visible left corner
- front wall joins the right wall at a visible right corner
- front wall terminates at an observed corner
- anchor: front wall contains reference door D1 in the left third and full height
Left wall
- left wall is only minimally visible
- left wall continues beyond the left image edge
- no visible left corner is observed on the left wall
- left wall joins the front wall at a visible right corner
Right wall
- right wall is partially visible
- right wall continues beyond the right image edge
- right wall joins the front wall at a visible left corner
- no visible right corner is observed on the right wall
- anchor: right wall contains built-in AC unit AC1 in the left third

---

## Generated Verification Statements
- stmt_01: No additional permanent wall planes are visible beyond the baseline wall set.
- stmt_02: front wall is fully visible.
- stmt_03: Front wall joins the left wall at a visible left corner.
- stmt_04: Front wall joins the right wall at a visible right corner.
- stmt_05: Front wall terminates at an observed corner.
- stmt_06: The front wall contains reference door D1 in the left third and full height.
- stmt_07: left wall is only minimally visible.
- stmt_08: Left wall continues beyond the left image edge.
- stmt_09: No visible left corner is observed on the left wall.
- stmt_10: Left wall joins the front wall at a visible right corner.
- stmt_11: right wall is partially visible.
- stmt_12: Right wall continues beyond the right image edge.
- stmt_13: Right wall joins the front wall at a visible left corner.
- stmt_14: No visible right corner is observed on the right wall.
- stmt_15: The right wall contains built-in AC unit AC1 in the left third.

---

## Gemini Verification
- stmt_01: TRUE -- No additional permanent wall planes are visible beyond the baseline wall set.
- stmt_02: TRUE -- front wall is fully visible.
- stmt_03: TRUE -- Front wall joins the left wall at a visible left corner.
- stmt_04: TRUE -- Front wall joins the right wall at a visible right corner.
- stmt_05: TRUE -- Front wall terminates at an observed corner.
- stmt_06: TRUE -- The front wall contains reference door D1 in the left third and full height.
- stmt_07: TRUE -- left wall is only minimally visible.
- stmt_08: TRUE -- Left wall continues beyond the left image edge.
- stmt_09: TRUE -- No visible left corner is observed on the left wall.
- stmt_10: TRUE -- Left wall joins the front wall at a visible right corner.
- stmt_11: TRUE -- right wall is partially visible.
- stmt_12: TRUE -- Right wall continues beyond the right image edge.
- stmt_13: TRUE -- Right wall joins the front wall at a visible left corner.
- stmt_14: TRUE -- No visible right corner is observed on the right wall.
- stmt_15: TRUE -- The right wall contains built-in AC unit AC1 in the left third.

---

## Verification Failures
- none

---

## Generated Architectural Events
- none

---

## Advisory Stage Extraction
Advisory Stage Extraction
- Camera orientation: unknown
- Visible wall planes: 2
- front wall: Wall surface is continuous. Left side terminates at a visible interior corner. Right side continues beyond the frame.
- left wall: Wall contains a large sliding glass door (D1). Right side terminates at a visible interior corner. Left side continues beyond the frame.

---

## Final PASS / FAIL
PASS

---

## Confidence
0.85
