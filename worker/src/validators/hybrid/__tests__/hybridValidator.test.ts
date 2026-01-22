import type { ValidationRequest, ValidationVerdict } from "../types";

// Mock the providers before importing
jest.mock("../stabilityValidator", () => ({
  StabilityValidator: jest.fn().mockImplementation(() => ({
    name: "stability" as const,
    validate: jest.fn(),
  })),
}));

jest.mock("../geminiValidator", () => ({
  GeminiValidator: jest.fn().mockImplementation(() => ({
    name: "gemini" as const,
    validate: jest.fn(),
  })),
}));

jest.mock("../config", () => ({
  loadHybridValidatorConfig: jest.fn(() => ({
    provider: "hybrid",
    confidenceThreshold: 0.75,
    geminiModel: "gemini-2.5-flash",
    debug: false,
    maxRetries: 2,
    timeoutMs: 15000,
  })),
}));

import { HybridValidator, createValidator } from "../hybridValidator";
import { StabilityValidator } from "../stabilityValidator";
import { GeminiValidator } from "../geminiValidator";
import { loadHybridValidatorConfig } from "../config";

const mockStabilityValidate = jest.fn();
const mockGeminiValidate = jest.fn();

function makeRequest(): ValidationRequest {
  return {
    originalB64: "base64original",
    editedB64: "base64edited",
    mimeType: "image/webp",
  };
}

function makeVerdict(overrides: Partial<ValidationVerdict> = {}): ValidationVerdict {
  return {
    pass: true,
    confidence: 0.9,
    reasons: [],
    provider: "stability",
    latencyMs: 100,
    ...overrides,
  };
}

describe("HybridValidator", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Wire up mock validate functions
    (StabilityValidator as jest.Mock).mockImplementation(() => ({
      name: "stability",
      validate: mockStabilityValidate,
    }));
    (GeminiValidator as jest.Mock).mockImplementation(() => ({
      name: "gemini",
      validate: mockGeminiValidate,
    }));
  });

  describe("provider selection", () => {
    test("provider=gemini only calls Gemini", async () => {
      (loadHybridValidatorConfig as jest.Mock).mockReturnValue({
        provider: "gemini",
        confidenceThreshold: 0.75,
        geminiModel: "gemini-2.5-flash",
        debug: false,
        maxRetries: 2,
        timeoutMs: 15000,
      });

      const geminiResult = makeVerdict({ provider: "gemini", confidence: 0.95 });
      mockGeminiValidate.mockResolvedValue(geminiResult);

      const validator = new HybridValidator();
      const result = await validator.validate(makeRequest());

      expect(result).toEqual(geminiResult);
      expect(mockGeminiValidate).toHaveBeenCalledTimes(1);
      expect(mockStabilityValidate).not.toHaveBeenCalled();
    });

    test("provider=stability only calls Stability", async () => {
      (loadHybridValidatorConfig as jest.Mock).mockReturnValue({
        provider: "stability",
        confidenceThreshold: 0.75,
        geminiModel: "gemini-2.5-flash",
        debug: false,
        maxRetries: 2,
        timeoutMs: 15000,
      });

      const stabilityResult = makeVerdict({ provider: "stability", confidence: 0.88 });
      mockStabilityValidate.mockResolvedValue(stabilityResult);

      const validator = new HybridValidator();
      const result = await validator.validate(makeRequest());

      expect(result).toEqual(stabilityResult);
      expect(mockStabilityValidate).toHaveBeenCalledTimes(1);
      expect(mockGeminiValidate).not.toHaveBeenCalled();
    });
  });

  describe("hybrid mode", () => {
    beforeEach(() => {
      (loadHybridValidatorConfig as jest.Mock).mockReturnValue({
        provider: "hybrid",
        confidenceThreshold: 0.75,
        geminiModel: "gemini-2.5-flash",
        debug: false,
        maxRetries: 2,
        timeoutMs: 15000,
      });
    });

    test("high-confidence Stability result accepted without escalation", async () => {
      const stabilityResult = makeVerdict({
        pass: true,
        provider: "stability",
        confidence: 0.92,
      });
      mockStabilityValidate.mockResolvedValue(stabilityResult);

      const validator = new HybridValidator();
      const result = await validator.validate(makeRequest());

      expect(result).toEqual(stabilityResult);
      expect(mockStabilityValidate).toHaveBeenCalledTimes(1);
      expect(mockGeminiValidate).not.toHaveBeenCalled();
    });

    test("high-confidence Stability FAIL accepted without escalation", async () => {
      const stabilityResult = makeVerdict({
        pass: false,
        provider: "stability",
        confidence: 0.88,
        reasons: ["Wall removed"],
      });
      mockStabilityValidate.mockResolvedValue(stabilityResult);

      const validator = new HybridValidator();
      const result = await validator.validate(makeRequest());

      expect(result.pass).toBe(false);
      expect(result.reasons).toContain("Wall removed");
      expect(mockGeminiValidate).not.toHaveBeenCalled();
    });

    test("low-confidence Stability escalates to Gemini", async () => {
      const lowConfidence = makeVerdict({
        pass: true,
        provider: "stability",
        confidence: 0.5, // below threshold of 0.75
      });
      const geminiResult = makeVerdict({
        pass: true,
        provider: "gemini",
        confidence: 0.9,
      });

      mockStabilityValidate.mockResolvedValue(lowConfidence);
      mockGeminiValidate.mockResolvedValue(geminiResult);

      const validator = new HybridValidator();
      const result = await validator.validate(makeRequest());

      expect(result).toEqual(geminiResult);
      expect(mockStabilityValidate).toHaveBeenCalledTimes(1);
      expect(mockGeminiValidate).toHaveBeenCalledTimes(1);
    });

    test("Stability error falls back to Gemini", async () => {
      mockStabilityValidate.mockRejectedValue(new Error("STABILITY_API_KEY not configured"));
      const geminiResult = makeVerdict({
        pass: false,
        provider: "gemini",
        confidence: 0.85,
        reasons: ["Door moved"],
      });
      mockGeminiValidate.mockResolvedValue(geminiResult);

      const validator = new HybridValidator();
      const result = await validator.validate(makeRequest());

      expect(result).toEqual(geminiResult);
      expect(result.provider).toBe("gemini");
      expect(mockStabilityValidate).toHaveBeenCalledTimes(1);
      expect(mockGeminiValidate).toHaveBeenCalledTimes(1);
    });

    test("both fail → fail-open (pass=true, confidence=0)", async () => {
      mockStabilityValidate.mockRejectedValue(new Error("Stability timeout"));
      mockGeminiValidate.mockRejectedValue(new Error("Gemini quota exceeded"));

      const validator = new HybridValidator();
      const result = await validator.validate(makeRequest());

      expect(result.pass).toBe(true);
      expect(result.confidence).toBe(0.0);
      expect(result.reasons).toContain("Both validation providers failed - failing open");
    });

    test("Stability low confidence + Gemini error → returns Stability result", async () => {
      // When Stability returns a result (even low confidence) and Gemini also fails,
      // we prefer the Stability result over total fail-open
      const stabilityResult = makeVerdict({
        pass: false,
        provider: "stability",
        confidence: 0.4, // below threshold
        reasons: ["Possible wall change"],
      });
      mockStabilityValidate.mockResolvedValue(stabilityResult);
      mockGeminiValidate.mockRejectedValue(new Error("Gemini unavailable"));

      const validator = new HybridValidator();
      const result = await validator.validate(makeRequest());

      // Falls back to stability result since gemini also failed
      expect(result).toEqual(stabilityResult);
    });
  });

  describe("createValidator factory", () => {
    test("returns a working HybridValidator instance", () => {
      (loadHybridValidatorConfig as jest.Mock).mockReturnValue({
        provider: "hybrid",
        confidenceThreshold: 0.75,
        geminiModel: "gemini-2.5-flash",
        debug: false,
        maxRetries: 2,
        timeoutMs: 15000,
      });

      const validator = createValidator();
      expect(validator).toBeInstanceOf(HybridValidator);
      expect(validator.validate).toBeDefined();
    });

    test("accepts config overrides", () => {
      (loadHybridValidatorConfig as jest.Mock).mockReturnValue({
        provider: "hybrid",
        confidenceThreshold: 0.75,
        geminiModel: "gemini-2.5-flash",
        debug: false,
        maxRetries: 2,
        timeoutMs: 15000,
      });

      const validator = createValidator({ provider: "gemini", debug: true });
      expect(validator).toBeInstanceOf(HybridValidator);
    });
  });

  describe("output shape validation", () => {
    test("verdict contains all required fields", async () => {
      (loadHybridValidatorConfig as jest.Mock).mockReturnValue({
        provider: "stability",
        confidenceThreshold: 0.75,
        geminiModel: "gemini-2.5-flash",
        debug: false,
        maxRetries: 2,
        timeoutMs: 15000,
      });

      mockStabilityValidate.mockResolvedValue(
        makeVerdict({ pass: true, confidence: 0.95, reasons: [], provider: "stability", latencyMs: 42 })
      );

      const validator = new HybridValidator();
      const result = await validator.validate(makeRequest());

      // Verify shape
      expect(typeof result.pass).toBe("boolean");
      expect(typeof result.confidence).toBe("number");
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(Array.isArray(result.reasons)).toBe(true);
      expect(["stability", "gemini"]).toContain(result.provider);
      expect(typeof result.latencyMs).toBe("number");
    });

    test("fail-open verdict has correct shape", async () => {
      (loadHybridValidatorConfig as jest.Mock).mockReturnValue({
        provider: "hybrid",
        confidenceThreshold: 0.75,
        geminiModel: "gemini-2.5-flash",
        debug: false,
        maxRetries: 2,
        timeoutMs: 15000,
      });

      mockStabilityValidate.mockRejectedValue(new Error("fail"));
      mockGeminiValidate.mockRejectedValue(new Error("fail"));

      const validator = new HybridValidator();
      const result = await validator.validate(makeRequest());

      expect(result.pass).toBe(true);
      expect(result.confidence).toBe(0);
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(typeof result.provider).toBe("string");
      expect(typeof result.latencyMs).toBe("number");
    });
  });
});
