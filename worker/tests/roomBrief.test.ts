jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}) }));
import { checkRoomBrief, buildStage2PromptFromRoomBrief, buildRoomBriefInstruction, type RoomBrief } from "../src/pipeline/roomBrief";

const good: RoomBrief = {
  roomSummary: "An open-plan kitchen, living and dining room.",
  camera: "The camera stands in the front-left corner looking toward the kitchen at the back.",
  landmarks: [
    { id: "L1", type: "tv_bracket", description: "black TV wall bracket on the white wall on the right", box: [0.7, 0.4, 0.95, 0.5] },
    { id: "L2", type: "kitchen_bench", description: "kitchen peninsula bench at the back, right of centre" },
  ],
  walls: [],
  zones: [{ name: "dining", description: "the open floor at the back in front of the kitchen peninsula" }],
  kitchenVisible: true,
  layout: [
    { item: "TV", placement: "mounted on the black TV wall bracket on the white wall on the right" },
    { item: "Sofa", placement: "in the living area on the left, facing the TV on the right-hand wall" },
    { item: "Dining table with 4 chairs", placement: "on the open floor at the back, just in front of the kitchen peninsula bench" },
  ],
  relationships: ["The dining table stays at the back near the kitchen, never between the sofa and the TV."],
  avoid: ["Do not place the dining table in the living area"],
  keepUntouched: ["The black TV wall bracket on the right wall"],
};

describe("room brief checks", () => {
  it("accepts a landmark-described plan", () => {
    expect(checkRoomBrief(good, "kitchen_living_dining")).toEqual([]);
  });
  it("requires the TV on the bracket", () => {
    const b = { ...good, layout: good.layout.map((l) => (l.item === "TV" ? { ...l, placement: "on the wall on the right side of the room" } : l)) };
    expect(checkRoomBrief(b, "kitchen_living_dining").join(" ")).toMatch(/bracket/);
  });
  it("requires a TV when a bracket exists", () => {
    const b = { ...good, layout: good.layout.filter((l) => l.item !== "TV") };
    expect(checkRoomBrief(b, "kitchen_living_dining").join(" ")).toMatch(/mount a TV/);
  });
  it("requires the dining table next to a visible kitchen", () => {
    const b = { ...good, layout: good.layout.map((l) => (/Dining/.test(l.item) ? { ...l, placement: "in the middle of the room in front of the sofa" } : l)) };
    expect(checkRoomBrief(b, "kitchen_living_dining").join(" ")).toMatch(/next to the kitchen/);
  });
  it("rejects coordinates", () => {
    const b = { ...good, layout: [...good.layout, { item: "Rug", placement: "centred at [0.42, 0.71] of the photo" }] };
    expect(checkRoomBrief(b, "kitchen_living_dining").join(" ")).toMatch(/coordinates/);
  });
  it("builds a prompt with the layout first and no coordinates", () => {
    const p = buildStage2PromptFromRoomBrief(good, { roomType: "kitchen_living_dining", styleDescription: "modern NZ" });
    expect(p).toMatch(/^Stage this empty open-plan kitchen, living and dining room/);
    expect(p.indexOf("LAYOUT")).toBeLessThan(p.indexOf("KEEP EXACTLY"));
    expect(p).toMatch(/1\. TV: Mounted on the black TV wall bracket/);
    expect(p).not.toMatch(/\[0\./);
  });
  it("tidies model wording into clean sentences", () => {
    const b = {
      ...good,
      camera: "Stands in the front-left foreground, looking toward the kitchen",
      avoid: ["Placing the dining table between the sofa and the TV wall.", "Do not block the doorway"],
    };
    const p = buildStage2PromptFromRoomBrief(b, { roomType: "kitchen_living_dining" });
    expect(p).toMatch(/The camera stands in the front-left foreground, looking toward the kitchen\./);
    expect(p).toMatch(/AVOID IN THIS ROOM\n- Placing the dining table between the sofa and the TV wall\.\n- Do not block the doorway\./);
    expect(p).not.toMatch(/\.\./);
    expect(p).not.toMatch(/\.;/);
  });
  it("plans a dining room without living-room furniture", () => {
    for (const rt of ["dining_room", "dining"]) {
      const t = buildRoomBriefInstruction(rt);
      expect(t).toMatch(/DINING AREA/);
      expect(t).not.toMatch(/LIVING AREA/);
      expect(t).toMatch(/a dining room\b/);
    }
    expect(buildRoomBriefInstruction("living_dining")).toMatch(/LIVING AREA/);
  });
  it("lets a tight kitchen/dining shot skip the dining table", () => {
    const tight = { ...good, diningSpace: { fits: "none" as const, reason: "only a walkway in front of the kitchen" }, layout: [] };
    expect(checkRoomBrief(tight, "kitchen_dining")).toEqual([]);
    expect(checkRoomBrief({ ...good, layout: [] }, "kitchen_dining").join(" ")).toMatch(/layout is empty/);
    const noTable = { ...good, layout: good.layout.filter((l) => !/dining/i.test(l.item)) };
    expect(checkRoomBrief(noTable, "kitchen_living_dining").join(" ")).toMatch(/needs a dining table/);
    const p = buildStage2PromptFromRoomBrief(tight, { roomType: "kitchen_dining" });
    expect(p).toMatch(/no room here for large furniture/);
    expect(p).toMatch(/never change the room, the stairs, the cabinetry or the camera view/);
  });
});
