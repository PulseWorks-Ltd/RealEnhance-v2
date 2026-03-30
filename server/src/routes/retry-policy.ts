function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function jobHasEditedArtifact(data: any): boolean {
  if (!data || typeof data !== "object") return false;

  const candidateJobId =
    asNonEmptyString(data?.editLatestJobId) ||
    asNonEmptyString(data?.meta?.editLatestJobId) ||
    null;

  const candidateUrl =
    asNonEmptyString(data?.latestEditUrl) ||
    asNonEmptyString(data?.editLatestUrl) ||
    asNonEmptyString(data?.meta?.latestEditUrl) ||
    asNonEmptyString(data?.meta?.editLatestUrl) ||
    null;

  return !!(candidateJobId || candidateUrl);
}
