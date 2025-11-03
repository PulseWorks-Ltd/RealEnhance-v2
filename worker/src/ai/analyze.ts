// server/ai/analyze.ts
// Returns "interior" | "exterior" | "unknown"
export async function detectScene(opts: {
  imageBuffer: Buffer;
  mimeType: string;
  ai: any; // Gemini AI instance
}): Promise<"interior" | "exterior" | "unknown"> {
  try {
    // Use Gemini to quickly classify the scene
    const imageB64 = opts.imageBuffer.toString("base64");
    
    const response = await opts.ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        { inlineData: { mimeType: opts.mimeType, data: imageB64 } },
        { text: "Is this an interior or exterior real estate photo? Reply with ONLY the word 'interior' or 'exterior'." }
      ]
    });

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const cleanText = text.toLowerCase().trim();
    
    if (cleanText.includes("interior")) return "interior";
    if (cleanText.includes("exterior")) return "exterior";
    
  } catch (error) {
    console.error('[detectScene] Classification failed:', error);
  }
  
  return "unknown";
}