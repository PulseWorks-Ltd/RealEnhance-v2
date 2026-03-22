import fs from "fs";
import path from "path";
import { runUnifiedValidation } from "../src/validators/runValidation";

type Pair = {
  id: string;
  baselinePath: string;
  enhancedPath: string;
};

function findPairs(root: string): Pair[] {
  const baselineDir = path.join(root, "Test Images", "Bedroom (Baseline)");
  const stagedDir = path.join(root, "Test Images", "Bedroom (Staged)");

  const isImage = (name: string) => /\.(jpg|jpeg|png|webp)$/i.test(name);
  const idFromName = (name: string): string | null => {
    const m = name.match(/Bedroom\s+(\d+)/i);
    return m ? m[1].padStart(2, "0") : null;
  };

  const baselineById = new Map<string, string>();
  for (const name of fs.readdirSync(baselineDir)) {
    if (!isImage(name)) continue;
    const id = idFromName(name);
    if (!id) continue;
    baselineById.set(id, path.join(baselineDir, name));
  }

  const pairs: Pair[] = [];
  for (const name of fs.readdirSync(stagedDir)) {
    if (!isImage(name)) continue;
    const id = idFromName(name);
    if (!id) continue;
    const baselinePath = baselineById.get(id);
    if (!baselinePath) continue;
    pairs.push({
      id,
      baselinePath,
      enhancedPath: path.join(stagedDir, name),
    });
  }

  return pairs.sort((a, b) => a.id.localeCompare(b.id));
}

async function main() {
  const root = path.resolve(__dirname, "../..");
  const pairs = findPairs(root);

  if (pairs.length === 0) {
    console.log("No Bedroom baseline/staged pairs found.");
    process.exit(1);
  }

  const startedAt = Date.now();
  const results: any[] = [];

  console.log(`[BATCH] Found ${pairs.length} bedroom pairs`);
  console.log(`[BATCH] STRUCTURAL_SIGNALS_MODE=${process.env.STRUCTURAL_SIGNALS_MODE || "(unset default->log_only)"}`);
  console.log(`[BATCH] GEMINI_VALIDATOR_MODE=${process.env.GEMINI_VALIDATOR_MODE || "(unset)"}`);

  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i];
    const idx = i + 1;
    const t0 = Date.now();

    console.log(`\n[PAIR ${idx}/${pairs.length}] Bedroom ${pair.id}`);
    console.log(`  baseline=${path.basename(pair.baselinePath)}`);
    console.log(`  enhanced=${path.basename(pair.enhancedPath)}`);

    try {
      const res = await runUnifiedValidation({
        originalPath: pair.baselinePath,
        enhancedPath: pair.enhancedPath,
        stage: "2",
        sceneType: "interior",
        roomType: "bedroom",
        mode: "log",
        jobId: `batch-bedroom-${pair.id}`,
        imageId: `bedroom-${pair.id}`,
        stagingStyle: "standard_listing",
        stage1APath: pair.baselinePath,
        sourceStage: "1A",
        validationMode: "FULL_STAGE_ONLY",
        geminiPolicy: "always",
      });

      const gem = (res.raw as any)?.geminiSemantic?.details || {};
      const row = {
        id: pair.id,
        baseline: path.basename(pair.baselinePath),
        enhanced: path.basename(pair.enhancedPath),
        passed: res.passed,
        hardFail: res.hardFail,
        blockSource: res.blockSource || null,
        score: res.score,
        riskLevel: res.riskLevel || null,
        geminiCategory: gem.category || null,
        geminiConfidence: typeof gem.confidence === "number" ? gem.confidence : null,
        geminiHardFail: gem.hardFail === true,
        reasons: res.reasons,
        warnings: res.warnings,
        elapsedMs: Date.now() - t0,
      };

      results.push(row);
      console.log(`  -> passed=${row.passed} hardFail=${row.hardFail} blockSource=${row.blockSource} score=${row.score}`);
      console.log(`  -> geminiCategory=${row.geminiCategory} geminiHardFail=${row.geminiHardFail} geminiConfidence=${row.geminiConfidence}`);
    } catch (err: any) {
      const row = {
        id: pair.id,
        baseline: path.basename(pair.baselinePath),
        enhanced: path.basename(pair.enhancedPath),
        error: err?.message || String(err),
        elapsedMs: Date.now() - t0,
      };
      results.push(row);
      console.log(`  -> ERROR: ${row.error}`);
    }
  }

  const summary = {
    total: results.length,
    ok: results.filter((r) => !r.error).length,
    errors: results.filter((r) => !!r.error).length,
    hardFail: results.filter((r) => r.hardFail === true).length,
    geminiHardFail: results.filter((r) => r.geminiHardFail === true).length,
    elapsedMs: Date.now() - startedAt,
  };

  const outDir = path.join(root, "tmp");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `stage2-validator-bedroom-batch-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2));

  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Saved report: ${outPath}`);
}

main().catch((err) => {
  console.error("BATCH_FATAL", err?.message || err);
  process.exit(1);
});
