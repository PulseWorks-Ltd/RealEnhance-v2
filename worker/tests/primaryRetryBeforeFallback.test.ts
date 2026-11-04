const restCalls: any[] = [];
let restScript: Array<() => any> = [];
jest.mock("../src/ai/geminiRestClient", () => ({
  generateContentViaRest: jest.fn(async (args: any) => {
    restCalls.push(args);
    const next = restScript.shift();
    if (!next) throw new Error("no more scripted responses");
    return next();
  }),
}));
import { runImageGenerationPrimaryThenFallbackViaRest } from "../src/ai/runWithImageModelFallback";

const IMAGE = { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] } }] };
const NO_IMAGE = { candidates: [{ content: { parts: [{ text: "sorry" }] } }] };
const err = (status: number, message = `HTTP ${status}`) => () => { const e: any = new Error(message); e.status = status; throw e; };

function run(fallbackResp: any = IMAGE) {
  const fallback = jest.fn(async () => fallbackResp);
  const p = runImageGenerationPrimaryThenFallbackViaRest({
    ai: { models: { generateContent: fallback } } as any,
    apiKey: "test",
    baseRequestBody: { contents: [], generationConfig: { imageConfig: { imageSize: "2K" } } } as any,
    context: "test",
    meta: { stage: "1B", jobId: "job_test", imageId: "img_test" } as any,
    primaryModel: "gemini-3.1-flash-image",
    fallbackModel: "gemini-2.5-flash-image",
    stageLabel: "1B",
  });
  return { p, fallback };
}

describe("2K primary is retried once before the ~1 MP fallback", () => {
  beforeEach(() => { restCalls.length = 0; restScript = []; jest.useRealTimers(); });

  it("an overload on the first try: the second 2K try is used, no fallback", async () => {
    restScript = [err(503), () => IMAGE];
    const { p, fallback } = run();
    const r = await p;
    expect(r.modelUsed).toBe("gemini-3.1-flash-image");
    expect(restCalls.length).toBe(2);
    expect(fallback).not.toHaveBeenCalled();
  }, 20000);

  it("no image twice: falls back to 2.5 after two 2K tries", async () => {
    restScript = [() => NO_IMAGE, () => NO_IMAGE];
    const { p, fallback } = run();
    const r = await p;
    expect(r.modelUsed).toBe("gemini-2.5-flash-image");
    expect(restCalls.length).toBe(2);
    expect(fallback).toHaveBeenCalledTimes(1);
  }, 20000);

  it("payment/quota error: no second 2K try, straight to the fallback", async () => {
    restScript = [err(402, "payment_required")];
    const { p, fallback } = run();
    const r = await p;
    expect(r.modelUsed).toBe("gemini-2.5-flash-image");
    expect(restCalls.length).toBe(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  }, 20000);

  it("a non-retryable error still fails without retry or fallback", async () => {
    restScript = [err(400, "bad request")];
    const { p, fallback } = run();
    await expect(p).rejects.toThrow(/without fallback eligibility/);
    expect(restCalls.length).toBe(1);
    expect(fallback).not.toHaveBeenCalled();
  }, 20000);
});
