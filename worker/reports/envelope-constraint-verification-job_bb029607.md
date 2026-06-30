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
- wall 0: visibility=partial, extent=partial, certainty=partial, leftCorner=yes, rightCorner=no, continuesBeyondFrame=yes -- Wall forms an inside corner on the left and continues beyond the right frame.
- wall 3: visibility=partial, extent=partial, certainty=partial, leftCorner=no, rightCorner=yes, continuesBeyondFrame=yes -- Wall contains a large sliding glass door, continues beyond the left frame, and forms an inside corner on the right.
- opening D1: door on wall 3 at center_third/full_height (confidence 0.99)
- fixture F1: ac_unit on wall 0 at right_third (confidence 0.98)

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
- wall containing built-in AC unit: partial visibility, extent partial
  - wall containing built-in AC unit is partially visible
  - wall containing built-in AC unit contains built-in AC unit
  - visible left corner on wall containing built-in AC unit
  - wall containing built-in AC unit terminates at an observed left corner
  - adjoining wall plane visible adjacent to the left edge of wall containing built-in AC unit
  - no visible right corner on wall containing built-in AC unit
  - wall containing built-in AC unit continues beyond the right image edge
  - no visible return wall adjacent to the right edge of wall containing built-in AC unit
  - visible right corner on wall containing built-in AC unit
  - wall containing built-in AC unit terminates at an observed right corner
  - adjoining wall plane visible adjacent to the right edge of wall containing built-in AC unit
  - return wall visible adjacent to the right edge of wall containing built-in AC unit
- wall containing sliding glass door: partial visibility, extent partial
  - wall containing sliding glass door is partially visible
  - wall containing sliding glass door contains sliding glass door
  - visible left corner on wall containing sliding glass door
  - wall containing sliding glass door terminates at an observed left corner
  - return wall visible adjacent to the left edge of wall containing sliding glass door
  - visible right corner on wall containing sliding glass door
  - wall containing sliding glass door terminates at an observed right corner
  - adjoining wall plane visible adjacent to the right edge of wall containing sliding glass door
  - adjoining wall plane visible adjacent to the left edge of wall containing sliding glass door
- Additional permanent architectural features:
  - adjoining wall plane visible adjacent to the right edge of wall containing built-in AC unit
  - permanent interior corner connecting the permanent return wall and the permanent wall plane to the left
  - permanent interior corner connecting the wall containing sliding glass door and the permanent return wall
  - permanent return wall connected to the left edge of wall containing sliding glass door
  - permanent wall plane parallel to the wall containing sliding glass door, visible to the left of the room
  - return wall visible adjacent to the left edge of wall containing sliding glass door

---

## Initial Guided Staged Wall Observations
- wall containing built-in AC unit [wall_ac_unit_right_third]
  primary semantic anchor: built-in AC unit
  same permanent wall visible: TRUE
  wall visibility: partial
  wall extent: partial
  architectural certainty: known
  confidence: 1
  reason: none
  observations:
    - wall containing built-in AC unit is partially visible
    - wall containing built-in AC unit contains built-in AC unit
    - visible left corner on wall containing built-in AC unit
    - wall containing built-in AC unit terminates at an observed left corner
    - adjoining wall plane visible adjacent to the left edge of wall containing built-in AC unit
    - no visible right corner on wall containing built-in AC unit
    - wall containing built-in AC unit continues beyond the right image edge
    - no visible return wall adjacent to the right edge of wall containing built-in AC unit
  derived continues beyond frame: true
  derived terminates at corner: true
  derived left corner visible: true
  derived right corner visible: false
  derived return wall visible: false
  derived adjoining wall visible: true
  derived recess visible: false
  return wall visibility significance: none
  adjoining wall visibility significance: partial
  recess visibility significance: none
- wall containing sliding glass door [wall_door_center_third_full_height]
  primary semantic anchor: sliding glass door
  same permanent wall visible: TRUE
  wall visibility: partial
  wall extent: partial
  architectural certainty: known
  confidence: 1
  reason: none
  observations:
    - wall containing sliding glass door is partially visible
    - wall containing sliding glass door contains sliding glass door
    - visible left corner on wall containing sliding glass door
    - wall containing sliding glass door terminates at an observed left corner
    - return wall visible adjacent to the left edge of wall containing sliding glass door
    - visible right corner on wall containing sliding glass door
    - wall containing sliding glass door terminates at an observed right corner
    - adjoining wall plane visible adjacent to the right edge of wall containing sliding glass door
  derived continues beyond frame: false
  derived terminates at corner: true
  derived left corner visible: true
  derived right corner visible: true
  derived return wall visible: true
  derived adjoining wall visible: true
  derived recess visible: false
  return wall visibility significance: partial
  adjoining wall visibility significance: partial
  recess visibility significance: none

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
- wall containing built-in AC unit: partial visibility, extent partial
  - wall containing built-in AC unit is partially visible
  - wall containing built-in AC unit contains built-in AC unit
  - visible left corner on wall containing built-in AC unit
  - wall containing built-in AC unit terminates at an observed left corner
  - adjoining wall plane visible adjacent to the left edge of wall containing built-in AC unit
  - no visible right corner on wall containing built-in AC unit
  - wall containing built-in AC unit continues beyond the right image edge
  - no visible return wall adjacent to the right edge of wall containing built-in AC unit
  - visible right corner on wall containing built-in AC unit
  - wall containing built-in AC unit terminates at an observed right corner
  - adjoining wall plane visible adjacent to the right edge of wall containing built-in AC unit
  - return wall visible adjacent to the right edge of wall containing built-in AC unit
- wall containing sliding glass door: partial visibility, extent partial
  - wall containing sliding glass door is partially visible
  - wall containing sliding glass door contains sliding glass door
  - visible left corner on wall containing sliding glass door
  - wall containing sliding glass door terminates at an observed left corner
  - return wall visible adjacent to the left edge of wall containing sliding glass door
  - visible right corner on wall containing sliding glass door
  - wall containing sliding glass door terminates at an observed right corner
  - adjoining wall plane visible adjacent to the right edge of wall containing sliding glass door
  - adjoining wall plane visible adjacent to the left edge of wall containing sliding glass door
- Additional permanent architectural features:
  - adjoining wall plane visible adjacent to the right edge of wall containing built-in AC unit
  - permanent interior corner connecting the permanent return wall and the permanent wall plane to the left
  - permanent interior corner connecting the wall containing sliding glass door and the permanent return wall
  - permanent return wall connected to the left edge of wall containing sliding glass door
  - permanent wall plane parallel to the wall containing sliding glass door, visible to the left of the room
  - return wall visible adjacent to the left edge of wall containing sliding glass door

---

## Final Guided Staged Wall Observations
- wall containing built-in AC unit [wall_ac_unit_right_third]
  primary semantic anchor: built-in AC unit
  same permanent wall visible: TRUE
  wall visibility: partial
  wall extent: partial
  architectural certainty: known
  confidence: 1
  reason: none
  observations:
    - wall containing built-in AC unit is partially visible
    - wall containing built-in AC unit contains built-in AC unit
    - visible left corner on wall containing built-in AC unit
    - wall containing built-in AC unit terminates at an observed left corner
    - adjoining wall plane visible adjacent to the left edge of wall containing built-in AC unit
    - no visible right corner on wall containing built-in AC unit
    - wall containing built-in AC unit continues beyond the right image edge
    - no visible return wall adjacent to the right edge of wall containing built-in AC unit
    - visible right corner on wall containing built-in AC unit
    - wall containing built-in AC unit terminates at an observed right corner
    - adjoining wall plane visible adjacent to the right edge of wall containing built-in AC unit
    - return wall visible adjacent to the right edge of wall containing built-in AC unit
  derived continues beyond frame: false
  derived terminates at corner: true
  derived left corner visible: true
  derived right corner visible: true
  derived return wall visible: true
  derived adjoining wall visible: true
  derived recess visible: false
  return wall visibility significance: partial
  adjoining wall visibility significance: partial
  recess visibility significance: none
- wall containing sliding glass door [wall_door_center_third_full_height]
  primary semantic anchor: sliding glass door
  same permanent wall visible: TRUE
  wall visibility: partial
  wall extent: partial
  architectural certainty: known
  confidence: 1
  reason: none
  observations:
    - wall containing sliding glass door is partially visible
    - wall containing sliding glass door contains sliding glass door
    - visible left corner on wall containing sliding glass door
    - wall containing sliding glass door terminates at an observed left corner
    - return wall visible adjacent to the left edge of wall containing sliding glass door
    - visible right corner on wall containing sliding glass door
    - wall containing sliding glass door terminates at an observed right corner
    - adjoining wall plane visible adjacent to the right edge of wall containing sliding glass door
    - adjoining wall plane visible adjacent to the left edge of wall containing sliding glass door
  derived continues beyond frame: false
  derived terminates at corner: true
  derived left corner visible: true
  derived right corner visible: true
  derived return wall visible: true
  derived adjoining wall visible: true
  derived recess visible: false
  return wall visibility significance: partial
  adjoining wall visibility significance: partial
  recess visibility significance: none

---

## Deterministic Observations
- baseline wall count: 2
- staged wall count: 2
- obs_wall_0_certainty_changed: wall containing built-in AC unit: architectural certainty changed from partial to known.
- obs_wall_0_new_corner: wall containing built-in AC unit: staged extraction indicates a corner now visible where baseline did not.
- obs_wall_0_shortened: wall containing built-in AC unit: staged wall now terminates at a corner where baseline did not show a termination.
- obs_wall_0_unsupported_completion: wall containing built-in AC unit: baseline wall continued beyond frame with uncertainty, staged extraction resolves known completed geometry.
- obs_wall_3_certainty_changed: wall containing sliding glass door: architectural certainty changed from partial to known.
- obs_wall_3_new_corner: wall containing sliding glass door: staged extraction indicates a corner now visible where baseline did not.
- obs_wall_3_shortened: wall containing sliding glass door: staged wall now terminates at a corner where baseline did not show a termination.
- obs_wall_3_unsupported_completion: wall containing sliding glass door: baseline wall continued beyond frame with uncertainty, staged extraction resolves known completed geometry.

---

## Deterministic Structural Interpretations
- wall_shortened: wall containing built-in AC unit no longer continues beyond the frame in staged observation.
  wall: wall containing built-in AC unit
  detected: wall_shortened
  associated wall: unknown
  classification: unknown
  decision: PASS
  severity: advisory
  confidence: low
  supporting facts: baseline continuesBeyondFrame=TRUE | staged continuesBeyondFrame=FALSE
  corroborating evidence: none
  contradicting evidence: none
- corner_introduced: wall containing built-in AC unit now shows a right corner that baseline did not show.
  wall: wall containing built-in AC unit
  detected: corner introduced
  associated wall: partial
  classification: structural_addition
  decision: FAIL
  severity: significant
  confidence: medium
  supporting facts: baseline rightCornerVisible=FALSE | staged rightCornerVisible=TRUE | associated wall magnitude=partial | connected feature significance=partial
  corroborating evidence: permanent interior corner connecting the permanent return wall and the permanent wall plane to the left | permanent interior corner connecting the wall containing sliding glass door and the permanent return wall
  contradicting evidence: none
- wall_plane_introduced: Staged observation introduces a permanent wall plane at the right frame edge of wall containing built-in AC unit.
  wall: wall containing built-in AC unit
  detected: wall plane introduced
  associated wall: partial
  classification: structural_addition
  decision: FAIL
  severity: significant
  confidence: medium
  supporting facts: baseline continuesBeyondFrame=TRUE | staged terminatesAtCorner=TRUE | staged returnWallVisible=TRUE | staged adjoiningWallVisible=TRUE | associated wall magnitude=partial | observed wall plane visibility=partial | architectural significance=structural_addition
  corroborating evidence: adjoining wall plane visible adjacent to the right edge of wall containing built-in AC unit | permanent interior corner connecting the permanent return wall and the permanent wall plane to the left | permanent interior corner connecting the wall containing sliding glass door and the permanent return wall | permanent return wall connected to the left edge of wall containing sliding glass door | permanent wall plane parallel to the wall containing sliding glass door, visible to the left of the room | return wall visible adjacent to the left edge of wall containing sliding glass door | return wall visible adjacent to the right edge of wall containing built-in AC unit
  contradicting evidence: none
- return_wall_introduced: wall containing built-in AC unit now has a visible return wall at the frame edge.
  wall: wall containing built-in AC unit
  detected: return wall introduced
  associated wall: partial
  classification: structural_addition
  decision: FAIL
  severity: significant
  confidence: medium
  supporting facts: baseline returnWallVisible=FALSE | staged returnWallVisible=TRUE | associated wall magnitude=partial | observed return wall visibility=partial | architectural significance=structural_addition
  corroborating evidence: permanent interior corner connecting the permanent return wall and the permanent wall plane to the left | permanent interior corner connecting the wall containing sliding glass door and the permanent return wall | permanent return wall connected to the left edge of wall containing sliding glass door | return wall visible adjacent to the left edge of wall containing sliding glass door | return wall visible adjacent to the right edge of wall containing built-in AC unit
  contradicting evidence: none
- adjoining_wall_introduced: wall containing built-in AC unit now has an adjoining wall plane visible at the frame edge.
  wall: wall containing built-in AC unit
  detected: adjoining wall introduced
  associated wall: partial
  classification: structural_addition
  decision: FAIL
  severity: significant
  confidence: medium
  supporting facts: baseline adjoiningWallVisible=FALSE | staged adjoiningWallVisible=TRUE | associated wall magnitude=partial | observed adjoining wall visibility=partial | architectural significance=structural_addition
  corroborating evidence: none
  contradicting evidence: none
- wall_shortened: wall containing sliding glass door no longer continues beyond the frame in staged observation.
  wall: wall containing sliding glass door
  detected: wall_shortened
  associated wall: unknown
  classification: unknown
  decision: PASS
  severity: advisory
  confidence: low
  supporting facts: baseline continuesBeyondFrame=TRUE | staged continuesBeyondFrame=FALSE
  corroborating evidence: none
  contradicting evidence: none
- corner_introduced: wall containing sliding glass door now shows a left corner that baseline did not show.
  wall: wall containing sliding glass door
  detected: corner introduced
  associated wall: partial
  classification: structural_addition
  decision: FAIL
  severity: significant
  confidence: medium
  supporting facts: baseline leftCornerVisible=FALSE | staged leftCornerVisible=TRUE | associated wall magnitude=partial | connected feature significance=partial
  corroborating evidence: permanent interior corner connecting the permanent return wall and the permanent wall plane to the left | permanent interior corner connecting the wall containing sliding glass door and the permanent return wall
  contradicting evidence: none
- wall_plane_introduced: Staged observation introduces a permanent wall plane at the left frame edge of wall containing sliding glass door.
  wall: wall containing sliding glass door
  detected: wall plane introduced
  associated wall: partial
  classification: structural_addition
  decision: FAIL
  severity: significant
  confidence: medium
  supporting facts: baseline continuesBeyondFrame=TRUE | staged terminatesAtCorner=TRUE | staged returnWallVisible=TRUE | staged adjoiningWallVisible=TRUE | associated wall magnitude=partial | observed wall plane visibility=partial | architectural significance=structural_addition
  corroborating evidence: adjoining wall plane visible adjacent to the right edge of wall containing built-in AC unit | permanent interior corner connecting the permanent return wall and the permanent wall plane to the left | permanent interior corner connecting the wall containing sliding glass door and the permanent return wall | permanent return wall connected to the left edge of wall containing sliding glass door | permanent wall plane parallel to the wall containing sliding glass door, visible to the left of the room | return wall visible adjacent to the left edge of wall containing sliding glass door | return wall visible adjacent to the right edge of wall containing built-in AC unit
  contradicting evidence: none
- return_wall_introduced: wall containing sliding glass door now has a visible return wall at the frame edge.
  wall: wall containing sliding glass door
  detected: return wall introduced
  associated wall: partial
  classification: structural_addition
  decision: FAIL
  severity: significant
  confidence: medium
  supporting facts: baseline returnWallVisible=FALSE | staged returnWallVisible=TRUE | associated wall magnitude=partial | observed return wall visibility=partial | architectural significance=structural_addition
  corroborating evidence: permanent interior corner connecting the permanent return wall and the permanent wall plane to the left | permanent interior corner connecting the wall containing sliding glass door and the permanent return wall | permanent return wall connected to the left edge of wall containing sliding glass door | return wall visible adjacent to the left edge of wall containing sliding glass door | return wall visible adjacent to the right edge of wall containing built-in AC unit
  contradicting evidence: none
- adjoining_wall_introduced: wall containing sliding glass door now has an adjoining wall plane visible at the frame edge.
  wall: wall containing sliding glass door
  detected: adjoining wall introduced
  associated wall: partial
  classification: structural_addition
  decision: FAIL
  severity: significant
  confidence: medium
  supporting facts: baseline adjoiningWallVisible=FALSE | staged adjoiningWallVisible=TRUE | associated wall magnitude=partial | observed adjoining wall visibility=partial | architectural significance=structural_addition
  corroborating evidence: none
  contradicting evidence: none

---

## Additional Observed Architectural Features
- adjoining wall plane visible adjacent to the right edge of wall containing built-in AC unit
- permanent interior corner connecting the permanent return wall and the permanent wall plane to the left
- permanent interior corner connecting the wall containing sliding glass door and the permanent return wall
- permanent return wall connected to the left edge of wall containing sliding glass door
- permanent wall plane parallel to the wall containing sliding glass door, visible to the left of the room
- return wall visible adjacent to the left edge of wall containing sliding glass door
- return wall visible adjacent to the right edge of wall containing built-in AC unit
- additional permanent wall plane visibility significance: partial
- additional permanent return wall visibility significance: partial
- additional permanent recess visibility significance: unknown
- additional permanent corner visibility significance: unknown
- confidence: 1
- reason: none

---

## Final Envelope Decision
- status: FAIL
- confidence: 1
- reason: envelope_confirmed_structural_change: The staged observation introduces a permanent corner and return wall not represented by the authoritative baseline wall geometry.
- selected explanation: The staged observation introduces a permanent corner and return wall not represented by the authoritative baseline wall geometry.

---

## Guided Observation Prompt
You are observing the staged image using the authoritative baseline semantic wall identities provided below.

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
Gemini must only describe staged-image observations.
Do not compare staged against baseline.
Do not explain why anything changed.
Do not conclude whether architecture changed.

Your observation order is mandatory:
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
If TRUE, describe only that wall using observation language that mirrors baseline extraction.
Use short descriptive observation lines such as:
- "wall containing sliding glass door is partially visible"
- "wall containing sliding glass door continues beyond the left image edge"
- "no visible left corner on wall containing sliding glass door"
- "wall containing sliding glass door joins wall containing built-in AC unit at a visible right corner"
- "wall containing sliding glass door terminates at an observed left corner"
- "return wall visible adjacent to the left edge of wall containing sliding glass door"
- "no visible adjoining wall plane adjacent to the left edge of wall containing sliding glass door"
- "no visible recess adjacent to the left edge of wall containing sliding glass door"
- "wall containing sliding glass door contains sliding glass door"

Do not mention baseline, previous visibility, or change.
Do not copy baseline geometry text unless that exact condition is visibly true in the staged image.
A return wall, adjoining wall plane, visible corner, or wall termination visible at a staged frame edge must be described directly in that wall's observations.
Do not hide such edge geometry by defaulting to continuation beyond frame.
For every visible wall, the observations array must explicitly cover the staged image only with:
- one visibility line
- one anchor containment line
- one left-edge corner line
- one left-edge continuation-or-termination line
- one left-edge adjacent-geometry line
- one right-edge corner line
- one right-edge continuation-or-termination line
- one right-edge adjacent-geometry line
If a wall terminates at a visible corner on an edge, state that directly for that edge and do not also say the wall continues beyond that same edge.
If a return wall is visible at an edge, also state the visible corner/termination for that same edge.
If an adjoining wall plane is visible at an edge, state it in that wall's observations even when it is the same observed geometry as a return wall.
If TRUE, include:
- wallVisibility
- wallExtent
- architecturalCertainty
- returnWallVisibilityMagnitude
- adjoiningWallVisibilityMagnitude
- recessVisibilityMagnitude
- observations
- confidence
- reason

For returnWallVisibilityMagnitude, adjoiningWallVisibilityMagnitude, and recessVisibilityMagnitude use exactly one of:
- none
- minimal
- small
- partial
- substantial
- full

Use these values only to describe how much of the permanent architectural feature is visible in the staged image.
Do not interpret what the value means.

After every known wall has been verified, report observational-only additional architectural features visible in the staged image but not part of the verified baseline semantic walls.
Use short descriptive feature lines only.
Do not list floors, ceilings, lighting, electrical outlets, trim, baseboards, or openings already contained within a verified baseline wall.
Only list additional permanent wall planes, return walls, interior corners, adjoining wall planes, recesses, or other room-envelope features not already covered by the verified baseline walls.
Prefix each listed feature with one visibility significance label:
- none
- minimal
- small
- partial
- substantial
- full

Example:
- "minimal: permanent return wall connected to the left edge of wall containing sliding glass door"
- "small: permanent interior corner connecting this return wall"

If no such features exist, return "NONE".

Do not infer whether these observations imply architectural change.

Return JSON only:

{
  "confidence":0.0-1.0,
  "stagedImageSummary":"concise observation-only summary of the staged image",
  "wallVerifications":[
    {
      "semanticWallId":"exact baseline semanticWallId",
      "displayName":"exact baseline displayName",
      "primaryAnchorLabel":"exact baseline primaryAnchorLabel",
      "samePermanentWallVisible":"TRUE"|"FALSE",
      "wallVisibility":"none"|"minimal"|"partial"|"substantial"|"dominant"|"complete"|"full",
      "wallExtent":"none"|"minimal"|"partial"|"substantial"|"dominant"|"complete"|"full",
      "architecturalCertainty":"known"|"partial"|"unknown",
      "returnWallVisibilityMagnitude":"none"|"minimal"|"small"|"partial"|"substantial"|"full",
      "adjoiningWallVisibilityMagnitude":"none"|"minimal"|"small"|"partial"|"substantial"|"full",
      "recessVisibilityMagnitude":"none"|"minimal"|"small"|"partial"|"substantial"|"full",
      "confidence":0.0-1.0,
      "reason":"required when samePermanentWallVisible is FALSE; otherwise optional",
      "observations":["short descriptive architectural observations only"]
    }
  ],
  "additionalPermanentArchitecturalFeatures":"NONE"|["descriptive permanent architectural features not part of the verified baseline semantic walls"]
}

---

## Guided Observation Gemini JSON
```json
{
  "confidence": 1.0,
  "stagedImageSummary": "The staged image displays a living room area with permanent architectural features including a wall containing a built-in AC unit, a wall with a sliding glass door, a return wall, and an additional perpendicular wall plane. The room features a white color scheme with a tiled floor.",
  "wallVerifications": [
    {
      "semanticWallId": "wall_ac_unit_right_third",
      "displayName": "wall containing built-in AC unit",
      "primaryAnchorLabel": "built-in AC unit",
      "samePermanentWallVisible": "TRUE",
      "wallVisibility": "partial",
      "wallExtent": "partial",
      "architecturalCertainty": "known",
      "returnWallVisibilityMagnitude": "none",
      "adjoiningWallVisibilityMagnitude": "partial",
      "recessVisibilityMagnitude": "none",
      "confidence": 1.0,
      "observations": [
        "wall containing built-in AC unit is partially visible",
        "wall containing built-in AC unit contains built-in AC unit",
        "visible left corner on wall containing built-in AC unit",
        "wall containing built-in AC unit terminates at an observed left corner",
        "adjoining wall plane visible adjacent to the left edge of wall containing built-in AC unit",
        "no visible right corner on wall containing built-in AC unit",
        "wall containing built-in AC unit continues beyond the right image edge",
        "no visible return wall adjacent to the right edge of wall containing built-in AC unit"
      ]
    },
    {
      "semanticWallId": "wall_door_center_third_full_height",
      "displayName": "wall containing sliding glass door",
      "primaryAnchorLabel": "sliding glass door",
      "samePermanentWallVisible": "TRUE",
      "wallVisibility": "partial",
      "wallExtent": "partial",
      "architecturalCertainty": "known",
      "returnWallVisibilityMagnitude": "partial",
      "adjoiningWallVisibilityMagnitude": "partial",
      "recessVisibilityMagnitude": "none",
      "confidence": 1.0,
      "observations": [
        "wall containing sliding glass door is partially visible",
        "wall containing sliding glass door contains sliding glass door",
        "visible left corner on wall containing sliding glass door",
        "wall containing sliding glass door terminates at an observed left corner",
        "return wall visible adjacent to the left edge of wall containing sliding glass door",
        "visible right corner on wall containing sliding glass door",
        "wall containing sliding glass door terminates at an observed right corner",
        "adjoining wall plane visible adjacent to the right edge of wall containing sliding glass door"
      ]
    }
  ],
  "additionalPermanentArchitecturalFeatures": [
    "partial: permanent return wall connected to the left edge of wall containing sliding glass door",
    "small: permanent interior corner connecting the wall containing sliding glass door and the permanent return wall",
    "partial: permanent wall plane parallel to the wall containing sliding glass door, visible to the left of the room",
    "small: permanent interior corner connecting the permanent return wall and the permanent wall plane to the left"
  ]
}
```
