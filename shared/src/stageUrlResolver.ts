export type StageLabel = "1A" | "1B" | "2";

export type StageUrlMap = Record<string, unknown> | null | undefined;

export type StageUrlResolutionLog = {
  context?: string;
  stage: StageLabel;
  keysChecked: string[];
  selectedKey: string | null;
  selectedUrl: string | null;
  reason: "matched" | "not_found";
};

export type StageUrlResolutionOptions = {
  context?: string;
  logger?: (message: string, payload: StageUrlResolutionLog) => void;
};

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getStageUrlKeys(stage: StageLabel): string[] {
  switch (stage) {
    case "1A":
      return ["1A", "stage1a", "stage1A", "stage_1a", "stage_1A"];
    case "1B":
      return ["1B", "stage1b", "stage1B", "stage_1b", "stage_1B"];
    case "2":
      return ["2", "stage2", "stage_2"];
    default:
      return [stage];
  }
}

export function normalizeStageLabel(raw: string | null | undefined): StageLabel | null {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return null;
  if (value === "1a" || value === "stage1a" || value === "stage_1a") return "1A";
  if (value === "1b" || value === "stage1b" || value === "stage_1b" || value === "1b-stage-ready" || value === "1b-light") return "1B";
  if (value === "2" || value === "stage2" || value === "stage_2") return "2";
  return null;
}

export function resolveStageUrl(
  stageUrls: StageUrlMap,
  stage: StageLabel,
  opts?: StageUrlResolutionOptions,
): string | null {
  const keys = getStageUrlKeys(stage);
  const map = (stageUrls || {}) as Record<string, unknown>;
  let selectedKey: string | null = null;
  let selectedUrl: string | null = null;

  for (const key of keys) {
    const candidate = asNonEmptyString(map[key]);
    if (!candidate) continue;
    selectedKey = key;
    selectedUrl = candidate;
    break;
  }

  if (opts?.logger) {
    opts.logger("[stage-url-resolve]", {
      context: opts.context,
      stage,
      keysChecked: keys,
      selectedKey,
      selectedUrl,
      reason: selectedUrl ? "matched" : "not_found",
    });
  }

  return selectedUrl;
}

export function mergeStageUrls(existing: StageUrlMap, patch: StageUrlMap): Record<string, string | null> {
  const current = { ...((existing || {}) as Record<string, unknown>) };
  const incoming = (patch || {}) as Record<string, unknown>;

  const writeValue = (key: string, value: string | null) => {
    const existingValue = asNonEmptyString(current[key]);
    if (value === null && existingValue) {
      return;
    }
    current[key] = value;
  };

  for (const [key, value] of Object.entries(incoming)) {
    const normalized = asNonEmptyString(value);
    const val = normalized ?? null;
    writeValue(key, val);

    const stage = normalizeStageLabel(key);
    if (!stage) continue;

    const aliases = getStageUrlKeys(stage);
    for (const alias of aliases) {
      writeValue(alias, val);
    }
  }

  return current as Record<string, string | null>;
}
