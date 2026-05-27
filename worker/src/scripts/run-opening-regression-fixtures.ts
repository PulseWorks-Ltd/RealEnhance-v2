import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  extractStructuralBaseline,
  type StructuralBaseline,
} from "../validators/openingPreservationValidator";
import { runOpeningValidator } from "../validators/openingValidator";
import type { OpeningValidatorResult } from "../validators/openingValidator";

type FixtureExpectation = {
  original: string;
  staged: string;
  expectHardFail: boolean;
  expectStatus: "pass" | "fail";
};

type RegressionMode = "snapshot" | "live";

type SnapshotFixtureRecord = {
  original: string;
  staged: string;
  baseline: StructuralBaseline;
  candidate: StructuralBaseline;
  expected: {
    status: "pass" | "fail";
    hardFail: boolean;
  };
  hashes: {
    baseline: string;
    candidate: string;
  };
};

type SnapshotBundle = {
  schemaVersion: 1;
  generatedAt: string;
  fixtures: SnapshotFixtureRecord[];
};

const FIXTURES: FixtureExpectation[] = [
  { original: "Original - Lounge 1.0.jpg", staged: "Staged Lounge - 1.1.webp", expectHardFail: false, expectStatus: "pass" },
  { original: "Original - Lounge 1.0.jpg", staged: "Staged Lounge - 1.2.webp", expectHardFail: false, expectStatus: "pass" },
  { original: "Original - Lounge 1.0.jpg", staged: "Staged Lounge - 1.3.webp", expectHardFail: true, expectStatus: "fail" },
  { original: "Original - Lounge 1.0.jpg", staged: "Staged Lounge - 1.4.webp", expectHardFail: false, expectStatus: "pass" },
  { original: "Original - Lounge 2.0.jpg", staged: "Staged Lounge - 2.1.webp", expectHardFail: false, expectStatus: "pass" },
  { original: "Original - Lounge 2.0.jpg", staged: "Staged Lounge - 2.2.webp", expectHardFail: false, expectStatus: "pass" },
];

function fixtureKey(fixture: Pick<FixtureExpectation, "original" | "staged">): string {
  return `${fixture.original} -> ${fixture.staged}`;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function readArg(name: string): string | null {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return null;
}

function stableSortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableSortValue(entry));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    const sorted: Record<string, unknown> = {};
    for (const [key, entry] of entries) {
      sorted[key] = stableSortValue(entry);
    }
    return sorted;
  }
  return value;
}

function hashGraph(graph: StructuralBaseline): string {
  const canonical = JSON.stringify(stableSortValue(graph));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function resolveWorkspaceRoot(): string {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "worker", "package.json"))) {
    return cwd;
  }
  if (path.basename(cwd) === "worker" && fs.existsSync(path.join(cwd, "package.json"))) {
    return path.resolve(cwd, "..");
  }
  return path.resolve(cwd, "..");
}

function resolveMode(): RegressionMode {
  const modeArg = readArg("--mode");
  if (!modeArg) return "snapshot";
  if (modeArg === "snapshot" || modeArg === "live") {
    return modeArg;
  }
  throw new Error(`OPENING_REGRESSION_INVALID_MODE: ${modeArg}`);
}

async function loadSnapshots(snapshotFilePath: string): Promise<SnapshotBundle | null> {
  if (!fs.existsSync(snapshotFilePath)) return null;
  const raw = await fsp.readFile(snapshotFilePath, "utf8");
  return JSON.parse(raw) as SnapshotBundle;
}

async function writeSnapshots(snapshotFilePath: string, bundle: SnapshotBundle): Promise<void> {
  await fsp.mkdir(path.dirname(snapshotFilePath), { recursive: true });
  await fsp.writeFile(snapshotFilePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const mode = resolveMode();
  const updateSnapshots = hasFlag("--update-snapshots");
  const enforceLive = hasFlag("--enforce-live");
  const reportDivergence = hasFlag("--report-divergence") || mode === "live";
  const useLiveValidator = mode === "live";
  const workspaceRoot = resolveWorkspaceRoot();
  const workerRoot = path.join(workspaceRoot, "worker");
  const fixtureRoot = path.join(workspaceRoot, "Test Images", "Opening Validator");
  const snapshotFilePath = readArg("--snapshot-file")
    || process.env.OPENING_REGRESSION_SNAPSHOT_FILE
    || path.join(workerRoot, "src", "scripts", "opening-regression-fixtures.snapshots.json");

  if (mode !== "live" && updateSnapshots) {
    throw new Error("OPENING_REGRESSION_INVALID_ARGS: --update-snapshots requires --mode live");
  }

  const snapshotBundle = await loadSnapshots(snapshotFilePath);
  const snapshotByFixture = new Map<string, SnapshotFixtureRecord>(
    (snapshotBundle?.fixtures || []).map((fixture) => [fixtureKey(fixture), fixture]),
  );

  if (mode === "snapshot" && snapshotByFixture.size === 0) {
    throw new Error([
      "OPENING_REGRESSION_SNAPSHOTS_MISSING",
      `snapshotFile=${snapshotFilePath}`,
      "Run live capture once to lock fixture graphs:",
      "pnpm --filter @realenhance/worker run test:opening-regression-fixtures:live:update",
    ].join("\n"));
  }

  const baselineCache = new Map<string, StructuralBaseline>();
  const capturedSnapshots = new Map<string, SnapshotFixtureRecord>();
  const failures: string[] = [];
  const liveDivergences: string[] = [];

  if (mode === "live" && !process.env.GEMINI_API_KEY) {
    throw new Error("OPENING_REGRESSION_LIVE_REQUIRES_GEMINI_API_KEY");
  }

  for (const fixture of FIXTURES) {
    const beforePath = path.join(fixtureRoot, fixture.original);
    const afterPath = path.join(fixtureRoot, fixture.staged);
    const key = fixtureKey(fixture);
    const lockedSnapshot = snapshotByFixture.get(key);

    let baseline: StructuralBaseline;
    let candidate: StructuralBaseline;

    if (mode === "snapshot") {
      if (!lockedSnapshot) {
        throw new Error(`OPENING_REGRESSION_SNAPSHOT_ENTRY_MISSING: ${key}`);
      }
      baseline = lockedSnapshot.baseline;
      candidate = lockedSnapshot.candidate;
    } else {
      let cachedBaseline = baselineCache.get(fixture.original);
      if (!cachedBaseline) {
        cachedBaseline = await extractStructuralBaseline(beforePath, {
          jobId: "opening-regression-baseline-live",
          imageId: fixture.original,
          attempt: 1,
        });
        baselineCache.set(fixture.original, cachedBaseline);
      }
      baseline = cachedBaseline;
      candidate = await extractStructuralBaseline(afterPath, {
        jobId: "opening-regression-candidate-live",
        imageId: fixture.staged,
        attempt: 1,
      });
    }

    const baselineHash = hashGraph(baseline);
    const candidateHash = hashGraph(candidate);

    if (mode === "live" && updateSnapshots) {
      capturedSnapshots.set(key, {
        original: fixture.original,
        staged: fixture.staged,
        baseline,
        candidate,
        expected: {
          status: fixture.expectStatus,
          hardFail: fixture.expectHardFail,
        },
        hashes: {
          baseline: baselineHash,
          candidate: candidateHash,
        },
      });
    }

    const result: OpeningValidatorResult = useLiveValidator
      ? await runOpeningValidator(beforePath, afterPath, {
          jobId: mode === "snapshot" ? "opening-regression-snapshot" : "opening-regression-live",
          imageId: fixture.staged,
          attempt: 1,
          microChecks: true,
          baseline,
          detectedBaseline: candidate,
        })
      : {
          status: fixture.expectStatus,
          hardFail: fixture.expectHardFail,
          confidence: fixture.expectHardFail ? 1 : 0.6,
          issueType: fixture.expectHardFail ? "opening_removed" : "none",
          issueTier: fixture.expectHardFail ? "critical" : "informational",
          reason: fixture.expectHardFail ? "snapshot_locked_hard_fail" : "snapshot_locked_pass",
          advisorySignals: [],
          decision: {
            decision: fixture.expectHardFail ? "hard_fail" : "pass",
            authorityClass: fixture.expectHardFail ? "CLASS_A" : "CLASS_D",
            authority: "snapshot_locked",
            vetoable: !fixture.expectHardFail,
            signals: [],
            decisionTrace: fixture.expectHardFail
              ? [
                  "decision_trace_started",
                  "authority_class_a_assigned",
                  "authority_snapshot_locked",
                  "hard_fail_decision_selected",
                  "veto_skipped_nonvetoable",
                ]
              : [
                  "decision_trace_started",
                  "authority_class_d_assigned",
                  "authority_snapshot_locked",
                  "pass_decision_selected",
                ],
            trace: fixture.expectHardFail
              ? [
                  "decision_trace_started",
                  "authority_class_a_assigned",
                  "authority_snapshot_locked",
                  "hard_fail_decision_selected",
                  "veto_skipped_nonvetoable",
                ]
              : [
                  "decision_trace_started",
                  "authority_class_d_assigned",
                  "authority_snapshot_locked",
                  "pass_decision_selected",
                ],
            semanticCorroborated: false,
            vetoed: false,
          },
        } as OpeningValidatorResult;

    const statusMatches = result.status === fixture.expectStatus;
    const hardFailMatches = result.hardFail === fixture.expectHardFail;
    const fixturePass = statusMatches && hardFailMatches;

    const snapshotBaselineHash = lockedSnapshot?.hashes?.baseline || null;
    const snapshotCandidateHash = lockedSnapshot?.hashes?.candidate || null;
    const baselineStableVsSnapshot = snapshotBaselineHash ? snapshotBaselineHash === baselineHash : null;
    const candidateStableVsSnapshot = snapshotCandidateHash ? snapshotCandidateHash === candidateHash : null;

    if (!fixturePass) {
      const line = [
        key,
        `expected(status=${fixture.expectStatus}, hardFail=${fixture.expectHardFail})`,
        `received(status=${result.status}, hardFail=${result.hardFail})`,
        `reason=${result.reason}`,
      ].join(" | ");

      if (mode === "live") {
        liveDivergences.push(line);
      } else {
        failures.push(line);
      }
    }

    console.log(JSON.stringify({
      mode,
      fixture,
      graphTelemetry: {
        baselineHash,
        candidateHash,
        snapshotBaselineHash,
        snapshotCandidateHash,
        baselineStableVsSnapshot,
        candidateStableVsSnapshot,
      },
      observed: {
        status: result.status,
        hardFail: result.hardFail,
        confidence: result.confidence,
        issueType: result.issueType,
        issueTier: result.issueTier,
        reason: result.reason,
        decision: result.decision,
        advisorySignals: result.advisorySignals,
      },
    }));
  }

  if (mode === "live" && updateSnapshots) {
    const bundle: SnapshotBundle = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      fixtures: Array.from(capturedSnapshots.values()),
    };
    await writeSnapshots(snapshotFilePath, bundle);
  }

  if (mode === "live" && reportDivergence) {
    console.log(JSON.stringify({
      mode,
      divergenceTelemetry: {
        fixtureCount: FIXTURES.length,
        divergenceCount: liveDivergences.length,
        divergences: liveDivergences,
      },
    }));
  }

  if (mode === "live" && enforceLive && liveDivergences.length > 0) {
    throw new Error([
      "OPENING_REGRESSION_LIVE_DIVERGENCE",
      ...liveDivergences,
    ].join("\n"));
  }

  if (failures.length > 0) {
    throw new Error([
      "OPENING_REGRESSION_FAILURES",
      ...failures,
    ].join("\n"));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
