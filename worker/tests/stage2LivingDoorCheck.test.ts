jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import { evaluateLivingDoor, buildLivingDoorPrompt } from "../src/pipeline/stage2Masked/core";

describe("living / dining door check", () => {
  const base = { furniturePresent: "yes", blocksDoor: "no", roomWidened: "no" };
  it("passes furniture that keeps the doors clear", () => {
    expect(evaluateLivingDoor(base).failed).toBe(false);
  });
  it("fails furniture blocking a door, with a hint naming it", () => {
    const r = evaluateLivingDoor({ ...base, blocksDoor: "yes", blockedWhat: "sofa across the sliding door" });
    expect(r.failed).toBe(true);
    expect(r.restageHints.join(" ")).toContain("sofa across the sliding door");
  });
  it("fails a room widened to fit the furniture", () => {
    expect(evaluateLivingDoor({ ...base, roomWidened: "yes" }).failed).toBe(true);
  });
  it("ignores everything when nothing was added or there is no answer", () => {
    expect(evaluateLivingDoor({ ...base, furniturePresent: "no", blocksDoor: "yes" }).failed).toBe(false);
    expect(evaluateLivingDoor(null).failed).toBe(false);
  });
  it("lists the surveyed doors", () => {
    expect(buildLivingDoorPrompt([{ id: "S1", type: "sliding_door", description: "deck slider", bbox: [0.1, 0.2, 0.3, 0.8] }] as any)).toContain("S1: deck slider (sliding_door)");
  });
});
