jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}) }));
import { checkRoomBrief, buildStage2PromptFromRoomBrief, type RoomBrief } from "../src/pipeline/roomBrief";

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
    expect(p).toMatch(/1\. TV: mounted on the black TV wall bracket/);
    expect(p).not.toMatch(/\[0\./);
  });
});
