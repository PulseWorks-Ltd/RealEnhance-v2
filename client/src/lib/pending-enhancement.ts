const PENDING_ENHANCEMENT_KEY = "pendingEnhancementJobId";
const PENDING_ENHANCEMENT_IDS_KEY = "pendingEnhancementJobIds";

export function setPendingEnhancementJobs(jobIds: string[]) {
  const normalized = Array.from(new Set((jobIds || []).map((id) => String(id || "").trim()).filter(Boolean)));
  if (!normalized.length) {
    clearPendingEnhancementJobs();
    return;
  }

  localStorage.setItem(PENDING_ENHANCEMENT_KEY, normalized[0]);
  localStorage.setItem(PENDING_ENHANCEMENT_IDS_KEY, JSON.stringify(normalized));
}

export function getPendingEnhancementJobId(): string | null {
  const value = localStorage.getItem(PENDING_ENHANCEMENT_KEY);
  const normalized = String(value || "").trim();
  return normalized || null;
}

export function getPendingEnhancementJobIds(): string[] {
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
  localStorage.removeItem(PENDING_ENHANCEMENT_KEY);
  localStorage.removeItem(PENDING_ENHANCEMENT_IDS_KEY);
}
