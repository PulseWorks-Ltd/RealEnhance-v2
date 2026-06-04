import fs from "node:fs";
import path from "node:path";

import { runStage2GenerationAttempt } from "../worker/src/pipeline/stage2";

async function main() {
  const root = "/workspaces/RealEnhance-v2";
  const inputPath = path.join(root, "worker/test-data/Rental 03.jpg");
  const outDir = path.join(root, "tmp");
  const outPath = path.join(outDir, `rental03-stage2-${Date.now()}.webp`);

  fs.mkdirSync(outDir, { recursive: true });

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Missing input image: ${inputPath}`);
  }

  const generatedPath = await runStage2GenerationAttempt(inputPath, {
    roomType: "living",
    sceneType: "interior",
    sourceStage: "1A",
    promptMode: "full",
    stagingStyle: "nz_standard",
    jobId: `rental03-stage2-${Date.now()}`,
    imageId: "rental03-test",
    outputPath: outPath,
    attempt: 1,
  });

  console.log(JSON.stringify({ inputPath, outputPath: generatedPath }, null, 2));
}

main().catch((err) => {
  console.error("STAGE2_RENTAL03_FAILED", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
