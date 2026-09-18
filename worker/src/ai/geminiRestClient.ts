import fetch from "node-fetch";

// Image-quality fix (2026-09-18): the installed @google/genai SDK (0.7.0)
// predates Gemini 3's generationConfig.imageConfig field entirely — verified
// directly in the SDK's own request-builder source
// (generateContentConfigToMldev maps an explicit field allowlist and has no
// imageConfig entry), and confirmed empirically: requesting imageSize "2K"
// and "4K" through the SDK both silently returned the same ~1MP output as no
// config at all. Upgrading the SDK (0.7.0 -> 2.23.0 latest) is a 2+ major
// version jump used extensively across this codebase (Stage 1A/1B/2, region
// edits) and out of scope here. This module instead makes a raw REST call
// for ONLY the one new call site that needs imageConfig (Stage 1A exterior),
// bypassing the SDK's field allowlist entirely — mirroring the pattern
// already used for Stability AI in stabilityConservativeUpscaleStage1A.ts
// (raw node-fetch, no SDK). Every other Gemini call site in this codebase
// (Stage 1A interior, 1B, 2, edits) is untouched and keeps using the SDK.
const GEMINI_REST_BASE_URL = process.env.GEMINI_REST_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiRestImageConfig {
  imageSize: string;
  aspectRatio?: string;
}

export interface GeminiRestGenerateContentBody {
  contents: any[];
  generationConfig?: {
    temperature?: number;
    topP?: number;
    topK?: number;
    imageConfig?: GeminiRestImageConfig;
  };
}

/**
 * Raw REST call to Gemini's generateContent endpoint. Returns the parsed JSON
 * response, which has the same shape (`candidates[].content.parts[]`,
 * `usageMetadata`) that the @google/genai SDK's `resp` object exposes, so it
 * is a drop-in for the existing `isValidImageResponse`/`logGeminiUsage`
 * helpers in runWithImageModelFallback.ts.
 */
// The @google/genai SDK accepts a flat array of Part-like objects
// (`{inlineData}`, `{text}`) as `contents` and silently wraps it into the
// real API shape (`contents: [{role, parts: [...]}]`) before sending. This
// codebase's callers (see gemini.ts's `requestParts`) rely on that SDK
// convenience and pass the flat form — the raw REST API does NOT do this
// wrapping, so it must happen here instead (confirmed via a live 400:
// "Unknown name 'inlineData' at 'contents[0]'" before this normalization
// was added).
function normalizeContentsForRest(contents: any[]): any[] {
  if (!Array.isArray(contents) || contents.length === 0) return contents;
  const alreadyWrapped = contents.every((entry) => entry && typeof entry === "object" && ("role" in entry || "parts" in entry));
  if (alreadyWrapped) return contents;
  return [{ role: "user", parts: contents }];
}

export async function generateContentViaRest(params: {
  apiKey: string;
  model: string;
  body: GeminiRestGenerateContentBody;
  timeoutMs?: number;
}): Promise<any> {
  const { apiKey, model, timeoutMs = 120000 } = params;
  const body: GeminiRestGenerateContentBody = {
    ...params.body,
    contents: normalizeContentsForRest(params.body.contents),
  };
  const url = `${GEMINI_REST_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res: import("node-fetch").Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal as any,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      const timeoutErr: any = new Error(`Gemini REST call timed out after ${timeoutMs}ms (model=${model})`);
      timeoutErr.code = "ETIMEDOUT";
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // Leave json as {} — isValidImageResponse will correctly report "no candidates".
  }

  if (!res.ok) {
    const message = json?.error?.message || res.statusText || "unknown error";
    const error: any = new Error(`Gemini REST call failed (${res.status}): ${message} (model=${model})`);
    error.status = res.status;
    error.body = text.slice(0, 1000);
    throw error;
  }

  return json;
}
