// Fully local test: calls renderStagingWithVertexInpaint() directly on the two
// real test images. No Redis, no Postgres, no S3, no other worker involved —
// output (mask + staged image) is written to local disk next to the source.
import path from "path";
import fs from "fs/promises";
import { renderStagingWithVertexInpaint } from "../worker/src/providers/vertexInpaint/renderer";

async function runOne(params: { label: string; localPath: string; roomType: string }) {
  console.log(`\n=== ${params.label} starting ===`);
  const startedAt = Date.now();
  try {
    const result = await renderStagingWithVertexInpaint({
      basePath: params.localPath,
      roomType: params.roomType,
      stagingStyle: "standard_listing",
      jobId: `local_test_${params.label}`,
      imageId: `local_test_${params.label}`,
    });
    console.log(`=== ${params.label} SUCCESS in ${Date.now() - startedAt}ms ===`);
    console.log(JSON.stringify({
      label: params.label,
      localPath: result.localPath,
      maskPath: result.maskPath,
      maskMetrics: result.maskMetrics,
      aspectRatioNormalization: result.aspectRatioNormalization,
      driftResult: result.driftResult,
      model: result.model,
      maskGenerationDurationMs: result.maskGenerationDurationMs,
      vertexRenderDurationMs: result.vertexRenderDurationMs,
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
  const results = [];
  results.push(
    await runOne({
      label: "living_33_kaipuke_07",
      localPath: path.join(repoRoot, "Test Images/Living (Baseline)/33 Kaipuke - Image 07.jpg"),
      roomType: "living_room",
    })
  );
  results.push(
    await runOne({
      label: "bedroom_12",
      localPath: path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12.jpg"),
      roomType: "bedroom",
    })
  );

  const summaryPath = path.join(repoRoot, "tmp", `vertex_inpaint_local_results_${Date.now()}.json`);
  await fs.writeFile(summaryPath, JSON.stringify(results, null, 2));
  console.log("\n=== ALL DONE, summary written to:", summaryPath, "===");
}

main().catch((e) => {
  console.error("run_vertex_inpaint_local_only failed:", e);
  process.exit(1);
});
