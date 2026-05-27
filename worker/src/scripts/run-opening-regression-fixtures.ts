import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  extractStructuralBaseline,
  type StructuralBaseline,
} from "../validators/openingPreservationValidator";
import { runOpeningValidator } from "../validators/openingValidator";

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
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
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

async function maybeLoadSnapshots(snapshotFilePath: string): Promise<SnapshotBundle | null> {
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
  const enforceLive = hasFlag("--enforce-live");
  const updateSnapshots = hasFlag("--update-snapshots");

  if (mode !== "live" && updateSnapshots) {
    throw new Error("OPENING_REGRESSION_INVALID_ARGS: --update-snapshots requires --mode live");
  }

  const workspaceRoot = resolveWorkspaceRoot();
  const workerRoot = path.join(workspaceRoot, "worker");
  const fixtureRoot = path.join(workspaceRoot, "Test Images", "Opening Validator");
  const snapshotFilePath = readArg("--snapshot-file")
    || process.env.OPENING_REGRESSION_SNAPSHOT_FILE
    || path.join(workerRoot, "src", "scripts", "opening-regression-fixtures.snapshots.json");

  const snapshotBundle = await maybeLoadSnapshots(snapshotFilePath);
  const snapshotByFixture = new Map<string, SnapshotFixtureRecord>(
    (snapshotBundle?.fixtures || []).map((fixture) => [fixtureKey(fixture), fixture]),
  );

  if (mode === "snapshot" && snapshotByFixture.size === 0) {
    throw new Error(
      [
        "OPENING_REGRESSION_SNAPSHOTS_MISSING",
        `snapshotFile=${snapshotFilePath}`,
        "Run live capture once to lock fixture graphs:",
        "pnpm --filter @realenhance/worker run test:opening-regression-fixtures:live:update",
      ].join("\n")
    );
  }

  const baselineCache = new Map<string, StructuralBaseline>();
  const capturedSnapshots = new Map<string, SnapshotFixtureRecord>();
  const failures: string[] = [];
  const telemetryMismatches: string[] = [];

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

    const result = await runOpeningValidator(beforePath, afterPath, {
      jobId: mode === "snapshot" ? "opening-regression-snapshot" : "opening-regression-live",
      imageId: fixture.staged,
      attempt: 1,
      baseline,
      detectedBaseline: candidate,
    });

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
      if (mode === "snapshot" || enforceLive) {
        failures.push(line);
      } else {
        telemetryMismatches.push(line);
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
        advisorySignals: result.advisorySignals,
      },
      expected: {
        status: fixture.expectStatus,
        hardFail: fixture.expectHardFail,
      },
      pass: fixturePass,
    }));
  }

  if (mode === "live" && updateSnapshots) {
    if (capturedSnapshots.size !== FIXTURES.length) {
      throw new Error("OPENING_REGRESSION_CAPTURE_INCOMPLETE: unable to capture all fixture snapshots");
    }

    const bundle: SnapshotBundle = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      fixtures: FIXTURES.map((fixture) => {
        const record = capturedSnapshots.get(fixtureKey(fixture));
        if (!record) {
          throw new Error(`OPENING_REGRESSION_CAPTURE_MISSING_FIXTURE: ${fixtureKey(fixture)}`);
        }
        return record;
      }),
    };

    await writeSnapshots(snapshotFilePath, bundle);
    console.log(`OPENING_REGRESSION_SNAPSHOTS_UPDATED: ${snapshotFilePath}`);
  }

  if (failures.length > 0) {
    const message = [
      mode === "snapshot" ? "OPENING_REGRESSION_SNAPSHOT_FAILURE" : "OPENING_REGRESSION_LIVE_FAILURE",
      ...failures,
    ].join("\n");
    throw new Error(message);
  }

  if (mode === "snapshot") {
    console.log("OPENING_REGRESSION_SNAPSHOT_SUCCESS");
    return;
  }

  if (telemetryMismatches.length > 0) {
    console.log(
      [
        "OPENING_REGRESSION_LIVE_TELEMETRY_MISMATCHES",
        ...telemetryMismatches,
      ].join("\n")
    );
  }

  console.log("OPENING_REGRESSION_LIVE_TELEMETRY_SUCCESS");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
