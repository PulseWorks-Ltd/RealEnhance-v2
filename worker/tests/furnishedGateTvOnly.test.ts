import { resolveFurnishedGateDecision, type FurnitureAnalysis, type FurnitureItem } from "../src/ai/furnitureDetector";

const analysis = (o: Partial<FurnitureAnalysis> = {}): FurnitureAnalysis => ({
  hasFurniture: true, detectedAnchors: [], confidence: 0.95, hasMovableSeating: false,
  hasCounterClutter: false, hasSurfaceClutter: false, hasLoosePortableItems: false, isStageReady: true,
  roomType: "living_room", furnitureItems: [], layoutDescription: "", replacementOpportunity: "none", suggestions: [], ...o,
} as FurnitureAnalysis);
const item = (type: string): FurnitureItem => ({ type, label: type, isAnchor: true, confidence: 0.9 } as FurnitureItem);
const gate = (a: FurnitureAnalysis) => resolveFurnishedGateDecision({ analysis: { ...a, status: "success" } as any, localEmpty: false, roomType: "living_room" });

describe("living room with only a TV (job_4ac443fb, Oct 2026)", () => {
  it("is staged from empty when the TV is the only thing in the room", () => {
    const g = gate(analysis({ detectedAnchors: ["tv"] }));
    expect(g.roomState).toBe("EMPTY");
    expect(g.stage2ModeCandidate).toBe("FROM_EMPTY");
    expect(g.requiresStage1B).toBe(false);
  });
  it("also when the TV is listed as a furniture item", () => {
    const g = gate(analysis({ detectedAnchors: ["tv"], furnitureItems: [item("tv")] }));
    expect(g.stage2ModeCandidate).toBe("FROM_EMPTY");
  });
  it("a TV with a sofa is still a furnished room (refresh)", () => {
    const g = gate(analysis({ detectedAnchors: ["tv", "sofa"], furnitureItems: [item("tv"), item("sofa")] }));
    expect(g.stage2ModeCandidate).toBe("REFRESH");
  });
});
