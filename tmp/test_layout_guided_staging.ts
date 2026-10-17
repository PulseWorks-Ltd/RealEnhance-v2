// FIRST REAL END-TO-END TEST (standalone, read-only w.r.t. production code):
// sends a single real Gemini image-generation call using a trimmed,
// room-specific, explicit-plan-guided Stage 2 prompt for Bedroom 12.
//
// Prompt construction: based on STAGE2_PROMPT_NANO_BANANA
// (worker/src/pipeline/stage2.ts:755-812), read fresh this session — kept
// the general "preserve architecture/camera" safety net and the specific
// items this room actually has (sliding glass door, walkthrough doorway,
// AC unit), removed the blanket prohibition list for things this room does
// not have (fireplaces, kitchen islands, built-in cabinetry, staircases,
// bathroom fixtures), and added the user's explicit, human-authored
// placement plan as new content (not present in the original prompt).
//
// Call pattern matches production Stage 2 generation as closely as
// possible for a standalone script: same model default
// (gemini-2.5-flash-image, see worker/src/ai/runWithImageModelFallback.ts
// MODEL_CONFIG.stage2.primary), same generationConfig shape/defaults
// (temperature 0.40, topP 0.90, topK 40 — attempt-1 values from
// resolveStage2GenerationPlan in stage2.ts), same request-part ordering
// (text prompt first, then base image as inlineData), same direct
// ai.models.generateContent() call underneath runWithSelectedImageModel.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";

const MODEL = process.env.REALENHANCE_MODEL_STAGE2_PRIMARY || "gemini-2.5-flash-image";
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const BASELINE_PATH = path.join(OUT_DIR, "Bedroom 12.jpg");

const TRIMMED_PLAN_GUIDED_PROMPT = `Virtual Staging Instructions for nano banana (or Pro)

As an advanced virtual staging AI, your only role is to add realistic, correctly-scaled furniture and decor to the provided room photo. You are to act only as a decorator, placing items within the unchanging physical structure of the room.

STRUCTURAL PRIORITY RULE — NON-NEGOTIABLE

Structural integrity is the highest-priority requirement.

You must preserve all architectural elements exactly: walls, ceilings, floors, doors, windows, openings, and camera geometry.

If staging conflicts with structure:
* structure always takes priority,
* but you must still produce a high-quality, fully staged, listing-ready result.

Do not default to sparse or minimal staging. Instead, adapt placement, scale, and composition to resolve conflicts.

THIS ROOM'S SPECIFIC STRUCTURAL FEATURES — DO NOT ALTER OR OBSTRUCT:

* Sliding glass door, on the left wall of the room: must remain fully visible, unobstructed, and functional. Do not cover it with furniture, curtains, or decor. Do not change its size, position, or the view through it.
* Walkthrough doorway, on the middle wall of the room (the wall opposite/facing the sliding glass door): must remain fully visible, unobstructed, and functional as a walkway. Do not place any furniture in or across this opening.
* Wall-mounted AC unit, on the same middle wall as the walkthrough doorway: must remain visible and unobstructed. Furniture may be placed beneath it but must not cover or obscure the unit itself.

EXPLICIT STAGING PLAN FOR THIS ROOM — place furniture exactly as follows:

* Bed: headboard placed flush against the far-right wall of the room. Position the bed close to the extreme right edge of the frame — that wall and part of the bed should be only PARTIALLY visible, cropped by the right edge of the photo. Do not pull the bed toward the center of the room. Orient the bed so its head-to-foot axis runs across the depth of the room (front-to-back relative to the camera), with the FOOT of the bed pointing toward the sliding glass door. The camera should see the LONG SIDE profile of the bed extending from the right wall back toward the door — NOT the headboard or footboard face-on toward the camera. A person lying in the bed would be looking directly at the sliding glass door, not at the camera.
* Side tables: one on each side of the bed.
* Dressing table: positioned under the AC unit, against the middle wall (the same wall as the walkthrough doorway) — placed so it does not block the doorway and does not cover the AC unit.
* Freestanding chair: placed in the left corner of the room, near the sliding glass door.

All added items must be rendered with realistic lighting and shadows that match the room, in correct perspective for the photo, and to-scale.

CORE PRINCIPLE:
The photo of the room must remain an exact structural and architectural copy of the original. Your function is limited entirely to placing a realistic layer of furniture and decor within this unchanging, permanent framework, following the explicit plan above. Do not extend, expand, contract, or warp any space or element of the original photo.

CAMERA & PERSPECTIVE CONSTRAINT:
The camera viewpoint, lens perspective, and framing of the image must remain exactly the same as in the original photo. Do not zoom, crop, rotate, widen, narrow, or otherwise shift the camera position or perspective. The final staged image must appear as though the exact same photo was taken from the same camera position, with furniture simply placed into the scene.`;

async function main() {
  console.log("=== TRIMMED, PLAN-GUIDED PROMPT (Part 1) ===\n");
  console.log(TRIMMED_PLAN_GUIDED_PROMPT);
  console.log("\n=== END PROMPT ===\n");

  const { data, mime } = toBase64(BASELINE_PATH);
  const ai = getGeminiClient();

  console.log(`=== Sending single real generation call (model=${MODEL}) ===`);
  const startedAt = Date.now();
  let response: any;
  try {
    response = await (ai as any).models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [{ text: TRIMMED_PLAN_GUIDED_PROMPT }, { inlineData: { mimeType: mime, data } }],
        },
      ],
      generationConfig: { temperature: 0.4, topP: 0.9, topK: 40 },
    });
  } catch (e: any) {
    console.error("=== GENERATION CALL FAILED ===", e?.message || e);
    process.exit(1);
  }
  const durationMs = Date.now() - startedAt;

  const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p: any) => p?.inlineData?.data);
  if (!imgPart) {
    console.error("=== NO IMAGE RETURNED ===");
    console.error("response part types:", parts.map((p: any) => Object.keys(p)));
    const textPart = parts.find((p: any) => typeof p?.text === "string");
    if (textPart) console.error("text response:", textPart.text.slice(0, 2000));
    process.exit(1);
  }

  const outPath = path.join(OUT_DIR, "Bedroom 12-layoutguided-staged-v2.webp");
  const imgBuffer = Buffer.from(imgPart.inlineData.data, "base64");
  await sharp(imgBuffer).webp({ quality: 95 }).toFile(outPath);

  console.log(`=== DONE (${durationMs}ms) ===`);
  console.log(JSON.stringify({ outPath, imageBytes: imgBuffer.length }, null, 2));
}

main().catch((e) => {
  console.error("test_layout_guided_staging failed:", e);
  process.exit(1);
});
