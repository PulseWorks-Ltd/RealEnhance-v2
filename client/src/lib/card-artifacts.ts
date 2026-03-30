export type StageKey = "1A" | "1B" | "2";
export type ArtifactType = "original" | "retry" | "edit";
export type DisplayOutputKey = StageKey | "retried" | "edited" | "original";
export type CardArtifactKey = DisplayOutputKey | "final";

export type CardArtifactViewItem = {
  key: CardArtifactKey;
  stage: StageKey | null;
  artifactType: ArtifactType;
  label: string;
  url: string;
  selectable: boolean;
};

export type CardArtifactView = {
  active: CardArtifactViewItem | null;
  available: CardArtifactViewItem[];
  currentArtifact: ArtifactType | null;
  selectedKey: DisplayOutputKey | null;
};

const toDisplayUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("blob:") ||
    normalized.startsWith("data:image/") ||
    normalized.startsWith("/")
  ) {
    return normalized;
  }
  return null;
};

export function getCardArtifactView(
  data: any,
  options?: {
    selectedKey?: DisplayOutputKey | null;
    originalFallback?: string | null;
    stageFallback?: { stage2?: string | null; stage1B?: string | null; stage1A?: string | null };
  }
): CardArtifactView {
  if (!data) {
    return {
      active: null,
      available: [],
      currentArtifact: null,
      selectedKey: null,
    };
  }

  const selectedKey = options?.selectedKey || null;
  const stageMap =
    data?.stageUrls ||
    data?.result?.stageUrls ||
    data?.stageOutputs ||
    data?.result?.stageOutputs ||
    null;
  const stageFallback = options?.stageFallback;
  const status = String(data?.status || data?.result?.status || "").toLowerCase();
  const validation = data?.validation || data?.result?.validation || data?.meta?.unifiedValidation || {};
  const blockedStage = (validation as any)?.blockedStage || data?.blockedStage || data?.result?.blockedStage || data?.meta?.blockedStage || null;
  const fallbackStage = (validation as any)?.fallbackStage ?? data?.fallbackStage ?? data?.result?.fallbackStage ?? data?.meta?.fallbackStage ?? null;
  const isRegionEdit =
    data?.completionSource === "region-edit" ||
    data?.result?.completionSource === "region-edit" ||
    String(data?.meta?.type || "").toLowerCase() === "region-edit" ||
    String(data?.meta?.jobType || "").toLowerCase() === "region_edit";

  const stage2Url =
    toDisplayUrl(stageMap?.["2"]) ||
    toDisplayUrl(stageMap?.[2]) ||
    toDisplayUrl(stageMap?.stage2) ||
    toDisplayUrl(data?.stage2Url) ||
    toDisplayUrl(data?.result?.stage2Url) ||
    toDisplayUrl(stageFallback?.stage2) ||
    null;
  const stage1BUrl =
    toDisplayUrl(stageMap?.["1B"]) ||
    toDisplayUrl(stageMap?.["1b"]) ||
    toDisplayUrl(stageMap?.stage1B) ||
    toDisplayUrl(stageFallback?.stage1B) ||
    null;
  const stage1AUrl =
    toDisplayUrl(stageMap?.["1A"]) ||
    toDisplayUrl(stageMap?.["1a"]) ||
    toDisplayUrl(stageMap?.["1"]) ||
    toDisplayUrl(stageMap?.stage1A) ||
    toDisplayUrl(stageFallback?.stage1A) ||
    null;
  const retryLatestUrl =
    toDisplayUrl(data?.latestRetryUrl) ||
    toDisplayUrl(data?.retryLatestUrl) ||
    toDisplayUrl(data?.result?.latestRetryUrl) ||
    toDisplayUrl(data?.result?.retryLatestUrl) ||
    null;
  const editLatestUrl =
    toDisplayUrl(data?.latestEditUrl) ||
    toDisplayUrl(data?.editLatestUrl) ||
    toDisplayUrl(data?.result?.latestEditUrl) ||
    toDisplayUrl(data?.result?.editLatestUrl) ||
    null;
  const finalOutputUrl =
    toDisplayUrl(data?.finalOutputUrl) ||
    toDisplayUrl(data?.result?.finalOutputUrl) ||
    toDisplayUrl(data?.resultUrl) ||
    toDisplayUrl(data?.result?.resultUrl) ||
    toDisplayUrl(data?.image) ||
    toDisplayUrl(data?.imageUrl) ||
    toDisplayUrl(data?.result?.image) ||
    toDisplayUrl(data?.result?.imageUrl) ||
    toDisplayUrl(data?.result?.result?.imageUrl) ||
    null;
  const originalUrl =
    toDisplayUrl(data?.originalImageUrl) ||
    toDisplayUrl(data?.result?.originalImageUrl) ||
    toDisplayUrl(data?.originalUrl) ||
    toDisplayUrl(data?.result?.originalUrl) ||
    toDisplayUrl(options?.originalFallback) ||
    null;
  const resolvedEditUrl = editLatestUrl || (isRegionEdit ? finalOutputUrl : null);

  const items = new Map<CardArtifactKey, CardArtifactViewItem>();
  const pushArtifact = (
    key: CardArtifactKey,
    stage: StageKey | null,
    artifactType: ArtifactType,
    label: string,
    url: string | null,
    selectable = true
  ) => {
    if (!url || items.has(key)) return;
    items.set(key, { key, stage, artifactType, label, url, selectable });
  };

  pushArtifact("original", null, "original", "Original", originalUrl);
  pushArtifact("1A", "1A", "original", "Enhanced", stage1AUrl);
  pushArtifact("1B", "1B", "original", "Decluttered", stage1BUrl);
  pushArtifact("2", "2", "original", "Staged", stage2Url);
  pushArtifact("retried", "2", "retry", "Retry", retryLatestUrl);
  pushArtifact("edited", null, "edit", "Edit", resolvedEditUrl);

  const hasConcretePipelineArtifact = !!(stage2Url || stage1BUrl || stage1AUrl || resolvedEditUrl || retryLatestUrl || originalUrl);
  if (finalOutputUrl && !hasConcretePipelineArtifact) {
    pushArtifact("final", null, "original", "Final", finalOutputUrl, false);
  }

  const available = Array.from(items.values());
  const byKey = (key: CardArtifactKey | null | undefined) => (key ? items.get(key) || null : null);
  const pickFallback = (): CardArtifactViewItem | null => {
    if (fallbackStage === "1B") return byKey("1B");
    if (fallbackStage === "1A") return byKey("1A");
    return byKey("1B") || byKey("1A") || null;
  };
  const pickNonDestructiveDefault = (): CardArtifactViewItem | null => {
    return (
      byKey("edited") ||
      byKey("retried") ||
      pickFallback() ||
      byKey("2") ||
      byKey("1B") ||
      byKey("1A") ||
      byKey("original") ||
      byKey("final")
    );
  };

  let active = byKey(selectedKey);
  if (!active) {
    if (status === "failed") {
      active = pickNonDestructiveDefault();
    } else if (blockedStage) {
      active = pickNonDestructiveDefault();
    }
  }
  if (!active) {
    active =
      byKey("edited") ||
      byKey("retried") ||
      byKey("2") ||
      byKey("1B") ||
      byKey("1A") ||
      byKey("original") ||
      byKey("final");
  }

  return {
    active,
    available,
    currentArtifact: active?.artifactType || null,
    selectedKey: active?.selectable ? (active.key as DisplayOutputKey) : null,
  };
}

export function resolveSafeStageUrl(data: any): { url: string | null; stage: StageKey | null } {
  const active = getCardArtifactView(data).active;
  return { url: active?.url || null, stage: active?.stage || null };
}
