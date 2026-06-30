# Envelope Constraint Verification Report - job_4a87f43b

## Pipeline Status
- Default envelope validator pipeline: baseline extraction -> qualified semantic walls + advisory geometry -> guided staged extraction -> extraction integrity gate -> deterministic comparison -> deterministic structural interpretation -> PASS / FAIL.
- Semantic wall repair, blank-wall promotion, and identity regeneration are not used in this replay.
- Environment variables required to enable constraint verification: none.

---

## Baseline Candidate Surfaces
- candidate_wall_0
  advisory positional label: front wall
  qualification decision: qualified_semantic_wall
  qualification score: 68
  primary semantic anchor: window
  raw architectural features: window
  evidence breakdown: primary architectural anchor window: +38 | visible wall extent partial: +11 | visible corners (1): +8 | continuation beyond frame: +5 | right boundary visible: +3 | architectural certainty partial: +3
  reason: Sufficient structural evidence exists to promote this candidate into the semantic wall set.
- candidate_wall_1
  advisory positional label: right wall
  qualification decision: supporting_geometric_evidence
  qualification score: 30
  primary semantic anchor: none
  raw architectural features: none
  evidence breakdown: visible wall extent partial: +11 | visible corners (1): +8 | continuation beyond frame: +5 | left boundary visible: +3 | architectural certainty partial: +3
  reason: This candidate carries useful geometry but lacks enough architectural evidence to become a semantic wall.
- candidate_wall_3
  advisory positional label: left wall
  qualification decision: supporting_geometric_evidence
  qualification score: 16
  primary semantic anchor: none
  raw architectural features: none
  evidence breakdown: visible wall extent partial: +11 | continuation beyond frame: +5 | architectural certainty unknown: +0
  reason: This candidate carries useful geometry but lacks enough architectural evidence to become a semantic wall.

---

## Baseline Extraction
- baseline extraction: present
- wall count: 3
- opening count: 1
- anchor fixture count: 0
- wall 0: visibility=partial, extent=partial, certainty=partial, leftCorner=no, rightCorner=yes, continuesBeyondFrame=yes -- Wall contains a single window on its right side and terminates at an inside corner. The left extent of the wall is beyond the frame.
- wall 1: visibility=partial, extent=partial, certainty=partial, leftCorner=yes, rightCorner=no, continuesBeyondFrame=yes -- Wall begins at a visible inside corner on the left and continues beyond the frame on the right.
- wall 3: visibility=partial, extent=partial, certainty=unknown, leftCorner=no, rightCorner=no, continuesBeyondFrame=yes -- A continuous wall surface that extends beyond both the left and right visible boundaries within the frame.
- opening W1: window on wall 0 at right_third/mid_zone (confidence 0.95)
- anchor fixtures: none

---

## Qualified Baseline Semantic Walls
- wall containing window [wall_window_right_third_mid_zone]
  primary semantic anchor: window
  secondary architectural features: none
  raw architectural features: window
  advisory positional label: front wall
  identity ambiguity: none
  geometry: wall containing window is partially visible | visibility magnitude: partial | wall containing window continues beyond the left image edge | no visible left corner on wall containing window | wall containing window joins right wall at a visible right corner | wall containing window terminates at an observed corner | no visible return wall at the left edge | no visible adjoining wall plane at the left edge | no visible recess at the left edge | no visible wall termination at the left edge

---

## Baseline Advisory Geometry
- candidate_wall_1 (right wall)
  qualification decision: supporting_geometric_evidence
  primary semantic anchor: none
  raw architectural features: none
  descriptor: Wall begins at a visible inside corner on the left and continues beyond the frame on the right.
  evidence breakdown: visible wall extent partial: +11 | visible corners (1): +8 | continuation beyond frame: +5 | left boundary visible: +3 | architectural certainty partial: +3
  reason: This candidate carries useful geometry but lacks enough architectural evidence to become a semantic wall.
- candidate_wall_3 (left wall)
  qualification decision: supporting_geometric_evidence
  primary semantic anchor: none
  raw architectural features: none
  descriptor: A continuous wall surface that extends beyond both the left and right visible boundaries within the frame.
  evidence breakdown: visible wall extent partial: +11 | continuation beyond frame: +5 | architectural certainty unknown: +0
  reason: This candidate carries useful geometry but lacks enough architectural evidence to become a semantic wall.

---

## Guided Staged Wall Observations
Staged Verification
- Verified baseline walls: 1
- wall containing window: substantial visibility, extent substantial
  - wall containing window is partially visible
  - wall containing window contains window
  - no visible left corner on wall containing window
  - wall containing window continues beyond the left image edge
  - no visible return wall adjacent to the left edge of wall containing window
  - no visible adjoining wall plane adjacent to the left edge of wall containing window
  - no visible recess adjacent to the left edge of wall containing window
  - wall containing window joins right wall at a visible right corner
  - wall containing window terminates at an observed right corner
  - return wall visible adjacent to the right edge of wall containing window
  - adjoining wall plane visible adjacent to the right edge of wall containing window
  - no visible recess adjacent to the right edge of wall containing window
  - visible left corner on wall containing window
  - wall containing window terminates at an observed left corner
  - adjoining wall plane visible adjacent to the left edge of wall containing window
  - return wall visible adjacent to the left edge of wall containing window
- Additional permanent architectural features:
  - permanent wall plane on the left side of the room
  - permanent wall plane on the right side of the room
  - return wall visible adjacent to the left edge of wall containing window

---

## Initial Guided Staged Wall Observations
- wall containing window [wall_window_right_third_mid_zone]
  primary semantic anchor: window
  same permanent wall visible: TRUE
  wall visibility: substantial
  wall extent: substantial
  architectural certainty: known
  confidence: 1
  reason: none
  observations:
    - wall containing window is partially visible
    - wall containing window contains window
    - no visible left corner on wall containing window
    - wall containing window continues beyond the left image edge
    - no visible return wall adjacent to the left edge of wall containing window
    - no visible adjoining wall plane adjacent to the left edge of wall containing window
    - no visible recess adjacent to the left edge of wall containing window
    - wall containing window joins right wall at a visible right corner
    - wall containing window terminates at an observed right corner
    - return wall visible adjacent to the right edge of wall containing window
    - adjoining wall plane visible adjacent to the right edge of wall containing window
    - no visible recess adjacent to the right edge of wall containing window
  derived continues beyond frame: true
  derived terminates at corner: true
  derived left corner visible: false
  derived right corner visible: true
  derived return wall visible: true
  derived adjoining wall visible: true
  derived recess visible: false
  return wall visibility significance: substantial
  adjoining wall visibility significance: substantial
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
- Verified baseline walls: 1
- wall containing window: substantial visibility, extent substantial
  - wall containing window is partially visible
  - wall containing window contains window
  - no visible left corner on wall containing window
  - wall containing window continues beyond the left image edge
  - no visible return wall adjacent to the left edge of wall containing window
  - no visible adjoining wall plane adjacent to the left edge of wall containing window
  - no visible recess adjacent to the left edge of wall containing window
  - wall containing window joins right wall at a visible right corner
  - wall containing window terminates at an observed right corner
  - return wall visible adjacent to the right edge of wall containing window
  - adjoining wall plane visible adjacent to the right edge of wall containing window
  - no visible recess adjacent to the right edge of wall containing window
  - visible left corner on wall containing window
  - wall containing window terminates at an observed left corner
  - adjoining wall plane visible adjacent to the left edge of wall containing window
  - return wall visible adjacent to the left edge of wall containing window
- Additional permanent architectural features:
  - permanent wall plane on the left side of the room
  - permanent wall plane on the right side of the room
  - return wall visible adjacent to the left edge of wall containing window

---

## Final Guided Staged Wall Observations
- wall containing window [wall_window_right_third_mid_zone]
  primary semantic anchor: window
  same permanent wall visible: TRUE
  wall visibility: substantial
  wall extent: substantial
  architectural certainty: known
  confidence: 1
  reason: none
  observations:
    - wall containing window is partially visible
    - wall containing window contains window
    - no visible left corner on wall containing window
    - wall containing window continues beyond the left image edge
    - no visible return wall adjacent to the left edge of wall containing window
    - no visible adjoining wall plane adjacent to the left edge of wall containing window
    - no visible recess adjacent to the left edge of wall containing window
    - wall containing window joins right wall at a visible right corner
    - wall containing window terminates at an observed right corner
    - return wall visible adjacent to the right edge of wall containing window
    - adjoining wall plane visible adjacent to the right edge of wall containing window
    - no visible recess adjacent to the right edge of wall containing window
    - visible left corner on wall containing window
    - wall containing window terminates at an observed left corner
    - adjoining wall plane visible adjacent to the left edge of wall containing window
    - return wall visible adjacent to the left edge of wall containing window
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
- baseline wall count: 3
- staged wall count: 3
- obs_wall_0_visibility_changed: wall containing window: wall visibility classification changed from baseline to staged extraction.
- obs_wall_0_certainty_changed: wall containing window: architectural certainty changed from partial to known.
- obs_wall_0_new_corner: wall containing window: staged extraction indicates a corner now visible where baseline did not.
- obs_wall_0_unsupported_completion: wall containing window: baseline wall continued beyond frame with uncertainty, staged extraction resolves known completed geometry.

---

## Deterministic Structural Interpretations
- wall_shortened: wall containing window no longer continues beyond the frame in staged observation.
  wall: wall containing window
  severity: advisory
  confidence: low
  supporting facts: baseline continuesBeyondFrame=TRUE | staged continuesBeyondFrame=FALSE
  corroborating evidence: none
  contradicting evidence: none
- corner_introduced: wall containing window now shows a left corner that baseline did not show.
  wall: wall containing window
  severity: advisory
  confidence: medium
  supporting facts: baseline leftCornerVisible=FALSE | staged leftCornerVisible=TRUE | connected feature significance=partial
  corroborating evidence: none
  contradicting evidence: none
- wall_plane_introduced: Staged observation introduces a permanent wall plane at the left frame edge of wall containing window.
  wall: wall containing window
  severity: advisory
  confidence: medium
  supporting facts: baseline continuesBeyondFrame=TRUE | staged terminatesAtCorner=TRUE | staged returnWallVisible=TRUE | staged adjoiningWallVisible=TRUE | observed wall plane visibility=partial | architectural significance=potential_structural_concern
  corroborating evidence: permanent wall plane on the left side of the room | permanent wall plane on the right side of the room | return wall visible adjacent to the left edge of wall containing window
  contradicting evidence: none
- return_wall_introduced: wall containing window now has a visible return wall at the frame edge.
  wall: wall containing window
  severity: advisory
  confidence: medium
  supporting facts: baseline returnWallVisible=FALSE | staged returnWallVisible=TRUE | observed return wall visibility=partial | architectural significance=potential_structural_concern
  corroborating evidence: return wall visible adjacent to the left edge of wall containing window
  contradicting evidence: none
- adjoining_wall_introduced: wall containing window now has an adjoining wall plane visible at the frame edge.
  wall: wall containing window
  severity: advisory
  confidence: medium
  supporting facts: baseline adjoiningWallVisible=FALSE | staged adjoiningWallVisible=TRUE | observed adjoining wall visibility=partial | architectural significance=potential_structural_concern
  corroborating evidence: none
  contradicting evidence: none

---

## Additional Observed Architectural Features
- permanent wall plane on the left side of the room
- permanent wall plane on the right side of the room
- return wall visible adjacent to the left edge of wall containing window
- additional permanent wall plane visibility significance: partial
- additional permanent return wall visibility significance: partial
- additional permanent recess visibility significance: unknown
- additional permanent corner visibility significance: unknown
- confidence: 1
- reason: none

---

## Final Envelope Decision
- status: PASS
- confidence: 0.65
- reason: envelope_insufficient_geometric_evidence: wall containing window no longer continues beyond the frame in staged observation.
- selected explanation: wall containing window no longer continues beyond the frame in staged observation.

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
- Visible wall planes: wall containing window
Wall containing window
- semantic wall identifier: wall containing window
- architectural anchors used only for wall identity: window
- wall visibility observation: wall containing window is partially visible
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
  - wall termination visibility: observed
  - return wall visibility: not resolved from baseline view
  - adjoining wall plane visibility: not resolved from baseline view
  - recess visibility: not resolved from baseline view
- wall containing window continues beyond the left image edge

QUALIFIED BASELINE SEMANTIC WALLS TO VERIFY:
- semanticWallId: wall_window_right_third_mid_zone
  displayName: wall containing window
  primaryAnchor: window
  baseline geometry: wall containing window is partially visible | visibility magnitude: partial | wall containing window continues beyond the left image edge | no visible left corner on wall containing window | wall containing window joins right wall at a visible right corner | wall containing window terminates at an observed corner | no visible return wall at the left edge | no visible adjoining wall plane at the left edge | no visible recess at the left edge | no visible wall termination at the left edge

BASELINE ADVISORY GEOMETRY (CORROBORATING ONLY; NEVER SEMANTIC IDENTITIES):
- candidate_wall_1 (right wall) [supporting_geometric_evidence]: Wall begins at a visible inside corner on the left and continues beyond the frame on the right. | evidence: visible wall extent partial: +11 | visible corners (1): +8 | continuation beyond frame: +5 | left boundary visible: +3 | architectural certainty partial: +3
- candidate_wall_3 (left wall) [supporting_geometric_evidence]: A continuous wall surface that extends beyond both the left and right visible boundaries within the frame. | evidence: visible wall extent partial: +11 | continuation beyond frame: +5 | architectural certainty unknown: +0

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
  "stagedImageSummary": "The staged image displays a bedroom with a bed centered against the wall containing a window. A large plain wall occupies the left side, and a plain wall occupies the right side. Furniture and decor are present.",
  "wallVerifications": [
    {
      "semanticWallId": "wall_window_right_third_mid_zone",
      "displayName": "wall containing window",
      "primaryAnchorLabel": "window",
      "samePermanentWallVisible": "TRUE",
      "wallVisibility": "substantial",
      "wallExtent": "substantial",
      "architecturalCertainty": "known",
      "returnWallVisibilityMagnitude": "substantial",
      "adjoiningWallVisibilityMagnitude": "substantial",
      "recessVisibilityMagnitude": "none",
      "confidence": 1.0,
      "observations": [
        "wall containing window is partially visible",
        "wall containing window contains window",
        "no visible left corner on wall containing window",
        "wall containing window continues beyond the left image edge",
        "no visible return wall adjacent to the left edge of wall containing window",
        "no visible adjoining wall plane adjacent to the left edge of wall containing window",
        "no visible recess adjacent to the left edge of wall containing window",
        "wall containing window joins right wall at a visible right corner",
        "wall containing window terminates at an observed right corner",
        "return wall visible adjacent to the right edge of wall containing window",
        "adjoining wall plane visible adjacent to the right edge of wall containing window",
        "no visible recess adjacent to the right edge of wall containing window"
      ]
    }
  ],
  "additionalPermanentArchitecturalFeatures": [
    "full: permanent wall plane on the left side of the room",
    "substantial: permanent wall plane on the right side of the room"
  ]
}
```
