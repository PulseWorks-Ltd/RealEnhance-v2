import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";
import {
  detectRelocation,
  type StructuralBaseline,
  validateOpeningPreservation,
} from "./openingPreservationValidator";
import type { ValidatorOutcome } from "./validatorOutcome";

export type OpeningValidatorResult = ValidatorOutcome;

const OPENING_MODEL_PRIMARY = process.env.GEMINI_VALIDATOR_MODEL_PRIMARY || "gemini-2.5-flash";
const OPENING_MODEL_ESCALATION = process.env.GEMINI_VALIDATOR_MODEL_ESCALATION || "gemini-2.5-pro";
const OPENING_ESCALATION_CONFIDENCE = Number(process.env.GEMINI_VALIDATOR_PRO_MIN_CONFIDENCE || 0.7);
const OPENING_LIGHT_ANCHOR_MODEL = process.env.GEMINI_OPENING_LIGHT_ANCHOR_MODEL || OPENING_MODEL_PRIMARY;

function parseOpeningResult(rawText: string): OpeningValidatorResult {
  const cleaned = String(rawText || "").replace(/```json|```/gi, "").trim();
  const jsonCandidate = cleaned.match(/\{[\s\S]*\}/)?.[0] ?? cleaned;
  let parsed: any;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    throw new Error("validator_error_invalid_json");
  }

  if (typeof parsed?.ok !== "boolean") {
    throw new Error("validator_error_invalid_schema");
  }

  const reason = typeof parsed?.reason === "string" && parsed.reason.trim().length > 0
    ? parsed.reason.trim()
    : parsed.ok ? "openings_preserved" : "openings_changed";
  const confidence = Number.isFinite(parsed?.confidence) ? Number(parsed.confidence) : 0.5;

  return {
    status: parsed.ok ? "pass" : "fail",
    reason,
    confidence,
    hardFail: parsed.ok ? false : confidence >= 0.85,
    advisorySignals: parsed.ok ? [] : [reason],
  };
}

type OpeningLightAnchorVerdict = {
  openingInfilled: boolean;
  openingRemoved: boolean;
  openingRelocated: boolean;
  confidence: number;
  analysis: string;
};

function parseOpeningLightAnchorVerdict(rawText: string): OpeningLightAnchorVerdict {
  const cleaned = String(rawText || "").replace(/```json|```/gi, "").trim();
  const jsonCandidate = cleaned.match(/\{[\s\S]*\}/)?.[0] ?? cleaned;
  const parsed = JSON.parse(jsonCandidate || "{}");

  const confidenceRaw = Number(parsed?.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0;

  return {
    openingInfilled: parsed?.openingInfilled === true,
    openingRemoved: parsed?.openingRemoved === true,
    openingRelocated: parsed?.openingRelocated === true,
    confidence,
    analysis: typeof parsed?.analysis === "string" ? parsed.analysis.trim().slice(0, 160) : "",
  };
}

async function runOpeningLightAnchorMicroCheck(
  beforeImageUrl: string,
  afterImageUrl: string
): Promise<OpeningLightAnchorVerdict | null> {
  const ai = getGeminiClient();
  const before = toBase64(beforeImageUrl).data;
  const after = toBase64(afterImageUrl).data;

  const prompt = `You are a fast structural opening spot-check validator.

Compare BEFORE vs AFTER for architectural opening infill.

GLOBAL LIGHT ANCHOR RULE:
Identify the primary exterior light-source opening in BEFORE
(large window/sliding door/glazed opening).

If in AFTER that region is no longer penetrative and appears as continuous wall,
or is replaced by decor/artwork/artificial light (lamp), set openingInfilled=true.

Do NOT treat as valid occlusion when the wall plane behind foreground objects
becomes continuous and opaque where an opening existed.

LEFT-TO-RIGHT WALL SEQUENCE RULE:
Compare opening sequence across each visible wall from left to right.
If an opening token disappears and the sequence becomes wall-continuous,
set openingRemoved=true (and openingInfilled=true when appropriate).

Return JSON only:
{
  "openingInfilled": boolean,
  "openingRemoved": boolean,
  "openingRelocated": boolean,
  "confidence": number,
  "analysis": "short reason"
}`;

  const response = await (ai as any).models.generateContent({
    model: OPENING_LIGHT_ANCHOR_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          { text: "IMAGE_BEFORE:" },
          { inlineData: { mimeType: "image/webp", data: before } },
          { text: "IMAGE_AFTER:" },
          { inlineData: { mimeType: "image/webp", data: after } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      topP: 0,
      maxOutputTokens: 180,
      responseMimeType: "application/json",
    },
  });

  const rawText = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  try {
    return parseOpeningLightAnchorVerdict(rawText);
  } catch {
    return null;
  }
}

export async function runOpeningValidator(
  beforeImageUrl: string,
  afterImageUrl: string,
  baseline?: StructuralBaseline | null
): Promise<OpeningValidatorResult> {
  if (baseline && Array.isArray(baseline.openings) && baseline.openings.length > 0) {
    const deterministic = await validateOpeningPreservation(baseline, afterImageUrl);
    const relocationDetected = detectRelocation(baseline, deterministic.detectedOpenings || []);
    const baselineById = new Map((baseline.openings || []).map((opening) => [String(opening.id), opening]));
    const detectedById = new Map((deterministic.detectedOpenings || []).map((opening) => [String(opening.id), opening]));

    let strictDoorOcclusionFail = false;
    let strictWindowOcclusionFail = false;

    for (const baseOpening of baseline.openings || []) {
      const matchedOpening =
        detectedById.get(String(baseOpening.id)) ||
        (deterministic.detectedOpenings || []).find((candidate) =>
          candidate.type === baseOpening.type &&
          candidate.wallIndex === baseOpening.wallIndex &&
          candidate.horizontalBand === baseOpening.horizontalBand
        );

      if (!matchedOpening) continue;

      const baseArea = Math.max(0.01, Number(baseOpening.area_pct || 0));
      const detectedArea = Math.max(0.01, Number(matchedOpening.area_pct || 0));
      const retention = detectedArea / baseArea;

      // Non-window openings (doors/closets/walkthroughs) must remain fully functional.
      // Any notable apparent occlusion/size loss is treated as hard fail.
      if (baseOpening.type !== "window") {
        if (retention < 0.9) {
          strictDoorOcclusionFail = true;
        }
      } else {
        // Window partial occlusion can be tolerated only when clearly partial.
        // Near-full occlusion is treated as structural failure.
        if (retention < 0.55) {
          strictWindowOcclusionFail = true;
        }
      }
    }

    const areaDelta = Number.isFinite(deterministic.summary.semanticOpeningAreaDeltaPct)
      ? Number(deterministic.summary.semanticOpeningAreaDeltaPct)
      : 0;
    const openingResizeHardFail = areaDelta >= 0.3;
    const openingResizeAdvisory = deterministic.summary.openingResized && areaDelta > 0 && areaDelta < 0.3;
    let hardFail =
      deterministic.summary.openingRemoved ||
      deterministic.summary.openingSealed ||
      deterministic.summary.openingRelocated ||
      deterministic.summary.openingClassMismatch ||
      deterministic.summary.openingBandMismatch ||
      relocationDetected ||
      openingResizeHardFail ||
      strictDoorOcclusionFail ||
      strictWindowOcclusionFail;

    const reasonParts: string[] = [];
    const advisorySignals: string[] = [];
    if (deterministic.summary.openingRemoved) reasonParts.push("opening_removed");
    if (deterministic.summary.openingRelocated || relocationDetected) reasonParts.push("opening_relocated");
    if (deterministic.summary.openingResized) {
      reasonParts.push("opening_resized");
      if (openingResizeAdvisory) {
        advisorySignals.push(`opening_resized_minor:${areaDelta.toFixed(3)}`);
      }
      if (openingResizeHardFail) {
        reasonParts.push(`opening_resize_ge_0_30:${areaDelta.toFixed(3)}`);
      }
    }
    if (deterministic.summary.openingClassMismatch) reasonParts.push("opening_class_mismatch");
    if (deterministic.summary.openingBandMismatch) reasonParts.push("opening_band_mismatch");
    if (strictDoorOcclusionFail) reasonParts.push("door_or_closet_partial_occlusion_not_allowed");
    if (strictWindowOcclusionFail) reasonParts.push("window_occlusion_exceeds_partial_threshold");

    const microCheckRisk =
      !hardFail && (
        deterministic.summary.openingResized ||
        areaDelta >= 0.2 ||
        strictWindowOcclusionFail ||
        strictDoorOcclusionFail
      );

    if (microCheckRisk) {
      const micro = await runOpeningLightAnchorMicroCheck(beforeImageUrl, afterImageUrl);
      if (micro && micro.confidence >= 0.8 && (micro.openingInfilled || micro.openingRemoved || micro.openingRelocated)) {
        hardFail = true;
        reasonParts.push(
          micro.openingInfilled
            ? "light_anchor_opening_infilled"
            : micro.openingRemoved
              ? "light_anchor_opening_removed"
              : "light_anchor_opening_relocated"
        );
        advisorySignals.push(`light_anchor_microcheck_confidence:${micro.confidence.toFixed(3)}`);
        if (micro.analysis) {
          advisorySignals.push(`light_anchor_microcheck_analysis:${micro.analysis.replace(/\|/g, "/")}`);
        }
      }
    }

    if (reasonParts.length === 0) reasonParts.push("openings_preserved");

    return {
      status: hardFail ? "fail" : "pass",
      reason: reasonParts.join("|"),
      confidence: deterministic.summary.confidence,
      hardFail,
      advisorySignals,
    };
  }

  const ai = getGeminiClient();
  const before = toBase64(beforeImageUrl).data;
  const after = toBase64(afterImageUrl).data;

  const prompt = `You are validating whether two images represent the exact same physical room architecture.

Compare the BASELINE image and the STAGED image.

GLOBAL RULE
The staged image must represent the exact same physical room architecture as the baseline image.
Furniture, decor, and staging objects may change.
Architectural structure may NOT change.

OPENING RULE (CRITICAL)
Treat windows, doors, sliding doors, closet doors, archways, balcony openings, and hallway openings as structural voids in wall planes.
If an architectural opening exists in the baseline image, it must remain visible in the staged image in approximately the same size and position.

Opening Verification Step (Required)
First identify all architectural openings present in
the baseline image.

These may include:
* windows
* doors
* closet doors
* sliding doors
* hallway openings
* archways
* balcony openings
* passage openings

For each opening identified in the baseline image,
verify that the same opening still exists in the
staged image.

Opening inventory step (internal reasoning):
Before making a decision, identify all architectural openings visible in the baseline image.

Architectural openings include:
windows, doors, sliding doors, closet doors, archways, balcony openings, and hallway openings.

For each opening determine:
* type (window, door, closet door, etc.)
* approximate position on the wall (left/center/right or relative to wall corners)
* approximate width relative to the wall
* approximate height relative to the wall

Then verify that each of those same openings still exists in the staged image in approximately the same location and size.

Verification step:
For each opening identified in the baseline inventory, explicitly verify whether the same opening is visible in the staged image.
If any baseline opening cannot be located or is replaced by continuous wall surface, the staged image must fail.

Missing Opening Rule
If any baseline opening cannot be located in the
staged image, the image must fail.

An opening is considered missing if:
* it is replaced by continuous wall surface
* it is sealed, filled, or walled over
* it disappears behind furniture with no visible
  opening geometry remaining

Opening invariant rule:
If any architectural opening from the baseline inventory:
* disappears
* becomes continuous wall surface
* becomes sealed or infilled
* changes width or height significantly
* relocates on the wall
* is replaced by a different type of opening
then set ok=false.

Occlusion handling:
Windows, doors, sliding doors, and closet openings may be partially occluded by furniture, decor, or curtains introduced during staging.
This is acceptable if the opening frame, position, and surrounding wall geometry still indicate that the opening exists.
Do NOT fail when an opening is partially hidden by furniture.
Fail ONLY when the opening itself disappears structurally, becomes wall, is sealed, resized, or relocated.

Occlusion Rule
Furniture or decor may partially block an opening.

However the opening must still be visually detectable
in the wall geometry.

Acceptable occlusion:
* bed covering lower portion of a window
* sofa partially covering doorway edge
* decor partially blocking a closet door

Unacceptable occlusion:
* furniture completely covering the opening region
* the opening cannot be located visually
* the region appears as continuous flat wall

If the baseline opening cannot be located because it is
fully hidden by furniture or appears replaced by wall
surface, assume the opening has been removed and
return ok=false.

PARTIAL OPENING DETECTION (CRITICAL)

If any portion of a window frame, door frame, sliding door frame,
or doorway opening is visible in the baseline image,
the validator must treat the opening as present.

Even if the opening is partially cropped by the camera frame,
the visible portion of the opening must remain visible
in the staged image.

If the visible edges of that opening disappear,
or are replaced by continuous wall surface,
the opening has been removed and the image must fail.

Do NOT assume the rest of the opening exists outside the frame.

EDGE-FRAME OPENING DETECTION (CRITICAL)

Architectural openings may appear partially at the edge of the camera frame.

If any portion of a window frame, door frame, sliding door frame,
or doorway boundary touches the image edge in the baseline image,
the validator must treat this as evidence that the opening continues
outside the camera view.

The validator must assume the opening extends beyond the frame
unless strong evidence proves otherwise.

Edge indicators of an opening include:

* vertical door frame touching the image edge
* horizontal window sill touching the image edge
* partial closet door frame cut off by the camera border
* doorway trim partially visible at the image boundary
* visible opening depth leading into another space

If these edge indicators exist in the baseline image,
the staged image must preserve the same visible boundary.

Return ok=false if:

* the edge frame disappears
* the edge frame becomes continuous wall
* the opening boundary becomes flat wall surface
* the visible edge of the opening shrinks or is replaced by furniture

Do NOT assume the opening disappears simply because
the camera cropped it.

If the baseline shows frame evidence at the image edge,
the staged image must show the same frame evidence.

OPENING BOUNDARY PRESERVATION

For every architectural opening detected in the baseline image
(window, door, closet door, sliding door, hallway opening):

1. Identify the visible edges of the opening.
2. Compare those edges in the staged image.

Return ok=false if any of the following occur:

* opening edges disappear
* opening edges move closer together
* wall surface replaces part of the opening
* the opening width decreases
* the opening height decreases
* the opening shape changes

All architectural openings must preserve their visible boundaries.

VERTICAL EDGE INVARIANT (CRITICAL)

For each doorway-like opening (door, closet door, sliding door, walkthrough),
identify the left and right vertical boundary lines in BASELINE.

If any required vertical boundary line terminates, fades into, or disappears
into continuous flat wall surface in STAGED, treat this as infill/removal
and return ok=false.

If a doorway appears partially hidden but no vertical frame boundary remains
visible on either side, this is NOT valid occlusion. It is structural removal.

WINDOW GEOMETRY PRESERVATION (CRITICAL)

If a window is visible in the baseline image,
its approximate width and height relative to the wall
must remain consistent.

Fail the validation if the staged image shows:

* window width reduced
* window height reduced
* window geometry altered
* window edges moved closer together
* window converted into a narrow slot window
* window partially replaced by wall surface
* window shape materially altered

Even moderate reductions in window width or height
should be treated as structural modification.

Furniture placement must NEVER cause windows to shrink.

FURNITURE OCCLUSION RULE

Furniture may partially block an opening,
but it must not alter the geometry of the opening.

If furniture appears to reduce the visible size
of a window or doorway, assume the opening
has been structurally modified.

In this situation return ok=false.

STRICT OCCLUSION POLICY (MANDATORY)

- Full occlusion of any opening (window, door, closet door, walkthrough) = FAIL.
- Occlusion by artwork, wall art, mirrors, decor objects, or decorative panels = FAIL.
- Partial occlusion by large furniture is allowed ONLY for windows.
- Partial occlusion of doors, closet doors, sliding doors, or walkthrough openings by furniture = FAIL.
- Even when partial window occlusion is present, the opening must remain clearly visible and fully functional.

OCCLUSION VS REPLACEMENT (MANDATORY)

Furniture or artwork may sit IN FRONT of an opening, but must never become
the wall itself.

If an object is flush against a region that was an opening in BASELINE,
and the frame/boundary of that opening is no longer visible on any side
of the object, this is replacement/infill, not occlusion.

In that case return ok=false.

SPATIAL ANCHOR VALIDATION (MANDATORY)

Use stable structural openings as anchors (for example a sliding glass door,
large exterior window, or fixed doorway).

Compare relative spacing from those anchors to nearby openings.
If anchor-to-opening spacing increases because an intermediate opening
disappears or becomes wall, return ok=false.

Do not excuse this as perspective drift when anchor geometry is preserved.

GLOBAL LIGHT ANCHOR (MANDATORY)

Identify the primary external light-source opening in BASELINE
(for example a sliding glass door or dominant exterior window).

If that region in STAGED is no longer a penetrative opening and appears as:
- continuous wall,
- wall-mounted decor/artwork,
- or an artificial light source substitute (lamp/sconce),
then this is opening infill/removal and must FAIL.

An opening is not validly occluded when the wall plane behind foreground
objects becomes continuous and opaque across the previous opening boundary.

LEFT-TO-RIGHT OPENING SEQUENCE (MANDATORY)

For each visible wall, compare architectural token order from left to right.
Example tokenization:
BEFORE: [Sliding Door] -> [Wall + AC] -> [Internal Doorway] -> [Corner]
AFTER:  [Solid Wall]   -> [Wall + AC] -> [Internal Doorway] -> [Corner]

If the ordered sequence changes because an opening token is replaced by
continuous wall, return ok=false.

Closet-door strictness:
Closet doors/openings may not disappear or be replaced by wall surface.
Any occlusion by artwork or decor is not allowed.
Large furniture covering any meaningful part of a closet opening should be treated as suspicious and fail unless the closet opening remains clearly and fully evidenced.

Set ok=false if ANY opening or built-in invariant is violated:
* window opening removed, added, resized, relocated, blocked, sealed, or infilled
* window opening replaced by continuous wall surface
* door/sliding-door opening removed, added, resized, relocated, sealed, or walled over
* closet door or closet opening removed, added, resized, relocated, sealed, hidden by walling, or replaced by flat wall
* doorway/archway/hallway opening disappears or becomes wall
* any baseline opening disappears or is materially transformed into solid wall
* built-ins moved/resized/removed/added (built-in cabinetry, kitchen islands, fireplaces, wall shelving, recessed wall units)

Perspective/cropping differences are allowed ONLY when all baseline openings remain present and consistent.

Ignore:
* movable furniture/decor changes
* lighting/color/rendering differences
* temporary occlusions caused by staging objects when opening geometry is still clearly preserved

Return JSON only:
{
  "ok": true|false,
  "reason": "short explanation",
  "confidence": 0.0-1.0,
  "openingRemoved": true|false,
  "openingRelocated": true|false,
  "openingInfilled": true|false,
  "openingResized": true|false,
  "analysis": "short structural analysis",
  "openingCount": { "before": number, "after": number },
  "detectedOpenings": [
    {
      "type": "window|door|closet_door|walkthrough|unknown",
      "position": "brief location text",
      "status": "preserved|occluded|removed|infilled|relocated|resized"
    }
  ]
}`;

  const runWithModel = async (model: string): Promise<OpeningValidatorResult> => {
    const response = await (ai as any).models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { text: "IMAGE_BEFORE:" },
            { inlineData: { mimeType: "image/webp", data: before } },
            { text: "IMAGE_AFTER:" },
            { inlineData: { mimeType: "image/webp", data: after } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        topP: 0,
        maxOutputTokens: 256,
        responseMimeType: "application/json",
      },
    });

    const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return parseOpeningResult(text);
  };

  try {
    const flashResult = await runWithModel(OPENING_MODEL_PRIMARY);
    /*
    Flash FAIL is trusted immediately because it normally
    indicates an obvious architectural violation.
    */
    if (flashResult.status === "fail") {
      return flashResult;
    }

    /*
    Flash PASS must always be verified by Pro because Flash
    can miss subtle geometry changes (window shrink,
    opening boundary movement, etc.)
    */
    const proResult = await runWithModel(OPENING_MODEL_ESCALATION);
    return proResult;
  } catch (error: any) {
    throw new Error(`validator_error_opening:${error?.message || String(error)}`);
  }
}
