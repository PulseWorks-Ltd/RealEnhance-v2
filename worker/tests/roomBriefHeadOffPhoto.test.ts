jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import fs from "fs";
import path from "path";
import { makeHeadOffPhotoPlan, buildStage2PromptFromRoomBrief, checkBedFits } from "../src/pipeline/roomBrief";

const FIX = path.join(__dirname, "../../Test Images/Head Off Photo Fixtures/681aa5f0_room_brief.json");

describe("head of the bed out of shot", () => {
  const load = () => JSON.parse(fs.readFileSync(FIX, "utf8"));

  it("drops the head-end pieces and runs the bed out of the photo", () => {
    const brief = load();
    brief.bedSpace = { ...brief.bedSpace, headOffPhoto: true };
    const { brief: out, changed } = makeHeadOffPhotoPlan(brief, "bedroom");
    const items = out.layout.map((l: any) => l.item).join(" | ");
    expect(items).not.toMatch(/bedside|lamp|art/i);
    const bed = out.layout.find((l: any) => /\bbed\b/i.test(l.item))!;
    expect(bed.placement).toMatch(/run out of the photo/);
    expect((out as any).bedSpace.bedsideTables).toBe(0);
    expect(changed.length).toBeGreaterThan(0);
    expect(checkBedFits(out)).toEqual([]);
    const prompt = buildStage2PromptFromRoomBrief(out, { roomType: "bedroom", styleDescription: "standard_listing" });
    expect(prompt).toContain("HEAD OF THE BED OUT OF SHOT");
  });

  it("leaves normal plans alone", () => {
    const brief = load();
    const { brief: out, changed } = makeHeadOffPhotoPlan(brief, "bedroom");
    expect(changed).toEqual([]);
    expect(out).toBe(brief);
    expect(buildStage2PromptFromRoomBrief(out, { roomType: "bedroom" })).not.toContain("HEAD OF THE BED OUT OF SHOT");
  });
});
