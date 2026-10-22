// New, independent signal, user-proposed: furniture positioned such that it
// physically blocks access to a door/closet-door/walkthrough is itself
// implausible staging — a human stager would not place furniture directly
// across an opening that needs to be walked through or opened, regardless
// of whether the opening itself can still be confirmed present via a
// structural trace. This sidesteps the present/occluded/absent ambiguity
// entirely: it doesn't ask "is the item still there," it asks "does this
// furniture arrangement make functional sense," which is answerable from
// the staged photo alone.
//
// Deliberately distinct from mere visual occlusion (can't fully see the
// item in the photo) — the question is PHYSICAL ACCESS (can a person reach
// and operate this opening), which is a different, stricter bar. A low
// dresser positioned beside/below a sliding closet door might still leave
// the door's own operable path clear even though it's visually "in front
// of" the item from the camera's angle; a dresser+mirror combination
// spanning the opening's entire footprint would not. This is the
// distinction being tested against Bedroom 02 (should register "blocked")
// vs. Bedroom 11 FIXED (a confirmed pass case — should register "clear" or
// at least not "blocked", or this signal would falsely break a
// already-confirmed-correct case).
import { toBase64 } from "../worker/src/utils/images";
import { grokAnalyzeImages, grokVisionModel } from "../worker/src/ai/grok";
import { resolveValidatorModel } from "../worker/src/validators/occlusionVsRemovalCheck";

// Per explicit user scoping: applies to any opening type that requires
// physical access/passage — door, closet_door, walkthrough. Does NOT apply
// to windows or fixtures (ac_unit, fireplace, built_in_cabinet,
// kitchen_island, staircase, plumbing_fixture, light_fixture, other) —
// blocking those is not a functional-access problem the way blocking a
// door/walkthrough is.
const ACCESS_TYPE_APPLICABLE = new Set(["door", "closet_door", "walkthrough"]);

export function isAccessCheckApplicable(itemType: string): boolean {
  return ACCESS_TYPE_APPLICABLE.has(String(itemType || "").toLowerCase());
}

export type AccessBlockedObservation = {
  clearanceDescription: string;
  accessBlocked: "clear" | "blocked" | "cannot_tell";
};

function buildPrompt(semanticRef: string): string {
  return `This location is expected to be an opening that provides passage between spaces (a door, closet door, or walkthrough) — specifically: ${semanticRef}

Look at THIS photo (only this one photo) at this location.

1. clearanceDescription — Describe concretely what is on the floor and in the space directly in front of, or across, this location. Is there a clear, walkable path leading to and through it, or is furniture, decor, or another object positioned in a way that would physically prevent a person from walking through it, reaching it, or operating it (opening a hinged door, sliding a panel, etc.)? Name specifically what (if anything) occupies that space and, if something does, roughly how much clearance (if any) remains — is the opening's own operable path (where it swings open, or where its sliding track runs) actually blocked, or does the furniture merely sit nearby/beside it without obstructing that path?

2. accessBlocked — Based on that description, classify as exactly one of:
   - "clear" — a person could walk to, reach, and operate this opening without first moving anything; any nearby furniture leaves its own functional path clear.
   - "blocked" — furniture or another object is positioned directly across, immediately in front of, or within the operable path of this location such that a person could NOT walk through, reach, or open/operate it without first moving that furniture. This is not how a functioning, accessible opening would realistically be staged by a human.
   - "cannot_tell" — you cannot confidently determine clearance from this photo (e.g. poor visibility, cropped out of frame).

Respond with ONLY a single valid JSON object:
{
  "clearanceDescription": "string",
  "accessBlocked": "clear" | "blocked" | "cannot_tell"
}`;
}

function extractJson(text: string): any {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

export async function observeAccessBlocked(params: {
  imagePath: string;
  semanticRef: string;
  ctx: { jobId: string; imageId: string; callLabel: string };
}): Promise<AccessBlockedObservation> {
  const loaded = toBase64(params.imagePath);
  const validatorModel = resolveValidatorModel();
  if (validatorModel !== "grok") {
    throw new Error("This test run is Grok-primary; Gemini path not implemented in this script.");
  }
  const text = await grokAnalyzeImages({
    images: [{ buffer: Buffer.from(loaded.data, "base64"), mimeType: loaded.mime, label: "Photo:" }],
    prompt: `You are a careful visual inspector judging whether a specific opening in a room photo is physically accessible or blocked by furniture placement.\n\n${buildPrompt(params.semanticRef)}`,
    jobId: params.ctx.jobId,
    imageId: params.ctx.imageId,
    reason: `access_blocked_${params.ctx.callLabel}`,
    expectJson: true,
  });
  console.log(JSON.stringify({ event: "GROK_VALIDATOR_USAGE", jobId: params.ctx.jobId, imageId: params.ctx.imageId, stage: "validator", callLabel: `access_blocked_${params.ctx.callLabel}`, model: grokVisionModel() }));
  const raw = extractJson(text);
  const stateEnum = ["clear", "blocked", "cannot_tell"];
  return {
    clearanceDescription: typeof raw?.clearanceDescription === "string" ? raw.clearanceDescription : "",
    accessBlocked: stateEnum.includes(raw?.accessBlocked) ? raw.accessBlocked : "cannot_tell",
  };
}

export type AccessBlockedVerdict = {
  verdict: "fail_access_blocked" | "not_applicable" | "pass";
  reason: string;
};

// Pure, deterministic, offline-testable. Only fires when: (a) the item type
// is one that requires physical access (door/closet_door/walkthrough), AND
// (b) the observation confidently reports "blocked". "cannot_tell" never
// fires (same conservative default as every other classifier tonight) —
// ambiguous evidence should not drive a fail.
export function evaluateAccessBlocked(itemType: string, observation: AccessBlockedObservation): AccessBlockedVerdict {
  if (!isAccessCheckApplicable(itemType)) {
    return { verdict: "not_applicable", reason: `item type "${itemType}" does not require physical access — this check does not apply` };
  }
  if (observation.accessBlocked === "blocked") {
    return { verdict: "fail_access_blocked", reason: `furniture placement physically blocks access to this ${itemType}, which is not a plausible real-world staging arrangement: "${observation.clearanceDescription}"` };
  }
  return { verdict: "pass", reason: `access classified as "${observation.accessBlocked}" — not confidently blocked: "${observation.clearanceDescription}"` };
}
