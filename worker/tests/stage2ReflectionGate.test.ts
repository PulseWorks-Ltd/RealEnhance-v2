jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import { buildReflectivePrompt } from "../src/pipeline/stage2Masked/core";

describe("reflective surfaces question", () => {
  it("asks about mirrors, low glass and glossy floors, defaulting to yes", () => {
    const p = buildReflectivePrompt();
    expect(p).toMatch(/mirror/);
    expect(p).toMatch(/glossy or polished floor/);
    expect(p).toMatch(/If unsure, answer "yes"/);
    expect(p).toContain('"reflective": "yes" | "no"');
  });
});
