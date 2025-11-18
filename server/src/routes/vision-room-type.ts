import { Router } from "express";
import fetch from "node-fetch";

const router = Router();

// Gemini Vision-based room type classifier
async function detectRoomTypeFromUrl(imageUrl: string, sceneTypeHint?: string) {
  const imgRes = await fetch(imageUrl);
  const bytes = await imgRes.arrayBuffer();
  const base64 = Buffer.from(bytes).toString("base64");

  const systemPrompt = `
You are a classifier that labels real-estate photos by room type.
Return a JSON object with:
- "sceneType": "interior" or "exterior"
- "roomType": one of ["living_room","bedroom","kitchen","bathroom","dining_room","office",
  "hallway","laundry","garage","exterior_front","exterior_backyard","balcony","pool","view","other_interior"]
- "confidence": number between 0 and 1
Strict JSON only, no extra text.
`.trim();

  // TODO: Replace with your Gemini client
  // Example Gemini API call (pseudo-code):
  // const resp = await geminiClient.generateContent({ ... });
  // For now, mock response for development:
  return {
    roomType: "living_room",
    confidence: 0.91,
    sceneType: sceneTypeHint || "interior",
    alternatives: [
      { label: "living_room", confidence: 0.91 },
      { label: "dining_room", confidence: 0.46 }
    ]
  };
}

router.post("/room-type", async (req, res) => {
  try {
    const { imageUrl, sceneType: hintSceneType } = req.body;
    if (!imageUrl) return res.status(400).json({ error: "imageUrl required" });
    const result = await detectRoomTypeFromUrl(imageUrl, hintSceneType);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "room-type-detection-failed" });
  }
});

export default router;
