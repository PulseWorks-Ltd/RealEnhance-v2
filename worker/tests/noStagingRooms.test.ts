jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import {
  roomGetsNoStaging,
  noStagingMessage,
  roomAllowsEmptyLayout,
  roomIsLightStaging,
  wallHasDoor,
  checkNoDoorWallForBedOrSofa,
  checkRoomBrief,
  checkBedFits,
  buildRoomBriefInstruction,
} from "../src/pipeline/roomBrief";

// Every value in the app's room-type list (client batch-processor INTERIOR_ROOM_TYPES, normalised).
const APP_ROOM_TYPES = [
  "bedroom", "living_room", "dining_room", "kitchen", "kitchen_dining", "kitchen_living", "living_dining",
  "kitchen_living_dining", "study", "office", "bathroom_1", "bathroom_2", "laundry", "garage", "basement",
  "attic", "hallway", "staircase", "entryway", "closet", "pantry", "sunroom",
];

describe("every room type can be staged (owner, Nov 2026)", () => {
  it("no room type in the app's list skips staging — garages included", () => {
    for (const r of [...APP_ROOM_TYPES, "Garage", "bathroom-1", "auto", ""]) expect(roomGetsNoStaging(r)).toBe(false);
  });
  it("rooms without a full furniture plan are staged lightly", () => {
    for (const r of ["bathroom_1", "bathroom_2", "laundry", "garage", "pantry", "closet", "hallway", "staircase", "entryway"]) expect(roomIsLightStaging(r)).toBe(true);
    for (const r of ["bedroom", "living_room", "kitchen", "study", "sunroom", "basement"]) expect(roomIsLightStaging(r)).toBe(false);
  });
  it("the garage plan asks for small touches, not an empty room", () => {
    const g = buildRoomBriefInstruction("garage");
    expect(g).toMatch(/GARAGE: light staging/);
    expect(g).not.toMatch(/show it clean and empty/);
  });
  it("the no-staging message never mentions AI", () => {
    expect(noStagingMessage("garage")).not.toMatch(/\bAI\b/);
    expect(noStagingMessage("hallway")).not.toMatch(/\bAI\b/);
  });
  it("rooms that may stay empty include garages and hallways, not bedrooms", () => {
    expect(roomAllowsEmptyLayout("garage")).toBe(true);
    expect(roomAllowsEmptyLayout("hallway")).toBe(true);
    expect(roomAllowsEmptyLayout("bedroom")).toBe(false);
  });
});

describe("beds and sofas against walls with doors (owner, Nov 2026)", () => {
  const wall = (name: string, description = "", usable = true) => ({ name, description, usableForLargeFurniture: usable, partlyVisible: false });
  it("reads door walls from the planner's own wall names and descriptions", () => {
    expect(wallHasDoor(wall("the wall on the left of the photo with the entry door frame"))).toBe(true);
    expect(wallHasDoor(wall("the wall on the right with the sliding door"))).toBe(true);
    expect(wallHasDoor(wall("the wall with the built-in wardrobe", "sliding wardrobe doors"))).toBe(true);
    expect(wallHasDoor(wall("the plain wall on the left with no doors"))).toBe(false);
    expect(wallHasDoor(wall("the wall straight ahead opposite the entry door", "plain painted wall"))).toBe(false);
    expect(wallHasDoor(wall("the wall straight ahead with the window"))).toBe(false);
  });
  it("rejects a bed planned on a door wall (Harcourts Bedroom 12)", () => {
    const brief: any = {
      walls: [wall("the wall on the left of the photo with the entry door frame"), wall("the plain wall straight ahead")],
      layout: [{ item: "Single bed (0.9 m wide)", placement: "with its headboard against the wall on the left of the photo with the entry door frame, pushed away from the door" }],
      bedSpace: { bed: "single", bedsideTables: 0, wallMetres: 2, depthMetres: 3 },
    };
    expect(checkNoDoorWallForBedOrSofa(brief)).toHaveLength(1);
    expect(checkRoomBrief(brief, "bedroom").join(" ")).toMatch(/Use a wall with no door first/);
  });
  it("accepts a bed on a plain wall", () => {
    const brief: any = {
      walls: [wall("the wall on the left of the photo with the entry door frame"), wall("the plain wall straight ahead")],
      layout: [{ item: "Queen bed (1.5 m wide)", placement: "headboard against the plain wall straight ahead, centred" }],
    };
    expect(checkNoDoorWallForBedOrSofa(brief)).toHaveLength(0);
  });
  it("rejects a sofa or lounge suite on a door wall, in every living-room combination", () => {
    const brief: any = {
      walls: [wall("the wall on the left with the hallway doorway"), wall("the plain wall straight ahead")],
      layout: [
        { item: "3-seat sofa (2.1 m long)", placement: "back against the wall on the left with the hallway doorway, at the far end" },
        { item: "Lounge suite", placement: "back against the plain wall straight ahead" },
      ],
    };
    expect(checkNoDoorWallForBedOrSofa(brief)).toHaveLength(1);
    for (const r of ["living_room", "living_dining", "kitchen_living", "kitchen_living_dining"]) {
      expect(checkRoomBrief(brief, r).join(" ")).toMatch(/sofa is planned against/);
    }
  });
  it("a free-standing sofa isn't against a wall", () => {
    const brief: any = {
      walls: [wall("the wall on the left with the hallway doorway")],
      layout: [{ item: "2-seat sofa", placement: "free-standing between the living and dining areas, near the wall on the left with the hallway doorway but clear of its path" }],
    };
    expect(checkNoDoorWallForBedOrSofa(brief)).toHaveLength(0);
  });
  it("a bed may use a long plain stretch of a door wall when no door-free wall exists (Harcourts Bedroom 08)", () => {
    const brief: any = {
      walls: [wall("the plain wall on the left with the power outlet", "long plain wall with the entry door at its far end"), wall("the wall on the right with the sliding wardrobe doors")],
      layout: [{ item: "Double bed (1.4 m wide)", placement: "headboard against the plain wall on the left with the power outlet, pushed to the near end away from the entry door" }],
    };
    expect(checkNoDoorWallForBedOrSofa(brief)).toHaveLength(0);
  });
  it("never a wardrobe wall or a balcony/sliding-door wall, even as the last resort", () => {
    const wardrobe: any = {
      walls: [wall("the wall on the right with the sliding wardrobe doors"), wall("the wall on the left with the entry door")],
      layout: [{ item: "Double bed", placement: "headboard against the wall on the right with the sliding wardrobe doors" }],
    };
    expect(checkNoDoorWallForBedOrSofa(wardrobe)).toHaveLength(1);
    const balcony: any = {
      walls: [wall("the far wall with the sliding balcony door"), wall("the wall on the right with the entry door")],
      layout: [{ item: "Single bed", placement: "headboard against the far wall with the sliding balcony door, beside the glass" }],
    };
    expect(checkNoDoorWallForBedOrSofa(balcony)).toHaveLength(1);
  });
  it("a bedroom always needs a bed", () => {
    const brief: any = {
      walls: [wall("the wall on the left with the entry door"), wall("the wall on the right with the built-in wardrobe", "sliding wardrobe doors")],
      layout: [{ item: "Rug", placement: "on the open floor in the middle of the room" }],
    };
    expect(checkRoomBrief(brief, "bedroom").join(" ")).toMatch(/needs a bed/);
  });
  it("a single bed fits a 2.6 m deep room (Harcourts Bedroom 09) and narrow-room advice never points at a door wall", () => {
    expect(checkBedFits({ bedSpace: { bed: "single", bedsideTables: 1, wallMetres: 3.2, depthMetres: 2.6 } } as any)).toHaveLength(0);
    const tooDeep = checkBedFits({ bedSpace: { bed: "double", bedsideTables: 1, wallMetres: 3.2, depthMetres: 2.6 } } as any).join(" ");
    expect(tooDeep).toMatch(/never onto a wall with a door, sliding door or balcony door/);
  });
  it("the planner instructions no longer allow the door-wall stretch", () => {
    const bed = buildRoomBriefInstruction("bedroom");
    expect(bed).toMatch(/\(3\) only if neither exists, a long plain stretch of a wall that has a door/);
    expect(bed).toMatch(/A wall of wardrobe doors is never a bed wall/);
    expect(bed).toMatch(/Never turn it onto an end wall that has a door/);
    const living = buildRoomBriefInstruction("living_dining");
    expect(living).toMatch(/NEVER put a sofa, couch or lounge suite against a wall that has a door/);
  });
});
