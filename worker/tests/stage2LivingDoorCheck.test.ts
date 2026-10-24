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

describe("living / dining re-stage hint", () => {
  const { livingDoorRestageHint, livingPlanFromBrief, doorsInWords } = require("../src/pipeline/stage2Masked/core");
  const doors = [
    { id: "D1", type: "doorway", description: "open doorway to the hallway", bbox: [0.51, 0.26, 0.56, 0.56] },
    { id: "D2", type: "door", description: "closed beige interior door", bbox: [0.36, 0.19, 0.44, 0.62] },
    { id: "D3", type: "door", description: "interior door frame on the right wall", bbox: [0.95, 0.12, 1, 0.88] },
  ];
  // Job 0d2b0a4b (Oct 2026): every wall has a door; the plan floats the sofa.
  const brief = {
    walls: [{ name: "Rear wall", usableForLargeFurniture: false }, { name: "Right wall", usableForLargeFurniture: false }],
    layout: [{ item: "Sofa" }, { item: "Area Rug" }, { item: "Coffee Table" }, { item: "Armchair" }],
  };

  it("names doors in words, not the check's ids", () => {
    const t = doorsInWords("sofa blocks D2 and D1", doors);
    expect(t).not.toMatch(/\bD[12]\b/);
    expect(t).toContain("closed beige interior door in the middle of the photo");
    expect(t).toContain("open doorway to the hallway in the middle of the photo");
    expect(doorsInWords("armchair blocks D3", doors)).toContain("at the far right edge of the photo");
  });

  it("changes only the blocking piece and keeps the sofa free-standing when no wall is free", () => {
    const hint = livingDoorRestageHint("armchair blocks D3", doors, livingPlanFromBrief(brief));
    expect(hint).toContain("Only the armchair was the problem");
    expect(hint).toContain("keep the sofa, area rug, coffee table exactly where the layout puts them");
    expect(hint).toContain("Leave the armchair out");
    expect(hint).toContain("free-standing in the open room");
    expect(hint).not.toContain("plain wall");
    expect(hint).not.toMatch(/\bD3\b/);
  });

  it("names the free walls from the plan when there are some", () => {
    const plan = livingPlanFromBrief({ ...brief, walls: [{ name: "Left wall", usableForLargeFurniture: true }] });
    const hint = livingDoorRestageHint("sofa blocks D2", doors, plan);
    expect(hint).toContain("use only: Left wall");
    expect(hint).toContain("Use a smaller sofa and move it further into the open room");
  });

  it("keeps the old wording (with doors in words) when there is no room plan", () => {
    const hint = livingDoorRestageHint("sofa blocks D2", doors, null);
    expect(hint).toContain("Put the sofa with its back to a plain wall");
    expect(hint).toContain("closed beige interior door");
  });
});
