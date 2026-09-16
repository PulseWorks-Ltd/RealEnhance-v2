// Fireplace occlusion check — the missing enforcement for the fireplace-loss
// investigation (job_5671358c, a living room with a fireplace and a TV
// bracket mounted directly above it).
//
// GAP THIS CLOSES: the existing fixture-occlusion mechanism
// (occlusionVsRemovalCheck.ts's combineOcclusionAnswer, used by
// fixtureFlooringValidator.ts for all 9 AnchorFixtureTypes) explicitly and
// deliberately treats PARTIAL occlusion by new furniture as an acceptable
// PASS — its own system instruction (FIXTURE_SYSTEM_INSTRUCTION,
// fixtureFlooringValidator.ts) uses "a fireplace hearth with a plant placed
// in front of part of it is normal staging, not a violation" as the
// canonical acceptable example, and the underlying rule
// (isOcclusion -> altered:false) only fails when a fixture is COMPLETELY
// covered with nothing peeking out. That's the right tolerance for most of
// the other 8 fixture types (a kitchen island edge behind a bar stool, a
// staircase partly behind a plant), but for a fireplace specifically it
// means a sofa or media console placed directly in front of the firebox —
// exactly the reported failure mode — passes validation today as long as
// some sliver of the mantel or hearth is still visible.
//
// This module asks a narrower, fireplace-specific question instead: not
// "is the fireplace still present at all" (the existing check's job, left
// alone), but "is the firebox opening itself blocked by a FURNITURE-class
// object" — explicitly distinguishing small decor (a plant, fire tools, a
// basket — still fine, matching the existing check's own tolerance) from a
// sofa/chair/media unit placed directly in front of it (not fine).
//
// DESIGN: standalone, isolated module (following doorAccessClearanceCheck.ts's
// pattern) rather than editing combineOcclusionAnswer directly — that
// function is shared by all 9 AnchorFixtureTypes plus every opening-side
// caller (openingEnvelopeValidator, fabricatedOpeningCheck,
// flooringBoundaryCheck, windowArtworkCheck, vanishedLandmarkCheck,
// doorAccessClearanceCheck all import from occlusionVsRemovalCheck.ts) — a
// regression there risks breaking fixture types that work fine today. An
// isolated module can be enabled/rolled back independently, with zero
// blast radius on the other 8 types.
//
// ROLLOUT: follows this codebase's established discipline for a brand-new,
// unproven check (see doorAccessClearanceCheckBlocking in
// validatorModelCall.ts, and stage1AExteriorHallucinationCheckBlocking from
// the "Enhance Exterior Outlook" work earlier this session) — ships gated
// behind its own independent flag (fireplaceOcclusionCheckBlocking, default
// false / advisory-only). This is the textbook case for that convention:
// it can newly fail jobs that pass today under the existing tolerant check,
// and it's the same class of unproven spatial-obstruction judgment those
// other checks were gated for.
import { callValidatorModel } from "./validatorModelCall";
import type { AnchorFixture } from "./openingPreservationValidator";

const FIREPLACE_OCCLUSION_CHECK_MODEL = String(process.env.FIREPLACE_OCCLUSION_CHECK_MODEL || "gemini-2.5-flash");
const FIREPLACE_OCCLUSION_CHECK_TIMEOUT_MS = Math.max(0, Number(process.env.FIREPLACE_OCCLUSION_CHECK_TIMEOUT_MS || 45000));
const FIREPLACE_OCCLUSION_MIN_CONFIDENCE = Math.max(0, Math.min(1, Number(process.env.FIREPLACE_OCCLUSION_MIN_CONFIDENCE ?? 0.7)));

export function fireplaceOcclusionCheckBlocking(): boolean {
  return String(process.env.FIREPLACE_OCCLUSION_CHECK_BLOCKING || "false").trim().toLowerCase() === "true";
}

export type FireplaceOcclusionObservation = {
  fireplaceId: string;
  hearthVisible: "yes" | "no" | "cannot_tell";
  fireboxOpeningVisible: "yes" | "no" | "cannot_tell";
  coveringObjectType: "none" | "small_decor" | "furniture" | "cannot_tell";
  coveringObjectDescription: string;
  confidence: number;
};

function buildBatchPrompt(items: { id: string; semanticRef: string }[]): string {
  const itemList = items.map((it) => `- fireplaceId: "${it.id}" — find this fireplace: ${it.semanticRef}`).join("\n");
  return `You will be shown two photos of the same room, taken moments apart:
- BEFORE: the original, unedited photo.
- AFTER: the same photo after an automated virtual-staging pass added furniture and decor.

Below is a list of fireplaces from the BEFORE photo, each with its own fireplaceId:

${itemList}

For EACH fireplace listed above, look at the AFTER photo and independently answer:

1. hearthVisible — Is the fireplace's hearth/surround (the mantel, tiled or masonry surround, base) still visible in AFTER? Answer "yes", "no" (completely hidden with nothing visible), or "cannot_tell".
2. fireboxOpeningVisible — Is the firebox opening itself (the actual dark opening where a fire would burn) still visible and not blocked in AFTER? Answer "yes", "no" (blocked/covered), or "cannot_tell".
3. coveringObjectType — If anything in AFTER is positioned in front of or overlapping the fireplace that was not there in BEFORE, classify it: "none" (nothing new is in front of it), "small_decor" (a plant, a vase, fire tools, a small basket, candles, books — small items that a real stager would place ON or beside a hearth without blocking it), "furniture" (a sofa, chair, ottoman, media console, TV stand, coffee table, or any other seating/furniture-class item positioned in front of or overlapping the firebox opening), or "cannot_tell".
4. coveringObjectDescription — Briefly describe what (if anything) is in front of the fireplace in AFTER. If nothing, say so plainly.
5. confidence — Your certainty in this specific judgment, from 0 to 1.

Respond with ONLY a single valid JSON object:
{
  "items": [
    { "fireplaceId": string, "hearthVisible": "yes" | "no" | "cannot_tell", "fireboxOpeningVisible": "yes" | "no" | "cannot_tell", "coveringObjectType": "none" | "small_decor" | "furniture" | "cannot_tell", "coveringObjectDescription": string, "confidence": number }
  ]
}
One entry per fireplace listed above, in the same order, matching fireplaceId exactly.`;
}

async function observeFireplaceOcclusionBatch(params: {
  beforePath: string;
  afterPath: string;
  items: { id: string; semanticRef: string }[];
  ctx: { jobId: string; imageId: string; attempt?: number; callLabel: string };
}): Promise<FireplaceOcclusionObservation[]> {
  const raw = await callValidatorModel({
    images: [
      { path: params.beforePath, label: "BEFORE (original photo):" },
      { path: params.afterPath, label: "AFTER (staged photo):" },
    ],
    systemInstruction: "You are a careful visual inspector checking whether a fireplace remains genuinely visible and unblocked after a room was virtually staged with furniture.",
    userPrompt: buildBatchPrompt(params.items),
    model: FIREPLACE_OCCLUSION_CHECK_MODEL,
    reasonPrefix: "fireplace_occlusion",
    timeoutMs: FIREPLACE_OCCLUSION_CHECK_TIMEOUT_MS,
    ctx: params.ctx,
  });
  const tristate = ["yes", "no", "cannot_tell"];
  const coveringTypes = ["none", "small_decor", "furniture", "cannot_tell"];
  const items: any[] = Array.isArray(raw?.items) ? raw.items : [];
  return items.map((it) => ({
    fireplaceId: String(it?.fireplaceId || ""),
    hearthVisible: tristate.includes(it?.hearthVisible) ? it.hearthVisible : "cannot_tell",
    fireboxOpeningVisible: tristate.includes(it?.fireboxOpeningVisible) ? it.fireboxOpeningVisible : "cannot_tell",
    coveringObjectType: coveringTypes.includes(it?.coveringObjectType) ? it.coveringObjectType : "cannot_tell",
    coveringObjectDescription: typeof it?.coveringObjectDescription === "string" ? it.coveringObjectDescription : "",
    confidence: typeof it?.confidence === "number" && Number.isFinite(it.confidence) ? Math.max(0, Math.min(1, it.confidence)) : 0,
  }));
}

export type FireplaceOcclusionVerdict = {
  verdict: "fail_furniture_blocking_firebox" | "fail_fully_hidden" | "pass" | "cannot_tell";
  reason: string;
};

// Pure, deterministic, offline-testable. "cannot_tell" and low-confidence
// deliberately pass rather than fail — the same asymmetric-default judgment
// this codebase's other new-and-unproven checks use (see
// evaluateDoorAccessClearance in doorAccessClearanceCheck.ts): an ambiguous
// read should never be the sole basis for a hard-fail on a brand-new,
// uncalibrated check.
export function evaluateFireplaceOcclusion(observation: FireplaceOcclusionObservation): FireplaceOcclusionVerdict {
  if (observation.confidence < FIREPLACE_OCCLUSION_MIN_CONFIDENCE) {
    return { verdict: "cannot_tell", reason: `confidence ${observation.confidence.toFixed(2)} below ${FIREPLACE_OCCLUSION_MIN_CONFIDENCE} threshold — not used as a basis for failure` };
  }
  if (observation.hearthVisible === "no" && observation.fireboxOpeningVisible === "no") {
    return { verdict: "fail_fully_hidden", reason: `fireplace fully hidden in AFTER: ${observation.coveringObjectDescription}` };
  }
  if (observation.fireboxOpeningVisible === "no" && observation.coveringObjectType === "furniture") {
    return {
      verdict: "fail_furniture_blocking_firebox",
      reason: `firebox opening blocked by a furniture-class object: ${observation.coveringObjectDescription}`,
    };
  }
  return {
    verdict: "pass",
    reason: `hearthVisible=${observation.hearthVisible} fireboxOpeningVisible=${observation.fireboxOpeningVisible} coveringObjectType=${observation.coveringObjectType} — not a furniture-blocking-firebox failure (small decor or nothing in front is expected, acceptable staging)`,
  };
}

export type FireplaceOcclusionItemResult = {
  fireplaceId: string;
  description: string;
  verdict: FireplaceOcclusionVerdict["verdict"] | "error";
  reason: string;
};

// Orchestration — mirrors doorAccessClearanceCheck.ts's
// runDoorAccessClearanceCheckForOpenings exactly: one batched call
// (skipped entirely if there are no fireplaces), evaluates each item via
// the pure function above, wrapped in a single try/catch so any failure
// degrades to a safe "error" verdict for every item in this batch — never
// propagating to the caller's own Promise.all. Runs BEFORE vs. AFTER
// (unlike the door check, which only looks at the staged image) since the
// question here is specifically about what staging ADDED, not the staged
// image's own standalone plausibility.
export async function runFireplaceOcclusionCheck(
  fireplaces: AnchorFixture[],
  beforePath: string,
  afterPath: string,
  ctx: { jobId: string; imageId: string; attempt?: number }
): Promise<FireplaceOcclusionItemResult[]> {
  const items = (fireplaces || []).filter((f) => f.type === "fireplace");
  if (items.length === 0) return [];

  try {
    const refs = items.map((it) => ({
      id: it.id,
      semanticRef: it.description || "a fireplace",
    }));
    const observations = await observeFireplaceOcclusionBatch({
      beforePath,
      afterPath,
      items: refs,
      ctx: { ...ctx, callLabel: "batch" },
    });
    const byId = new Map(observations.map((o) => [o.fireplaceId, o]));
    return items.map((it) => {
      const obs =
        byId.get(it.id) ||
        ({ fireplaceId: it.id, hearthVisible: "cannot_tell", fireboxOpeningVisible: "cannot_tell", coveringObjectType: "cannot_tell", coveringObjectDescription: "", confidence: 0 } as FireplaceOcclusionObservation);
      const verdict = evaluateFireplaceOcclusion(obs);
      return { fireplaceId: it.id, description: it.description || "fireplace", verdict: verdict.verdict, reason: verdict.reason };
    });
  } catch (e: any) {
    console.log(
      JSON.stringify({
        event: "NEW_VALIDATOR_CHECK_ERROR",
        check: "fireplace_occlusion",
        jobId: ctx.jobId,
        imageId: ctx.imageId,
        attempt: ctx.attempt,
        error: String(e?.message || e),
      })
    );
    return items.map((it) => ({ fireplaceId: it.id, description: it.description || "fireplace", verdict: "error", reason: `check failed, degraded to non-blocking: ${String(e?.message || e)}` }));
  }
}
