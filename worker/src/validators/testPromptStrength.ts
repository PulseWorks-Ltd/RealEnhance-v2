import { GoogleGenAI } from "@google/genai";
import fs from "fs/promises";
import path from "path";
import { execSync } from "child_process";

/**
 * 🧪 Vertex AI Prompt Tester (Stage 1B Light Declutter)
 * 
 * Usage:
 * 1. Ensure you have authenticated with gcloud: `gcloud auth application-default login`
 *    OR set GOOGLE_APPLICATION_CREDENTIALS environment variable.
 * 2. Set GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION env vars (or edit constants below).
 * 3. Update IMAGE_INPUT path to point to a real image.
 * 4. Run: `npx tsx worker/src/validators/testPromptStrength.ts`
 */

// --- CONFIGURATION ---
let detectedProject = "realenhance-v2";
try {
  const p = execSync("gcloud config get-value project", { stdio: "pipe" }).toString().trim();
  if (p && p !== "(unset)") {
    detectedProject = p;
  }
} catch (e) {
  // ignore
}
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || detectedProject;
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
// Using Gemini 2.0 as requested
const MODEL = "gemini-2.0-flash"; 

// Replace this with path to local image you want to test
const IMAGE_INPUT = "/workspaces/RealEnhance-v2/worker/test-data/Rental 03.jpg";

// --- PROMPT TO TEST (Stage 1B "light declutter") ---
function buildTestPrompt(roomType: string = "living room", sceneType: "interior" | "exterior" = "interior") {
  if (sceneType === "exterior") {
      return `\nDeclutter this exterior property image for professional New Zealand real estate marketing.\n\nREMOVE (transient items ONLY):\n• Hoses, bins, toys, tools, tarps, ladders, bags, packaging, garden equipment\n• Loose debris: bark, stones, leaves, scattered items, dirt piles\n• Random accessories on decks/paths that are not permanently fixed\n\nKEEP EXACTLY (PERMANENT):\n• All buildings, windows, doors, rooflines, fences, gates, retaining walls\n• All permanent landscaping (trees, shrubs, hedges, garden beds)\n• All driveways, paths, decks, patios — preserve shape, size, materials, and patterns\n\nHARD RULES — NON‑NEGOTIABLE:\n• Use the image EXACTLY as provided. No rotate/crop/zoom or perspective changes.\n• Do NOT change, resize, move, or remove any permanent structure or landscaping.\n• Do NOT alter driveway, deck, or path geometry or surface type.\n\nGoal: Clean, tidy exterior with only transient clutter removed. No structural or material changes.`.trim();
  }

  return `You are a professional real-estate photo editor.\n\nTASK:\nTidy and clean this ${roomType || "room"} while KEEPING ALL MAIN FURNITURE exactly as it is.\nThis protection applies ONLY to the furniture itself — NOT to the loose items placed on top of it.\nAll loose surface items are eligible for removal.\n\nThis is a "declutter only" pass. The room must look neat, minimal, and real-estate ready, but still furnished.\n\nYOU MUST REMOVE ALL OF THE FOLLOWING IF VISIBLE:\n• All framed photos and personal picture frames\n• All small decorative clutter on shelves and surfaces\n• All personal ornaments and keepsakes\n• All pot plants, indoor plants, and flowers on furniture and benchtops\n• All loose papers, mail, magazines, and books left out\n• All bags, shoes, jackets, and clothing items\n• All toys and children's items\n• All cables, cords, chargers, and electronics clutter\n• All bathroom sink, vanity, bath, and shower clutter\n• All kitchen bench clutter, dish racks, bottles, and small containers\n• All window sill clutter\n• All sideboard and cabinet-top décor\n\nYOU MUST KEEP ALL MAIN FURNITURE:\n• All sofas and couches\n• All armchairs and lounge chairs\n• All dining tables and dining chairs\n• All beds and bedside tables\n• All wardrobes, cabinets, dressers, and TV units\n• All coffee tables and side tables\n• All large floor rugs UNDER furniture\n\nDO NOT MODIFY:\n• Walls, windows, doors, ceilings, or floors\n• Curtains, blinds, and fixed light fittings\n• Built-in cabinetry and fixed joinery\n• Outdoor greenery visible through windows\n\n────────────────────────────────\nAMBIGUOUS CLUTTER RESOLUTION RULE\n────────────────────────────────\nIf any HORIZONTAL SURFACE (kitchen benchtop, coffee table, dining table, desk, sideboard, shelf, or window sill)\nappears visually noisy due to dense, overlapping, or ambiguous clutter\nand you cannot clearly identify all individual items:\n\nYou MUST remove the entire movable clutter group as a single unit,\nas long as it is NOT a fixed or structural element.\n\nThis rule applies to:\n- Countertop clutter piles\n- Desk clutter\n- Floor clutter\n- Shelves with mixed loose items\n- Entryway dumps\n- Ambiguous overlapping object groups\n\nYou MUST NOT apply this rule to:\n- Walls, floors, ceilings\n- Windows or doors\n- Curtains, blinds, rods\n- Cabinets, benchtops, islands\n- Built-in shelving\n- Fixed wardrobes\n- Appliances that are built-in\n- Plumbing fixtures\n- Electrical fixtures\n\nIf there is any uncertainty whether something is fixed:\n→ You MUST treat it as fixed and DO NOT remove it.\n\nABSOLUTE NEGATIVE RULE — DO NOT ADD NEW ITEMS:\nDO NOT add any new objects, decor, kitchen items, props, bowls, bottles, plants, or styling elements. Only remove existing loose clutter. Never introduce new items.\n\nFAIL CONSTRAINT:\nIf ANY framed photos, personal décor, plants, shelf clutter,\nOR dense clutter remains on kitchen benches, dining tables, coffee tables, desks, sideboards, or window sills,\nthe task is considered FAILED.\n\nGOAL:\nThe room should look like the homeowner has carefully packed away all personal belongings and mess while leaving the original furniture layout intact.`.trim();
}
// ----------------------------------------------------

async function run() {
  console.log(`\n🚀 Initializing Vertex AI Client (${PROJECT} / ${LOCATION})...`);
  console.log(`🤖 Model: ${MODEL}`);

  const ai = new GoogleGenAI({
    vertexai: true,
    project: PROJECT,
    location: LOCATION,
  });

  try {
    // 1. Load Images
    console.log(`\n📂 Loading image...`);
    console.log(`   Input: ${IMAGE_INPUT}`);

    let b: Buffer;
    try {
      b = await fs.readFile(IMAGE_INPUT);
    } catch (e) {
      console.error(`\n❌ ERROR: Could not read image. Please check path in script.`);
      process.exit(1);
    }

    // 2. Build Prompt
    const prompt = buildTestPrompt("living room", "interior");
    console.log(`\n📝 Prompt generated (${prompt.length} chars)`);

    // 3. Call Vertex AI
    console.log(`\n⚡ Sending request to Vertex AI...`);
    const start = Date.now();
    
    const resp = await ai.models.generateContent({
      model: MODEL,
      contents: [
        { role: "user", parts: [{ text: prompt }] },
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/webp", data: b.toString("base64") } },
          ],
        },
      ],
      // Cast to any to align with SDK typing while keeping test flexibility
    } as any);

    const elapsed = Date.now() - start;
    console.log(`✅ Response received in ${elapsed}ms`);

    // 4. Output Result
    const candidates = resp.candidates || [];
    const parts = candidates[0]?.content?.parts || [];
    
    // Check for text response
    const textPart = parts.find(p => p.text);
    if (textPart) {
        console.log("\n--- 📝 MODEL TEXT RESPONSE ---");
        console.log(textPart.text);
        console.log("-----------------------------");
    }

    // Check for image response
    const imagePart = parts.find(p => p.inlineData && p.inlineData.data);
    if (imagePart && imagePart.inlineData?.data) {
        console.log("\n--- 🖼️ MODEL RETURNED IMAGE ---");
        const outPath = "output_test.webp";
      await fs.writeFile(outPath, Buffer.from(imagePart.inlineData.data, 'base64'));
        console.log(`✅ Saved generated image to: ${outPath}`);
    } else {
        console.log("\n⚠️ No image returned. (Model might be text-only or refused generation)");
    }

  } catch (err: any) {
    console.error("\n❌ FATAL ERROR:");
    console.error(err?.message || err);

    if (err.message?.includes("default credentials") || err.message?.includes("no credentials")) {
      console.error("\n💡 TIP: Authentication missing.");
      console.error("   Run: `gcloud auth application-default login`");
      console.error("   Or set GOOGLE_APPLICATION_CREDENTIALS to your service account key path.");
    }

    if (err.message?.includes("403") || err.message?.includes("Permission denied")) {
      console.error("\n💡 TIP: Permission denied.");
      console.error(`   1. Current Project: ${PROJECT}`);
      console.error("   2. Ensure Vertex AI API is enabled: `gcloud services enable aiplatform.googleapis.com`");
      console.error("   3. Check if you have permissions on this project.");
    }
  }
}

if (require.main === module) {
  run();
}
