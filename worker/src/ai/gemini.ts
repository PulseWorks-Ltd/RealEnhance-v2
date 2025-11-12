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
 * - Stage 2: gemini-2.0-flash-exp (advanced capabilities for virtual staging)
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

  // Select model based on stage
  // Stage 1A/1B: Use Gemini 1.5 Flash (fast, cost-effective for enhancement/declutter)
  // Stage 2: Use Gemini 2.0 Flash (advanced for virtual staging)
  const model = (stage === "2") ? "gemini-2.0-flash-exp" : "gemini-1.5-flash";
  
  const operationType = declutter ? "Enhance + Declutter" : "Enhance";
  console.log(`🤖 Starting Gemini AI ${operationType} (stage: ${stage || 'unspecified'}, model: ${model})...`);
  console.log(`[Gemini] 🔵 Input path: ${inputPath}`);
  console.log(`[Gemini] 🔵 Scene type: ${sceneType}, replaceSky: ${replaceSky}`);
  
  try {
    const client = getGeminiClient();
    console.log(`[Gemini] ✓ Gemini client initialized`);
    
    // Read the image file
    const imageBuffer = await fs.readFile(inputPath);
    const imageSizeKB = Math.round(imageBuffer.length / 1024);
    console.log(`[Gemini] 🖼️ Loaded image from disk: ${imageSizeKB} KB`);
    
    const imageBase64 = imageBuffer.toString("base64");
    const base64SizeKB = Math.round(imageBase64.length / 1024);
    console.log(`[Gemini] 📦 Encoded to base64: ${base64SizeKB} KB`);
    
    const mimeType = "image/webp";
    
    // Build the appropriate prompt based on options
    const prompt = buildGeminiPrompt({ sceneType, replaceSky, declutter });
    console.log(`[Gemini] 📝 Generated prompt (length: ${prompt.length} chars)`);
    console.log(`[Gemini] Using ${declutter ? 'combined enhance+declutter' : 'enhance-only'} prompt`);
    console.log(`[Gemini] Prompt preview: ${prompt.substring(0, 200)}...`);

    // Call Gemini's vision model with image editing using the new API
    console.log(`[Gemini] 🤖 Using model: ${model}`);
    
    console.log(`[Gemini] 🚀 Calling Gemini API with image (${imageSizeKB} KB) and prompt (${prompt.length} chars)...`);
    const startTime = Date.now();
    
    const result = await (client as any).models.generateContent({
      model: model,
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                data: imageBase64,
                mimeType: mimeType,
              },
            },
            { text: prompt },
          ],
        },
      ],
    });

    const elapsedMs = Date.now() - startTime;
    console.log(`[Gemini] ✅ Gemini API responded in ${elapsedMs} ms`);

    // In the new API, result is the response directly (no .response property)
    console.log(`[Gemini] 📊 Response received`);
    console.log(`[Gemini] 📊 Response structure:`, Object.keys(result));
    
    // Extract the enhanced image from the response
    const candidates = result.candidates;
    console.log(`[Gemini] 📊 Response candidates: ${candidates?.length || 0}`);
    
    if (!candidates || candidates.length === 0) {
      console.error("❌ [Gemini] ERROR: Gemini returned no candidates!");
      console.error("❌ [Gemini] Full response:", JSON.stringify(result, null, 2));
      console.warn("⚠️ Gemini returned no candidates, using original image");
      return inputPath;
    }
    console.log(`[Gemini] ✓ Found ${candidates.length} candidate(s)`);

    const parts = candidates[0].content?.parts;
    console.log(`[Gemini] 📊 Parts in candidate[0]: ${parts?.length || 0}`);
    
    if (!parts || parts.length === 0) {
      console.error("❌ [Gemini] ERROR: Gemini response has no parts!");
      console.error("❌ [Gemini] Candidate[0]:", JSON.stringify(candidates[0], null, 2));
      console.warn("⚠️ Gemini response has no parts, using original image");
      return inputPath;
    }
    console.log(`[Gemini] ✓ Found ${parts.length} part(s) in response`);

    // Look for inline data in the parts
    let enhancedImageData: string | null = null;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      console.log(`[Gemini] 🔍 Checking part ${i}:`, Object.keys(part));
      if ((part as any).inlineData) {
        enhancedImageData = (part as any).inlineData.data;
        const dataSizeKB = enhancedImageData ? Math.round(enhancedImageData.length / 1024) : 0;
        console.log(`[Gemini] ✓ Found inline image data in part ${i}: ${dataSizeKB} KB (base64)`);
        break;
      }
    }

    if (!enhancedImageData) {
      console.error("❌ [Gemini] ERROR: No image data found in any part!");
      console.error("❌ [Gemini] All parts:", JSON.stringify(parts, null, 2));
      console.warn("⚠️ No image data in Gemini response, using original image");
      return inputPath;
    }

    // Save the enhanced image with appropriate suffix
    const suffix = declutter ? "-gemini-enhanced-decluttered" : "-gemini-enhanced";
    const outputPath = inputPath.replace(/\.(webp|jpg|jpeg|png)$/i, `${suffix}.webp`);
    const enhancedBuffer = Buffer.from(enhancedImageData, "base64");
    const outputSizeKB = Math.round(enhancedBuffer.length / 1024);
    console.log(`[Gemini] 📦 Decoded enhanced image: ${outputSizeKB} KB`);
    
    await fs.writeFile(outputPath, enhancedBuffer);
    console.log(`[Gemini] 💾 Saved enhanced image to: ${outputPath}`);

    console.log(`✅ Gemini ${operationType} complete: ${outputPath}`);
    console.log(`[Gemini] 🎉 SUCCESS - Enhanced image ready`);
    return outputPath;

  } catch (error) {
    console.error(`❌ [Gemini] EXCEPTION: Gemini ${operationType} failed:`, error);
    console.error(`❌ [Gemini] Error details:`, JSON.stringify(error, null, 2));
    if (skipIfNoApiKey) {
      console.log("⚠️ Falling back to original image");
      return inputPath;
    }
    throw error;
  }
}