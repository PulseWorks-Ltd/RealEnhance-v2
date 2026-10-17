// Fridge-cavity insertion eligibility check.
//
// New, narrow capability (real product request, not a validator bug fix):
// Stage 2 staging is normally strictly forbidden from adding any large/
// floor-standing item to a kitchen zone — see anchorLockedStaging.ts's
// buildKitchenZoneGuardrailText. This check carves out exactly ONE
// exception to that rule: when a kitchen has a genuinely empty,
// builder-provided refrigerator cavity (flanked by cabinetry, sized and
// shaped for a full-size fridge, with nothing occupying it) and no
// refrigerator already exists anywhere else in the room, staging is
// permitted to insert exactly one refrigerator into that exact cavity.
// Every other appliance (stove, oven, rangetop, cooktop, dishwasher, etc.)
// and every other floor item remains completely locked, in every case —
// this check's result only ever ADDS the one narrow fridge exception; it
// never touches, weakens, or overrides any other kitchen-zone rule.
//
// Deliberately modeled on windowArtworkCheck.ts's shape (see that file's
// header for the fuller design rationale this codebase already
// established): one narrowly-scoped Gemini call asking a single specific
// question, a pure/offline-testable deterministic function that turns the
// observation into a verdict, and self-contained error handling that
// degrades to a safe, non-blocking result rather than throwing.
//
// Unlike windowArtworkCheck.ts (a validator-only check, consulted only
// after Stage 2 generation), this check is consumed as a PROMPT-
// CONSTRUCTION input, run against the BASELINE (pre-staging) image
// BEFORE generation — the same consumption mode anchorLockedStaging.ts's
// own kitchenSignal already uses. Its result decides whether the
// generation prompt is allowed to mention a fridge at all.
//
// Fails closed by design: any error, timeout, or ambiguous ("cannot_tell")
// read degrades to "not eligible." Inserting an unwarranted fridge (a
// structural fabrication) is a categorically worse outcome than failing
// to insert one that was actually warranted — the same risk asymmetry
// windowArtworkCheck.ts's own header documents for its stricter, one-sided
// verdict.
import { callValidatorModel } from "./validatorModelCall";

const FRIDGE_CAVITY_CHECK_MODEL = String(process.env.FRIDGE_CAVITY_CHECK_MODEL || "gemini-2.5-pro");
const FRIDGE_CAVITY_CHECK_TIMEOUT_MS = Math.max(0, Number(process.env.FRIDGE_CAVITY_CHECK_TIMEOUT_MS || 30000));

export type TriState = "yes" | "no" | "cannot_tell";

export type FridgeCavityObservation = {
  fridgeAlreadyPresent: TriState;
  fridgeAlreadyPresentDescription: string;
  cavityPresent: TriState;
  cavityDescription: string;
  cavityBbox: [number, number, number, number] | null;
};

const SYSTEM_INSTRUCTION = "You are a careful visual inspector examining a kitchen photo for a specific, narrow architectural detail.";

function buildPrompt(): string {
  return `Look at this kitchen photo and answer two independent questions.

1. fridgeAlreadyPresent — Is a refrigerator (any style: freestanding, French door, side-by-side, or a built-in/integrated panel-fronted fridge) visible ANYWHERE in this photo, in the kitchen or elsewhere in frame? Answer exactly one of: "yes", "no", "cannot_tell" (visibility too poor, or the relevant area is cropped out of frame). Describe what you see in fridgeAlreadyPresentDescription.

2. cavityPresent — Independent of question 1: is there a genuinely empty, builder-provided, appliance-sized gap in the kitchen cabinetry run — flanked by cabinetry, a countertop, or a wall on at least one side, sized and shaped for a full-size refrigerator, with nothing currently occupying it (not a fridge, not another appliance, not storage, not shelving continuing through it)? This must be a real, visually obvious gap bounded by cabinetry/wall on at least one side — do not report a cavity from a plain, continuous, unbroken run of cabinetry or wall that merely has open floor space in front of it. Answer exactly one of: "yes", "no", "cannot_tell". Describe what you see in cavityDescription, and if "yes", give its approximate bounding box in cavityBbox as [x1, y1, x2, y2] normalized 0-1 (0,0 = top-left of the photo); otherwise cavityBbox should be null.

Respond with ONLY a single valid JSON object:
{
  "fridgeAlreadyPresent": "yes" | "no" | "cannot_tell",
  "fridgeAlreadyPresentDescription": string,
  "cavityPresent": "yes" | "no" | "cannot_tell",
  "cavityDescription": string,
  "cavityBbox": [number, number, number, number] | null
}`;
}

export async function observeFridgeCavity(params: {
  imagePath: string;
  ctx: { jobId: string; imageId: string; attempt?: number; callLabel: string };
}): Promise<FridgeCavityObservation> {
  const raw = await callValidatorModel({
    images: [{ path: params.imagePath, label: "Photo:" }],
    systemInstruction: SYSTEM_INSTRUCTION,
    userPrompt: buildPrompt(),
    model: FRIDGE_CAVITY_CHECK_MODEL,
    reasonPrefix: "fridge_cavity",
    timeoutMs: FRIDGE_CAVITY_CHECK_TIMEOUT_MS,
    ctx: params.ctx,
  });
  const stateEnum: TriState[] = ["yes", "no", "cannot_tell"];
  const bboxRaw = raw?.cavityBbox;
  const bbox: [number, number, number, number] | null =
    Array.isArray(bboxRaw) && bboxRaw.length === 4 && bboxRaw.every((v: any) => typeof v === "number" && Number.isFinite(v))
      ? [bboxRaw[0], bboxRaw[1], bboxRaw[2], bboxRaw[3]]
      : null;
  return {
    fridgeAlreadyPresent: stateEnum.includes(raw?.fridgeAlreadyPresent) ? raw.fridgeAlreadyPresent : "cannot_tell",
    fridgeAlreadyPresentDescription: typeof raw?.fridgeAlreadyPresentDescription === "string" ? raw.fridgeAlreadyPresentDescription : "",
    cavityPresent: stateEnum.includes(raw?.cavityPresent) ? raw.cavityPresent : "cannot_tell",
    cavityDescription: typeof raw?.cavityDescription === "string" ? raw.cavityDescription : "",
    cavityBbox: bbox,
  };
}

export type FridgeCavityEligibility = {
  eligible: boolean;
  cavityBbox: [number, number, number, number] | null;
  reason: string;
};

// Pure, deterministic, offline-testable — the "code decides" step.
// Deliberately conservative on both axes: eligible only when the cavity is
// affirmatively confirmed ("yes", not "cannot_tell") AND no fridge is
// affirmatively confirmed present anywhere ("no" or "cannot_tell" for
// fridgeAlreadyPresent both block eligibility — "cannot_tell" here means
// we genuinely don't know, and risking a second fridge next to one we
// merely couldn't see is worse than being conservative and inserting
// none).
export function evaluateFridgeCavityEligibility(observation: FridgeCavityObservation): FridgeCavityEligibility {
  if (observation.fridgeAlreadyPresent !== "no") {
    return {
      eligible: false,
      cavityBbox: null,
      reason: `fridgeAlreadyPresent="${observation.fridgeAlreadyPresent}" (not confirmed absent): "${observation.fridgeAlreadyPresentDescription}"`,
    };
  }
  if (observation.cavityPresent !== "yes" || !observation.cavityBbox) {
    return {
      eligible: false,
      cavityBbox: null,
      reason: `no confirmed empty fridge cavity: cavityPresent="${observation.cavityPresent}" — "${observation.cavityDescription}"`,
    };
  }
  return {
    eligible: true,
    cavityBbox: observation.cavityBbox,
    reason: `confirmed empty fridge cavity, no existing fridge detected anywhere in the room: "${observation.cavityDescription}"`,
  };
}

// Orchestration: one call, self-contained error handling. Any failure
// (API error, timeout, malformed JSON) degrades to "not eligible" rather
// than throwing into the caller's prompt-building flow — never blocks
// staging, never grants insertion permission on a failure.
export async function checkFridgeCavityEligibility(
  imagePath: string,
  ctx: { jobId: string; imageId: string; attempt?: number }
): Promise<FridgeCavityEligibility> {
  try {
    const observation = await observeFridgeCavity({ imagePath, ctx: { ...ctx, callLabel: "fridge_cavity" } });
    return evaluateFridgeCavityEligibility(observation);
  } catch (e: any) {
    console.log(
      JSON.stringify({
        event: "NEW_VALIDATOR_CHECK_ERROR",
        check: "fridge_cavity",
        jobId: ctx.jobId,
        imageId: ctx.imageId,
        attempt: ctx.attempt,
        error: String(e?.message || e),
      })
    );
    return { eligible: false, cavityBbox: null, reason: `check failed, degraded to not-eligible: ${String(e?.message || e)}` };
  }
}
