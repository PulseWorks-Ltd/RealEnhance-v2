/**
 * Stage 2 model fallback smoke tests
 * Run with: npx tsx src/ai/__tests__/stage2ModelFallback.test.ts
 */

import { runWithPrimaryThenFallback } from "../runWithImageModelFallback";
import { resolveStage2Models } from "../../pipeline/stage2";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
  }
}

function assertEqual<T>(actual: T, expected: T, name: string) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${name} (expected ${expected}, got ${actual})`);
  } else {
    failed++;
    console.log(`  ✗ ${name} (expected ${expected}, got ${actual})`);
  }
}

class FakeAI {
  models = {
    generateContent: async ({ model }: { model: string }) => {
      if (model === "invalid-model") {
        const err: any = new Error("model not found");
        err.code = 404;
        throw err;
      }
      return {
        candidates: [
          { content: { parts: [{ inlineData: { data: "Zg==", mimeType: "image/webp" } }] } }
        ]
      };
    }
  };
}

console.log("=== Stage 2 model fallback smoke tests ===\n");

// Test 1: missing override uses base primary
(() => {
  process.env.REALENHANCE_MODEL_STAGE2_PRIMARY = "base-primary-model";
  process.env.GEMINI_STAGE2_MODEL_FALLBACK = "base-fallback-model";
  const selection = resolveStage2Models({
    roomType: "multiple_living_areas",
    stage2Variant: "2B",
    jobId: "job-1",
    imageId: "img-1",
    multiLivingModelEnv: "", // intentionally blank to trigger warn + fallback
  });
  assertEqual(selection.primaryModel, "base-primary-model", "Missing override falls back to base primary");
  assertEqual(selection.fallbackModel, "base-fallback-model", "Uses configured Stage 2 fallback");
})();

// Test 2: primary failure falls back to secondary model and still returns image
(async () => {
  process.env.REALENHANCE_MODEL_STAGE2_PRIMARY = "invalid-model";
  process.env.GEMINI_STAGE2_MODEL_FALLBACK = "valid-model";

  const ai = new FakeAI() as any;
  const { resp, modelUsed } = await runWithPrimaryThenFallback({
    stageLabel: "2",
    ai,
    baseRequest: { contents: [{ text: "test" }] } as any,
    context: "stage2-smoke",
    primaryOverride: "invalid-model",
    fallbackOverride: "valid-model",
  });

  const parts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
  assert(parts.some(p => p.inlineData?.data), "Fallback response contains inline image data");
  assertEqual(modelUsed, "valid-model", "Uses fallback model when primary fails");

  console.log(`\nTests completed: ${passed + failed} (passed: ${passed}, failed: ${failed})`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})();
