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

describe("living / dining door check: walkable standard and hint fixes (Oct 2026 batch)", () => {
  const { evaluateLivingDoor, livingDoorRestageHint, livingPlanFromBrief, doorsInWords, floorMovedHint, buildLivingDoorPrompt } = require("../src/pipeline/stage2Masked/core");
  const base = { furniturePresent: "yes", roomWidened: "no" };

  it("fails only a door a person can't walk through", () => {
    expect(evaluateLivingDoor({ ...base, doorAccess: "blocked", blockedWhat: "sofa across the hallway doorway" }).failed).toBe(true);
    expect(evaluateLivingDoor({ ...base, doorAccess: "passable", blockedWhat: "sofa hides the bottom of the doorway" }).failed).toBe(false);
    expect(evaluateLivingDoor({ ...base, doorAccess: "clear" }).failed).toBe(false);
    expect(buildLivingDoorPrompt([])).toContain('"doorAccess": "blocked" | "passable" | "clear"');
  });

  it("matches 'beige sofa' to the planned '3-seater sofa' instead of telling Gemini to both move and keep it", () => {
    const plan = livingPlanFromBrief({ walls: [], layout: [{ item: "3-seater sofa" }, { item: "coffee table" }, { item: "dining table" }, { item: "dining chairs" }, { item: "armchair" }] });
    const hint = livingDoorRestageHint("the beige sofa blocks the open hallway doorway", [], plan);
    expect(hint).toContain("Only the 3-seater sofa was the problem");
    expect(hint).not.toMatch(/keep the[^.]*3-seater sofa/);
    // "table" alone is ambiguous (coffee or dining) and "armchair" is not a "chair".
    expect(livingDoorRestageHint("the armchair blocks the door", [], plan)).toContain("Only the armchair was the problem");
  });

  it("drops a door id in brackets after the check's own description, and trims stray full stops", () => {
    const doors = [{ id: "A1", type: "doorway", description: "the open doorway with a white frame leading to a hallway.", bbox: [0.5, 0.2, 0.56, 0.6] }];
    expect(doorsInWords("the beige sofa blocks the open doorway (A1) in the middle-back wall", doors)).toBe("the beige sofa blocks the open doorway in the middle-back wall");
    expect(doorsInWords("sofa blocks A1", doors)).toBe("sofa blocks the open doorway with a white frame leading to a hallway in the middle of the photo");
  });

  it("floor-moved hint says where, keeps the layout, and no longer claims there is little floor", () => {
    const hint = floorMovedHint({ atXPct: [16, 25] });
    expect(hint).toContain("on the left of the photo (about 16–25% of the way across)");
    expect(hint).toContain("Keep the same layout");
    expect(hint).not.toContain("only a little floor");
    expect(floorMovedHint(null)).toContain("the line where the wall meets the floor was moved");
  });
});
