import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { runStage1A } from "../pipeline/stage1A";
import { runStage2 } from "../pipeline/stage2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Ensure required env vars
  process.env.STAGE1A_DEBUG = "1";
  process.env.STAGE2_DEBUG = "1";
  process.env.USE_GEMINI_STAGE2 = "1";

  if (!process.env.GOOGLE_API_KEY) {
    throw new Error("GOOGLE_API_KEY environment variable is required");
  }
  
  // Validate API key format
  if (!/^AIza[0-9A-Za-z-_]{35}$/.test(process.env.GOOGLE_API_KEY)) {
    throw new Error("Invalid GOOGLE_API_KEY format - must start with 'AIza' and be 39 chars long");
  }
  
  // Test the API key
  console.log("Testing Gemini API key...");
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models?key=${process.env.GOOGLE_API_KEY}`
    );
    if (!response.ok) {
      const error = await response.json();
      throw new Error(
        `Gemini API key test failed (${response.status}): ${error.error?.message || "Unknown error"}\n` +
        "Please visit https://makersuite.google.com/app/apikey to create a valid API key"
      );
    }
    console.log("API key validated successfully!\n");
  } catch (e) {
    throw new Error(`Failed to validate Gemini API key: ${e.message}`);
  }

  // Test image path - using a real room image
  const testImage = path.join(__dirname, "..", "..", "test-data", "test-room.jpg");
  if (!fs.existsSync(testImage)) {
    console.log("Creating test-data directory and downloading test image...");
    fs.mkdirSync(path.dirname(testImage), { recursive: true });
    
    // Download a sample room image if none exists
    const response = await fetch("https://source.unsplash.com/random/1200x800/?empty+room");
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(testImage, buffer);
    console.log(`Downloaded test image to ${testImage}`);
  }

  console.log("\n=== Starting E2E Pipeline Test ===\n");
  
  // Run Stage 1A (decluttering)
  console.log("Running Stage 1A (Declutter)...");
  const stage1Output = await runStage1A(testImage);
  console.log("Stage 1A complete:", stage1Output);

  // Run Stage 2 (virtual staging)
  console.log("\nRunning Stage 2 (Virtual Staging)...");
  const stage2Output = await runStage2(stage1Output, { 
    roomType: "living room",
    profile: {
      id: "test-1",
      roomGroupId: "test-group",
      styleName: "Modern Scandinavian",
      model: "gemini-2.5-flash-image",
      seed: 42,
      temperature: 0.7,
      palette: ["gray", "white", "natural wood"],
      prompt: "Clean lines, minimalist furniture, natural materials. Add a comfortable sectional sofa, coffee table, and accent chairs.",
    }
  });
  console.log("Stage 2 complete:", stage2Output);

  console.log("\n=== Test Complete ===");
  console.log("Test image:", testImage);
  console.log("Stage 1A output:", stage1Output);
  console.log("Stage 2 output:", stage2Output);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});