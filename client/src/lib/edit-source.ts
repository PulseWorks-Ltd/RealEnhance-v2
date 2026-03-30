import type { DisplayOutputKey } from "./card-artifacts";

export type SourceStageLabel = "original" | "1A" | "1B" | "2" | "retry" | "edit";

type ResolvedEditSource = {
  sourceUrl: string | null;
  sourceStage: SourceStageLabel | null;
  selectedTab: DisplayOutputKey | null;
  sourceJobId: string | null;
};

type ResolveSelectedEditSourceInput = {
  selectedTab?: DisplayOutputKey | null;
  stage2Url?: string | null;
  stage1BUrl?: string | null;
  stage1AUrl?: string | null;
  retryLatestUrl?: string | null;
  editLatestUrl?: string | null;
  originalUrl?: string | null;
  defaultJobId?: string | null;
  retryArtifactJobId?: string | null;
  editedArtifactJobId?: string | null;
};

function normalizeArtifactIdentityUrl(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return trimmed.split("?")[0]?.split("#")[0] || null;
  }
}

function isSameArtifactUrl(left?: string | null, right?: string | null): boolean {
  const normalizedLeft = normalizeArtifactIdentityUrl(left);
  const normalizedRight = normalizeArtifactIdentityUrl(right);
  return !!normalizedLeft && !!normalizedRight && normalizedLeft === normalizedRight;
}

export function resolveSelectedEditSource(input: ResolveSelectedEditSourceInput): ResolvedEditSource {
  const selectedTab = input.selectedTab || null;
  const defaultJobId = input.defaultJobId || null;
  const retryArtifactJobId = input.retryArtifactJobId || null;
  const editedArtifactJobId = input.editedArtifactJobId || null;

  if (selectedTab === "2") {
    if (input.retryLatestUrl && isSameArtifactUrl(input.stage2Url, input.retryLatestUrl)) {
      return {
        sourceUrl: input.retryLatestUrl,
        sourceStage: "retry",
        selectedTab: "retried",
        sourceJobId: retryArtifactJobId,
      };
    }
    return {
      sourceUrl: input.stage2Url || null,
      sourceStage: "2",
      selectedTab,
      sourceJobId: defaultJobId,
    };
  }

  if (selectedTab === "1B") {
    return {
      sourceUrl: input.stage1BUrl || null,
      sourceStage: "1B",
      selectedTab,
      sourceJobId: defaultJobId,
    };
  }

  if (selectedTab === "1A") {
    return {
      sourceUrl: input.stage1AUrl || null,
      sourceStage: "1A",
      selectedTab,
      sourceJobId: defaultJobId,
    };
  }

  if (selectedTab === "retried") {
    return {
      sourceUrl: input.retryLatestUrl || null,
      sourceStage: "retry",
      selectedTab,
      sourceJobId: retryArtifactJobId,
    };
  }

  if (selectedTab === "edited") {
    return {
      sourceUrl: input.editLatestUrl || null,
      sourceStage: "edit",
      selectedTab,
      sourceJobId: editedArtifactJobId || defaultJobId,
    };
  }

  if (selectedTab === "original") {
    return {
      sourceUrl: input.originalUrl || null,
      sourceStage: "original",
      selectedTab,
      sourceJobId: defaultJobId,
    };
  }

  return {
    sourceUrl: null,
    sourceStage: null,
    selectedTab: null,
    sourceJobId: null,
  };
}