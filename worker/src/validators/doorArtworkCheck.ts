// Door-surface artwork check — Part C of tmp/implausibleStagingCheck.ts,
// ported alongside windowArtworkCheck.ts's Part B (see that file's header
// for the full history of Part B's own design). Part C was explicitly left
// out of the original integration ("Part C, artwork-on-door-surface, is
// not part of this integration" — windowArtworkCheck.ts's own header
// comment). Identified as a confirmed, prototyped, unintegrated gap by the
// RealEnhance validator-scope audit (2026-08-29, finding C3): a
// glass-paned, mirror-paneled, or sliding door is structurally analogous
// to a window for this exact failure mode — artwork mounted directly on
// its own operable surface is the same "occlusion logic wrongly excuses a
// full replacement" blind spot windowArtworkCheck.ts exists to close for
// windows, and the standard occlusion-vs-removal check has the identical
// bias toward reading it as harmless occlusion rather than a violation.
//
// Deliberately scoped, per the original prototype's own explicit design:
// a PLAIN FLUSH SOLID door has no surface this rule applies to and is
// not_applicable even if something is somehow claimed mounted on it — a
// wreath or hanging decoration on an ordinary solid door is completely
// normal staging, not a violation. Applicability requires the door's own
// surface (checked from BOTH a fresh look at the staged photo AND the
// baseline's own description, since a canvas hung directly over a mirror/
// glass door could itself obscure the very surface a fresh look would need
// to correctly classify) to indicate glass/mirror/sliding.
import type { StructuralOpening } from "./openingPreservationValidator";
import { buildSemanticReference, type PickedItem } from "./semanticItemRef";
import { callValidatorModel } from "./validatorModelCall";

const DOOR_ARTWORK_CHECK_MODEL = String(process.env.WINDOW_ARTWORK_CHECK_MODEL || "gemini-2.5-pro");
const DOOR_ARTWORK_CHECK_TIMEOUT_MS = Math.max(0, Number(process.env.WINDOW_ARTWORK_CHECK_TIMEOUT_MS || 30000));

const DOOR_ARTWORK_TYPE_APPLICABLE = new Set(["door", "closet_door"]);
export function isDoorArtworkCheckApplicable(itemType: string): boolean {
  return DOOR_ARTWORK_TYPE_APPLICABLE.has(String(itemType || "").toLowerCase());
}

export type DoorSurfaceType = "glass_panes" | "mirror_panel" | "sliding_panel" | "flush_solid" | "cannot_tell";

export type DoorArtworkObservation = {
  itemId: string;
  doorSurfaceDescription: string;
  doorSurfaceType: DoorSurfaceType;
  mountedArtworkDescription: string;
  artworkMountedOnDoor: "yes" | "no" | "cannot_tell";
};

// Keyword scan of the baseline's own free-text description — one of two
// OR'd applicability sources (see evaluateArtworkOnDoorSurface). The
// baseline photo, taken before staging, has no risk of the door's own
// surface being obscured by whatever artwork may since have been mounted
// on it, so it's a reliable independent signal in exactly the scenario
// where a fresh look alone could be fooled.
const SURFACE_KEYWORDS: Record<Exclude<DoorSurfaceType, "flush_solid" | "cannot_tell">, RegExp> = {
  glass_panes: /\b(glass|glazed|glazing|pane)\b/i,
  mirror_panel: /\bmirror(ed)?\b/i,
  sliding_panel: /\bslid(e|ing)\b/i,
};

function baselineIndicatesSpecialSurface(baselineDescription: string | undefined): boolean {
  const text = String(baselineDescription || "");
  return Object.values(SURFACE_KEYWORDS).some((re) => re.test(text));
}

function buildBatchPrompt(doors: { id: string; semanticRef: string }[]): string {
  const itemList = doors.map((d) => `- itemId: "${d.id}" — find this item: ${d.semanticRef}`).join("\n");
  return `Below is a list of doors from this room's baseline photo:

${itemList}

Look at THIS photo (only this one photo — the current/staged version) at EACH door, one at a time, independently.

For EACH door listed above, answer:

1. doorSurfaceDescription — Describe the door's own current visible surface in THIS photo: is it glass-paned, does it have a mirror panel, is it a sliding/pocket door, or is it a plain flush solid panel? Look directly at the photo — do not assume from any label or category name.

2. doorSurfaceType — Based on that description, classify as exactly one of: "glass_panes", "mirror_panel", "sliding_panel", "flush_solid", "cannot_tell".

3. mountedArtworkDescription — Is there any picture frame, canvas, framed print, or similar decorative panel physically attached to, hung from, or resting directly ON the door's OWN leaf/panel — something that would move with the door if it were opened or slid — as distinct from wall art on the adjacent wall beside/above the door, or furniture merely standing in front of it? Name exactly what you see and exactly where it is attached, or state plainly that nothing is mounted on the door itself.

4. artworkMountedOnDoor — Answer exactly one of: "yes" (the artwork is on the door's own operable leaf itself, not just near it), "no" (no artwork on the door's own leaf), "cannot_tell" (cannot confidently judge).

Respond with ONLY a single valid JSON object:
{
  "doors": [
    { "itemId": string, "doorSurfaceDescription": string, "doorSurfaceType": "glass_panes" | "mirror_panel" | "sliding_panel" | "flush_solid" | "cannot_tell", "mountedArtworkDescription": string, "artworkMountedOnDoor": "yes" | "no" | "cannot_tell" }
  ]
}
One entry per door listed above, in the same order, matching itemId exactly.`;
}

export async function observeDoorArtworkBatch(params: {
  imagePath: string;
  doors: { id: string; semanticRef: string }[];
  ctx: { jobId: string; imageId: string; attempt?: number; callLabel: string };
}): Promise<DoorArtworkObservation[]> {
  const raw = await callValidatorModel({
    images: [{ path: params.imagePath, label: "Photo:" }],
    systemInstruction: "You are a careful visual inspector checking whether a room's staging arrangement is physically plausible.",
    userPrompt: buildBatchPrompt(params.doors),
    model: DOOR_ARTWORK_CHECK_MODEL,
    reasonPrefix: "door_artwork",
    timeoutMs: DOOR_ARTWORK_CHECK_TIMEOUT_MS,
    ctx: params.ctx,
  });
  const surfaceEnum = ["glass_panes", "mirror_panel", "sliding_panel", "flush_solid", "cannot_tell"];
  const stateEnum = ["yes", "no", "cannot_tell"];
  const items: any[] = Array.isArray(raw?.doors) ? raw.doors : [];
  return items.map((it) => ({
    itemId: String(it?.itemId || ""),
    doorSurfaceDescription: typeof it?.doorSurfaceDescription === "string" ? it.doorSurfaceDescription : "",
    doorSurfaceType: surfaceEnum.includes(it?.doorSurfaceType) ? it.doorSurfaceType : "cannot_tell",
    mountedArtworkDescription: typeof it?.mountedArtworkDescription === "string" ? it.mountedArtworkDescription : "",
    artworkMountedOnDoor: stateEnum.includes(it?.artworkMountedOnDoor) ? it.artworkMountedOnDoor : "cannot_tell",
  }));
}

export type DoorArtworkVerdict = {
  verdict: "fail_artwork_on_door_surface" | "not_applicable" | "pass";
  reason: string;
};

// Pure, deterministic, offline-testable — same discipline as every other
// evaluate/classify function in this file family. Applicability requires:
// item type is door/closet_door, AND (fresh staged-photo read OR baseline
// description text) indicates a special surface (glass/mirror/sliding). A
// plain flush solid door is not_applicable even if artwork is somehow
// claimed present, per the original prototype's explicit scoping.
export function evaluateArtworkOnDoorSurface(
  itemType: string,
  baselineDescription: string | undefined,
  observation: Omit<DoorArtworkObservation, "itemId">
): DoorArtworkVerdict {
  if (!isDoorArtworkCheckApplicable(itemType)) {
    return { verdict: "not_applicable", reason: `item type "${itemType}" is not a door or closet_door — this check only applies to those` };
  }

  const freshIndicatesSpecialSurface =
    observation.doorSurfaceType === "glass_panes" ||
    observation.doorSurfaceType === "mirror_panel" ||
    observation.doorSurfaceType === "sliding_panel";
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

export type DoorArtworkItemResult = {
  itemId: string;
  type: string;
  description: string;
  verdict: DoorArtworkVerdict["verdict"] | "error";
  reason: string;
};

// Orchestration — mirrors windowArtworkCheck.ts's runWindowArtworkCheckForOpenings
// exactly: filters to applicable-type openings, one batched call (skipped
// entirely if there are no doors/closet_doors), evaluates each item via the
// pure function above. Wrapped in a single try/catch so any failure
// degrades to a safe "error" verdict for every door in this batch — never
// propagating to the caller's own Promise.all.
export async function runDoorArtworkCheckForOpenings(
  openings: StructuralOpening[],
  stagedImagePath: string,
  ctx: { jobId: string; imageId: string; attempt?: number }
): Promise<DoorArtworkItemResult[]> {
  const doors = (openings || []).filter((o) => isDoorArtworkCheckApplicable(o.type));
  if (doors.length === 0) return [];

  const toPicked = (o: StructuralOpening): PickedItem => ({
    id: o.id,
    type: o.type,
    description: o.description,
    wallIndex: o.wallIndex,
    horizontalBand: o.horizontalBand,
    verticalBand: o.verticalBand,
    bbox: o.bbox,
  });

  try {
    const doorRefs = doors.map((d) => ({ id: d.id, semanticRef: buildSemanticReference(toPicked(d)) }));
    const observations = await observeDoorArtworkBatch({
      imagePath: stagedImagePath,
      doors: doorRefs,
      ctx: { ...ctx, callLabel: "batch" },
    });
    const byId = new Map(observations.map((o) => [o.itemId, o]));
    return doors.map((d) => {
      const obs =
        byId.get(d.id) ||
        ({ itemId: d.id, doorSurfaceDescription: "", doorSurfaceType: "cannot_tell", mountedArtworkDescription: "", artworkMountedOnDoor: "cannot_tell" } as DoorArtworkObservation);
      const verdict = evaluateArtworkOnDoorSurface(d.type, d.description, obs);
      return { itemId: d.id, type: d.type, description: d.description || d.type, verdict: verdict.verdict, reason: verdict.reason };
    });
  } catch (e: any) {
    console.log(
      JSON.stringify({
        event: "NEW_VALIDATOR_CHECK_ERROR",
        check: "door_artwork",
        jobId: ctx.jobId,
        imageId: ctx.imageId,
        attempt: ctx.attempt,
        error: String(e?.message || e),
      })
    );
    return doors.map((d) => ({ itemId: d.id, type: d.type, description: d.description || d.type, verdict: "error", reason: `check failed, degraded to non-blocking: ${String(e?.message || e)}` }));
  }
}
