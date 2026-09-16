// Stage 1A "Enhance Exterior Outlook" hallucination check.
//
// GAP THIS CLOSES: the "Enhance Exterior Outlook" checkbox (payload flag
// enhanceExteriorSky) authorizes Gemini to improve the weather/sky/lighting
// of the exterior view seen through a window or door on an interior photo —
// clear clouds, remove fog/rain, brighten the sky, even replace an overcast
// sky with a generated blue one. The prompt
// (STAGE1A_SUNNY_EXTERIOR_INSTRUCTION_BLOCK, pipeline/stage1A.ts) is
// explicit that buildings, structures, civil elements, and vegetation must
// never change in any way (including colour — vegetation enhancement was
// removed from that feature entirely) — but nothing in the pipeline
// actually checks whether the model complied. Every existing window/opening
// validator (openingPreservationValidator.ts, windowValidator.ts) is
// content-blind — it checks position/size/count, never what is rendered
// inside the opening. The Stage 1A structural validator
// (stage1AValidator.ts's validateStage1AStructural) is a permanent no-op
// stub. The global content-diff check (stage1AContentDiff.ts) is a
// whole-image, non-localized metric that a small window-region change would
// not reliably trip, and is non-blocking by default anyway. This check is
// the missing enforcement: a direct, targeted before/after comparison asking
// only "did new exterior content appear through an opening that was not
// genuinely present before" — explicitly instructed to ignore only the
// sky/weather change this feature is intentionally allowed to make.
//
// DISCONNECTED (2026-09-16, user request): this module is fully built and
// typechecked but its call site in pipeline/stage1A.ts is currently gated
// off by stage1AExteriorHallucinationCheckEnabled() (default false), at the
// user's explicit request, so they can test the now-narrower (no vegetation
// touching at all) "Enhance Exterior Outlook" prompt on its own first. Flip
// STAGE1A_EXTERIOR_HALLUCINATION_CHECK_ENABLED=true to reconnect it for
// testing against a set of images before deciding whether to keep it wired
// in. Nothing else about this module needs to change to re-enable it.
//
// SCOPE: when enabled, only ever invoked when the sunny-exterior prompt
// block was actually injected for this job (checkbox on, interior scene,
// non-empty prompt) — see pipeline/stage1A.ts's
// stage1ASunnyExteriorPromptInjected. Every other Stage 1A job pays zero
// extra cost or latency for this check.
//
// Uses callValidatorModel (validatorModelCall.ts) rather than
// geminiSemanticValidator.ts's runGeminiSemanticValidator: the latter's
// Stage-1A post-processing only ever sets hardFail=true for a narrow,
// opening-geometry-specific violation taxonomy (opening_change/wall_change/
// camera_shift, or reason text containing tokens like "new window"/"wall
// added") — a hallucinated building or tree through a window matches none of
// them, so hardFail would be silently downgraded to false before this check
// ever saw it. callValidatorModel has no such contract to fight; this module
// defines its own minimal, purpose-built JSON response shape instead.
//
// ROLLOUT: follows this codebase's established discipline for a brand-new,
// unproven check (see doorAccessClearanceCheckBlocking in
// validatorModelCall.ts) — ships gated behind its own independent flag
// (stage1AExteriorHallucinationCheckBlocking, default false / advisory-only)
// rather than inheriting newValidatorChecksBlocking()'s already-earned
// "true". It should be observed against real "Enhance Exterior Outlook" jobs
// — specifically watched for false positives against the permitted sky/
// weather change — before being trusted to alter job output.
import { callValidatorModel } from "./validatorModelCall";

const STAGE1A_EXTERIOR_HALLUCINATION_CHECK_MODEL = String(process.env.STAGE1A_EXTERIOR_HALLUCINATION_CHECK_MODEL || "gemini-2.5-flash");
// A classification/audit call on two images, not image generation — kept on
// the fast tier by default since this runs on every "Enhance Exterior
// Outlook" job that actually reaches Gemini (see stage1A.ts's gating).
const STAGE1A_EXTERIOR_HALLUCINATION_CHECK_TIMEOUT_MS = Math.max(0, Number(process.env.STAGE1A_EXTERIOR_HALLUCINATION_CHECK_TIMEOUT_MS || 45000));
const STAGE1A_EXTERIOR_HALLUCINATION_MIN_CONFIDENCE = Math.max(0, Math.min(1, Number(process.env.STAGE1A_EXTERIOR_HALLUCINATION_MIN_CONFIDENCE ?? 0.75)));

export function buildStage1AExteriorHallucinationPrompt(): string {
  return `You will be shown two photos of the same interior room, taken moments apart:
- BEFORE: the original, unedited photo.
- AFTER: the same photo after an automated enhancement pass.

The enhancement pass was EXPLICITLY AUTHORISED to improve the outdoor weather, sky, and lighting visible through any existing window, door, or other opening — this is expected and must never be flagged. It was NOT authorised to invent any new exterior object, building, structure, or landscape feature that was not already present in BEFORE, and it was NOT authorised to change vegetation in any way, including its colour.

Your only task: decide whether the AFTER photo shows any exterior content, visible through a window, door, skylight, or other opening, that was NOT genuinely present in BEFORE, or vegetation that looks different from BEFORE in any way.

### EXPRESSLY PERMITTED — do not flag these
- Sky and weather changes: an overcast, grey, white, or rain-affected sky in BEFORE may become clear and blue with sunlight in AFTER. Fog, mist, haze, raindrops, and water spots on the glass may be cleared entirely. This is authorised, even though the sky's actual pixels are completely different from BEFORE.
- Visibility recovery: exterior detail that was dark, washed out, or obscured by weather in BEFORE may simply become clearly visible in AFTER — this is recovering real detail, not inventing it.
- Interior lighting changes that result from the above (e.g. more daylight spilling into the room).

### REPORT AS A FAILURE (hallucinationDetected = true) if, through any opening, AFTER shows:
- A building, house, dwelling, garage, shed, or part of one, that is not in BEFORE.
- A different building than the one in BEFORE (different shape, roofline, storey count, cladding, or window arrangement).
- A fence, wall, gate, deck, pergola, balcony, retaining wall, pool, driveway, path, road, or power line not present in BEFORE.
- A landscape feature (a hill, ridge, mountain, body of water, or horizon/skyline profile) that was not there before.
- A vehicle, boat, person, animal, or any other discrete object that was not there before.
- A tree, shrub, hedge, plant, or lawn that is newly present, or an existing one that has changed size, shape, position, species, colour, or vibrancy in any way. Vegetation must look identical to BEFORE — do not treat a greener or more vibrant appearance as an acceptable lighting side-effect; flag it.
- Exterior content present in BEFORE that has been removed or painted out in AFTER.

### HOW TO DECIDE
- Judge the existence and identity of exterior content, and the appearance of vegetation specifically — colour changes are only acceptable for the sky/weather itself, never for vegetation.
- If a difference is confined to the sky or weather condition alone, it is NOT a failure.
- If detail in BEFORE was too obscured to tell whether AFTER invented it or merely revealed it, treat it as revealed (not a failure), and lower your confidence instead.
- Only report hallucinationDetected = true when you are genuinely confident that new, different, removed, or recoloured vegetation/structural/object content is present.

Respond with ONLY a single valid JSON object:
{
  "hallucinationDetected": boolean,
  "reasons": [string],
  "confidence": number
}
Each entry in "reasons" must name the specific object or content and where it appears, e.g. "a two-storey house with a grey roof is visible through the left window; BEFORE shows only sky and a hedge there." If hallucinationDetected is false, reasons may be an empty array. confidence is your certainty in this specific judgment, from 0 to 1.`;
}

export type Stage1AExteriorHallucinationVerdict = {
  ran: boolean;
  error?: string;
  hallucinationDetected: boolean;
  reasons: string[];
  confidence: number;
  model: string;
};

// Pure, offline-testable decision step, separated from the network call so
// it can be exercised with fabricated observations at zero cost.
export function decideStage1AExteriorHallucination(observation: { hallucinationDetected: boolean; confidence: number }): boolean {
  return (
    observation.hallucinationDetected === true
    && Number.isFinite(observation.confidence)
    && observation.confidence >= STAGE1A_EXTERIOR_HALLUCINATION_MIN_CONFIDENCE
  );
}

// Independently gated (see header comment) — a brand-new, unproven check
// must earn its own "true" the same deliberate way doorAccessClearanceCheck
// did, not inherit newValidatorChecksBlocking()'s already-earned one.
export function stage1AExteriorHallucinationCheckBlocking(): boolean {
  return String(process.env.STAGE1A_EXTERIOR_HALLUCINATION_CHECK_BLOCKING || "false").trim().toLowerCase() === "true";
}

// Master on/off switch for the whole check (see this file's DISCONNECTED
// header note) — separate from and checked before stage1AExteriorHallucinationCheckBlocking,
// which only controls whether a detected hallucination is allowed to alter
// job output. This one controls whether the check runs and logs at all.
// Default false: disconnected at the user's request until they've tested
// the now vegetation-untouched "Enhance Exterior Outlook" prompt on its own
// against a set of real images.
export function stage1AExteriorHallucinationCheckEnabled(): boolean {
  return String(process.env.STAGE1A_EXTERIOR_HALLUCINATION_CHECK_ENABLED || "false").trim().toLowerCase() === "true";
}

// Fail-open on any error or timeout (network issue, malformed response,
// etc.) — a validator outage must never cost a customer their enhancement.
// Never throws.
export async function runStage1AExteriorHallucinationCheck(params: {
  beforePath: string;
  afterPath: string;
  jobId: string;
  imageId: string;
}): Promise<Stage1AExteriorHallucinationVerdict> {
  try {
    const raw = await callValidatorModel({
      images: [
        { path: params.beforePath, label: "BEFORE (original photo):" },
        { path: params.afterPath, label: "AFTER (enhanced photo):" },
      ],
      systemInstruction: "You are a careful visual inspector auditing whether an automated photo-enhancement tool invented new exterior content visible through a window or door.",
      userPrompt: buildStage1AExteriorHallucinationPrompt(),
      model: STAGE1A_EXTERIOR_HALLUCINATION_CHECK_MODEL,
      reasonPrefix: "stage1a_exterior_hallucination",
      timeoutMs: STAGE1A_EXTERIOR_HALLUCINATION_CHECK_TIMEOUT_MS,
      ctx: { jobId: params.jobId, imageId: params.imageId, callLabel: "compare" },
    });
    const confidence = typeof raw?.confidence === "number" && Number.isFinite(raw.confidence)
      ? Math.max(0, Math.min(1, raw.confidence))
      : 0;
    const reasons = Array.isArray(raw?.reasons)
      ? raw.reasons.map((r: any) => String(r || "").trim()).filter(Boolean)
      : [];
    const hallucinationDetected = decideStage1AExteriorHallucination({
      hallucinationDetected: raw?.hallucinationDetected === true,
      confidence,
    });
    return { ran: true, hallucinationDetected, reasons, confidence, model: STAGE1A_EXTERIOR_HALLUCINATION_CHECK_MODEL };
  } catch (e: any) {
    return {
      ran: false,
      error: String(e?.message || e),
      hallucinationDetected: false,
      reasons: [],
      confidence: 0,
      model: STAGE1A_EXTERIOR_HALLUCINATION_CHECK_MODEL,
    };
  }
}
