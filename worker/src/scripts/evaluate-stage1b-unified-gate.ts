import fs from "fs";
import path from "path";
import sharp from "sharp";
import { runStage1BUnifiedGate } from "../validators/stage1BUnifiedGate";

type EvalCase = {
  id: string;
  baselinePath: string;
  candidatePath: string;
  expectedPass: boolean;
  label: "good" | "bad";
};

type EvalResult = {
  id: string;
  label: "good" | "bad";
  expectedPass: boolean;
  actualPass: boolean;
  durationMs: number;
  reason: string;
};

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function p95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(0.95 * (sorted.length - 1)));
  return sorted[index];
}

async function buildSyntheticPairs(repoRoot: string, outDir: string): Promise<EvalCase[]> {
  const bedroomDir = path.join(repoRoot, "Test Images", "Bedroom (Baseline)");
  const sources = fs
    .readdirSync(bedroomDir)
    .filter((name) => /\.(jpg|jpeg|png|webp)$/i.test(name))
    .sort()
    .slice(0, 10);

  if (sources.length < 10) {
    throw new Error(`Need at least 10 baseline images, found ${sources.length}`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const cases: EvalCase[] = [];

  for (const [index, fileName] of sources.entries()) {
    const sourcePath = path.join(bedroomDir, fileName);
    const baseName = `case_${String(index + 1).padStart(2, "0")}`;
    const goodPath = path.join(outDir, `${baseName}_good.webp`);
    const badPath = path.join(outDir, `${baseName}_bad.webp`);

    const meta = await sharp(sourcePath).metadata();
    if (!meta.width || !meta.height) {
      throw new Error(`Invalid image dimensions for ${sourcePath}`);
    }

    // Known-good proxy: photometric-only transform intended to preserve room geometry.
    await sharp(sourcePath)
      .rotate()
      .median(2)
      .modulate({ brightness: 1.02, saturation: 1.01 })
      .webp({ quality: 92 })
      .toFile(goodPath);

    // Known-bad proxy: aggressive crop + resize back to original dimensions.
    const cropX = Math.floor(meta.width * 0.08);
    const cropY = Math.floor(meta.height * 0.08);
    const cropW = Math.max(64, meta.width - cropX * 2);
    const cropH = Math.max(64, meta.height - cropY * 2);

    await sharp(sourcePath)
      .rotate()
      .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
      .resize(meta.width, meta.height, { fit: "fill" })
      .webp({ quality: 90 })
      .toFile(badPath);

    cases.push({
      id: `${baseName}_good`,
      baselinePath: sourcePath,
      candidatePath: goodPath,
      expectedPass: true,
      label: "good",
    });
    cases.push({
      id: `${baseName}_bad`,
      baselinePath: sourcePath,
      candidatePath: badPath,
      expectedPass: false,
      label: "bad",
    });
  }

  return cases;
}

async function evaluateCase(testCase: EvalCase): Promise<EvalResult> {
  const gate = await runStage1BUnifiedGate({
    baselinePath: testCase.baselinePath,
    candidatePath: testCase.candidatePath,
    sceneType: "interior",
    stage1BValidationMode: "LIGHT_DECLUTTER",
    jobId: `stage1b-unified-eval-${testCase.id}`,
    imageId: testCase.id,
  });

  return {
    id: testCase.id,
    label: testCase.label,
    expectedPass: testCase.expectedPass,
    actualPass: gate.passed,
    durationMs: gate.durationMs,
    reason: gate.reasons[0] || gate.issueType || "none",
  };
}

async function main() {
  const workerRoot = process.cwd();
  const repoRoot = path.resolve(workerRoot, "..");
  const tmpDir = path.join("/tmp", "stage1b-unified-gate-eval");

  const karakaBaseline = path.join(repoRoot, "Test Images", "Kitchen", "Karaka - Image 02 Baseline.jpg");
  const karakaDecluttered = path.join(repoRoot, "Test Images", "Kitchen", "Karaka - Image 02 Decluttered.jpg");

  const karakaGate = await runStage1BUnifiedGate({
    baselinePath: karakaBaseline,
    candidatePath: karakaDecluttered,
    sceneType: "interior",
    roomType: "kitchen",
    stage1BValidationMode: "LIGHT_DECLUTTER",
    jobId: "karaka-stage1b-unified-gate",
    imageId: "karaka-image-02",
  });

  const maxAttempts = 2;
  const currentAttempt = 1;
  const karakaWouldRetry = !karakaGate.passed && currentAttempt < maxAttempts;
  const karakaPublishBlocked = !karakaGate.passed;

  const cases = await buildSyntheticPairs(repoRoot, tmpDir);
  const results: EvalResult[] = [];
  for (const testCase of cases) {
    const result = await evaluateCase(testCase);
    results.push(result);
    console.log(
      `[STAGE1B_UNIFIED_EVAL] id=${result.id} label=${result.label} expected=${result.expectedPass ? "PASS" : "FAIL"} actual=${result.actualPass ? "PASS" : "FAIL"} durationMs=${result.durationMs} reason=${result.reason}`
    );
  }

  const good = results.filter((entry) => entry.label === "good");
  const bad = results.filter((entry) => entry.label === "bad");

  const goodPass = good.filter((entry) => entry.actualPass).length;
  const goodFail = good.length - goodPass;
  const badPass = bad.filter((entry) => entry.actualPass).length;
  const badFail = bad.length - badPass;

  const falsePositives = badPass;
  const falseNegatives = goodFail;

  const addedLatencyMs = results.map((entry) => entry.durationMs);

  const summary = {
    karaka: {
      passed: karakaGate.passed,
      hardFail: karakaGate.hardFail,
      reasons: karakaGate.reasons,
      durationMs: karakaGate.durationMs,
      retryTriggered: karakaWouldRetry,
      publishBlocked: karakaPublishBlocked,
    },
    evaluation: {
      totalCases: results.length,
      goodCases: good.length,
      badCases: bad.length,
      goodPass,
      goodFail,
      badPass,
      badFail,
      falsePositives,
      falseNegatives,
    },
    latency: {
      currentStage1BPathMs: 0,
      avgAddedLatencyMs: Number(mean(addedLatencyMs).toFixed(2)),
      p95AddedLatencyMs: Number(p95(addedLatencyMs).toFixed(2)),
    },
  };

  console.log("STAGE1B_UNIFIED_GATE_SUMMARY_START");
  console.log(JSON.stringify(summary, null, 2));
  console.log("STAGE1B_UNIFIED_GATE_SUMMARY_END");
}

main().catch((error) => {
  console.error("STAGE1B_UNIFIED_GATE_EVAL_ERROR", error);
  process.exit(1);
});
