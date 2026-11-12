const restCalls: any[] = [];
let script: Array<() => any> = [];
jest.mock("../src/ai/geminiRestClient", () => ({
  generateContentViaRest: jest.fn(async (args: any) => { restCalls.push(args); const next = script.shift(); if (!next) throw new Error("no more"); return next(); }),
}));
jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import { callGeminiImage, isRetryableNoImage } from "../src/pipeline/stage2Masked/core";
import { isLayoutOrTransientFailure } from "../src/pipeline/stage2Masked/pipeline";

const img = { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from("png").toString("base64") } }] } }] };
const empty = (reason: string) => ({ candidates: [{ finishReason: reason, content: { parts: [] } }] });
const params = { model: "gemini-3.1-flash-image", parts: [], imageSize: "1K", aspectRatio: "4:3" };

describe("Gemini 'no image' answers (Nov 2026 test run, Bedroom_05)", () => {
  beforeEach(() => { restCalls.length = 0; script = []; process.env.GEMINI_API_KEY = "test"; jest.spyOn(console, "warn").mockImplementation(() => {}); });

  it("retries once after IMAGE_RECITATION and uses the second answer", async () => {
    script = [() => empty("IMAGE_RECITATION"), () => img];
    const r = await callGeminiImage(params);
    expect(restCalls).toHaveLength(2);
    expect(r.image.toString()).toBe("png");
  });
  it("gives up after one retry", async () => {
    script = [() => empty("IMAGE_RECITATION"), () => empty("IMAGE_RECITATION")];
    await expect(callGeminiImage(params)).rejects.toThrow(/IMAGE_RECITATION/);
    expect(restCalls).toHaveLength(2);
  });
  it("never retries a safety block", async () => {
    script = [() => empty("IMAGE_SAFETY"), () => img];
    await expect(callGeminiImage(params)).rejects.toThrow(/IMAGE_SAFETY/);
    expect(restCalls).toHaveLength(1);
  });
  it("classifies reasons", () => {
    for (const r of ["IMAGE_RECITATION", "RECITATION", "OTHER", "IMAGE_OTHER", "no image returned"]) expect(isRetryableNoImage(r)).toBe(true);
    for (const r of ["SAFETY", "IMAGE_SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"]) expect(isRetryableNoImage(r)).toBe(false);
  });
});

describe("extra staging attempt: only for layout or processing failures", () => {
  it("allows the extra attempt for layout and transient failures", () => {
    for (const r of ["furniture cut off by the trace", "furniture floating", "room changed to fit the furniture", "room reshaped", "processing error: gemini-3.1-flash-image returned no image (IMAGE_RECITATION)"]) {
      expect(isLayoutOrTransientFailure(r)).toBe(true);
    }
  });
  it("not for anything else (e.g. a blocked doorway)", () => {
    for (const r of ["doorway blocked", "bed covers the door", "furniture cut off at the photo edge"]) expect(isLayoutOrTransientFailure(r)).toBe(false);
  });
});
