import fs from "fs/promises";
import { getAdminConfig } from "../utils/adminConfig";
import { siblingOutPath, toBase64, writeImageDataUrl } from "../utils/images";
import { focusLog } from "../utils/logFocus";
import { buildGeminiPrompt } from "./gemini";

const XAI_API_BASE = "https://api.x.ai/v1";

export function resolveXaiApiKey(): string | undefined {
  return process.env.XAI_API_KEY;
}

function getXaiApiKey(): string {
  const key = resolveXaiApiKey();
  if (!key) {
    throw new Error("XAI_API_KEY missing: set it in the worker service env to enable Grok image generation/validation");
  }
  return key;
}

function grokImageModel(): string {
  return process.env.GROK_IMAGE_MODEL || "grok-imagine-image-quality";
}

function grokVisionModel(): string {
  return process.env.GROK_VISION_MODEL || "grok-4.5";
}

async function xaiFetch(pathname: string, body: any, timeoutMs = 120_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${XAI_API_BASE}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getXaiApiKey()}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`xAI ${pathname} failed: ${resp.status} ${resp.statusText} — ${text.slice(0, 2000)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`xAI ${pathname} returned non-JSON response: ${text.slice(0, 500)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Image generation / editing — POST /v1/images/edits
// ---------------------------------------------------------------------------

export interface GrokImageEditArgs {
  imageBuffer: Buffer;
  mimeType?: string;
  prompt: string;
  referenceImages?: Buffer[];
  jobId?: string;
  imageId?: string;
  reason?: string;
}

export async function grokImageEdit(args: GrokImageEditArgs): Promise<{ buffer: Buffer; mimeType: string }> {
  const { imageBuffer, mimeType = "image/webp", prompt, referenceImages = [], jobId, imageId, reason } = args;
  if (!imageBuffer?.length) throw new Error("Grok image edit requires a non-empty image buffer");
  if (!prompt?.trim()) throw new Error("Grok image edit requires a non-empty prompt");

  const toDataUri = (buf: Buffer, mt: string) => `data:${mt};base64,${buf.toString("base64")}`;
  // xAI supports up to 3 source images per edit request; primary image first.
  const images = [imageBuffer, ...referenceImages.slice(0, 2)].map((buf) => ({
    type: "image_url",
    image_url: toDataUri(buf, mimeType),
  }));

  focusLog("GROK_EDIT_START", "[grok.imageEdit] starting", {
    jobId, imageId, reason, promptLength: prompt.length, referenceImageCount: referenceImages.length,
  });

  const apiStart = Date.now();
  const model = grokImageModel();
  const json = await xaiFetch("/images/edits", {
    model,
    prompt,
    image: images.length === 1 ? images[0] : images,
  });
  const apiMs = Date.now() - apiStart;

  const first = json?.data?.[0] ?? json?.images?.[0] ?? (json?.url || json?.b64_json ? json : null);
  const outUrl: string | undefined = first?.url;
  const outB64: string | undefined = first?.b64_json;

  if (!outUrl && !outB64) {
    console.error("[grok.imageEdit] no image in response", JSON.stringify(json).slice(0, 2000));
    throw new Error("Grok image edit returned no image data");
  }

  let outBuffer: Buffer;
  if (outB64) {
    outBuffer = Buffer.from(outB64, "base64");
  } else {
    const imgResp = await fetch(outUrl!);
    if (!imgResp.ok) throw new Error(`Failed to download Grok edit output image: ${imgResp.status}`);
    outBuffer = Buffer.from(await imgResp.arrayBuffer());
  }

  focusLog("GROK_EDIT_RESPONSE", "[grok.imageEdit] response received", {
    jobId, imageId, apiMs, model, bytes: outBuffer.length,
  });

  return { buffer: outBuffer, mimeType: "image/png" };
}

// ---------------------------------------------------------------------------
// Full-image enhance/declutter/stage — mirrors ai/gemini.ts's enhanceWithGemini
// contract so Stage 1A/1B/2 callers need only swap the import.
// ---------------------------------------------------------------------------

export interface EnhanceWithGrokOptions {
  declutter?: boolean;
  sceneType?: "interior" | "exterior" | string;
  stage?: "1A" | "1B" | "2";
  strictMode?: boolean;
  jobId: string;
  imageId: string;
  roomType?: string;
  modelReason?: string;
  promptOverride?: string;
  declutterIntensity?: "light" | "standard" | "heavy";
  outputPath?: string;
  referenceImageBuffers?: Buffer[];
}

export async function enhanceWithGrok(inputPath: string, options: EnhanceWithGrokOptions): Promise<string> {
  const {
    declutter = false,
    sceneType,
    stage,
    strictMode = false,
    promptOverride,
    declutterIntensity,
    jobId,
    imageId,
    roomType,
    modelReason,
    outputPath,
    referenceImageBuffers,
  } = options;

  const apiKey = resolveXaiApiKey();
  if (!apiKey) {
    console.error("❌ FATAL: XAI_API_KEY not configured — cannot continue Grok pipeline.");
    throw new Error("XAI_API_KEY missing for Grok enhancement — aborting job.");
  }

  const operationType = declutter ? "Enhance + Declutter" : "Enhance";
  focusLog("GROK_START", `🤖 Starting Grok AI ${operationType} (stage: ${stage || "unspecified"})...`);
  focusLog("GROK_INPUT", `[Grok] 🔵 Input path: ${inputPath}`);

  try {
    let di = declutterIntensity;
    if (!di) {
      try {
        const admin = await getAdminConfig();
        const sceneKey = sceneType === "interior" ? "interior" : (sceneType === "exterior" ? "exterior" : undefined);
        const byScene = sceneKey ? admin.declutterIntensityByScene?.[sceneKey] : undefined;
        const intensity = byScene || admin.declutterIntensity;
        if (intensity && ["light", "standard", "heavy"].includes(intensity)) {
          di = intensity as any;
        }
      } catch {}
      if (!di) {
        const envScene = sceneType === "interior"
          ? process.env.GEMINI_DECLUTTER_INTENSITY_INTERIOR
          : (sceneType === "exterior" ? process.env.GEMINI_DECLUTTER_INTENSITY_EXTERIOR : undefined);
        const envGlobal = process.env.GEMINI_DECLUTTER_INTENSITY;
        const val = (envScene || envGlobal || "").trim().toLowerCase();
        if (["light", "standard", "heavy"].includes(val)) {
          di = val as any;
        }
      }
    }

    const prompt = (typeof promptOverride === "string" && promptOverride.length > 0)
      ? promptOverride
      : buildGeminiPrompt({
          goal: declutter ? "Declutter and enhance image" : "Enhance image",
          sceneType: sceneType === "interior" || sceneType === "exterior" ? sceneType : "auto",
          declutterLevel: di,
          stage,
          strictMode,
        });
    focusLog("GROK_PROMPT", `[Grok] 📝 Prompt length: ${prompt.length} chars`);

    const { data, mime } = toBase64(inputPath);
    const imageBuffer = Buffer.from(data, "base64");

    const modelLogReason = modelReason
      || (roomType ? `${roomType} → ${stage === "1B" ? "declutter" : (stage === "2" ? "staging" : "enhance")}` : (stage === "1B" ? "declutter" : (stage === "2" ? "staging" : "enhance")));

    const { buffer: outImageBuffer } = await grokImageEdit({
      imageBuffer,
      mimeType: mime,
      prompt,
      referenceImages: referenceImageBuffers,
      jobId,
      imageId,
      reason: modelLogReason,
    });

    const suffix = declutter ? "-grok-1B" : "-grok-1A";
    const out = outputPath || siblingOutPath(inputPath, suffix, ".webp");
    if (outputPath) {
      try {
        await fs.access(out);
        throw new Error(`[Grok] Output path already exists: ${out}`);
      } catch (err: any) {
        if (err?.code !== "ENOENT") throw err;
      }
    }

    const sharp = require("sharp");
    const webpBuffer: Buffer = await sharp(outImageBuffer).webp({ quality: 92 }).toBuffer();
    writeImageDataUrl(out, `data:image/webp;base64,${webpBuffer.toString("base64")}`);
    focusLog("GROK_SAVE", `[Grok] 💾 Saved enhanced image to: ${out}`);
    return out;
  } catch (error) {
    console.error(`❌ FATAL: Grok ${operationType} failed — cannot continue AI pipeline.`);
    console.error("Error details:", error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Vision analysis / validation — POST /v1/responses
// ---------------------------------------------------------------------------

export interface GrokAnalyzeImagesArgs {
  images: Array<{ buffer: Buffer; mimeType?: string; label?: string }>;
  prompt: string;
  jobId?: string;
  imageId?: string;
  reason?: string;
  timeoutMs?: number;
  /** Append a "respond with JSON only" instruction. Default true; set false for plain-text verdicts (e.g. "PASS or FAIL"). */
  expectJson?: boolean;
}

export async function grokAnalyzeImages(args: GrokAnalyzeImagesArgs): Promise<string> {
  const { images, prompt, jobId, imageId, reason, timeoutMs, expectJson = true } = args;
  if (!images?.length) throw new Error("Grok image analysis requires at least one image");
  if (!prompt?.trim()) throw new Error("Grok image analysis requires a non-empty prompt");

  const content: any[] = [];
  for (const img of images) {
    if (img.label) content.push({ type: "input_text", text: img.label });
    content.push({
      type: "input_image",
      image_url: `data:${img.mimeType || "image/webp"};base64,${img.buffer.toString("base64")}`,
    });
  }
  content.push({
    type: "input_text",
    text: expectJson
      ? `${prompt}\n\nRespond with ONLY a single valid JSON object. No markdown, no prose, no code fences.`
      : prompt,
  });

  focusLog("GROK_ANALYZE_START", "[grok.analyzeImages] starting", {
    jobId, imageId, reason, promptLength: prompt.length, imageCount: images.length,
  });

  const apiStart = Date.now();
  const model = grokVisionModel();
  const json = await xaiFetch("/responses", {
    model,
    input: [{ role: "user", content }],
  }, timeoutMs ?? 120_000);
  const apiMs = Date.now() - apiStart;

  const text = extractResponseText(json);
  focusLog("GROK_ANALYZE_RESPONSE", "[grok.analyzeImages] response received", {
    jobId, imageId, apiMs, model, textLength: text.length,
  });

  if (!text.trim()) {
    console.error("[grok.analyzeImages] empty response", JSON.stringify(json).slice(0, 2000));
    throw new Error("Grok image analysis returned no text");
  }
  return text;
}

function extractResponseText(json: any): string {
  if (typeof json?.output_text === "string" && json.output_text.length) return json.output_text;
  const output = json?.output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === "string") parts.push(c.text);
        }
      }
    }
    if (parts.length) return parts.join("\n");
  }
  if (typeof json?.choices?.[0]?.message?.content === "string") return json.choices[0].message.content;
  return "";
}
