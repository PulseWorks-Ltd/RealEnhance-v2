import path from "path";
import fs from "fs";
import { runStage1A } from "../pipeline/stage1A";
import { runStage2 } from "../pipeline/stage2";
import type { StagingProfile } from "../utils/groups";

// Create a test profile
const createTestProfile = (): StagingProfile => ({
  id: "test-profile-1",
  roomGroupId: "test-group-1",
  styleName: "Modern Scandinavian",
  model: "staging-v1",
  seed: 42,
  palette: ["gray", "white", "natural wood"],
  prompt: "Clean lines, minimalist furniture, natural materials. Add a comfortable sectional sofa, coffee table, and accent chairs.",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});

/**
 * Validates Gemini API key and quota configuration
 */
async function validateGeminiSetup(apiKey: string): Promise<void> {
  console.log("Testing Gemini API key and quota configuration...");
  
  // Step 1: Check API key validity
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`
    );
    if (!response.ok) {
      const error = await response.json();
      throw new Error(
        `Gemini API key test failed (${response.status}): ${error.error?.message || "Unknown error"}\n` +
        "Please visit https://makersuite.google.com/app/apikey to create a valid API key"
      );
    }
    const modelsList = await response.json();
    console.log("✓ API key is valid");

    // Step 2: Test quota/billing configuration with a minimal request
    console.log("Checking quota configuration...");
    const testModel = modelsList.models?.[0]?.name;
    if (!testModel) {
      throw new Error("Could not find any available Gemini models");
    }
    console.log(`Using model: ${testModel}`);

    const quotaTestResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1/${testModel}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Hi" }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 1,
            topP: 1,
            topK: 1
          }
        })
      }
    );

    if (!quotaTestResponse.ok) {
      const error = await quotaTestResponse.json();
      if (error.error?.code === 429) {
        throw new Error(
          "Quota/billing configuration check failed. Please follow these steps:\n\n" +
          "1. Go to https://console.cloud.google.com\n" +
          "2. Select your project\n" +
          "3. Enable billing for the project\n" +
          "4. Visit https://console.cloud.google.com/apis/api/generativelanguage.googleapis.com/quotas\n" +
          "5. Configure appropriate quotas for your use case\n\n" +
          "Error details: " + error.error?.message
        );
      }
      throw new Error(`Quota test failed (${quotaTestResponse.status}): ${error.error?.message || "Unknown error"}`);
    }

    console.log("✓ Quota configuration validated\n");
  } catch (e: any) {
    throw new Error(`Failed to validate Gemini API key: ${e.message}`);
  }
}

/**
 * Main test function
 */
async function main(): Promise<void> {
  // Ensure required env vars
  process.env.STAGE1A_DEBUG = "1";
  process.env.STAGE2_DEBUG = "1";
  process.env.USE_GEMINI_STAGE2 = "1";

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_API_KEY environment variable is required");
  }
  
  // Validate API key format
  if (!/^AIza[0-9A-Za-z-_]{35}$/.test(apiKey)) {
    throw new Error("Invalid GOOGLE_API_KEY format - must start with 'AIza' and be 39 chars long");
  }

  // Validate API key and quota configuration
  await validateGeminiSetup(apiKey);

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
    sceneType: "interior",
    profile: createTestProfile()
  });
  console.log("Stage 2 complete:", stage2Output);

  console.log("\n=== Test Complete ===");
  console.log("Test image:", testImage);
  console.log("Stage 1A output:", stage1Output);
  console.log("Stage 2 output:", stage2Output);
}

// Run the test
main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});