jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import { surfaceStylingOnly } from "../src/pipeline/stage2Masked/pipeline";

// Nov 2026, Harcourts: two fitted kitchens (no island, no stools) failed every
// attempt because bench-top styling read as "floating furniture" and the bench
// edge as a moved skirting.
describe("styling that sits on benches, rails and shelves", () => {
  it("a kitchen whose plan has nothing on the floor", () => {
    expect(surfaceStylingOnly("kitchen", { layout: [] })).toBe(true);
    expect(surfaceStylingOnly("kitchen", { layout: [{ item: "Fruit bowl", placement: "on the bench by the sink" }, { item: "Small potted herb", placement: "on the windowsill" }] })).toBe(true);
  });
  it("keeps the floor checks when stools or a table are planned, or there is no plan", () => {
    expect(surfaceStylingOnly("kitchen", { layout: [{ item: "Two bar stools", placement: "at the island overhang" }] })).toBe(false);
    expect(surfaceStylingOnly("kitchen", null)).toBe(false);
    expect(surfaceStylingOnly("kitchen_dining", { layout: [] })).toBe(false);
    expect(surfaceStylingOnly("living_room", { layout: [] })).toBe(false);
  });
  it("light-staging rooms always", () => {
    expect(surfaceStylingOnly("bathroom_1", null)).toBe(true);
    expect(surfaceStylingOnly("laundry", null)).toBe(true);
  });
});

import { checkSofaPlacement } from "../src/pipeline/roomBrief";
import { livingDoorRestageHint } from "../src/pipeline/stage2Masked/core";
// Nov 2026, job_97e405cc: a free-standing sofa "oriented to face toward the
// large sliding glass door" was drawn against the glass twice.
describe("free-standing sofas are placed by where they stand, not what they face", () => {
  it("asks for a rewrite when a free-standing sofa is described as facing a door or glass", () => {
    const pl = "freestanding on the area rug in the foreground living area, with its back facing the dining area and kitchen, oriented to face toward the large sliding glass door on the right of the photo";
    expect(checkSofaPlacement({ layout: [{ item: "3-seat sofa", placement: pl }] } as any, "living_dining").join(" ")).toMatch(/WHERE it stands/);
    expect(checkSofaPlacement({ layout: [{ item: "3-seat sofa", placement: "free-standing in the foreground of the photo, back toward the camera, 1.6 m from the sliding glass door" }] } as any, "living_dining")).toHaveLength(0);
    expect(checkSofaPlacement({ layout: [{ item: "3-seat sofa", placement: "back against the plain wall straight ahead, facing the TV" }] } as any, "living_room")).toHaveLength(0);
  });
  it("tells Gemini where to put a sofa that blocked a sliding door when no wall is free", () => {
    expect(livingDoorRestageHint("the sofa blocks the sliding glass patio door on the right", [], { usableWalls: [], items: ["3-seat sofa"] })).toMatch(/foreground of the photo/);
    expect(livingDoorRestageHint("the sofa blocks the sliding glass patio door on the right", [], { usableWalls: ["the plain wall on the left"], items: ["3-seat sofa"] })).not.toMatch(/foreground of the photo/);
  });
});
