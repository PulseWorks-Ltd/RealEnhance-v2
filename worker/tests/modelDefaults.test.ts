import {
  GEMINI_FAST_TEXT_MODEL,
  GEMINI_STRONG_TEXT_MODEL,
  GEMINI_TEXT_MIN_OUTPUT_TOKENS,
  applyTextModelPolicy,
  auditModelEnvVars,
  replacementForRetiredModel,
  withTextModelPolicy,
} from "../src/ai/modelDefaults";

describe("Gemini model defaults (Dec 2026 retirement of 2.5 Pro / 2.5 Flash)", () => {
  test("defaults are the current replacement models", () => {
    expect(GEMINI_STRONG_TEXT_MODEL).toBe("gemini-3.8-flash");
    expect(GEMINI_FAST_TEXT_MODEL).toBe("gemini-3.5-flash-lite");
  });

  test("retiring text models map to their replacements; image and current models are left alone", () => {
    expect(replacementForRetiredModel("gemini-2.5-pro")).toBe("gemini-3.8-flash");
    expect(replacementForRetiredModel("gemini-2.5-flash")).toBe("gemini-3.5-flash-lite");
    expect(replacementForRetiredModel("gemini-2.5-flash-exp")).toBe("gemini-3.5-flash-lite");
    expect(replacementForRetiredModel("gemini-2.0-flash")).toBe("gemini-3.5-flash-lite");
    expect(replacementForRetiredModel("gemini-2.0-flash-exp")).toBe("gemini-3.5-flash-lite");
    expect(replacementForRetiredModel("gemini-2.5-flash-image")).toBeNull();
    expect(replacementForRetiredModel("gemini-3.1-flash-image")).toBeNull();
    expect(replacementForRetiredModel("gemini-3.8-flash")).toBeNull();
    expect(replacementForRetiredModel("gemini-3.1-flash-lite")).toBeNull();
    expect(replacementForRetiredModel("grok")).toBeNull();
  });

  test("small output limits on text requests are raised so answers are not cut off", () => {
    const out = applyTextModelPolicy({ model: "gemini-2.5-pro", config: { maxOutputTokens: 256, temperature: 0 } });
    expect(out.model).toBe("gemini-3.8-flash");
    expect(out.config.maxOutputTokens).toBe(GEMINI_TEXT_MIN_OUTPUT_TOKENS);
    expect(out.config.temperature).toBe(0);
    // Larger limits and requests without a limit are untouched.
    expect(applyTextModelPolicy({ model: "gemini-3.8-flash", config: { maxOutputTokens: 16384 } }).config.maxOutputTokens).toBe(16384);
    expect(applyTextModelPolicy<any>({ model: "gemini-3.8-flash", config: {} }).config.maxOutputTokens).toBeUndefined();
  });

  test("image requests are never changed", () => {
    const img = { model: "gemini-2.5-flash-image", config: { maxOutputTokens: 100 } };
    expect(applyTextModelPolicy(img)).toBe(img);
    const modal = { model: "gemini-2.0-flash-exp", config: { responseModalities: ["IMAGE", "TEXT"], maxOutputTokens: 100 } };
    expect(applyTextModelPolicy(modal)).toBe(modal);
  });

  test("the wrapped client applies the policy to every generateContent call", async () => {
    const seen: any[] = [];
    const client = { models: { generateContent: async (p: any) => { seen.push(p); return { ok: true }; } } };
    const wrapped = withTextModelPolicy(client);
    withTextModelPolicy(wrapped); // wrapping twice is harmless
    await wrapped.models.generateContent({ model: "gemini-2.5-flash", config: { maxOutputTokens: 300 } });
    expect(seen).toHaveLength(1);
    expect(seen[0].model).toBe("gemini-3.5-flash-lite");
    expect(seen[0].config.maxOutputTokens).toBe(GEMINI_TEXT_MIN_OUTPUT_TOKENS);
  });

  test("start-up audit names Railway variables still set to retiring models", () => {
    const prev = { ...process.env };
    process.env.OPENING_PRESERVATION_MODEL = "gemini-2.5-pro";
    process.env.GEMINI_VALIDATOR_MODEL_PRIMARY = "gemini-2.5-flash";
    process.env.ROOM_BRIEF_MODEL = "gemini-3.8-flash";
    const logs: string[] = [];
    const findings = auditModelEnvVars((m) => logs.push(m));
    process.env = prev;
    expect(findings).toEqual(
      expect.arrayContaining([
        "OPENING_PRESERVATION_MODEL=gemini-2.5-pro → set to gemini-3.8-flash",
        "GEMINI_VALIDATOR_MODEL_PRIMARY=gemini-2.5-flash → set to gemini-3.5-flash-lite",
      ])
    );
    expect(findings.some((f) => f.startsWith("ROOM_BRIEF_MODEL"))).toBe(false);
    expect(logs).toHaveLength(1);
  });
});
