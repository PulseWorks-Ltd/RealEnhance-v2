import type { GoogleGenAI } from "@google/genai";
import fs from "fs/promises";
import path from "path";
import { runWithImageModelFallback } from "./runWithImageModelFallback";
import { getAdminConfig } from "../utils/adminConfig";
import { siblingOutPath, toBase64, writeImageDataUrl } from "../utils/images";
import { buildPrompt, PromptOptions } from "./prompt";

let singleton: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (singleton) return singleton as any;
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_API_KEY missing: set it in the worker service env to enable Gemini image generation");
  }
  // The SDK exports types; instantiate via any to avoid type ctor mismatches
  const Ctor: any = require("@google/genai").GoogleGenAI;
  singleton = new Ctor({ apiKey });
  return singleton as any;
}

function buildGeminiPrompt(options: PromptOptions): string {
  return buildPrompt(options);
}

/**
 * Enhance an image using Gemini's vision and image editing capabilities
 * Can perform either:
 * 1. Enhance-only (quality improvements, no structural changes)
 * 2. Enhance + Declutter (combined in one call to save API costs)
 * 
 * Model selection:
 * - Stage 1A/1B: gemini-1.5-flash (fast, cost-effective for enhancement/declutter)
 * - Stage 2: gemini-2.5-flash (advanced capabilities for virtual staging)
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
    // Optional, mild cleanup helpers
    floorClean?: boolean;
    hardscapeClean?: boolean;
    declutterIntensity?: "light" | "standard" | "heavy";
  } = {}
): Promise<string> {
  const { skipIfNoApiKey = true, replaceSky = false, declutter = false, sceneType, stage, strictMode = false, temperature, topP, topK, floorClean = false, hardscapeClean = false, declutterIntensity } = options;

  // Check if Gemini API key is available
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    if (skipIfNoApiKey) {
      console.log("⚠️ Gemini API key not found, skipping AI enhancement");
      return inputPath; // Return original path if no API key
    }
    throw new Error("GOOGLE_API_KEY missing for Gemini enhancement");
  }

  const operationType = declutter ? "Enhance + Declutter" : "Enhance";
  console.log(`🤖 Starting Gemini AI ${operationType} (stage: ${stage || 'unspecified'})...`);
  console.log(`[Gemini] 🔵 Input path: ${inputPath}`);
  console.log(`[Gemini] 🔵 Scene type: ${sceneType}, replaceSky: ${replaceSky}, declutter: ${declutter}`);

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
    const prompt = buildGeminiPrompt({
      goal: declutter ? "Declutter and enhance image" : "Enhance image", // Default goal
      sceneType: sceneType === "interior" || sceneType === "exterior" ? sceneType : "auto",
      declutterLevel: di,
      // Add other valid PromptOptions properties here as needed
    });
    console.log(`[Gemini] 📝 Prompt length: ${prompt.length} chars`);

    const { data, mime } = toBase64(inputPath);
    const requestParts: any[] = [
      { inlineData: { mimeType: mime, data } },
      { text: prompt },
    ];

    console.log(`[Gemini] 🚀 Calling Gemini 2.5 Image model (with fallback)...`);
    const apiStart = Date.now();
    // Decide sampling defaults based on scene + mode, then apply any overrides
    const baseSampling = (() => {
      const isExterior = sceneType === "exterior";
      const isInterior = sceneType === "interior";
      let t: number;
      let p: number;
      let k: number;
      if (declutter) {
        // Keep conservative to avoid artifacts while still allowing cleanup
        if (isInterior) {
          t = 0.45; p = 0.80; k = 40;
        } else {
          t = 0.35; p = 0.75; k = 40;
        }
      } else {
        // Enhance-only: allow a touch more variation for interiors
        if (isInterior) {
          t = 0.55; p = 0.85; k = 40;
        } else {
          t = 0.40; p = 0.80; k = 40;
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

    const sampling = {
      temperature: typeof temperature === 'number' ? temperature : (cfgTemp ?? envTemp ?? baseSampling.temperature),
      topP: typeof topP === 'number' ? topP : (cfgTopP ?? envTopP ?? baseSampling.topP),
      topK: typeof topK === 'number' ? topK : (cfgTopK ?? envTopK ?? baseSampling.topK),
    };
    const sourceNotes: string[] = [];
    if (typeof temperature !== 'number' && (cfgTemp || cfgTopP || cfgTopK)) sourceNotes.push('config');
    if (typeof temperature !== 'number' && (envTemp || envTopP || envTopK)) sourceNotes.push('env');
    console.log(`[Gemini] 🎛️ Sampling: temp=${sampling.temperature}, topP=${sampling.topP}, topK=${sampling.topK} ${sourceNotes.length ? `(${sourceNotes.join('+')} overrides applied)` : ''}`);

    const { resp, modelUsed } = await runWithImageModelFallback(client as any, {
      contents: requestParts,
      generationConfig: {
        // Encourage high fidelity + keep dimensions
        temperature: sampling.temperature,
        topP: sampling.topP,
        topK: sampling.topK,
      }
    } as any, declutter ? "enhance+declutter" : "enhance");
    const apiMs = Date.now() - apiStart;
    console.log(`[Gemini] ✅ API responded in ${apiMs} ms (model=${modelUsed})`);

    const parts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
    console.log(`[Gemini] 📊 Response parts: ${parts.length}`);
    const img = parts.find((p: any) => p.inlineData?.data && /image\//.test(p.inlineData?.mimeType || ''));
    if (!img?.inlineData?.data) {
      console.error("❌ [Gemini] No image returned by model");
      return inputPath;
    }

    const suffix = declutter ? "-gemini-1B" : "-gemini-1A";
    const out = siblingOutPath(inputPath, suffix, ".webp");
    writeImageDataUrl(out, `data:image/webp;base64,${img.inlineData.data}`);
    console.log(`[Gemini] 💾 Saved enhanced image to: ${out}`);
    return out;
  } catch (error) {
    console.error(`❌ [Gemini] ${operationType} failed:`, error);
    if (skipIfNoApiKey) {
      console.log("⚠️ Falling back to original image");
      return inputPath;
    }
    throw error;
  }
}