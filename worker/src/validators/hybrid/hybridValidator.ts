// worker/src/validators/hybrid/hybridValidator.ts
// Orchestrator: Stability primary, Gemini fallback/escalation.

import type { ValidationProvider, ValidationRequest, ValidationVerdict } from "./types";
import { StabilityValidator } from "./stabilityValidator";
import { GeminiValidator } from "./geminiValidator";
import { loadHybridValidatorConfig, type HybridValidatorConfig } from "./config";

/**
 * Hybrid validator orchestrator.
 *
 * Flow:
 * - provider="stability" → only Stability
 * - provider="gemini"    → only Gemini
 * - provider="hybrid"    → Stability first; escalate to Gemini on low confidence or error
 *
 * Escalation rules:
 * - pass=true/false AND confidence >= threshold → accept result
 * - confidence < threshold OR error/timeout     → escalate to Gemini
 * - Both fail → fail-open (allow image through with confidence=0)
 */
export class HybridValidator implements ValidationProvider {
  readonly name = "stability" as const; // reports actual provider in verdict

  private config: HybridValidatorConfig;
  private stability: StabilityValidator;
  private gemini: GeminiValidator;

  constructor(configOverride?: Partial<HybridValidatorConfig>) {
    this.config = { ...loadHybridValidatorConfig(), ...configOverride };
    this.stability = new StabilityValidator();
    this.gemini = new GeminiValidator();
  }

  async validate(req: ValidationRequest): Promise<ValidationVerdict> {
    const { provider, confidenceThreshold, debug } = this.config;

    if (provider === "gemini") {
      const result = await this.gemini.validate(req);
      if (debug) this.logResult("gemini-only", result);
      return result;
    }

    if (provider === "stability") {
      const result = await this.stability.validate(req);
      if (debug) this.logResult("stability-only", result);
      return result;
    }

    // Hybrid mode: Stability primary, Gemini fallback
    let stabilityResult: ValidationVerdict | null = null;

    try {
      stabilityResult = await this.stability.validate(req);

      if (debug) this.logResult("stability-primary", stabilityResult);

      // High confidence → accept
      if (stabilityResult.confidence >= confidenceThreshold) {
        console.log(
          `[HYBRID_VALIDATOR] provider=stability pass=${stabilityResult.pass} confidence=${stabilityResult.confidence.toFixed(2)} latencyMs=${stabilityResult.latencyMs}`
        );
        return stabilityResult;
      }

      // Low confidence → escalate
      if (debug) {
        console.log(
          `[HYBRID_VALIDATOR] Stability low confidence (${stabilityResult.confidence.toFixed(2)} < ${confidenceThreshold}), escalating to Gemini`
        );
      }
    } catch (err: any) {
      console.warn(`[HYBRID_VALIDATOR] Stability error: ${err?.message}, falling back to Gemini`);
    }

    // Escalate to Gemini
    try {
      const geminiResult = await this.gemini.validate(req);

      if (debug) this.logResult("gemini-fallback", geminiResult);

      console.log(
        `[HYBRID_VALIDATOR] provider=gemini pass=${geminiResult.pass} confidence=${geminiResult.confidence.toFixed(2)} latencyMs=${geminiResult.latencyMs}`
      );
      return geminiResult;
    } catch (geminiErr: any) {
      // Both failed
      if (stabilityResult) {
        console.warn(
          `[HYBRID_VALIDATOR] Gemini also failed (${geminiErr?.message}), using Stability result (confidence: ${stabilityResult.confidence.toFixed(2)})`
        );
        return stabilityResult;
      }

      // Total failure → fail-open
      console.error("[HYBRID_VALIDATOR] Both providers failed. Failing open.");
      return {
        pass: true,
        confidence: 0.0,
        reasons: ["Both validation providers failed - failing open"],
        provider: "gemini",
        latencyMs: 0,
      };
    }
  }

  private logResult(label: string, result: ValidationVerdict): void {
    console.log(
      `[HYBRID_VALIDATOR] [${label}] pass=${result.pass} confidence=${result.confidence.toFixed(2)} reasons=${JSON.stringify(result.reasons)} latencyMs=${result.latencyMs}`
    );
  }
}

/**
 * Factory function - creates the hybrid validator with the active configuration.
 */
export function createValidator(configOverride?: Partial<HybridValidatorConfig>): HybridValidator {
  return new HybridValidator(configOverride);
}
