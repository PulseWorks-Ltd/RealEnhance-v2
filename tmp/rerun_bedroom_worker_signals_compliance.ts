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
import { runSemanticStructureValidator } from "../worker/src/validators/semanticStructureValidator";
import { runMaskedEdgeValidator } from "../worker/src/validators/maskedEdgeValidator";
import { runUnifiedValidator, type Stage2LocalSignals } from "../worker/src/validators/unifiedValidator";
import { checkCompliance } from "../worker/src/ai/compliance";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";

type ValidatorStatus = "pass" | "fail";

type ValidatorFinding = {
  status: ValidatorStatus;
  reason: string;
  confidence: number;
  hardFail?: boolean;
};

type OpeningSignals = {
  removed: boolean;
  relocated: boolean;
  resized: boolean;
  resizeDelta: number;
  bandMismatch: boolean;
  classMismatch: boolean;
};

type OpeningStructuralSignalLevel = "none" | "advisory" | "strong" | "extreme";

type OpeningStructuralSignalReason =
  | "opening_removed"
  | "opening_removed_and_relocated"
  | "opening_resize_extreme"
  | "opening_relocated_and_resized";

type OpeningStructuralSignal = {
  type: OpeningStructuralSignalReason;
  confidence: Exclude<OpeningStructuralSignalLevel, "none">;
  resizeDelta?: number;
};

type OutputRow = {
  image: string;
  baseline: string;
  staged: string;
  pairFound: boolean;
  baselineSource?: "cached" | "computed";
  validators?: {
    opening: ValidatorFinding;
    fixture: ValidatorFinding;
    flooring: ValidatorFinding;
    envelope: ValidatorFinding;
  };
  workerSignals?: {
    semanticWallDrift: number;
    semanticOpeningsDelta: number;
    maskedEdgeDrift: number;
    edgeOpeningRisk: number;
    localPrecheckDecision: string;
    unifiedDecision: string;
    unifiedSeverity: string;
    unifiedScore: number;
    advisorySignals: string[];
    openingStructuralSignal?: OpeningStructuralSignal;
  };
  compliance?: {
    ran: boolean;
    ok?: boolean;
    confidence?: number;
    blocking?: boolean;
    tier?: number;
    structuralViolation?: boolean;
    placementViolation?: boolean;
    reasons?: string[];
    error?: string;
  };
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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeValidatorReason(reason: string): string {
  const normalized = String(reason || "unknown")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "unknown";
}

function normalizeFinding(input: any): ValidatorFinding {
  const status: ValidatorStatus = input?.hardFail === true ? "fail" : "pass";
  return {
    status,
    reason: typeof input?.reason === "string" ? input.reason : status === "pass" ? "none" : "unknown",
    confidence: Number.isFinite(input?.confidence) ? Number(input.confidence) : 0.5,
    hardFail: input?.hardFail === true,
  };
}

function extractOpeningSignals(openingResult: { reason?: string; advisorySignals?: string[] }): OpeningSignals {
  const reasonTokens = String(openingResult.reason || "")
    .split("|")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const advisoryTokens = Array.isArray(openingResult.advisorySignals)
    ? openingResult.advisorySignals.map((token) => String(token || "").trim().toLowerCase()).filter(Boolean)
    : [];

  const tokens = [...reasonTokens, ...advisoryTokens];
  const joined = `|${tokens.join("|")}|`;

  const resizeToken = tokens.find((token) => token.startsWith("opening_resize_ge_0_30:"));
  const resizeDelta = resizeToken ? Number.parseFloat(resizeToken.split(":")[1] || "0") : 0;
  const resized = /(^|\|)opening_resized($|\|)/.test(joined) || Number.isFinite(resizeDelta) && resizeDelta > 0;

  return {
    removed: /(^|\|)opening_removed($|\|)/.test(joined),
    relocated: /(^|\|)opening_relocated($|\|)/.test(joined),
    resized,
    resizeDelta,
    bandMismatch: /(^|\|)opening_band_mismatch($|\|)/.test(joined),
    classMismatch: /(^|\|)opening_class_mismatch($|\|)/.test(joined),
  };
}

function evaluateOpeningStructuralConfidence(
  signals: OpeningSignals
): { level: OpeningStructuralSignalLevel; reason?: OpeningStructuralSignalReason } {
  if (signals.removed && signals.relocated) {
    return { level: "strong", reason: "opening_removed_and_relocated" };
  }

  if (signals.removed) {
    return { level: "strong", reason: "opening_removed" };
  }

  if (signals.resized && signals.relocated) {
    return { level: "strong", reason: "opening_relocated_and_resized" };
  }

  if (signals.resized && signals.resizeDelta >= 0.6) {
    return { level: "extreme", reason: "opening_resize_extreme" };
  }

  if (
    signals.relocated ||
    signals.resized ||
    signals.bandMismatch ||
    signals.classMismatch
  ) {
    return { level: "advisory" };
  }

  return { level: "none" };
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
  const ai = getGeminiClient();

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
    } else {
      baseline = await extractStructuralBaseline(basePath);
      row.baselineSource = "computed";
    }

    let semanticWallDriftNorm = 0;
    let semanticOpeningsDeltaNorm = 0;
    let maskedEdgeDriftNorm = 0;
    let edgeOpeningRiskNorm = 0;

    try {
      const [semanticSignals, maskedSignals] = await Promise.all([
        runSemanticStructureValidator({
          originalImagePath: basePath,
          enhancedImagePath: stagedPath,
          scene: "interior",
          mode: "log",
        }),
        runMaskedEdgeValidator({
          originalImagePath: basePath,
          enhancedImagePath: stagedPath,
          scene: "interior",
          mode: "log",
          jobId: `batch-${stagedFolder}-${image}`,
        }),
      ]);

      semanticWallDriftNorm = clamp01(Number(semanticSignals?.walls?.driftRatio ?? 0));
      semanticOpeningsDeltaNorm = clamp01(
        Math.abs(semanticSignals?.windows?.change ?? 0) +
          Math.abs(semanticSignals?.doors?.change ?? 0) +
          Math.abs(semanticSignals?.openings?.created ?? 0) +
          Math.abs(semanticSignals?.openings?.closed ?? 0)
      );
      maskedEdgeDriftNorm = clamp01(Number(maskedSignals?.maskedEdgeDrift ?? 0));
      edgeOpeningRiskNorm = clamp01(Number(maskedSignals?.edgeOpeningRisk ?? 0));
    } catch {
      // Keep zeros when local signal extraction fails.
    }

    const localPrecheckSignals: Stage2LocalSignals = {
      structuralDegreeChange: clamp01(Math.max(semanticWallDriftNorm, maskedEdgeDriftNorm)),
      wallDrift: clamp01(semanticWallDriftNorm),
      maskedEdgeDrift: clamp01(maskedEdgeDriftNorm),
      edgeOpeningRisk: clamp01(edgeOpeningRiskNorm),
      openingCountMismatch: clamp01(semanticOpeningsDeltaNorm),
      floorPlaneShift: 0,
      fixtureMismatch: 0,
      islandDetectionDrift: 0,
    };
    const localPrecheckResult = runUnifiedValidator(localPrecheckSignals);

    const stage2AdvisorySignals: string[] = [];
    const appendAdvisories = (validator: "openings" | "fixtures" | "floor" | "envelope", advisories: string[]) => {
      if (!Array.isArray(advisories) || advisories.length === 0) return;
      const normalized = advisories.map((signal) => `${validator}:${normalizeValidatorReason(String(signal || "advisory"))}`);
      stage2AdvisorySignals.push(...normalized);
    };

    const openingRes = await runOpeningValidator(basePath, stagedPath, baseline || null);
    appendAdvisories("openings", openingRes.advisorySignals || []);

    let openingStructuralSignal: OpeningStructuralSignal | undefined;
    const openingSignals = extractOpeningSignals(openingRes);
    const openingConfidence = evaluateOpeningStructuralConfidence(openingSignals);
    const openingStructuralSignalDetected =
      openingConfidence.level === "strong" || openingConfidence.level === "extreme";
    if (openingStructuralSignalDetected && openingConfidence.reason) {
      const structuralConfidence = openingConfidence.level === "extreme" ? "extreme" : "strong";
      appendAdvisories("openings", [
        "opening_structural_signal:true",
        `opening_structural_signal_reason:${openingConfidence.reason}`,
      ]);
      openingStructuralSignal = {
        type: openingConfidence.reason,
        confidence: structuralConfidence,
        resizeDelta: Number.isFinite(openingSignals.resizeDelta) ? openingSignals.resizeDelta : undefined,
      };
    }

    const fixtureRes = await runFixtureValidator(basePath, stagedPath);
    appendAdvisories("fixtures", fixtureRes.advisorySignals || []);

    const floorRes = await runFloorIntegrityValidator(basePath, stagedPath);
    appendAdvisories("floor", floorRes.advisorySignals || []);

    const envelopeRes = await runEnvelopeValidator(basePath, stagedPath);
    appendAdvisories("envelope", envelopeRes.advisorySignals || []);

    row.validators = {
      opening: normalizeFinding(openingRes),
      fixture: normalizeFinding(fixtureRes),
      flooring: normalizeFinding(floorRes),
      envelope: normalizeFinding(envelopeRes),
    };

    const openingPass = row.validators.opening.status === "pass";
    const fixturePass = row.validators.fixture.status === "pass";
    const floorPass = row.validators.flooring.status === "pass";
    const envelopePass = row.validators.envelope.status === "pass";

    const localSignals: Stage2LocalSignals = {
      structuralDegreeChange: clamp01(Math.max(semanticWallDriftNorm, maskedEdgeDriftNorm, envelopePass ? 0 : 1)),
      wallDrift: clamp01(semanticWallDriftNorm),
      maskedEdgeDrift: clamp01(maskedEdgeDriftNorm),
      edgeOpeningRisk: clamp01(edgeOpeningRiskNorm),
      openingCountMismatch: clamp01(Math.max(semanticOpeningsDeltaNorm, openingPass ? 0 : 1)),
      floorPlaneShift: floorPass ? 0 : 1,
      fixtureMismatch: fixturePass ? 0 : 1,
      islandDetectionDrift: 0,
    };

    const unifiedLocalResult = runUnifiedValidator(localSignals);

    row.workerSignals = {
      semanticWallDrift: semanticWallDriftNorm,
      semanticOpeningsDelta: semanticOpeningsDeltaNorm,
      maskedEdgeDrift: maskedEdgeDriftNorm,
      edgeOpeningRisk: edgeOpeningRiskNorm,
      localPrecheckDecision: localPrecheckResult.decision,
      unifiedDecision: unifiedLocalResult.decision,
      unifiedSeverity: unifiedLocalResult.severity,
      unifiedScore: unifiedLocalResult.score,
      advisorySignals: stage2AdvisorySignals,
      openingStructuralSignal,
    };

    if (stage2AdvisorySignals.length === 0) {
      row.compliance = { ran: false };
      rows.push(row);
      continue;
    }

    try {
      const base1A = toBase64(basePath);
      const baseFinal = toBase64(stagedPath);
      const compliance = await checkCompliance(ai as any, base1A.data, baseFinal.data, {
        validationMode: "FULL_STAGE_ONLY",
        advisorySignals: stage2AdvisorySignals,
        openingStructuralSignal: openingStructuralSignalDetected,
        openingStructuralSignalContext: openingStructuralSignal,
        modelOverride: "gemini-2.5-pro",
      });
      row.compliance = {
        ran: true,
        ok: compliance.ok,
        confidence: compliance.confidence,
        blocking: compliance.blocking,
        tier: compliance.tier,
        structuralViolation: compliance.structuralViolation,
        placementViolation: compliance.placementViolation,
        reasons: compliance.reasons,
      };
    } catch (err: any) {
      row.compliance = {
        ran: true,
        error: err?.message || String(err),
      };
    }

    rows.push(row);
    console.log(`[worker-signals] ${stagedFolder} :: ${image} done`);
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
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v;
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not found in process env or server/.env");
  }

  const cachedBaselines = loadCachedBaselines(root);
  const ts = Date.now();

  const stagedRows = await runBatch(root, "Bedroom (Staged)", cachedBaselines);
  const staged2Rows = await runBatch(root, "Bedroom (Staged 2)", cachedBaselines);

  const out1 = path.join(root, "tmp", `bedroom_stage2_worker_signals_results.${ts}.json`);
  const out2 = path.join(root, "tmp", `bedroom_staged2_worker_signals_results.${ts}.json`);
  fs.writeFileSync(out1, JSON.stringify(stagedRows, null, 2));
  fs.writeFileSync(out2, JSON.stringify(staged2Rows, null, 2));

  console.log(`[worker-signals] wrote ${out1}`);
  console.log(`[worker-signals] wrote ${out2}`);
}

main().catch((err) => {
  console.error("[worker-signals] fatal", err);
  process.exit(1);
});
