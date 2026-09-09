// Regression tests for the multi-zone room-type expansion (2026-08-29):
// kitchen_dining, kitchen_living, and (originally) multiple_living got the
// same real zoning + planMultiAnchor treatment living_dining already had.
// planMultiAnchor itself needed no changes to support a third "kitchen" or
// "secondary" purpose zone — these tests confirm that generalization holds:
// a kitchen zone is invisible to anchor selection but still correctly
// excludes its own bordering walls from living-zone anchor candidacy, and
// the new kitchen-zone-based dining-bias signal works without requiring an
// island fixture or an inferred opening signal.
//
// "multiple_living" was later replaced by "kitchen_living_dining" (real
// production gap — see anchorLockedStaging.ts's MultiZoneRoomKind header
// comment): unlike multiple_living's flexible "dining OR an ad-hoc
// secondary zone" model, kitchen_living_dining requires kitchen AND living
// AND dining, all three, every time.
import { planMultiAnchor, isRoomTypeSupportedByAnchorLockedStaging } from "../src/pipeline/anchorLockedStaging";
import type { StructuralBaseline, StructuralOpening } from "../src/validators/openingPreservationValidator";
import type { WallVisibilityWall, LivingDiningZone } from "../src/pipeline/anchorLockedStaging";

function makeWall(id: string, wallLabel: string, xRange: [number, number], openingIds: string[] = [], usableWidthFraction = 1): WallVisibilityWall {
  const [minX, maxX] = xRange;
  return {
    id,
    wallLabel,
    extent: { polygon: [[minX, 0.2], [maxX, 0.2], [maxX, 1], [minX, 1]] },
    openingIds,
    usableWidthFraction,
    usableSegments: [{ range: [0, usableWidthFraction], widthFraction: usableWidthFraction, description: "Clear wall space." }],
    confidence: 0.95,
  };
}

function makeBaseline(openings: StructuralOpening[] = []): StructuralBaseline {
  return { openings, anchorFixtures: [] } as StructuralBaseline;
}

function makeZone(id: string, purpose: LivingDiningZone["purpose"], polygon: [number, number][], borderingWallIndices: number[], label?: string): LivingDiningZone {
  return { id, purpose, label, floorRegion: { polygon }, borderingWallIndices, reasoning: "test fixture" };
}

describe("isRoomTypeSupportedByAnchorLockedStaging — multi-zone expansion", () => {
  it("recognizes kitchen_dining, kitchen_living, and kitchen_living_dining", () => {
    expect(isRoomTypeSupportedByAnchorLockedStaging("kitchen_dining")).toBe(true);
    expect(isRoomTypeSupportedByAnchorLockedStaging("kitchen_living")).toBe(true);
    expect(isRoomTypeSupportedByAnchorLockedStaging("kitchen_living_dining")).toBe(true);
  });
});

describe("planMultiAnchor — kitchen zone generalization (kitchen_living-style)", () => {
  it("ignores a kitchen-purpose zone for anchor selection but still excludes its bordering walls from living-focal-wall candidacy", () => {
    const walls = [
      makeWall("wall_0", "Front wall", [0, 0.5]),  // shared with kitchen zone — must be excluded
      makeWall("wall_1", "Right wall", [0.5, 1]),  // living-exclusive — should win
    ];
    const kitchenZone = makeZone("zone_kitchen", "kitchen", [[0, 0.1], [0.5, 0.1], [0.5, 0.5], [0, 0.5]], [0]);
    const livingZone = makeZone("zone_living", "living", [[0, 0.5], [1, 0.5], [1, 0.9], [0, 0.9]], [0, 1]);
    const plan = planMultiAnchor(makeBaseline(), walls, [kitchenZone, livingZone]);

    expect(plan.diningPlan).toBeNull(); // no dining zone present
    expect(plan.tvPlan).not.toBeNull();
    expect(plan.tvPlan!.wallId).toBe("wall_1"); // not wall_0, which is shared with the kitchen zone
  });

  it("does not compute a dining plan for kitchen_living (no dining zone at all)", () => {
    const walls = [makeWall("wall_0", "Front wall", [0, 1])];
    const kitchenZone = makeZone("zone_kitchen", "kitchen", [[0, 0.1], [1, 0.1], [1, 0.4], [0, 0.4]], [0]);
    const livingZone = makeZone("zone_living", "living", [[0, 0.4], [1, 0.4], [1, 0.9], [0, 0.9]], [0]);
    const plan = planMultiAnchor(makeBaseline(), walls, [kitchenZone, livingZone]);
    expect(plan.diningPlan).toBeNull();
  });
});

describe("planMultiAnchor — kitchen zone as a direct dining-bias signal (kitchen_dining-style)", () => {
  it("biases the dining table toward a real kitchen zone sharing a bordering wall, with no island fixture or opening signal needed", () => {
    const walls = [makeWall("wall_0", "Kitchen-side wall", [0, 1])];
    const kitchenZone = makeZone("zone_kitchen", "kitchen", [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]], [0]);
    const diningZone = makeZone("zone_dining", "dining", [[0, 0.5], [1, 0.5], [1, 1], [0, 1]], [0]);
    const plan = planMultiAnchor(makeBaseline(), walls, [kitchenZone, diningZone]);

    expect(plan.diningPlan).not.toBeNull();
    expect(plan.diningPlan!.nearKitchen).toBe(true);
    expect(plan.diningPlan!.reasoning).toContain("directly borders the room's own extracted kitchen zone");
    // Biased away from the raw centroid (x=0.5) toward wall_0's midpoint (x=0.5 here,
    // so assert the mechanism fired via nearKitchen/reasoning rather than a numeric shift
    // that would be coincidentally zero for this symmetric fixture).
  });

  it("biases toward the kitchen zone even with no dining-bordering wall in common — falls back to no bias when zones don't share a wall", () => {
    const walls = [makeWall("wall_0", "Wall A", [0, 0.5]), makeWall("wall_1", "Wall B", [0.5, 1])];
    const kitchenZone = makeZone("zone_kitchen", "kitchen", [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]], [0]);
    const diningZone = makeZone("zone_dining", "dining", [[0.5, 0.5], [1, 0.5], [1, 1], [0.5, 1]], [1]); // no shared wall with kitchen
    const plan = planMultiAnchor(makeBaseline(), walls, [kitchenZone, diningZone]);

    expect(plan.diningPlan).not.toBeNull();
    expect(plan.diningPlan!.nearKitchen).toBeFalsy();
  });
});

describe("planMultiAnchor — generic zone-purpose handling (secondary/dining, independent of room type)", () => {
  it("computes no dining anchor when the second zone is 'secondary' (e.g. a study nook)", () => {
    const walls = [
      makeWall("wall_0", "Front wall", [0, 1]),   // living-exclusive
      makeWall("wall_1", "Back wall", [0, 1]),    // shared with the secondary zone
    ];
    const livingZone = makeZone("zone_living", "living", [[0, 0.2], [1, 0.2], [1, 0.6], [0, 0.6]], [0, 1]);
    const secondaryZone = makeZone("zone_secondary", "secondary", [[0, 0.6], [1, 0.6], [1, 1], [0, 1]], [1], "study nook");
    const plan = planMultiAnchor(makeBaseline(), walls, [livingZone, secondaryZone]);

    expect(plan.diningPlan).toBeNull();
    expect(plan.tvPlan).not.toBeNull(); // living zone's own anchor logic still runs normally
    expect(plan.tvPlan!.wallId).toBe("wall_0"); // the wall exclusive to living, not the one shared with the secondary zone
  });

  it("reuses the full dining-anchor machinery when the second zone is genuinely 'dining'", () => {
    const walls = [
      makeWall("wall_0", "Front wall", [0, 1]),   // living-exclusive
      makeWall("wall_1", "Back wall", [0, 1]),    // shared with the dining zone
    ];
    const livingZone = makeZone("zone_living", "living", [[0, 0.2], [1, 0.2], [1, 0.6], [0, 0.6]], [0, 1]);
    const diningZone = makeZone("zone_dining", "dining", [[0, 0.6], [1, 0.6], [1, 1], [0, 1]], [1]);
    const plan = planMultiAnchor(makeBaseline(), walls, [livingZone, diningZone]);

    expect(plan.diningPlan).not.toBeNull();
    expect(plan.tvPlan).not.toBeNull();
  });
});

describe("planMultiAnchor — kitchen_living_dining's mandatory three zones", () => {
  it("resolves living (tvPlan/sofaPlan) and dining anchors simultaneously when all three zones are present, with dining biased toward the real kitchen zone", () => {
    const walls = [
      makeWall("wall_0", "Kitchen wall", [0, 0.34]),   // shared with kitchen + dining
      makeWall("wall_1", "Living focal wall", [0.34, 0.67]), // living-exclusive — should win the focal wall
      makeWall("wall_2", "Side wall", [0.67, 1]),
    ];
    const kitchenZone = makeZone("zone_kitchen", "kitchen", [[0, 0], [0.34, 0], [0.34, 0.5], [0, 0.5]], [0]);
    const livingZone = makeZone("zone_living", "living", [[0.34, 0], [1, 0], [1, 0.6], [0.34, 0.6]], [1, 2]);
    const diningZone = makeZone("zone_dining", "dining", [[0, 0.5], [0.34, 0.5], [0.34, 1], [0, 1]], [0]);
    const plan = planMultiAnchor(makeBaseline(), walls, [kitchenZone, livingZone, diningZone]);

    // Living zone's own anchor logic runs normally, excluding the wall
    // shared with the kitchen zone (wall_0) from focal-wall candidacy.
    expect(plan.tvPlan).not.toBeNull();
    expect(plan.tvPlan!.wallId).toBe("wall_1");

    // Dining anchor is present and biased toward the kitchen, since a real
    // "kitchen"-purpose zone shares a bordering wall with the dining zone —
    // the same three-way interaction this room kind actually produces
    // (unlike the 2-zone tests above, which never had all three at once).
    expect(plan.diningPlan).not.toBeNull();
    expect(plan.diningPlan!.nearKitchen).toBe(true);
    expect(plan.diningPlan!.reasoning).toContain("directly borders the room's own extracted kitchen zone");
  });
});
