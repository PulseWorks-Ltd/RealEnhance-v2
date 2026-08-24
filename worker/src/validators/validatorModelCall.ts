// Shared Grok/Gemini dual-model call helper for the two newest validator
// checks (windowArtworkCheck.ts, vanishedLandmarkCheck.ts) — generalizes
// fabricatedOpeningCheck.ts's private callModel, adding an optional
// per-call timeout. Deliberately NOT used by any already-shipped check
// (occlusionVsRemovalCheck.ts, fabricatedOpeningCheck.ts) to avoid
// regression risk on proven code; scoped to the two newest, least-proven
// checks only.
import { toBase64 } from "../utils/images";
import { getGeminiClient } from "../ai/gemini";
import { grokAnalyzeImages, grokVisionModel } from "../ai/grok";
import { logGeminiUsage } from "../ai/usageTelemetry";
import { resolveValidatorModel } from "./occlusionVsRemovalCheck";

export class ValidatorCallTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`validator call "${label}" timed out after ${timeoutMs}ms`);
    this.name = "ValidatorCallTimeoutError";
  }
}

function extractJson(text: string): any {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

async function callOnce(params: {
  images: { path: string; label: string }[];
  systemInstruction: string;
  userPrompt: string;
  model: string;
  reasonPrefix: string;
  maxOutputTokens?: number;
  ctx: { jobId: string; imageId: string; attempt?: number; callLabel: string };
}): Promise<any> {
  const loaded = params.images.map((img) => ({ ...toBase64(img.path), label: img.label }));
  const validatorModel = resolveValidatorModel();
  const requestStartedAt = Date.now();
  const fullReason = `${params.reasonPrefix}_${params.ctx.callLabel}`;

  if (validatorModel === "grok") {
    const text = await grokAnalyzeImages({
      images: loaded.map((l) => ({ buffer: Buffer.from(l.data, "base64"), mimeType: l.mime, label: l.label })),
      prompt: `${params.systemInstruction}\n\n${params.userPrompt}`,
      jobId: params.ctx.jobId,
      imageId: params.ctx.imageId,
      reason: fullReason,
      expectJson: true,
    });
    console.log(
      JSON.stringify({
        event: "GROK_VALIDATOR_USAGE",
        jobId: params.ctx.jobId,
        imageId: params.ctx.imageId,
        stage: "validator",
        callLabel: fullReason,
        model: grokVisionModel(),
        latencyMs: Date.now() - requestStartedAt,
      })
    );
    return extractJson(text);
  }

  const ai = getGeminiClient();
  const parts: any[] = [{ text: params.systemInstruction }, { text: params.userPrompt }];
  for (const l of loaded) {
    parts.push({ text: l.label });
    parts.push({ inlineData: { mimeType: l.mime, data: l.data } });
  }
  const response: any = await (ai as any).models.generateContent({
    model: params.model,
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0, topP: 0.1, topK: 1, maxOutputTokens: params.maxOutputTokens ?? 2048, responseMimeType: "application/json" },
  });
  logGeminiUsage({
    ctx: { jobId: params.ctx.jobId, imageId: params.ctx.imageId, stage: "validator", attempt: params.ctx.attempt ?? 1 },
    model: params.model,
    callType: "validator",
    response,
    latencyMs: Date.now() - requestStartedAt,
  });
  const responseParts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const textPart = responseParts.find((p: any) => typeof p?.text === "string");
  if (!textPart) throw new Error(`${params.reasonPrefix.toUpperCase()}[${params.ctx.callLabel}]: no text returned`);
  return extractJson(textPart.text);
}

export async function callValidatorModel(params: {
  images: { path: string; label: string }[];
  systemInstruction: string;
  userPrompt: string;
  model: string;
  reasonPrefix: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
  ctx: { jobId: string; imageId: string; attempt?: number; callLabel: string };
}): Promise<any> {
  if (!params.timeoutMs || params.timeoutMs <= 0) return callOnce(params);

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ValidatorCallTimeoutError(params.ctx.callLabel, params.timeoutMs!)), params.timeoutMs);
  });
  try {
    return await Promise.race([callOnce(params), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// Single flippable switch gating whether the two newest checks
// (window-artwork replacement, vanished-landmark) can actually block/retry
// a job. Defaults false (advisory-only): both checks still compute their
// full verdict and get logged via the existing [VALIDATOR_ADVISORY_NON_BLOCKING]
// path (status:"fail", hardFail:false), but cannot affect job outcome until
// this is flipped to "true" after a production observation period.
export function newValidatorChecksBlocking(): boolean {
  return String(process.env.NEW_VALIDATOR_CHECKS_BLOCKING || "false").trim().toLowerCase() === "true";
}
