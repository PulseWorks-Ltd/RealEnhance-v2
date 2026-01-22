// worker/src/validators/hybrid/geminiValidator.ts
// Gemini validation provider - structural + placement checks via Gemini vision.

import type { ValidationProvider, ValidationRequest, ValidationVerdict } from "./types";
import { loadHybridValidatorConfig } from "./config";
import { getGeminiClient } from "../../ai/gemini";

const STRUCTURAL_PROMPT = [
  'Return JSON only: {"ok": true|false, "confidence": 0.0-1.0, "reasons": ["..."]}',
  "Compare ORIGINAL vs EDITED. ok=false ONLY if the EDITED image alters fixed architectural features:",
  "- adds/removes/moves/resizes doors, windows, walls, ceilings, floors, stairs, pillars, beams, built-ins, fixed plumbing/electrical.",
  "- changes room perspective beyond minor lens/exposure correction.",
  "Allow staging furniture to overlap walls/floors visually; overlapping is NOT a structural violation.",
  "confidence = how certain you are about this verdict (0.0 = unsure, 1.0 = certain).",
].join("\n");

const PLACEMENT_PROMPT = [
  'Return JSON only: {"ok": true|false, "confidence": 0.0-1.0, "reasons": ["..."]}',
  "Compare ORIGINAL vs EDITED. ok=false if EDITED places objects in clearly unrealistic or unsafe positions:",
  "- blocking a DOOR or WINDOW,",
  "- overlapping fixed fixtures,",
  "- furniture not aligned to floor perspective.",
  "confidence = how certain you are (0.0 = unsure, 1.0 = certain).",
].join("\n");

/**
 * Gemini validator - wraps the same structural + placement prompts as compliance.ts
 * with the provider interface, timeout, and confidence scoring.
 */
export class GeminiValidator implements ValidationProvider {
  readonly name = "gemini" as const;

  private timeoutMs: number;
  private model: string;

  constructor() {
    const cfg = loadHybridValidatorConfig();
    this.timeoutMs = cfg.timeoutMs;
    this.model = cfg.geminiModel;
  }

  async validate(req: ValidationRequest): Promise<ValidationVerdict> {
    const ai = getGeminiClient();
    const t0 = Date.now();

    // Structural check
    const structResult = await this.callGemini(ai, req, STRUCTURAL_PROMPT);
    const latencyMs = Date.now() - t0;

    if (structResult.ok === false) {
      return {
        pass: false,
        confidence: structResult.confidence ?? 0.8,
        reasons: structResult.reasons || ["Structural change detected"],
        provider: "gemini",
        latencyMs,
      };
    }

    // Placement check
    const placementResult = await this.callGemini(ai, req, PLACEMENT_PROMPT);
    const totalLatency = Date.now() - t0;

    if (placementResult.ok === false) {
      return {
        pass: false,
        confidence: placementResult.confidence ?? 0.8,
        reasons: placementResult.reasons || ["Unrealistic/blocked placement"],
        provider: "gemini",
        latencyMs: totalLatency,
      };
    }

    return {
      pass: true,
      confidence: Math.min(structResult.confidence ?? 0.85, placementResult.confidence ?? 0.85),
      reasons: [],
      provider: "gemini",
      latencyMs: totalLatency,
    };
  }

  private async callGemini(
    ai: any,
    req: ValidationRequest,
    prompt: string
  ): Promise<{ ok?: boolean; confidence?: number; reasons?: string[] }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await ai.models.generateContent({
        model: this.model,
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              { text: "ORIGINAL:" },
              { inlineData: { mimeType: req.mimeType || "image/webp", data: req.originalB64 } },
              { text: "EDITED:" },
              { inlineData: { mimeType: req.mimeType || "image/webp", data: req.editedB64 } },
            ],
          },
        ],
      });

      const text =
        resp.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") || "{}";
      const cleaned = text.replace(/```json|```/g, "").trim();

      try {
        return JSON.parse(cleaned);
      } catch {
        return { ok: false, confidence: 0.0, reasons: ["JSON parse failed"] };
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
