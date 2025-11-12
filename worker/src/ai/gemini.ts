import type { GoogleGenAI } from "@google/genai";
import fs from "fs/promises";
import path from "path";

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
    return `You are a professional real estate image editor.
Your job is to enhance this photo for property marketing and remove loose furniture and clutter, while keeping the structure of the room unchanged.

Enhancement requirements:
• Improve exposure, brightness and contrast so the room looks bright and inviting.
• Correct white balance and color cast; walls should look neutral and natural.
• Increase clarity and local contrast to bring out detail in floors, walls and fixtures.
• Reduce noise and compression artifacts.
• Slightly increase saturation so colours look rich but still realistic.

Declutter requirements:
• Remove loose furniture (sofas, chairs, coffee tables, freestanding shelves, bedside tables, etc.) and small clutter (toys, personal items, bins, small appliances, etc.) as needed to make the room look clean and empty.
• Where objects are removed, realistically reconstruct the background (walls, skirting, windows, doors, corners, floor) consistent with the original architecture and lighting.
• Keep built-in elements such as kitchens, wardrobes, fireplaces, window frames, and fixed shelving unless they are obviously freestanding furniture.
${isExterior ? `• For exterior photos: Remove vehicles, bins, tools, garden clutter, temporary structures, but keep permanent landscaping and building features.` : ''}

Forbidden changes (very important):
• Do not move, resize, or remove any walls, ceilings, floors, windows, doors, structural columns, or fixed cabinetry.
• Do not change ceiling height, room proportions or window positions.
• Do not add any new furniture, decor, or objects – staging will be done in a later step.
• Do not change the camera angle, lens distortion, crop, or aspect ratio.
• Do not add people, animals, text, logos, or watermarks.
${replaceSky && isExterior ? `• Replace any overcast, cloudy, or gray sky with a clear, natural blue sky while maintaining realistic lighting consistency.` : ''}

${isExterior ? `This is an EXTERIOR photo. The sky should look natural; avoid over-saturated cartoon skies.` : ''}
${isInterior ? `This is an INTERIOR photo. Aim for bright but realistic daylight in the room.` : ''}

Output one image that is both professionally enhanced and cleanly decluttered, ready to be used as an "empty room" base for virtual staging.`;
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
 */
export async function enhanceWithGemini(
  inputPath: string,
  options: {
    skipIfNoApiKey?: boolean;
    replaceSky?: boolean;
    declutter?: boolean;
    sceneType?: "interior" | "exterior" | string;
  } = {}
): Promise<string> {
  const { skipIfNoApiKey = true, replaceSky = false, declutter = false, sceneType } = options;

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
  console.log(`🤖 Starting Gemini AI ${operationType} (sceneType: ${sceneType}, replaceSky: ${replaceSky})...`);
  
  try {
    const client = getGeminiClient();
    
    // Read the image file
    const imageBuffer = await fs.readFile(inputPath);
    const imageBase64 = imageBuffer.toString("base64");
    const mimeType = "image/webp";
    
    // Build the appropriate prompt based on options
    const prompt = buildGeminiPrompt({ sceneType, replaceSky, declutter });
    
    console.log(`[Gemini] Using ${declutter ? 'combined enhance+declutter' : 'enhance-only'} prompt`);

    // Call Gemini's vision model with image editing
    const model = (client as any).getGenerativeModel({ 
      model: "gemini-1.5-pro-latest" 
    });
    
    const result = await model.generateContent([
      {
        inlineData: {
          data: imageBase64,
          mimeType: mimeType,
        },
      },
      { text: prompt },
    ]);

    const response = await result.response;
    
    // Extract the enhanced image from the response
    const candidates = response.candidates;
    if (!candidates || candidates.length === 0) {
      console.warn("⚠️ Gemini returned no candidates, using original image");
      return inputPath;
    }

    const parts = candidates[0].content?.parts;
    if (!parts || parts.length === 0) {
      console.warn("⚠️ Gemini response has no parts, using original image");
      return inputPath;
    }

    // Look for inline data in the parts
    let enhancedImageData: string | null = null;
    for (const part of parts) {
      if ((part as any).inlineData) {
        enhancedImageData = (part as any).inlineData.data;
        break;
      }
    }

    if (!enhancedImageData) {
      console.warn("⚠️ No image data in Gemini response, using original image");
      return inputPath;
    }

    // Save the enhanced image with appropriate suffix
    const suffix = declutter ? "-gemini-enhanced-decluttered" : "-gemini-enhanced";
    const outputPath = inputPath.replace(/\.(webp|jpg|jpeg|png)$/i, `${suffix}.webp`);
    const enhancedBuffer = Buffer.from(enhancedImageData, "base64");
    await fs.writeFile(outputPath, enhancedBuffer);

    console.log(`✅ Gemini ${operationType} complete: ${outputPath}`);
    return outputPath;

  } catch (error) {
    console.error(`❌ Gemini ${operationType} failed:`, error);
    if (skipIfNoApiKey) {
      console.log("⚠️ Falling back to original image");
      return inputPath;
    }
    throw error;
  }
}