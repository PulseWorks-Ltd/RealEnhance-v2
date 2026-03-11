const PENDING_ENHANCEMENT_KEY = "pendingEnhancementJobId";
const PENDING_ENHANCEMENT_IDS_KEY = "pendingEnhancementJobIds";
const PENDING_ENHANCEMENT_SESSION_KEY = "pendingEnhancementSessionV2";
const PENDING_ENHANCEMENT_TTL_MS = 90 * 60 * 1000;

export type PendingEnhancementResumeStatus = "pending" | "rehydrated";

export type PendingEnhancementFileMetadata = {
  name: string;
  size: number;
  type: string;
  lastModified: number;
};

export type PendingEnhancementSession = {
  version: 2;
  ownerUserId?: string | null;
  jobIds: string[];
  imageIds: string[];
  fileMetadata: PendingEnhancementFileMetadata[];
  previewUrls: string[];
  roomTypeByImageId: Record<string, string>;
  sceneTypeByImageId: Record<string, string>;
  stagingStyle?: string;
  resumeStatus: PendingEnhancementResumeStatus;
  rehydratedAt?: number;
  requestedCount: number;
  requiredCredits: number;
  availableCredits: number;
  missingCredits: number;
  createdAt: number;
  expiresAt: number;
};

type PendingEnhancementSessionInput = {
  ownerUserId?: string | null;
  jobIds: string[];
  imageIds?: string[];
  fileMetadata?: PendingEnhancementFileMetadata[];
  previewUrls?: string[];
  roomTypeByImageId?: Record<string, string>;
  sceneTypeByImageId?: Record<string, string>;
  stagingStyle?: string;
  resumeStatus?: PendingEnhancementResumeStatus;
  rehydratedAt?: number;
  requestedCount?: number;
  requiredCredits?: number;
  availableCredits?: number;
  missingCredits?: number;
  createdAt?: number;
  expiresAt?: number;
};

function normalizeIds(ids: string[]): string[] {
  return Array.from(new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean)));
}

function normalizePreviewUrls(urls: unknown): string[] {
  if (!Array.isArray(urls)) return [];
  return urls.map((url) => String(url || "").trim());
}

function normalizeStringMap(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const entries = Object.entries(input as Record<string, unknown>)
    .map(([k, v]) => [String(k || "").trim(), String(v || "").trim()] as const)
    .filter(([k, v]) => !!k && !!v);
  return Object.fromEntries(entries);
}

function normalizeResumeStatus(value: unknown): PendingEnhancementResumeStatus {
  return value === "pending" ? "pending" : "rehydrated";
}

function parseSession(raw: string | null): PendingEnhancementSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;

    const jobIds = normalizeIds(Array.isArray(parsed.jobIds) ? parsed.jobIds : []);
    if (!jobIds.length) return null;

    const createdAt = Number(parsed.createdAt || 0);
    const expiresAt = Number(parsed.expiresAt || 0);
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || createdAt <= 0 || expiresAt <= 0) {
      return null;
    }

    return {
      version: 2,
      ownerUserId: parsed.ownerUserId ? String(parsed.ownerUserId) : undefined,
      jobIds,
      imageIds: normalizeIds(Array.isArray(parsed.imageIds) ? parsed.imageIds : []),
      fileMetadata: Array.isArray(parsed.fileMetadata)
        ? parsed.fileMetadata
            .map((f: any) => ({
              name: String(f?.name || ""),
              size: Math.max(0, Number(f?.size || 0)),
              type: String(f?.type || "application/octet-stream"),
              lastModified: Math.max(0, Number(f?.lastModified || 0)),
            }))
            .filter((f: PendingEnhancementFileMetadata) => !!f.name)
        : [],
      previewUrls: normalizePreviewUrls(parsed.previewUrls),
      roomTypeByImageId: normalizeStringMap(parsed.roomTypeByImageId),
      sceneTypeByImageId: normalizeStringMap(parsed.sceneTypeByImageId),
      stagingStyle: parsed.stagingStyle ? String(parsed.stagingStyle) : undefined,
      resumeStatus: normalizeResumeStatus(parsed.resumeStatus),
      rehydratedAt: Number.isFinite(Number(parsed.rehydratedAt))
        ? Math.max(0, Number(parsed.rehydratedAt))
        : undefined,
      requestedCount: Math.max(0, Number(parsed.requestedCount || 0)),
      requiredCredits: Math.max(0, Number(parsed.requiredCredits || 0)),
      availableCredits: Math.max(0, Number(parsed.availableCredits || 0)),
      missingCredits: Math.max(0, Number(parsed.missingCredits || 0)),
      createdAt,
      expiresAt,
    };
  } catch {
    return null;
  }
}

export function setPendingEnhancementSession(input: PendingEnhancementSessionInput) {
  const normalizedJobIds = normalizeIds(input.jobIds || []);
  if (!normalizedJobIds.length) {
    clearPendingEnhancementJobs();
    return;
  }

  const now = Date.now();
  const createdAt = Number(input.createdAt || now);
  const expiresAt = Number(input.expiresAt || (createdAt + PENDING_ENHANCEMENT_TTL_MS));

  const payload: PendingEnhancementSession = {
    version: 2,
    ownerUserId: input.ownerUserId ? String(input.ownerUserId) : undefined,
    jobIds: normalizedJobIds,
    imageIds: normalizeIds(input.imageIds || []),
    fileMetadata: Array.isArray(input.fileMetadata) ? input.fileMetadata : [],
    previewUrls: normalizePreviewUrls(input.previewUrls),
    roomTypeByImageId: normalizeStringMap(input.roomTypeByImageId),
    sceneTypeByImageId: normalizeStringMap(input.sceneTypeByImageId),
    stagingStyle: input.stagingStyle ? String(input.stagingStyle) : undefined,
    resumeStatus: normalizeResumeStatus(input.resumeStatus),
    rehydratedAt: Number.isFinite(Number(input.rehydratedAt))
      ? Math.max(0, Number(input.rehydratedAt))
      : undefined,
    requestedCount: Math.max(0, Number(input.requestedCount || 0)),
    requiredCredits: Math.max(0, Number(input.requiredCredits || 0)),
    availableCredits: Math.max(0, Number(input.availableCredits || 0)),
    missingCredits: Math.max(0, Number(input.missingCredits || 0)),
    createdAt,
    expiresAt,
  };

  localStorage.setItem(PENDING_ENHANCEMENT_SESSION_KEY, JSON.stringify(payload));
  localStorage.setItem(PENDING_ENHANCEMENT_KEY, normalizedJobIds[0]);
  localStorage.setItem(PENDING_ENHANCEMENT_IDS_KEY, JSON.stringify(normalizedJobIds));
}

export function getPendingEnhancementSession(): PendingEnhancementSession | null {
  const parsed = parseSession(localStorage.getItem(PENDING_ENHANCEMENT_SESSION_KEY));
  if (!parsed) return null;
  if (Date.now() >= parsed.expiresAt) {
    clearPendingEnhancementJobs();
    return null;
  }
  return parsed;
}

export function setPendingEnhancementJobs(jobIds: string[]) {
  const normalized = normalizeIds(jobIds || []);
  if (!normalized.length) {
    clearPendingEnhancementJobs();
    return;
  }

  const existing = getPendingEnhancementSession();
  setPendingEnhancementSession({
    ownerUserId: existing?.ownerUserId,
    jobIds: normalized,
    imageIds: existing?.imageIds || [],
    fileMetadata: existing?.fileMetadata || [],
    previewUrls: existing?.previewUrls || [],
    roomTypeByImageId: existing?.roomTypeByImageId || {},
    sceneTypeByImageId: existing?.sceneTypeByImageId || {},
    stagingStyle: existing?.stagingStyle,
    resumeStatus: existing?.resumeStatus || "rehydrated",
    rehydratedAt: existing?.rehydratedAt,
    requestedCount: existing?.requestedCount || normalized.length,
    requiredCredits: existing?.requiredCredits || 0,
    availableCredits: existing?.availableCredits || 0,
    missingCredits: existing?.missingCredits || 0,
    createdAt: existing?.createdAt,
    expiresAt: existing?.expiresAt,
  });
}

export function getPendingEnhancementJobId(): string | null {
  const value = localStorage.getItem(PENDING_ENHANCEMENT_KEY);
  const normalized = String(value || "").trim();
  return normalized || null;
}

export function getPendingEnhancementJobIds(): string[] {
  const session = getPendingEnhancementSession();
  if (session?.jobIds?.length) return session.jobIds;

  try {
    const raw = localStorage.getItem(PENDING_ENHANCEMENT_IDS_KEY);
    if (!raw) {
      const fallback = getPendingEnhancementJobId();
      return fallback ? [fallback] : [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      const fallback = getPendingEnhancementJobId();
      return fallback ? [fallback] : [];
    }
    return Array.from(new Set(parsed.map((id) => String(id || "").trim()).filter(Boolean)));
  } catch {
    const fallback = getPendingEnhancementJobId();
    return fallback ? [fallback] : [];
  }
}

export function clearPendingEnhancementJobs() {
  localStorage.removeItem(PENDING_ENHANCEMENT_SESSION_KEY);
  localStorage.removeItem(PENDING_ENHANCEMENT_KEY);
  localStorage.removeItem(PENDING_ENHANCEMENT_IDS_KEY);
}

export function setPendingEnhancementResumeStatus(status: PendingEnhancementResumeStatus) {
  const existing = getPendingEnhancementSession();
  if (!existing) return;

  setPendingEnhancementSession({
    ownerUserId: existing.ownerUserId,
    jobIds: existing.jobIds,
    imageIds: existing.imageIds,
    fileMetadata: existing.fileMetadata,
    previewUrls: existing.previewUrls,
    roomTypeByImageId: existing.roomTypeByImageId,
    sceneTypeByImageId: existing.sceneTypeByImageId,
    stagingStyle: existing.stagingStyle,
    resumeStatus: status,
    rehydratedAt: status === "rehydrated" ? Date.now() : undefined,
    requestedCount: existing.requestedCount,
    requiredCredits: existing.requiredCredits,
    availableCredits: existing.availableCredits,
    missingCredits: existing.missingCredits,
    createdAt: existing.createdAt,
    expiresAt: existing.expiresAt,
  });
}
