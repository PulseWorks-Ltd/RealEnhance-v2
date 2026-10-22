// Part 2: standalone single-room dining anchor planner.
//
// Confirmed via anchorLockedStaging.ts: SUPPORTED_ROOM_TYPES = new
// Set(["bedroom"]) — there is no standalone dining (or any non-bedroom)
// anchor path in production, and the living/dining zoning+multi-anchor
// system built earlier tonight is ALSO not in production (it lives only in
// tmp/ scripts) and is architecturally the wrong tool here anyway: it
// splits ONE room into TWO zones with TWO anchors. Diningroom 01 is a
// single-purpose room with no living-zone content at all — forcing it
// through the two-zone planner would mean fabricating a nonexistent living
// zone. This is a small, direct extension of the *pattern* proven by
// planBedroomAnchor (anchorLockedStaging.ts:312-388): one real baseline
// extraction, one real wall-visibility extraction, one deterministic
// planner, no zoning step. It is NOT a copy of planBedroomAnchor's
// mechanics, because a dining table's placement convention is different
// from a bed's: a bed anchors AGAINST a wall; a dining table is
// conventionally FREESTANDING in the open floor, away from walls, with
// chair-pull-out clearance on all sides (matching the convention already
// established for the dining anchor in tonight's living/dining work).
//
// Placement heuristic (grounded in real wall-visibility + baseline data,
// not guessed): horizontal position defaults to the center of the
// visible floor span (union of all wall extents), then shifts off-center
// only if that default position would sit within a clearance radius of a
// door/walkthrough opening's swing path — reusing the identical
// clearance-check pattern already proven for the Living 10 sofa test.
// Vertical position defaults to mid-depth of the visible floor: the
// midpoint between the back wall's baseboard line and the frame's bottom
// edge, which approximates "away from the back wall, but not crowding the
// camera" without needing a dedicated floor-region extraction call.

type Point = [number, number];

function polygonBBox(polygon: Point[]) {
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

const CLEARANCE_RADIUS = 0.12;

export type DiningRoomAnchorPlan = {
  center: [number, number];
  reasoning: string[];
  clearanceOk: boolean;
};

export function planDiningRoomAnchor(baseline: any, walls: any[]): DiningRoomAnchorPlan {
  const reasoning: string[] = [];

  // Horizontal: center of the visible floor span (union of all wall extents).
  const allX = walls.flatMap((w) => w.extent.polygon.map((p: Point) => p[0]));
  const minX = Math.min(...allX);
  const maxX = Math.max(...allX);
  let tableX = minX + (maxX - minX) / 2;
  reasoning.push(`Visible floor horizontal span [${minX.toFixed(3)}, ${maxX.toFixed(3)}] across ${walls.length} walls — default center x=${tableX.toFixed(3)}.`);

  // Circulation clearance: door/walkthrough openings' swing paths must stay clear.
  const doorOpenings = (baseline.openings || []).filter((o: any) => o.type === "door" || o.type === "walkthrough");
  const conflicting = doorOpenings.filter((o: any) => {
    const doorX = (o.bbox[0] + o.bbox[2]) / 2;
    return Math.abs(tableX - doorX) < CLEARANCE_RADIUS;
  });
  if (conflicting.length > 0) {
    const avgDoorX = conflicting.reduce((s: number, o: any) => s + (o.bbox[0] + o.bbox[2]) / 2, 0) / conflicting.length;
    tableX = avgDoorX < tableX ? minX + (maxX - minX) * 0.65 : minX + (maxX - minX) * 0.35;
    reasoning.push(`Default center conflicts with circulation opening(s) [${conflicting.map((o: any) => o.id).join(", ")}] (avg x=${avgDoorX.toFixed(3)}) — shifted to x=${tableX.toFixed(3)}.`);
  } else {
    reasoning.push(`No circulation opening within ${CLEARANCE_RADIUS} of default center — table stays horizontally centered.`);
  }

  // Re-check clearance after any shift (report honestly if it still doesn't fully clear).
  const stillConflicting = doorOpenings.filter((o: any) => {
    const doorX = (o.bbox[0] + o.bbox[2]) / 2;
    return Math.abs(tableX - doorX) < CLEARANCE_RADIUS;
  });
  const clearanceOk = stillConflicting.length === 0;
  if (!clearanceOk) {
    reasoning.push(`WARNING: after shift, still within clearance radius of [${stillConflicting.map((o: any) => o.id).join(", ")}] — flagging, not silently accepting.`);
  }

  // Vertical: a wall's own polygon bottom edge is where it meets the floor
  // at its NEAREST corner (perspective-dependent), which in a room
  // photographed at an angle can sit close to the frame bottom even for
  // the back wall (confirmed on Diningroom 01's real data: wall_0's own
  // polygon bottom reaches y=0.94-0.95, which would place the table almost
  // off-frame). A more robust "back of room" reference: a non-floor-
  // touching opening (a window) on the front/back wall (wallIndex 0) —
  // its bottom edge sits safely above the true floor line without relying
  // on the wall polygon's perspective-skewed nearest corner.
  const backWindow = (baseline.openings || []).find((o: any) => o.type === "window" && o.wallIndex === 0);
  const wall0 = walls.find((w: any) => w.id === "wall_0");
  let backRefY = 0.6;
  if (backWindow) {
    backRefY = backWindow.bbox[3];
    reasoning.push(`Back-wall window ${backWindow.id} bottom edge at y=${backRefY.toFixed(3)} — used as the back-of-room depth reference (more robust than the wall polygon's perspective-skewed nearest corner).`);
  } else if (wall0) {
    backRefY = polygonBBox(wall0.extent.polygon).maxY;
    reasoning.push(`No back-wall window found — falling back to wall_0's polygon bottom edge, y=${backRefY.toFixed(3)}.`);
  } else {
    reasoning.push(`No back-wall reference found — default fallback y=${backRefY.toFixed(3)}.`);
  }
  const tableY = backRefY + (1.0 - backRefY) * 0.35;
  reasoning.push(`Table placed 35% of the remaining depth from the back-of-room reference toward the camera, y=${tableY.toFixed(3)}.`);

  return { center: [tableX, tableY], reasoning, clearanceOk };
}
