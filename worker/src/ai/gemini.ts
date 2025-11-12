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
 * Enhance an image using Gemini's vision and image editing capabilities
 * Applies professional HDR effects, sky replacement, and natural lighting improvements
 */
export async function enhanceWithGemini(
  inputPath: string,
  options: {
    skipIfNoApiKey?: boolean;
    replaceSky?: boolean;
  } = {}
): Promise<string> {
  const { skipIfNoApiKey = true, replaceSky = true } = options;

  // Check if Gemini API key is available
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    if (skipIfNoApiKey) {
      console.log("⚠️ Gemini API key not found, skipping AI enhancement");
      return inputPath; // Return original path if no API key
    }
    throw new Error("GOOGLE_API_KEY missing for Gemini enhancement");
  }

  console.log("🤖 Starting Gemini AI enhancement...");
  
  try {
    const client = getGeminiClient();
    
    // Read the image file
    const imageBuffer = await fs.readFile(inputPath);
    const imageBase64 = imageBuffer.toString("base64");
    const mimeType = "image/webp";
    
    // Build the enhancement prompt
    let prompt = `Enhance this real estate photo to professional standards:

Core Enhancements:
- Apply natural HDR effect: lift shadows while preserving highlight detail
- Improve natural lighting and exposure balance
- Enhance colors naturally (warmer, inviting tones)
- Sharpen architectural details and textures`;

    if (replaceSky) {
      prompt += `\n- Replace any overcast, cloudy, or gray sky with a clear, vibrant blue sky
- Maintain realistic lighting consistency with the new sky`;
    }

    prompt += `\n
Critical Requirements:
- Maintain realistic appearance (NO fake HDR halos or oversaturation)
- Preserve architectural accuracy and proportions
- Professional real estate photography standard
- Natural, inviting look that appeals to buyers

Output the enhanced image directly.`;

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
    // Note: Gemini's image generation API may return the image in different formats
    // We'll need to handle the response appropriately
    
    // For now, check if the response contains image data
    const candidates = response.candidates;
    if (!candidates || candidates.length === 0) {
      console.warn("⚠️ Gemini returned no candidates, using original image");
      return inputPath;
    }

    // Check if there's inline data (image) in the response
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

    // Save the enhanced image
    const outputPath = inputPath.replace(/\.(webp|jpg|jpeg|png)$/i, "-gemini-enhanced.webp");
    const enhancedBuffer = Buffer.from(enhancedImageData, "base64");
    await fs.writeFile(outputPath, enhancedBuffer);

    console.log(`✅ Gemini enhancement complete: ${outputPath}`);
    return outputPath;

  } catch (error) {
    console.error("❌ Gemini enhancement failed:", error);
    if (skipIfNoApiKey) {
      console.log("⚠️ Falling back to original image");
      return inputPath;
    }
    throw error;
  }
}