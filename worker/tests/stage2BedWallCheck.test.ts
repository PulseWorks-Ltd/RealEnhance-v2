jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import { evaluateBedWall, buildBedWallPrompt } from "../src/pipeline/stage2Masked/core";

const base = { bedPresent: "yes", doorOnHeadboardWall: "no", otherPlainWallAvailable: "no", headboardCoversWindow: "no", bedCoversDoor: "no" };

describe("bed wall check", () => {
  it("passes a bed on a plain wall", () => {
    expect(evaluateBedWall(base).failed).toBe(false);
  });
  it("fails a bed covering a door, even with no other plain wall (client 006)", () => {
    const r = evaluateBedWall({ ...base, doorOnHeadboardWall: "yes", bedCoversDoor: "yes" });
    expect(r.failed).toBe(true);
    expect(r.restageHints.join(" ")).toMatch(/door/);
  });
  it("fails a headboard on a door wall when a plain wall exists", () => {
    expect(evaluateBedWall({ ...base, doorOnHeadboardWall: "yes", otherPlainWallAvailable: "yes" }).failed).toBe(true);
  });
  it("allows the door wall as a fallback when there is no plain wall (client 005)", () => {
    expect(evaluateBedWall({ ...base, doorOnHeadboardWall: "yes", otherPlainWallAvailable: "no" }).failed).toBe(false);
  });
  it("fails a bed covering a window", () => {
    expect(evaluateBedWall({ ...base, headboardCoversWindow: "yes" }).failed).toBe(true);
  });
  it("allows a bed covering only the bottom of a window's glass (33 Golf Rd Image 03), even when a plain wall exists", () => {
    for (const other of ["no", "yes"]) {
      const r = evaluateBedWall({ ...base, otherPlainWallAvailable: other, headboardCoversWindow: "yes", windowCoverage: "bottom" });
      expect(r.failed).toBe(false);
      expect(r.underWindowAccepted).toBe(true);
    }
  });
  it("fails a bed that hides most of a window", () => {
    const r = evaluateBedWall({ ...base, headboardCoversWindow: "yes", windowCoverage: "most" });
    expect(r.failed).toBe(true);
    expect(r.restageHints.join(" ")).toMatch(/low headboard/);
  });
  it("fails a bed covering a window when the answer doesn't say how much", () => {
    expect(evaluateBedWall({ ...base, headboardCoversWindow: "yes" }).failed).toBe(true);
  });
  it("ignores everything when there is no bed or no answer", () => {
    expect(evaluateBedWall({ ...base, bedPresent: "no", bedCoversDoor: "yes" }).failed).toBe(false);
    expect(evaluateBedWall(null).failed).toBe(false);
  });
  it("lists the surveyed doors in the prompt", () => {
    const p = buildBedWallPrompt([{ id: "door_1", type: "door", description: "hall door", bbox: [0.1, 0.2, 0.3, 0.9] }]);
    expect(p).toContain("door_1: hall door (door), box [0.10, 0.20, 0.30, 0.90]");
    expect(p).toContain("bedCoversDoor");
  });
  it("fails when the room was widened to fit the bed (client Image 02)", () => {
    const r = evaluateBedWall({ ...base, roomWidened: "yes" });
    expect(r.failed).toBe(true);
    expect(r.roomWidened).toBe(true);
    expect(r.restageHints.join(" ")).toMatch(/longest direction/);
  });
  it("still builds a prompt when the survey found no doors", () => {
    const p = buildBedWallPrompt([]);
    expect(p).toContain("none found by the survey");
    expect(p).toContain("roomWidened");
  });
});
