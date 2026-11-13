jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import { roomGetsNoStaging, noStagingMessage, roomAllowsEmptyLayout } from "../src/pipeline/roomBrief";

describe("rooms that are never staged (Nov 2026, Harcourts batch: garages failed 4 times each)", () => {
  it("skips staging for garages only", () => {
    expect(roomGetsNoStaging("garage")).toBe(true);
    expect(roomGetsNoStaging("Garage")).toBe(true);
    for (const r of ["bedroom", "living_room", "bathroom_1", "kitchen", "hallway", "laundry", "auto", ""]) expect(roomGetsNoStaging(r)).toBe(false);
  });
  it("explains it in plain words, never mentioning AI", () => {
    const m = noStagingMessage("garage");
    expect(m).toMatch(/garage/i);
    expect(m).not.toMatch(/\bAI\b/);
    expect(noStagingMessage("hallway")).not.toMatch(/\bAI\b/);
  });
  it("rooms that may stay empty include garages and hallways, not bedrooms", () => {
    expect(roomAllowsEmptyLayout("garage")).toBe(true);
    expect(roomAllowsEmptyLayout("hallway")).toBe(true);
    expect(roomAllowsEmptyLayout("bedroom")).toBe(false);
  });
});
