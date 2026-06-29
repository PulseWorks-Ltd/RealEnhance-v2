# Envelope Constraint Verification Report - job_bb029607

## Pipeline Status
- Default envelope validator pipeline: baseline extraction -> qualified semantic walls + advisory geometry -> guided staged extraction -> extraction integrity gate -> deterministic comparison -> deterministic structural interpretation -> PASS / FAIL.
- Semantic wall repair, blank-wall promotion, and identity regeneration are not used in this replay.
- Environment variables required to enable constraint verification: none.

---

## Baseline Candidate Surfaces
- candidate_wall_0
  advisory positional label: front wall
  qualification decision: qualified_semantic_wall
  qualification score: 62
  primary semantic anchor: built-in AC unit
  raw architectural features: built-in AC unit
  evidence breakdown: primary architectural anchor built-in AC unit: +32 | visible wall extent partial: +11 | visible corners (1): +8 | continuation beyond frame: +5 | left boundary visible: +3 | architectural certainty partial: +3
  reason: Sufficient structural evidence exists to promote this candidate into the semantic wall set.
- candidate_wall_3
  advisory positional label: left wall
  qualification decision: qualified_semantic_wall
  qualification score: 68
  primary semantic anchor: sliding glass door
  raw architectural features: sliding glass door
  evidence breakdown: primary architectural anchor sliding glass door: +38 | visible wall extent partial: +11 | visible corners (1): +8 | continuation beyond frame: +5 | right boundary visible: +3 | architectural certainty partial: +3
  reason: Sufficient structural evidence exists to promote this candidate into the semantic wall set.

---

## Baseline Extraction
- baseline extraction: present
- wall count: 2
- opening count: 1
- anchor fixture count: 1
- wall 0: visibility=partial, extent=partial, certainty=partial, leftCorner=yes, rightCorner=no, continuesBeyondFrame=yes -- Wall surface with a wall-mounted AC unit. The left boundary forms a visible interior corner. The right boundary continues beyond the frame.
- wall 3: visibility=partial, extent=partial, certainty=partial, leftCorner=no, rightCorner=yes, continuesBeyondFrame=yes -- Wall containing a large sliding glass door. The right boundary forms a visible interior corner. The left boundary continues beyond the frame.
- opening D1: door on wall 3 at center_third/full_height (confidence 0.98)
- fixture AC1: ac_unit on wall 0 at right_third (confidence 0.99)

---

## Qualified Baseline Semantic Walls
- wall containing built-in AC unit [wall_ac_unit_right_third]
  primary semantic anchor: built-in AC unit
  secondary architectural features: none
  raw architectural features: built-in AC unit
  advisory positional label: front wall
  identity ambiguity: none
  geometry: wall containing built-in AC unit is partially visible | visibility magnitude: partial | wall containing built-in AC unit continues beyond the right image edge | wall containing built-in AC unit joins wall containing sliding glass door at a visible left corner | no visible right corner on wall containing built-in AC unit | no visible return wall at the right edge | no visible adjoining wall plane at the right edge | no visible recess at the right edge | no visible wall termination at the right edge
- wall containing sliding glass door [wall_door_center_third_full_height]
  primary semantic anchor: sliding glass door
  secondary architectural features: none
  raw architectural features: sliding glass door
  advisory positional label: left wall
  identity ambiguity: none
  geometry: wall containing sliding glass door is partially visible | visibility magnitude: partial | wall containing sliding glass door continues beyond the left image edge | no visible left corner on wall containing sliding glass door | wall containing sliding glass door joins wall containing built-in AC unit at a visible right corner | no visible return wall at the left edge | no visible adjoining wall plane at the left edge | no visible recess at the left edge | no visible wall termination at the left edge

---

## Baseline Advisory Geometry
- none

---

## Guided Staged Wall Observations
Staged Verification
- Verified baseline walls: 2
- wall containing built-in AC unit: substantial visibility, extent substantial; leftCorner=yes; rightCorner=no; continuesBeyondFrame=yes; returnWallVisible=no; adjoiningWallVisible=no; recessVisible=no
- wall containing sliding glass door: substantial visibility, extent substantial; leftCorner=yes; rightCorner=yes; continuesBeyondFrame=no; returnWallVisible=yes; adjoiningWallVisible=yes; recessVisible=no
- Additional permanent wall planes: TRUE
  - A permanent wall plane adjoining the left edge of the wall containing the sliding glass door, extending out of frame to the left (a return wall).

---

## Initial Guided Staged Wall Observations
- wall containing built-in AC unit [wall_ac_unit_right_third]
  primary semantic anchor: built-in AC unit
  same permanent wall visible: TRUE
  wall visibility: substantial
  wall extent: substantial
  left corner visible: true
  right corner visible: false
  continues beyond frame: true
  terminates at corner: false
  return wall visible: false
  adjoining wall visible: false
  recess visible: false
  confidence: 1
  reason: none
  observations: The wall containing the built-in AC unit is clearly visible. | It forms a visible corner on its left with the wall containing the sliding glass door. | It continues beyond the right image frame without a visible corner.
- wall containing sliding glass door [wall_door_center_third_full_height]
  primary semantic anchor: sliding glass door
  same permanent wall visible: TRUE
  wall visibility: substantial
  wall extent: substantial
  left corner visible: true
  right corner visible: true
  continues beyond frame: false
  terminates at corner: true
  return wall visible: true
  adjoining wall visible: true
  recess visible: false
  confidence: 1
  reason: none
  observations: The wall containing the sliding glass door is clearly visible. | It forms a visible corner on its right with the wall containing the built-in AC unit. | It terminates at a visible left corner, where it connects to a permanent return wall that extends out of frame to the left. | The baseline described 'no visible left corner' and 'continues beyond frame' for this wall, but in the staged image, a left corner is now visible, and the wall itself terminates at this corner.

---

## Extraction Integrity Gate
- passed: YES
- final evaluated attempt: 1
- mapping confidence threshold: 0.5
- issues: none

---

## Retry Status
- retry triggered: NO
- total attempts: 1
- final attempt: 1
- retry succeeded: YES
- reason: none

---

## Final Guided Staged Observation
Staged Verification
- Verified baseline walls: 2
- wall containing built-in AC unit: substantial visibility, extent substantial; leftCorner=yes; rightCorner=no; continuesBeyondFrame=yes; returnWallVisible=no; adjoiningWallVisible=no; recessVisible=no
- wall containing sliding glass door: substantial visibility, extent substantial; leftCorner=yes; rightCorner=yes; continuesBeyondFrame=no; returnWallVisible=yes; adjoiningWallVisible=yes; recessVisible=no
- Additional permanent wall planes: TRUE
  - A permanent wall plane adjoining the left edge of the wall containing the sliding glass door, extending out of frame to the left (a return wall).

---

## Final Guided Staged Wall Observations
- wall containing built-in AC unit [wall_ac_unit_right_third]
  primary semantic anchor: built-in AC unit
  same permanent wall visible: TRUE
  wall visibility: substantial
  wall extent: substantial
  left corner visible: true
  right corner visible: false
  continues beyond frame: true
  terminates at corner: false
  return wall visible: false
  adjoining wall visible: false
  recess visible: false
  confidence: 1
  reason: none
  observations: The wall containing the built-in AC unit is clearly visible. | It forms a visible corner on its left with the wall containing the sliding glass door. | It continues beyond the right image frame without a visible corner.
- wall containing sliding glass door [wall_door_center_third_full_height]
  primary semantic anchor: sliding glass door
  same permanent wall visible: TRUE
  wall visibility: substantial
  wall extent: substantial
  left corner visible: true
  right corner visible: true
  continues beyond frame: false
  terminates at corner: true
  return wall visible: true
  adjoining wall visible: true
  recess visible: false
  confidence: 1
  reason: none
  observations: The wall containing the sliding glass door is clearly visible. | It forms a visible corner on its right with the wall containing the built-in AC unit. | It terminates at a visible left corner, where it connects to a permanent return wall that extends out of frame to the left. | The baseline described 'no visible left corner' and 'continues beyond frame' for this wall, but in the staged image, a left corner is now visible, and the wall itself terminates at this corner.

---

## Deterministic Observations
- baseline wall count: 2
- staged wall count: 2
- obs_wall_0_visibility_changed: wall containing built-in AC unit: wall visibility classification changed from baseline to staged extraction.
- obs_wall_0_certainty_changed: wall containing built-in AC unit: architectural certainty changed from partial to known.
- obs_wall_3_visibility_changed: wall containing sliding glass door: wall visibility classification changed from baseline to staged extraction.
- obs_wall_3_certainty_changed: wall containing sliding glass door: architectural certainty changed from partial to known.
- obs_wall_3_new_corner: wall containing sliding glass door: staged extraction indicates a corner now visible where baseline did not.
- obs_wall_3_shortened: wall containing sliding glass door: staged wall now terminates at a corner where baseline did not show a termination.
- obs_wall_3_unsupported_completion: wall containing sliding glass door: baseline wall continued beyond frame with uncertainty, staged extraction resolves known completed geometry.

---

## Deterministic Structural Interpretations
- wall_shortened: wall containing sliding glass door no longer continues beyond the frame in staged observation.
  wall: wall containing sliding glass door
  severity: advisory
  confidence: low
  supporting facts: baseline continuesBeyondFrame=TRUE | staged continuesBeyondFrame=FALSE
  corroborating evidence: none
  contradicting evidence: none
- corner_introduced: wall containing sliding glass door now shows a left corner that baseline did not show.
  wall: wall containing sliding glass door
  severity: significant
  confidence: high
  supporting facts: baseline leftCornerVisible=FALSE | staged leftCornerVisible=TRUE
  corroborating evidence: none
  contradicting evidence: none
- return_wall_introduced: wall containing sliding glass door now has a visible return wall at the frame edge.
  wall: wall containing sliding glass door
  severity: significant
  confidence: high
  supporting facts: baseline returnWallVisible=FALSE | staged returnWallVisible=TRUE
  corroborating evidence: none
  contradicting evidence: none
- adjoining_wall_introduced: wall containing sliding glass door now has an adjoining wall plane visible at the frame edge.
  wall: wall containing sliding glass door
  severity: significant
  confidence: high
  supporting facts: baseline adjoiningWallVisible=FALSE | staged adjoiningWallVisible=TRUE
  corroborating evidence: none
  contradicting evidence: none
- wall_plane_introduced: Guided staged observation reports extra wall planes not associated with baseline semantic walls.
  wall: n/a
  severity: significant
  confidence: medium
  supporting facts: additional observed architectural features: additionalPermanentWallPlanes=TRUE
  corroborating evidence: A permanent wall plane adjoining the left edge of the wall containing the sliding glass door, extending out of frame to the left (a return wall).
  contradicting evidence: none
- return_wall_introduced: Guided staged observation reports return walls beyond the baseline model.
  wall: n/a
  severity: significant
  confidence: medium
  supporting facts: additional observed architectural features: additionalPermanentReturnWalls=TRUE
  corroborating evidence: A permanent return wall connected to the left edge of the wall containing the sliding glass door, extending out of frame to the left.
  contradicting evidence: none
- corner_introduced: Guided staged observation reports corners not accounted for by baseline semantic walls.
  wall: n/a
  severity: significant
  confidence: medium
  supporting facts: additional observed architectural features: additionalPermanentCorners=TRUE
  corroborating evidence: A permanent corner connecting the left edge of the wall containing the sliding glass door to an adjoining wall plane (the return wall).
  contradicting evidence: none

---

## Additional Observed Architectural Features
- additional permanent wall planes: TRUE
- additional permanent wall plane descriptions: A permanent wall plane adjoining the left edge of the wall containing the sliding glass door, extending out of frame to the left (a return wall).
- additional permanent return walls: TRUE
- additional permanent return wall descriptions: A permanent return wall connected to the left edge of the wall containing the sliding glass door, extending out of frame to the left.
- additional permanent recesses: FALSE
- additional permanent recess descriptions: none
- additional permanent corners: TRUE
- additional permanent corner descriptions: A permanent corner connecting the left edge of the wall containing the sliding glass door to an adjoining wall plane (the return wall).
- unmatched permanent architectural features: FALSE
- unmatched permanent feature descriptions: none
- confidence: 0.9
- reason: none

---

## Final Envelope Decision
- status: FAIL
- confidence: 1
- reason: envelope_confirmed_structural_change: wall containing sliding glass door now shows a left corner that baseline did not show.
- selected explanation: wall containing sliding glass door now shows a left corner that baseline did not show.

---

## Guided Observation Prompt
You are verifying whether the staged image still preserves the authoritative baseline architectural wall graph.

Review the BASELINE image and the STAGED image.

Only evaluate permanent architecture.
Ignore furniture, decor, styling, and movable objects.
The baseline graph is authoritative.
Do not extract the room again.
Do not rename walls.
Do not change wall ordering.
Do not merge walls.
Do not split walls.
Do not invent new semantic identities.

Your reasoning order is mandatory:
1. Verify each known baseline wall.
2. Verify the geometry of each known wall.
3. Observe any additional permanent architectural features not represented by the baseline semantic walls.

CANONICAL BASELINE ARCHITECTURAL MODEL:
Canonical Architectural Constraint Model
- Camera orientation: unknown
- Visible wall planes: wall containing built-in AC unit, wall containing sliding glass door
Wall containing built-in AC unit
- semantic wall identifier: wall containing built-in AC unit
- architectural anchors used only for wall identity: built-in AC unit
- wall visibility observation: wall containing built-in AC unit is partially visible
- wall visibility: partial
- Left edge transition
  - continues beyond frame: no
  - visible corner: yes
  - left corner visibility magnitude: partial
  - wall termination visibility: not resolved from baseline view
  - return wall visibility: not resolved from baseline view
  - adjoining wall plane visibility: not resolved from baseline view
  - recess visibility: not resolved from baseline view
- Right edge transition
  - continues beyond frame: yes
  - visible corner: no
  - right corner visibility magnitude: none
  - wall termination visibility: not observed
  - return wall visibility: none
  - adjoining wall plane visibility: none
  - recess visibility: none
- wall containing built-in AC unit continues beyond the right image edge
Wall containing sliding glass door
- semantic wall identifier: wall containing sliding glass door
- architectural anchors used only for wall identity: sliding glass door
- wall visibility observation: wall containing sliding glass door is partially visible
- wall visibility: partial
- Left edge transition
  - continues beyond frame: yes
  - visible corner: no
  - left corner visibility magnitude: none
  - wall termination visibility: not observed
  - return wall visibility: none
  - adjoining wall plane visibility: none
  - recess visibility: none
- Right edge transition
  - continues beyond frame: no
  - visible corner: yes
  - right corner visibility magnitude: partial
  - wall termination visibility: not resolved from baseline view
  - return wall visibility: not resolved from baseline view
  - adjoining wall plane visibility: not resolved from baseline view
  - recess visibility: not resolved from baseline view
- wall containing sliding glass door continues beyond the left image edge

QUALIFIED BASELINE SEMANTIC WALLS TO VERIFY:
- semanticWallId: wall_ac_unit_right_third
  displayName: wall containing built-in AC unit
  primaryAnchor: built-in AC unit
  baseline geometry: wall containing built-in AC unit is partially visible | visibility magnitude: partial | wall containing built-in AC unit continues beyond the right image edge | wall containing built-in AC unit joins wall containing sliding glass door at a visible left corner | no visible right corner on wall containing built-in AC unit | no visible return wall at the right edge | no visible adjoining wall plane at the right edge | no visible recess at the right edge | no visible wall termination at the right edge
- semanticWallId: wall_door_center_third_full_height
  displayName: wall containing sliding glass door
  primaryAnchor: sliding glass door
  baseline geometry: wall containing sliding glass door is partially visible | visibility magnitude: partial | wall containing sliding glass door continues beyond the left image edge | no visible left corner on wall containing sliding glass door | wall containing sliding glass door joins wall containing built-in AC unit at a visible right corner | no visible return wall at the left edge | no visible adjoining wall plane at the left edge | no visible recess at the left edge | no visible wall termination at the left edge

BASELINE ADVISORY GEOMETRY (CORROBORATING ONLY; NEVER SEMANTIC IDENTITIES):
- none

For each baseline semantic wall above, answer whether that same permanent wall is visible in the staged image.
If TRUE, describe only that wall using:
- wallVisibility
- wallExtent
- leftCornerVisible
- rightCornerVisible
- continuesBeyondFrame
- terminatesAtCorner
- returnWallVisible
- adjoiningWallVisible
- recessVisible
- architecturalCertainty
- confidence
- reason

After every known wall has been verified, report observational-only additional architectural features using these fields:
- additionalPermanentWallPlanes
- additionalPermanentWallPlaneDescriptions
- additionalPermanentCorners
- additionalPermanentCornerDescriptions
- additionalPermanentReturnWalls
- additionalPermanentReturnWallDescriptions
- additionalPermanentRecesses
- additionalPermanentRecessDescriptions
- unmatchedPermanentArchitecturalFeatures
- unmatchedPermanentFeatureDescriptions

Do not infer whether these observations imply architectural change.

Return JSON only:

{
  "answer":"TRUE"|"FALSE",
  "confidence":0.0-1.0,
  "analysis":"concise visual explanation",
  "selectedExplanation":"short primary explanation",
  "primaryHypothesis":"short primary hypothesis",
  "hypothesisConfidence":"Low"|"Medium"|"High",
  "visualAmbiguity":true|false,
  "boundaryLinesMissing":true|false,
  "continuousSurfaceReplacement":true|false,
  "noPlausibleVisualExplanation":true|false,
  "wallVerifications":[
    {
      "semanticWallId":"exact baseline semanticWallId",
      "displayName":"exact baseline displayName",
      "primaryAnchorLabel":"exact baseline primaryAnchorLabel",
      "samePermanentWallVisible":"TRUE"|"FALSE",
      "wallVisibility":"none"|"minimal"|"partial"|"substantial"|"dominant"|"complete"|"full",
      "wallExtent":"none"|"minimal"|"partial"|"substantial"|"dominant"|"complete"|"full",
      "architecturalCertainty":"known"|"partial"|"unknown",
      "leftCornerVisible":true|false,
      "rightCornerVisible":true|false,
      "continuesBeyondFrame":true|false,
      "terminatesAtCorner":true|false,
      "returnWallVisible":true|false,
      "adjoiningWallVisible":true|false,
      "recessVisible":true|false,
      "confidence":0.0-1.0,
      "reason":"required when samePermanentWallVisible is FALSE; otherwise optional",
      "observations":["short geometric observations"]
    }
  ],
  "additionalPermanentWallPlanes":"TRUE"|"FALSE",
  "additionalPermanentWallPlaneDescriptions":["additional permanent wall planes not represented by baseline semantic walls"],
  "additionalPermanentCorners":"TRUE"|"FALSE",
  "additionalPermanentCornerDescriptions":["additional permanent corners not represented by baseline semantic walls"],
  "additionalPermanentReturnWalls":"TRUE"|"FALSE",
  "additionalPermanentReturnWallDescriptions":["additional permanent return walls not represented by baseline semantic walls"],
  "additionalPermanentRecesses":"TRUE"|"FALSE",
  "additionalPermanentRecessDescriptions":["additional permanent recesses not represented by baseline semantic walls"],
  "unmatchedPermanentArchitecturalFeatures":"TRUE"|"FALSE",
  "unmatchedPermanentFeatureDescriptions":["permanent architectural features not associated with baseline semantic walls"]
}

---

## Guided Observation Gemini JSON
```json
{
  "answer": "TRUE",
  "confidence": 0.9,
  "analysis": "The two baseline semantic walls, 'wall containing built-in AC unit' and 'wall containing sliding glass door', are clearly visible in the staged image. Their permanent architectural forms are preserved. However, the geometric visibility of the left edge of the 'wall containing sliding glass door' has changed; a corner and an adjoining return wall are now visible, which were not described as visible in the baseline.",
  "selectedExplanation": "All baseline semantic walls are present. A previously unobserved corner and adjoining return wall are now visible to the left of the wall containing the sliding glass door.",
  "primaryHypothesis": "The authoritative baseline architectural wall graph is preserved. The additional visible architectural features are consistent with the existing graph, revealing previously unseen parts of the room's permanent structure.",
  "hypothesisConfidence": "High",
  "visualAmbiguity": false,
  "boundaryLinesMissing": false,
  "continuousSurfaceReplacement": false,
  "noPlausibleVisualExplanation": false,
  "wallVerifications": [
    {
      "semanticWallId": "wall_ac_unit_right_third",
      "displayName": "wall containing built-in AC unit",
      "primaryAnchorLabel": "built-in AC unit",
      "samePermanentWallVisible": "TRUE",
      "wallVisibility": "substantial",
      "wallExtent": "substantial",
      "architecturalCertainty": "known",
      "leftCornerVisible": true,
      "rightCornerVisible": false,
      "continuesBeyondFrame": true,
      "terminatesAtCorner": false,
      "returnWallVisible": false,
      "adjoiningWallVisible": false,
      "recessVisible": false,
      "confidence": 1.0,
      "observations": [
        "The wall containing the built-in AC unit is clearly visible.",
        "It forms a visible corner on its left with the wall containing the sliding glass door.",
        "It continues beyond the right image frame without a visible corner."
      ]
    },
    {
      "semanticWallId": "wall_door_center_third_full_height",
      "displayName": "wall containing sliding glass door",
      "primaryAnchorLabel": "sliding glass door",
      "samePermanentWallVisible": "TRUE",
      "wallVisibility": "substantial",
      "wallExtent": "substantial",
      "architecturalCertainty": "known",
      "leftCornerVisible": true,
      "rightCornerVisible": true,
      "continuesBeyondFrame": false,
      "terminatesAtCorner": true,
      "returnWallVisible": true,
      "adjoiningWallVisible": true,
      "recessVisible": false,
      "confidence": 1.0,
      "observations": [
        "The wall containing the sliding glass door is clearly visible.",
        "It forms a visible corner on its right with the wall containing the built-in AC unit.",
        "It terminates at a visible left corner, where it connects to a permanent return wall that extends out of frame to the left.",
        "The baseline described 'no visible left corner' and 'continues beyond frame' for this wall, but in the staged image, a left corner is now visible, and the wall itself terminates at this corner."
      ]
    }
  ],
  "additionalPermanentWallPlanes": "TRUE",
  "additionalPermanentWallPlaneDescriptions": [
    "A permanent wall plane adjoining the left edge of the wall containing the sliding glass door, extending out of frame to the left (a return wall)."
  ],
  "additionalPermanentCorners": "TRUE",
  "additionalPermanentCornerDescriptions": [
    "A permanent corner connecting the left edge of the wall containing the sliding glass door to an adjoining wall plane (the return wall)."
  ],
  "additionalPermanentReturnWalls": "TRUE",
  "additionalPermanentReturnWallDescriptions": [
    "A permanent return wall connected to the left edge of the wall containing the sliding glass door, extending out of frame to the left."
  ],
  "additionalPermanentRecesses": "FALSE",
  "additionalPermanentRecessDescriptions": [],
  "unmatchedPermanentArchitecturalFeatures": "FALSE",
  "unmatchedPermanentFeatureDescriptions": []
}
```
