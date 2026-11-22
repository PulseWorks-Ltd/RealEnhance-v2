jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import { plannedBedWallFromBrief, buildBedWallPrompt, evaluateBedWall } from "../src/pipeline/stage2Masked/core";
import { isLayoutOrTransientFailure } from "../src/pipeline/stage2Masked/pipeline";

// Nov 2026, job_37bb979a: the plan chose the plain right-hand wall; attempt 2
// put the bed against the back wall (with a doorway), past the corner, and passed.
const brief = {
  walls: [
    { name: "the plain wall on the right of the photo" },
    { name: "the back wall with the open doorway" },
  ],
  layout: [
    { item: "Queen bed (1.5 m wide)", placement: "headboard against the plain wall on the right of the photo, toward the far corner" },
    { item: "Bedside table (0.5 m wide)", placement: "beside the bed" },
  ],
};

describe("bed on the wall the room plan chose (job_37bb979a)", () => {
  it("reads the planned wall from the plan, by the plan's own wall name", () => {
    expect(plannedBedWallFromBrief(brief)).toBe("the plain wall on the right of the photo");
    expect(plannedBedWallFromBrief({ layout: [{ item: "Double bed", placement: "against the left wall under the window — toward the corner" }] })).toBe("against the left wall under the window");
    expect(plannedBedWallFromBrief({ layout: [{ item: "Sofa", placement: "x" }] })).toBeNull();
  });
  it("asks the check whether the headboard is on that wall", () => {
    const p = buildBedWallPrompt([], "the plain wall on the right of the photo");
    expect(p).toMatch(/onPlannedWall/);
    expect(p).toMatch(/the plain wall on the right of the photo/);
    expect(p).toMatch(/past a corner of the room/);
    expect(buildBedWallPrompt([])).not.toMatch(/onPlannedWall/);
  });
  it("fails a bed on a different wall, with a hint naming the planned wall, and allows another staging", () => {
    const planned = "the plain wall on the right of the photo";
    const r = evaluateBedWall({ bedPresent: "yes", onPlannedWall: "no", doorOnHeadboardWall: "yes", otherPlainWallAvailable: "no" }, planned);
    expect(r.failed).toBe(true);
    expect(r.wrongWall).toBe(true);
    expect(r.restageHints.join(" ")).toMatch(/the plain wall on the right of the photo/);
    expect(evaluateBedWall({ bedPresent: "yes", onPlannedWall: "yes" }, planned).failed).toBe(false);
    expect(evaluateBedWall({ bedPresent: "yes" }, null).failed).toBe(false);
    expect(isLayoutOrTransientFailure("bed not where the plan put it")).toBe(true);
  });
  it("accepts a bed on a different wall when that wall is good (owner, Nov 2026: Harcourts job_8f63d481)", () => {
    const planned = "the wall on the left of the photo with the large window";
    // Gemini chose the plain wall beside the planned one, three times; all good stagings.
    const ok = evaluateBedWall({ bedPresent: "yes", onPlannedWall: "no", headboardWall: "the plain wall on the left side of the room", doorOnHeadboardWall: "no", otherPlainWallAvailable: "no", headboardCoversWindow: "no", windowCoverage: "none", bedCoversDoor: "no", roomWidened: "no" }, planned);
    expect(ok.wrongWall).toBe(true);
    expect(ok.offPlanAccepted).toBe(true);
    expect(ok.failed).toBe(false);
    expect(ok.restageHints).toHaveLength(0);
    // Still failed when the other wall is not good.
    const base = { bedPresent: "yes", onPlannedWall: "no", doorOnHeadboardWall: "no", headboardCoversWindow: "no", bedCoversDoor: "no", roomWidened: "no" };
    expect(evaluateBedWall({ ...base, doorOnHeadboardWall: "yes" }, planned).failed).toBe(true);
    expect(evaluateBedWall({ ...base, bedCoversDoor: "yes" }, planned).failed).toBe(true);
    expect(evaluateBedWall({ ...base, roomWidened: "yes" }, planned).failed).toBe(true);
    expect(evaluateBedWall({ ...base, headboardCoversWindow: "yes", windowCoverage: "most" }, planned).failed).toBe(true);
  });
});
