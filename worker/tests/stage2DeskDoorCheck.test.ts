jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import { evaluateDeskDoor, buildDeskDoorPrompt } from "../src/pipeline/stage2Masked/core";

const base = { deskPresent: "yes", doorOnDeskWall: "no", otherPlainWallAvailable: "no", deskCoversDoor: "no", roomWidened: "no" };

describe("desk door check", () => {
  it("passes a desk on a plain wall", () => {
    expect(evaluateDeskDoor(base).failed).toBe(false);
  });
  it("fails a desk setup in front of a door", () => {
    const r = evaluateDeskDoor({ ...base, deskCoversDoor: "yes" });
    expect(r.failed).toBe(true);
    expect(r.restageHints.join(" ")).toMatch(/plain wall that has no door/);
  });
  it("fails a desk on a door wall only when a plain wall exists", () => {
    expect(evaluateDeskDoor({ ...base, doorOnDeskWall: "yes", otherPlainWallAvailable: "yes" }).failed).toBe(true);
    expect(evaluateDeskDoor({ ...base, doorOnDeskWall: "yes", otherPlainWallAvailable: "no" }).failed).toBe(false);
  });
  it("ignores everything when there is no desk or no answer", () => {
    expect(evaluateDeskDoor({ ...base, deskPresent: "no", deskCoversDoor: "yes" }).failed).toBe(false);
    expect(evaluateDeskDoor(null).failed).toBe(false);
  });
  it("lists the surveyed doors", () => {
    const p = buildDeskDoorPrompt([{ id: "D1", type: "door", description: "alcove door", bbox: [0.44, 0.31, 0.55, 0.88] }] as any);
    expect(p).toContain("D1: alcove door (door), box [0.44, 0.31, 0.55, 0.88]");
    expect(p).toContain("deskCoversDoor");
  });
});
