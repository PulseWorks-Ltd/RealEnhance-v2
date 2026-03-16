import fs from "fs";
import path from "path";
import { extractStructuralBaseline } from "../src/validators/openingPreservationValidator";
import { runOpeningValidator } from "../src/validators/openingValidator";

type Pair = {
  id: string;
  baseline: string;
  staged: string;
  variant: string;
};

async function main() {
  const root = path.resolve(__dirname, "../..");
  const baselineDir = path.join(root, "Test Images", "Bedroom (Baseline)");
  const stagedDirs: Array<{ dir: string; variant: string }> = [
    { dir: path.join(root, "Test Images", "Bedroom (Staged)"), variant: "staged_v1" },
    { dir: path.join(root, "Test Images", "Bedroom (Staged 2)"), variant: "staged_v2" },
  ];

  const readFiles = (dir: string) =>
    fs.readdirSync(dir).filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f));
  const idFromName = (name: string): string | null => {
    const m = name.match(/Bedroom\s+(\d+)/i);
    return m ? m[1].padStart(2, "0") : null;
  };

  const baselineById = new Map<string, string>();
  for (const file of readFiles(baselineDir)) {
    const id = idFromName(file);
    if (!id) continue;
    baselineById.set(id, path.join(baselineDir, file));
  }

  const pairs: Pair[] = [];
  for (const { dir, variant } of stagedDirs) {
    for (const file of readFiles(dir)) {
      const id = idFromName(file);
      if (!id) continue;
      const baseline = baselineById.get(id);
      if (!baseline) continue;
      pairs.push({ id, baseline, staged: path.join(dir, file), variant });
    }
  }

  pairs.sort((a, b) => (a.id + a.variant).localeCompare(b.id + b.variant));

  const baselineCache = new Map<string, any>();
  const results: any[] = [];

  for (const pair of pairs) {
    const started = Date.now();
    try {
      let baseline = baselineCache.get(pair.baseline);
      if (!baseline) {
        baseline = await extractStructuralBaseline(pair.baseline);
        baselineCache.set(pair.baseline, baseline);
      }

      const res = await runOpeningValidator(pair.baseline, pair.staged, baseline);
      results.push({
        id: pair.id,
        variant: pair.variant,
        baseline: path.basename(pair.baseline),
        staged: path.basename(pair.staged),
        status: res.status,
        hardFail: res.hardFail,
        reason: res.reason,
        confidence: Number(res.confidence ?? 0),
        advisories: res.advisorySignals || [],
        elapsedMs: Date.now() - started,
      });
      console.log(
        `[SMOKE] ${pair.id}/${pair.variant} => ${res.status} hardFail=${res.hardFail} reason=${res.reason}`
      );
    } catch (err: any) {
      results.push({
        id: pair.id,
        variant: pair.variant,
        baseline: path.basename(pair.baseline),
        staged: path.basename(pair.staged),
        status: "error",
        hardFail: true,
        reason: err?.message || String(err),
        confidence: 0,
        advisories: [],
        elapsedMs: Date.now() - started,
      });
      console.log(`[SMOKE] ${pair.id}/${pair.variant} => ERROR ${err?.message || err}`);
    }
  }

  const summary = {
    total: results.length,
    pass: results.filter((r) => r.status === "pass").length,
    fail: results.filter((r) => r.status === "fail").length,
    error: results.filter((r) => r.status === "error").length,
    hardFail: results.filter((r) => r.hardFail === true).length,
  };

  console.log("\n=== SMOKE SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("\n=== DETAILED RESULTS ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error("SMOKE_FATAL", err?.message || err);
  process.exit(1);
});
