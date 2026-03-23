import fs from "fs";
import path from "path";
import { runOpeningValidator } from "../worker/src/validators/openingValidator";
import { runFixtureValidator } from "../worker/src/validators/fixtureValidator";
import { runFloorIntegrityValidator } from "../worker/src/validators/floorIntegrityValidator";
import { runEnvelopeValidator } from "../worker/src/validators/envelopeValidator";
import { runUnifiedValidation } from "../worker/src/validators/runValidation";
import { CRITICAL_ISSUES, ISSUE_TYPES, type ValidationIssueType } from "../worker/src/validators/issueTypes";

type Pair = { id: string; baselinePath: string; enhancedPath: string; roomType: "living" };

type SpecialistDecision = {
  pass: boolean;
  confidence: number;
  issueType: ValidationIssueType;
  hardFail: boolean;
  status: string;
  reason: string;
};

type Row = {
  id: string;
  baseline: string;
  enhanced: string;
  elapsedMs: number;
  specialist: {
    opening: SpecialistDecision;
    fixture: SpecialistDecision;
    floor: SpecialistDecision;
    envelope: SpecialistDecision;
    hardFailBlock: boolean;
    blockReasons: string[];
  };
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

function toDecision(res: any): SpecialistDecision {
  const hardFail = res?.hardFail === true;
  const status = String(res?.status || "pass");
  const pass = hardFail ? false : true;
  const conf = Number(res?.confidence);
  const confidence = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0;
  const issueType = pass ? ISSUE_TYPES.NONE : ((res?.issueType as ValidationIssueType) || ISSUE_TYPES.UNIFIED_FAILURE);
  return {
    pass,
    confidence,
    issueType,
    hardFail,
    status,
    reason: String(res?.reason || (pass ? "none" : "unknown")),
  };
}

async function runOne(pair: Pair): Promise<Row> {
  const t0 = Date.now();
  const baseline = path.basename(pair.baselinePath);
  const enhanced = path.basename(pair.enhancedPath);

  const [openingRaw, fixtureRaw, floorRaw, envelopeRaw] = await Promise.all([
    runOpeningValidator(pair.baselinePath, pair.enhancedPath),
    runFixtureValidator(pair.baselinePath, pair.enhancedPath),
    runFloorIntegrityValidator(pair.baselinePath, pair.enhancedPath),
    runEnvelopeValidator(pair.baselinePath, pair.enhancedPath),
  ]);

  const opening = toDecision(openingRaw);
  const fixture = toDecision(fixtureRaw);
  const floor = toDecision(floorRaw);
  const envelope = toDecision(envelopeRaw);

  const specialistEntries = [
    ["opening", opening] as const,
    ["fixture", fixture] as const,
    ["floor", floor] as const,
    ["envelope", envelope] as const,
  ];

  const hardFailBlockers = specialistEntries.filter(([, d]) => d.hardFail && CRITICAL_ISSUES.has(d.issueType));
  const hardFailBlock = hardFailBlockers.length > 0;
  const blockReasons = hardFailBlockers.map(([name, d]) => `${name}:${d.issueType}:${d.reason}:conf=${d.confidence.toFixed(3)}`);

  if (hardFailBlock) {
    return {
      id: pair.id,
      baseline,
      enhanced,
      elapsedMs: Date.now() - t0,
      specialist: { opening, fixture, floor, envelope, hardFailBlock, blockReasons },
      unified: {
        ran: false,
        pass: null,
        hardFail: null,
        issueType: null,
        issueTier: null,
        reason: null,
        elapsedMs: 0,
      },
      finalDecision: "fail",
      failedAt: "specialist",
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
    jobId: `kaipuke-${pair.id}-${Date.now()}`,
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
    specialist: { opening, fixture, floor, envelope, hardFailBlock, blockReasons },
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

  const startedAt = Date.now();
  const rows: Row[] = [];
  for (const pair of pairs) {
    const row = await runOne(pair);
    rows.push(row);
    console.log(`[PAIR ${pair.id}] decision=${row.finalDecision} failedAt=${row.failedAt || "none"} elapsedMs=${row.elapsedMs}`);
  }

  const summary = {
    total: rows.length,
    pass: rows.filter((r) => r.finalDecision === "pass").length,
    fail: rows.filter((r) => r.finalDecision === "fail").length,
    specialistBlocked: rows.filter((r) => r.failedAt === "specialist").length,
    unifiedEvaluated: rows.filter((r) => r.unified.ran).length,
    avgElapsedMs: Math.round(rows.reduce((a, r) => a + r.elapsedMs, 0) / Math.max(1, rows.length)),
    totalElapsedMs: Date.now() - startedAt,
  };

  const outPath = path.join(root, "tmp", `kaipuke-stage2-validators-${Date.now()}.json`);
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
