jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { checkFloorMoved } from "../src/pipeline/stage2Masked/core";
import { visibleFloorPct } from "../src/pipeline/stage2Masked/floorLine";
import { makeTightShotPlan, buildStage2PromptFromRoomBrief, tightShotApplies } from "../src/pipeline/roomBrief";

const DIR = path.join(__dirname, "../../Test Images/Tight Shot Fixtures/GolfRd_05");
const FLOAT = path.join(__dirname, "../../Test Images/Floating Check Fixtures");
const maybe = fs.existsSync(DIR) ? it : it.skip;

async function maskOf(file: string) {
  const { data, info } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { mask: Uint8Array.from(data, (v) => (v > 127 ? 1 : 0)), w: info.width, h: info.height };
}

describe("floor-moved check", () => {
  maybe("flags Gemini raising the floor to fit a bed in a tight shot (33 Golf Rd Image 05, attempt 2)", async () => {
    const original = fs.readFileSync(path.join(DIR, "1_original.jpg"));
    const staged = fs.readFileSync(path.join(DIR, "2_staged_raw_attempt2.jpg"));
    const { mask, w, h } = await maskOf(path.join(DIR, "3_mask_final_attempt2.png"));
    const r = await checkFloorMoved(original, staged, mask, w, h);
    expect(r.moved).toBe(true);
    expect(r.longestRunPct).toBeGreaterThanOrEqual(4);
  }, 60000);

  maybe("does not flag the same photo against itself", async () => {
    const original = fs.readFileSync(path.join(DIR, "1_original.jpg"));
    const { mask, w, h } = await maskOf(path.join(DIR, "3_mask_final_attempt2.png"));
    const r = await checkFloorMoved(original, original, mask, w, h);
    expect(r.moved).toBe(false);
    expect(r.movedColsPct).toBe(0);
  }, 60000);

  const goodDirs = ["Bedroom_07", "Bedroom_14"].filter((d) => fs.existsSync(path.join(FLOAT, d, "2_staged_raw.webp")));
  for (const d of goodDirs) {
    it(`does not flag ${d} (floor line where it belongs; legs float instead)`, async () => {
      const original = fs.readFileSync(path.join(FLOAT, d, "1_original.jpg"));
      const staged = fs.readFileSync(path.join(FLOAT, d, "2_staged_raw.webp"));
      const { mask, w, h } = await maskOf(path.join(FLOAT, d, "3_mask_traced.png"));
      const r = await checkFloorMoved(original, staged, mask, w, h);
      expect(r.moved).toBe(false);
    }, 60000);
  }
});

describe("tight shots", () => {
  maybe("measures the Golf Rd bedroom as a tight shot and normal bedrooms as not", async () => {
    expect(await visibleFloorPct(fs.readFileSync(path.join(DIR, "1_original.jpg")))).toBeLessThan(12);
    for (const d of ["Bedroom_11", "Bedroom_12"]) {
      const f = path.join(FLOAT, d, "1_original.jpg");
      if (fs.existsSync(f)) expect(await visibleFloorPct(fs.readFileSync(f))).toBeGreaterThan(15);
    }
  }, 60000);

  it("only measures rooms where the floor line is a fair measure", () => {
    expect(tightShotApplies("bedroom")).toBe(true);
    expect(tightShotApplies("living_room")).toBe(true);
    expect(tightShotApplies("kitchen_dining")).toBe(false);
    expect(tightShotApplies("bathroom")).toBe(false);
  });

  maybe("cuts the plan down: no rug, double bed, one bedside table, bed may run off the photo", () => {
    const brief = JSON.parse(fs.readFileSync(path.join(DIR, "2_room_brief.json"), "utf8"));
    brief.layout.push({ item: "Bedside table", placement: "on the near side of the bed, toward the camera" });
    const { brief: out, changed } = makeTightShotPlan(brief, "bedroom", 9.5);
    const text = JSON.stringify(out.layout) + JSON.stringify(out.relationships);
    expect(text).not.toMatch(/\brug\b/i);
    expect(text).not.toMatch(/\bqueen\b/i);
    expect((out as any).bedSpace.bed).toBe("double");
    expect(out.layout.filter((it) => /bedside/i.test(it.item)).length).toBe(1);
    expect(out.layout.find((it) => /\bbed\b/i.test(it.item) && !/bedside/i.test(it.item))!.placement).toMatch(/edge of the photo/);
    expect(out.tightShot).toEqual({ floorPct: 9.5 });
    expect(changed.join(" ")).toMatch(/rug/i);
    const prompt = buildStage2PromptFromRoomBrief(out, { roomType: "bedroom", styleDescription: "standard_listing" });
    expect(prompt).toContain("TIGHT SHOT");
    expect(prompt).not.toMatch(/a rug under the seating/);
  });
});
