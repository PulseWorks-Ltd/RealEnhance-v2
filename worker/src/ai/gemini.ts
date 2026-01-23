export interface RegionEditArgs {
  prompt: string;
  baseImageBuffer: Buffer;
  maskPngBuffer?: Buffer;
  roomType?: string;
  sceneType?: string;
  preserveStructure?: boolean;
}

export async function regionEditWithGemini(args: RegionEditArgs): Promise<Buffer> {
  const {
    prompt,
    baseImageBuffer,
    maskPngBuffer,
    roomType,
    sceneType,
    preserveStructure,
  } = args;

  console.log("[gemini.regionEdit] starting", {
    promptLength: prompt.length,
    hasMask: !!maskPngBuffer,
    baseSize: baseImageBuffer.length,
    roomType,
    sceneType,
    preserveStructure,
  });

  const parts: any[] = [
    { text: prompt },
    {
      inlineData: {
        mimeType: "image/webp",
        data: baseImageBuffer.toString("base64"),
      },
    },
  ];
  if (maskPngBuffer) {
    parts.push({
      inlineData: {
        mimeType: "image/png",
        data: maskPngBuffer.toString("base64"),
      },
    });
  }
  const contents = [
    {
      role: "user",
      parts,
    },
  ];

  // Use the same fallback helper as 1A/1B
  const { resp } = await runWithImageModelFallback(getGeminiClient(), { contents }, "[gemini.regionEdit]", { stage: "region-edit" });

  const candidates = resp.candidates ?? [];
  const usable =
    candidates.find(
      (c: any) =>
        !c.finishReason ||
        c.finishReason === "STOP" ||
        c.finishReason === "FINISH_REASON_UNSPECIFIED"
    ) ?? candidates[0];
  // Debug: log mask buffer stats
  if (maskPngBuffer) {
    const sharpStats = await require('sharp')(maskPngBuffer).stats();
    console.log('[regionEditWithGemini] Received maskPngBuffer:', {
      width: sharpStats.width,
      height: sharpStats.height,
      channels: sharpStats.channels,
      min: sharpStats.channels.map((c:any)=>c.min),
      max: sharpStats.channels.map((c:any)=>c.max),
      sum: sharpStats.channels.map((c:any)=>c.sum),
    });
  }

  if (!usable?.content?.parts?.length) {
    console.error(
      "[gemini.regionEdit] no usable content parts",
      JSON.stringify(usable, null, 2)
    );
    throw new Error("No image content in Gemini region edit response");
  }

  const imagePart = usable.content.parts.find(
    (p: any) => p.inlineData && p.inlineData.data
  );

  if (!imagePart || !imagePart.inlineData) {
    console.error(
      "[gemini.regionEdit] no inlineData image part",
      JSON.stringify(usable.content.parts, null, 2)
    );
    throw new Error("No image data in Gemini region edit response");
  }

  const base64Image = imagePart.inlineData.data as string;
  return Buffer.from(base64Image, "base64");
}
import type { GoogleGenAI } from "@google/genai";
import fs from "fs/promises";
import path from "path";
import { runWithImageModelFallback, runWithPrimaryThenFallback } from "./runWithImageModelFallback";
import { getAdminConfig } from "../utils/adminConfig";
import { siblingOutPath, toBase64, writeImageDataUrl } from "../utils/images";
import { buildPrompt, PromptOptions } from "./prompt";
import { buildTestStage1APrompt, buildTestStage1BPrompt, buildTestStage2Prompt, tightenPromptAndLowerTemp } from "./prompts-test";

let singleton: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (singleton) return singleton as any;
  const apiKey = process.env.REALENHANCE_API_KEY;
  if (!apiKey) {
    throw new Error("REALENHANCE_API_KEY missing: set it in the worker service env to enable Gemini image generation");
  }
  // The SDK exports types; instantiate via any to avoid type ctor mismatches
  const Ctor: any = require("@google/genai").GoogleGenAI;
  singleton = new Ctor({ apiKey });
  return singleton as any;
}

function buildGeminiPrompt(options: PromptOptions & { stage?: "1A"|"1B"|"2"; strictMode?: boolean }): string {
  const useTest = process.env.USE_TEST_PROMPTS === "1";
  const stage = options as any as { stage?: "1A"|"1B"|"2"; };
  if (useTest && stage.stage) {
    const scene = (options.sceneType === "interior" || options.sceneType === "exterior") ? options.sceneType : "interior";
    let p = stage.stage === "1A"
      ? buildTestStage1APrompt(scene as any, (options as any).roomType)
      : stage.stage === "1B"
      ? buildTestStage1BPrompt(scene as any, (options as any).roomType)
      : buildTestStage2Prompt(scene as any, (options as any).roomType);
    if ((options as any).strictMode) {
      p = tightenPromptAndLowerTemp(p, 0.8);
    }
    return p;
  }
  return buildPrompt(options);
}

/**
 * Enhance an image using Gemini's vision and image editing capabilities
 * Can perform either:
 * 1. Enhance-only (quality improvements, no structural changes)
 * 2. Enhance + Declutter (combined in one call to save API costs)
 *
 * Model selection (per-stage with safe fallback):
 * - Stage 1A: gemini-2.5-flash-image (no fallback)
 * - Stage 1B: gemini-3-pro-image-preview → fallback to gemini-2.5-flash-image
 * - Stage 2:  gemini-2.5-flash-image (no fallback)
 *
 * Environment variables (optional overrides):
 * - REALENHANCE_MODEL_STAGE1A_PRIMARY
 * - REALENHANCE_MODEL_STAGE1B_PRIMARY, REALENHANCE_MODEL_STAGE1B_FALLBACK
 * - REALENHANCE_MODEL_STAGE2_PRIMARY
 */
export async function enhanceWithGemini(
  inputPath: string,
  options: {
    skipIfNoApiKey?: boolean;
    replaceSky?: boolean;
    declutter?: boolean;
    sceneType?: "interior" | "exterior" | string;
    stage?: "1A" | "1B" | "2";  // Added to determine model selection
    strictMode?: boolean;          // Stricter constraints
    // Sampling controls (optional overrides)
    temperature?: number;
    topP?: number;
    topK?: number;
    // Optional direct prompt override (NZ style wiring)
    promptOverride?: string;
    // Optional, mild cleanup helpers
    floorClean?: boolean;
    hardscapeClean?: boolean;
    declutterIntensity?: "light" | "standard" | "heavy";
    jobId?: string;
    imageId?: string;
  } = {}
): Promise<string> {
  const { skipIfNoApiKey = true, replaceSky = false, declutter = false, sceneType, stage, strictMode = false, temperature, topP, topK, promptOverride, floorClean = false, hardscapeClean = false, declutterIntensity, jobId, imageId } = options;

  // Check if Gemini API key is available
  const apiKey = process.env.REALENHANCE_API_KEY;
  if (!apiKey) {
    console.error("❌ FATAL: Gemini API key not configured — cannot continue AI pipeline.");
    throw new Error("REALENHANCE_API_KEY missing for Gemini enhancement — aborting job.");
  }

  const operationType = declutter ? "Enhance + Declutter" : "Enhance";
  console.log(`🤖 Starting Gemini AI ${operationType} (stage: ${stage || 'unspecified'}) jobId=${jobId || 'n/a'} imageId=${imageId || 'n/a'}`);
  console.log(`[Gemini] 🔵 Input path: ${inputPath}`);
  console.log(`[Gemini] 🔵 Scene type: ${sceneType}, replaceSky: ${replaceSky}, declutter: ${declutter}`);

  // Log model selection strategy
  if (stage === "1A") {
    console.log(`[Gemini] 📋 Model strategy: Stage 1A uses Gemini 2.5 (no fallback)`);
  } else if (stage === "1B") {
    console.log(`[Gemini] 📋 Model strategy: Stage 1B primary=Gemini 3, fallback=Gemini 2.5`);
  } else if (stage === "2") {
    console.log(`[Gemini] 📋 Model strategy: Stage 2 uses Gemini 2.5 (no fallback)`);
  }

  try {
    const client = getGeminiClient();
    console.log(`[Gemini] ✓ Gemini client initialized`);

    // Build prompt and image parts
    // Map config-based declutter intensity to env for prompt builder (kept sync)
    let di = declutterIntensity;
    if (!di) {
      try {
        const admin = await getAdminConfig();
        const sceneKey = sceneType === 'interior' ? 'interior' : (sceneType === 'exterior' ? 'exterior' : undefined);
        const byScene = sceneKey ? admin.declutterIntensityByScene?.[sceneKey] : undefined;
        const intensity = byScene || admin.declutterIntensity;
        if (intensity && ['light','standard','heavy'].includes(intensity)) {
          di = intensity as any;
        }
      } catch {}
      // Env-based per-scene override if still not set
      if (!di) {
        const envScene = sceneType === 'interior'
          ? process.env.GEMINI_DECLUTTER_INTENSITY_INTERIOR
          : (sceneType === 'exterior' ? process.env.GEMINI_DECLUTTER_INTENSITY_EXTERIOR : undefined);
        const envGlobal = process.env.GEMINI_DECLUTTER_INTENSITY;
        const val = (envScene || envGlobal || '').trim().toLowerCase();
        if (['light','standard','heavy'].includes(val)) {
          di = val as any;
        }
      }
    }
    // Ensure sceneType matches PromptOptions type
    const prompt = (typeof promptOverride === 'string' && promptOverride.length > 0)
      ? promptOverride
      : buildGeminiPrompt({
          goal: declutter ? "Declutter and enhance image" : "Enhance image", // Default goal
          sceneType: sceneType === "interior" || sceneType === "exterior" ? sceneType : "auto",
          declutterLevel: di,
          stage: stage,
          strictMode: strictMode,
          // Add other valid PromptOptions properties here as needed
        });
    console.log(`[Gemini] 📝 Prompt length: ${prompt.length} chars`);

    const { data, mime } = toBase64(inputPath);
    const requestParts: any[] = [
      { inlineData: { mimeType: mime, data } },
      { text: prompt },
    ];

    console.log(`[Gemini] 🚀 Calling Gemini 3 Pro Image model... jobId=${jobId || 'n/a'} imageId=${imageId || 'n/a'}`);
    const apiStart = Date.now();
    // Decide sampling defaults based on scene + mode, then apply any overrides
    const baseSampling = (() => {
      // If using test prompts with embedded temp, keep API sampling neutral
      if (process.env.USE_TEST_PROMPTS === "1") {
        return { temperature: undefined as any, topP: undefined as any, topK: undefined as any };
      }
      const isExterior = sceneType === "exterior";
      const isInterior = sceneType === "interior";
      let t: number;
      let p: number;
      let k: number;
      if (declutter) {
        // Balanced for declutter; slightly higher for exterior polish
        if (isInterior) {
          t = 0.45; p = 0.80; k = 40;
        } else {
          t = 0.50; p = 0.86; k = 45;
        }
      } else {
        // Enhance-only: boost exterior to improve sky/grass/surface polish
        if (isInterior) {
          t = 0.55; p = 0.85; k = 40;
        } else {
          t = 0.60; p = 0.90; k = 50;
        }
      }
      if (strictMode) {
        t = Math.max(0.1, t - 0.15);
        p = Math.max(0.5, p - 0.05);
        k = Math.max(20, k - 5);
      }
      return { temperature: t, topP: p, topK: k };
    })();

    // Environment overrides (if provided). Explicit options take precedence over env.
    const parseEnvNumber = (v?: string) => {
      if (!v) return undefined;
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : undefined;
    };
    // Per-scene env overrides (scene takes precedence over global)
    const sceneKey = (sceneType === 'interior' ? 'INTERIOR' : (sceneType === 'exterior' ? 'EXTERIOR' : '')) as 'INTERIOR'|'EXTERIOR'|'';
    const envTempScene = sceneKey ? parseEnvNumber(process.env[`GEMINI_TEMP_${sceneKey}`]) : undefined;
    const envTopPScene = sceneKey ? parseEnvNumber(process.env[`GEMINI_TOP_P_${sceneKey}`] || process.env[`GEMINI_TOPP_${sceneKey}`]) : undefined;
    const envTopKScene = sceneKey ? parseEnvNumber(process.env[`GEMINI_TOP_K_${sceneKey}`]) : undefined;
    const envTemp = envTempScene ?? parseEnvNumber(process.env.GEMINI_TEMP);
    const envTopP = envTopPScene ?? parseEnvNumber(process.env.GEMINI_TOP_P || process.env.GEMINI_TOPP);
    const envTopK = envTopKScene ?? parseEnvNumber(process.env.GEMINI_TOP_K);

    // Admin config overrides (file-based), applied before env but after explicit options?
    // Precedence: explicit options > config > env > defaults
    const admin = await getAdminConfig();
    const modeKey = declutter ? 'declutter' : 'enhance';
    const cfgSampling = admin.sampling?.[
      sceneType === 'interior' ? 'interior' : (sceneType === 'exterior' ? 'exterior' : 'default' as any)
    ] as any;
    const cfgForMode = (cfgSampling && (cfgSampling[modeKey] as any)) || (admin.sampling?.default ?? {});
    const cfgTemp = typeof cfgForMode?.temperature === 'number' ? cfgForMode.temperature : undefined;
    const cfgTopP = typeof cfgForMode?.topP === 'number' ? cfgForMode.topP : undefined;
    const cfgTopK = typeof cfgForMode?.topK === 'number' ? cfgForMode.topK : undefined;

    const usingTest = process.env.USE_TEST_PROMPTS === "1";
    const sampling = usingTest
      ? { temperature: undefined as any, topP: undefined as any, topK: undefined as any }
      : {
          temperature: typeof temperature === 'number' ? temperature : (cfgTemp ?? envTemp ?? baseSampling.temperature),
          topP: typeof topP === 'number' ? topP : (cfgTopP ?? envTopP ?? baseSampling.topP),
          topK: typeof topK === 'number' ? topK : (cfgTopK ?? envTopK ?? baseSampling.topK),
        };
    const sourceNotes: string[] = [];
    if (!usingTest) {
      if (typeof temperature !== 'number' && (cfgTemp || cfgTopP || cfgTopK)) sourceNotes.push('config');
      if (typeof temperature !== 'number' && (envTemp || envTopP || envTopK)) sourceNotes.push('env');
      console.log(`[Gemini] 🎛️ Sampling: temp=${sampling.temperature}, topP=${sampling.topP}, topK=${sampling.topK} ${sourceNotes.length ? `(${sourceNotes.join('+')} overrides applied)` : ''}`);
    } else {
      console.log(`[Gemini] 🎛️ Sampling: Using prompt-embedded temperature (API sampling left default)`);
    }

    // ✅ PER-STAGE MODEL SELECTION WITH SAFE FALLBACK
    let resp: any;
    let modelUsed: string;

    const baseRequest = {
      contents: requestParts,
      generationConfig: usingTest ? undefined : {
        temperature: sampling.temperature,
        topP: sampling.topP,
        topK: sampling.topK,
      }
    } as any;

    if (stage === "1A") {
      // Stage 1A: Gemini 2.5 only (no fallback)
      const result = await runWithImageModelFallback(client as any, baseRequest, "enhance-1A", { jobId, imageId, stage: "1A" });
      resp = result.resp;
      modelUsed = result.modelUsed;
    } else if (stage === "1B") {
      // Stage 1B: Gemini 3 → fallback to 2.5
      const result = await runWithPrimaryThenFallback({
        stageLabel: "1B",
        ai: client as any,
        baseRequest,
        context: "enhance-1B",
        logCtx: { jobId, imageId, stage: "1B" },
      });
      resp = result.resp;
      modelUsed = result.modelUsed;
    } else if (stage === "2") {
      // Stage 2: Gemini 2.5 only (no fallback) - optimized for virtual staging
      // Use the Stage 2 config which now points to Gemini 2.5
      const result = await runWithPrimaryThenFallback({
        stageLabel: "2",
        ai: client as any,
        baseRequest,
        context: "stage2",
        logCtx: { jobId, imageId, stage: "2" },
      });
      resp = result.resp;
      modelUsed = result.modelUsed;
    } else {
      // Legacy: no stage specified, use Stage 1A behavior
      const result = await runWithImageModelFallback(client as any, baseRequest, declutter ? "enhance+declutter" : "enhance", { jobId, imageId, stage: stage || "1A" });
      resp = result.resp;
      modelUsed = result.modelUsed;
    }

    const apiMs = Date.now() - apiStart;
    console.log(`[Gemini] ✅ API responded in ${apiMs} ms (model=${modelUsed})`);

    const parts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
    console.log(`[Gemini] 📊 Response parts: ${parts.length}`);
    const img = parts.find((p: any) => p.inlineData?.data && /image\//.test(p.inlineData?.mimeType || ''));
    if (!img?.inlineData?.data) {
      console.error(`❌ FATAL: Gemini ${modelUsed} returned no image data — cannot continue.`);
      throw new Error(`Gemini ${modelUsed} model returned no image data – aborting job.`);
    }

    const suffix = declutter ? "-gemini-1B" : "-gemini-1A";
    const out = siblingOutPath(inputPath, suffix, ".webp");
    writeImageDataUrl(out, `data:image/webp;base64,${img.inlineData.data}`);
    console.log(`[Gemini] 💾 Saved enhanced image to: ${out}`);
    return out;
  } catch (error) {
    console.error(`❌ FATAL: Gemini ${operationType} failed — cannot continue AI pipeline.`);
    console.error(`Error details:`, error);
    throw error;
  }
}