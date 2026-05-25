/// <reference types="node" />

import fs from "fs/promises";
import path from "path";

type EvalHealth = {
  label: string;
  outputRoot: string;
  latestRunPath: string;
  pidFilePath: string;
  status: "healthy" | "stale" | "down" | "missing";
  details: Record<string, unknown>;
};

type PidFilePayload = {
  pid?: number;
  generatedAt?: string;
  logPath?: string;
  runDir?: string;
};

function readFlag(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  return process.argv[index + 1];
}

function parseIntFlag(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number | null | undefined): boolean {
  if (!Number.isFinite(pid) || !pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function statMtimeIso(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

async function evaluateRoot(params: {
  label: string;
  outputRoot: string;
  staleSeconds: number;
}): Promise<EvalHealth> {
  const latestRunPath = path.join(params.outputRoot, "latest-run.json");
  const pidFilePath = path.join(params.outputRoot, "continuity-eval.pid");

  const latest = await readJson<{ runDir?: string; generatedAt?: string }>(latestRunPath);
  const rootPidFile = await readJson<PidFilePayload>(pidFilePath);

  if (!latest?.runDir) {
    const rootPid = Number(rootPidFile?.pid || 0) || null;
    return {
      label: params.label,
      outputRoot: params.outputRoot,
      latestRunPath,
      pidFilePath,
      status: "missing",
      details: {
        reason: "latest_run_missing",
        rootPid,
        rootPidAlive: isProcessAlive(rootPid),
      },
    };
  }

  const runPidPath = path.join(latest.runDir, "continuity-eval.pid");
  const runPidFile = await readJson<PidFilePayload>(runPidPath);
  const runPid = Number(runPidFile?.pid || 0) || null;
  const runPidAlive = isProcessAlive(runPid);
  const rootPid = Number(rootPidFile?.pid || 0) || null;
  const rootPidAlive = isProcessAlive(rootPid);
  const effectivePid = runPid || rootPid;
  const effectivePidAlive = runPidAlive || rootPidAlive;

  const heartbeatPath = path.join(latest.runDir, "heartbeat.json");
  const crashPath = path.join(latest.runDir, "crash-report.json");
  const progressPath = path.join(latest.runDir, "progress-checkpoint.json");

  const heartbeat = await readJson<{ timestamp?: string; currentPhase?: string; currentProviderCall?: string }>(heartbeatPath);
  const crash = await readJson<{ timestamp?: string; signal?: string; error?: string }>(crashPath);
  const progress = await readJson<{ generatedAt?: string; completedCases?: number; totalCases?: number }>(progressPath);

  const heartbeatTs = heartbeat?.timestamp ? Date.parse(heartbeat.timestamp) : NaN;
  const now = Date.now();
  const heartbeatAgeSec = Number.isFinite(heartbeatTs) ? Math.max(0, Math.round((now - heartbeatTs) / 1000)) : null;
  const isHeartbeatStale = heartbeatAgeSec !== null && heartbeatAgeSec > params.staleSeconds;

  const status: EvalHealth["status"] = effectivePidAlive
    ? (isHeartbeatStale ? "stale" : "healthy")
    : (crash ? "down" : "stale");

  return {
    label: params.label,
    outputRoot: params.outputRoot,
    latestRunPath,
    pidFilePath,
    status,
    details: {
      runDir: latest.runDir,
      runPidPath,
      runPid,
      runPidAlive,
      runPidGeneratedAt: runPidFile?.generatedAt || null,
      rootPid,
      rootPidAlive,
      rootPidGeneratedAt: rootPidFile?.generatedAt || null,
      effectivePid,
      effectivePidAlive,
      latestGeneratedAt: latest.generatedAt || null,
      heartbeatPath,
      heartbeatTimestamp: heartbeat?.timestamp || null,
      heartbeatAgeSec,
      heartbeatStaleThresholdSec: params.staleSeconds,
      currentPhase: heartbeat?.currentPhase || null,
      currentProviderCall: heartbeat?.currentProviderCall || null,
      progressGeneratedAt: progress?.generatedAt || null,
      completedCases: progress?.completedCases ?? null,
      totalCases: progress?.totalCases ?? null,
      crashPath,
      crashTimestamp: crash?.timestamp || null,
      crashSignal: crash?.signal || null,
      crashError: crash?.error || null,
      heartbeatFileMtime: await statMtimeIso(heartbeatPath),
      progressFileMtime: await statMtimeIso(progressPath),
    },
  };
}

async function main(): Promise<void> {
  const staleSeconds = parseIntFlag(readFlag("stale-seconds"), 180);
  const outputRoot = readFlag("output-root") || "/workspaces/RealEnhance-v2/worker/artifacts/continuity-evaluation";
  const smokeOutputRoot = readFlag("smoke-output-root") || "/workspaces/RealEnhance-v2/worker/artifacts/continuity-evaluation-smoke";

  const checks = await Promise.all([
    evaluateRoot({ label: "full", outputRoot, staleSeconds }),
    evaluateRoot({ label: "smoke", outputRoot: smokeOutputRoot, staleSeconds }),
  ]);

  for (const check of checks) {
    const header = `[CONTINUITY_EVAL_HEALTH][${check.label}] ${check.status.toUpperCase()}`;
    console.log(header);
    console.log(JSON.stringify(check, null, 2));
  }

  // Non-zero exit when full evaluation is not currently healthy.
  const full = checks.find((item) => item.label === "full");
  if (!full || full.status !== "healthy") {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error("[CONTINUITY_EVAL_HEALTH][FATAL]", error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
