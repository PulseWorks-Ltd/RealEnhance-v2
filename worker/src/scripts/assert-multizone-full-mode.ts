import assert from "node:assert/strict";
import { buildStage2PromptNZStyle } from "../ai/prompts.nzRealEstate";

function assertMultiZoneFullPromptGuard() {
  const prompt = buildStage2PromptNZStyle("kitchen_living", "interior", {
    sourceStage: "1A",
    stagingStyle: "nz_standard",
  });

  const promptModeOverride = buildStage2PromptNZStyle("kitchen_living", "interior", {
    sourceStage: "1B-light",
    mode: "full",
    stagingStyle: "nz_standard",
  });

  assert.ok(
    prompt.includes("You MUST stage BOTH selected functional zones."),
    "Missing multi-zone full-mode enforcement line"
  );

  assert.ok(
    prompt.includes("Living zone → sofa or sectional seating"),
    "Missing living-zone required anchor line"
  );

  assert.ok(
    prompt.includes("Dining zone → full dining table with chairs"),
    "Missing dining-zone required anchor line"
  );

  assert.ok(
    promptModeOverride.includes("You MUST stage BOTH selected functional zones."),
    "Explicit FULL mode failed to enforce two-zone requirement"
  );

  assert.ok(
    promptModeOverride.includes("FULL STAGING MODE"),
    "Explicit FULL mode failed to select full staging prompt path"
  );
}

assertMultiZoneFullPromptGuard();
console.log("[PASS] Multi-zone FULL mode prompt guard");
