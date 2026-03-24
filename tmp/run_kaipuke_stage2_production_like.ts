import fs from "fs";
import path from "path";
import { runOpeningValidator } from "../worker/src/validators/openingValidator";
import { runFixtureValidator } from "../worker/src/validators/fixtureValidator";
import { runFloorIntegrityValidator } from "../worker/src/validators/floorIntegrityValidator";
import { runEnvelopeValidator } from "../worker/src/validators/envelopeValidator";
import { runUnifiedValidation } from "../worker/src/validators/runValidation";
import { classifyIssueTier, CRITICAL_ISSUES, ISSUE_TYPES, type ValidationIssueType } from "../worker/src/validators/issueTypes";

type Pair = { id: string; baselinePath: string; enhancedPath: string; roomType: "living" };

type SpecialistSignal = {
  validator: "openings" | "fixtures" | "floor" | "envelope";
  issueType?: ValidationIssueType;
  reason?: string;
  confidence?: number;
  subtype?: string;
  advisorySignals?: string[];
};

type Row = {
  id: string;
  baseline: string;
  enhanced: string;
  elapsedMs: number;
  stage2IssueTypeGateEnabled: boolean;
  stage2IssueTypeGateBlocked: boolean;
  stage2IssueTypeGateSignal?: SpecialistSignal;
  specialistSignals: SpecialistSignal[];
  unified: {
    ran: boolean;
    pass: boolean | null;
    hardFail: boolean | null;
    issueType: string | null;
    issueTier: string | null;
    reason: string | null;
    elapsedMs: number;
  };
  finalDecision: "pass" | "fail" | "error";
  failedAt?: string;
};

const root = process.cwd();
const pairs: Pair[] = [
  {
    id: "06",
    baselinePath: path.join(root, "Test Images/Living (Baseline)/33 Kaipuke - Image 06.jpg"),
    enhancedPath: path.join(root, "Test Images/Living (Staged)/33 Kaipuke - Image 06 (Staged).jpg"),
    roomType: "living",
  },
  {
    id: "07",
    baselinePath: path.join(root, "Test Images/Living (Baseline)/33 Kaipuke - Image 07.jpg"),
    enhancedPath: path.join(root, "Test Images/Living (Staged)/33 Kaipuke - Image 07 (Staged).jpg"),
    roomType: "living",
  },
];

function asSignal(
  validator: "openings" | "fixtures" | "floor" | "envelope",
  raw: any
): SpecialistSignal {
  const conf = Number(raw?.confidence);
  const issueType = (raw?.issueType as ValidationIssueType) || ISSUE_TYPES.NONE;
  return {
    validator,
    issueType,
    reason: typeof raw?.reason === "string" ? raw.reason : undefined,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : undefined,
    subtype: typeof raw?.subtype === "string" ? raw.subtype : undefined,
    advisorySignals: Array.isArray(raw?.advisorySignals) ? raw.advisorySignals : undefined,
  };
}

function isFixedCeilingFixture(signal: SpecialistSignal): boolean {
  const detail = [signal.reason || "", signal.subtype || "", ...(signal.advisorySignals || [])]
    .join(" ")
    .toLowerCase();
  return /\b(pendant|ceiling[\s_-]?light|ceiling[\s_-]?fixture|chandelier)\b/.test(detail);
}

function shouldHardFailFromIssueType(signal: SpecialistSignal): boolean {
  const issueType = signal.issueType;
  if (!issueType || issueType === ISSUE_TYPES.NONE) return false;

  const confidence = Number(signal.confidence);
  const confidenceEligible = !Number.isFinite(confidence) || confidence >= 0.85;
  if (!confidenceEligible) return false;

  if (issueType === ISSUE_TYPES.FIXTURE_CHANGED) {
    return isFixedCeilingFixture(signal);
  }

  return CRITICAL_ISSUES.has(issueType);
}

async function runOne(pair: Pair, gateEnabled: boolean): Promise<Row> {
  const t0 = Date.now();
  const baseline = path.basename(pair.baselinePath);
  const enhanced = path.basename(pair.enhancedPath);

  const [openingRaw, fixtureRaw, floorRaw, envelopeRaw] = await Promise.all([
    runOpeningValidator(pair.baselinePath, pair.enhancedPath),
    runFixtureValidator(pair.baselinePath, pair.enhancedPath),
    runFloorIntegrityValidator(pair.baselinePath, pair.enhancedPath),
    runEnvelopeValidator(pair.baselinePath, pair.enhancedPath),
  ]);

  const specialistSignals: SpecialistSignal[] = [
    asSignal("openings", openingRaw),
    asSignal("fixtures", fixtureRaw),
    asSignal("floor", floorRaw),
    asSignal("envelope", envelopeRaw),
  ];

  const categoricalBlock = gateEnabled ? specialistSignals.find(shouldHardFailFromIssueType) : undefined;

  if (categoricalBlock) {
    return {
      id: pair.id,
      baseline,
      enhanced,
      elapsedMs: Date.now() - t0,
      stage2IssueTypeGateEnabled: gateEnabled,
      stage2IssueTypeGateBlocked: true,
      stage2IssueTypeGateSignal: categoricalBlock,
      specialistSignals,
      unified: {
        ran: false,
        pass: null,
        hardFail: true,
        issueType: categoricalBlock.issueType || null,
        issueTier: categoricalBlock.issueType ? classifyIssueTier(categoricalBlock.issueType) : null,
        reason: categoricalBlock.reason || "critical_issues_gate",
        elapsedMs: 0,
      },
      finalDecision: "fail",
      failedAt: "issueType_gate",
    };
  }

  const u0 = Date.now();
  const unified = await runUnifiedValidation({
    originalPath: pair.baselinePath,
    enhancedPath: pair.enhancedPath,
    stage: "2",
    sceneType: "interior",
    roomType: pair.roomType,
    mode: "enforce",
    jobId: `kaipuke-prod-like-${pair.id}-${Date.now()}`,
    imageId: `kaipuke-${pair.id}`,
    stagingStyle: "standard_listing",
    stage1APath: pair.baselinePath,
    sourceStage: "1A",
    validationMode: "FULL_STAGE_ONLY",
    geminiPolicy: "always",
  });
  const uElapsed = Date.now() - u0;

  const unifiedPass = unified.passed === true && unified.hardFail !== true;
  const issueType = unified.issueType || null;
  const criticalFail = !unifiedPass && !!issueType && CRITICAL_ISSUES.has(issueType as ValidationIssueType);

  return {
    id: pair.id,
    baseline,
    enhanced,
    elapsedMs: Date.now() - t0,
    stage2IssueTypeGateEnabled: gateEnabled,
    stage2IssueTypeGateBlocked: false,
    specialistSignals,
    unified: {
      ran: true,
      pass: unifiedPass,
      hardFail: unified.hardFail === true,
      issueType,
      issueTier: unified.issueTier || null,
      reason: unified.reasons?.[0] || null,
      elapsedMs: uElapsed,
    },
    finalDecision: criticalFail ? "fail" : "pass",
    failedAt: criticalFail ? "unified" : undefined,
  };
}

async function main() {
  for (const p of pairs) {
    if (!fs.existsSync(p.baselinePath)) throw new Error(`Missing baseline: ${p.baselinePath}`);
    if (!fs.existsSync(p.enhancedPath)) throw new Error(`Missing staged: ${p.enhancedPath}`);
  }

  const gateEnabled =
    String(process.env.STAGE2_ENABLE_ISSUETYPE_HARDFAIL || "").toLowerCase() === "1" ||
    String(process.env.STAGE2_ENABLE_ISSUETYPE_HARDFAIL || "").toLowerCase() === "true";

  const startedAt = Date.now();
  const rows: Row[] = [];
  for (const pair of pairs) {
    const row = await runOne(pair, gateEnabled);
    rows.push(row);
    console.log(`[PAIR ${pair.id}] decision=${row.finalDecision} failedAt=${row.failedAt || "none"} gateBlocked=${row.stage2IssueTypeGateBlocked} elapsedMs=${row.elapsedMs}`);
  }

  const summary = {
    total: rows.length,
    pass: rows.filter((r) => r.finalDecision === "pass").length,
    fail: rows.filter((r) => r.finalDecision === "fail").length,
    issueTypeGateEnabled: gateEnabled,
    issueTypeGateBlocked: rows.filter((r) => r.stage2IssueTypeGateBlocked).length,
    unifiedEvaluated: rows.filter((r) => r.unified.ran).length,
    avgElapsedMs: Math.round(rows.reduce((a, r) => a + r.elapsedMs, 0) / Math.max(1, rows.length)),
    totalElapsedMs: Date.now() - startedAt,
  };

  const outPath = path.join(root, "tmp", `kaipuke-stage2-production-like-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ summary, rows }, null, 2));

  console.log("=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`REPORT=${outPath}`);
}

main().catch((err) => {
  console.error("BATCH_FATAL", err?.message || String(err));
  process.exit(1);
});
