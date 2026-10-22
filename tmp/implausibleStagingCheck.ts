// Parts B and C of the user's latest request: two independent,
// unconditional "does this staging arrangement make real-world sense"
// checks, deliberately NOT routed through the general presence/occlusion
// logic in wallGapStructureCheck.ts or vanishedLandmarkCheck.ts — the whole
// point is a direct, hard-coded implausibility override that fires
// regardless of whether the item can otherwise be confirmed present/
// occluded/absent.
//
// B: a window's own expected location now occupied by hung artwork/a
//    painting is never a legitimate staging outcome — directly re-closes
//    the real, confirmed Living 10 gap (window replaced by a painting,
//    correctly classified "occluded" by the general logic and therefore
//    not failed, since "occluded" was deliberately made non-failing to
//    avoid the Bedroom 11 FIXED / Living 07 false-positive pattern).
// C: artwork physically mounted ON a door's own operable surface (glass
//    panes, a mirror panel, or a sliding leaf) is physically/practically
//    implausible — you cannot hang a picture on a mirror or glass pane the
//    way you would a flat wall, and anything mounted on an operable panel
//    would move with the door, which no real stager would do.
//
// Grok-only (matches tonight's default pattern; the user's explicit
// Gemini-testing ask was specifically for the access-path check in
// accessPathCheck.ts, not these two).
import { toBase64 } from "../worker/src/utils/images";
import { grokAnalyzeImages, grokVisionModel } from "../worker/src/ai/grok";
import { resolveValidatorModel } from "../worker/src/validators/occlusionVsRemovalCheck";

function extractJson(text: string): any {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

async function callGrokSingleImage(params: { imagePath: string; prompt: string; ctx: { jobId: string; imageId: string; callLabel: string } }): Promise<any> {
  const loaded = toBase64(params.imagePath);
  const validatorModel = resolveValidatorModel();
  if (validatorModel !== "grok") {
    throw new Error("This test run is Grok-primary; Gemini path not implemented for implausibleStagingCheck.ts.");
  }
  const text = await grokAnalyzeImages({
    images: [{ buffer: Buffer.from(loaded.data, "base64"), mimeType: loaded.mime, label: "Photo:" }],
    prompt: `You are a careful visual inspector checking whether a room's staging arrangement is physically plausible.\n\n${params.prompt}`,
    jobId: params.ctx.jobId,
    imageId: params.ctx.imageId,
    reason: `implausible_staging_${params.ctx.callLabel}`,
    expectJson: true,
  });
  console.log(JSON.stringify({ event: "GROK_VALIDATOR_USAGE", jobId: params.ctx.jobId, imageId: params.ctx.imageId, stage: "validator", callLabel: `implausible_staging_${params.ctx.callLabel}`, model: grokVisionModel() }));
  return extractJson(text);
}

// ── B: window replaced by artwork ──────────────────────────────────────

export function isWindowArtworkCheckApplicable(itemType: string): boolean {
  return String(itemType || "").toLowerCase() === "window";
}

export type WindowArtworkObservation = {
  locationDescription: string;
  artworkAtLocation: "yes" | "no" | "cannot_tell";
};

function buildWindowArtworkPrompt(semanticRef: string): string {
  return `Find this item: ${semanticRef}

Look at THIS photo (only this one photo) at this window's expected location.

1. locationDescription — Describe concretely what is visible at this window's expected location in THIS photo right now. Do you see actual window elements (glass panes, a frame, a sill, blinds/curtains hung for an operable window), or does something else entirely occupy that same wall area? If something else occupies it, name specifically what it is (e.g. "a large framed abstract painting hangs there") and roughly how much of the window's expected footprint it covers.

2. artworkAtLocation — Answer exactly one of: "yes" (a framed picture, painting, canvas, or similar wall art occupies most/all of THIS window's own expected footprint — not merely present somewhere else in the room), "no" (the window's own glass/frame/sill is genuinely visible there, even if partially covered by ordinary curtains/blinds — those are normal window dressings, not artwork replacing the window), "cannot_tell" (visibility is too poor to judge, or the location is cropped out of frame).

Respond with ONLY a single valid JSON object:
{
  "locationDescription": "string",
  "artworkAtLocation": "yes" | "no" | "cannot_tell"
}`;
}

export async function observeWindowArtworkReplacement(params: {
  imagePath: string;
  semanticRef: string;
  ctx: { jobId: string; imageId: string; callLabel: string };
}): Promise<WindowArtworkObservation> {
  const raw = await callGrokSingleImage({ imagePath: params.imagePath, prompt: buildWindowArtworkPrompt(params.semanticRef), ctx: params.ctx });
  const stateEnum = ["yes", "no", "cannot_tell"];
  return {
    locationDescription: typeof raw?.locationDescription === "string" ? raw.locationDescription : "",
    artworkAtLocation: stateEnum.includes(raw?.artworkAtLocation) ? raw.artworkAtLocation : "cannot_tell",
  };
}

export type WindowArtworkVerdict = {
  verdict: "fail_window_replaced_by_artwork" | "not_applicable" | "pass";
  reason: string;
};

// Pure, deterministic, offline-testable. Unconditional: fires independent
// of the general presence/occlusion logic elsewhere — that is the entire
// point of this rule.
export function evaluateWindowArtworkReplacement(itemType: string, observation: WindowArtworkObservation): WindowArtworkVerdict {
  if (!isWindowArtworkCheckApplicable(itemType)) {
    return { verdict: "not_applicable", reason: `item type "${itemType}" is not a window — this check only applies to windows` };
  }
  if (observation.artworkAtLocation === "yes") {
    return { verdict: "fail_window_replaced_by_artwork", reason: `artwork confirmed occupying the window's own expected footprint: "${observation.locationDescription}"` };
  }
  return { verdict: "pass", reason: `artworkAtLocation="${observation.artworkAtLocation}" — not confirmed artwork at the window's own location: "${observation.locationDescription}"` };
}

// ── C: artwork mounted on a door's own surface ─────────────────────────

export type DoorSurfaceType = "glass_panes" | "mirror_panel" | "sliding_panel" | "flush_solid" | "cannot_tell";

export type ArtworkOnDoorObservation = {
  doorSurfaceDescription: string;
  doorSurfaceType: DoorSurfaceType;
  mountedArtworkDescription: string;
  artworkMountedOnDoor: "yes" | "no" | "cannot_tell";
};

const DOOR_ARTWORK_TYPE_APPLICABLE = new Set(["door", "closet_door"]);
export function isArtworkOnDoorCheckApplicable(itemType: string): boolean {
  return DOOR_ARTWORK_TYPE_APPLICABLE.has(String(itemType || "").toLowerCase());
}

// Keyword scan of the baseline's own free-text description, used as one of
// two OR'd applicability sources (see evaluateArtworkOnDoorSurface) — the
// staged photo's own fresh read is the other. Both are consulted because a
// canvas hung directly over a mirror/glass door could itself obscure the
// very surface that would let a fresh look correctly classify it as
// mirror_panel/glass_panes — the baseline photo, taken before staging, has
// no such obstruction and is a reliable independent signal in exactly that
// scenario.
const SURFACE_KEYWORDS: Record<Exclude<DoorSurfaceType, "flush_solid" | "cannot_tell">, RegExp> = {
  glass_panes: /\b(glass|glazed|glazing|pane)\b/i,
  mirror_panel: /\bmirror(ed)?\b/i,
  sliding_panel: /\bslid(e|ing)\b/i,
};

function baselineIndicatesSpecialSurface(baselineDescription: string | undefined): boolean {
  const text = String(baselineDescription || "");
  return Object.values(SURFACE_KEYWORDS).some((re) => re.test(text));
}

function buildArtworkOnDoorPrompt(semanticRef: string): string {
  return `Find this item: ${semanticRef}

Look at THIS photo (only this one photo) at this door.

1. doorSurfaceDescription — Describe the door's own current visible surface in THIS photo: is it glass-paned, does it have a mirror panel, is it a sliding/pocket door, or is it a plain flush solid panel? Look directly at the photo — do not assume from any label or category name.

2. doorSurfaceType — Based on that description, classify as exactly one of: "glass_panes", "mirror_panel", "sliding_panel", "flush_solid", "cannot_tell".

3. mountedArtworkDescription — Is there any picture frame, canvas, framed print, or similar decorative panel physically attached to, hung from, or resting directly ON the door's OWN leaf/panel — something that would move with the door if it were opened or slid — as distinct from wall art on the adjacent wall beside/above the door, or furniture merely standing in front of it? Name exactly what you see and exactly where it is attached, or state plainly that nothing is mounted on the door itself.

4. artworkMountedOnDoor — Answer exactly one of: "yes" (the artwork is on the door's own operable leaf itself, not just near it), "no" (no artwork on the door's own leaf), "cannot_tell" (cannot confidently judge).

Respond with ONLY a single valid JSON object:
{
  "doorSurfaceDescription": "string",
  "doorSurfaceType": "glass_panes" | "mirror_panel" | "sliding_panel" | "flush_solid" | "cannot_tell",
  "mountedArtworkDescription": "string",
  "artworkMountedOnDoor": "yes" | "no" | "cannot_tell"
}`;
}

export async function observeArtworkOnDoorSurface(params: {
  imagePath: string;
  semanticRef: string;
  ctx: { jobId: string; imageId: string; callLabel: string };
}): Promise<ArtworkOnDoorObservation> {
  const raw = await callGrokSingleImage({ imagePath: params.imagePath, prompt: buildArtworkOnDoorPrompt(params.semanticRef), ctx: params.ctx });
  const surfaceEnum = ["glass_panes", "mirror_panel", "sliding_panel", "flush_solid", "cannot_tell"];
  const stateEnum = ["yes", "no", "cannot_tell"];
  return {
    doorSurfaceDescription: typeof raw?.doorSurfaceDescription === "string" ? raw.doorSurfaceDescription : "",
    doorSurfaceType: surfaceEnum.includes(raw?.doorSurfaceType) ? raw.doorSurfaceType : "cannot_tell",
    mountedArtworkDescription: typeof raw?.mountedArtworkDescription === "string" ? raw.mountedArtworkDescription : "",
    artworkMountedOnDoor: stateEnum.includes(raw?.artworkMountedOnDoor) ? raw.artworkMountedOnDoor : "cannot_tell",
  };
}

export type ArtworkOnDoorVerdict = {
  verdict: "fail_artwork_on_door_surface" | "not_applicable" | "pass";
  reason: string;
};

// Pure, deterministic, offline-testable. Applicability requires: item type
// is door/closet_door, AND (fresh staged-photo read OR baseline description
// text) indicates a special surface (glass/mirror/sliding) — a plain flush
// solid door is not_applicable even if artwork is somehow claimed present,
// per explicit user scoping.
export function evaluateArtworkOnDoorSurface(itemType: string, baselineDescription: string | undefined, observation: ArtworkOnDoorObservation): ArtworkOnDoorVerdict {
  if (!isArtworkOnDoorCheckApplicable(itemType)) {
    return { verdict: "not_applicable", reason: `item type "${itemType}" is not a door or closet_door — this check only applies to those` };
  }

  const freshIndicatesSpecialSurface = observation.doorSurfaceType === "glass_panes" || observation.doorSurfaceType === "mirror_panel" || observation.doorSurfaceType === "sliding_panel";
  const baselineIndicates = baselineIndicatesSpecialSurface(baselineDescription);

  if (!freshIndicatesSpecialSurface && !baselineIndicates) {
    return {
      verdict: "not_applicable",
      reason: `neither the fresh observation (doorSurfaceType="${observation.doorSurfaceType}") nor the baseline description indicates glass/mirror/sliding — a plain flush solid door has no surface this rule applies to`,
    };
  }

  if (observation.artworkMountedOnDoor === "yes") {
    return {
      verdict: "fail_artwork_on_door_surface",
      reason: `artwork confirmed mounted on the door's own operable surface (fresh doorSurfaceType="${observation.doorSurfaceType}", baselineIndicatesSpecialSurface=${baselineIndicates}): "${observation.mountedArtworkDescription}"`,
    };
  }

  return {
    verdict: "pass",
    reason: `applicable (fresh doorSurfaceType="${observation.doorSurfaceType}", baselineIndicatesSpecialSurface=${baselineIndicates}) but artworkMountedOnDoor="${observation.artworkMountedOnDoor}" — not confirmed`,
  };
}
