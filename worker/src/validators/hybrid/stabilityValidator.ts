// worker/src/validators/hybrid/stabilityValidator.ts
// Stability AI validation provider - uses image comparison for structural validation.

import fetch from "node-fetch";
import FormData from "form-data";
import type { ValidationProvider, ValidationRequest, ValidationVerdict } from "./types";
import { loadHybridValidatorConfig } from "./config";

const STABILITY_VALIDATION_URL =
  process.env.STABILITY_VALIDATION_URL ||
  "https://api.stability.ai/v2beta/stable-image/control/structure";

/**
 * Stability AI validator.
 *
 * Sends both original and edited images to the configured Stability endpoint
 * for structural comparison analysis. Uses the same node-fetch + FormData
 * pattern as the existing Stability upscaler in the codebase.
 *
 * The endpoint and response parsing are encapsulated so they can be swapped
 * when Stability releases a dedicated validation API.
 */
export class StabilityValidator implements ValidationProvider {
  readonly name = "stability" as const;

  private apiKey: string;
  private timeoutMs: number;

  constructor() {
    this.apiKey = process.env.STABILITY_API_KEY || "";
    this.timeoutMs = loadHybridValidatorConfig().timeoutMs;
  }

  async validate(req: ValidationRequest): Promise<ValidationVerdict> {
    if (!this.apiKey) {
      throw new Error("STABILITY_API_KEY not configured");
    }

    const t0 = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const prompt = "Structural consistency check: ensure edited image preserves fixed architecture (walls, windows, doors, ceilings, floors) compared to original. Return similarity score.";
      const outputFormatEnv = (process.env.STABILITY_OUTPUT_FORMAT || "webp").toLowerCase();
      const allowedFormats: Array<"webp" | "png" | "jpeg"> = ["webp", "png", "jpeg"];
      const outputFormat = (allowedFormats as string[]).includes(outputFormatEnv) ? (outputFormatEnv as "webp" | "png" | "jpeg") : "webp";

      if (!prompt.trim()) {
        throw new Error("Stability: prompt is required");
      }
      if (!allowedFormats.includes(outputFormat)) {
        throw new Error("Stability: invalid output_format");
      }

      const form = new FormData();
      form.append("image", Buffer.from(req.originalB64, "base64"), {
        filename: "original.webp",
        contentType: req.mimeType || "image/webp",
      });
      form.append("control_image", Buffer.from(req.editedB64, "base64"), {
        filename: "edited.webp",
        contentType: req.mimeType || "image/webp",
      });
      form.append("prompt", prompt);
      form.append("output_format", outputFormat);

      const res = await fetch(STABILITY_VALIDATION_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
        body: form as any,
        signal: controller.signal as any,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "unknown error");
        throw new Error(`Stability API ${res.status}: ${errText.slice(0, 200)}`);
      }

      const result: any = await res.json();
      const latencyMs = Date.now() - t0;

      // Parse Stability response into normalized verdict.
      // Field names depend on endpoint; use sensible defaults.
      const confidence: number = result.similarity_score ?? result.confidence ?? result.score ?? 0.5;
      const structuralMatch = confidence >= 0.75;

      return {
        pass: structuralMatch,
        confidence,
        reasons: structuralMatch ? [] : [result.reason || "Structural divergence detected"],
        provider: "stability",
        latencyMs,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
