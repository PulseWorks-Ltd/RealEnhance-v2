import fs from "fs/promises";
import path from "path";

type EnvMap = Record<string, string>;

type ServiceSnapshot = {
  label: string;
  sourcePath: string;
  env: EnvMap;
};

type Finding = {
  severity: "error" | "warning";
  code: string;
  message: string;
  key?: string;
};

type PreflightResult = {
  ok: boolean;
  checkedAt: string;
  services: {
    worker: { label: string; sourcePath: string };
    experimental: { label: string; sourcePath: string };
  };
  lockedKeys: string[];
  findings: Finding[];
};

function readFlag(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function dequote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseDotEnv(raw: string): EnvMap {
  const env: EnvMap = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = dequote(trimmed.slice(eq + 1));
    if (!key) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

function parseQuotedValue(fileText: string, key: string): string | undefined {
  const keyIndex = fileText.indexOf(`${key}=`);
  if (keyIndex < 0) {
    return undefined;
  }
  const valueStart = keyIndex + key.length + 1;
  const firstChar = fileText[valueStart];
  if (firstChar !== '"') {
    return undefined;
  }

  let value = "";
  let cursor = valueStart + 1;
  let escaped = false;
  while (cursor < fileText.length) {
    const char = fileText[cursor];
    if (char === '"' && !escaped) {
      return value;
    }
    value += char;
    if (char === "\\" && !escaped) {
      escaped = true;
    } else {
      escaped = false;
    }
    cursor += 1;
  }
  return undefined;
}

function parseJsonObject(raw: string): EnvMap {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON object for env snapshot");
  }
  const out: EnvMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = String(value);
    }
  }
  return out;
}

async function loadEnvSnapshot(label: string, sourcePath: string): Promise<ServiceSnapshot> {
  const absolute = path.resolve(sourcePath);
  const raw = await fs.readFile(absolute, "utf8");
  const trimmed = raw.trim();

  let env: EnvMap;
  if (trimmed.startsWith("{")) {
    env = parseJsonObject(trimmed);
  } else {
    env = parseDotEnv(raw);
    const multilineCredentialsJson = parseQuotedValue(raw, "GOOGLE_APPLICATION_CREDENTIALS_JSON");
    if (multilineCredentialsJson) {
      env.GOOGLE_APPLICATION_CREDENTIALS_JSON = multilineCredentialsJson;
    }
  }

  return {
    label,
    sourcePath: absolute,
    env,
  };
}

function pushFinding(findings: Finding[], finding: Finding): void {
  findings.push(finding);
}

function valueOf(snapshot: ServiceSnapshot, key: string): string {
  return String(snapshot.env[key] || "").trim();
}

function checkRequiredKeys(findings: Finding[], snapshot: ServiceSnapshot, requiredKeys: string[]): void {
  for (const key of requiredKeys) {
    if (!valueOf(snapshot, key)) {
      pushFinding(findings, {
        severity: "error",
        code: "missing_required_key",
        message: `${snapshot.label} missing required key ${key}`,
        key,
      });
    }
  }
}

function checkLockedParity(
  findings: Finding[],
  worker: ServiceSnapshot,
  experimental: ServiceSnapshot,
  lockedKeys: string[],
  allowedDiff: Set<string>
): void {
  for (const key of lockedKeys) {
    if (allowedDiff.has(key)) {
      continue;
    }
    const workerValue = valueOf(worker, key);
    const experimentalValue = valueOf(experimental, key);
    if (workerValue !== experimentalValue) {
      pushFinding(findings, {
        severity: "error",
        code: "locked_mismatch",
        message: `${key} mismatch: worker='${workerValue}' experimental='${experimentalValue}'`,
        key,
      });
    }
  }
}

function parseCredentialsProjectId(rawJson: string): string | null {
  const trimmed = rawJson.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as { project_id?: unknown };
    return typeof parsed.project_id === "string" ? parsed.project_id.trim() || null : null;
  } catch {
    return null;
  }
}

function checkCredentialsAlignment(findings: Finding[], snapshot: ServiceSnapshot, strict: boolean): void {
  const project = valueOf(snapshot, "GOOGLE_CLOUD_PROJECT");
  const credentialsJson = valueOf(snapshot, "GOOGLE_APPLICATION_CREDENTIALS_JSON");
  if (!credentialsJson) {
    return;
  }
  const credentialsProject = parseCredentialsProjectId(credentialsJson);
  if (!credentialsProject) {
    if (!strict) {
      pushFinding(findings, {
        severity: "warning",
        code: "credentials_json_unparsed",
        message: `${snapshot.label} GOOGLE_APPLICATION_CREDENTIALS_JSON could not be parsed; skipped due to --skip-credentials-json-check`,
        key: "GOOGLE_APPLICATION_CREDENTIALS_JSON",
      });
      return;
    }
    pushFinding(findings, {
      severity: "error",
      code: "credentials_json_invalid",
      message: `${snapshot.label} GOOGLE_APPLICATION_CREDENTIALS_JSON is missing valid project_id`,
      key: "GOOGLE_APPLICATION_CREDENTIALS_JSON",
    });
    return;
  }
  if (project && credentialsProject !== project) {
    pushFinding(findings, {
      severity: "error",
      code: "credentials_project_mismatch",
      message: `${snapshot.label} credentials project_id '${credentialsProject}' does not match GOOGLE_CLOUD_PROJECT '${project}'`,
      key: "GOOGLE_APPLICATION_CREDENTIALS_JSON",
    });
  }
}

function checkProviderPlannerRenderer(findings: Finding[], snapshot: ServiceSnapshot): void {
  const provider = valueOf(snapshot, "SECONDARY_CONTINUITY_PROVIDER").toLowerCase();
  const planner = valueOf(snapshot, "SECONDARY_CONTINUITY_PLANNER").toLowerCase();
  const renderer = valueOf(snapshot, "SECONDARY_CONTINUITY_RENDERER").toLowerCase();

  if (provider !== "vertex") {
    pushFinding(findings, {
      severity: "error",
      code: "provider_not_vertex",
      message: `${snapshot.label} SECONDARY_CONTINUITY_PROVIDER must be 'vertex' (found '${provider || "<empty>"}')`,
      key: "SECONDARY_CONTINUITY_PROVIDER",
    });
  }

  if (planner !== "gemini25pro") {
    pushFinding(findings, {
      severity: "error",
      code: "planner_drift",
      message: `${snapshot.label} SECONDARY_CONTINUITY_PLANNER should be 'gemini25pro' for tested parity (found '${planner || "<empty>"}')`,
      key: "SECONDARY_CONTINUITY_PLANNER",
    });
  }

  if (renderer !== "imagen3") {
    pushFinding(findings, {
      severity: "error",
      code: "renderer_drift",
      message: `${snapshot.label} SECONDARY_CONTINUITY_RENDERER should be 'imagen3' for tested parity (found '${renderer || "<empty>"}')`,
      key: "SECONDARY_CONTINUITY_RENDERER",
    });
  }
}

function checkScopeWarnings(findings: Finding[]): void {
  pushFinding(findings, {
    severity: "warning",
    code: "scope_manual_verification_required",
    message: "Credential IAM scopes/roles cannot be proven from env alone; verify Storage object read/write on VERTEX_GCS_BUCKET for both service accounts.",
  });
}

function printHumanSummary(result: PreflightResult): void {
  console.log("[CONTINUITY_ENV_PREFLIGHT]", result.ok ? "PASS" : "FAIL");
  console.log(`[CONTINUITY_ENV_PREFLIGHT] checkedAt=${result.checkedAt}`);
  console.log(`[CONTINUITY_ENV_PREFLIGHT] worker=${result.services.worker.sourcePath}`);
  console.log(`[CONTINUITY_ENV_PREFLIGHT] experimental=${result.services.experimental.sourcePath}`);
  console.log(`[CONTINUITY_ENV_PREFLIGHT] lockedKeys=${result.lockedKeys.join(",")}`);

  if (result.findings.length === 0) {
    console.log("[CONTINUITY_ENV_PREFLIGHT] findings=none");
    return;
  }

  for (const finding of result.findings) {
    const prefix = finding.severity.toUpperCase();
    const keyPart = finding.key ? ` key=${finding.key}` : "";
    console.log(`[${prefix}] code=${finding.code}${keyPart} message=${finding.message}`);
  }
}

async function main(): Promise<void> {
  const workerEnvPath = readFlag("worker-env");
  const experimentalEnvPath = readFlag("experimental-env");
  const jsonOutput = hasFlag("json");
  const strictCredentialsJsonCheck = !hasFlag("skip-credentials-json-check");
  const allowedDiff = new Set(parseCsv(readFlag("allow-diff")));

  if (!workerEnvPath || !experimentalEnvPath) {
    throw new Error("Usage: tsx src/scripts/preflight-continuity-env.ts --worker-env <path> --experimental-env <path> [--allow-diff KEY1,KEY2] [--json]");
  }

  const lockedKeys = [
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "VERTEX_GCS_BUCKET",
    "SECONDARY_CONTINUITY_PROVIDER",
    "SECONDARY_CONTINUITY_PLANNER",
    "SECONDARY_CONTINUITY_RENDERER",
    "VERTEX_CONTINUITY_GUIDANCE_SCALE",
    "EXPERIMENT_ROOM_CONSISTENCY_V1",
    "CONTINUITY_USE_GEMINI_OCCUPANCY_MASK",
  ];

  const requiredKeys = [
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_APPLICATION_CREDENTIALS_JSON",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "VERTEX_GCS_BUCKET",
    "SECONDARY_CONTINUITY_PROVIDER",
    "SECONDARY_CONTINUITY_PLANNER",
    "SECONDARY_CONTINUITY_RENDERER",
  ];

  const worker = await loadEnvSnapshot("worker", workerEnvPath);
  const experimental = await loadEnvSnapshot("worker-vertex-experimental", experimentalEnvPath);
  const findings: Finding[] = [];

  checkRequiredKeys(findings, worker, requiredKeys);
  checkRequiredKeys(findings, experimental, requiredKeys);
  checkLockedParity(findings, worker, experimental, lockedKeys, allowedDiff);
  checkCredentialsAlignment(findings, worker, strictCredentialsJsonCheck);
  checkCredentialsAlignment(findings, experimental, strictCredentialsJsonCheck);
  checkProviderPlannerRenderer(findings, worker);
  checkProviderPlannerRenderer(findings, experimental);
  checkScopeWarnings(findings);

  const errorCount = findings.filter((finding) => finding.severity === "error").length;
  const result: PreflightResult = {
    ok: errorCount === 0,
    checkedAt: new Date().toISOString(),
    services: {
      worker: { label: worker.label, sourcePath: worker.sourcePath },
      experimental: { label: experimental.label, sourcePath: experimental.sourcePath },
    },
    lockedKeys,
    findings,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanSummary(result);
  }

  process.exitCode = result.ok ? 0 : 2;
}

main().catch((error) => {
  console.error("[CONTINUITY_ENV_PREFLIGHT][FATAL]", error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
