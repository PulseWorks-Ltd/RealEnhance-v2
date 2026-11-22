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
