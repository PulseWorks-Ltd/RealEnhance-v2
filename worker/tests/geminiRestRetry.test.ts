const responses: Array<() => any> = [];
jest.mock("node-fetch", () => jest.fn(async () => {
  const next = responses.shift();
  if (!next) throw new Error("no more mocked responses");
  return next();
}));
import fetch from "node-fetch";
import { generateContentViaRest, isTransientGeminiRestError } from "../src/ai/geminiRestClient";

const ok = () => ({ ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ candidates: [1] }) });
const fail = (status: number) => () => ({ ok: false, status, statusText: "x", text: async () => JSON.stringify({ error: { message: "The service is currently unavailable." } }) });
const call = () => generateContentViaRest({ apiKey: "k", model: "gemini-3.1-flash-image", body: { contents: [{ text: "hi" }] } });

describe("Gemini REST transient retry", () => {
  beforeEach(() => {
    responses.length = 0;
    (fetch as unknown as jest.Mock).mockClear();
    process.env.GEMINI_REST_RETRY_DELAY_MS = "0";
    delete process.env.GEMINI_REST_TRANSIENT_RETRIES;
  });

  it("retries a 503 and returns the later success", async () => {
    responses.push(fail(503), ok);
    await expect(call()).resolves.toEqual({ candidates: [1] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("gives up after 2 retries", async () => {
    responses.push(fail(503), fail(503), fail(503), ok);
    await expect(call()).rejects.toThrow(/503/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("does not retry a bad request or bad key", async () => {
    responses.push(fail(400), ok);
    await expect(call()).rejects.toThrow(/400/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("classifies errors", () => {
    expect(isTransientGeminiRestError({ status: 429 })).toBe(true);
    expect(isTransientGeminiRestError({ status: 403 })).toBe(false);
    expect(isTransientGeminiRestError({ code: "ECONNRESET" })).toBe(true);
    expect(isTransientGeminiRestError({ code: "ETIMEDOUT" })).toBe(false);
  });
});
