import path from "path";
import fs from "fs/promises";
import { runContinuityEvaluation, type EvaluationMode } from "../continuity/evaluation/harness";

function readFlag(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  return process.argv[index + 1];
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseMode(raw: string | undefined): EvaluationMode {
  const value = String(raw || "full").trim().toLowerCase();
  const supported: EvaluationMode[] = [
    "full",
    "live",
    "replay_planner",
    "replay_occupancy",
    "occupancy_only",
    "replay_continuity",
    "continuity_only",
    "validator_only",
  ];
  if (!supported.includes(value as EvaluationMode)) {
    throw new Error(`Unsupported mode: ${value}. Supported modes: ${supported.join(", ")}`);
  }
  return value as EvaluationMode;
}

function decodeQuotedEnvValue(value: string): string {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    if (current !== "\\") {
      decoded += current;
      continue;
    }
    const next = value[index + 1];
    if (next === undefined) {
      decoded += current;
      continue;
    }
    if (next === "n") {
      decoded += "\n";
      index += 1;
      continue;
    }
    if (next === "r") {
      decoded += "\r";
      index += 1;
      continue;
    }
    if (next === "t") {
      decoded += "\t";
      index += 1;
      continue;
    }
    if (next === '"' || next === "\\") {
      decoded += next;
      index += 1;
      continue;
    }
    decoded += next;
    index += 1;
  }
  return decoded;
}

function parseQuotedValue(fileText: string, key: string): string | undefined {
  const keyIndex = fileText.indexOf(`${key}=`);
  if (keyIndex < 0) {
    return undefined;
  }
  const valueStart = keyIndex + key.length + 1;
  const firstChar = fileText[valueStart];
  if (firstChar !== '"') {
    const lineEnd = fileText.indexOf("\n", valueStart);
    const rawValue = fileText.slice(valueStart, lineEnd >= 0 ? lineEnd : undefined).trim();
    return rawValue || undefined;
  }

  let value = "";
  let cursor = valueStart + 1;
  let escaped = false;
  while (cursor < fileText.length) {
    const char = fileText[cursor];
    if (char === '"' && !escaped) {
      break;
    }
    value += char;
    if (char === "\\" && !escaped) {
      escaped = true;
    } else {
      escaped = false;
    }
    cursor += 1;
  }
  return decodeQuotedEnvValue(value);
}

async function loadContinuityEnvFromFile(envPath: string): Promise<void> {
  const fileText = await fs.readFile(envPath, "utf8");
  const requiredKeys = [
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_APPLICATION_CREDENTIALS_JSON",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "VERTEX_GCS_BUCKET",
    "SECONDARY_CONTINUITY_PLANNER",
  ];

  for (const key of requiredKeys) {
    if (String(process.env[key] || "").trim()) {
      continue;
    }
    const value = parseQuotedValue(fileText, key);
    if (value) {
      process.env[key] = value;
    }
  }
}

async function main(): Promise<void> {
  await loadContinuityEnvFromFile("/workspaces/RealEnhance-v2/server/.env");

  const datasetDir = readFlag("dataset-dir") || path.join("/workspaces/RealEnhance-v2", "MultiView Images");
  const outputRootDir = readFlag("output-root") || path.join("/workspaces/RealEnhance-v2/worker/artifacts", "continuity-evaluation");
  const mode = parseMode(readFlag("mode"));
  const sourceRunDir = readFlag("source-run-dir") || undefined;
  const useGeminiOccupancy = parseBoolean(readFlag("use-gemini-occupancy"), true);
  const maxCasesRaw = readFlag("max-cases");
  const maxCases = maxCasesRaw ? Number(maxCasesRaw) : undefined;

  if ((mode === "replay_planner" || mode === "replay_occupancy" || mode === "occupancy_only" || mode === "replay_continuity" || mode === "continuity_only" || mode === "validator_only") && !sourceRunDir) {
    throw new Error(`Mode ${mode} requires --source-run-dir`);
  }

  const result = await runContinuityEvaluation({
    datasetDir,
    outputRootDir,
    mode,
    sourceRunDir,
    useGeminiOccupancy,
    maxCases: Number.isFinite(maxCases) ? maxCases : undefined,
  });

  console.log(JSON.stringify({
    runDir: result.runDir,
    datasetManifestPath: path.join(result.runDir, "continuity-dataset-manifest.json"),
    summaryPath: path.join(result.runDir, "continuity-evaluation-summary.json"),
    failureAnalysisPath: path.join(result.runDir, "failure-analysis.json"),
    mode,
    totalRooms: result.summary.totalRooms,
    totalSecondaryViews: result.summary.totalSecondaryViews,
    completedCases: result.summary.completedCases,
    successCount: result.summary.successCount,
    failureCount: result.summary.failureCount,
    successRate: result.summary.successRate,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
