import type { GoogleGenAI } from "@google/genai";
import fs from "fs/promises";
import path from "path";
import { runWithImageModelFallback } from "./runWithImageModelFallback";
import { siblingOutPath, toBase64, writeImageDataUrl } from "../utils/images";

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

/**
 * Build the appropriate Gemini prompt based on job options
 */
function buildGeminiPrompt(options: {
  sceneType?: "interior" | "exterior" | string;
  replaceSky?: boolean;
  declutter?: boolean;
}): string {
  const { sceneType, replaceSky = false, declutter = false } = options;
  const isExterior = sceneType === "exterior";
  const isInterior = sceneType === "interior";

  if (declutter) {
    // Combined Enhance + Declutter prompt (saves one Gemini call)
    return `You are a professional real estate image editor specializing in high-end property marketing.
Your job is to transform this photo into a stunning, magazine-quality image AND remove loose furniture and clutter, creating a clean canvas for virtual staging.

Enhancement requirements:
• **Dramatic Quality Boost**: Significantly improve exposure, brightness and contrast so the room looks exceptionally bright, airy and inviting.
• **Professional HDR**: Apply professional HDR tone mapping to bring out detail in shadows and highlights. The space should have depth and dimension.
• **White Balance**: Correct white balance and color cast; walls should look neutral and clean.
• **Clarity & Detail**: Dramatically increase clarity and local contrast to bring out sharp detail in floors, walls, fixtures and architectural features.
• **Noise Reduction**: Eliminate noise and compression artifacts for a clean, professional finish.
• **Rich Colors**: Increase saturation moderately so colors look rich and appealing, but maintain realism.
• **Magazine Quality**: The result should look like a professionally shot and edited luxury real estate photograph.

Declutter requirements:
• Remove ALL loose furniture (sofas, chairs, tables, freestanding shelves, beds, etc.) and clutter (toys, personal items, bins, appliances, decorations) to create a completely empty space.
• Where objects are removed, perfectly reconstruct the background (walls, baseboards, windows, doors, corners, flooring) to match the original architecture and lighting seamlessly.
• Preserve ALL built-in elements: kitchens, built-in wardrobes, fireplaces, window frames, fixed shelving, countertops, bathroom fixtures.
${isExterior ? `• For exterior photos: Remove vehicles, bins, tools, garden furniture, temporary structures, but keep permanent landscaping, fencing, and building features.` : ''}

Forbidden changes (critical):
• Do not move, resize, or remove any walls, ceilings, floors, windows, doors, structural columns, or fixed cabinetry.
• Do not change ceiling height, room proportions or window positions.
• Do not add any new furniture, decor, or objects – staging will be done separately.
• Do not change the camera angle, lens distortion, crop, or aspect ratio.
• Do not add people, animals, text, logos, or watermarks.
${replaceSky && isExterior ? `• Replace any overcast, cloudy, or gray sky with a vibrant, clear blue sky with light clouds. Match the lighting naturally.` : ''}

${isExterior ? `This is an EXTERIOR photo. Remove clutter and enhance dramatically to showcase maximum curb appeal. The sky should be vibrant and inviting.` : ''}
${isInterior ? `This is an INTERIOR photo. Create a completely empty, bright, luxurious-looking space ready for professional virtual staging.` : ''}

Output one image that is both professionally enhanced to magazine quality AND completely decluttered, ready for virtual staging.`;
  }

  // Enhance-only prompt (Stage 1A when no declutter requested)
  return `You are a professional real estate photo editor.
Your job is to enhance image quality for property marketing while keeping the scene structurally identical to the input.

Allowed changes:
• Improve exposure, brightness and contrast.
• Correct white balance and color cast to look neutral and natural.
• Increase clarity and local contrast for better detail.
• Reduce noise and compression artifacts.
• Slightly increase saturation to make the image more inviting, but keep it realistic.
${replaceSky && isExterior ? `• Replace any overcast, cloudy, or gray sky with a clear, natural blue sky while maintaining realistic lighting consistency.` : ''}

Forbidden changes:
• Do not move, resize or remove any walls, ceilings, floors, windows, doors, built-in cabinetry or other fixed architecture.
• Do not remove or add any furniture, decor, appliances, plants, vehicles, or other objects.
• Do not change the camera angle, crop, or aspect ratio.
• Do not add text, watermarks, logos, people, or animals.

${isExterior ? `This is an EXTERIOR photo. The sky should look natural; avoid over-saturated cartoon skies.` : ''}
${isInterior ? `This is an INTERIOR photo. Aim for bright but realistic daylight in the room.` : ''}

Output a single enhanced version of the image that looks like a professionally edited real-estate photograph.`;
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
  } = {}
): Promise<string> {
  const { skipIfNoApiKey = true, replaceSky = false, declutter = false, sceneType, stage } = options;

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
    const prompt = buildGeminiPrompt({ sceneType, replaceSky, declutter });
    console.log(`[Gemini] 📝 Prompt length: ${prompt.length} chars`);

    const { data, mime } = toBase64(inputPath);
    const requestParts: any[] = [
      { inlineData: { mimeType: mime, data } },
      { text: prompt },
    ];

    console.log(`[Gemini] 🚀 Calling Gemini 2.5 Image model (with fallback)...`);
    const apiStart = Date.now();
    const { resp, modelUsed } = await runWithImageModelFallback(client as any, {
      contents: requestParts,
      generationConfig: {
        // Encourage high fidelity + keep dimensions
        temperature: 0.4,
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