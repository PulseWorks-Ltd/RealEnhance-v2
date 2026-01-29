// Shared helpers to manage persisted enhancement/batch state across users and tabs.
// Keeps key generation and clear requests in one place to avoid cross-account leakage.

export const LEGACY_BATCH_KEY = "pmf_batch_job";
export const LEGACY_ACTIVE_KEY = "activeBatchJobIds";
export const CLEAR_EVENT = "realenhance:clear-enhancements";

export const makeBatchKey = (userId?: string | null) =>
  userId ? `${LEGACY_BATCH_KEY}:${userId}` : LEGACY_BATCH_KEY;

export const makeActiveKey = (userId?: string | null) =>
  userId ? `${LEGACY_ACTIVE_KEY}:${userId}` : LEGACY_ACTIVE_KEY;

export function migrateLegacyKeysOnce(userId?: string | null) {
  try {
    const legacyBatch = localStorage.getItem(LEGACY_BATCH_KEY);
    const legacyActive = localStorage.getItem(LEGACY_ACTIVE_KEY);
    if (legacyBatch || legacyActive) {
      localStorage.removeItem(LEGACY_BATCH_KEY);
      localStorage.removeItem(LEGACY_ACTIVE_KEY);
      localStorage.removeItem("activeJobId");
      console.log("[BATCH_RESTORE_CLEARED_LEGACY_KEYS]", { userId });
    }
  } catch (err) {
    console.warn("[BATCH_RESTORE_CLEARED_LEGACY_KEYS] failed", err);
  }
}

export function clearEnhancementStateStorage(userId?: string | null) {
  try {
    localStorage.removeItem(makeBatchKey(userId));
    localStorage.removeItem(makeActiveKey(userId));
    localStorage.removeItem("activeJobId");
    // Always clear legacy keys to prevent rehydration from old data.
    localStorage.removeItem(LEGACY_BATCH_KEY);
    localStorage.removeItem(LEGACY_ACTIVE_KEY);
  } catch (err) {
    console.warn("[BATCH_CLEAR_STORAGE] failed", err);
  }
}

export function requestClearEnhancementState(userId?: string | null) {
  clearEnhancementStateStorage(userId);
  try {
    window.dispatchEvent(
      new CustomEvent(CLEAR_EVENT, { detail: { userId: userId ?? null } })
    );
  } catch (err) {
    console.warn("[BATCH_CLEAR_EVENT] dispatch failed", err);
  }
}