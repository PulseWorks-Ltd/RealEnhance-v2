jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import { sameRoomChangeAgain } from "../src/pipeline/stage2Masked/pipeline";

// Nov 2026, job_2575a584: "room changed to fit the furniture" at x 79-92%,
// then 80-95%, then 81-95% — the third attempt was never going to differ.
describe("no extra staging when Gemini changes the room the same way twice", () => {
  const att = (x1: number, x2: number, reasons = ["room changed to fit the furniture"]) => ({ reasonsList: reasons, skirtingBeside: { runs: [{ x1Pct: x1, x2Pct: x2 }] } });
  it("same change in the same place -> skip the extra staging", () => {
    expect(sameRoomChangeAgain(att(79.1, 92.3), att(80.1, 95.4))).toBe(true);
  });
  it("a change somewhere else, or a different reason -> another try is allowed", () => {
    expect(sameRoomChangeAgain(att(10, 20), att(80, 95))).toBe(false);
    expect(sameRoomChangeAgain(att(79, 92, ["furniture floating"]), att(80, 95))).toBe(false);
    expect(sameRoomChangeAgain(null, att(80, 95))).toBe(false);
  });
});
