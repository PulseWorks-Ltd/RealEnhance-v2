import fs from "fs";
import path from "path";
import { runEnvelopeValidator } from "../worker/src/validators/envelopeValidator";
import { runFixtureValidator } from "../worker/src/validators/fixtureValidator";
import { runFloorIntegrityValidator } from "../worker/src/validators/floorIntegrityValidator";
import { runOpeningValidator } from "../worker/src/validators/openingValidator";
import {
  extractStructuralBaseline,
  type StructuralBaseline,
} from "../worker/src/validators/openingPreservationValidator";
import {
  createEmptyEvidence,
  classifyRisk,
  type ValidationEvidence,
} from "../worker/src/validators/validationEvidence";
import { runGeminiSemanticValidator } from "../worker/src/validators/geminiSemanticValidator";

type ValidatorStatus = "pass" | "fail";

type ValidatorFinding = {
  status: ValidatorStatus;
  reason: string;
  confidence: number;
  hardFail?: boolean;
};

type FinalStructuralFinding = {
  ran: boolean;
  model: string;
  hardFail?: boolean;
  category?: string;
  violationType?: string;
  confidence?: number;
  reasons?: string[];
  error?: string;
};

type OutputRow = {
  image: string;
  baseline: string;
  staged: string;
  pairFound: boolean;
  baselineSource?: "cached" | "computed";
  baselineExtraction?: {
    ok: boolean;
    wallCount?: number;
    openingCount?: number;
    error?: string;
  };
  validators?: {
    opening: ValidatorFinding;
    fixture: ValidatorFinding;
    flooring: ValidatorFinding;
    envelope: ValidatorFinding;
  };
  decision?: {
    escalatedToFinalStructuralValidator: boolean;
    trigger: "validator_fail" | "none";
  };
  finalStructuralValidator?: FinalStructuralFinding;
};

function parseDotEnv(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function normalizeFinding(input: any): ValidatorFinding {
  const status: ValidatorStatus = input?.status === "fail" ? "fail" : "pass";
  return {
    status,
    reason: typeof input?.reason === "string" ? input.reason : status === "pass" ? "none" : "unknown",
    confidence: Number.isFinite(input?.confidence) ? Number(input.confidence) : 0.5,
    hardFail: input?.hardFail === true,
  };
}

function countOpenings(baseline?: StructuralBaseline | null) {
  if (!baseline || !Array.isArray(baseline.openings)) return { windows: 0, doors: 0, total: 0 };
  let windows = 0;
  let doors = 0;
  for (const o of baseline.openings) {
    if (o.type === "window") windows += 1;
    if (o.type === "door" || o.type === "closet_door" || o.type === "walkthrough") doors += 1;
  }
  return { windows, doors, total: baseline.openings.length };
}

function makeEvidence(
  imageId: string,
  baseline: StructuralBaseline | null,
  staged: StructuralBaseline | null
): ValidationEvidence {
  const before = countOpenings(baseline);
  const after = countOpenings(staged);
  const evidence = createEmptyEvidence(`batch-${imageId}`, "2", "bedroom");
  evidence.openings.windowsBefore = before.windows;
  evidence.openings.windowsAfter = after.windows;
  evidence.openings.doorsBefore = before.doors;
  evidence.openings.doorsAfter = after.doors;
  evidence.localFlags = [];
  return evidence;
}

function loadCachedBaselines(root: string): Map<string, StructuralBaseline> {
  const p = path.join(root, "tmp", "bedroom_staged2_baseline_extraction_full.json");
  const map = new Map<string, StructuralBaseline>();
  if (!fs.existsSync(p)) return map;
  const arr = JSON.parse(fs.readFileSync(p, "utf8"));
  for (const row of arr) {
    const imageName = String(row?.image || "").trim();
    const extraction = row?.baselineExtraction;
    if (!imageName || !extraction || !Array.isArray(extraction.openings)) continue;
    map.set(imageName, extraction as StructuralBaseline);
  }
  return map;
}

async function runBatch(root: string, stagedFolder: string, cachedBaselines: Map<string, StructuralBaseline>): Promise<OutputRow[]> {
  const baselineDir = path.join(root, "Test Images", "Bedroom (Baseline)");
  const stagedDir = path.join(root, "Test Images", stagedFolder);

  const baselineFiles = fs
    .readdirSync(baselineDir)
    .filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .sort((a, b) => a.localeCompare(b));

  const rows: OutputRow[] = [];

  for (const baseFile of baselineFiles) {
    const image = path.basename(baseFile, path.extname(baseFile));
    const stagedFile = `${image} (Enhanced).webp`;
    const basePath = path.join(baselineDir, baseFile);
    const stagedPath = path.join(stagedDir, stagedFile);
    const pairFound = fs.existsSync(stagedPath);

    const row: OutputRow = {
      image,
      baseline: baseFile,
      staged: stagedFile,
      pairFound,
    };

    if (!pairFound) {
      rows.push(row);
      continue;
    }

    let baseline: StructuralBaseline | null = null;
    if (cachedBaselines.has(image)) {
      baseline = cachedBaselines.get(image)!;
      row.baselineSource = "cached";
      row.baselineExtraction = {
        ok: true,
        wallCount: baseline.wallCount,
        openingCount: baseline.openings.length,
      };
    } else {
      try {
        baseline = await extractStructuralBaseline(basePath);
        row.baselineSource = "computed";
        row.baselineExtraction = {
          ok: true,
          wallCount: baseline.wallCount,
          openingCount: baseline.openings.length,
        };
      } catch (err: any) {
        row.baselineSource = "computed";
        row.baselineExtraction = {
          ok: false,
          error: err?.message || String(err),
        };
      }
    }

    const openingRes = await runOpeningValidator(basePath, stagedPath, baseline).catch((err: any) => ({
      status: "fail",
      reason: err?.message || String(err),
      confidence: 0,
      hardFail: true,
    }));

    const fixtureRes = await runFixtureValidator(basePath, stagedPath).catch((err: any) => ({
      status: "fail",
      reason: err?.message || String(err),
      confidence: 0,
      hardFail: true,
    }));

    const floorRes = await runFloorIntegrityValidator(basePath, stagedPath).catch((err: any) => ({
      status: "fail",
      reason: err?.message || String(err),
      confidence: 0,
      hardFail: true,
    }));

    const envelopeRes = await runEnvelopeValidator(basePath, stagedPath).catch((err: any) => ({
      status: "fail",
      reason: err?.message || String(err),
      confidence: 0,
      hardFail: true,
    }));

    row.validators = {
      opening: normalizeFinding(openingRes),
      fixture: normalizeFinding(fixtureRes),
      flooring: normalizeFinding(floorRes),
      envelope: normalizeFinding(envelopeRes),
    };

    const shouldEscalate = Object.values(row.validators).some((v) => v.status === "fail");
    row.decision = {
      escalatedToFinalStructuralValidator: shouldEscalate,
      trigger: shouldEscalate ? "validator_fail" : "none",
    };

    if (!shouldEscalate) {
      row.finalStructuralValidator = {
        ran: false,
        model: "gemini-2.5-pro",
      };
      rows.push(row);
      console.log(`[normal-pipeline] ${stagedFolder} :: ${image} pass (no escalation)`);
      continue;
    }

    try {
      const stagedExtraction = await extractStructuralBaseline(stagedPath).catch(() => null);
      const evidence = makeEvidence(image, baseline, stagedExtraction);
      const risk = classifyRisk(evidence);

      const finalVerdict = await runGeminiSemanticValidator({
        basePath: basePath,
        candidatePath: stagedPath,
        stage: "2",
        sceneType: "interior",
        validationMode: "FULL_STAGE_ONLY",
        evidence,
        riskLevel: risk.level,
        modelOverride: "gemini-2.5-pro",
      });

      row.finalStructuralValidator = {
        ran: true,
        model: "gemini-2.5-pro",
        hardFail: finalVerdict.hardFail,
        category: finalVerdict.category,
        violationType: finalVerdict.violationType,
        confidence: finalVerdict.confidence,
        reasons: Array.isArray(finalVerdict.reasons) ? finalVerdict.reasons : [],
      };
    } catch (err: any) {
      row.finalStructuralValidator = {
        ran: true,
        model: "gemini-2.5-pro",
        error: err?.message || String(err),
      };
    }

    rows.push(row);
    console.log(`[normal-pipeline] ${stagedFolder} :: ${image} escalated`);
  }

  return rows;
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const envPath = path.join(root, "server", ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing env file: ${envPath}`);
  }

  const env = parseDotEnv(envPath);
  if (!process.env.GEMINI_API_KEY && env.GEMINI_API_KEY) {
    process.env.GEMINI_API_KEY = env.GEMINI_API_KEY;
  }
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not found in process env or server/.env");
  }

  const cachedBaselines = loadCachedBaselines(root);
  const ts = Date.now();

  const stagedRows = await runBatch(root, "Bedroom (Staged)", cachedBaselines);
  const staged2Rows = await runBatch(root, "Bedroom (Staged 2)", cachedBaselines);

  const out1 = path.join(root, "tmp", `bedroom_stage2_pipeline_normal_results.${ts}.json`);
  const out2 = path.join(root, "tmp", `bedroom_staged2_pipeline_normal_results.${ts}.json`);
  fs.writeFileSync(out1, JSON.stringify(stagedRows, null, 2));
  fs.writeFileSync(out2, JSON.stringify(staged2Rows, null, 2));

  console.log(`[normal-pipeline] wrote ${out1}`);
  console.log(`[normal-pipeline] wrote ${out2}`);
}

main().catch((err) => {
  console.error("[normal-pipeline] fatal", err);
  process.exit(1);
});
