// worker/src/validators/hybrid/config.ts
// Configuration for the hybrid validation system.

export interface HybridValidatorConfig {
  provider: "stability" | "gemini" | "hybrid";
  confidenceThreshold: number;
  geminiModel: string;
  debug: boolean;
  maxRetries: number;
  timeoutMs: number;
}

export function loadHybridValidatorConfig(): HybridValidatorConfig {
  return {
    provider: (process.env.VALIDATION_PROVIDER || "hybrid") as HybridValidatorConfig["provider"],
    confidenceThreshold: parseFloat(process.env.VALIDATION_CONF_THRESHOLD || "0.75"),
    geminiModel: process.env.GEMINI_VALIDATION_MODEL || "gemini-2.5-flash",
    debug: process.env.VALIDATION_DEBUG === "1" || process.env.VALIDATION_DEBUG === "true",
    maxRetries: parseInt(process.env.MAX_VALIDATION_RETRIES || "2", 10),
    timeoutMs: 15_000,
  };
}
