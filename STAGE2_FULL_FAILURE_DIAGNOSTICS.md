# Stage 2 Full — Failed Image Diagnostics

Batch run: `logs.1771811038230.log` · 5 jobs total · 4 FULL_STAGE_ONLY exhausted → fallback 1A · 1 REFRESH_OR_DIRECT passed

---

## Diagnostic JSON — All 4 Failed Jobs (Attempt 1)

```json
[
  {
    "imageId": "job_491a101b-1f8d-45f4-ab29-f7d9ebdfeb21",
    "stage": "2",
    "validationMode": "FULL_STAGE_ONLY",
    "roomType": "bedroom",
    "sourceStage": "1A",
    "attempt": 1,
    "local": {
      "openingsChanged": true,
      "anchorsChanged": true,
      "anchorFlags": ["island_changed"],
      "structuralMaskPassed": false,
      "wallsPassed": false,
      "wallPercent": 56.76,
      "maskedEdgePercent": 57.23,
      "angleDegrees": 0,
      "ssim": 0.459,
      "windowDelta": "3→2",
      "doorDelta": "0→0",
      "openingsSemantic": "+1/-0",
      "openingsMask": "+1/-0"
    },
    "structuralEnforcement": {
      "forcedHardFail": true,
      "violationType": "opening_change"
    },
    "geminiRaw": {
      "category": "structure",
      "violationType": "opening_change",
      "hardFail": true,
      "confidence": 0.95,
      "reason": "All architectural elements including walls, window, door, ceiling, floor, and fixed electrical outlets remain unchanged. The ceiling light fixture and window blind also appear identical. There is no evidence of camera shift or envelope geometry drift. The ISLAND_CHANGED flag is a false positive. Changes are solely the introduction of freestanding furniture (bed, nightstands, armchair, side table, wall art).",
      "builtInDetected": true,
      "structuralAnchorCount": 1,
      "builtInLowConfidence": false,
      "builtInDowngradeAllowed": false
    },
    "geminiConfirm": {
      "attempt": 1,
      "confirmedFail": true,
      "confirmedViolations": [],
      "rejectedFlags": [
        "anchor:island_changed (no kitchen island present)",
        "ssim:0.459 (Gemini pipeline SSIM=1.0 authoritative)",
        "semantic_validator_failed: windows 3→2, wall_drift 56.76%, openings +1/-0 (all false positives)",
        "masked_edge_failed: drift 57.23%, openings +1/-0 (false positives)"
      ],
      "confirmedStructuralChanges": "NONE — all local signals explicitly rejected"
    },
    "final": {
      "hard": true,
      "category": "structure"
    },
    "diagnosis": "FALSE POSITIVE LOOP. Gemini semantic says no structural change. Confirm validator rejects all local flags as false positives. Zero confirmed violations. Yet confirmedFail=true fires. Bug: confirm prompt returns confirmedFail=true even when all evidence is rejected."
  },
  {
    "imageId": "job_30097326-cb62-498d-9af0-c0bf0c06526a",
    "stage": "2",
    "validationMode": "FULL_STAGE_ONLY",
    "roomType": "bedroom",
    "sourceStage": "1A",
    "attempt": 1,
    "local": {
      "openingsChanged": true,
      "anchorsChanged": true,
      "anchorFlags": ["island_changed", "lighting_changed"],
      "structuralMaskPassed": false,
      "wallsPassed": false,
      "wallPercent": 52.16,
      "maskedEdgePercent": 32.09,
      "angleDegrees": 0,
      "ssim": 0.149,
      "windowDelta": "1→1",
      "doorDelta": "0→0",
      "openingsSemantic": "+1/-0",
      "openingsMask": "+0/-0"
    },
    "structuralEnforcement": {
      "forcedHardFail": true,
      "violationType": "opening_change"
    },
    "geminiRaw": {
      "category": "structure",
      "violationType": "opening_change",
      "hardFail": true,
      "confidence": 0.98,
      "reason": "Room fully staged transforming empty room into functional bedroom. All architectural elements including walls, ceiling, floor, window openings, and door opening remain unchanged in position and size. Camera perspective identical. All built-in structural anchors (ceiling fan, flush-mount ceiling light fixture) are present in both images retaining exact footprint, position, silhouette. ISLAND_CHANGED and LIGHTING_CHANGED anchor flags deemed false positives upon visual inspection.",
      "builtInDetected": true,
      "structuralAnchorCount": 2,
      "builtInLowConfidence": false,
      "builtInDowngradeAllowed": false
    },
    "geminiConfirm": {
      "attempt": 1,
      "confirmedFail": true,
      "confirmedViolations": [
        "CEILING FIXTURE CHANGED: In BEFORE — yellowish dome-shaped flush mount light (near window). In AFTER — replaced with white conical/fluted flush mount. Classified as fixed ceiling fixture change → structural hard-fail."
      ],
      "rejectedFlags": [
        "anchor:island_changed (no kitchen island present)",
        "wall_drift_pct 52.16% (visual inspection contradicts — 0.00% drift per pipeline)",
        "masked_drift_pct 32.09% (contradicted by pipeline 0.00%)",
        "openings +1/-0 semantic (false positive)"
      ]
    },
    "final": {
      "hard": true,
      "category": "structure"
    },
    "diagnosis": "GENUINE VIOLATION. Ceiling light fixture changed from yellowish dome-shaped flush mount to white conical flush mount. Confirm validator correctly identified this as a real built_in_moved violation. NOTE: Gemini semantic (attempt 1) said LIGHTING_CHANGED was a false positive — it was WRONG. The confirm validator caught what semantic missed. Retry at attempt 2 shows violationType=built_in_moved which is the correct classification. This job legitimately blocked all 3 attempts because the generation kept changing the ceiling fixture."
  },
  {
    "imageId": "job_f34d32a9-a355-400e-8866-0f52a19db2fd",
    "stage": "2",
    "validationMode": "FULL_STAGE_ONLY",
    "roomType": "living_room",
    "sourceStage": "1A",
    "attempt": 1,
    "local": {
      "openingsChanged": true,
      "anchorsChanged": true,
      "anchorFlags": ["island_changed"],
      "structuralMaskPassed": false,
      "wallsPassed": false,
      "wallPercent": 18.54,
      "maskedEdgePercent": 57.37,
      "angleDegrees": 0,
      "ssim": 0.299,
      "windowDelta": "5→4",
      "doorDelta": "0→0",
      "openingsSemantic": "+0/-0",
      "openingsMask": "+0/-1"
    },
    "structuralEnforcement": {
      "forcedHardFail": true,
      "violationType": "opening_change"
    },
    "geminiRaw": {
      "category": "structure",
      "violationType": "opening_change",
      "hardFail": true,
      "confidence": 0.95,
      "reason": "Large sliding glass door on the left in BEFORE has been changed to a fixed large window in AFTER. This constitutes a structural modification to an opening altering its functionality and type. Curtains present on both the large left opening and the right opening in BEFORE have been removed in AFTER. Curtain removal is explicitly listed as a structural hard-fail condition.",
      "builtInDetected": true,
      "structuralAnchorCount": 1,
      "builtInLowConfidence": false,
      "builtInDowngradeAllowed": false
    },
    "geminiConfirm": {
      "attempt": 1,
      "confirmedFail": true,
      "confirmedViolations": [
        "OPENING TYPE CHANGE: Sliding glass door (left) → fixed large window. Opening type altered.",
        "CURTAIN REMOVAL: Curtains removed from both left opening and right opening. Curtain removal = structural hard-fail per prompt rules.",
        "ISLAND_CHANGED confirmed as a third signal (visible in confirm log from prior session analysis)."
      ],
      "rejectedFlags": []
    },
    "final": {
      "hard": true,
      "category": "structure"
    },
    "diagnosis": "GENUINE VIOLATION. Sliding glass door converted to fixed window (opening type change) AND curtains removed (explicit hard-fail condition). Both Gemini semantic and confirm validator agree. Generation consistently produced this change across all 3 retries — model appears unable to preserve the sliding door system when staging this scene."
  },
  {
    "imageId": "job_e53de680-02c1-4c60-8c91-c0b1a6d95ddb",
    "stage": "2",
    "validationMode": "FULL_STAGE_ONLY",
    "roomType": "dining_room",
    "sourceStage": "1A",
    "attempt": 1,
    "local": {
      "openingsChanged": true,
      "anchorsChanged": true,
      "anchorFlags": ["island_changed"],
      "structuralMaskPassed": false,
      "wallsPassed": false,
      "wallPercent": 37.42,
      "maskedEdgePercent": 49.30,
      "angleDegrees": 0,
      "ssim": 0.747,
      "windowDelta": "1→1",
      "doorDelta": "0→0",
      "openingsSemantic": "+1/-0",
      "openingsMask": "+1/-0"
    },
    "structuralEnforcement": {
      "forcedHardFail": true,
      "violationType": "opening_change"
    },
    "geminiRaw": {
      "category": "structure",
      "violationType": "opening_change",
      "hardFail": true,
      "confidence": 0.95,
      "reason": "No structural changes observed. All architectural elements including wall positions, corner positions, ceiling plane, room width/depth, window-to-wall ratio, door-to-wall ratio remain identical. Camera viewpoint/FOV/perspective unchanged (0.0% wall drift, 0.0% masked edge drift, 0.0° angle deviation). Built-in fixtures (ceiling fan, recessed lights, sliding door system with curtains, window with blinds, wall-mounted panels) are all present and unchanged. ISLAND_CHANGED flag is a false positive — no built-in island present. Changes are freestanding furniture only (dining table, chairs, rug, side cabinet).",
      "builtInDetected": true,
      "structuralAnchorCount": 1,
      "builtInLowConfidence": false,
      "builtInDowngradeAllowed": false
    },
    "geminiConfirm": {
      "attempt": 1,
      "confirmedFail": true,
      "confirmedViolations": [],
      "rejectedFlags": [
        "anchor:island_changed (no kitchen island, changes are freestanding furniture only)",
        "semantic_validator_failed: openings +1/-0, wall_drift 37.42% (all false positives, 0.00% per pipeline CV)",
        "masked_edge_failed: drift 49.30%, openings +1/-0 (false positives)",
        "ssim:0.747 (structural elements unchanged per visual inspection)"
      ],
      "confirmedStructuralChanges": "NONE — all local signals explicitly rejected"
    },
    "final": {
      "hard": true,
      "category": "structure"
    },
    "diagnosis": "FALSE POSITIVE LOOP. Gemini semantic explicitly says no structural changes (0.0% drift, all anchors unchanged). Confirm validator rejects every single flag as a false positive. Zero confirmed violations cited. Yet confirmedFail=true. Same bug as job_491a101b. This job should have passed all 3 retries and produced good output."
  }
]
```

---

## Summary Table

| Job | Room | Real Violation? | Gemini Semantic Verdict | Confirm Verdict | Diagnosis |
|-----|------|----------------|------------------------|-----------------|-----------|
| `job_491a101b` | bedroom | **NO** | "No structural changes, furniture only" | All flags REJECTED, zero confirmed violations, but `confirmedFail=true` | **FALSE POSITIVE BUG** |
| `job_30097326` | bedroom | **YES** | "ISLAND_CHANGED + LIGHTING_CHANGED are false positives" (WRONG) | Ceiling fixture changed: yellowish dome → white conical, `confirmedFail=true` | Genuine block — confirm caught what semantic missed |
| `job_f34d32a9` | living room | **YES** | Sliding door → fixed window + curtains removed | Confirmed both violations, `confirmedFail=true` | Genuine block |
| `job_e53de680` | dining room | **NO** | "No structural changes, 0.0% drift, ISLAND_CHANGED false positive" | All flags REJECTED, zero confirmed violations, but `confirmedFail=true` | **FALSE POSITIVE BUG** |

---

## Root Cause Analysis

### Bug: `confirmedFail=true` with zero confirmed violations (jobs 491a101b and e53de680)

**Symptom:** The confirm validator response contains only "Rejected:" and "Confirmed: no change" reasons. No structural violation is actually confirmed. Yet the parsed `confirmedFail` field is `true`.

**Likely cause — confirm prompt response schema ambiguity:**

The confirm prompt asks Gemini to return a JSON object like:
```json
{ "confirmedFail": true/false, "reasons": [...] }
```

The model appears to be setting `confirmedFail: true` to mean **"I have processed the confirmation request and completed my analysis"** rather than **"I confirm the fail is genuine."** The reasons array clearly shows the model concluded there is no structural change — but the `confirmedFail` boolean is `true` anyway.

This is a prompt ambiguity problem. The `confirmedFail` field name is confusing. The model interprets it as "did I complete the confirmation?" rather than "is the structural fail confirmed as genuine?"

**Alternative cause — `STRUCTURAL_ENFORCEMENT_APPLIED` pre-emption:**

The `STRUCTURAL_ENFORCEMENT_APPLIED` block fires with `forcedHardFail=true` before Gemini semantic runs. The confirm validator may be receiving `forcedHardFail=true` in its evidence payload and returning `confirmedFail=true` because `forcedHardFail` is already set — treating it as authoritative over its own reasoning.

**The `ISLAND_CHANGED` false positive cascade:**

All 4 jobs fired `anchor:island_changed`. For bedroom and dining room scenes, there is no kitchen island — the anchor detector is misidentifying furniture clusters or dark counter-like regions as an island. This false anchor flag:
1. Causes `risk=HIGH`
2. Triggers `STRUCTURAL_ENFORCEMENT_APPLIED forcedHardFail=true violationType=opening_change`
3. Sends the image through the confirm path unconditionally
4. Confirm returns `confirmedFail=true` (bug) even when it rejects all evidence

---

## Actionable Fixes

### Fix 1: `confirmedFail` semantics in confirm prompt (HIGH PRIORITY)

Rename the output field and change the prompt instruction:
```
// Current (ambiguous):
"Return confirmedFail: true if you have reviewed the findings"

// Should be:
"Return structuralViolationConfirmed: true ONLY if you have identified at least one 
 specific structural element that was genuinely changed. Return false if all flags 
 are false positives and no structural change occurred."
```
And update the parser to use `structuralViolationConfirmed` with a default of `false`.

### Fix 2: `ISLAND_CHANGED` false positive suppression

The `island_changed` anchor should be suppressed for non-kitchen room types:
```typescript
if (roomType !== 'kitchen' && roomType !== 'dining_room') {
  anchorFlags = anchorFlags.filter(f => f !== 'island_changed');
}
```
(dining_room may legitimately have a kitchen island pass-through — review separately)

### Fix 3: Require at least one `confirmedViolations` entry before setting `confirmedFail=true`

In the confirm validator parsing code, override the returned `confirmedFail` value:
```typescript
// After parsing Gemini confirm response:
if (confirmedViolations.length === 0 && confirmedFail === true) {
  console.warn('[GEMINI_CONFIRM] confirmedFail=true but zero confirmed violations — overriding to false');
  confirmedFail = false;
}
```

---

## Passing Job Reference (job_3ed6c993, REFRESH_OR_DIRECT)

| Field | Value |
|-------|-------|
| validationMode | REFRESH_OR_DIRECT |
| roomType | kitchen |
| gemini-semantic | hardFail=false, conf=1, cat=style_only |
| SSIM | 0.862 |
| Structural IoU (masked) | 0.999 |
| Edge IoU | 0.998 |
| anchor fired | cabinetry_changed (false positive: decorative items only) |
| confirm | status=pass, confirmedFail=false |
| verdict | PASS |

Key difference: `validationMode=REFRESH_OR_DIRECT` means `geminiMode=log` (advisory only), not `block`. Gemini semantic returning `hardFail=false` is sufficient to pass. The `confirmedFail` bug doesn't trigger because gemini semantic returned `hardFail=false`.
