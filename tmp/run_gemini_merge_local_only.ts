// Fully local test: calls renderStagingWithGeminiMerge() directly on a real
// test image. No Redis, no Postgres, no S3, no other worker involved — output
// (staged candidate, extraction mask, overlay, final composite) is written to
// local disk next to the source, via runStage2()'s own siblingOutPath
// convention plus this provider's own debug artifacts.
import path from "path";
import fs from "fs/promises";
import { renderStagingWithGeminiMerge } from "../worker/src/providers/geminiMerge/renderer";

async function runOne(params: { label: string; localPath: string; roomType: string }) {
  console.log(`\n=== ${params.label} starting ===`);
  const startedAt = Date.now();
  try {
    const result = await renderStagingWithGeminiMerge({
      basePath: params.localPath,
      roomType: params.roomType,
      sceneType: "interior",
      stagingStyle: "standard_listing",
      sourceStage: "1A",
      jobId: `local_test_${params.label}`,
      imageId: `local_test_${params.label}`,
    });
    console.log(`=== ${params.label} SUCCESS in ${Date.now() - startedAt}ms ===`);
    console.log(JSON.stringify({
      label: params.label,
      finalLocalPath: result.finalLocalPath,
      stagedCandidatePath: result.stagedCandidatePath,
      extractionMaskPath: result.extractionMaskPath,
      overlayDebugPath: result.overlayDebugPath,
      maskMetrics: result.maskMetrics,
      extractionModel: result.extractionModel,
      generationDurationMs: result.generationDurationMs,
      extractionDurationMs: result.extractionDurationMs,
      compositeDurationMs: result.compositeDurationMs,
    }, null, 2));
    return { label: params.label, ok: true, result };
  } catch (err: any) {
    console.error(`=== ${params.label} FAILED in ${Date.now() - startedAt}ms ===`);
    console.error(err?.name, err?.message);
    return { label: params.label, ok: false, error: { name: err?.name, message: err?.message } };
  }
}

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const target = process.argv[2] || "bedroom";

  const targets: Record<string, { label: string; localPath: string; roomType: string }> = {
    bedroom: {
      label: "bedroom_12",
      localPath: path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12.jpg"),
      roomType: "bedroom",
    },
    living: {
      label: "living_33_kaipuke_07",
      localPath: path.join(repoRoot, "Test Images/Living (Baseline)/33 Kaipuke - Image 07.jpg"),
      roomType: "living_room",
    },
  };

  const selected = target === "all" ? Object.values(targets) : [targets[target]];
  const results = [];
  for (const t of selected) {
    results.push(await runOne(t));
  }

  const summaryPath = path.join(repoRoot, "tmp", `gemini_merge_local_results_${Date.now()}.json`);
  await fs.writeFile(summaryPath, JSON.stringify(results, null, 2));
  console.log("\n=== ALL DONE, summary written to:", summaryPath, "===");
}

main().catch((e) => {
  console.error("run_gemini_merge_local_only failed:", e);
  process.exit(1);
});
