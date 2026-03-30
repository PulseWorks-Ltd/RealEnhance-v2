function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function hasEditedArtifact(data: any): boolean {
  if (!data || typeof data !== "object") return false;

  const candidateJobId =
    asNonEmptyString(data?.editLatestJobId) ||
    asNonEmptyString(data?.result?.editLatestJobId) ||
    asNonEmptyString(data?.meta?.editLatestJobId) ||
    null;

  const candidateUrl =
    asNonEmptyString(data?.latestEditUrl) ||
    asNonEmptyString(data?.editLatestUrl) ||
    asNonEmptyString(data?.result?.latestEditUrl) ||
    asNonEmptyString(data?.result?.editLatestUrl) ||
    asNonEmptyString(data?.meta?.latestEditUrl) ||
    asNonEmptyString(data?.meta?.editLatestUrl) ||
    null;

  return !!(candidateJobId || candidateUrl);
}
