jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}) }));
import { maskedStage2Enabled } from "../src/pipeline/stage2Masked/pipeline";

describe("merged Stage 2 switch", () => {
  const saved = { v: process.env.STAGE2_SPECIALIST_VALIDATORS, h: process.env.STAGE2_MASKED_HARMONISE };
  afterEach(() => {
    if (saved.v === undefined) delete process.env.STAGE2_SPECIALIST_VALIDATORS; else process.env.STAGE2_SPECIALIST_VALIDATORS = saved.v;
    if (saved.h === undefined) delete process.env.STAGE2_MASKED_HARMONISE; else process.env.STAGE2_MASKED_HARMONISE = saved.h;
  });
  const set = (v?: string, h?: string) => {
    if (v === undefined) delete process.env.STAGE2_SPECIALIST_VALIDATORS; else process.env.STAGE2_SPECIALIST_VALIDATORS = v;
    if (h === undefined) delete process.env.STAGE2_MASKED_HARMONISE; else process.env.STAGE2_MASKED_HARMONISE = h;
  };

  it("is off by default and for on / off", () => {
    set(); expect(maskedStage2Enabled()).toBe(false);
    set("on"); expect(maskedStage2Enabled()).toBe(false);
    set("off"); expect(maskedStage2Enabled()).toBe(false);
  });
  it("turns on with STAGE2_SPECIALIST_VALIDATORS=merged (any case)", () => {
    set("merged"); expect(maskedStage2Enabled()).toBe(true);
    set(" Merged "); expect(maskedStage2Enabled()).toBe(true);
  });
  it("still honours the original STAGE2_MASKED_HARMONISE switch", () => {
    set(undefined, "on"); expect(maskedStage2Enabled()).toBe(true);
    set("off", "1"); expect(maskedStage2Enabled()).toBe(true);
  });
});
