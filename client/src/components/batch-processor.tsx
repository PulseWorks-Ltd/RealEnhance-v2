// Client-side stub for room type detection (replace with real logic as needed)
  // Replaced by backend ML API call below
import React, { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FixedSelect, FixedSelectItem } from "@/components/ui/FixedSelect";
import { Button } from "@/components/ui/button";
import { withDevice } from "@/lib/withDevice";
import { api, apiFetch, apiJson } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/context/AuthContext";
import { useAuthGuard } from "@/hooks/useAuthGuard";
import {
  CLEAR_EVENT,
  makeActiveKey,
  makeBatchKey,
  migrateLegacyKeysOnce,
  clearEnhancementStateStorage,
  requestClearEnhancementState,
} from "@/lib/enhancement-state";
import { getQuotaExceededMessage } from "@/lib/quota-messaging";
import { Modal } from "./Modal";
import { EditModal } from "./EditModal";
import { CompareSlider } from "./CompareSlider";
import { RegionEditor } from "./region-editor";
import { RetryDialog } from "./retry-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Dropzone } from "@/components/ui/dropzone";
import { ProcessingSteps, type ProcessingStep } from "@/components/ui/processing-steps";
import { EmptyStateLaunchpad } from "@/components/ui/empty-state-launchpad";
import { Loader2, CheckCircle, XCircle, AlertCircle, Home, Armchair, ChevronLeft, ChevronRight, CloudSun, Info, Maximize2, X, RefreshCw } from 'lucide-react';
import { Switch } from "@/components/ui/switch";
import { isStagingUIEnabled, getStagingDisabledMessage } from "@/lib/staging-guard";

type RunState = "idle" | "running" | "done";
type StageKey = "1A" | "1B" | "2";
type DisplayOutputKey = StageKey | "retried" | "edited";
type EditSourceStage = "stage2" | "stage1B" | "stage1A";
type PreviewModalImage = { url: string; filename: string; originalUrl?: string; index: number };

type SceneType = "interior" | "exterior";
type SceneLabel = SceneType;

type SceneDetectResult = {
  scene: SceneType | null;
  confidence: number; // 0..1
  signal: number;     // unpenalized/penalized aggregate signal 0..1
  features: {
    skyTop10: number;
    skyTop40: number;
    grassBottom: number;
    blueOverall: number;
    greenOverall: number;
    meanLum: number;
  };
  reason: "confident_interior" | "confident_exterior" | "uncertain" | "covered_exterior_suspect";
  source?: "client" | "server";
};

const EMPTY_SCENE_FEATURES = { skyTop10: 0, skyTop40: 0, grassBottom: 0, blueOverall: 0, greenOverall: 0, meanLum: 0 };

const INTERIOR_ROOM_TYPES: Array<{ value: string; label: string }> = [
  { value: "bedroom", label: "Bedroom" },
  { value: "living_room", label: "Living" },
  { value: "dining_room", label: "Dining" },
  { value: "kitchen", label: "Kitchen" },
  { value: "kitchen_dining", label: "Kitchen & Dining" },
  { value: "kitchen_living", label: "Kitchen & Living" },
  { value: "living_dining", label: "Living & Dining" },
  { value: "multiple_living", label: "Multiple Living" },
  { value: "study", label: "Study" },
  { value: "office", label: "Office" },
  { value: "bathroom-1", label: "Bathroom 1" },
  { value: "bathroom-2", label: "Bathroom 2" },
  { value: "laundry", label: "Laundry" },
  { value: "garage", label: "Garage" },
  { value: "basement", label: "Basement" },
  { value: "attic", label: "Attic" },
  { value: "hallway", label: "Hallway" },
  { value: "staircase", label: "Staircase" },
  { value: "entryway", label: "Entryway" },
  { value: "closet", label: "Closet" },
  { value: "pantry", label: "Pantry" },
  { value: "sunroom", label: "Sunroom" },
];

function estimateBatchCredits(images: Array<{ sceneType: string; userSelectedStage1B: boolean; userSelectedStage2: boolean }>): number {
  return images.reduce((sum, img) => {
    const sceneType = String(img.sceneType || "").toLowerCase();
    if (sceneType === "exterior") {
      return sum + 1;
    }
    if (img.userSelectedStage1B && img.userSelectedStage2) {
      return sum + 2;
    }
    return sum + 1;
  }, 0);
}

// Generate a stable ID for a file based on its properties (not array index)
function getFileId(f: File): string {
  return `${f.name}:${f.size}:${f.lastModified}`;
}

// Clamp a number into [0,1]; return null when not finite
const clamp01 = (value: number | null | undefined): number | null => {
  if (!Number.isFinite(value as number)) return null;
  const v = Number(value);
  if (Number.isNaN(v)) return null;
  return Math.min(1, Math.max(0, v));
};

const normalizeSceneLabel = (value: unknown): SceneType | null => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "interior" || normalized === "exterior") return normalized;
  return null;
};

// Scene signal thresholds (two-band hysteresis)
const SCENE_SIGNAL_LOW = (() => {
  const raw = Number((import.meta as any).env?.VITE_SCENE_SIGNAL_LOW);
  const clamped = clamp01(raw);
  return clamped === null ? 0.06 : clamped;
})();

const SCENE_SIGNAL_HIGH = (() => {
  const raw = Number((import.meta as any).env?.VITE_SCENE_SIGNAL_HIGH);
  const clamped = clamp01(raw);
  const safe = clamped === null ? 0.12 : clamped;
  return Math.max(safe, SCENE_SIGNAL_LOW + 0.01); // ensure ordering
})();

const SCENE_CONF_SCALE = (() => {
  const raw = Number((import.meta as any).env?.VITE_SCENE_CONF_SCALE);
  if (!Number.isFinite(raw) || raw <= 0) return 0.20;
  return raw;
})();

const IS_DEV = !!(import.meta as any).env?.DEV;

// Normalizer functions to handle shape mismatch between backend and frontend
function normalizeBatchItem(it: any): { ok: boolean; image?: string | null; error?: string } | null {
  if (!it) return null;
  const url = it.finalOutputUrl || it.result?.finalOutputUrl || it.image || it.imageUrl || it.result?.imageUrl || (Array.isArray(it.images) && it.images[0]?.url) || null;
  if (it.error) return { ok: false, error: String(it.error), image: null };
  if (!url) return { ok: false, error: 'completed_no_url', image: null };
  return { ok: true, image: url };
}

function getDisplayUrl(data: any): string | null {
  // Delegate to canonical resolver for all URL resolution
  const resolved = resolveSafeStageUrl(data);
  return resolved.url;
}

function resolveSafeStageUrl(data: any): { url: string | null; stage: StageKey | null } {
  if (!data) return { url: null, stage: null };

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

  const isRegionEdit =
    data?.completionSource === "region-edit" ||
    data?.result?.completionSource === "region-edit" ||
    String(data?.meta?.type || "").toLowerCase() === "region-edit" ||
    String(data?.meta?.jobType || "").toLowerCase() === "region_edit";
  const editLatestUrl =
    toDisplayUrl(data?.editLatestUrl) ||
    toDisplayUrl(data?.result?.editLatestUrl) ||
    null;

  const status = String(data?.status || data?.result?.status || "").toLowerCase();
  const validation = data?.validation || data?.result?.validation || data?.meta?.unifiedValidation || {};
  const blockedStage = (validation as any)?.blockedStage || data?.blockedStage || data?.result?.blockedStage || data?.meta?.blockedStage || null;
  const fallbackStage = (validation as any)?.fallbackStage ?? data?.fallbackStage ?? data?.result?.fallbackStage ?? data?.meta?.fallbackStage ?? null;

  const stageMap =
    data?.stageUrls ||
    data?.result?.stageUrls ||
    data?.stageOutputs ||
    data?.result?.stageOutputs ||
    null;

  const stage2 = toDisplayUrl(stageMap?.['2']) || toDisplayUrl(stageMap?.[2]) || toDisplayUrl(stageMap?.stage2) || toDisplayUrl(data?.stage2Url) || toDisplayUrl(data?.result?.stage2Url) || null;
  const stage1B = toDisplayUrl(stageMap?.['1B']) || toDisplayUrl(stageMap?.['1b']) || toDisplayUrl(stageMap?.stage1B) || toDisplayUrl(stageMap?.[1]) || null;
  const stage1A = toDisplayUrl(stageMap?.['1A']) || toDisplayUrl(stageMap?.['1a']) || toDisplayUrl(stageMap?.['1']) || null;

  const finalOutput =
    toDisplayUrl(data?.finalOutputUrl) ||
    toDisplayUrl(data?.result?.finalOutputUrl) ||
    null;

  const legacyResultAlias =
    toDisplayUrl(data?.resultUrl) ||
    toDisplayUrl(data?.image) ||
    toDisplayUrl(data?.imageUrl) ||
    toDisplayUrl(data?.result?.resultUrl) ||
    toDisplayUrl(data?.result?.image) ||
    toDisplayUrl(data?.result?.imageUrl) ||
    toDisplayUrl(data?.result?.result?.imageUrl) ||
    null;

  if (isRegionEdit) {
    return { url: editLatestUrl || finalOutput || legacyResultAlias || null, stage: null };
  }

  const pickFallback = (): { url: string | null; stage: StageKey | null } => {
    if (fallbackStage === "1B" && stage1B) return { url: stage1B, stage: "1B" };
    if (fallbackStage === "1A" && stage1A) return { url: stage1A, stage: "1A" };
    if (stage1B) return { url: stage1B, stage: "1B" };
    if (stage1A) return { url: stage1A, stage: "1A" };
    return { url: null, stage: null };
  };

  const isFailed = status === "failed";
  if (isFailed) return pickFallback();
  if (blockedStage) {
    const fb = pickFallback();
    if (fb.url) return fb;
  }

  if (finalOutput) return { url: finalOutput, stage: null };
  if (stage2) return { url: stage2, stage: "2" };
  if (stage1B) return { url: stage1B, stage: "1B" };
  if (stage1A) return { url: stage1A, stage: "1A" };
  return { url: legacyResultAlias, stage: legacyResultAlias ? ("2" as StageKey) : null };
}

// Add cache-busting version to force browser reload (only when version exists)
// NEVER modify signed URLs (AWS, GCS) — appending params breaks the signature
function withVersion(url?: string | null, version?: string | number): string | null {
  if (!url) return null;
  // Only add version param if we have an explicit version (from retry/edit)
  // Don't use Date.now() as fallback - that would invalidate on every render
  if (!version) return url;
  // Never append query params to signed URLs — breaks the signature
  if (
    url.includes('X-Amz-Signature') ||
    url.includes('Signature=') ||
    url.includes('GoogleAccessId=')
  ) {
    return url;
  }
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${version}`;
}

function toDisplayUrl(value: unknown): string | null {
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
}

function normalizeVersionToTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
    const parsed = Number(new Date(trimmed));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (value instanceof Date) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function getPerImageDeclutterRequested(item: any): boolean {
  const requestedStages = item?.requestedStages || item?.result?.requestedStages || item?.meta?.requestedStages || null;
  return !!requestedStages?.stage1b ||
    (typeof requestedStages?.declutter === "boolean" ? requestedStages.declutter : false) ||
    !!item?.options?.declutter ||
    !!item?.result?.options?.declutter;
}

function getPerImageStagingAllowed(item: any): boolean {
  const itemAllow = item?.meta?.allowStaging;
  const resultAllow = item?.result?.meta?.allowStaging;
  if (itemAllow === false || resultAllow === false) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 2: Filter backend warnings and errors for user-friendly display
// ═══════════════════════════════════════════════════════════════════════════════

// Technical warnings that should NOT be shown to users (backend diagnostics only)
const TECHNICAL_WARNINGS = [
  'dimension_normalized',
  'dimension_normalised', // UK spelling
  'strictRetry',
  'fallbackUsed',
  'stage1BStructuralSafe',
  'stage2Skipped',
  'validationRisk',
  'stage2ValidationRisk',
  'localBlockingEnabled',
  'geminiConfirmationEnabled',
  'retryAttempt',
  'preprocessed',
  'canonical',
  'metadata_updated',
];

const USER_FRIENDLY_MESSAGES: Record<string, string> = {
  'stage2Blocked': 'Virtual staging was not applied due to room layout or quality concerns',
  'complianceBlocked': 'Image could not be processed due to content policy',
  'timeout': 'Processing took longer than expected - using best available result',
  'Stage 2 blocked': 'Virtual staging was not applied due to room layout concerns',
  'validation failed': 'Image quality validation prevented staging - best available result returned',
  'structural validation failed': 'Room structure validation prevented staging',
};

/**
 * Filter warnings to remove backend diagnostic messages and translate technical
 * messages to user-friendly versions.
 */
function filterWarningsForDisplay(warnings: string[]): string[] {
  if (!Array.isArray(warnings)) return [];
  
  return warnings
    .filter(w => {
      if (!w || typeof w !== 'string') return false;
      // Filter out technical backend warnings
      const warningLower = w.toLowerCase();
      return !TECHNICAL_WARNINGS.some(tech => warningLower.includes(tech.toLowerCase()));
    })
    .map(w => {
      // Translate technical messages to user-friendly versions
      const warningLower = w.toLowerCase();
      for (const [key, friendlyMsg] of Object.entries(USER_FRIENDLY_MESSAGES)) {
        if (warningLower.includes(key.toLowerCase())) {
          return friendlyMsg;
        }
      }
      return w;
    })
    .filter((w, i, arr) => arr.indexOf(w) === i); // Remove duplicates
}

/**
 * FIX 3: Only show error messages for terminal failure states, not transient errors
 */
function shouldShowError(result: any): boolean {
  if (!result) return false;
  
  const status = String(result?.status || '').toLowerCase();
  const errorMessage = result?.error || result?.errorMessage || result?.message;
  
  // No error message to show
  if (!errorMessage) return false;
  
  // Don't show errors if job completed successfully
  if (status === 'completed' || status === 'complete') {
    return false;
  }
  
  // Don't show errors if job is still actively processing
  if (status === 'processing' && (result?.progress || 0) > 0) {
    return false;
  }
  
  // Don't show errors for queued jobs
  if (status === 'queued' || status === 'waiting') {
    return false;
  }
  
  // Only show errors for terminal failure states
  return status === 'failed' || status === 'cancelled' || status === 'timeout';
}

/**
 * Get user-friendly error message for display
 */
function getDisplayError(result: any): string | null {
  if (!shouldShowError(result)) return null;
  
  const rawError = result?.error || result?.errorMessage || result?.message || 'Processing failed';
  
  // Translate technical errors to user-friendly messages
  const errorLower = String(rawError).toLowerCase();
  for (const [key, friendlyMsg] of Object.entries(USER_FRIENDLY_MESSAGES)) {
    if (errorLower.includes(key.toLowerCase())) {
      return friendlyMsg;
    }
  }
  
  // Check if it's a technical error message (contains technical jargon)
  const technicalTerms = ['redis', 'bullmq', 'worker', 'gemini api', 'timeout', 'updatejob', 'metadata'];
  const isTechnical = technicalTerms.some(term => errorLower.includes(term));
  
  if (isTechnical) {
    return 'Image processing encountered an issue. Please retry or contact support.';
  }
  
  return rawError;
}

// ═══════════════════════════════════════════════════════════════════════════════

// Batch job persistence interfaces and functions
interface PersistedFileMetadata {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

interface PersistedBatchJob {
  ownerUserId?: string | null;
  jobId: string;
  jobIds: string[];
  runState: RunState;
  results: any[];
  processedImages: string[];
  processedImagesByIndex: { [key: number]: string };
  timestamp: number;
  fileCount: number;
  goal: string;
  industry: string;
  settings: {
    preserveStructure: boolean;
    latest?: {
      retryLatestUrl?: string | null;
      editLatestUrl?: string | null;
      originalUploadUrl?: string | null;
    },
    allowStaging: boolean;
    baselineStage: "original" | "1A" | "1B" | "latest";
    outdoorStaging: string;
    furnitureReplacement: boolean;
    declutter: boolean;
    stagingStyle: string;
    propertyAddress?: string;
    void viewingStage;

    const retryLatestUrl = toDisplayUrl(latest?.retryLatestUrl) || null;
    const editLatestUrl = toDisplayUrl(latest?.editLatestUrl) || null;
  };
  fileMetadata: PersistedFileMetadata[];
  jobIdToIndex: Record<string, number>;
    const originalUploadUrl = toDisplayUrl(latest?.originalUploadUrl) || null;

    // Latest successful artifact order:
    // retryLatestUrl -> editLatestUrl -> stage2 -> stage1B -> stage1A -> original_upload
    if (retryLatestUrl) {
      return {
        baselineStage: "latest",
        stagesToRun: ["2"],
        allowStaging: true,
        sourceUrl: retryLatestUrl,
        sourceStageLabel: "retry_latest",
      };
    }

    if (editLatestUrl) {
      return {
        baselineStage: "latest",
        stagesToRun: ["2"],
        allowStaging: true,
        sourceUrl: editLatestUrl,
        sourceStageLabel: "edit_latest",
      };
    }

    if (stage2Url) {
      return {
        baselineStage: "1B",
        stagesToRun: ["2"],
        allowStaging: true,
        sourceUrl: stage2Url,
        sourceStageLabel: "stage2",
      };
    }

    if (stage1BUrl) {
      return {
        baselineStage: "1B",
        stagesToRun: ["2"],
        allowStaging: true,
        sourceUrl: stage1BUrl,
        sourceStageLabel: "stage1b",
      };
    }

    if (stage1AUrl) {
      return {
        baselineStage: "1A",
        stagesToRun: ["1B", "2"],
        allowStaging: true,
        sourceUrl: stage1AUrl,
        sourceStageLabel: "stage1a",
      };
    }

    if (originalUploadUrl) {
      return {
        baselineStage: "original",
        stagesToRun: ["1A", "1B", "2"],
        allowStaging: true,
        sourceUrl: originalUploadUrl,
        sourceStageLabel: "original_upload",
      };
    }
  imageIdToIndex?: Record<string, number>;
    // Final fallback: full pipeline from original file upload.
  // Case A: Viewing Stage 2 → re-stage from Stage 1B
  if (viewingStage === "2" && stage1BUrl) {
    return {
      baselineStage: "1B",
      stagesToRun: ["2"],
      allowStaging: true,
      sourceUrl: stage1BUrl,
      sourceStageLabel: "stage1b",
    };
  }

  // Case A2: Viewing Stage 2 but no Stage 1B available → re-stage from Stage 1A
  if (viewingStage === "2" && stage1AUrl) {
    return {
      baselineStage: "1A",
      stagesToRun: ["2"],
      allowStaging: true,
      sourceUrl: stage1AUrl,
      sourceStageLabel: "stage1a",
    };
  }

  // Case B: Viewing Stage 1B and Stage 2 exists → re-declutter from 1A, then re-stage
  if (viewingStage === "1B" && stage2Url && stage1AUrl) {
    return {
      baselineStage: "1A",
      stagesToRun: ["1B", "2"],
      allowStaging: true,
      sourceUrl: stage1AUrl,
      sourceStageLabel: "stage1a",
    };
  }

  // Case C: Viewing Stage 1B, no Stage 2 → re-declutter from 1A only
  if (viewingStage === "1B" && stage1AUrl) {
    return {
      baselineStage: "1A",
      stagesToRun: ["1B"],
      allowStaging: false,
      sourceUrl: stage1AUrl,
      sourceStageLabel: "stage1a",
    };
  }

  // Fallback: viewing 1A or original → full pipeline from original file
  return {
    baselineStage: "original",
    stagesToRun: stage1BUrl ? ["1A", "1B"] : ["1A"],
    allowStaging: false,
    sourceUrl: null, // will use original file upload
    sourceStageLabel: "original",
  };
}

// Stable placeholder for restored (non-image) file blobs so the UI never shows a broken icon
const RESTORED_PLACEHOLDER = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 90'><rect width='120' height='90' fill='%23e5e7eb'/><path d='M43 30h34l4 6h8a5 5 0 015 5v27a5 5 0 01-5 5H31a5 5 0 01-5-5V41a5 5 0 015-5h8l4-6z' fill='%23d1d5db'/><circle cx='60' cy='53' r='12' fill='%23cbd5e1'/><circle cx='60' cy='53' r='7' fill='%239ca3af'/><text x='50%' y='82%' dominant-baseline='middle' text-anchor='middle' font-family='Arial, sans-serif' font-size='10' fill='%239ca3af'>Preview</text></svg>";

function normalizeJobStatus(raw: string | undefined): 'processing' | 'completed' | 'failed' | 'cancelled' {
  const val = (raw || "").toLowerCase();
  if (["completed", "complete", "done", "success", "succeeded", "finished", "ok"].includes(val)) return "completed";
  if (["failed", "error", "errored", "blocked", "rejected"].includes(val)) return "failed";
  if (["cancelled", "canceled", "aborted", "terminated"].includes(val)) return "cancelled";
  return "processing";
}

function saveBatchJobState(state: PersistedBatchJob, userId: string | null) {
  try {
    const payload = { ...state, ownerUserId: userId ?? null };
    localStorage.setItem(makeBatchKey(userId), JSON.stringify(payload));
  } catch (error) {
    console.warn("Failed to save batch job state:", error);
  }
}

function loadBatchJobState(userId: string | null): PersistedBatchJob | null {
  try {
    migrateLegacyKeysOnce(userId);
    const saved = localStorage.getItem(makeBatchKey(userId));
    if (!saved) return null;
    
    const state = JSON.parse(saved) as PersistedBatchJob;
    
    // Check if job has expired
    const hoursAgo = (Date.now() - state.timestamp) / (1000 * 60 * 60);
    if (hoursAgo > JOB_EXPIRY_HOURS) {
      clearBatchJobState();
      return null;
    }
    
    return state;
  } catch (error) {
    console.warn("Failed to load batch job state:", error);
    clearBatchJobState();
    return null;
  }
}

function clearBatchJobState(userId?: string | null, opts?: { resetUI?: boolean }) {
  try {
    if (opts?.resetUI) {
      requestClearEnhancementState(userId ?? null);
    } else {
      clearEnhancementStateStorage(userId ?? null);
    }
  } catch (error) {
    console.warn("Failed to clear batch job state:", error);
  }
}

// Helper component for consistent status badges
const StatusBadge = ({ status, className, label }: { status: 'processing' | 'completed' | 'failed' | 'queued', className?: string, label?: string }) => {
  if (status === 'processing' || status === 'queued') {
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium bg-slate-100 text-slate-700 ring-1 ring-slate-200 animate-pulse ${className}`}>
        <Loader2 className="w-3 h-3 animate-spin" />
        {label || (status === 'queued' ? 'Queued' : 'Processing')}
      </span>
    );
  }
  if (status === 'completed') {
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium bg-emerald-600 text-white ring-1 ring-emerald-300/60 shadow-sm ${className}`}>
        <CheckCircle className="w-3.5 h-3.5" />
        {label || 'Enhancement Complete'}
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium bg-rose-600 text-white shadow-sm ${className}`}>
        <AlertCircle className="w-3.5 h-3.5" />
        {label || 'Error'}
      </span>
    );
  }
  return null;
};

// Helper to generate retry-specific status text
const getRetryStatusText = (stage?: "1A" | "1B" | "2" | "full" | null): string => {
  if (!stage || stage === "full") return "Retrying enhancement...";
  if (stage === "1A") return "Retrying color enhancement...";
  if (stage === "1B") return "Retrying declutter...";
  if (stage === "2") return "Retrying staging...";
  return "Retrying...";
};

type ProcessingMessageStage = "stage1a" | "stage1b" | "stage2" | "validator" | "retry";
type BatchPhaseState = "UPLOADING" | "QUEUE_WAIT" | "PROCESSING";
type DisplayStageKey = "uploading" | "stage1a" | "stage1b" | "stage2" | "validator" | "retry" | "completed";

const MESSAGE_ROTATION_MS = 2_500;

const STAGE_MESSAGES: Record<ProcessingMessageStage, string[]> = {
  stage1a: [
    "Improving color balance",
    "Enhancing lighting",
    "Correcting white balance",
    "Sharpening image details",
    "Optimizing exposure",
  ],
  stage1b: [
    "Detecting removable furniture",
    "Decluttering room layout",
    "Removing temporary objects",
    "Cleaning visual distractions",
    "Preparing room for staging",
  ],
  stage2: [
    "Designing staged layout",
    "Placing furniture",
    "Optimizing room composition",
    "Adding realistic staging elements",
    "Finalizing staged presentation",
  ],
  validator: [
    "Reviewing visual quality",
    "Checking composition",
    "Verifying layout",
    "Finalizing details"
  ],
  retry: [
    "Improving styling",
    "Adjusting composition",
    "Refining layout",
    "Updating presentation"
  ],
};

function normalizeCurrentStage(raw: unknown): string {
  return String(raw || "").toLowerCase();
}

function resolveDisplayStageKey(params: {
  status: string;
  currentStage: string;
  isDone: boolean;
  isRetryActive: boolean;
  isUploading: boolean;
}): DisplayStageKey {
  const { status, currentStage, isDone, isRetryActive, isUploading } = params;
  if (isDone) return "completed";
  if (isRetryActive) return "retry";
  if (isUploading || status === "queued" || status === "waiting") return "uploading";
  if (
    currentStage.includes("1b") ||
    currentStage.includes("stage1b") ||
    currentStage.includes("declutter")
  ) return "stage1b";
  if (
    currentStage.includes("2") ||
    currentStage.includes("stage2") ||
    currentStage.includes("staging") ||
    currentStage.includes("design")
  ) return "stage2";
  if (
    currentStage.includes("valid") ||
    currentStage.includes("review") ||
    currentStage.includes("compliance")
  ) return "validator";
  if (
    currentStage.includes("1a") ||
    currentStage.includes("stage1a") ||
    currentStage.includes("enhanc") ||
    currentStage.includes("upload") ||
    currentStage.includes("preprocess")
  ) return "stage1a";
  return "stage1a";
}

function toProcessingMessageStage(key: DisplayStageKey): ProcessingMessageStage {
  if (key === "stage1b") return "stage1b";
  if (key === "stage2") return "stage2";
  if (key === "validator" || key === "completed") return "validator";
  if (key === "retry") return "retry";
  return "stage1a";
}

const STAGE_PROGRESS: Record<string, number> = {
  uploading: 10,
  stage1a: 35,
  stage1b: 60,
  stage2: 90,
  validator: 100,
  retry: 70,
  completed: 100,
};

const STAGE_TITLES: Record<string, string> = {
  uploading: "Preparing Image",
  stage1a: "Enhancing Parameters",
  stage1b: "Simplifying Space",
  stage2: "Applying Design",
  validator: "Quality Review",
  retry: "Layout Refinement",
  completed: "Enhancement Complete",
};

const BATCH_PHASE_LABELS: Record<BatchPhaseState, string> = {
  UPLOADING: "Phase 1 — Uploading Images",
  QUEUE_WAIT: "Phase 2 — Queue Placement",
  PROCESSING: "Phase 3 — Active Processing",
};

export default function BatchProcessor() {
  // Staging style preset for the batch - default preserves legacy NZ Standard behavior
  const [stagingStyle, setStagingStyle] = useState<StagingStyle>("standard_listing");
  
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasRestoredRef = useRef(false);
  
  // Constants for file validation
  const MAX_FILES = 50;
  const MAX_FILE_SIZE_MB = 15;
  const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
  
  // Tab state for clean UI flow - default to images tab when empty to show launchpad
  const [activeTab, setActiveTab] = useState<"upload" | "images" | "enhance">(
    () => files.length === 0 ? "images" : "upload"
  );
  const [isUploading, setIsUploading] = useState(false);
  const [globalGoal, setGlobalGoal] = useState("");
  const [propertyAddress, setPropertyAddress] = useState("");
  const [preserveStructure, setPreserveStructure] = useState<boolean>(true);
  const presetKey = "realestate"; // Locked to Real Estate only
  const [showAdditionalSettings, setShowAdditionalSettings] = useState(false);
  const [runState, setRunState] = useState<RunState>("idle");
  const [results, setResults] = useState<any[]>([]);
  const [messageIndexByImage, setMessageIndexByImage] = useState<Record<number, number>>({});
  const messageTimerByImageRef = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const messageStageByImageRef = useRef<Record<number, ProcessingMessageStage>>({});
  const [availableCredits, setAvailableCredits] = useState<number | null>(null);
  const [isCreditSummaryLoading, setIsCreditSummaryLoading] = useState(false);
  const [creditGateModal, setCreditGateModal] = useState<{
    open: boolean;
    requiredCredits: number;
    availableCredits: number;
  }>({
    open: false,
    requiredCredits: 0,
    availableCredits: 0,
  });

  // Keep restored batches in the unified workspace when files arrive asynchronously.
  useEffect(() => {
    const hasRestoredFiles = files.some(f => (f as any).__restored === true);
    
    if (
      !hasRestoredRef.current &&
      hasRestoredFiles &&
      activeTab === "images"
    ) {
      hasRestoredRef.current = true;
    }
  }, [files, activeTab]);

  // Transparent AI simulation
  const [aiSteps, setAiSteps] = useState<Record<number, string>>({});
  useEffect(() => {
    if (runState !== 'running') return;
    const steps = [
      "Analyzing geometry...", "Correcting vertical perspective...", "Balancing exposure...", 
      "Detecting windows...", "Rendering virtual furniture...", "Adjusting manufacturing lighting...",
      "Optimizing textures...", "Finalizing composition..."
    ];
    const interval = setInterval(() => {
        setAiSteps(prev => {
            const next = {...prev};
             for (let i = 0; i < 50; i++) { 
                if (Math.random() > 0.6) {
                    next[i] = steps[Math.floor(Math.random() * steps.length)];
                }
             }
            return next;
        });
    }, 2500);
    return () => clearInterval(interval);
  }, [runState]);

  useEffect(() => {
    const clearMessageTimer = (index: number) => {
      const timer = messageTimerByImageRef.current[index];
      if (timer) {
        clearTimeout(timer);
        delete messageTimerByImageRef.current[index];
      }
      delete messageStageByImageRef.current[index];
    };

    files.forEach((_, index) => {
      const item = results[index] || {};
      const status = String(item?.status || item?.result?.status || "").toLowerCase();
      const isTerminal = status === "completed" || status === "complete" || status === "failed" || status === "cancelled";
      const isRetryActive = Boolean(item?.retryInFlight);
      const currentStage = normalizeCurrentStage(item?.currentStage || item?.result?.currentStage);
      const shouldRotate = !isTerminal && (runState === "running" || status === "processing" || status === "queued" || status === "waiting" || isUploading || isRetryActive);

      if (!shouldRotate) {
        clearMessageTimer(index);
        return;
      }

      const displayStageKey = resolveDisplayStageKey({
        status,
        currentStage,
        isDone: false,
        isRetryActive,
        isUploading,
      });
      const messageStage = toProcessingMessageStage(displayStageKey);

      if (!messageTimerByImageRef.current[index] || messageStageByImageRef.current[index] !== messageStage) {
        clearMessageTimer(index);

        const messages = STAGE_MESSAGES[messageStage] || STAGE_MESSAGES.stage1a;
        setMessageIndexByImage((prev) => ({ ...prev, [index]: 0 }));
        messageStageByImageRef.current[index] = messageStage;

        const rotateMessage = () => {
          setMessageIndexByImage((prev) => ({
            ...prev,
            [index]: ((prev[index] ?? 0) + 1) % Math.max(1, messages.length),
          }));
          messageTimerByImageRef.current[index] = setTimeout(rotateMessage, MESSAGE_ROTATION_MS);
        };

        messageTimerByImageRef.current[index] = setTimeout(rotateMessage, MESSAGE_ROTATION_MS);
      }
    });

  }, [files, results, runState, isUploading]);

  useEffect(() => {
    return () => {
      Object.keys(messageTimerByImageRef.current).forEach((key) => {
        const index = Number(key);
        const timer = messageTimerByImageRef.current[index];
        if (timer) clearTimeout(timer);
      });
      messageTimerByImageRef.current = {};
      messageStageByImageRef.current = {};
    };
  }, []);

  const [jobId, setJobId] = useState<string>("");
  const [jobIds, setJobIds] = useState<string[]>([]); // multi-job batch ids
  const jobIdToIndexRef = useRef<Record<string, number>>({});
  const imageIdToIndexRef = useRef<Record<string, number>>({});
  const jobIdToImageIdRef = useRef<Record<string, string>>({});
  const [displayStageByIndex, setDisplayStageByIndex] = useState<Record<number, DisplayOutputKey>>({});
  const [progressText, setProgressText] = useState<string>("");
  const [lastDetected, setLastDetected] = useState<{ index: number; label: string; confidence: number } | null>(null);
  const [processedImages, setProcessedImages] = useState<string[]>([]); // Track processed image URLs for ZIP download
  const [processedImagesByIndex, setProcessedImagesByIndex] = useState<{[key: number]: string}>({}); // Track processed image URLs by original index
  // AUDIT FIX: AbortController moved from useState to useRef to avoid stale closure issues
  const abortControllerRef = useRef<AbortController | null>(null);
  const abortController = abortControllerRef.current;
  const setAbortController = (ctrl: AbortController | null) => { abortControllerRef.current = ctrl; };
  
  // Additional boolean flags for processing control
  const [allowStaging, setAllowStaging] = useState(true);
  const [allowRetouch, setAllowRetouch] = useState(true);
  const [outdoorStaging, setOutdoorStaging] = useState<"auto" | "none">("auto");
  const [furnitureReplacement, setFurnitureReplacement] = useState(true);
  // Declutter flag (drives Stage 1B in worker)
  const [declutter, setDeclutter] = useState<boolean>(false);
  const [clientBatchId, setClientBatchId] = useState<string | null>(null);

  const clientBatchIdRef = useRef<string | null>(null);
  const previousFileCountRef = useRef<number>(0);
  
  // Collapsible specific requirements
  const [showSpecificRequirements, setShowSpecificRequirements] = useState(false);
  
  // ZIP download loading state
  const [isDownloadingZip, setIsDownloadingZip] = useState(false);
  const lastActivityByIndexRef = useRef<Record<number, { ts: number; key: string }>>({});
  
  // Batch refine loading state
  const [isBatchRefining, setIsBatchRefining] = useState(false);
  const [hasRefinedImages, setHasRefinedImages] = useState(false);
  // Track cancellable job ids reported by the server (per-image jobs)
  const [cancelIds, setCancelIds] = useState<string[]>([]);
  
  // Preview/edit modal state
  const [previewImage, setPreviewImage] = useState<PreviewModalImage | null>(null);
  const [editingImageIndex, setEditingImageIndex] = useState<number | null>(null);
  const [activeEditSource, setActiveEditSource] = useState<{ url: string; stage: EditSourceStage | null; jobId: string | null } | null>(null);
  const [regionEditorOpen, setRegionEditorOpen] = useState(false);
  const [retryingImages, setRetryingImages] = useState<Set<number>>(new Set());
  const [retryLoadingImages, setRetryLoadingImages] = useState<Set<number>>(new Set());
  const [editingImages, setEditingImages] = useState<Set<number>>(new Set());
  const [editCompletedImages, setEditCompletedImages] = useState<Set<number>>(new Set());
  const regionEditJobIdsRef = useRef<Set<string>>(new Set());
  const editingImagesRef = useRef<Set<number>>(new Set());
  const preEditStageUrlsRef = useRef<Record<number, { stage2: string | null; stage1B: string | null; stage1A: string | null }>>({});
  const editFallbackTimersRef = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const clearEditFallbackTimer = useCallback((index: number) => {
    const t = editFallbackTimersRef.current[index];
    if (t) {
      clearTimeout(t);
      delete editFallbackTimersRef.current[index];
    }
  }, []);
  useEffect(() => {
    editingImagesRef.current = editingImages;
  }, [editingImages]);

  useEffect(() => {
    return () => {
      Object.values(editFallbackTimersRef.current).forEach((t) => clearTimeout(t));
      editFallbackTimersRef.current = {};
    };
  }, []);

  // Helper to clear retry flags for a specific image index
  const clearRetryFlags = useCallback((index: number) => {
    setRetryingImages(prev => {
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
    setRetryLoadingImages(prev => {
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
    setResults(prev => prev.map((r, i) => {
      if (i !== index) return r;
      return {
        ...r,
        retryInFlight: undefined,
        retryStage: undefined,
      };
    }));
  }, []);

  const markRetryFailed = useCallback((index: number, errorMessage: string) => {
    clearRetryFlags(index);
    setResults(prev => prev.map((r, i) => {
      if (i !== index) return r;
      return {
        ...r,
        status: "failed",
        uiStatus: "error",
        error: errorMessage,
        currentStage: null,
        retryInFlight: undefined,
        retryStage: undefined,
        statusLastModified: Date.now(),
      };
    }));
  }, [clearRetryFlags]);

  // Retry timeout safety (5 minutes max for full pipeline jobs)
  const RETRY_TIMEOUT_MS = 300_000;
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Retry dialog state
  const [retryDialog, setRetryDialog] = useState<{ isOpen: boolean; imageIndex: number | null }>({
    isOpen: false,
    imageIndex: null
  });
  
  const [isEditingInProgress, setIsEditingInProgress] = useState(false);
  const [editingImage, setEditingImage] = useState<{ url: string, filename: string, resultIndex: number, onSubmit: (roiData: any, instructions?: string) => void } | null>(null);

  // Manual room linking state
  type LocalItemMeta = {
    roomKey?: string;     // user label e.g. "Lounge-A"
    angleOrder?: number;  // 1,2,3... (1 = primary)
  };
  
  const [selection, setSelection] = useState<Set<number>>(new Set()); // indexes user has selected
  const [metaByIndex, setMetaByIndex] = useState<Record<number, LocalItemMeta>>({});
  
  // Images tab state - keyed by stable imageId (not array index) to survive removals
  const [imageSceneTypesById, setImageSceneTypesById] = useState<Record<string, string>>({});
  const [manualSceneTypesById, setManualSceneTypesById] = useState<Record<string, SceneLabel | null>>({});
  const [scenePredictionsById, setScenePredictionsById] = useState<Record<string, SceneDetectResult>>({});
  const [imageRoomTypesById, setImageRoomTypesById] = useState<Record<string, string>>({});
  const refreshModeOnlyRoomTypes = useMemo(() => new Set([
    "multiple_living",
    "kitchen_dining",
    "kitchen_living",
    "living_dining",
  ]), []);
  const [imageSkyReplacementById, setImageSkyReplacementById] = useState<Record<string, boolean>>({});
  // Track manual scene overrides per-image (when user changes scene dropdown)
  const [manualSceneOverrideById, setManualSceneOverrideById] = useState<Record<string, boolean>>({});
  const [linkImages, setLinkImages] = useState<boolean>(false);
  // Studio view: current image being configured (by stable imageId)
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);

  const manualSceneTypesByIdRef = useRef<Record<string, SceneLabel | null>>({});
  const imageSceneTypesByIdRef = useRef<Record<string, string>>({});
  const scenePredictionsByIdRef = useRef<Record<string, SceneDetectResult>>({});
  useEffect(() => { manualSceneTypesByIdRef.current = manualSceneTypesById; }, [manualSceneTypesById]);
  useEffect(() => { imageSceneTypesByIdRef.current = imageSceneTypesById; }, [imageSceneTypesById]);
  useEffect(() => { scenePredictionsByIdRef.current = scenePredictionsById; }, [scenePredictionsById]);
  
  // Compute currentImageIndex from selectedImageId for backwards compatibility
  const currentImageIndex = useMemo(() => {
    if (!selectedImageId) return 0;
    const idx = files.findIndex(f => getFileId(f) === selectedImageId);
    return idx >= 0 ? idx : 0;
  }, [files, selectedImageId]);

  // Set initial selectedImageId when files change
  useEffect(() => {
    if (files.length > 0 && !selectedImageId) {
      setSelectedImageId(getFileId(files[0]));
    } else if (files.length === 0) {
      setSelectedImageId(null);
    } else if (selectedImageId && !files.some(f => getFileId(f) === selectedImageId)) {
      // Selected image was removed, select first available
      setSelectedImageId(getFileId(files[0]));
    }
  }, [files, selectedImageId]);

  // Detect brand new batch (first files added after empty state)
  useEffect(() => {
    const prev = previousFileCountRef.current;
    const isNewBatch = prev === 0 && files.length > 0 && runState !== 'running';
    if (isNewBatch) {
      const newClientBatchId = `client-batch-${Date.now()}`;
      clientBatchIdRef.current = newClientBatchId;
      setClientBatchId(newClientBatchId);
    }
    if (files.length === 0) {
      clientBatchIdRef.current = null;
      setClientBatchId(null);
    }
    previousFileCountRef.current = files.length;
  }, [files.length, runState]);

  // Helper to set current image by index (for UI that uses indices)
  const setCurrentImageIndex = useCallback((indexOrFn: number | ((prev: number) => number)) => {
    if (typeof indexOrFn === 'function') {
      const newIdx = indexOrFn(currentImageIndex);
      if (newIdx >= 0 && newIdx < files.length) {
        setSelectedImageId(getFileId(files[newIdx]));
      }
    } else {
      if (indexOrFn >= 0 && indexOrFn < files.length) {
        setSelectedImageId(getFileId(files[indexOrFn]));
      }
    }
  }, [currentImageIndex, files]);

  // Get imageId for a given index
  const getImageIdForIndex = useCallback((index: number): string | null => {
    if (index < 0 || index >= files.length) return null;
    return getFileId(files[index]);
  }, [files]);

  // Get current imageId
  const currentImageId = selectedImageId || (files.length > 0 ? getFileId(files[0]) : null);

  // Tuning controls (apply to all images in this batch; optional)
  // Declutter intensity removed: always heavy/preset in backend
  // Disable manual sampling controls; prompt embeds temperature instead
  const samplingUiEnabled = false;
  const [temperatureInput, setTemperatureInput] = useState<string>("");
  const [topPInput, setTopPInput] = useState<string>("");
  const [topKInput, setTopKInput] = useState<string>("");

  // Progressive display queue for SSE items
  const queueRef = useRef<any[]>([]);
  const scheduledRef = useRef(false);
  const processedSetRef = useRef<Set<number>>(new Set());
  const filesFingerprintRef = useRef<string>("");
  const sceneDetectCacheRef = useRef<Record<string, SceneDetectResult>>({});
  // Track which jobIds have shown a strict-retry toast
  const strictNotifiedRef = useRef<Set<string>>(new Set());
  // Track which indices are currently undergoing strict validator retry
  const [strictRetryingIndices, setStrictRetryingIndices] = useState<Set<number>>(new Set());
  const statusUnknownLoggedRef = useRef<Set<string>>(new Set());
  const idxMissingLoggedRef = useRef<Set<string>>(new Set());
  const statusHasUrlLoggedRef = useRef<Set<string>>(new Set());
  const statusTargetNotReachedLoggedRef = useRef<Set<string>>(new Set());
  const retryChildMappingLoggedRef = useRef<Set<string>>(new Set());
  const autoFurnitureNoticeLoggedRef = useRef<Set<number>>(new Set());

  // Industry mapping - locked to Real Estate only
  const industryMap: Record<string, string> = {
    "realestate": "Real Estate"
  };
  
  const { toast } = useToast();
  const { user, refreshUser, signOut } = useAuth();
  const { ensureLoggedInAndCredits } = useAuthGuard();
  const currentUserId = user?.id || null;

  const prevUserIdRef = useRef<string | null>(null);

  const handleAuthFailure = useCallback(() => {
    clearBatchJobState(currentUserId, { resetUI: true });
    setRunState("idle");
    setAbortController(null);
    try { signOut?.(); } catch {}
  }, [currentUserId, signOut]);

  const isAdminUser = user?.role === "owner" || user?.role === "admin";
  const hasRoleInfo = !!user?.role;
  const billingHref = "/agency#billing-section";
  const addonHref = "/agency#bundle-purchase";

  const showQuotaExceededToast = useCallback(() => {
    const message = getQuotaExceededMessage({ isAdmin: isAdminUser, hasRoleInfo });

    toast({
      title: "Image allowance used",
      description: (
        <div className="space-y-3">
          <p>{message}</p>
          {isAdminUser && (
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm" variant="secondary">
                <a href={billingHref}>Go to Billing</a>
              </Button>
              <Button asChild size="sm" variant="outline">
                <a href={addonHref}>Buy add-on bundle</a>
              </Button>
            </div>
          )}
        </div>
      ),
      variant: "destructive",
    });
  }, [addonHref, billingHref, hasRoleInfo, isAdminUser, toast]);

  // Lightweight client-side scene detector (prefill UX): 3-state with uncertain band
  async function detectSceneFromFile(f: File): Promise<SceneDetectResult> {
    const cacheKey = `${f.name}:${f.size}:${f.lastModified}`;
    if (sceneDetectCacheRef.current[cacheKey]) return sceneDetectCacheRef.current[cacheKey];
    try {
      const bmp = await createImageBitmap(f);
      // Normalize width to 256 while preserving aspect
      const cnv = document.createElement("canvas");
      cnv.width = 256; cnv.height = Math.max(1, Math.round(256 * (bmp.height / Math.max(1, bmp.width))));
      const ctx = cnv.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0, cnv.width, cnv.height);
      const { width, height } = cnv;
      const img = ctx.getImageData(0, 0, width, height);

      let total = 0;
      let blueOverall = 0;
      let greenOverall = 0;
      let skyTop10 = 0;
      let skyTop40 = 0;
      let grassBottom40 = 0;
      let luminanceSum = 0;

      for (let i = 0, px = 0; i < img.data.length; i += 4, px++) {
        const r = img.data[i];
        const g = img.data[i + 1];
        const b = img.data[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const v = max / 255;
        const d = max - min;
        const s = max === 0 ? 0 : d / max;
        let h = 0;
        if (d !== 0) {
          if (max === r) h = ((g - b) / d) % 6;
          else if (max === g) h = (b - r) / d + 2;
          else h = (r - g) / d + 4;
          h *= 60;
          if (h < 0) h += 360;
        }

        const y = Math.floor(px / width);
        total++;
        luminanceSum += v;

        if (v > 0.45 && s > 0.10 && h >= 190 && h <= 255) blueOverall++;
        if (v > 0.30 && s > 0.30 && h >= 70 && h <= 160) greenOverall++;

        const isSkyish = v > 0.65 && s < 0.55 && h >= 185 && h <= 245;
        const isGrass = v > 0.35 && s > 0.35 && h >= 75 && h <= 150;

        if (isSkyish) {
          if (y < height * 0.10) skyTop10++;
          if (y < height * 0.40) skyTop40++;
        }
        if (isGrass && y > height * 0.60) grassBottom40++;
      }

      const denom = Math.max(1, total);
      const features = {
        skyTop10: skyTop10 / denom,
        skyTop40: skyTop40 / denom,
        grassBottom: grassBottom40 / denom,
        blueOverall: blueOverall / denom,
        greenOverall: greenOverall / denom,
        meanLum: luminanceSum / denom,
      };

      const coveredExteriorSuspect =
        features.skyTop10 > 0.02 &&
        features.blueOverall < 0.06 &&
        features.skyTop40 > 0.05;

      if (coveredExteriorSuspect) {
        const unsure: SceneDetectResult = {
          scene: null,
          confidence: 0,
          signal: Math.max(features.skyTop10, features.skyTop40, features.blueOverall),
          features,
          reason: "covered_exterior_suspect",
          source: "client",
        };
        console.debug('[SceneDetect][client] covered_exterior_suspect -> unsure', {
          skyTop10: features.skyTop10,
          skyTop40: features.skyTop40,
          blueOverall: features.blueOverall,
          meanLum: features.meanLum,
          decision: unsure,
        });
        sceneDetectCacheRef.current[cacheKey] = unsure;
        return unsure;
      }

      let signal = Math.max(
        features.skyTop10,
        features.skyTop40 * 0.9,
        features.grassBottom,
        features.blueOverall * 0.8,
        features.greenOverall * 0.8
      );

      if (features.skyTop40 < 0.03 && features.blueOverall > 0.10) signal *= 0.7;
      if (features.grassBottom < 0.02 && features.greenOverall > 0.08) signal *= 0.8;
      if (features.meanLum > 0.70 && features.skyTop40 < 0.02) signal *= 0.85;

      let scene: SceneType | null = null;
      let reason: SceneDetectResult["reason"] = "uncertain";
      if (signal <= SCENE_SIGNAL_LOW) {
        scene = "interior";
        reason = "confident_interior";
      } else if (signal >= SCENE_SIGNAL_HIGH) {
        scene = "exterior";
        reason = "confident_exterior";
      }

      const mid = (SCENE_SIGNAL_LOW + SCENE_SIGNAL_HIGH) / 2;
      const halfBand = (SCENE_SIGNAL_HIGH - SCENE_SIGNAL_LOW) / 2;
      const margin = Math.abs(signal - mid) - halfBand;
      const confidence = clamp01(margin / SCENE_CONF_SCALE) ?? 0;

      console.log(
        "[SceneDetect] skyTop10=", features.skyTop10.toFixed(3),
        " skyTop40=", features.skyTop40.toFixed(3),
        " grassBottom=", features.grassBottom.toFixed(3),
        " blueOverall=", features.blueOverall.toFixed(3),
        " greenOverall=", features.greenOverall.toFixed(3),
        " meanLum=", features.meanLum.toFixed(3),
        " signal=", signal.toFixed(3),
        " low=", SCENE_SIGNAL_LOW.toFixed(3),
        " high=", SCENE_SIGNAL_HIGH.toFixed(3),
        " -> scene=", scene,
        " conf=", (confidence ?? 0).toFixed(2),
        " reason=", reason
      );

      const result: SceneDetectResult = { scene, confidence: confidence ?? 0, signal, features, reason, source: "client" };
      sceneDetectCacheRef.current[cacheKey] = result;
      return result;
    } catch (e) {
      console.warn("[SceneDetect] Detection failed; marking uncertain:", e);
      const fallback: SceneDetectResult = {
        scene: null,
        confidence: 0,
        signal: 0,
        features: { skyTop10: 0, skyTop40: 0, grassBottom: 0, blueOverall: 0, greenOverall: 0, meanLum: 0 },
        reason: "uncertain",
        source: "client",
      };
      sceneDetectCacheRef.current[cacheKey] = fallback;
      return fallback;
    }
  }

  const prevFileIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const currentIds = new Set(files.map(getFileId));
    const prevIds = prevFileIdsRef.current;
    const hasOverlap = [...currentIds].some(id => prevIds.has(id));
    const hasNewFiles = [...currentIds].some(id => !prevIds.has(id));
    const userSelected = files.some(f => !(f as any).__restored);

    if (userSelected && hasNewFiles && !hasOverlap && prevIds.size > 0) {
      setImageSceneTypesById({});
      setManualSceneTypesById({});
      setImageRoomTypesById({});
      setImageSkyReplacementById({});
      setMetaByIndex({});
      setSelection(new Set());
      setManualSceneOverrideById({});
      setScenePredictionsById({});
      scenePredictionsByIdRef.current = {};
      sceneDetectCacheRef.current = {};
    } else if (prevIds.size === 0 && currentIds.size > 0 && userSelected) {
      setImageSceneTypesById({});
      setManualSceneTypesById({});
      setImageRoomTypesById({});
      setImageSkyReplacementById({});
      setMetaByIndex({});
      setSelection(new Set());
      setManualSceneOverrideById({});
      setScenePredictionsById({});
      scenePredictionsByIdRef.current = {};
      sceneDetectCacheRef.current = {};
    }

    prevFileIdsRef.current = currentIds;
  }, [files]);

  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    };
  }, []);

  // When user enters the Images tab, prefill scene predictions using client-side detector
  // NOTE: This effect only runs on file list changes / initial load, NOT on scene type changes
  // to prevent re-running detection when user clicks Interior/Exterior buttons
  // IMPORTANT: Only detect for NEW images whose imageId is not already in scenePredictionsById
  useEffect(() => {
    if (activeTab !== "images" || !files.length) return;
    let cancelled = false;
    console.log("[SceneDetect] starting auto-detect pass", { fileCount: files.length });
    (async () => {
      const nextPreds: Record<string, SceneDetectResult> = {};
      const skyDefaults: Record<string, boolean> = {};

      // Process files sequentially with microtask yields to prevent UI blocking
      for (let i = 0; i < files.length; i++) {
        if (cancelled) break;
        const f = files[i];
        const imageId = getFileId(f);

        // Skip files with manual scene override already set
        const manualScene = manualSceneTypesByIdRef.current[imageId];
        if (manualScene) {
          console.log("[SceneDetect] skip manual scene", { imageId, scene: manualScene });
          continue;
        }
        const explicit = imageSceneTypesByIdRef.current[imageId];
        if (explicit && explicit !== "auto") {
          console.log("[SceneDetect] skip existing scene", { imageId, scene: explicit });
          continue;
        }
        const existingPrediction = scenePredictionsByIdRef.current[imageId];
        if (existingPrediction) {
          console.log("[SceneDetect] reuse cached prediction", { imageId, scene: existingPrediction.scene, source: existingPrediction.source });
          nextPreds[imageId] = existingPrediction;
          continue;
        }

        // Yield to main thread between file processing to keep UI responsive
        await new Promise(resolve => setTimeout(resolve, 0));
        if (cancelled) break;

        const prediction = await detectSceneFromFile(f);
        if (!cancelled) {
          nextPreds[imageId] = prediction;
          if (prediction.scene && !manualSceneTypesByIdRef.current[imageId]) {
            setImageSceneTypesById(prev => {
              if (prev[imageId] && prev[imageId] !== "auto") return prev;
              return { ...prev, [imageId]: prediction.scene as string };
            });
            if (prediction.scene === "exterior" && imageSkyReplacementById[imageId] === undefined) {
              skyDefaults[imageId] = true;
            }
          } else {
            setImageSceneTypesById(prev => {
              const copy = { ...prev } as Record<string, string>;
              delete copy[imageId];
              return copy;
            });
          }
        }
      }

      if (!cancelled && Object.keys(nextPreds).length) {
        setScenePredictionsById(prev => ({ ...prev, ...nextPreds }));
        if (Object.keys(skyDefaults).length) {
          setImageSkyReplacementById(prev => ({ ...prev, ...skyDefaults }));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [activeTab, files, imageSkyReplacementById]);

  const finalSceneForIndex = useCallback((index: number): SceneLabel | null => {
    const imageId = getImageIdForIndex(index);
    if (!imageId) return null;
    const manual = manualSceneTypesById[imageId];
    if (manual === "interior" || manual === "exterior") return manual;
    const explicit = imageSceneTypesById[imageId];
    if (explicit === "interior" || explicit === "exterior") return explicit;
    const pred = scenePredictionsById[imageId];
    if (pred?.scene) return pred.scene;
    return null;
  }, [getImageIdForIndex, imageSceneTypesById, manualSceneTypesById, scenePredictionsById]);

  const sceneRequiresInput = useCallback((index: number) => {
    const imageId = getImageIdForIndex(index);
    if (!imageId) return true;
    const manual = manualSceneTypesById[imageId];
    if (manual === "interior" || manual === "exterior") return false;
    const explicit = imageSceneTypesById[imageId];
    if (explicit === "interior" || explicit === "exterior") return false;
    const pred = scenePredictionsById[imageId];
    if (pred?.scene) return false;
    return true; // no scene prediction and no user selection
  }, [getImageIdForIndex, imageSceneTypesById, manualSceneTypesById, scenePredictionsById]);

  const roomTypeRequiresInput = useCallback((index: number) => {
    if (!allowStaging) return false;
    const scene = finalSceneForIndex(index);
    if (scene !== "interior") return false;
    const imageId = getImageIdForIndex(index);
    if (!imageId) return true;
    return !(imageRoomTypesById[imageId]);
  }, [allowStaging, finalSceneForIndex, getImageIdForIndex, imageRoomTypesById]);

  const imageValidationStatus = useCallback((index: number): "needs_input" | "ok" | "unknown" => {
    if (sceneRequiresInput(index) || roomTypeRequiresInput(index)) return "needs_input";
    const hasScene = !!finalSceneForIndex(index);
    const imageId = getImageIdForIndex(index);
    const hasRoom = imageId ? !!imageRoomTypesById[imageId] : false;
    return hasScene || hasRoom ? "ok" : "unknown";
  }, [finalSceneForIndex, getImageIdForIndex, imageRoomTypesById, roomTypeRequiresInput, sceneRequiresInput]);

  const blockingIndices = useMemo(() => {
    const blockers: number[] = [];
    files.forEach((_, idx) => {
      if (imageValidationStatus(idx) === "needs_input") blockers.push(idx);
    });
    return blockers;
  }, [files, imageValidationStatus]);

  const recordScenePrediction = useCallback((index: number, prediction: SceneDetectResult) => {
    const imageId = getImageIdForIndex(index);
    if (!imageId) return;
    const normalized: SceneDetectResult = {
      scene: prediction?.scene ?? null,
      confidence: clamp01(prediction?.confidence) ?? 0,
      signal: clamp01(prediction?.signal) ?? 0,
      features: prediction?.features || EMPTY_SCENE_FEATURES,
      reason: prediction?.reason ?? "uncertain",
      source: prediction?.source || "server",
    };
    setScenePredictionsById(prev => ({ ...prev, [imageId]: normalized }));
    if (normalized.scene) {
      setImageSceneTypesById(prev => {
        if (prev[imageId] && prev[imageId] !== "auto") return prev;
        return { ...prev, [imageId]: normalized.scene as string };
      });
      if (normalized.scene === "exterior" && imageSkyReplacementById[imageId] === undefined) {
        setImageSkyReplacementById(prev => ({ ...prev, [imageId]: true }));
      }
    }
  }, [getImageIdForIndex, imageSkyReplacementById]);

  const blockingCount = blockingIndices.length;
  const firstBlockingIndex = blockingIndices[0] ?? 0;
  const currentFinalScene = finalSceneForIndex(currentImageIndex);

  const batchCreditEstimateInputs = useMemo(
    () => files.map((_, index) => {
      const perImageMeta = (metaByIndex as Record<number, any>)[index] || {};
      const scene = finalSceneForIndex(index) === "exterior" ? "exterior" : "interior";
      const userSelectedStage1B = perImageMeta.declutter !== undefined
        ? !!perImageMeta.declutter
        : !!declutter;
      const userSelectedStage2 = perImageMeta.virtualStage !== undefined
        ? !!perImageMeta.virtualStage
        : !!allowStaging;

      return {
        sceneType: scene,
        userSelectedStage1B,
        userSelectedStage2,
      };
    }),
    [allowStaging, declutter, files, finalSceneForIndex, metaByIndex]
  );

  const requiredBatchCredits = useMemo(
    () => estimateBatchCredits(batchCreditEstimateInputs),
    [batchCreditEstimateInputs]
  );

  const isEnhanceCreditBlocked = availableCredits !== null && requiredBatchCredits > availableCredits;

  const openCreditGateModal = useCallback((requiredCredits: number, available: number) => {
    setCreditGateModal({
      open: true,
      requiredCredits,
      availableCredits: available,
    });
  }, []);

  const refreshCreditSummary = useCallback(async () => {
    if (!currentUserId) {
      setAvailableCredits(null);
      return null;
    }

    try {
      setIsCreditSummaryLoading(true);
      const summary = await apiJson<any>("/api/billing/subscription");
      const monthlyRemaining = Math.max(0, Number(summary?.allowance?.monthlyRemaining ?? 0));
      const addonRemaining = Math.max(0, Number(summary?.addOns?.remaining ?? 0));
      const totalAvailable = monthlyRemaining + addonRemaining;
      setAvailableCredits(totalAvailable);
      return {
        monthlyRemaining,
        addonRemaining,
        availableCredits: totalAvailable,
      };
    } catch (err) {
      console.warn("[CREDIT_GATE] Failed to refresh billing summary", err);
      setAvailableCredits(null);
      return null;
    } finally {
      setIsCreditSummaryLoading(false);
    }
  }, [currentUserId]);

  useEffect(() => {
    void refreshCreditSummary();
  }, [refreshCreditSummary]);

  useEffect(() => {
    const onFocus = () => {
      void refreshCreditSummary();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshCreditSummary]);

  // Manual room linking functions
  function toggleSelect(i: number) {
    setSelection(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  // Assign a roomKey to all selected items
  function assignRoomKey() {
    const roomKey = prompt("Enter room group label (e.g., Lounge-A):")?.trim();
    if (!roomKey) return;
    setMetaByIndex(prev => {
      const next = { ...prev };
      selection.forEach(i => {
        next[i] = { ...(next[i] || {}), roomKey };
      });
      return next;
    });
    // Clear selection after assignment
    setSelection(new Set());
  }

  // Set angle order for selected items (e.g., "2" means follow-up; "1" = primary)
  function setAngleOrder() {
    const v = prompt("Angle order number (1 = primary, 2 = second angle, etc.):")?.trim();
    const n = v ? parseInt(v, 10) : NaN;
    if (!n || n < 1) return;
    setMetaByIndex(prev => {
      const next = { ...prev };
      selection.forEach(i => {
        next[i] = { ...(next[i] || {}), angleOrder: n };
      });
      return next;
    });
    // Clear selection after assignment
    setSelection(new Set());
  }

  // Build metaJson to send with the batch request
  const metaJson = useMemo(() => {
    // Build array of metadata for each image
    const arr: any[] = [];
    files.forEach((file, i) => {
      const imageId = getFileId(file);
      const metaItem: any = { index: i };
      // Room linking
      if (metaByIndex[i]?.roomKey) metaItem.roomKey = metaByIndex[i].roomKey;
      if (metaByIndex[i]?.angleOrder) metaItem.angleOrder = metaByIndex[i].angleOrder;
      // Scene type
      const sceneType = finalSceneForIndex(i) || "auto";
      if (sceneType !== "auto") metaItem.sceneType = sceneType;
      const pred = scenePredictionsById[imageId];
      const predConf = clamp01(pred?.confidence ?? null);
      if (pred) {
        metaItem.scenePrediction = {
          scene: pred.scene,
          confidence: predConf,
          signal: clamp01(pred.signal) ?? pred.signal ?? null,
          reason: pred.reason,
          features: pred.features,
          source: pred.source || "client",
        };
      }
      if (manualSceneOverrideById[imageId]) metaItem.manualSceneOverride = true;
      // Room type (only for interiors)
      if (allowStaging && (sceneType !== "exterior")) {
        const roomType = imageRoomTypesById[imageId];
        if (roomType) metaItem.roomType = roomType;
      }
      // Sky replacement (only for exteriors)
      if (sceneType === "exterior" && imageSkyReplacementById[imageId] !== undefined) {
        metaItem.replaceSky = imageSkyReplacementById[imageId];
      }
      // Tuning controls
      if (samplingUiEnabled) {
        const tNum = temperatureInput.trim() ? Number(temperatureInput) : undefined;
        const pNum = topPInput.trim() ? Number(topPInput) : undefined;
        const kNum = topKInput.trim() ? Number(topKInput) : undefined;
        if (Number.isFinite(tNum)) metaItem.temperature = tNum;
        if (Number.isFinite(pNum)) metaItem.topP = pNum;
        if (Number.isFinite(kNum)) metaItem.topK = kNum;
      }
      arr.push(metaItem);
    });
    return JSON.stringify(arr);
  }, [metaByIndex, files, finalSceneForIndex, imageSceneTypesById, imageRoomTypesById, imageSkyReplacementById, manualSceneOverrideById, linkImages, temperatureInput, topPInput, topKInput, results, allowStaging, samplingUiEnabled, scenePredictionsById]);

  // Progressive display: Process ONE item per animation frame to prevent React batching
  const schedule = () => {
    if (scheduledRef.current) return;
    scheduledRef.current = true;

    requestAnimationFrame(function tick() {
      const next = queueRef.current.shift();
      if (next) {
        // Debug: Log what we're about to normalize
        console.log('[SCHEDULE] Processing item:', {
          index: next.index,
          hasResult: !!next.result,
          resultKeys: next.result ? Object.keys(next.result) : [],
          imageUrl: next.result?.imageUrl ? String(next.result.imageUrl).substring(0, 100) : 'missing',
          error: next.error
        });
        
        // Standardize to BatchResult shape
        const norm = normalizeBatchItem(next.result);
        
        console.log('[SCHEDULE] Normalized:', {
          index: next.index,
          normOk: norm?.ok,
          normImage: norm?.image ? String(norm.image).substring(0, 100) : 'missing',
          normError: norm?.error
        });
        
        setResults(prev => {
          const copy = prev ? [...prev] : [];
          const existing = copy[next.index] || {} as any;
          // Persist requestedStages and meta so target-stage completion logic works
          const mergedRequestedStages = next.requestedStages || next.result?.requestedStages || next.result?.meta?.requestedStages || existing.requestedStages || existing.result?.requestedStages || null;
          const mergedMeta = {
            ...(existing.meta || {}),
            ...(next.result?.meta || {}),
          };
          // Ensure allowStaging is captured from component state if not set by server
          if (mergedMeta.allowStaging === undefined && typeof allowStaging === 'boolean') {
            mergedMeta.allowStaging = allowStaging;
          }
          copy[next.index] = {
            ...existing,
            index: next.index,
            filename: next.filename,
            ok: !!norm?.ok,
            image: norm?.image || undefined,
            originalImageUrl: next.result?.originalImageUrl || next.result?.originalUrl || undefined,  // Preserve original URL for comparison slider
            stageUrls: next.stageUrls || next.result?.stageUrls || existing.stageUrls || null,
            imageId: next.imageId || next.result?.imageId,
            jobId: next.jobId,
            error: next.error || norm?.error,
            requestedStages: mergedRequestedStages,
            meta: mergedMeta,
            retryInFlight: undefined, // Clear retry UI state when server update arrives
            retryStage: undefined, // Clear retry stage when server update arrives
          };
          return copy;
        });

        // Also clear retry tracking Sets if this is a terminal status
        const hasRetryFlags = retryingImages.has(next.index) || retryLoadingImages.has(next.index);
        const isTerminalStatus = next.result?.status === 'completed' || next.result?.status === 'failed';
        if (hasRetryFlags && isTerminalStatus) {
          clearRetryFlags(next.index);
        }

        // If the server included job meta like scene detection, surface it
        if (next.result && next.result.meta && next.result.meta.scene) {
          const scene = next.result.meta.scene;
          const normalizedScene = normalizeSceneLabel(scene.label);
          const conf = clamp01(scene.confidence ?? null);
          recordScenePrediction(next.index, {
            scene: normalizedScene,
            confidence: conf ?? 0,
            signal: clamp01(scene.signal ?? conf ?? null) ?? 0,
            features: scene.features || EMPTY_SCENE_FEATURES,
            reason: scene.reason || (normalizedScene ? (normalizedScene === "exterior" ? "confident_exterior" : "confident_interior") : "uncertain"),
            source: "server",
          });
          if (normalizedScene) {
            setProgressText(`Detected: ${normalizedScene} (${Math.round((conf || 0) * 100)}%)`);
            setLastDetected({ index: next.index, label: normalizedScene, confidence: conf || 0 });
          }
        }

        // Update processed images tracking in the same tick
        const enhancedUrl = getEnhancedUrl(next.result) || (norm?.ok ? norm?.image : null);
        if (enhancedUrl) {
          if (enhancedUrl.startsWith('http') || enhancedUrl.startsWith('/api/images/')) {
            setProcessedImages(prev => [...prev, enhancedUrl]);
            setProcessedImagesByIndex(prev => ({
              ...prev,
              [next.index]: enhancedUrl
            }));
          } else if (!enhancedUrl.startsWith('data:')) {
            console.warn('Unexpected URL format for ZIP download:', enhancedUrl);
          }
        }
      }
      
      // Continue processing if more items in queue
      if (queueRef.current.length) {
        requestAnimationFrame(tick);
      } else {
        scheduledRef.current = false;
      }
    });
  };

  // ✅ Resilient helper to extract imageUrl from various response shapes
  function getEnhancedUrl(result: any): string | null {
    if (!result) return null;

    // Preferred normalized shape
    if (typeof result.imageUrl === "string") return result.imageUrl;

    // Common alternates
    if (typeof result === "string" && result.startsWith("http")) return result;
    if (result.url) return result.url;
    if (result.data?.imageUrl) return result.data.imageUrl;
    if (result.output?.imageUrl) return result.output.imageUrl;
    if (Array.isArray(result.images) && result.images[0]?.url) return result.images[0].url;

    // Base64 as last resort
    if (typeof result.imageBase64 === "string") return `data:image/jpeg;base64,${result.imageBase64}`;
    if (result.data?.imageBase64) return `data:image/jpeg;base64,${result.data.imageBase64}`;

    return null;
  }

  const previewUrls = useMemo(
    () => files.map((f: any) => (f.__restored ? RESTORED_PLACEHOLDER : URL.createObjectURL(f))),
    [files]
  );

  useEffect(() => () => {
    previewUrls.forEach(u => {
      // Only revoke real blob/object URLs; placeholders/data URIs need no cleanup
      if (u && typeof u === "string" && u.startsWith("blob:")) {
        URL.revokeObjectURL(u);
      }
    });
  }, [previewUrls]);
  
  // Progress text clears when files change
  useEffect(() => {
    setProgressText("");
  }, [files]);

  // Restore batch job state on component mount
  useEffect(() => {
    const userId = currentUserId;
    if (!userId) {
      console.log("[BATCH_RESTORE_SKIPPED_NO_USER]");
      clearBatchJobState(undefined, { resetUI: true });
      return;
    }

    const savedState = loadBatchJobState(userId);
    if (!savedState) return;

    if (savedState.ownerUserId && savedState.ownerUserId !== userId) {
      console.log("[BATCH_RESTORE_SKIPPED_DIFFERENT_USER]", { stored: savedState.ownerUserId, current: userId });
      clearBatchJobState(userId, { resetUI: true });
      return;
    }

    console.log("[BATCH_RESTORE_OK]", { userId, jobId: savedState.jobId });
    setJobId(savedState.jobId);
    setJobIds(savedState.jobIds || (savedState.jobId ? [savedState.jobId] : []));
    setRunState(savedState.runState);
    setResults(savedState.results);
    setProcessedImages(savedState.processedImages);
    setProcessedImagesByIndex(savedState.processedImagesByIndex);
    jobIdToIndexRef.current = savedState.jobIdToIndex || {};
    imageIdToIndexRef.current = savedState.imageIdToIndex || {};
    if (!Object.keys(jobIdToIndexRef.current).length) {
      rebuildJobIndexMapping(savedState.jobIds, savedState.fileMetadata?.length || savedState.results?.length || 0);
    }
    if (!Object.keys(imageIdToIndexRef.current).length && Array.isArray(savedState.results)) {
      savedState.results.forEach((res, idx) => {
        const imgId = res?.imageId || res?.result?.imageId;
        if (imgId && imageIdToIndexRef.current[imgId] === undefined) {
          imageIdToIndexRef.current[imgId] = idx;
        }
      });
    }
    setGlobalGoal(savedState.goal);
    setPreserveStructure?.(savedState.settings.preserveStructure);
    setAllowStaging(savedState.settings.allowStaging);
    setAllowRetouch?.(savedState.settings.allowRetouch);
    setOutdoorStaging(savedState.settings.outdoorStaging as "auto" | "none");
    setFurnitureReplacement(savedState.settings.furnitureReplacement ?? true);
    setDeclutter(savedState.settings.declutter ?? false);
    setPropertyAddress(savedState.settings.propertyAddress ?? "");
    // DO NOT restore stagingStyle - always default to Standard Listing
    // User must explicitly select a different style for each new session
    
    // Restore file metadata if available
    if (savedState.fileMetadata && savedState.fileMetadata.length > 0) {
      console.log("Restoring file metadata for", savedState.fileMetadata.length, "files");
      // Create placeholder File objects from metadata so the UI shows the upload queue
      const restoredFiles = savedState.fileMetadata.map((meta) => {
        const blob = new Blob([`Placeholder for ${meta.name}`], { type: meta.type });
        const file = new File([blob], meta.name, {
          type: meta.type,
          lastModified: meta.lastModified
        });
        (file as any).__restored = true; // display-only placeholder
        return file;
      });
      setFiles(restoredFiles);
    }
    
    if (savedState.runState === "running") {
      setActiveTab("enhance");
      startPollingExistingBatch(savedState.jobIds && savedState.jobIds.length ? savedState.jobIds : [savedState.jobId]);
    } else if (savedState.runState === "done") {
      setActiveTab("enhance");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId]);

  // Clear enhancement state when user changes (cross-account guard)
  useEffect(() => {
    const prev = prevUserIdRef.current;
    if (prev && prev !== currentUserId) {
      requestClearEnhancementState(prev);
      requestClearEnhancementState(currentUserId);
    }
    prevUserIdRef.current = currentUserId;
  }, [currentUserId]);

  // Listen for global clear requests (logout or manual clear) to reset component state and abort polling
  useEffect(() => {
    const handler = () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        setAbortController(null);
      }
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      queueRef.current = [];
      processedSetRef.current = new Set();
      jobIdToIndexRef.current = {};
      imageIdToIndexRef.current = {};
      jobIdToImageIdRef.current = {};
      regionEditJobIdsRef.current = new Set();
      strictNotifiedRef.current = new Set();
      statusUnknownLoggedRef.current = new Set();
      idxMissingLoggedRef.current = new Set();
      statusHasUrlLoggedRef.current = new Set();
      statusTargetNotReachedLoggedRef.current = new Set();
      retryChildMappingLoggedRef.current = new Set();
      autoFurnitureNoticeLoggedRef.current = new Set();
      sceneDetectCacheRef.current = {};
      scenePredictionsByIdRef.current = {};
      clientBatchIdRef.current = null;
      previousFileCountRef.current = 0;
      setJobId("");
      setJobIds([]);
      setCancelIds([]);
      setClientBatchId(null);
      setResults([]);
      setProcessedImages([]);
      setProcessedImagesByIndex({});
      setRetryingImages(new Set());
      setRetryLoadingImages(new Set());
      setEditingImages(new Set());
      setEditCompletedImages(new Set());
      setDisplayStageByIndex({});
      setStrictRetryingIndices(new Set());
      setProgressText("");
      setMessageIndexByImage({});
      setAiSteps({});
      setIsUploading(false);
      setIsBatchRefining(false);
      setHasRefinedImages(false);
      setSelection(new Set());
      setMetaByIndex({});
      setImageRoomTypesById({});
      setImageSceneTypesById({});
      setManualSceneTypesById({});
      setManualSceneOverrideById({});
      setImageSkyReplacementById({});
      setScenePredictionsById({});
      setGlobalGoal("");
      setPropertyAddress("");
      setPreserveStructure(true);
      setLinkImages(false);
      setSelectedImageId(null);
      setCurrentImageIndex(0);
      setShowSpecificRequirements(false);
      setPreviewImage(null);
      setEditingImageIndex(null);
      setActiveEditSource(null);
      setRegionEditorOpen(false);
      setRunState("idle");
      setFiles([]);
      setActiveTab("images");
      console.log("[BATCH_STATE_CLEARED]", { source: "clear-event" });
    };
    window.addEventListener(CLEAR_EVENT, handler);
    return () => window.removeEventListener(CLEAR_EVENT, handler);
  // Uses refs for in-flight controllers/timers to avoid stale closures.
  }, []);

  // Auto-save state when key values change
  useEffect(() => {
    if (runState !== "idle" && (jobId || jobIds.length) && currentUserId) {
      const state: PersistedBatchJob = {
        ownerUserId: currentUserId,
        jobId,
        jobIds,
        runState,
        results,
        processedImages,
        processedImagesByIndex,
        timestamp: Date.now(),
        fileCount: files.length,
        goal: globalGoal,
        industry: industryMap[presetKey] || "Real Estate",
        settings: {
          preserveStructure,
          allowStaging,
          allowRetouch,
          outdoorStaging,
          furnitureReplacement,
          declutter,
          stagingStyle,
          propertyAddress,
        },
        fileMetadata: files.map(file => ({
          name: file.name,
          size: file.size,
          type: file.type,
          lastModified: file.lastModified
        })),
        jobIdToIndex: { ...jobIdToIndexRef.current },
        imageIdToIndex: { ...imageIdToIndexRef.current }
      };
      saveBatchJobState(state, currentUserId);
    }
  }, [jobId, jobIds, runState, results, processedImages, processedImagesByIndex, files, globalGoal, presetKey, preserveStructure, allowStaging, allowRetouch, outdoorStaging, furnitureReplacement, declutter, stagingStyle, propertyAddress, currentUserId]);

  const startPollingExistingBatch = async (ids: string[]) => {
    if (!ids.length) return;
    const controller = new AbortController();
    setAbortController(controller);
    await pollForBatch(ids, controller);
  };

  // Polling function for existing jobs
  const startPollingExistingJob = async (existingJobId: string) => {
    const controller = new AbortController();
    setAbortController(controller);
    
    await pollForResults(existingJobId, controller);
  };

  // Extracted polling logic for reuse
  const pollForResults = async (currentJobId: string, controller: AbortController) => {
    // Persist so we can resume after reload/nav (per-user key)
    localStorage.setItem("activeJobId", currentJobId);
    if (currentUserId) {
      localStorage.setItem(makeActiveKey(currentUserId), JSON.stringify([currentJobId]));
    }
    
    const MAX_POLL_MINUTES = 45;                         // Extended from 5 minutes to 45 minutes
    const MAX_POLL_MS = MAX_POLL_MINUTES * 60 * 1000;
    const BACKOFF_START_MS = 1000;                       // 1s
    const BACKOFF_MAX_MS = 5000;                         // cap at 5s
    const BACKOFF_FACTOR = 1.5;                          // 1s→1.5s→2.25s→…→≤5s
    
    let delay = BACKOFF_START_MS;
    const deadline = Date.now() + MAX_POLL_MS;
    
    while (Date.now() < deadline) {
      try {
        if (controller.signal.aborted) {
          return;
        }
        
  const resp = await fetch(api(`/api/status/${encodeURIComponent(currentJobId)}`), {
          method: "GET",
          credentials: "include",
          headers: {
            ...withDevice().headers,
            "Cache-Control": "no-cache"
          },
          signal: controller.signal
        });

        if (!resp.ok) {
          // Treat transient/missing as queued; keep polling instead of surfacing error
          if (resp.status === 404 || resp.status === 204) {
            setProgressText("Preparing job…");
            await new Promise(r => setTimeout(r, Math.max(BACKOFF_START_MS, delay)));
            delay = Math.min(BACKOFF_MAX_MS, Math.floor(delay * BACKOFF_FACTOR));
            continue;
          }
          if (resp.status === 401 || resp.status === 403) {
            handleAuthFailure();
            return alert("Session expired. Please login and retry.");
          }
          const err = await resp.json().catch(() => ({}));
          console.warn("[status-poll] transient error", { status: resp.status, body: err });
          await new Promise(r => setTimeout(r, Math.max(BACKOFF_START_MS, delay)));
          delay = Math.min(BACKOFF_MAX_MS, Math.floor(delay * BACKOFF_FACTOR));
          continue;
        }

  const data = await resp.json();

        // Single-job strict retry toast + badge state
        try {
          const jid = data?.id || data?.jobId || currentJobId;
          const meta = data?.meta || {};
          if (jid && meta && meta.strictRetry && !strictNotifiedRef.current.has(jid)) {
            strictNotifiedRef.current.add(jid);
            const reasons: string[] = Array.isArray(meta.strictRetryReasons) ? meta.strictRetryReasons : [];
            toast({
              title: 'Retrying with stricter validation',
              description: reasons.length ? reasons.join('; ') : (data?.message || 'Adjusting settings to preserve structure.'),
            });
          }
          // Maintain badge for index 0 in single-job mode
          if (meta && meta.strictRetry) {
            setStrictRetryingIndices(prev => {
              const next = new Set(prev);
              next.add(0);
              return next;
            });
          } else {
            // Clear when strictRetry no longer present
            setStrictRetryingIndices(prev => {
              const next = new Set(prev);
              next.delete(0);
              return next;
            });
          }
        } catch {}

        // Harvest per-item job ids for server-side cancellation
        if (Array.isArray(data.items)) {
          const ids: string[] = [];
          for (const it of data.items) {
            const id = it?.id || it?.jobId || it?.job_id;
            if (typeof id === 'string') ids.push(id);
          }
          if (ids.length) {
            setCancelIds(prev => {
              const set = new Set(prev);
              ids.forEach(id => set.add(id));
              return Array.from(set);
            });
          }
        }
        
        // Update progress text based on job status
        if (data.items) {
          const completed = data.items.filter((item: any) => item && (item.status === 'completed' || item.status === 'failed')).length;
          const total = data.count || data.items.length;
          if (completed === total && total > 0) {
            setProgressText('Completed');
          } else {
            setProgressText(`Processing images: ${completed}/${total} completed`);
          }

          // Surface strict retry notifications as toasts (once per job)
          try {
            for (const item of data.items) {
              const jid = item?.id || item?.jobId || item?.job_id;
              if (!jid) continue;
              const meta = item?.meta || {};
              if (meta && meta.strictRetry && !strictNotifiedRef.current.has(jid)) {
                strictNotifiedRef.current.add(jid);
                const reasons: string[] = Array.isArray(meta.strictRetryReasons) ? meta.strictRetryReasons : [];
                toast({
                  title: 'Retrying with stricter validation',
                  description: reasons.length ? reasons.join('; ') : (item?.message || 'Adjusting settings to preserve structure.'),
                });
              }
            }
          } catch {}
          
          // Process any new completed items
          for (let i = 0; i < data.items.length; i++) {
            const item = data.items[i];
            const url = item?.imageUrl || item?.resultUrl || item?.image || null;
            const originalUrl = item?.originalImageUrl || item?.originalUrl || item?.original || null;
            const itemRequestedStages = item?.requestedStages || item?.meta?.requestedStages || null;
            if (item && item.status === 'completed' && !processedSetRef.current.has(i)) {
              processedSetRef.current.add(i);
              queueRef.current.push({
                index: i,
                result: { imageUrl: url, originalImageUrl: originalUrl, qualityEnhancedUrl: item.qualityEnhancedUrl, mode: item.mode, note: item.note, meta: item.meta, requestedStages: itemRequestedStages },
                jobId: item?.id || item?.jobId || item?.job_id || currentJobId,
                imageId: item?.imageId,
                stageUrls: item?.stageUrls || null,
                requestedStages: itemRequestedStages,
                filename: item.filename || `image-${i + 1}`
              });
            } else if (item && item.status === 'failed' && !processedSetRef.current.has(i)) {
              processedSetRef.current.add(i);
              queueRef.current.push({
                index: i,
                error: item.error || "Processing failed",
                jobId: item?.id || item?.jobId || item?.job_id || currentJobId,
                imageId: item?.imageId,
                requestedStages: itemRequestedStages,
                filename: item.filename || `image-${i + 1}`
              });
            }
            if (item?.meta?.scene) {
              const scene = item.meta.scene;
              const normalizedScene = normalizeSceneLabel(scene.label);
              const conf = clamp01(scene.confidence ?? null);
              recordScenePrediction(i, {
                scene: normalizedScene,
                confidence: conf ?? 0,
                signal: clamp01(scene.signal ?? conf ?? null) ?? 0,
                features: scene.features || EMPTY_SCENE_FEATURES,
                reason: scene.reason || (normalizedScene ? (normalizedScene === "exterior" ? "confident_exterior" : "confident_interior") : "uncertain"),
                source: "server",
              });
            }
            // Merge room type detection (user override precedence)
            try {
              const detected = item?.meta?.roomTypeDetected || item?.meta?.roomType;
              if (detected && i < files.length) {
                const imgIdForDetection = getFileId(files[i]);
                setImageRoomTypesById(prev => {
                  const current = prev[imgIdForDetection];
                  if (!current || current === 'auto') {
                    setRoomTypeDetectionTick(tick => tick + 1); // Force re-render
                    return { ...prev, [imgIdForDetection]: detected };
                  }
                  return prev;
                });
              }
            } catch {}
          }
          
          schedule(); // Process queued updates
        }
        // Single-job endpoint (no items array): synthesize one entry when terminal
        if (!data.items && typeof data.status === 'string') {
          const terminal = ['completed','failed','error'].includes(data.status);
          if (terminal && !processedSetRef.current.has(0)) {
            processedSetRef.current.add(0);
            if (data.status === 'completed') {
              const url = data.imageUrl || data.resultUrl || data.image || null;
              const originalUrl = data.originalImageUrl || data.originalUrl || data.original || null;
              queueRef.current.push({
                index: 0,
                result: { imageUrl: url, originalImageUrl: originalUrl, mode: 'enhanced' },
                filename: files[0]?.name || 'image-1'
              });
            } else {
              queueRef.current.push({ index: 0, error: data.error || 'Processing failed', filename: files[0]?.name || 'image-1' });
            }
            schedule();
          }
          if (data.status === 'completed') {
            // Gate on target stage URL before declaring done
            const singleStageMap = data?.stageUrls || data?.result?.stageUrls || {};
            const singleReqStages = data?.requestedStages || data?.meta?.requestedStages || data?.result?.requestedStages || {};
            const singleSceneLabel = String(data?.meta?.scene?.label || data?.result?.meta?.scene?.label || "").toLowerCase();
            const singleStagingAllowed = getPerImageStagingAllowed(data);
            const singleReqStage2 = singleReqStages?.stage2 === true || singleReqStages?.stage2 === "true";
            const singleDeclutter = !!singleReqStages?.stage1b;
            const singleStage2Expected = singleReqStage2 && singleSceneLabel !== "exterior" && singleStagingAllowed;
            const singleTarget: StageKey = singleStage2Expected ? "2" : singleDeclutter ? "1B" : "1A";
            const singleS2 = singleStageMap?.['2'] || singleStageMap?.stage2 || null;
            const singleS1B = singleStageMap?.['1B'] || singleStageMap?.['1b'] || singleStageMap?.stage1B || null;
            const singleS1A = singleStageMap?.['1A'] || singleStageMap?.['1a'] || singleStageMap?.['1'] || singleStageMap?.stage1A || null;
            const singleFallback = data.imageUrl || data.resultUrl || data.image || null;
            const singleTargetPresent = (
              (singleTarget === "2" && !!singleS2) ||
              (singleTarget === "1B" && !!singleS1B) ||
              (singleTarget === "1A" && (!!singleS1A || !!singleFallback))
            );
            if (singleTargetPresent) {
              setRunState('done');
              setAbortController(null);
              clearBatchJobState(currentUserId);
              await refreshUser();
              setProgressText('Batch complete! 1 images enhanced successfully.');
              return;
            }
            // Target not reached yet — continue polling
          }
          if (['failed','error'].includes(data.status)) {
            setRunState('idle');
            setAbortController(null);
            clearBatchJobState(currentUserId);
            setProgressText('Batch failed');
            return;
          }
        }
        
        if (data.done) {
          // Verify all items have reached their target stages before stopping
          const doneItems = Array.isArray(data.items) ? data.items : [];
          const allTargetsReached = doneItems.length > 0 && doneItems.every((di: any) => {
            const diStatus = String(di?.status || di?.state || "").toLowerCase();
            if (diStatus === 'failed') return true; // Failed is terminal
            const diStageMap = di?.stageUrls || di?.stage_urls || {};
            const diReqStages = di?.requestedStages || di?.meta?.requestedStages || {};
            const diScene = String(di?.meta?.scene?.label || "").toLowerCase();
            const diStagingOk = getPerImageStagingAllowed(di);
            const diReqS2 = diReqStages?.stage2 === true || diReqStages?.stage2 === "true";
            const diDeclutter = !!diReqStages?.stage1b;
            const diS2Expected = diReqS2 && diScene !== "exterior" && diStagingOk;
            const diTarget: StageKey = diS2Expected ? "2" : diDeclutter ? "1B" : "1A";
            const diS2 = diStageMap?.['2'] || diStageMap?.stage2 || null;
            const diS1B = diStageMap?.['1B'] || diStageMap?.['1b'] || diStageMap?.stage1B || null;
            const diS1A = diStageMap?.['1A'] || diStageMap?.['1a'] || diStageMap?.['1'] || diStageMap?.stage1A || null;
            const diFallback = di?.imageUrl || di?.resultUrl || null;
            return (
              (diTarget === "2" && !!diS2) ||
              (diTarget === "1B" && !!diS1B) ||
              (diTarget === "1A" && (!!diS1A || !!diFallback))
            );
          });
          if (allTargetsReached) {
            setRunState("done");
            setAbortController(null);
            clearBatchJobState(currentUserId);
            await refreshUser();
            const completedCount = doneItems.filter((item: any) => item && item.status === 'completed').length;
            setProgressText(`Batch complete! ${completedCount} images enhanced successfully.`);
            return;
          }
          // Not all targets reached — continue polling
        }
        
        // If we got a good response but not done, soften the backoff a bit
        delay = Math.max(BACKOFF_START_MS, Math.floor(delay / BACKOFF_FACTOR));
        
      } catch (error: any) {
        if (error.name === 'AbortError') {
          return;
        }
        console.error("Polling error:", error);
        // Network hiccup: keep backoff growing
        delay = Math.min(BACKOFF_MAX_MS, Math.floor(delay * BACKOFF_FACTOR));
      }
      
      // Yield to browser + wait
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    // Timed out window (job still likely running on server)
    console.warn("Batch polling window elapsed. You can manually resume later.");
    setAbortController(null);
    if (runState === "running") {
      setProgressText("Polling timeout reached - job may still be processing on server. You can refresh to resume.");
    }
  };

  // Multi-job polling using server batch endpoint
  const pollForBatch = async (ids: string[], controller: AbortController) => {
    if (currentUserId) {
      localStorage.setItem(makeActiveKey(currentUserId), JSON.stringify(ids));
    }
    const MAX_POLL_MINUTES = 45;
    const MAX_POLL_MS = MAX_POLL_MINUTES * 60 * 1000;
    const BACKOFF_START_MS = 1000;
    const BACKOFF_MAX_MS = 5000;
    const BACKOFF_FACTOR = 1.5;
    const TERMINAL_STATUSES = new Set(["completed", "complete", "done", "failed", "cancelled", "canceled"]);
    const STALE_DONE_GRACE_MS = 15_000;
    let delay = BACKOFF_START_MS;
    const deadline = Date.now() + MAX_POLL_MS;
    let doneSeenAt: number | null = null;
    let finalRefreshRequested = false;

    while (Date.now() < deadline) {
      try {
        if (controller.signal.aborted) return;
        const qs = encodeURIComponent(ids.join(","));
        const pollUrl = api(`/api/status/batch?ids=${qs}`);
        console.log('[BATCH] Polling URL:', pollUrl);
        const resp = await fetch(pollUrl, {
          method: "GET",
          credentials: "include",
          headers: { ...withDevice().headers, "Cache-Control": "no-cache" },
          signal: controller.signal
        });
        if (!resp.ok) {
          // Treat missing/empty as queued and continue polling (no red errors)
          if (resp.status === 404 || resp.status === 204) {
            await new Promise(r => setTimeout(r, Math.max(BACKOFF_START_MS, delay)));
            delay = Math.min(BACKOFF_MAX_MS, Math.floor(delay * BACKOFF_FACTOR));
            continue;
          }
          const err = await resp.json().catch(() => ({}));
          console.warn("[BATCH] poll error treated as transient", { status: resp.status, body: err });
          await new Promise(r => setTimeout(r, Math.max(BACKOFF_START_MS, delay)));
          continue;
        }
        const data = await resp.json();
        const items = Array.isArray(data.items) ? data.items : [];

        if (!items.length && !data.done) {
          // Empty payload → treat as queued and keep polling
          await new Promise(r => setTimeout(r, Math.max(BACKOFF_START_MS, delay)));
          delay = Math.min(BACKOFF_MAX_MS, Math.floor(delay * BACKOFF_FACTOR));
          continue;
        }

        // Debug logging to see what we're receiving
        if (items.length > 0) {
          console.log('[BATCH] Received status update:', {
            totalItems: items.length,
            completed: items.filter((it: any) => it && it.status === 'completed').length,
            sample: items[0] ? {
              id: items[0].id,
              status: items[0].status,
              hasImageUrl: !!items[0].imageUrl,
              hasResultUrl: !!items[0].resultUrl,
              imageUrlPreview: items[0].imageUrl ? String(items[0].imageUrl).substring(0, 100) : 'none',
              resultUrlPreview: items[0].resultUrl ? String(items[0].resultUrl).substring(0, 100) : 'none'
            } : null
          });
        }

        // strict retry toasts (once per job) and badge indices map
        try {
          const currentStrict = new Set<number>();
          for (const it of items) {
            const jid = it?.id || it?.jobId || it?.job_id;
            if (!jid) continue;
            const meta = it?.meta || {};
            if (meta && meta.strictRetry && !strictNotifiedRef.current.has(jid)) {
              strictNotifiedRef.current.add(jid);
              const reasons: string[] = Array.isArray(meta.strictRetryReasons) ? meta.strictRetryReasons : [];
              toast({
                title: 'Retrying with stricter validation',
                description: reasons.length ? reasons.join('; ') : (it?.message || 'Adjusting settings to preserve structure.'),
              });
            }
            if (meta && meta.strictRetry) {
              const idx = jobIdToIndexRef.current[jid];
              if (typeof idx === 'number') currentStrict.add(idx);
            }
          }
          // Replace the set with current strict retry indices
          setStrictRetryingIndices(currentStrict);
        } catch {}

          const statusCounts: Record<string, number> = {};
        const nonTerminalIndices: number[] = [];
        const reachedTargetOrFailedIndices = new Set<number>();
        let hasUnmappedNonTerminal = false;
        const queuedWithOutputs: Array<{ idx?: number; jobId?: string }> = [];
          const errorWithOutputs: Array<{ idx?: number; jobId?: string }> = [];
        const total = ids.length;

        // progress + status merge
        const completed = items.filter((it: any) => it && (String(it.state || it.jobState || it.queueStatus || "").toLowerCase() === 'completed')).length;

        // surface per-item updates (processing or completed) and merge stage URLs progressively
        const retryTerminalIndices = new Set<number>();

        for (const it of items) {
          const polledId = it?.jobId || it?.id || it?.job_id || it?.job?.id || it?.job?.jobId || it?.result?.jobId;
          const retryInfo = it?.retryInfo || it?.retry_info || it?.meta?.retryInfo || it?.meta?.retry_info || {};
          const metaParentJobId = it?.meta?.parentJobId || it?.meta?.parent_job_id || null;
          const jobParentJobId = it?.job?.parentJobId || it?.job?.parent_job_id || null;
          const parentJobId = it?.parentJobId || it?.parent_job_id || retryInfo?.parentJobId || retryInfo?.parent_job_id || metaParentJobId || jobParentJobId || null;
          const isRetryChildJob = !!(polledId && parentJobId && polledId !== parentJobId);
          const imageId = it?.imageId || it?.image_id || it?.meta?.imageId || it?.meta?.image_id || retryInfo?.imageId || retryInfo?.image_id || jobIdToImageIdRef.current[polledId || ''] || null;
          let idx = polledId ? jobIdToIndexRef.current[polledId] : undefined;
          let mappedViaParent = false;
          let mappedViaImage = false;

          if (typeof idx === 'undefined' && parentJobId) {
            const parentIdx = jobIdToIndexRef.current[parentJobId];
            if (typeof parentIdx === 'number') {
              idx = parentIdx;
              mappedViaParent = true;
            }
          }

          if (typeof idx === 'undefined' && imageId) {
            const imageIdx = imageIdToIndexRef.current[imageId];
            if (typeof imageIdx === 'number') {
              idx = imageIdx;
              mappedViaImage = true;
            }
          }

          const resolvedJobKey = polledId || parentJobId || (typeof idx === 'number' ? jobIds[idx] : null) || imageId || null;
          const key = resolvedJobKey || 'unknown';

          if (typeof idx === 'number') {
            if ((mappedViaParent || mappedViaImage) && !retryChildMappingLoggedRef.current.has(String(polledId || `${parentJobId || ''}:${imageId || ''}:${idx}`))) {
              retryChildMappingLoggedRef.current.add(String(polledId || `${parentJobId || ''}:${imageId || ''}:${idx}`));
              console.log('[BATCH][retry_child_mapped_to_parent]', { childJobId: polledId || null, parentJobId, imageId, idx });
            }
            if (polledId && jobIdToIndexRef.current[polledId] === undefined) {
              jobIdToIndexRef.current[polledId] = idx;
            }
            if (imageId) {
              imageIdToIndexRef.current[imageId] = idx;
            }
          }

          const uiStatusRaw = String(it?.uiStatus || it?.status || "").toLowerCase(); // ok | warning | error (preferred uiStatus)
          const pipelineStatusRaw = String(it?.status || it?.state || it?.jobState || it?.queueStatus || "").toLowerCase();
          const normalizedStatus = normalizeJobStatus(pipelineStatusRaw);
          if (normalizedStatus === "processing" && pipelineStatusRaw && !statusUnknownLoggedRef.current.has(pipelineStatusRaw)) {
            statusUnknownLoggedRef.current.add(pipelineStatusRaw);
            console.log('[BATCH][status_unknown]', { raw: pipelineStatusRaw });
          }
          const status = normalizedStatus === "cancelled" ? "failed" : normalizedStatus === "failed" ? "failed" : normalizedStatus === "completed" ? "completed" : "processing";
          const isTerminalFlag = normalizedStatus === "completed" || normalizedStatus === "failed" || normalizedStatus === "cancelled" || TERMINAL_STATUSES.has(status) || it?.isTerminal === true;
          const progress = typeof it?.progress === "number" ? it.progress
            : typeof it?.progressPct === "number" ? it.progressPct
            : typeof it?.progress_percent === "number" ? it.progress_percent
            : typeof it?.meta?.progress === "number" ? it.meta.progress
            : null;
          const stageUrlsRaw = it?.stageUrls || it?.stage_urls || null;
          const stageUrls = stageUrlsRaw ? {
            '2': toDisplayUrl(stageUrlsRaw['2']) || toDisplayUrl(stageUrlsRaw.stage2) || null,
            '1B': toDisplayUrl(stageUrlsRaw['1B']) || toDisplayUrl(stageUrlsRaw['1b']) || toDisplayUrl(stageUrlsRaw.stage1B) || null,
            '1A': toDisplayUrl(stageUrlsRaw['1A']) || toDisplayUrl(stageUrlsRaw['1']) || toDisplayUrl(stageUrlsRaw.stage1A) || null,
            stage2: toDisplayUrl(stageUrlsRaw.stage2) || toDisplayUrl(stageUrlsRaw['2']) || null,
            stage1B: toDisplayUrl(stageUrlsRaw.stage1B) || toDisplayUrl(stageUrlsRaw['1B']) || toDisplayUrl(stageUrlsRaw['1b']) || null,
            stage1A: toDisplayUrl(stageUrlsRaw.stage1A) || toDisplayUrl(stageUrlsRaw['1A']) || toDisplayUrl(stageUrlsRaw['1']) || null,
          } : null;
          const requestedStages = it?.requestedStages || it?.meta?.requestedStages || it?.metadata?.requestedStages || null;
          const requestedStage2 = requestedStages?.stage2 === true || requestedStages?.stage2 === "true";
          const declutterRequested = getPerImageDeclutterRequested(it);
          const trackedRegionEditJob = !!polledId && regionEditJobIdsRef.current.has(polledId);
          const editInFlightForIdx = typeof idx === "number" && editingImagesRef.current.has(idx);
          const isRegionEdit = trackedRegionEditJob || editInFlightForIdx ||
            String(it?.meta?.type || "").toLowerCase() === "region-edit" ||
            String(it?.meta?.jobType || "").toLowerCase() === "region_edit";
          const sceneLabel = String(it?.meta?.scene?.label || it?.meta?.sceneLabel || it?.meta?.scene_type || it?.meta?.sceneType || "").toLowerCase();
          const stagingAllowed = getPerImageStagingAllowed(it);
          const stage2Expected = requestedStage2 && sceneLabel !== "exterior" && stagingAllowed;
          const resultStage = it?.resultStage || it?.finalStage || it?.result_stage || (it?.meta && (it.meta.resultStage || it.meta.result_stage)) || null;
          const extraResult = it?.result || {};
          const finalOutputUrl =
            toDisplayUrl(it?.finalOutputUrl) ||
            toDisplayUrl(extraResult?.finalOutputUrl) ||
            toDisplayUrl(it?.publishedUrl) ||
            toDisplayUrl(it?.resultUrl) ||
            toDisplayUrl(it?.publishUrl) ||
            toDisplayUrl(it?.outputUrl) ||
            toDisplayUrl(it?.finalUrl) ||
            toDisplayUrl(extraResult?.resultUrl) ||
            toDisplayUrl(extraResult?.imageUrl) ||
            toDisplayUrl(extraResult?.url) ||
            null;
          const originalUrl = toDisplayUrl(it?.originalImageUrl) || toDisplayUrl(it?.originalUrl) || toDisplayUrl(it?.original) || null;
          const validation = it?.validation || it?.meta?.unifiedValidation || it?.meta?.unified_validation || {};
          const blockedStage = (validation as any)?.blockedStage || it?.blockedStage || it?.meta?.blockedStage || null;
          const fallbackStage = (validation as any)?.fallbackStage || it?.fallbackStage || it?.meta?.fallbackStage || null;
          const validationNote = (validation as any)?.note || it?.validationNote || it?.meta?.validationNote || null;
          const rawWarnings = Array.isArray(validation?.warnings) ? (validation.warnings as string[]) : [];
          if (validationNote) rawWarnings.push(validationNote);
          // FIX 2: Filter technical backend warnings for user display
          const warnings = filterWarningsForDisplay(rawWarnings);
          let hardFail = typeof validation?.hardFail === 'boolean' ? validation.hardFail : false;
          const stage2UrlRaw = stageUrls?.['2'] || stageUrls?.stage2 || null;
          const stage1bUrl = stageUrls?.['1B'] || stageUrls?.stage1B || null;
          const stage1aUrl = stageUrls?.['1A'] || stageUrls?.stage1A || null;
          const resultStageNorm = String(resultStage || "").toUpperCase();
          const stage2Mismatch = requestedStage2 === false && (stage2UrlRaw || resultStageNorm === "2");
          const stage2Url = stage2Mismatch ? null : stage2UrlRaw;
          const resultUrlSafe = stage2Mismatch ? null : finalOutputUrl;
          const stagePreview = stage2Url || stage1bUrl || stage1aUrl || null;
          const hasOutputs = !!(stagePreview || resultUrlSafe || it?.imageUrl || it?.image || extraResult?.imageUrl || extraResult?.url);

          // Determine target stage per image (same logic as UI)
          const targetStage: StageKey = (() => {
            if (stage2Expected) return "2";
            if (declutterRequested) return "1B";
            return "1A";
          })();

          const targetUrlPresent = (() => {
            if (targetStage === "2") return !!stage2Url;
            if (targetStage === "1B") return !!stage1bUrl;
            return !!stage1aUrl;
          })();

          let uiStatus = uiStatusRaw || (warnings.length ? 'warning' : 'ok');
          if (blockedStage && hasOutputs) uiStatus = 'warning';

          // Completion requires explicit completed status AND target stage reached
          let completionSource: string = "none";
          let displayUrl: string | null = resultUrlSafe || null;
          if (isRegionEdit) {
            displayUrl =
              toDisplayUrl(it?.imageUrl) ||
              toDisplayUrl(it?.image) ||
              toDisplayUrl(extraResult?.imageUrl) ||
              toDisplayUrl(extraResult?.url) ||
              displayUrl;
            if (displayUrl) completionSource = "region-edit";
          }
          if (!displayUrl) {
            if (stage2Url) {
              displayUrl = stage2Url;
              completionSource = "stage2";
            } else if (stage1bUrl) {
              displayUrl = stage1bUrl;
              completionSource = "stage1b";
            } else if (stage1aUrl) {
              displayUrl = stage1aUrl;
              completionSource = "stage1a";
            } else if (it?.imageUrl || it?.image || extraResult?.imageUrl || extraResult?.url) {
              displayUrl = it?.imageUrl || it?.image || extraResult?.imageUrl || extraResult?.url || null;
              completionSource = "imageUrl_fallback";
            }
          } else {
            completionSource = "resultUrl";
          }

          if (!resultUrlSafe && displayUrl && completionSource !== "resultUrl") {
            console.log('[BATCH][completion_fallback]', { jobId: key, source: completionSource, status, hasResult: !!resultUrlSafe });
          }

          const completedViaFallback =
            status === "completed" &&
            !!displayUrl &&
            !targetUrlPresent &&
            !!(
              blockedStage ||
              fallbackStage ||
              (targetStage === "2" && (resultStageNorm === "1A" || resultStageNorm === "1B"))
            );

          // FIX: mark fallback terminals as complete even when Stage 2 was requested but safely blocked
          const completedFinal = status === "completed" && !!displayUrl && (targetUrlPresent || isRegionEdit || completedViaFallback);
          const completionSourceResolved = isRegionEdit && completedFinal ? "region-edit" : completionSource;
          
          // Log when backend says completed but target not reached (still processing)
          if (status === "completed" && displayUrl && !targetUrlPresent && !isRegionEdit) {
            if (!statusTargetNotReachedLoggedRef.current.has(String(resolvedJobKey || 'unknown'))) {
              statusTargetNotReachedLoggedRef.current.add(String(resolvedJobKey || 'unknown'));
              console.log('[BATCH][target_not_reached]', { jobId: key, status, targetStage, hasStage2: !!stage2Url, hasStage1B: !!stage1bUrl, hasStage1A: !!stage1aUrl, targetPresent: targetUrlPresent });
            }
          }

          // Missing final URL while marked complete is a warning bug surface
          const warningList = (() => {
            const base = warnings.slice();
              if (status === "completed" && !resultUrlSafe) {
                base.push("Image Enhancement didn’t finalise. Please retry image.");
              uiStatus = uiStatus === 'error' ? 'error' : 'warning';
            }
                if (status === "completed" && targetStage === "2" && !stage2Url) {
                  base.push("Staged output is missing for this completed job. Please retry image.");
                  uiStatus = uiStatus === 'error' ? 'error' : 'warning';
                }
                if (stage2Mismatch) {
                  base.push("Staged output present but wasn’t requested.");
                  uiStatus = uiStatus === 'error' ? 'error' : 'warning';
                }
            return base;
          })();

          if (status === "failed") {
            hardFail = true;
            uiStatus = 'error';
          }

          const hasAnyUrl = !!(displayUrl || stagePreview || it?.imageUrl || it?.image || extraResult?.imageUrl || extraResult?.url || resultUrlSafe);
          if (normalizedStatus === "processing" && hasAnyUrl && !statusHasUrlLoggedRef.current.has(String(resolvedJobKey || 'unknown'))) {
            statusHasUrlLoggedRef.current.add(String(resolvedJobKey || 'unknown'));
            console.log('[BATCH][status_unmapped_but_has_url]', { polledId, parentJobId, imageId, rawStatus: pipelineStatusRaw, normalized: normalizedStatus, urlFieldsPresent: { displayUrl: !!displayUrl, stage2Url: !!stage2Url, stage1bUrl: !!stage1bUrl, stage1aUrl: !!stage1aUrl, imageUrl: !!it?.imageUrl, image: !!it?.image, extraResultUrl: !!(extraResult?.imageUrl || extraResult?.url), resultUrl: !!resultUrl } });
          }

          // No downgrades: keep processing/queued/failed/completed as reported
          statusCounts[status] = (statusCounts[status] || 0) + 1;
          const chosenPreview = completedFinal ? displayUrl : (stagePreview || null);

          if (typeof idx === "number") {
            const now = Date.now();
            const activityKey = `${status}|${progress ?? "na"}|${stage1aUrl ? "1" : "0"}|${stage1bUrl ? "1" : "0"}|${stage2Url ? "1" : "0"}|${resultUrlSafe ? "1" : "0"}`;
            const lastActivity = lastActivityByIndexRef.current[idx];
            if (!lastActivity || lastActivity.key !== activityKey) {
              lastActivityByIndexRef.current[idx] = { ts: now, key: activityKey };
            }
            const lastTs = lastActivityByIndexRef.current[idx]?.ts ?? now;
            const ageMs = now - lastTs;
            const hasOnlyStage1A = !!stage1aUrl && !stage1bUrl && !stage2Url && !resultUrlSafe;
            const isQueued = pipelineStatusRaw === "queued" || pipelineStatusRaw === "waiting";
            const uiOverrideFailed = (status === "processing" || isQueued) && hasOnlyStage1A && ageMs >= STUCK_UI_MS;
            if (uiOverrideFailed && !warningList.includes("Enhanced copy of the original is available.")) {
              warningList.push("Enhanced copy of the original is available.");
            }
            const isTerminalNormalized = normalizedStatus === "completed" || normalizedStatus === "failed" || normalizedStatus === "cancelled";
            if (!isTerminalNormalized && !TERMINAL_STATUSES.has(status)) {
              nonTerminalIndices.push(idx);
            }
            if (status === "failed" || completedFinal) {
              reachedTargetOrFailedIndices.add(idx);
            }
            const filename = files[idx]?.name || `image-${idx + 1}`;
            setResults(prev => {
              const copy = prev ? [...prev] : [];
              const existing = copy[idx] || {};
              
              // ✅ PATCH 5: Version timestamp race guard - only accept newer updates
              const incomingVersion = normalizeVersionToTimestamp(
                it?.version ?? it?.updatedAt ?? it?.updated_at
              );
              const existingVersion = normalizeVersionToTimestamp(
                existing.version ?? existing.updatedAt
              );
              
              if (incomingVersion < existingVersion) {
                // Stale update - ignore it
                console.log('[BATCH][version_guard_rejected]', {
                  jobId: polledId || parentJobId,
                  idx,
                  existingVersion,
                  incomingVersion,
                  delta: existingVersion - incomingVersion
                });
                return copy; // Keep existing state
              }
              
              // Persist requestedStages and meta so target-stage completion logic works
              const mergedRequestedStages = requestedStages || existing.requestedStages || existing.result?.requestedStages || null;
              const mergedMeta = {
                ...(existing.meta || {}),
                ...(it?.meta || {}),
              };
              const existingStageMap = existing.stageUrls || existing.result?.stageUrls || existing.stageOutputs || existing.result?.stageOutputs || null;
              const stageUrlsMap = (stageUrls || null) as Record<string, any> | null;
              const existingStageMapObj = (existingStageMap || null) as Record<string, any> | null;
              const mergedStageUrls = (isRetryChildJob || isRegionEdit)
                ? (existingStageMapObj || stageUrlsMap || null)
                : stageUrlsMap
                  ? {
                      ...(existingStageMapObj || {}),
                      ...(stageUrlsMap || {}),
                      '2': stageUrlsMap['2'] || stageUrlsMap.stage2 || existingStageMapObj?.['2'] || existingStageMapObj?.stage2 || null,
                      '1B': stageUrlsMap['1B'] || stageUrlsMap['1b'] || stageUrlsMap.stage1B || existingStageMapObj?.['1B'] || existingStageMapObj?.['1b'] || existingStageMapObj?.stage1B || null,
                      '1A': stageUrlsMap['1A'] || stageUrlsMap['1'] || stageUrlsMap.stage1A || existingStageMapObj?.['1A'] || existingStageMapObj?.['1a'] || existingStageMapObj?.['1'] || existingStageMapObj?.stage1A || null,
                      stage2: stageUrlsMap.stage2 || stageUrlsMap['2'] || existingStageMapObj?.stage2 || existingStageMapObj?.['2'] || null,
                      stage1B: stageUrlsMap.stage1B || stageUrlsMap['1B'] || stageUrlsMap['1b'] || existingStageMapObj?.stage1B || existingStageMapObj?.['1B'] || existingStageMapObj?.['1b'] || null,
                      stage1A: stageUrlsMap.stage1A || stageUrlsMap['1A'] || stageUrlsMap['1'] || existingStageMapObj?.stage1A || existingStageMapObj?.['1A'] || existingStageMapObj?.['1a'] || existingStageMapObj?.['1'] || null,
                    }
                  : (existingStageMapObj || null);
              const mergedResultUrl = resultUrlSafe
                || existing.resultUrl
                || existing.result?.finalOutputUrl
                || existing.result?.resultUrl
                || null;
              const isTerminalStatusForRetry = status === "completed" || status === "failed";
              const polledCurrentStage = normalizeCurrentStage(
                it?.currentStage ||
                it?.current_stage ||
                it?.processingStage ||
                it?.processing_stage ||
                it?.stage ||
                it?.meta?.currentStage ||
                it?.meta?.current_stage ||
                existing.currentStage ||
                existing.result?.currentStage
              );
              copy[idx] = {
                ...existing,
                status,
                progress,
                currentStage: polledCurrentStage || existing.currentStage || null,
                resultStage: resultStage ?? existing.resultStage ?? existing.result?.resultStage ?? null,
                resultUrl: mergedResultUrl,
                finalOutputUrl: mergedResultUrl,
                stageUrls: mergedStageUrls,
                completionSource: completionSourceResolved,
                retryLatestUrl: (isRetryChildJob && completedFinal ? (displayUrl || existing.retryLatestUrl || null) : (existing.retryLatestUrl || null)),
                editLatestUrl: isRegionEdit && completedFinal ? (displayUrl ?? existing.editLatestUrl ?? null) : (existing.editLatestUrl ?? null),
                version: Math.max(incomingVersion, existingVersion), // ✅ Store normalized numeric timestamp
                updatedAt: it?.updatedAt || it?.updated_at || existing.updatedAt,
                imageId: imageId || existing.imageId,
                jobId: polledId || parentJobId || existing.jobId,
                originalUrl: originalUrl || existing.originalUrl,
                originalImageUrl: originalUrl || existing.originalImageUrl || existing.originalUrl,
                filename,
                warnings: warningList,
                uiStatus,
                hardFail,
                uiOverrideFailed,
                requestedStages: mergedRequestedStages,
                meta: mergedMeta,
                // Preserve prior result object but refresh URLs and status fields
                result: {
                  ...(existing.result || {}),
                  imageUrl: completedFinal ? (displayUrl || existing.result?.imageUrl) : (existing.result?.imageUrl || undefined),
                  finalOutputUrl: mergedResultUrl,
                  resultUrl: mergedResultUrl,
                  originalImageUrl: originalUrl || existing.result?.originalImageUrl || existing.result?.originalUrl || existing.originalImageUrl || existing.originalUrl,
                  originalUrl: originalUrl || existing.result?.originalUrl || existing.result?.originalImageUrl || existing.originalUrl || existing.originalImageUrl,
                  stageUrls: mergedStageUrls,
                  requestedStages: mergedRequestedStages,
                  meta: mergedMeta,
                  status,
                  currentStage: polledCurrentStage || existing.result?.currentStage || existing.currentStage || null,
                  resultStage: resultStage ?? existing.result?.resultStage ?? existing.resultStage ?? null,
                  progress,
                  warnings: warningList,
                  uiStatus,
                  hardFail,
                  completionSource: completionSourceResolved,
                  retryLatestUrl: (isRetryChildJob && completedFinal ? (displayUrl || existing.result?.retryLatestUrl || null) : (existing.result?.retryLatestUrl ?? null)),
                  editLatestUrl: isRegionEdit && completedFinal ? (displayUrl ?? existing.result?.editLatestUrl ?? null) : (existing.result?.editLatestUrl ?? null),
                },
                // Preview URL used while processing
                previewUrl: chosenPreview || existing.previewUrl || null,
                // FIX 3: Only show errors for terminal failure states
                error: (status === "failed" || (it.errorCode && isTerminalFlag))
                  ? getDisplayError({ status, error: it.error || it.message || it.errorMessage || existing.error || "Processing failed", progress: it.progress })
                  : (uiOverrideFailed ? (existing.error || "Enhanced copy of the original is available.") : existing.error),
                errorCode: (status === "failed" || (it.errorCode && isTerminalFlag)) ? (it.errorCode || it.error_code || it.meta?.errorCode || existing.errorCode) : undefined,
                blockedStage: blockedStage || existing.blockedStage,
                fallbackStage: fallbackStage || existing.fallbackStage,
                validationNote: validationNote || existing.validationNote,
                retryInFlight: isTerminalStatusForRetry ? undefined : existing.retryInFlight,
                retryStage: isTerminalStatusForRetry ? undefined : existing.retryStage,
              };
              return copy;
            });

            if (isTerminalFlag) {
              retryTerminalIndices.add(idx);
            }

            if (isRegionEdit && completedFinal) {
              clearEditFallbackTimer(idx);
              setEditingImages(prev => {
                const next = new Set(prev);
                next.delete(idx);
                return next;
              });
              setEditCompletedImages(prev => new Set(prev).add(idx));
              if (polledId) regionEditJobIdsRef.current.delete(polledId);
            }

            if (isRegionEdit && status === "failed") {
              clearEditFallbackTimer(idx);
              setEditingImages(prev => {
                const next = new Set(prev);
                next.delete(idx);
                return next;
              });
              if (polledId) regionEditJobIdsRef.current.delete(polledId);
            }

            if (IS_DEV) {
              const stageKeys = stageUrls ? Object.keys(stageUrls).filter(k => (stageUrls as Record<string, any>)[k]) : [];
              console.debug('[BATCH][stage-preview]', {
                jobId: key,
                index: idx,
                status,
                stageKeys,
                resultStage: resultStage || null,
                resultUrl: resultUrl || null,
                chosenPreview: chosenPreview || null,
              });
            }

            if (completedFinal && !processedSetRef.current.has(idx)) {
              processedSetRef.current.add(idx);
              const queueStageUrls = (stageUrls as Record<string, any> | null) || null;
              const queueRequestedStages = requestedStages || null;
              queueRef.current.push({
                index: idx,
                result: {
                  imageUrl: displayUrl,
                  originalImageUrl: originalUrl,
                  qualityEnhancedUrl: null,
                  mode: it.mode || "enhanced",
                  stageUrls: queueStageUrls,
                  imageId,
                  status,
                  resultStage,
                  requestedStages: queueRequestedStages,
                  meta: it?.meta || {},
                },
                jobId: key,
                imageId,
                stageUrls: queueStageUrls,
                requestedStages: queueRequestedStages,
                filename,
              });
            }
          } else {
            const hasAnyUrl = !!(displayUrl || stagePreview || it?.imageUrl || it?.image || extraResult?.imageUrl || extraResult?.url || resultUrl);
            const missingKey = String(resolvedJobKey || polledId || parentJobId || imageId || 'unknown');
            if (!idxMissingLoggedRef.current.has(missingKey)) {
              idxMissingLoggedRef.current.add(missingKey);
              console.log('[BATCH][poll_idx_missing]', {
                polledId,
                parentJobId,
                imageId,
                candidates: { jobId: it?.jobId, id: it?.id, job_id: it?.job_id },
                status: pipelineStatusRaw,
                hasAnyUrl,
                urlsPresent: {
                  resultUrl: !!resultUrl,
                  stage2Url: !!stage2Url,
                  stage1bUrl: !!stage1bUrl,
                  stage1aUrl: !!stage1aUrl,
                  imageUrl: !!it?.imageUrl,
                  image: !!it?.image,
                  extraResultUrl: !!(extraResult?.imageUrl || extraResult?.url)
                }
              });
            }
            if (!isTerminalFlag && !TERMINAL_STATUSES.has(status)) {
              hasUnmappedNonTerminal = true;
            }
          }
        }

        if (retryTerminalIndices.size > 0) {
          setRetryingImages(prev => {
            const next = new Set(prev);
            retryTerminalIndices.forEach((idx) => next.delete(idx));
            return next;
          });
          setRetryLoadingImages(prev => {
            const next = new Set(prev);
            retryTerminalIndices.forEach((idx) => next.delete(idx));
            return next;
          });
        }

        schedule();

        const terminalCount = Object.entries(statusCounts).reduce((acc, [st, count]) => acc + (TERMINAL_STATUSES.has(st) ? count : 0), 0);
        const queuedCount = statusCounts['queued'] || 0;
        const processingCount = statusCounts['processing'] || 0;
        setProgressText(`Processing images: ${terminalCount}/${total} finished`);

        if (IS_DEV) {
          console.debug('[BATCH][poll] status counts', { queued: queuedCount, processing: processingCount, completed, terminal: terminalCount, total });
          if (queuedWithOutputs.length) {
            console.warn('[BATCH][poll] queued-with-outputs', queuedWithOutputs);
          }
          if (errorWithOutputs.length) {
            console.warn('[BATCH][poll] error-with-outputs', errorWithOutputs);
          }
        }

        const allTerminal = items.length > 0 && nonTerminalIndices.length === 0 && !hasUnmappedNonTerminal;
        const serverSignaledDone = !!data.done;

        // ✅ FIX #1: Target-aware completion check
        // Don't stop polling just because backend says "done" - verify all images reached their targets
        const allImagesReachedTargetOrFailed = files.length > 0 && files.every((_, idx) => {
          if (reachedTargetOrFailedIndices.has(idx)) return true;
          const r = results[idx];
          if (!r) return false;
          const status = String(r?.status || "").toLowerCase();
          if (status === "failed") return true;

          const requestedStages = r?.requestedStages || r?.result?.requestedStages || {};
          const sceneLabel = String(r?.meta?.scene?.label || r?.result?.meta?.scene?.label || "").toLowerCase();
          const stagingAllowed = getPerImageStagingAllowed(r);
          const requestedStage2 = requestedStages?.stage2 === true || requestedStages?.stage2 === "true";
          const declutterRequested = getPerImageDeclutterRequested(r);
          const stage2Expected = requestedStage2 && sceneLabel !== "exterior" && stagingAllowed;
          const targetStage: StageKey = stage2Expected ? "2" : declutterRequested ? "1B" : "1A";

          const stageMap = r?.stageUrls || r?.result?.stageUrls || {};
          const stage2Url = stageMap?.['2'] || stageMap?.stage2 || null;
          const stage1BUrl = stageMap?.['1B'] || stageMap?.['1b'] || stageMap?.stage1B || null;
          const stage1AUrl = stageMap?.['1A'] || stageMap?.['1a'] || stageMap?.['1'] || stageMap?.stage1A || null;
          const targetUrlPresent = (
            (targetStage === "2" && !!stage2Url) ||
            (targetStage === "1B" && !!stage1BUrl) ||
            (targetStage === "1A" && !!stage1AUrl)
          );

          const blockedStage = r?.blockedStage || r?.result?.blockedStage || r?.meta?.blockedStage || r?.result?.meta?.blockedStage || null;
          const fallbackStage = r?.fallbackStage ?? r?.result?.fallbackStage ?? r?.meta?.fallbackStage ?? r?.result?.meta?.fallbackStage ?? null;
          const resultStageNorm = String(r?.resultStage || r?.result?.resultStage || r?.finalStage || r?.result?.finalStage || "").toUpperCase();
          const completedViaFallback =
            (status === "completed" || status === "complete") &&
            !targetUrlPresent &&
            !!(stage1AUrl || stage1BUrl || stage2Url) &&
            !!(
              blockedStage ||
              fallbackStage ||
              (targetStage === "2" && (resultStageNorm === "1A" || resultStageNorm === "1B"))
            );
          return ((status === "completed" || status === "complete") && targetUrlPresent) || completedViaFallback;
        });

        // Use target-aware completion instead of blindly trusting serverSignaledDone
        const shouldConsiderStopping = allTerminal || (serverSignaledDone && allImagesReachedTargetOrFailed);

        if (shouldConsiderStopping && !finalRefreshRequested) {
          finalRefreshRequested = true;
          delay = BACKOFF_START_MS;
          if (IS_DEV) {
            console.debug('[BATCH][poll] requesting final refresh before stopping', { allTerminal, allImagesReachedTarget: allImagesReachedTargetOrFailed, serverDone: serverSignaledDone });
          }
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        // ✅ FIX #4: Stale-state self-heal with extended grace for multi-stage items
        // Only apply stuck_queued logic if server says done AND items haven't reached their targets
        if (serverSignaledDone && !shouldConsiderStopping) {
          if (doneSeenAt === null) {
            doneSeenAt = Date.now();
            if (IS_DEV) {
              console.warn('[BATCH][poll] server done but images haven\'t reached targets; extending polling', { nonTerminalIndices, hasUnmappedNonTerminal, allImagesReachedTarget: allImagesReachedTargetOrFailed });
            }
          }
          const waited = Date.now() - doneSeenAt;
          
          // Extended grace period for multi-stage items: 45 seconds instead of 15
          const MULTI_STAGE_GRACE_MS = 45_000;
          const graceMs = MULTI_STAGE_GRACE_MS;
          
          if (waited >= graceMs) {
            if (nonTerminalIndices.length) {
              // Don't mark as stuck_queued if items:
              // 1. Have partial outputs (still progressing through pipeline)
              // 2. Haven't reached their target stage yet (legitimately processing)
              const trulyStuckIndices: number[] = [];
              for (const idx of nonTerminalIndices) {
                const existing = results[idx] || {};
                const hasPartialOutputs = !!(existing.stageUrls?.['1A'] || existing.stageUrls?.stage1A || existing.stageUrls?.['1B'] || existing.stageUrls?.stage1B || existing.stageUrls?.['2'] || existing.stageUrls?.stage2);
                
                // Check if item is legitimately in multi-stage pipeline
                const requestedStages = existing?.requestedStages || existing?.result?.requestedStages || {};
                const sceneLabel = String(existing?.meta?.scene?.label || existing?.result?.meta?.scene?.label || "").toLowerCase();
                const stagingAllowed = getPerImageStagingAllowed(existing);
                const requestedStage2 = requestedStages?.stage2 === true || requestedStages?.stage2 === "true";
                const stage2Expected = requestedStage2 && sceneLabel !== "exterior" && stagingAllowed;
                const isMultiStageItem = stage2Expected || requestedStages?.stage1b;
                
                // Only mark as stuck if: no outputs AND not a multi-stage item, OR has been waiting too long
                const waitedTooLong = waited >= (5 * 60 * 1000); // 5 minutes absolute max
                const shouldMarkStuck = (!hasPartialOutputs && !isMultiStageItem) || waitedTooLong;
                
                if (shouldMarkStuck) {
                  trulyStuckIndices.push(idx);
                }
              }
              if (trulyStuckIndices.length > 0) {
                setResults(prev => {
                  const copy = prev ? [...prev] : [];
                  for (const idx of trulyStuckIndices) {
                    const existing = copy[idx] || {};
                    copy[idx] = {
                      ...existing,
                      status: 'failed',
                      error: existing.error || 'stuck_queued',
                      errorCode: 'stuck_queued',
                    } as any;
                    processedSetRef.current.add(idx);
                  }
                  return copy;
                });
                setProgressText(`Marked ${trulyStuckIndices.length} item(s) as stuck. You can retry them.`);
                if (IS_DEV) {
                  console.warn('[BATCH][poll] marking stuck queued items as failed', { trulyStuckIndices, skippedDueToPartialOutputs: nonTerminalIndices.filter(i => !trulyStuckIndices.includes(i)) });
                }
              }
            }
          } else {
            // Still within grace period - continue polling
            delay = BACKOFF_START_MS;
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
        }

        // ✅ FIX #1: Only stop polling when all images reached targets OR truly stuck
        if (shouldConsiderStopping) {
          if (IS_DEV) {
            console.debug('[BATCH][poll] stopping — all items reached targets or failed', { allTerminal, allImagesReachedTarget: allImagesReachedTargetOrFailed, nonTerminalIndices, hasUnmappedNonTerminal });
          }
          setRunState("done");
          setAbortController(null);
          await refreshUser();
          setProgressText(`Batch complete! ${terminalCount} images finished.`);
          clearBatchJobState(currentUserId);
          return;
        }

        delay = Math.max(BACKOFF_START_MS, Math.floor(delay / BACKOFF_FACTOR));
      } catch (e:any) {
        if (e.name === 'AbortError') return;
        delay = Math.min(BACKOFF_MAX_MS, Math.floor(delay * BACKOFF_FACTOR));
      }
      await new Promise(r => setTimeout(r, delay));
    }
    clearBatchJobState(currentUserId);
  };

  // Helper: start polling a single region-edit job via the global batch status endpoint
  const startRegionEditPolling = async (jobId: string, imageIndex: number) => {
    console.log('[BatchProcessor] startRegionEditPolling', { jobId, imageIndex });
    regionEditJobIdsRef.current.add(jobId);

    // Map this jobId to the relevant image index so pollForBatch knows where to route results
    jobIdToIndexRef.current[jobId] = imageIndex;

    const controller = new AbortController();
    setAbortController(controller);

    try {
      await pollForBatch([jobId], controller);
    } finally {
      // Polling lifecycle ended for this job
      regionEditJobIdsRef.current.delete(jobId);
      setIsEditingInProgress(false);
    }
  };

  // Legacy per-id polling fallback if /api/status/batch is unavailable
  const pollForBatchLegacy = async (ids: string[], controller: AbortController) => {
    const MAX_POLL_MS = 45 * 60 * 1000;
    const BACKOFF_START_MS = 1000, BACKOFF_MAX_MS = 5000, BACKOFF_FACTOR = 1.5;
    let delay = BACKOFF_START_MS; const deadline = Date.now() + MAX_POLL_MS;
    if (currentUserId) localStorage.setItem(makeActiveKey(currentUserId), JSON.stringify(ids));
    while (Date.now() < deadline) {
      if (controller.signal.aborted) return;
      try {
        const items: any[] = [];
        for (const id of ids) {
          const res = await fetch(api(`/api/status/${encodeURIComponent(id)}`), {
            method: "GET", credentials: "include", headers: { ...withDevice().headers, "Cache-Control": "no-cache" }, signal: controller.signal
          });
          if (!res.ok) continue;
          const j = await res.json();
          // Map to minimal shape expected by UI
          const st = j?.status || j?.state;
          const status = st === 'complete' || st === 'succeeded' ? 'completed' : st === 'error' || st === 'failed' ? 'failed' : 'processing';
          items.push({ id, status, imageUrl: j?.result?.imageUrl });
        }
        const completed = items.filter(i=>i.status==='completed').length;
        setProgressText(`Processing images: ${completed}/${ids.length} completed`);
        for (const it of items) {
          const idx = jobIdToIndexRef.current[it.id];
          if (typeof idx === 'number' && it.status === 'completed' && !processedSetRef.current.has(idx)) {
            processedSetRef.current.add(idx);
            queueRef.current.push({ index: idx, result: { imageUrl: it.imageUrl || null, mode: 'enhanced' }, jobId: it.id, filename: files[idx]?.name || `image-${idx+1}` });
          }
          if (typeof idx === 'number' && it.status === 'failed' && !processedSetRef.current.has(idx)) {
            processedSetRef.current.add(idx);
            queueRef.current.push({ index: idx, error: 'Processing failed', jobId: it.id, filename: files[idx]?.name || `image-${idx+1}` });
          }
        }
        schedule();
        if (completed === ids.length) {
          setRunState('done'); setAbortController(null); await refreshUser();
          clearBatchJobState(currentUserId);
          return;
        }
        delay = Math.max(BACKOFF_START_MS, Math.floor(delay / BACKOFF_FACTOR));
      } catch (e:any) {
        if (e.name === 'AbortError') return;
        delay = Math.min(BACKOFF_MAX_MS, Math.floor(delay * BACKOFF_FACTOR));
      }
      await new Promise(r=>setTimeout(r, delay));
    }
    clearBatchJobState(currentUserId);
  };

  // Cancel entire batch: abort client polling and notify server to cancel queued jobs
  const cancelBatchProcessing = async () => {
    const activeClientBatchId = clientBatchIdRef.current || clientBatchId || undefined;
    const ids = cancelIds.length ? cancelIds : jobIds;
    try {
      if (activeClientBatchId) {
        await fetch(api('/api/batch/cancel'), withDevice({
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batchId: activeClientBatchId }),
          signal: AbortSignal.timeout(15_000)
        }));
      } else if (ids.length) {
        // AUDIT FIX: added timeout to prevent hung cancel requests
        await fetch(api('/api/jobs/cancel-batch'), withDevice({
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
          signal: AbortSignal.timeout(15_000)
        }));
      }
      console.log('[BATCH_CANCELLED]', { batchId: activeClientBatchId || null, ids: ids.length });
      resetBatchState('images');
      toast({ title: 'Enhancement cancelled', description: ids.length ? `Requested cancel for ${ids.length} job(s).` : 'Stopped polling.' });
    } catch (e: any) {
      // Even if server cancel fails, clear local state to avoid stuck UI
      console.warn('[BATCH_CANCELLED] server cancel failed', e);
      resetBatchState('images');
      toast({ title: 'Cancelled locally; some jobs may still complete', description: e?.message || 'Unable to cancel batch on server', variant: 'destructive' });
    }
  };


  const startBatchProcessing = async () => {
    // Guard: no files, no spin
    if (!files.length) {
      toast({ title: "No images selected", description: "Add images before starting enhancement.", variant: "destructive" });
      console.info("[ENHANCE_CLICK] blocked:no_files");
      return;
    }

    // Block start when required inputs are missing
    if (blockingIndices.length) {
      const humanList = blockingIndices.map(i => i + 1).join(", ");
      toast({
        title: "Complete required settings",
        description: `Please fill Scene Type${allowStaging ? " and Room Type" : ""} for image(s): ${humanList}.`,
        variant: "destructive"
      });
      setActiveTab("images");
      setCurrentImageIndex(blockingIndices[0]);
      return;
    }

    const totalCreditsNeeded = requiredBatchCredits;

    const latestSummary = await refreshCreditSummary();
    const latestAvailable = latestSummary?.availableCredits ?? availableCredits;
    if (latestAvailable !== null && totalCreditsNeeded > latestAvailable) {
      openCreditGateModal(totalCreditsNeeded, latestAvailable);
      return;
    }
    
    try {
      // Ensure signed in AND have enough credits (handles both in one call)
      await ensureLoggedInAndCredits(totalCreditsNeeded);
    } catch (e: any) {
      if (e.code === "INSUFFICIENT_CREDITS") {
        const available = Number.isFinite(e.availableCredits)
          ? Number(e.availableCredits)
          : Math.max(0, Number(availableCredits ?? 0));
        openCreditGateModal(totalCreditsNeeded, available);
        return;
      }
      toast({ title: "Cannot start", description: e.message || "Sign in and try again.", variant: "destructive" });
      console.error("[ENHANCE_REQUEST] credits/auth failed", e);
      return;
    }

    // Start SSE batch processing
    setRunState("running");
    // Pre-size results array with queued placeholders to avoid flicker to error
    setResults(Array.from({ length: files.length }, (_, idx) => ({ index: idx, status: 'queued' })) as any);
    setProgressText("");
    setJobId("");
    setJobIds([]);
    setProcessedImages([]);
    setProcessedImagesByIndex({});
    setDisplayStageByIndex({});
    processedSetRef.current.clear(); // Reset processed tracking for new batch
    
    // Create abort controller for cleanup
    const controller = new AbortController();
    setAbortController(controller);
    
  const fd = new FormData();
    files.forEach(f => fd.append("images", f));
    
    // Use shared industry mapping from component scope
    const goalToSend = globalGoal.trim() || "General, realistic enhancement for the selected industry.";
    fd.append("goal", goalToSend);
    fd.append("industry", industryMap[presetKey] || "Real Estate");
    fd.append("preserveStructure", "true");
    fd.append("allowStaging", allowStaging.toString());
    fd.append("stagingStyle", allowStaging ? stagingStyle : "");
    fd.append("allowRetouch", "true");
    fd.append("furnitureReplacement", furnitureReplacement.toString());
    fd.append("declutter", declutter.toString());
    const declutterMode = declutter && allowStaging ? "stage-ready" : "light";
    if (declutter) {
      fd.append("declutterMode", declutterMode);
      console.log("[upload] UI sending options:", { declutter, declutterMode, allowStaging });
    }
    const stage2Only = allowStaging && !declutter;
    const stage2Variant: "2A" | "2B" | undefined = (() => {
      if (!allowStaging) return undefined;
      if (declutter) return "2A";
      return "2B";
    })();

    if (IS_DEV && declutter) {
      console.assert(!!declutterMode, "[DEV_ASSERT] declutterMode must be non-null when declutter is enabled");
    }

    const activeClientBatchId = clientBatchIdRef.current || (() => {
      const gen = `client-batch-${Date.now()}`;
      clientBatchIdRef.current = gen;
      setClientBatchId(gen);
      return gen;
    })();

    console.log("[BATCH] start payload", {
      clientBatchId: activeClientBatchId,
      batchId: "pending",
      stage2Only,
      allowStaging,
      declutter,
      files: files.length,
    });
    if (stage2Variant) {
      fd.append("stage2Variant", stage2Variant);
    }
    fd.append("stage2Only", stage2Only.toString());
    fd.append("outdoorStaging", outdoorStaging);
    if (propertyAddress.trim()) {
      fd.append("propertyAddress", propertyAddress.trim());
    }
    // NEW: Manual room linking metadata
    fd.append("metaJson", metaJson);
    
    try {
      setIsUploading(true);
      console.info("[ENHANCE_REQUEST] sending", {
        files: files.length,
        allowStaging,
        declutter,
        declutterMode,
        stage2Variant,
        stage2Only,
      });
      console.log("[ENHANCE_REQUEST] image payload preview", {
        stage2Variant,
        declutterMode,
        stage2Only,
        stagesSelected: { stage1A: true, stage1B: declutter, stage2: allowStaging },
      });
      // Phase 1: Start batch processing with files
      const uploadOnce = async () => fetch(api("/api/upload"), {
        method: "POST",
        body: fd,
        credentials: "include",
        headers: withDevice().headers,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
      });

      let uploadResp: Response;
      try {
        uploadResp = await uploadOnce();
      } catch (uploadErr: any) {
        const message = String(uploadErr?.message || "").toLowerCase();
        const transient = message.includes("failed to fetch") || message.includes("network") || message.includes("timeout") || uploadErr?.name === "TimeoutError";
        if (!transient) throw uploadErr;
        console.warn("[ENHANCE_REQUEST] transient upload error, retrying once", uploadErr);
        uploadResp = await uploadOnce();
      }

      if (!uploadResp.ok) {
        setIsUploading(false);
        setRunState("idle");
        if (uploadResp.status === 401 || uploadResp.status === 403) {
          handleAuthFailure();
          toast({ title: "Login required", description: "Login and retry to start enhancement.", variant: "destructive" });
          return;
        }
        const err = await uploadResp.json().catch(() => ({}));
        if (uploadResp.status === 402 && err?.code === "QUOTA_EXCEEDED") {
          showQuotaExceededToast();
          return;
        }
        if (uploadResp.status === 402 && err?.code === "INSUFFICIENT_CREDITS") {
          const required = Number.isFinite(err?.requiredCredits) ? Number(err.requiredCredits) : totalCreditsNeeded;
          const available = Number.isFinite(err?.availableCredits) ? Number(err.availableCredits) : Math.max(0, Number(availableCredits ?? 0));
          openCreditGateModal(required, available);
          return;
        }
        console.error("[ENHANCE_REQUEST] failed", err);
        toast({ title: "Upload failed", description: err.message || "Failed to upload files", variant: "destructive" });
        return;
      }

      const uploadResult = await uploadResp.json();
      setIsUploading(false);
      const jobs = Array.isArray(uploadResult.jobs) ? uploadResult.jobs : [];
      if (!jobs.length) throw new Error("Upload response missing jobs");
      const ids = jobs.map((j:any)=>j.jobId).filter(Boolean);
      console.info("[ENHANCE_REQUEST] ok", { jobs: ids.length });
      console.log("[BATCH] start", {
        clientBatchId: activeClientBatchId,
        batchId: ids[0] || "unknown",
        allowStaging,
        declutter,
        stage2Only,
      });
      setJobIds(ids);
      setCancelIds(ids);
      if (currentUserId) {
        localStorage.setItem(makeActiveKey(currentUserId), JSON.stringify(ids));
        localStorage.setItem("activeJobId", ids[0]);
      }
      jobIdToIndexRef.current = {};
      imageIdToIndexRef.current = {};
      jobIdToImageIdRef.current = {};
      jobs.forEach((j:any, i:number) => {
        jobIdToIndexRef.current[j.jobId] = i;
        jobIdToImageIdRef.current[j.jobId] = j.imageId;
        if (j.imageId) imageIdToIndexRef.current[j.imageId] = i;
      });
      
      // Phase 2: Poll multi-job status
      await pollForBatch(ids, controller);
      
    } catch (error: any) {
      setIsUploading(false);
      setRunState("idle");
      setProgressText("");
      setAbortController(null);
      if (error.name !== 'AbortError') {
        console.error("[ENHANCE_REQUEST] failed", error);
        toast({ title: "Start failed", description: error.message || "Failed to start batch processing", variant: "destructive" });
        return;
      }
    }
  };

  const downloadZip = async () => {
    // Check if we have processed images from batch processing
    if (processedImages.length === 0) {
      toast({ 
        title: "No Images Available", 
        description: "No processed images available for download.",
        variant: "destructive"
      });
      return;
    }
    
    // Prevent double downloads
    if (isDownloadingZip) {
      return;
    }
    
    setIsDownloadingZip(true);
    
    try {
      // Import JSZip dynamically for client-side ZIP creation
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      
      // Get current displayed images (includes edits) - use same logic as gallery display
      const imagesToDownload: { url: string; filename: string }[] = [];
      
      for (let i = 0; i < results.length; i++) {
        // Prefer safe (non-failed) stage URLs; fall back to stored processed URLs only if safe
        const safe = resolveSafeStageUrl(results[i]);
        const imageUrl = safe.url || processedImagesByIndex[i] || null;
        
        if (imageUrl) {
          // Generate filename - use original file name if available, otherwise generate one
          let filename: string;
          if (files[i]?.name) {
            const originalName = files[i].name;
            const baseName = originalName.replace(/\.[^/.]+$/, ""); // Remove extension
            const extension = originalName.includes('.') ? originalName.split('.').pop() : 'jpg';
            filename = `enhanced_${baseName}.${extension}`;
          } else {
            // Fallback for persisted batches or when files array doesn't match
            const extension = imageUrl.includes('.png') ? 'png' : 'jpg';
            filename = `enhanced_image_${i + 1}.${extension}`;
          }
          
          imagesToDownload.push({
            url: imageUrl,
            filename: filename
          });
        }
      }
      
      if (imagesToDownload.length === 0) {
        toast({ 
          title: "No Images Available", 
          description: "No enhanced images found for download.",
          variant: "destructive"
        });
        return;
      }
      
      // Download each image and add to ZIP
      for (const item of imagesToDownload) {
        try {
          let imageBuffer: ArrayBuffer;
          
          if (item.url.startsWith('data:')) {
            // Handle data URLs (base64 encoded images)
            const base64Data = item.url.split(',')[1];
            imageBuffer = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0)).buffer;
          } else {
            // Handle regular URLs
            // AUDIT FIX: added timeout to prevent hung blob downloads
            const response = await fetch(item.url, { signal: AbortSignal.timeout(30_000) });
            if (!response.ok) {
              console.warn(`Failed to fetch image: ${item.url}`, response.status);
              continue;
            }
            imageBuffer = await response.arrayBuffer();
          }
          
          zip.file(item.filename, imageBuffer);
        } catch (error) {
          console.warn(`Failed to process image ${item.filename}:`, error);
          // Continue with other images even if one fails
        }
      }
      
      // Generate ZIP file
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      
      // Download the ZIP
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `enhanced-images-${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      
      toast({ 
        title: "Download Complete", 
        description: `ZIP file downloaded successfully with ${imagesToDownload.length} images.`
      });
    } catch (error) {
      console.error("Download error:", error);
      toast({ 
        title: "Download Failed", 
        description: "Failed to create ZIP file. Please try again.",
        variant: "destructive"
      });
    } finally {
      setIsDownloadingZip(false);
    }
  };

  const handleStartEnhance = () => {
    const declutterMode = declutter && allowStaging ? "stage-ready" : "light";
    console.info("[ENHANCE_CLICK] start", {
      count: files.length,
      allowStaging,
      declutter,
      declutterMode,
      clientBatchId,
    });

    if (!files.length) {
      toast({ title: "No images selected", description: "Add images before starting enhancement.", variant: "destructive" });
      return;
    }

    if (isEnhanceCreditBlocked) {
      openCreditGateModal(requiredBatchCredits, Math.max(0, Number(availableCredits ?? 0)));
      return;
    }

    setActiveTab("enhance");
    startBatchProcessing();
  };

  const handleRetryFailed = async () => {
    // Only treat images as failed if they have a real error (not validator-failed)
    const failedImages = results.filter(r => r && r.error && r.error !== 'validator_failed');
    if (failedImages.length === 0) {
      toast({ title: "No Failed Images", description: "All images processed successfully.", variant: "default" });
      return;
    }

    // Get the indices of failed images to retry with original files
    const failedIndices = failedImages.map(r => r.index);
    const filesToRetry = failedIndices.map(i => files[i]).filter(Boolean);
    
    if (filesToRetry.length === 0) {
      alert("Cannot retry: original files not available");
      return;
    }

    try {
      // Ensure user has sufficient credits
      await ensureLoggedInAndCredits(filesToRetry.length);
    } catch (e: any) {
      alert(e.message || "Unable to retry - please sign in and try again.");
      return;
    }

    // Retry with same settings
    setRunState("running");
    const fd = new FormData();
    filesToRetry.forEach(f => fd.append("images", f));
    
    const goalToSend = globalGoal.trim() || "General, realistic enhancement for the selected industry.";
    fd.append("goal", goalToSend);
    
    fd.append("industry", industryMap[presetKey] || "Real Estate");
    fd.append("preserveStructure", "true");
    fd.append("allowStaging", allowStaging.toString());
    fd.append("stagingStyle", allowStaging ? stagingStyle : "");
    fd.append("allowRetouch", "true");
    fd.append("furnitureReplacement", furnitureReplacement.toString());
    if (propertyAddress.trim()) {
      fd.append("propertyAddress", propertyAddress.trim());
    }
    // Manual room linking metadata (for retry)
    fd.append("metaJson", metaJson);

    try {
      // AUDIT FIX: added timeout to prevent hung retry upload
      const res = await fetch(api("/api/upload"), withDevice({
        method: "POST",
        body: fd,
        credentials: "include",
        signal: AbortSignal.timeout(60_000)
      }));
      
      if (!res.ok) {
        setRunState("done");
        if (res.status === 402) {
          const err = await res.json().catch(() => ({}));
          if (err?.code === "QUOTA_EXCEEDED") {
            showQuotaExceededToast();
            return;
          }
          if (err?.code === "INSUFFICIENT_CREDITS") {
            const required = Number.isFinite(err?.requiredCredits) ? Number(err.requiredCredits) : filesToRetry.length;
            const available = Number.isFinite(err?.availableCredits) ? Number(err.availableCredits) : Math.max(0, Number(availableCredits ?? 0));
            openCreditGateModal(required, available);
            return;
          }
        }
        alert("Failed to retry batch processing");
        return;
      }
      
      const data = await res.json();
      
      // Handle synchronous response - no jobId needed, results are immediate
      if (data.results) {
        // Merge retry results with existing results
        const updatedResults = [...results];
        data.results.forEach((retryResult: any) => {
          const originalIndex = retryResult.index;
          if (originalIndex >= 0 && originalIndex < updatedResults.length) {
            updatedResults[originalIndex] = retryResult;
          }
        });
        setResults(updatedResults);
        setRunState("done");
        toast({ 
          title: "Retry Complete", 
          description: `Retried ${filesToRetry.length} images. Used ${data.creditsUsed || 0} credits.`
        });
        return;
      }
      
      // Fallback: if no immediate results, something went wrong
      setRunState("done");
      alert("Retry completed but results were not returned properly");
    } catch (error: any) {
      setRunState("done");
      alert(error.message || "Failed to retry batch processing");
    }
  };

  // Retry dialog handlers
  const handleOpenRetryDialog = (imageIndex: number) => {
    setRetryDialog({ isOpen: true, imageIndex });
  };

  const handleCloseRetryDialog = () => {
    setRetryDialog({ isOpen: false, imageIndex: null });
  };

  const handleRetrySubmit = async (
    customInstructions: string,
    sceneType: "auto" | "interior" | "exterior",
    roomType?: string,
    referenceImage?: File
  ) => {
    if (retryDialog.imageIndex === null) return;
    
    const imageIndex = retryDialog.imageIndex;
    
    // Close dialog immediately and start retry process
    handleCloseRetryDialog();
    
    try {
      // Determine what stage the user is currently viewing
      const res = results[imageIndex];
      const stageMap = res?.stageUrls || res?.result?.stageUrls || res?.stageOutputs || res?.result?.stageOutputs || {};
      const requestedStages = res?.requestedStages || res?.result?.requestedStages || res?.meta?.requestedStages || null;
      const requestedStage2 = requestedStages?.stage2 === true || requestedStages?.stage2 === "true";
      const stage1BWasRequested = !!requestedStages?.stage1b
        || (typeof requestedStages?.declutter === "boolean" ? requestedStages.declutter : false)
        || !!res?.options?.declutter
        || !!res?.result?.options?.declutter;
      const blockedStage = (res?.validation as any)?.blockedStage || (res?.result?.validation as any)?.blockedStage || res?.blockedStage || res?.result?.blockedStage || res?.meta?.blockedStage || null;
      const statusRaw = String(res?.status || res?.result?.status || "").toLowerCase();
      const selectedOutput = displayStageByIndex[imageIndex];
      const viewingStage: StageKey | null = (selectedOutput === "1A" || selectedOutput === "1B" || selectedOutput === "2")
        ? selectedOutput
        : (() => {
        const s2 = stageMap?.['2'] || stageMap?.stage2 || null;
        const s1b = stageMap?.['1B'] || stageMap?.['1b'] || stageMap?.stage1B || null;
        const s1a = stageMap?.['1A'] || stageMap?.['1a'] || stageMap?.['1'] || stageMap?.stage1A || null;
        if (s2) return "2" as StageKey;
        if (s1b) return "1B" as StageKey;
        if (s1a) return "1A" as StageKey;
        return null;
      })();

      // Preserve Stage 2 retry intent when Stage 2 was requested but no Stage 2 URL exists yet.
      const forceStage2Retry = requestedStage2 && (blockedStage === "2" || statusRaw === "failed" || viewingStage !== "2");
      const retryContextStage: StageKey | null = forceStage2Retry ? "2" : viewingStage;
      const hasStage1BBaseline = !!(stageMap?.['1B'] || stageMap?.['1b'] || stageMap?.stage1B);
      const hasStage1ABaseline = !!(stageMap?.['1A'] || stageMap?.['1a'] || stageMap?.['1'] || stageMap?.stage1A);
      
      const retryLatestUrl =
        toDisplayUrl(res?.retryLatestUrl) ||
        toDisplayUrl(res?.result?.retryLatestUrl) ||
        null;
      const editLatestUrl =
        toDisplayUrl(res?.editLatestUrl) ||
        toDisplayUrl(res?.result?.editLatestUrl) ||
        null;
      const originalUploadUrl =
        toDisplayUrl(res?.originalImageUrl) ||
        toDisplayUrl(res?.result?.originalImageUrl) ||
        toDisplayUrl(res?.originalUrl) ||
        toDisplayUrl(res?.result?.originalUrl) ||
        null;

      // Compute baseline and stages using latest successful artifact order.
      const baseline = computeRetryBaseline(retryContextStage, stageMap, {
        retryLatestUrl,
        editLatestUrl,
        originalUploadUrl,
      });

      // Backend contract: if Stage 1B was part of the requested pipeline, Stage 2 retry requires Stage 1B baseline.
      // When that baseline is missing, request 1B regeneration first (with staging enabled) instead of invalid 2-only retry.
      const requiresStage1BRebuild = forceStage2Retry && stage1BWasRequested && !hasStage1BBaseline;
      const canUseStage1AForStage2Retry = forceStage2Retry && hasStage1ABaseline && (!stage1BWasRequested || requiresStage1BRebuild);

      const stage1BBaseline =
        stageMap?.['1B'] ||
        stageMap?.['1b'] ||
        stageMap?.stage1B ||
        null;
      const stage1ABaseline =
        stageMap?.['1A'] ||
        stageMap?.['1a'] ||
        stageMap?.['1'] ||
        stageMap?.stage1A ||
        null;

      const requestedStagesList: StageKey[] = (() => {
        const out: StageKey[] = [];
        if (requestedStages?.stage1a === true || requestedStages?.stage1a === "true") out.push("1A");
        if (requestedStages?.stage1b) out.push("1B");
        if (requestedStages?.stage2 === true || requestedStages?.stage2 === "true") out.push("2");
        return out;
      })();

      const hasAnyStageBaseline = !!(stage1BBaseline || stage1ABaseline);
      const isFullPipelineFallback = !hasAnyStageBaseline;

      // Preserve pipeline intent for retry: compute remaining stages from baseline context.
      // If Stage 2 was originally requested but no stage baseline exists, restart the full requested pipeline.
      const effectiveStagesToRun: StageKey[] = forceStage2Retry && !hasAnyStageBaseline
        ? (requestedStagesList.length ? requestedStagesList : ["1A", "1B", "2"])
        : baseline.stagesToRun;
      const effectiveAllowStaging = effectiveStagesToRun.includes("2") || baseline.allowStaging;
      const effectiveSourceUrl = baseline.sourceUrl;
      const effectiveSourceStageLabel = baseline.sourceStageLabel;
      
      console.log("[RETRY] Context-aware retry:", {
        imageIndex,
        viewingStage,
        retryContextStage,
        forceStage2Retry,
        requiresStage1BRebuild,
        canUseStage1AForStage2Retry,
        isFullPipelineFallback,
        stage1BWasRequested,
        hasStage1BBaseline,
        hasStage1ABaseline,
        requestedStage2,
        blockedStage,
        baselineStage: baseline.baselineStage,
        stagesToRun: effectiveStagesToRun,
        allowStaging: effectiveAllowStaging,
        sourceUrl: effectiveSourceUrl?.substring(0, 60),
        sourceStageLabel: effectiveSourceStageLabel,
      });

      // Determine the retryStage to send (highest stage in the pipeline)
      const highestStage = effectiveStagesToRun[effectiveStagesToRun.length - 1];

      // Optimistic UI: flip to Retrying immediately when modal closes
      setRetryingImages(prev => new Set(prev).add(imageIndex));
      setRetryLoadingImages(prev => new Set(prev).add(imageIndex));
      setResults(prev => prev.map((r, i) => {
        if (i !== imageIndex) return r;
        return {
          ...r,
          status: "processing",
          error: null,
          errorCode: undefined,
          uiStatus: "ok",
          uiOverrideFailed: false,
          retryInFlight: true,
          retryStage: highestStage,
          currentStage: highestStage,
        };
      }));
      
      await handleRetryImage(
        imageIndex,
        customInstructions,
        sceneType,
        effectiveAllowStaging,
        false, // furnitureReplacementMode
        roomType,
        undefined, // windowCount
        referenceImage,
        highestStage, // retryStage: tells the server which stage to produce
        effectiveSourceUrl, // baselineUrl: correct upstream image
        effectiveSourceStageLabel, // sourceStageLabel: for server metadata
        stage1BWasRequested, // backend needs this to validate stage2-only retry policy
        effectiveStagesToRun,
        requestedStagesList,
        baseline.baselineStage
      );
    } catch (error) {
      // Error is already handled in handleRetryImage
    }
  };

  // Resolve the best available enhanced output for a given result and optional user-selected stage
  const resolveBestStageOutput = (
    result: any,
    selectedStage?: DisplayOutputKey | null,
    originalFallback?: string | null,
    stageFallback?: { stage2?: string | null; stage1B?: string | null; stage1A?: string | null }
  ): { stage: StageKey | null; url: string | null } => {
    const stageMap = result?.stageUrls || result?.result?.stageUrls || result?.stageOutputs || result?.result?.stageOutputs || {};
    const finalResultUrl =
      toDisplayUrl(result?.finalOutputUrl) ||
      toDisplayUrl(result?.result?.finalOutputUrl) ||
      toDisplayUrl(result?.resultUrl) ||
      toDisplayUrl(result?.result?.resultUrl) ||
      null;
    const editLatestUrl = toDisplayUrl(result?.editLatestUrl) || toDisplayUrl(result?.result?.editLatestUrl) || null;
    const isRegionEdit =
      result?.completionSource === "region-edit" ||
      result?.result?.completionSource === "region-edit" ||
      String(result?.meta?.type || "").toLowerCase() === "region-edit" ||
      String(result?.meta?.jobType || "").toLowerCase() === "region_edit";
    const stage2Url = toDisplayUrl(stageMap?.['2']) || toDisplayUrl(stageMap?.[2]) || toDisplayUrl(stageMap?.stage2) || toDisplayUrl(result?.stage2Url) || toDisplayUrl(result?.result?.stage2Url) || toDisplayUrl(stageFallback?.stage2) || null;
    const stage1BUrl = toDisplayUrl(stageMap?.['1B']) || toDisplayUrl(stageMap?.['1b']) || toDisplayUrl(stageMap?.stage1B) || toDisplayUrl(stageFallback?.stage1B) || null;
    const stage1AUrl = toDisplayUrl(stageMap?.['1A']) || toDisplayUrl(stageMap?.['1a']) || toDisplayUrl(stageMap?.['1']) || toDisplayUrl(stageMap?.stage1A) || toDisplayUrl(stageFallback?.stage1A) || null;
    const originalUrl = toDisplayUrl(result?.originalImageUrl) || toDisplayUrl(result?.result?.originalImageUrl) || toDisplayUrl(result?.originalUrl) || toDisplayUrl(result?.result?.originalUrl) || toDisplayUrl(originalFallback) || null;

    if (isRegionEdit && !selectedStage) {
      if (editLatestUrl) return { stage: null, url: editLatestUrl };
      if (finalResultUrl) return { stage: null, url: finalResultUrl };
    }

    if (selectedStage === "edited" && editLatestUrl) return { stage: null, url: editLatestUrl };

    if (selectedStage === "2" && stage2Url) return { stage: "2", url: stage2Url };
    if (selectedStage === "1B" && stage1BUrl) return { stage: "1B", url: stage1BUrl };
    if (selectedStage === "1A" && stage1AUrl) return { stage: "1A", url: stage1AUrl };

    if (finalResultUrl) return { stage: null, url: finalResultUrl };
    if (stage2Url) return { stage: "2", url: stage2Url };
    if (stage1BUrl) return { stage: "1B", url: stage1BUrl };
    if (stage1AUrl) return { stage: "1A", url: stage1AUrl };
    if (originalUrl) return { stage: null, url: originalUrl };

    return { stage: null, url: null };
  };

  const mapStageToEditSource = (stage: StageKey | null | undefined): EditSourceStage | null => {
    if (stage === "2") return "stage2";
    if (stage === "1B") return "stage1B";
    if (stage === "1A") return "stage1A";
    return null;
  };

  const resolveDisplayedStageForEdit = useCallback((imageIndex: number): StageKey | null => {
    const selected = displayStageByIndex[imageIndex] as DisplayOutputKey | undefined;
    if (selected === "2" || selected === "1B" || selected === "1A") return selected;
    if (selected === "retried" || selected === "edited") return null;

    // Match UI default display stage when user hasn't explicitly selected a tab.
    const item = results[imageIndex];
    if (!item) return null;
    const stageMap = item?.stageUrls || item?.result?.stageUrls || item?.stageOutputs || item?.result?.stageOutputs || {};
    const stage2Url =
      toDisplayUrl(stageMap?.["2"]) ||
      toDisplayUrl(stageMap?.[2]) ||
      toDisplayUrl(stageMap?.stage2) ||
      toDisplayUrl(item?.stage2Url) ||
      toDisplayUrl(item?.result?.stage2Url) ||
      null;
    const stage1BUrl =
      toDisplayUrl(stageMap?.["1B"]) ||
      toDisplayUrl(stageMap?.["1b"]) ||
      toDisplayUrl(stageMap?.stage1B) ||
      null;
    const stage1AUrl =
      toDisplayUrl(stageMap?.["1A"]) ||
      toDisplayUrl(stageMap?.["1a"]) ||
      toDisplayUrl(stageMap?.["1"]) ||
      toDisplayUrl(stageMap?.stage1A) ||
      null;
    if (stage2Url) return "2";
    if (stage1BUrl) return "1B";
    if (stage1AUrl) return "1A";
    return null;
  }, [displayStageByIndex, results]);

  const getEditSourceForIndex = useCallback((imageIndex: number) => {
    const item = results[imageIndex];
    if (!item) return { url: null, stage: null } as const;

    // Edit baseline must match the exact artifact currently rendered in UI.
    const displayed = buildPreviewImage(imageIndex);
    const displayedUrl = toDisplayUrl(displayed?.url);
    const displayedStage = resolveDisplayedStageForEdit(imageIndex);
    return {
      url: displayedUrl || null,
      stage: mapStageToEditSource(displayedStage),
    } as const;
  }, [buildPreviewImage, resolveDisplayedStageForEdit, results]);

  // Handle edit image - resolve URL before opening editor
  const handleEditImage = (imageIndex: number, displayedUrlOverride?: string | null) => {
    const item = results[imageIndex];
    if (!item) {
      console.error('[EDIT][load_source] No result data for index:', imageIndex);
      toast({
        title: "Cannot open editor",
        description: "Image data not available",
        variant: "destructive"
      });
      return;
    }

    const stageMap = item?.stageUrls || item?.result?.stageUrls || item?.stageOutputs || item?.result?.stageOutputs || {};
    const preservedStage2 = toDisplayUrl(stageMap?.['2']) || toDisplayUrl(stageMap?.[2]) || toDisplayUrl(stageMap?.stage2) || toDisplayUrl(item?.stage2Url) || toDisplayUrl(item?.result?.stage2Url) || null;
    const preservedStage1B = toDisplayUrl(stageMap?.['1B']) || toDisplayUrl(stageMap?.['1b']) || toDisplayUrl(stageMap?.stage1B) || null;
    const preservedStage1A = toDisplayUrl(stageMap?.['1A']) || toDisplayUrl(stageMap?.['1a']) || toDisplayUrl(stageMap?.['1']) || toDisplayUrl(stageMap?.stage1A) || null;
    preEditStageUrlsRef.current[imageIndex] = {
      stage2: preservedStage2,
      stage1B: preservedStage1B,
      stage1A: preservedStage1A,
    };

    const resolvedEditSource = getEditSourceForIndex(imageIndex);
    const imageUrl =
      toDisplayUrl(displayedUrlOverride) ||
      resolvedEditSource.url;
    const urlSource = resolvedEditSource.stage;
    const imageId = item?.imageId || item?.result?.imageId || null;
    const sourceJobId = item?.jobId || item?.result?.jobId || null;

    // ✅ Verify URL is non-null before opening editor
    if (!imageUrl) {
      console.error('[EDIT][load_source] No valid URL found', {
        imageId,
        imageIndex,
        urlSource: urlSource || 'displayed',
        item: {
          stageUrls: item?.stageUrls || null,
          resultUrl: item?.resultUrl || null,
          imageUrl: item?.imageUrl || null
        }
      });
      toast({
        title: "Cannot open editor",
        description: "No valid image URL available for editing",
        variant: "destructive"
      });
      return;
    }

    // ✅ Log selected URL source for debugging edit flow
    console.log('[edit] resolved image URL', {
      imageId,
      imageIndex,
      stage: urlSource || 'displayed',
      url: imageUrl,
      completionSource: item?.completionSource || null,
      stageUrls: item?.stageUrls || item?.result?.stageUrls || null,
      resultUrl: item?.resultUrl || null,
    });

    // ✅ Store completion source in editor state for reference
    setActiveEditSource({ url: imageUrl, stage: urlSource || null, jobId: sourceJobId });
    setEditingImageIndex(imageIndex);
    setRegionEditorOpen(true);
  };

  const handleRetryImage = async (imageIndex: number, customInstructions?: string, sceneType?: "auto" | "interior" | "exterior", allowStagingOverride?: boolean, furnitureReplacementOverride?: boolean, roomType?: string, windowCount?: number, referenceImage?: File, retryStage?: StageKey, baselineUrl?: string | null, sourceStageLabel?: string, stage1BWasRequested?: boolean, stagesToRun?: StageKey[], requestedStagesList?: StageKey[], baselineStage?: "original" | "1A" | "1B") => {
    // ✅ Prevent double retry on same image
    if (!files || imageIndex >= files.length || retryingImages.has(imageIndex)) return;

    const fileToRetry = files[imageIndex];
    if (!fileToRetry) return;

    // Check if this is a synthetic placeholder file created from batch persistence
    const isPlaceholder = (fileToRetry as any).__restored === true;
    const originalFromStoreUrl =
      results[imageIndex]?.result?.originalImageUrl ||
      results[imageIndex]?.result?.originalUrl ||
      results[imageIndex]?.originalImageUrl ||
      results[imageIndex]?.originalUrl;

    // If we only have a placeholder, pull the original from storage so the retry uses a real image
    let fileForUpload: File = fileToRetry;
    if (isPlaceholder) {
      if (!originalFromStoreUrl) {
        toast({
          title: "Need the original photo",
          description: "Please re-upload the image before retrying so we can process the real file.",
          variant: "destructive"
        });
        return;
      }
      try {
        // AUDIT FIX: added timeout to prevent hung original re-download
        const resp = await fetch(originalFromStoreUrl, { signal: AbortSignal.timeout(30_000) });
        if (!resp.ok) throw new Error("Unable to download the original image");
        const blob = await resp.blob();
        const revived = new File([blob], fileToRetry.name || "retry-image.jpg", {
          type: blob.type || fileToRetry.type || "image/jpeg",
          lastModified: Date.now()
        });
        // Mark as real so subsequent retries use this file
        (revived as any).__restored = false;
        setFiles(prev => {
          const next = [...prev];
          next[imageIndex] = revived;
          return next;
        });
        fileForUpload = revived;
      } catch (err: any) {
        toast({
          title: "Couldn’t load the original",
          description: err?.message || "Please re-upload the image and retry.",
          variant: "destructive"
        });
        return;
      }
    }

    try {
      // Check credits and authentication
      await ensureLoggedInAndCredits(1);
    } catch (e: any) {
      if (e.code === "INSUFFICIENT_CREDITS") {
        const goBuy = confirm("You need 1 more credit to retry this image. Buy credits now?");
        if (goBuy) {
          window.open("/settings/billing", "_blank");
        }
        return;
      }
      toast({
        title: "Authentication required",
        description: e.message || "Please sign in to retry images",
        variant: "destructive"
      });
      return;
    }

    // ✅ Clear any previous timeout
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }

    // ✅ Mark retry active and loading
    setRetryingImages(prev => new Set(prev).add(imageIndex));
    setRetryLoadingImages(prev => new Set(prev).add(imageIndex));

    // ✅ CRITICAL: Immediately clear ALL error states and UI badges for this image
    setResults(prev => prev.map((r, i) => {
      if (i !== imageIndex) return r;
      const nextStage = retryStage || null;
      return {
        ...r,
        status: "processing",
        uiStatus: "ok",
        error: null, // Clear error object
        errorMessage: undefined, // Clear error message
        errorCode: undefined, // Clear error code
        failureReason: undefined, // Clear failure reason
        validationError: undefined, // Clear validation errors
        warnings: [], // Clear warnings array
        resultStage: null,
        finalStage: null,
        currentStage: nextStage ? nextStage.toLowerCase() : "processing",
        statusLastModified: Date.now(), // Update timestamp for immediate UI refresh
        retryInFlight: true, // UI-only flag for immediate badge update
        retryStage: nextStage, // Store requested retry stage for status text
      };
    }));
    if (retryStage) {
      setDisplayStageByIndex(prev => ({ ...prev, [imageIndex]: retryStage }));
    }
    
    try {
      // Determine explicit scene type - prefer provided, then metadata, then auto
      const imageIdForRetry = getImageIdForIndex(imageIndex);
      const storedScene = imageIdForRetry ? imageSceneTypesById[imageIdForRetry] : null;
      const explicitScene = sceneType || storedScene || "auto";

      // Use the baseline URL provided by computeRetryBaseline (context-aware)
      // Falls back to original file when baselineUrl is null (full pipeline retry)
      const retrySource = {
        stage: sourceStageLabel || "original_upload",
        url: baselineUrl || originalFromStoreUrl || null,
      };
      const parentJobId = results[imageIndex]?.jobId || jobIds[imageIndex] || null;
      const clientBatchIdToSend = clientBatchIdRef.current || clientBatchId || null;
      
      // Build retry-focused goal based on scene
      const baseGoal = (globalGoal?.trim() || "General, realistic enhancement for the selected industry.").trim();
      
      const retryFocus = explicitScene === "exterior"
        ? " [RETRY FOCUS] Prioritize clear blue sky with soft clouds, subtle grass revival (natural), strong dehaze/contrast/sharpness. Keep staging only on decks/patios; skip if uncertain."
        : explicitScene === "interior"
        ? " [RETRY FOCUS] Maintain realistic furniture scale, doorway/window clearance, and modern cohesive styling. Improve exposure/white balance/sharpness."
        : "";
      
      const goalToSend = customInstructions
        ? [baseGoal, customInstructions.trim(), retryFocus].filter(Boolean).join(" ")
        : [baseGoal, retryFocus].filter(Boolean).join(" ");
      
      // Use dedicated retry endpoint that bypasses batch lock
      const fd = new FormData();
      fd.append("image", fileForUpload); // Correct field name for retry-single
      fd.append("goal", goalToSend);
      if (sceneType) fd.append("sceneType", sceneType);
      if (sceneType && sceneType !== 'auto') fd.append("manualSceneOverride", "true");
      if (typeof allowStagingOverride === 'boolean') fd.append("allowStaging", String(allowStagingOverride));
      if (typeof furnitureReplacementOverride === 'boolean') fd.append("furnitureReplacement", String(furnitureReplacementOverride));
      if (roomType) fd.append("roomType", roomType);
      if (windowCount !== undefined) fd.append("windowCount", String(windowCount));
      if (referenceImage) fd.append("referenceImage", referenceImage);
      if (imageIdForRetry) fd.append("imageId", imageIdForRetry);
      if (parentJobId) fd.append("parentJobId", parentJobId);
      if (clientBatchIdToSend) fd.append("clientBatchId", clientBatchIdToSend);
      if (retrySource.stage) fd.append("sourceStage", retrySource.stage);
      if (retrySource.url) fd.append("sourceUrl", retrySource.url);
      fd.append("stage1BWasRequested", String(Boolean(stage1BWasRequested)));
      if (baselineStage) fd.append("baselineStage", baselineStage);
      if (baselineUrl) fd.append("baselineUrl", baselineUrl);
      if (stagesToRun?.length) fd.append("stagesToRun", JSON.stringify(stagesToRun));
      if (requestedStagesList?.length) fd.append("requestedStages", JSON.stringify(requestedStagesList));
      fd.append("requestedStage", (retryStage || "2") as StageKey);

      try {
        // AUDIT FIX: added timeout to prevent hung retry requests
        const response = await fetch(api("/api/batch/retry-single"), withDevice({
          method: "POST",
          body: fd,
          credentials: "include",
          signal: AbortSignal.timeout(30_000)
        }));

        if (!response.ok) {
          if (response.status === 402) {
            const err = await response.json().catch(() => ({}));
            if (err?.code === "QUOTA_EXCEEDED") {
              showQuotaExceededToast();
              return;
            }
            const goBuy = confirm("You need 1 more credit to retry this image. Buy credits now?");
            if (goBuy) {
              window.open("/settings/billing", "_blank");
            }
            return;
          }
          const err = await response.json().catch(() => ({}));
          if (err?.error === "image_not_found" || err?.code === "image_not_found") {
            markRetryFailed(imageIndex, "The source image is no longer available to retry.");
            toast({
              title: "Image unavailable",
              description: "The source image is no longer available to retry. Please re-upload and try again.",
              variant: "destructive"
            });
            console.warn("[retry-single] image_not_found", { imageIndex, imageId: imageIdForRetry, err });
            return;
          }
          if (err?.error === "forbidden_source") {
            markRetryFailed(imageIndex, "Retry source is no longer valid.");
            toast({
              title: "Pick a current output",
              description: "Please refresh the page and choose a current output before retrying.",
              variant: "destructive"
            });
            return;
          }
          if (err?.error === "manual_retry_requires_stage2" || err?.error === "manual_retry_stage2only_required" || err?.error === "manual_retry_stage2only_payload_invalid") {
            markRetryFailed(imageIndex, err?.message || "Retry requires Stage 2 with a valid baseline policy.");
            toast({
              title: "Retry requires staging baseline",
              description: err?.message || "Retry requires an earlier processing stage to be available as a baseline.",
              variant: "destructive"
            });
            return;
          }
          // Handle retry-specific compliance failures
          if (err.code === "RETRY_COMPLIANCE_FAILED") {
            markRetryFailed(imageIndex, "Retry blocked by compliance validation.");
            const violationDetails = err.reasons?.join(", ") || "structural preservation requirements";
            toast({
              title: "Cannot generate different result",
              description: `The enhancer cannot create a compliant variation due to ${violationDetails}. Try adjusting your settings or using a different approach. No credit was charged.`,
              variant: "destructive",
              duration: 8000
            });
            return;
          }
          // Enhanced error messaging for specific retry issues
          if (response.status === 400 && err.message?.includes("Invalid image format")) {
            throw new Error("The image file appears to be corrupted or in an unsupported format. Please try uploading the image again.");
          }
          throw new Error(err.message || "Failed to retry image");
        }

        // Instead of expecting the image to be ready, start polling for the job status
        // Extract jobId from the response
        const data = await response.json();
        let jobId = data.jobId || (data.jobs && data.jobs[0] && data.jobs[0].id);
        if (!jobId && data.jobs && data.jobs.length > 0) jobId = data.jobs[0].id;
        if (!jobId) {
          throw new Error("Retry submitted but no jobId returned. Please try again.");
        }
        console.log("[retry-single] submitted", { imageIndex, jobId, imageId: imageIdForRetry });

        // ✅ IMMEDIATELY update batch item state to reflect retry processing
        setResults(prev => prev.map((r, i) => {
          if (i !== imageIndex) return r;
          return {
            ...r,
            status: "processing",
            progress: 0,
            resultUrl: r?.resultUrl || r?.result?.resultUrl || null,
            imageUrl: r?.imageUrl || r?.result?.imageUrl || null,
            stageUrls: r?.stageUrls || r?.result?.stageUrls || null,
            completionSource: null,
            jobId: jobId, // Store the new retry jobId
            statusLastModified: Date.now(),
            retryInFlight: true, // UI-only flag for immediate badge update
            retryStage: retryStage || null, // Store requested retry stage for status text
          };
        }));

        // ✅ Register retry job with polling infrastructure
        jobIdToIndexRef.current[jobId] = imageIndex;
        if (imageIdForRetry) {
          imageIdToIndexRef.current[imageIdForRetry] = imageIndex;
          jobIdToImageIdRef.current[jobId] = imageIdForRetry;
        }

        // ✅ Add retry jobId to jobIds array for main poller
        setJobIds(prev => {
          const updated = [...prev];
          updated[imageIndex] = jobId;
          return updated;
        });

        // ✅ DO NOT set global progress - retry is image-only operation
        // ❌ setProgressText("Retry submitted. Waiting for enhanced image...");
        // ❌ setRunState("running");
        // ❌ setAbortController(controller);

        // ✅ Start safety timeout (auto-reset after 60 seconds)
        retryTimeoutRef.current = setTimeout(() => {
          console.warn("[retry-timeout] Retry timed out for image:", imageIndex);

          setRetryLoadingImages(prev => {
            const next = new Set(prev);
            next.delete(imageIndex);
            return next;
          });
          setRetryingImages(prev => {
            const next = new Set(prev);
            next.delete(imageIndex);
            return next;
          });

          setResults(prev => prev.map((r, i) => i === imageIndex ? {
            ...r,
            status: "failed",
            uiStatus: "error",
            error: "Retry timed out",
            currentStage: null,
            retryInFlight: undefined,
            retryStage: undefined,
          } : r));

          retryTimeoutRef.current = null;

          toast({
            title: "Retry timed out",
            description: "The retry took too long. Please try again.",
            variant: "destructive"
          });
        }, RETRY_TIMEOUT_MS);

        // Poll for the single job status using the batch endpoint for consistency
        const pollRetryJob = async () => {
          const pollStart = Date.now();
          const pollTimeout = 10 * 60 * 1000; // 10 minutes max (but timeout will trigger at 60s)
          let delay = 1000;
          while (Date.now() - pollStart < pollTimeout) {
            // ✅ No abort controller for retry - image-only operation
            try {
              const resp = await fetch(api(`/api/status/batch?ids=${encodeURIComponent(jobId)}`), {
                method: "GET",
                credentials: "include",
                headers: { ...withDevice().headers, "Cache-Control": "no-cache" }
                // ✅ No signal - image-only operation
              });
              if (!resp.ok) {
                await new Promise(r => setTimeout(r, delay));
                continue;
              }
              const statusData = await resp.json();
              const items = Array.isArray(statusData.items) ? statusData.items : [];
              const job = items.find((j: any) => j.id === jobId) || items[0];
              const jobStatusRaw = String(job?.status || job?.state || "").toLowerCase();
              const isJobCompleted = jobStatusRaw === "completed" || jobStatusRaw === "complete";
              const isJobFailed = jobStatusRaw === "failed" || jobStatusRaw === "error" || jobStatusRaw === "cancelled" || jobStatusRaw === "canceled";
              const jobStageUrls = job?.stageUrls || job?.stage_urls || {};
              const completedOutputUrl =
                toDisplayUrl(job?.imageUrl) ||
                toDisplayUrl(job?.resultUrl) ||
                toDisplayUrl(job?.publishedUrl) ||
                toDisplayUrl(jobStageUrls?.stage2) ||
                toDisplayUrl(jobStageUrls?.["2"]) ||
                toDisplayUrl(jobStageUrls?.stage1B) ||
                toDisplayUrl(jobStageUrls?.["1B"]) ||
                toDisplayUrl(jobStageUrls?.stage1A) ||
                toDisplayUrl(jobStageUrls?.["1A"]) ||
                null;
              const hasCompletedOutput = !!completedOutputUrl;
              const hasRecoverableFallback = isJobFailed && hasCompletedOutput;

              if (job && isJobCompleted && hasCompletedOutput) {
                // ✅ Clear timeout on success (spinner stays until onLoad)
                if (retryTimeoutRef.current) {
                  clearTimeout(retryTimeoutRef.current);
                  retryTimeoutRef.current = null;
                }

                // Update UI with the new image
                const stamp = Date.now();
                const stageUrls = jobStageUrls || null;
                const imageIdFromJob = job.imageId || job.image_id || null;
                const retryResult = {
                  image: completedOutputUrl,
                  imageUrl: completedOutputUrl,
                  result: { imageUrl: completedOutputUrl },
                  stageUrls,
                  imageId: imageIdFromJob,
                  error: null,
                  ok: true
                };
                const normalizedResult = normalizeBatchItem(retryResult);
                const preservedOriginalUrl =
                  results[imageIndex]?.result?.originalImageUrl ||
                  results[imageIndex]?.result?.originalUrl ||
                  results[imageIndex]?.originalImageUrl ||
                  results[imageIndex]?.originalUrl;
                const preservedQualityEnhancedUrl = results[imageIndex]?.result?.qualityEnhancedUrl || results[imageIndex]?.qualityEnhancedUrl;
                const existingRetryHistory = Array.isArray(results[imageIndex]?.retryHistory)
                  ? results[imageIndex].retryHistory
                  : [];
                setResults(prev => prev.map((r, i) =>
                  i === imageIndex ? {
                    ...r,
                    image: completedOutputUrl,
                    imageUrl: completedOutputUrl,
                    resultUrl: completedOutputUrl,
                    version: stamp,
                    mode: job.mode || "staged",
                    originalImageUrl: preservedOriginalUrl,
                    qualityEnhancedUrl: preservedQualityEnhancedUrl,
                    stageUrls: r?.stageUrls || stageUrls || null,
                    imageId: imageIdFromJob || r?.imageId,
                    retryLatestUrl: completedOutputUrl,
                    retryHistory: [
                      ...existingRetryHistory,
                      {
                        url: completedOutputUrl,
                        ts: stamp,
                        stage: retryStage || null,
                        jobId,
                      },
                    ],
                    status: "completed",
                    uiStatus: "ok",
                    currentStage: null,
                    retryInFlight: undefined,
                    retryStage: undefined,
                    resultStage: (job.resultStage || job.finalStage || retryStage || r?.resultStage || null) as StageKey | null,
                    finalStage: (job.finalStage || job.resultStage || retryStage || r?.finalStage || null) as StageKey | null,
                    result: {
                      ...(normalizedResult || {}),
                      image: completedOutputUrl,
                      imageUrl: completedOutputUrl,
                      resultUrl: completedOutputUrl,
                      originalImageUrl: preservedOriginalUrl,
                      stageUrls: r?.result?.stageUrls || r?.stageUrls || stageUrls || (normalizedResult as any)?.stageUrls,
                      imageId: imageIdFromJob || (normalizedResult as any)?.imageId,
                      qualityEnhancedUrl: preservedQualityEnhancedUrl,
                      retryLatestUrl: completedOutputUrl,
                    },
                    error: null,
                    filename: r?.filename
                  } : r
                ));
                setDisplayStageByIndex(prev => ({ ...prev, [imageIndex]: "retried" }));
                setProcessedImagesByIndex(prev => ({ ...prev, [String(imageIndex)]: completedOutputUrl }));
                setProcessedImages(prev => {
                  const newSet = new Set(prev);
                  newSet.add(completedOutputUrl);
                  return Array.from(newSet);
                });
                setProcessedImagesByIndex(prev => ({
                  ...prev,
                  [imageIndex]: completedOutputUrl
                }));
                await refreshUser();

                // Mark retry as finished (spinner clears on image load, but clear now for buttons/state)
                clearRetryFlags(imageIndex);

                // ✅ DO NOT set global progress state
                // ❌ setRunState("done");
                // ❌ setAbortController(null);
                // ❌ setProgressText("Retry complete! Enhanced image is ready.");

                return;
              } else if (job && hasRecoverableFallback) {
                if (retryTimeoutRef.current) {
                  clearTimeout(retryTimeoutRef.current);
                  retryTimeoutRef.current = null;
                }

                const stamp = Date.now();
                const stageUrls = jobStageUrls || null;
                const imageIdFromJob = job.imageId || job.image_id || null;
                const preservedOriginalUrl =
                  results[imageIndex]?.result?.originalImageUrl ||
                  results[imageIndex]?.result?.originalUrl ||
                  results[imageIndex]?.originalImageUrl ||
                  results[imageIndex]?.originalUrl;
                const preservedQualityEnhancedUrl = results[imageIndex]?.result?.qualityEnhancedUrl || results[imageIndex]?.qualityEnhancedUrl;
                const existingRetryHistory = Array.isArray(results[imageIndex]?.retryHistory)
                  ? results[imageIndex].retryHistory
                  : [];

                setResults(prev => prev.map((r, i) =>
                  i === imageIndex ? {
                    ...r,
                    image: completedOutputUrl,
                    imageUrl: completedOutputUrl,
                    resultUrl: completedOutputUrl,
                    version: stamp,
                    mode: job.mode || "staged",
                    originalImageUrl: preservedOriginalUrl,
                    qualityEnhancedUrl: preservedQualityEnhancedUrl,
                    stageUrls: r?.stageUrls || stageUrls || null,
                    imageId: imageIdFromJob || r?.imageId,
                    retryLatestUrl: completedOutputUrl,
                    retryHistory: [
                      ...existingRetryHistory,
                      {
                        url: completedOutputUrl,
                        ts: stamp,
                        stage: retryStage || null,
                        jobId,
                      },
                    ],
                    status: "completed",
                    uiStatus: "warning",
                    currentStage: null,
                    retryInFlight: undefined,
                    retryStage: undefined,
                    resultStage: (job.resultStage || job.finalStage || retryStage || r?.resultStage || null) as StageKey | null,
                    finalStage: (job.finalStage || job.resultStage || retryStage || r?.finalStage || null) as StageKey | null,
                    warnings: Array.isArray(job?.warnings) ? job.warnings : (r?.warnings || []),
                    result: {
                      ...(r?.result || {}),
                      image: completedOutputUrl,
                      imageUrl: completedOutputUrl,
                      resultUrl: completedOutputUrl,
                      originalImageUrl: preservedOriginalUrl,
                      stageUrls: r?.result?.stageUrls || r?.stageUrls || stageUrls,
                      imageId: imageIdFromJob || r?.result?.imageId,
                      qualityEnhancedUrl: preservedQualityEnhancedUrl,
                      retryLatestUrl: completedOutputUrl,
                      warnings: Array.isArray(job?.warnings) ? job.warnings : (r?.result?.warnings || []),
                    },
                    error: null,
                  } : r
                ));

                setDisplayStageByIndex(prev => ({ ...prev, [imageIndex]: "retried" }));
                setProcessedImagesByIndex(prev => ({ ...prev, [String(imageIndex)]: completedOutputUrl }));
                clearRetryFlags(imageIndex);

                toast({
                  title: "Retry completed with fallback",
                  description: (Array.isArray(job?.warnings) && job.warnings[0]) || "A best-available result was returned after validation fallback.",
                  variant: "default"
                });
                return;
              } else if (job && isJobFailed) {
                // ✅ Clear timeout on failure
                if (retryTimeoutRef.current) {
                  clearTimeout(retryTimeoutRef.current);
                  retryTimeoutRef.current = null;
                }

                // ✅ DO NOT set global progress state
                // ❌ setRunState("done");
                // ❌ setAbortController(null);
                // ❌ setProgressText("Retry failed. Unable to enhance image.");

                markRetryFailed(imageIndex, job.error || "The retry job failed to process.");

                const errMsg = job.error || "The retry job failed to process.";
                if (job.error === "image_not_found") {
                  toast({
                    title: "Image unavailable",
                    description: "The source image is no longer available to retry. Please re-upload and try again.",
                    variant: "destructive"
                  });
                  console.warn("[retry-poll] image_not_found", { imageIndex, imageId: imageIdForRetry, jobId, job });
                } else {
                  toast({
                    title: "Retry failed",
                    description: errMsg,
                    variant: "destructive"
                  });
                }
                return;
              }
            } catch (e) {
              // Ignore and retry
            }
            await new Promise(r => setTimeout(r, delay));
            delay = Math.min(5000, Math.floor(delay * 1.5));
          }

          // ✅ Poll timeout reached (but timeout ref will have already fired at 60s)
          // ✅ DO NOT set global progress state
          // ❌ setRunState("done");
          // ❌ setAbortController(null);
          // ❌ setProgressText("Retry timed out. Please try again.");

          // Note: timeout toast already shown by timeout handler above
          console.warn("[retry-poll] Poll timeout reached for image:", imageIndex);
        };
        pollRetryJob();
      } catch (error) {
        console.error("Retry failed:", error);

        // ✅ Clear timeout on error
        if (retryTimeoutRef.current) {
          clearTimeout(retryTimeoutRef.current);
          retryTimeoutRef.current = null;
        }

        markRetryFailed(imageIndex, error instanceof Error ? error.message : "Unknown error");

        toast({
          title: "Retry failed",
          description: error instanceof Error ? error.message : "Unknown error",
          variant: "destructive"
        });
      } finally {
        // Keep spinner until image onLoad; do not clear here
      }
    } catch (e) {
      console.error("[handleRetryImage] Outer retry process error:", e);
      // Do not clear spinner here; timeout/onLoad handlers manage UI state
    } finally {
      // Outer try-finally: intentionally leave spinner until onLoad/timeout
    }
  };

  const handleBatchRefine = async () => {
    // Check if we have processed images to refine
    if (processedImages.length === 0) {
      toast({ 
        title: "No Images Available", 
        description: "No processed images available for batch refinement.",
        variant: "destructive"
      });
      return;
    }
    
    // Prevent double refines
    if (isBatchRefining) {
      return;
    }
    
    setIsBatchRefining(true);
    
    try {
      // Batch refine is a free Sharp-based enhancement - only ensure user is signed in
      await ensureLoggedInAndCredits(0); // 0 credits needed, just validates authentication
      
      // AUDIT FIX: added timeout to prevent hung refine requests
      const response = await fetch(api("/api/batch/refine"), {
        method: "POST",
               headers: {
          "Content-Type": "application/json",
          ...withDevice().headers        },
        credentials: "include",
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({ 
          imageUrlsWithIndex: Object.entries(processedImagesByIndex).map(([index, url]) => ({index: parseInt(index), url})),
          profession: industryMap[presetKey] || "Real Estate"
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        toast({ 
          title: "Refinement Failed", 
          description: errorData.error || "Failed to refine batch images. Please try again.",
          variant: "destructive"
        });
        return;
      }
      
      const data = await response.json();
      
      if (!data.ok || !data.results) {
        toast({ 
          title: "Refinement Failed", 
          description: "Invalid response from server during batch refinement.",
          variant: "destructive"
        });
        return;
      }
      
      // Update processedImagesByIndex with the refined versions where successful
      const updatedProcessedImagesByIndex = { ...processedImagesByIndex };
      
      data.results.forEach((refinedResult: any) => {
        if (refinedResult.ok && refinedResult.refinedUrl) {
          // Update the index-based mapping
          updatedProcessedImagesByIndex[refinedResult.index] = refinedResult.refinedUrl;
        }
      });
      
      setProcessedImagesByIndex(updatedProcessedImagesByIndex);
      
      // Rebuild processedImages array from the index-based mapping in proper order
      const maxIndex = Math.max(...Object.keys(updatedProcessedImagesByIndex).map(k => parseInt(k)));
      const orderedProcessedImages: string[] = [];
      for (let i = 0; i <= maxIndex; i++) {
        if (updatedProcessedImagesByIndex[i]) {
          orderedProcessedImages[i] = updatedProcessedImagesByIndex[i];
        }
      }
      setProcessedImages(orderedProcessedImages.filter(Boolean)); // Remove empty slots
      
      // CRITICAL FIX: Also update the results state array so gallery thumbnails show refined images
      setResults(prev => prev.map((result, index) => {
        const refinedResult = data.results.find((r: any) => r.index === index);
        if (refinedResult?.ok && refinedResult.refinedUrl && result?.result) {
          return {
            ...result,
            result: {
              ...result.result,
              imageUrl: refinedResult.refinedUrl
            }
          };
        }
        return result;
      }));
      
      setHasRefinedImages(true);
      
      const successCount = data.results.filter((r: any) => r.ok).length;
      // No credits used for batch refine (free Sharp processing)
      // But refresh user state to keep UI in sync
      await refreshUser();
      
      toast({ 
        title: "Batch Refinement Complete", 
        description: `Successfully refined ${successCount} out of ${Object.keys(processedImagesByIndex).length} images with smart adjustments.`
      });
      
    } catch (error: any) {
      console.error("Batch refine error:", error);
      
      // Handle authentication errors (batch refine is free, so no credit issues)
      if (error.code === 401 || error.code === 403) {
        handleAuthFailure();
        toast({ 
          title: "Authentication Required", 
          description: "Please sign in to refine batch images.",
          variant: "destructive"
        });
      } else {
        toast({ 
          title: "Refinement Failed", 
          description: error.message || "Failed to refine batch images. Please try again.",
          variant: "destructive"
        });
      }
    } finally {
      setIsBatchRefining(false);
    }
  };

  function resetBatchState(nextTab: "upload" | "images" = "images") {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setAbortController(null);
    }
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    if (flashAssignedTimerRef.current) {
      clearTimeout(flashAssignedTimerRef.current);
      flashAssignedTimerRef.current = null;
    }
    Object.keys(messageTimerByImageRef.current).forEach((key) => {
      const index = Number(key);
      const timer = messageTimerByImageRef.current[index];
      if (timer) clearTimeout(timer);
    });
    messageTimerByImageRef.current = {};
    messageStageByImageRef.current = {};
    Object.values(editFallbackTimersRef.current).forEach((t) => clearTimeout(t));
    editFallbackTimersRef.current = {};

    queueRef.current = [];
    processedSetRef.current = new Set();
    jobIdToIndexRef.current = {};
    imageIdToIndexRef.current = {};
    jobIdToImageIdRef.current = {};
    regionEditJobIdsRef.current = new Set();
    strictNotifiedRef.current = new Set();
    statusUnknownLoggedRef.current = new Set();
    idxMissingLoggedRef.current = new Set();
    statusHasUrlLoggedRef.current = new Set();
    statusTargetNotReachedLoggedRef.current = new Set();
    retryChildMappingLoggedRef.current = new Set();
    autoFurnitureNoticeLoggedRef.current = new Set();
    sceneDetectCacheRef.current = {};
    scenePredictionsByIdRef.current = {};
    clientBatchIdRef.current = null;
    previousFileCountRef.current = 0;

    setFiles([]);
    setGlobalGoal("");
    setPropertyAddress("");
    setPreserveStructure(true);
    setIsUploading(false);
    setRunState("idle");
    setJobId("");
    setJobIds([]);
    setCancelIds([]);
    setClientBatchId(null);
    setResults([]);
    setProgressText("");
    setProcessedImages([]);
    setProcessedImagesByIndex({});
    setDisplayStageByIndex({});
    setRetryingImages(new Set());
    setRetryLoadingImages(new Set());
    setEditingImages(new Set());
    setEditCompletedImages(new Set());
    setStrictRetryingIndices(new Set());
    setMessageIndexByImage({});
    setAiSteps({});
    setLastDetected(null);
    setFlashAssignedThumbnailIndex(null);
    setPreviewImage(null);
    setEditingImageIndex(null);
    setActiveEditSource(null);
    setRegionEditorOpen(false);
    setEditingImage(null);
    setIsEditingInProgress(false);
    setRetryDialog({ isOpen: false, imageIndex: null });

    setIsBatchRefining(false);
    setHasRefinedImages(false);

    setSelection(new Set());
    setMetaByIndex({});
    setImageRoomTypesById({});
    setImageSceneTypesById({});
    setManualSceneTypesById({});
    setManualSceneOverrideById({});
    setImageSkyReplacementById({});
    setLinkImages(false);
    setScenePredictionsById({});
    setSelectedImageId(null);
    setShowSpecificRequirements(false);
    setActiveTab(nextTab);

    clearBatchJobState(currentUserId);
    clearEnhancementStateStorage(currentUserId);
    clearEnhancementStateStorage(undefined);
    localStorage.removeItem("currentBatch");
    sessionStorage.removeItem("currentBatch");

    console.log('[BATCH_STATE_CLEARED]', { tab: nextTab, userId: currentUserId || null });
    console.log('[BATCH_RESET]', { tab: nextTab, userId: currentUserId || null });
  }

  const handleRestart = () => {
    resetBatchState("images");
  };

  // Cancel batch request
  const cancelBatch = async () => {
    if (!jobIds.length) return;
    try {
      // AUDIT FIX: added timeout to prevent hung cancel requests
      await fetch(api("/api/jobs/cancel-batch"), withDevice({
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: jobIds }),
        signal: AbortSignal.timeout(15_000)
      }));
      if (abortController) abortController.abort();
      setRunState("idle");
      setProgressText("Batch cancelled");
    } catch (e) {
      console.warn("cancel-batch failed", e);
    }
  };

  // Helper function to check if user can proceed to next tab
  const canProceedToTab = (tab: "upload" | "images" | "enhance"): boolean => {
    switch(tab) {
      case "images": return files.length > 0;
      case "enhance": return files.length > 0;
      default: return true;
    }
  };

  // Auto-advance tab when files are selected
  const onFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = Array.from(e.target.files || []);
    // Append new files to existing ones instead of replacing
    setFiles(prev => [...prev, ...fileList]);
    // Auto-advance to the unified workspace when files are selected.
    if (fileList.length > 0 && activeTab === "upload") {
      setActiveTab("images");
    }
  };

  // Trigger file selector (for launchpad and other UI surfaces)
  const triggerFileSelector = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // Centralized file validation and processing handler
  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []);
    let processingFiles = selectedFiles;
    const rejectionReasons: string[] = [];
    
    // Filter by MIME type
    const imageFiles = processingFiles.filter(f => f.type.startsWith("image/"));
    if (imageFiles.length !== processingFiles.length) {
      rejectionReasons.push(`${processingFiles.length - imageFiles.length} non-image file(s)`);
    }
    processingFiles = imageFiles;
    
    // Validate file count - accept as many as possible up to limit
    const availableSlots = MAX_FILES - files.length;
    if (processingFiles.length > availableSlots) {
      if (availableSlots > 0) {
        rejectionReasons.push(`${processingFiles.length - availableSlots} file(s) exceed batch limit`);
        processingFiles = processingFiles.slice(0, availableSlots);
      } else {
        toast({
          title: "Batch limit reached",
          description: `Maximum ${MAX_FILES} images allowed per batch. Remove files to add more.`,
          variant: "destructive",
        });
        e.target.value = '';
        return;
      }
    }
    
    // Validate file sizes
    const validFiles = processingFiles.filter(f => f.size <= MAX_FILE_SIZE_BYTES);
    if (validFiles.length !== processingFiles.length) {
      rejectionReasons.push(`${processingFiles.length - validFiles.length} file(s) exceed ${MAX_FILE_SIZE_MB}MB`);
    }
    
    if (validFiles.length === 0) {
      if (rejectionReasons.length > 0) {
        toast({
          title: "No valid files",
          description: `Skipped: ${rejectionReasons.join(', ')}`,
          variant: "destructive",
        });
      }
      e.target.value = '';
      return;
    }
    
    // Deduplicate by name+size
    setFiles(prev => {
      const existing = new Set(prev.map(f => `${f.name}-${f.size}`));
      const unique = validFiles.filter(f => !existing.has(`${f.name}-${f.size}`));
      
      if (unique.length !== validFiles.length) {
        rejectionReasons.push(`${validFiles.length - unique.length} duplicate(s)`);
      }
      
      // Show aggregated feedback
      if (rejectionReasons.length > 0) {
        toast({
          title: unique.length > 0 ? `Added ${unique.length} file(s)` : "Files skipped",
          description: `Skipped: ${rejectionReasons.join(', ')}`,
          variant: unique.length > 0 ? "default" : "destructive",
        });
      }
      
      return [...prev, ...unique];
    });
    
    // Context-safe tab switch for the unified workspace
    if (validFiles.length > 0) {
      setActiveTab(prev => prev === "upload" ? "images" : prev);
    }
    
    // Reset input to allow re-selection of same files
    e.target.value = '';
  }, [files, toast]);

  // Drag-drop handler for EmptyStateLaunchpad
  const handleFileDrop = useCallback((droppedFiles: File[]) => {
    let processingFiles = droppedFiles;
    const rejectionReasons: string[] = [];
    
    // Filter by MIME type (drag/drop bypasses accept attribute)
    const imageFiles = processingFiles.filter(f => f.type.startsWith("image/"));
    if (imageFiles.length !== processingFiles.length) {
      rejectionReasons.push(`${processingFiles.length - imageFiles.length} non-image file(s)`);
    }
    processingFiles = imageFiles;
    
    // Validate file count - accept as many as possible up to limit
    const availableSlots = MAX_FILES - files.length;
    if (processingFiles.length > availableSlots) {
      if (availableSlots > 0) {
        rejectionReasons.push(`${processingFiles.length - availableSlots} file(s) exceed batch limit`);
        processingFiles = processingFiles.slice(0, availableSlots);
      } else {
        toast({
          title: "Batch limit reached",
          description: `Maximum ${MAX_FILES} images allowed per batch. Remove files to add more.`,
          variant: "destructive",
        });
        return;
      }
    }
    
    // Validate file sizes
    const validFiles = processingFiles.filter(f => f.size <= MAX_FILE_SIZE_BYTES);
    if (validFiles.length !== processingFiles.length) {
      rejectionReasons.push(`${processingFiles.length - validFiles.length} file(s) exceed ${MAX_FILE_SIZE_MB}MB`);
    }
    
    if (validFiles.length === 0) {
      if (rejectionReasons.length > 0) {
        toast({
          title: "No valid files",
          description: `Skipped: ${rejectionReasons.join(', ')}`,
          variant: "destructive",
        });
      }
      return;
    }
    
    // Deduplicate by name+size
    setFiles(prev => {
      const existing = new Set(prev.map(f => `${f.name}-${f.size}`));
      const unique = validFiles.filter(f => !existing.has(`${f.name}-${f.size}`));
      
      if (unique.length !== validFiles.length) {
        rejectionReasons.push(`${validFiles.length - unique.length} duplicate(s)`);
      }
      
      // Show aggregated feedback
      if (rejectionReasons.length > 0) {
        toast({
          title: unique.length > 0 ? `Added ${unique.length} file(s)` : "Files skipped",
          description: `Skipped: ${rejectionReasons.join(', ')}`,
          variant: unique.length > 0 ? "default" : "destructive",
        });
      }
      
      return [...prev, ...unique];
    });
    
    // Context-safe tab switch for the unified workspace
    if (validFiles.length > 0) {
      setActiveTab(prev => prev === "upload" ? "images" : prev);
    }
  }, [files, toast]);

  const clearAllFiles = () => {
    setFiles([]);
    setSelection(new Set());
    setMetaByIndex({});
    setImageSceneTypesById({});
    setImageRoomTypesById({});
    setManualSceneTypesById({});
    setManualSceneOverrideById({});
    setImageSkyReplacementById({});
    setScenePredictionsById({});
    setSelectedImageId(null);
  };

  const shiftIndexMap = <T,>(map: Record<number, T>, index: number): Record<number, T> => {
    const next: Record<number, T> = {};
    Object.entries(map).forEach(([k, value]) => {
      const i = parseInt(k, 10);
      if (Number.isNaN(i)) return;
      if (i < index) next[i] = value;
      else if (i > index) next[i - 1] = value;
    });
    return next;
  };

  const removeFile = (index: number) => {
    // Get the imageId for the file being removed BEFORE modifying files array
    const imageIdToRemove = index < files.length ? getFileId(files[index]) : null;

    // Update selection to select next image (right neighbor, else left neighbor)
    const total = files.length;
    if (selectedImageId && imageIdToRemove && selectedImageId === imageIdToRemove) {
      // Currently selected image is being removed - select next
      const hasRight = index < total - 1;
      const nextIndex = hasRight ? index + 1 : Math.max(0, index - 1);
      if (nextIndex !== index && nextIndex < total) {
        setSelectedImageId(getFileId(files[nextIndex]));
      } else if (total <= 1) {
        setSelectedImageId(null);
      }
    }

    // Remove from files array
    setFiles(prev => prev.filter((_, i) => i !== index));
    setResults(prev => prev.filter((_, i) => i !== index));
    setAiSteps(prev => shiftIndexMap(prev, index));
    setProcessedImages(prev => prev.filter((_, i) => i !== index));
    setProcessedImagesByIndex(prev => shiftIndexMap(prev, index));

    // Shift index-based selection state
    setSelection(prev => {
      const newSelection = new Set<number>();
      prev.forEach(i => {
        if (i < index) newSelection.add(i);
        else if (i > index) newSelection.add(i - 1);
      });
      return newSelection;
    });

    // Shift index-based meta state
    setMetaByIndex(prev => shiftIndexMap(prev, index));

    // Clean up scene state by imageId (optional - state persists for potential undo)
    // Note: We delete the removed image's data to prevent memory leaks over time
    if (imageIdToRemove) {
      setImageSceneTypesById(prev => {
        const next = { ...prev };
        delete next[imageIdToRemove];
        return next;
      });
      setManualSceneTypesById(prev => {
        const next = { ...prev };
        delete next[imageIdToRemove];
        return next;
      });
      setManualSceneOverrideById(prev => {
        const next = { ...prev };
        delete next[imageIdToRemove];
        return next;
      });
      setImageSkyReplacementById(prev => {
        const next = { ...prev };
        delete next[imageIdToRemove];
        return next;
      });
      setImageRoomTypesById(prev => {
        const next = { ...prev };
        delete next[imageIdToRemove];
        return next;
      });
      setScenePredictionsById(prev => {
        const next = { ...prev };
        delete next[imageIdToRemove];
        return next;
      });

      // Clean up refs too
      delete imageSceneTypesByIdRef.current[imageIdToRemove];
      delete manualSceneTypesByIdRef.current[imageIdToRemove];
      delete scenePredictionsByIdRef.current[imageIdToRemove];
    }
  };

  const removeDisabled = runState !== "idle" || isUploading;

  const handleRemoveImage = (index: number) => {
    if (removeDisabled) {
      toast({
        title: "Cannot remove now",
        description: "Wait for the current process to finish before removing images.",
        variant: "destructive",
      });
      return;
    }

    const confirmed = window.confirm("Remove this image from the batch?");
    if (!confirmed) return;

    // removeFile handles selection update internally
    removeFile(index);
  };

  // Dummy state to force re-render when room type detection updates
  const [roomTypeDetectionTick, setRoomTypeDetectionTick] = useState(0);

  // Rebuild jobId->index mapping when we only have jobIds and file order
  const rebuildJobIndexMapping = (ids: string[] | null | undefined, fileCount: number) => {
    if (!ids || !ids.length || !fileCount) return;
    // Only fill missing entries to avoid clobbering any saved mapping
    const mapping = { ...jobIdToIndexRef.current } as Record<string, number>;
    ids.forEach((id, idx) => {
      if (typeof id === "string" && mapping[id] === undefined && idx < fileCount) {
        mapping[id] = idx;
      }
    });
    jobIdToIndexRef.current = mapping;
  };

  // Keyboard navigation for studio
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      // Only active in studio view
      if (activeTab !== "images") return;
      
      if (e.key === 'ArrowLeft') {
        setCurrentImageIndex(i => Math.max(0, i - 1));
      }
      if (e.key === 'ArrowRight') {
        setCurrentImageIndex(i => Math.min(files.length - 1, i + 1));
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // We need the current index from the state ref or closure
        // Since this effect depends on [currentImageIndex], it will re-bind
        handleRemoveImage(currentImageIndex);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTab, files, currentImageIndex, handleRemoveImage, setCurrentImageIndex]);

  // Scroll sync for carousel - Auto-scroll active thumbnail into view
  useEffect(() => {
    if (activeTab === "images") {
      const element = document.getElementById(`thumbnail-btn-${currentImageIndex}`);
      if (element) {
        element.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      }
    }
  }, [currentImageIndex, activeTab]);

  const hasInFlightResults = results.some(r => {
    const st = String(r?.status || r?.result?.status || "").toLowerCase();
    return !r?.uiOverrideFailed && (st === "processing" || st === "queued" || st === "active");
  });

  const batchQueueFeedback = useMemo(() => {
    const total = files.length || 0;
    const statuses = results.map((r) => String(r?.status || r?.result?.status || "").toLowerCase());
    const queuedCount = statuses.filter((s) => s === "queued" || s === "waiting").length;
    const processingCount = statuses.filter((s) => s === "processing" || s === "active" || s === "staging" || s === "validating").length;

    const queuedResult = results.find((r) => {
      const s = String(r?.status || r?.result?.status || "").toLowerCase();
      return s === "queued" || s === "waiting";
    });

    const queuePositionRaw =
      queuedResult?.queuePosition ??
      queuedResult?.result?.queuePosition ??
      queuedResult?.meta?.queuePosition ??
      queuedResult?.result?.meta?.queuePosition ??
      queuedResult?.position ??
      queuedResult?.result?.position;

    const estimatedStartRaw =
      queuedResult?.estimatedStartSeconds ??
      queuedResult?.result?.estimatedStartSeconds ??
      queuedResult?.meta?.estimatedStartSeconds ??
      queuedResult?.result?.meta?.estimatedStartSeconds ??
      queuedResult?.etaSeconds ??
      queuedResult?.result?.etaSeconds;

    const queuePosition = Number.isFinite(Number(queuePositionRaw)) ? Number(queuePositionRaw) : undefined;
    const estimatedStartSeconds = Number.isFinite(Number(estimatedStartRaw)) ? Number(estimatedStartRaw) : undefined;

    let phaseState: BatchPhaseState;
    if (isUploading) {
      phaseState = "UPLOADING";
    } else if (runState === "running" && queuedCount > 0 && processingCount === 0) {
      phaseState = "QUEUE_WAIT";
    } else {
      phaseState = "PROCESSING";
    }

    const phaseProgress = runState === "done"
      ? 100
      : phaseState === "UPLOADING"
        ? 20
        : phaseState === "QUEUE_WAIT"
          ? 35
          : Math.max(40, Math.min(95, Math.round((Math.max(processingCount, 1) / Math.max(total, 1)) * 100)));

    return {
      total,
      queuedCount,
      phaseState,
      phaseProgress,
      queuePosition,
      estimatedStartSeconds,
    };
  }, [files.length, isUploading, results, runState]);

  const configuredImagesCount = useMemo(() => {
    if (!files.length) return 0;
    return files.reduce((count, _file, index) => {
      return imageValidationStatus(index) === "ok" ? count + 1 : count;
    }, 0);
  }, [files, imageValidationStatus]);

  const configuredProgressPct = useMemo(() => {
    if (!files.length) return 0;
    return Math.round((configuredImagesCount / files.length) * 100);
  }, [configuredImagesCount, files.length]);

  const [flashAssignedThumbnailIndex, setFlashAssignedThumbnailIndex] = useState<number | null>(null);
  const flashAssignedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashAssignedThumbnail = useCallback((index: number) => {
    setFlashAssignedThumbnailIndex(index);
    if (flashAssignedTimerRef.current) clearTimeout(flashAssignedTimerRef.current);
    flashAssignedTimerRef.current = setTimeout(() => {
      setFlashAssignedThumbnailIndex(null);
      flashAssignedTimerRef.current = null;
    }, 200);
  }, []);

  useEffect(() => {
    return () => {
      if (flashAssignedTimerRef.current) clearTimeout(flashAssignedTimerRef.current);
    };
  }, []);

  const quickAssignRoomType = useCallback((preset: "living_room" | "bedroom" | "kitchen" | "bathroom-1" | "exterior") => {
    if (!currentImageId) return;
    const assignedIndex = currentImageIndex;

    if (preset === "exterior") {
      setManualSceneTypesById(prev => ({ ...prev, [currentImageId]: "exterior" }));
      setImageSceneTypesById(prev => ({ ...prev, [currentImageId]: "exterior" }));
      setManualSceneOverrideById(prev => ({ ...prev, [currentImageId]: true }));
      setImageSkyReplacementById(prev => ({ ...prev, [currentImageId]: true }));
      setImageRoomTypesById(prev => ({ ...prev, [currentImageId]: "" }));
    } else {
      setManualSceneTypesById(prev => ({ ...prev, [currentImageId]: "interior" }));
      setImageSceneTypesById(prev => ({ ...prev, [currentImageId]: "interior" }));
      setManualSceneOverrideById(prev => ({ ...prev, [currentImageId]: true }));
      setImageSkyReplacementById(prev => ({ ...prev, [currentImageId]: false }));
      setImageRoomTypesById(prev => ({ ...prev, [currentImageId]: preset }));
    }

    flashAssignedThumbnail(assignedIndex);
    setCurrentImageIndex(i => Math.min(files.length - 1, i + 1));
  }, [currentImageId, currentImageIndex, files.length, flashAssignedThumbnail, setCurrentImageIndex]);

  const currentAssignedRoomType = currentImageId ? (imageRoomTypesById[currentImageId] || "") : "";
  const quickAssignButtonClass = (isAssigned: boolean) =>
    `rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
      isAssigned
        ? "border-green-500 bg-green-50 text-green-700"
        : "border-gray-300 bg-white text-slate-700 hover:bg-slate-50"
    }`;

  const buildPreviewImage = useCallback((index: number): PreviewModalImage | null => {
    if (!Number.isInteger(index) || index < 0 || index >= files.length) return null;

    const file = files[index];
    if (!file) return null;

    const result = results[index];
    const selectedStage = displayStageByIndex[index] as DisplayOutputKey | undefined;
    const preEditSnapshot = preEditStageUrlsRef.current[index] || { stage2: null, stage1B: null, stage1A: null };
    const resolved = resolveBestStageOutput(result, selectedStage, previewUrls[index] || null, {
      stage2: preEditSnapshot.stage2,
      stage1B: preEditSnapshot.stage1B,
      stage1A: preEditSnapshot.stage1A,
    });
    const bestDisplayUrl = resolved.url || previewUrls[index] || null;
    const enhancedUrl = withVersion(bestDisplayUrl, result?.version || result?.updatedAt) || bestDisplayUrl;

    const persistedOriginalUrl =
      result?.result?.originalImageUrl ||
      result?.originalImageUrl ||
      result?.result?.originalUrl ||
      result?.originalUrl ||
      null;
    const localOriginal =
      (file as any)?.__restored !== true &&
      previewUrls[index] &&
      previewUrls[index] !== RESTORED_PLACEHOLDER
        ? previewUrls[index]
        : undefined;
    const originalUrl = persistedOriginalUrl || localOriginal;
    const finalUrl = enhancedUrl || previewUrls[index];
    if (!finalUrl) return null;

    return {
      url: finalUrl,
      filename: file.name || `Image ${index + 1}`,
      originalUrl,
      index,
    };
  }, [displayStageByIndex, files, previewUrls, results]);

  const openPreviewImage = useCallback((index: number) => {
    const payload = buildPreviewImage(index);
    if (!payload) return;
    setPreviewImage(payload);
  }, [buildPreviewImage]);

  const goToPreviousPreviewImage = useCallback(() => {
    if (!previewImage) return;
    openPreviewImage(previewImage.index - 1);
  }, [openPreviewImage, previewImage]);

  const goToNextPreviewImage = useCallback(() => {
    if (!previewImage) return;
    openPreviewImage(previewImage.index + 1);
  }, [openPreviewImage, previewImage]);

  useEffect(() => {
    if (!previewImage) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        goToNextPreviewImage();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goToPreviousPreviewImage();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setPreviewImage(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goToNextPreviewImage, goToPreviousPreviewImage, previewImage]);

  // Debug: Log button visibility state
  React.useEffect(() => {
    if (results.length > 0) {
      const inFlightDetails = results.map((r, i) => ({
        index: i,
        status: r?.status,
        uiOverrideFailed: r?.uiOverrideFailed,
        isInFlight: !r?.uiOverrideFailed && ["processing", "queued", "active"].includes(String(r?.status || "").toLowerCase())
      })).filter(d => d.isInFlight);
      
      console.log('[BATCH][buttons-visibility]', { 
        runState, 
        hasInFlightResults, 
        buttonsVisible: runState === "done" && !hasInFlightResults,
        totalResults: results.length,
        inFlightCount: inFlightDetails.length,
        inFlightDetails: inFlightDetails.length > 0 ? inFlightDetails : 'none'
      });
    }
  }, [runState, hasInFlightResults, results]);

  return (
  <div className="w-full">
      {/* Hidden global file input for launchpad and other UI surfaces */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*"
        onChange={handleFileInputChange}
        className="hidden"
      />
      
      {/* Main header and tab navigation remain unchanged. No legacy bottom edit section. All region editing is handled in the RegionEditor modal. */}

      {/* Tab Content */}
  <div
    className={`relative w-full h-full overflow-hidden bg-white flex flex-col font-sans text-slate-900 ${activeTab === 'upload' ? 'px-8 py-6' : ''}`}
    style={{
      backgroundImage: "radial-gradient(circle, rgba(0,0,0,0.05) 1px, transparent 1px)",
      backgroundSize: "24px 24px",
    }}
  >
        
        {/* Upload Tab */}
        {activeTab === "upload" && (
          <div className="text-center relative z-10">
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Upload Your Images</h2>
            <p className="text-slate-600 mb-8">
              {files.length === 0 
                ? "Select multiple images to enhance in batch"
                : `${files.length} image${files.length === 1 ? '' : 's'} selected • Click below to add more from other folders`
              }
            </p>
            
            <Dropzone 
              onFilesSelected={(newFiles) => {
                setFiles(prev => [...prev, ...newFiles]);
                if (newFiles.length > 0) setActiveTab("images");
              }}
              maxFiles={50}
              maxSizeMB={15}
              className="bg-brand-800/20"
            />

            {files.length > 0 && (
              <div className="mt-8">
                <h3 className="text-lg font-medium text-slate-900 mb-4">
                  Selected Images ({files.length})
                </h3>
                
                {/* Room Linking Controls */}
                <div className="flex gap-2 mb-4 justify-center flex-wrap">
                  <button 
                    className="rounded-md border border-gray-600 px-3 py-1 text-sm text-white bg-gray-800 hover:bg-gray-700 disabled:opacity-50" 
                    onClick={assignRoomKey} 
                    disabled={selection.size === 0}
                    data-testid="button-assign-room"
                  >
                    📋 Link as same room…
                  </button>
                  <button 
                    className="rounded-md border border-gray-600 px-3 py-1 text-sm text-white bg-gray-800 hover:bg-gray-700 disabled:opacity-50" 
                    onClick={setAngleOrder} 
                    disabled={selection.size === 0}
                    data-testid="button-set-angle-order"
                  >
                    🔢 Set angle order…
                  </button>
                  <button 
                    className="rounded-md border border-slate-600 px-3 py-1 text-sm text-white bg-slate-800 hover:bg-slate-700 transition" 
                    onClick={clearAllFiles}
                    data-testid="button-clear-all"
                  >
                    🗑️ Clear All
                  </button>
                  {selection.size > 0 && (
                    <span className="text-xs text-gray-400 flex items-center">
                      {selection.size} selected
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                  {previewUrls.map((url, i) => (
                    <div 
                      key={i} 
                      className={`relative group cursor-pointer rounded-lg border-2 transition-all ${
                        selection.has(i) ? "border-brand-500 ring-2 ring-brand-500/30" : "border-gray-600"
                      }`}
                      onClick={() => toggleSelect(i)}
                      data-testid={`thumbnail-${i}`}
                    >
                      <img 
                        src={url} 
                        alt={`upload-${i}`} 
                        className="w-full h-24 object-cover rounded-lg"
                      />
                      
                      {/* Remove button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeFile(i);
                        }}
                        className="absolute top-1 right-1 w-6 h-6 bg-slate-800 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-slate-700 z-10"
                        data-testid={`button-remove-${i}`}
                        title="Remove image"
                      >
                        <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                      
                      {/* Selection indicator */}
                      {selection.has(i) && (
                        <div className="absolute top-1 left-1 w-5 h-5 bg-brand-light0 rounded-full flex items-center justify-center">
                          <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        </div>
                      )}
                      
                      {/* Room and angle badges */}
                      <div className="absolute bottom-1 left-1 flex flex-col gap-1">
                        {metaByIndex[i]?.roomKey && (
                          <span className="inline-block rounded-full bg-brand-accent text-white px-2 py-0.5 text-[10px] font-medium">
                            Room: {metaByIndex[i]?.roomKey}
                          </span>
                        )}
                        {metaByIndex[i]?.angleOrder && (
                          <span className="inline-block rounded-full bg-slate-600 text-white px-2 py-0.5 text-[10px] font-medium">
                            Angle {metaByIndex[i]?.angleOrder}
                          </span>
                        )}
                      </div>
                      
                      <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition-all rounded-lg flex items-end">
                        <div className="w-full p-2 text-white text-xs bg-gradient-to-t from-black to-transparent rounded-b-lg opacity-0 group-hover:opacity-100 transition-opacity">
                          {files[i].name}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => setActiveTab("images")}
                  className="mt-6 bg-action-600 text-white px-6 py-3 rounded-lg hover:bg-action-700 transition-colors font-medium"
                  data-testid="button-proceed-workspace"
                >
                  Next: Configure and Review
                </button>
              </div>
            )}
          </div>
        )}

        {/* Images Tab - Studio Layout */}
        {activeTab === "images" && (
          <div className="w-full h-full overflow-hidden flex flex-col bg-slate-100">
            <div className="w-full border-b border-slate-200 bg-white h-10 shrink-0 mb-0">
              <div className="flex items-center justify-center h-full gap-2 text-xs font-medium max-w-lg mx-auto">
                <div className="text-emerald-700 flex items-center gap-1"><span className="w-4 h-4 rounded-full bg-emerald-100 flex items-center justify-center">1</span> Upload</div>
                <div className="h-0.5 w-8 bg-slate-200 mx-2" />
                <div className="text-indigo-700 flex items-center gap-1 font-bold"><span className="w-4 h-4 rounded-full bg-indigo-100 flex items-center justify-center text-[10px]">2</span> Image Preparation</div>
                <div className="h-0.5 w-8 bg-slate-200 mx-2" />
                <div className="text-slate-500 flex items-center gap-1"><span className="w-4 h-4 rounded-full bg-slate-100 flex items-center justify-center text-[10px]">3</span> Enhance</div>
              </div>
            </div>

            {files.length === 0 ? (
              <div className="flex-1 overflow-auto p-8">
                <EmptyStateLaunchpad
                  onFileSelect={triggerFileSelector}
                  onFileDrop={handleFileDrop}
                  onSampleSelect={(sampleType) => {
                    console.log('[BatchProcessor] Sample selected:', sampleType);
                    toast({
                      title: "Sample images coming soon",
                      description: `${sampleType} sample will be available in the next release.`,
                    });
                  }}
                />
              </div>
            ) : (
              <div className="flex-1 min-h-0 w-full flex overflow-hidden">
                <aside className="w-80 h-full flex flex-col overflow-hidden bg-white border-r border-slate-200 p-3 pt-0">
                  <div className="space-y-3 flex-1 overflow-y-auto pr-1 pb-2">
                    <div className="flex items-start justify-between gap-2 sticky top-0 bg-white py-2 z-10">
                      <div>
                        <h2 className="text-lg font-semibold text-slate-900">Image Preparation</h2>
                        <p className="text-xs text-slate-600">Global settings for this batch.</p>
                      </div>
                      <button
                        onClick={() => setActiveTab("upload")}
                        className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                        type="button"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                        Upload
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        const checked = !declutter;
                        setDeclutter(checked);
                        setFurnitureReplacement(checked);
                      }}
                      className={`w-full rounded-lg border p-3 text-left text-sm space-y-1 transition-all ${declutter ? "border-action-500 bg-action-50 text-action-800" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"}`}
                    >
                      <p className="font-semibold">Declutter Mode</p>
                      <p className="text-xs">Removes furniture and clutter while preserving structure.</p>
                    </button>

                    <button
                      type="button"
                      onClick={() => setAllowStaging(!allowStaging)}
                      className={`w-full rounded-lg border p-3 text-left text-sm space-y-1 transition-all ${allowStaging ? "border-action-500 bg-action-50 text-action-800" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"}`}
                    >
                      <p className="font-semibold">Virtual Staging Mode</p>
                      <p className="text-xs">Adds staging to supported interior scenes.</p>
                    </button>

                    <div className="space-y-3 text-sm">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-slate-600" htmlFor="property-address-input">
                          Property Address
                        </label>
                        <input
                          id="property-address-input"
                          type="text"
                          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
                          value={propertyAddress}
                          onChange={(e) => setPropertyAddress(e.target.value)}
                          placeholder="e.g., 21 Smith Street"
                          data-testid="input-property-address"
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-xs font-medium text-slate-600" htmlFor="staging-style-select">
                          Staging Style
                        </label>
                        <select
                          id="staging-style-select"
                          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 disabled:bg-slate-100"
                          value={stagingStyle}
                          onChange={(e) => setStagingStyle(e.target.value as StagingStyle)}
                          data-testid="select-staging-style"
                          disabled={!allowStaging}
                        >
                          <option value="standard_listing">Standard Listing</option>
                          <option value="family_home">Family Home</option>
                          <option value="urban_apartment">Urban Apartment</option>
                          <option value="high_end_luxury">High-End Luxury</option>
                          <option value="country_lifestyle">Country / Lifestyle</option>
                          <option value="lived_in_rental">Lived-In / Rental</option>
                        </select>
                        <button
                          type="button"
                          onClick={() => setStagingStyle("standard_listing")}
                          className="mt-1 text-xs text-action-600 underline hover:text-action-700"
                        >
                          Reset to Standard Listing
                        </button>
                      </div>

                      <div>
                        <button
                          onClick={() => setShowSpecificRequirements(!showSpecificRequirements)}
                          className="flex w-full items-center justify-between rounded-md border border-slate-300 bg-white px-3 py-2 text-left text-sm text-slate-700 transition-colors hover:bg-slate-50"
                          data-testid="button-toggle-specific-requirements"
                          type="button"
                        >
                          <span>Specific Requirements</span>
                          <span className={`text-slate-400 transition-transform ${showSpecificRequirements ? "rotate-180" : ""}`}>▼</span>
                        </button>
                        {showSpecificRequirements && (
                          <textarea
                            className="mt-2 w-full rounded-md border border-slate-300 bg-white p-3 text-sm text-slate-700"
                            rows={3}
                            placeholder="e.g., Stage interiors, brighten rooms, greener lawn, blue sky without clouds..."
                            value={globalGoal}
                            onChange={(e) => setGlobalGoal(e.target.value)}
                            data-testid="textarea-global-goal"
                          />
                        )}
                      </div>
                    </div>
                  </div>
                </aside>

                <div className="flex-1 h-full min-h-0 px-5 flex flex-col overflow-hidden bg-slate-50">
                  <div className="flex items-center justify-between gap-3 shrink-0 py-1.5 z-10">
                    <div className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 shadow-sm">
                      Image {currentImageIndex + 1} of {files.length}
                    </div>
                    <div className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 shadow-sm">
                      {configuredImagesCount} / {files.length} configured
                    </div>
                  </div>

                  <div className="flex-1 flex flex-col justify-center items-center min-h-0 min-w-0 w-full mb-0">
                    <div className="flex-1 min-h-0 max-h-[65vh] w-full relative flex items-center justify-center rounded-2xl overflow-hidden bg-white border border-slate-200 shadow-sm">
                      <img
                        src={previewUrls[currentImageIndex]}
                        alt={files[currentImageIndex]?.name || `Image ${currentImageIndex + 1}`}
                        className="h-full w-auto object-contain rounded-2xl p-0.5"
                      />

                      <div className="absolute right-4 top-4 z-20">
                        <button
                          type="button"
                          onClick={() => handleRemoveImage(currentImageIndex)}
                          disabled={removeDisabled}
                          className="group flex h-8 w-8 items-center justify-center rounded-full border border-white/40 bg-slate-200/80 shadow-lg backdrop-blur-md transition-all duration-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                          title="Remove image"
                        >
                          <X className="h-4 w-4 text-slate-600 transition-transform group-hover:scale-110 group-hover:stroke-2 group-hover:text-white" />
                        </button>
                      </div>

                      <div className="absolute bottom-4 right-4 z-20">
                        <button
                          onClick={() => openPreviewImage(currentImageIndex)}
                          className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/10 text-white shadow-lg backdrop-blur-md transition-all hover:scale-105 hover:bg-white/20"
                          title="View fullscreen"
                        >
                          <Maximize2 className="h-4 w-4 drop-shadow-sm" />
                        </button>
                      </div>

                      {files.length > 1 && (
                        <>
                          <button
                            onClick={() => setCurrentImageIndex((i) => Math.max(0, i - 1))}
                            disabled={currentImageIndex === 0}
                            className="absolute left-2 top-1/2 z-20 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-900 shadow-xl transition-all hover:scale-105 hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-30"
                            aria-label="Previous image"
                          >
                            <ChevronLeft className="ml-0.5 h-5 w-5" />
                          </button>
                          <button
                            onClick={() => setCurrentImageIndex((i) => Math.min(files.length - 1, i + 1))}
                            disabled={currentImageIndex === files.length - 1}
                            className="absolute right-2 top-1/2 z-20 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-900 shadow-xl transition-all hover:scale-105 hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-30"
                            aria-label="Next image"
                          >
                            <ChevronRight className="ml-0.5 h-5 w-5" />
                          </button>
                        </>
                      )}
                    </div>

                    <div className="flex flex-col items-center space-y-2 mt-2 shrink-0">
                      {(() => {
                      const sceneType = currentImageId ? imageSceneTypesById[currentImageId] : undefined;
                      const sceneSelected = Boolean(sceneType);
                      const currentRoomType = currentImageId ? imageRoomTypesById[currentImageId] || "" : "";

                      return (
                        <>
                          <div className="flex gap-3 justify-center">
                            <button
                              type="button"
                              onClick={() => {
                                if (!currentImageId) return;
                                setManualSceneTypesById((prev) => ({ ...prev, [currentImageId]: "exterior" }));
                                setImageSceneTypesById((prev) => ({ ...prev, [currentImageId]: "exterior" }));
                                setManualSceneOverrideById((prev) => ({ ...prev, [currentImageId]: true }));
                                setImageSkyReplacementById((prev) => ({ ...prev, [currentImageId]: true }));
                              }}
                              className={`px-12 py-1.5 rounded-lg border text-sm font-medium min-w-[180px] transition-colors ${sceneType === "exterior" ? "border-indigo-500 bg-indigo-50 text-indigo-700 shadow-sm" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}
                            >
                              Exterior
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (!currentImageId) return;
                                setManualSceneTypesById((prev) => ({ ...prev, [currentImageId]: "interior" }));
                                setImageSceneTypesById((prev) => ({ ...prev, [currentImageId]: "interior" }));
                                setManualSceneOverrideById((prev) => ({ ...prev, [currentImageId]: true }));
                                setImageSkyReplacementById((prev) => ({ ...prev, [currentImageId]: false }));
                              }}
                              className={`px-12 py-1.5 rounded-lg border text-sm font-medium min-w-[180px] transition-colors ${sceneType === "interior" ? "border-indigo-500 bg-indigo-50 text-indigo-700 shadow-sm" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}
                            >
                              Interior
                            </button>
                          </div>

                          {!sceneSelected ? (
                            <p className="text-sm text-indigo-600 font-bold">Select interior or exterior for this image</p>
                          ) : sceneType === "exterior" ? (
                            <p className="text-sm text-emerald-600 font-bold">Ready. Move onto next image.</p>
                          ) : (
                            <div className="flex flex-col items-center gap-2">
                              <select
                                value={currentRoomType}
                                onChange={(e) => {
                                  if (!currentImageId) return;
                                  setImageRoomTypesById((prev) => ({ ...prev, [currentImageId]: e.target.value }));
                                  flashAssignedThumbnail(currentImageIndex);
                                }}
                                className="w-[320px] rounded-lg border px-4 py-1.5 text-sm bg-slate-800 text-white"
                              >
                                <option value="">Select room type...</option>
                                {INTERIOR_ROOM_TYPES.map((room) => (
                                  <option key={room.value} value={room.value}>
                                    {room.label}
                                  </option>
                                ))}
                              </select>
                              {!currentRoomType ? (
                                <p className="text-sm text-indigo-600 font-bold">*Select room type to continue</p>
                              ) : (
                                <p className="text-sm text-emerald-600 font-bold">Ready. Move onto next image.</p>
                              )}
                            </div>
                          )}
                        </>
                      );
                    })()}
                    </div>
                  </div>

                  <div className="w-full max-w-full overflow-x-auto mt-auto mt-1 pb-4 snap-x scroll-smooth shrink-0">
                    <div className="flex w-max min-w-full gap-3 px-1">
                      {files.map((file, idx) => {
                        const isCurrent = idx === currentImageIndex;
                        const needsRoomType = roomTypeRequiresInput(idx);
                        const fileId = getFileId(file);
                        const sceneType = imageSceneTypesById[fileId];
                        const roomType = imageRoomTypesById[fileId];

                        let label = "";
                        if (needsRoomType) {
                          label = "Assign Room Type";
                        } else if (sceneType === "exterior") {
                          label = "Exterior";
                        } else if (sceneType === "interior" && roomType) {
                          const roomObj = INTERIOR_ROOM_TYPES.find((r) => r.value === roomType);
                          label = roomObj ? roomObj.label : "Interior";
                        } else {
                          label = "Dining & Living";
                        }

                        return (
                          <button
                            key={idx}
                            id={`thumbnail-btn-${idx}`}
                            type="button"
                            onClick={() => setCurrentImageIndex(idx)}
                            className={`relative shrink-0 rounded-lg border overflow-hidden ${isCurrent ? "ring-2 ring-indigo-500 border-transparent" : "border-slate-300"} ${flashAssignedThumbnailIndex === idx ? "ring-2 ring-emerald-300 border-transparent" : ""}`}
                          >
                            <img
                              src={previewUrls[idx]}
                              alt={file.name || `Image ${idx + 1}`}
                              className="h-28 w-40 object-cover"
                              loading="lazy"
                            />
                            <div className="absolute inset-0 flex items-end pointer-events-none">
                              <div className="w-full bg-gradient-to-t from-black/95 via-black/60 to-transparent px-2 py-2 text-left leading-tight">
                                <span className={`block text-[12px] font-semibold tracking-wide drop-shadow-md ${needsRoomType ? "text-indigo-300" : "text-slate-50"}`}>
                                  {label}
                                </span>
                                <span className="block text-[10px] uppercase tracking-[0.08em] text-slate-200/90">
                                  {idx + 1} / {files.length}
                                </span>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {files.length > 0 && (
              <footer className="sticky bottom-0 mt-auto py-4 border-t border-slate-200 bg-white/80 backdrop-blur-md flex items-center justify-end px-8 z-50 gap-3 w-full shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] shrink-0">
                {isEnhanceCreditBlocked && (
                  <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-700" title="Not enough credits">
                    Batch requires {requiredBatchCredits} credits - you have {Math.max(0, Number(availableCredits ?? 0))} available.
                  </p>
                )}
                <button
                  onClick={handleStartEnhance}
                  disabled={!files.length || files.some((_file, index) => roomTypeRequiresInput(index)) || isEnhanceCreditBlocked}
                  title={files.some((_file, index) => roomTypeRequiresInput(index)) ? "Assign all room types to proceed" : undefined}
                  className="rounded-lg bg-gradient-to-r from-action-600 to-indigo-600 px-8 py-2 font-semibold text-white shadow-md transition-all hover:from-action-700 hover:to-indigo-700 hover:shadow-lg focus:ring-2 focus:ring-action-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 text-base flex items-center border border-transparent"
                  data-testid="button-proceed-enhance"
                  type="button"
                >
                  Start Enhancement
                </button>
              </footer>
            )}
          </div>
        )}

        {/* Enhance Tab - Premium Command Center */}
        {activeTab === "enhance" && (
          <div className="h-full bg-slate-50 relative pointer-events-auto overflow-x-hidden flex flex-col min-h-0">
            <style>{`@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
            <div
              className="absolute inset-0 opacity-40"
              style={{
                backgroundImage: `radial-gradient(circle, rgb(148 163 184) 1px, transparent 1px)`,
                backgroundSize: '24px 24px',
              }}
            />
            
            {(runState === "idle") ? (
              /* Idle State - "Ready to Start" similar to before but cleaner */
              <div className="bg-white rounded-xl shadow-lg p-8 max-w-4xl mx-auto mt-8">
                  <div className="text-center py-8">
                    <div className="text-6xl mb-4">✨</div>
                    <h3 className="text-xl font-medium text-gray-900 mb-2">
                      Ready to enhance {files.length} images
                    </h3>
                    <p className="text-gray-600 mb-6">
                      Industry: {industryMap[presetKey]} • Structure preserved • {allowStaging ? (furnitureReplacement ? "Furniture upgrade mode" : "Staging enabled") : "No staging"}
                    </p>
                    <button
                      onClick={handleStartEnhance}
                      disabled={!files.length || blockingCount > 0}
                      title={blockingCount ? `Complete required settings for ${blockingCount} image${blockingCount === 1 ? '' : 's'}.` : undefined}
                      className="bg-emerald-600 text-white px-8 py-4 rounded hover:bg-emerald-700 transition-colors font-medium text-lg disabled:opacity-50 disabled:cursor-not-allowed shadow-md"
                      data-testid="button-start-batch"
                    >
                      Process Batch #{Math.floor(Math.random() * 1000) + 2000} ({files.length} Images)
                    </button>
                    {isEnhanceCreditBlocked && (
                      <button
                        type="button"
                        onClick={() => openCreditGateModal(requiredBatchCredits, Math.max(0, Number(availableCredits ?? 0)))}
                        className="mt-3 text-xs text-amber-700 underline"
                        title="Not enough credits"
                      >
                        Batch requires {requiredBatchCredits} credits — you have {Math.max(0, Number(availableCredits ?? 0))} available
                      </button>
                    )}
                    {isCreditSummaryLoading && (
                      <p className="mt-2 text-xs text-slate-500">Checking available credits…</p>
                    )}
                    <p className="mt-4 text-xs text-slate-500">
                      Users are responsible for verifying that generated images accurately represent the property before use in marketing.
                    </p>
                    <div className="flex justify-center mt-4">
                      <button
                        onClick={() => setActiveTab("images")}
                        className="text-gray-500 hover:text-gray-700 text-sm"
                        data-testid="button-back-workspace"
                      >
                        ← Back to workspace
                      </button>
                    </div>
                  </div>
              </div>
            ) : (
             /* COMMAND CENTER VIEW */
             <div className="max-w-[1600px] mx-auto px-6 lg:px-8 py-8 relative z-10">
                
                {/* 1. Header Section */}
                <div className="sticky top-0 z-20 -mx-6 lg:-mx-8 px-6 lg:px-8 py-4 mb-8 bg-white/80 backdrop-blur border-b border-slate-200">
                  <div className="flex flex-col gap-4 md:flex-row md:justify-between md:items-center mb-4">
                    <div>
                        {(() => {
                          // ✅ FIX #2: Target-aware completion count
                          const completedCount = results.filter((r, idx) => {
                            if (!r) return false;
                            const status = String(r?.status || "").toLowerCase();
                            const failed = status === "failed";
                            const hasError = !!r?.error;
                            
                            // Calculate target stage for this image
                            const requestedStages = r?.requestedStages || r?.result?.requestedStages || {};
                            const sceneLabel = String(r?.meta?.scene?.label || r?.result?.meta?.scene?.label || "").toLowerCase();
                            const stagingAllowed = getPerImageStagingAllowed(r);
                            const requestedStage2 = requestedStages?.stage2 === true || requestedStages?.stage2 === "true";
                            const declutterRequested = getPerImageDeclutterRequested(r);
                            const stage2Expected = requestedStage2 && sceneLabel !== "exterior" && stagingAllowed;
                            
                            const targetStage: StageKey = stage2Expected ? "2" : declutterRequested ? "1B" : "1A";
                            
                            // Check if target URL is present
                            const stageMap = r?.stageUrls || r?.result?.stageUrls || {};
                            const stage2Url = stageMap?.['2'] || stageMap?.stage2 || null;
                            const stage1BUrl = stageMap?.['1B'] || stageMap?.['1b'] || stageMap?.stage1B || null;
                            const stage1AUrl = stageMap?.['1A'] || stageMap?.['1a'] || stageMap?.['1'] || stageMap?.stage1A || null;
                            
                            const targetUrlPresent = (
                              (targetStage === "2" && !!stage2Url) ||
                              (targetStage === "1B" && !!stage1BUrl) ||
                              (targetStage === "1A" && !!stage1AUrl)
                            );

                            const blockedStage = r?.blockedStage || r?.result?.blockedStage || r?.meta?.blockedStage || r?.result?.meta?.blockedStage || null;
                            const fallbackStage = r?.fallbackStage ?? r?.result?.fallbackStage ?? r?.meta?.fallbackStage ?? r?.result?.meta?.fallbackStage ?? null;
                            const resultStageNorm = String(r?.resultStage || r?.result?.resultStage || r?.finalStage || r?.result?.finalStage || "").toUpperCase();
                            const completedViaFallback = (status === "completed" || status === "complete") && !targetUrlPresent && !!(stage1AUrl || stage1BUrl || stage2Url) && !!(
                              blockedStage ||
                              fallbackStage ||
                              (targetStage === "2" && (resultStageNorm === "1A" || resultStageNorm === "1B"))
                            );
                            
                            // Count as complete if: reached target OR failed with fallback available
                            const failedWithFallback = (failed || hasError) && (stage1AUrl || stage1BUrl || stage2Url);
                            return targetUrlPresent || failedWithFallback || completedViaFallback;
                          }).length;
                          const total = files.length || 0;
                          const remaining = Math.max(total - completedCount, 0);
                          const isComplete = runState === 'done';
                          const title = isComplete ? "Image Enhancement Complete" : `Processing ${files.length} Images`;
                          const subtitle = isComplete
                            ? null
                            : `${remaining} image${remaining === 1 ? '' : 's'} remaining`;
                          return (
                            <>
                              <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">{title}</h1>
                              {subtitle && <p className="text-sm text-slate-500 mt-1">{subtitle}</p>}
                            </>
                          );
                        })()}
                    </div>
                    <div className="flex items-center gap-3 md:justify-end">
                        {runState === 'running' && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={cancelBatchProcessing}
                          >
                            Cancel Current Batch
                          </Button>
                        )}
                        {(runState === 'running' || isUploading) && (
                            <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">
                                <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                                {isUploading ? "Uploading" : "Optimizing"}
                            </span>
                        )}
                        {runState === 'done' && (
                            <>
                             <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">
                                <CheckCircle className="w-3 h-3 mr-2" />
                                Complete
                            </span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={handleRestart}
                              title="Clear results and start a new batch"
                            >
                              Start New Batch
                            </Button>
                            </>
                        )}
                        {/* Failsafe: Always show reset when there are results, even if stuck in weird state */}
                        {results.length > 0 && runState !== 'running' && runState !== 'done' && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleRestart}
                            title="Reset and clear all results"
                          >
                            Reset
                          </Button>
                        )}
                    </div>
                    </div>

                    {(runState === "running" || isUploading) && (
                      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                        <p className="text-sm font-semibold text-slate-900">{`Processing ${batchQueueFeedback.total} Images`}</p>
                        <div className="mt-3 h-2 rounded-full bg-slate-200 overflow-hidden">
                          <div
                            className="h-full bg-gradient-to-r from-blue-500 to-blue-600 transition-all duration-500"
                            style={{ width: `${batchQueueFeedback.phaseProgress}%` }}
                          />
                        </div>
                        <div className="mt-3 space-y-1 text-xs text-slate-600">
                          <p className={batchQueueFeedback.phaseState === "UPLOADING" ? "font-semibold text-slate-900" : ""}>
                            {BATCH_PHASE_LABELS.UPLOADING}
                          </p>
                          <p className={batchQueueFeedback.phaseState === "QUEUE_WAIT" ? "font-semibold text-slate-900" : ""}>
                            {BATCH_PHASE_LABELS.QUEUE_WAIT}
                          </p>
                          <p className={batchQueueFeedback.phaseState === "PROCESSING" ? "font-semibold text-slate-900" : ""}>
                            {BATCH_PHASE_LABELS.PROCESSING}
                          </p>
                        </div>
                        {batchQueueFeedback.phaseState === "QUEUE_WAIT" && (
                          <div className="mt-3 text-xs text-slate-600 space-y-1">
                            <p>Your batch has been added to the processing queue.</p>
                            {batchQueueFeedback.queuePosition !== undefined && (
                              <p>{`Position: ${batchQueueFeedback.queuePosition}`}</p>
                            )}
                            {batchQueueFeedback.estimatedStartSeconds !== undefined && (
                              <p>{`Estimated start: ~${batchQueueFeedback.estimatedStartSeconds}s`}</p>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* 2. Global Progress Bar */}
                    <div className="h-4 w-full rounded-full overflow-hidden bg-slate-200">
                     {/* Calculate total progress - use IIFE for clean variable scope */}
                     {(() => {
                         const completed = results.filter(r => (r?.result?.image || (r?.result?.imageUrl)) || r?.error).length;
                         const total = files.length || 1;
                         const pct = Math.round((completed / total) * 100);
                         const uploadPct = isUploading ? 10 : 0; 
                         const displayPct = isUploading ? 30 : Math.max(5, pct);
                         return (
                            <div 
                          className="h-full bg-gradient-to-r from-blue-500 to-blue-600 transition-all duration-500 ease-out" 
                                style={{ width: `${runState === 'done' ? 100 : displayPct}%` }}
                            />
                         );
                     })()}
                    </div>
                </div>

                  {/* 3. Gallery Grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {files.map((file, i) => {
                        const result = results[i];
                        const status = String(result?.status || result?.result?.status || "").toLowerCase();
                        const uiStatus = String(result?.uiStatus || result?.result?.uiStatus || "ok").toLowerCase();
                        const sceneLabel = String(
                          result?.meta?.scene?.label ||
                          result?.result?.meta?.scene?.label ||
                          result?.meta?.sceneType ||
                          result?.result?.meta?.sceneType ||
                          ""
                        ).toLowerCase();
                        const isExteriorScene = sceneLabel === "exterior" || sceneLabel.startsWith("exterior_");
                        const requestedStages = result?.requestedStages || result?.result?.requestedStages || {};
                        const requestedStage2 = requestedStages?.stage2 === true || requestedStages?.stage2 === "true";
                        const declutterRequested = getPerImageDeclutterRequested(result);
                        const stagingAllowed = getPerImageStagingAllowed(result);
                        const stage2SkippedByDesign = result?.meta?.stage2Skipped === true || result?.result?.meta?.stage2Skipped === true;
                        const stage2Expected = requestedStage2 && !isExteriorScene && stagingAllowed && !stage2SkippedByDesign;
                        const resultStage = (result?.resultStage || result?.result?.resultStage || result?.finalStage || result?.result?.finalStage || null) as StageKey | null;
                        const isRetrying = retryingImages.has(i) || retryLoadingImages.has(i);
                        const hasActiveEdit = editingImages.has(i);
                        const isEditComplete = !hasActiveEdit && (editCompletedImages.has(i)
                          || !!result?.editLatestUrl
                          || !!result?.result?.editLatestUrl
                          || result?.completionSource === "region-edit"
                          || result?.result?.completionSource === "region-edit");
                        const isEditing = hasActiveEdit;
                        const uiOverrideFailed = !!result?.uiOverrideFailed;
                        const autoInsertedStage1B = result?.meta?.autoInsertedStage1B === true
                          || result?.result?.meta?.autoInsertedStage1B === true;
                        if (autoInsertedStage1B && !autoFurnitureNoticeLoggedRef.current.has(i)) {
                          console.log("[UI_AUTO_FURNITURE_NOTICE_SHOWN]", {
                            index: i,
                            jobId: result?.jobId || result?.result?.jobId || null,
                          });
                          autoFurnitureNoticeLoggedRef.current.add(i);
                        }

                        // Stage URL resolution (supports new stage1A/1B keys)
                        const stageMap = result?.stageUrls || result?.result?.stageUrls || result?.stageOutputs || result?.result?.stageOutputs || {};
                        const preEditSnapshot = preEditStageUrlsRef.current[i] || null;
                        const stage2Url =
                          toDisplayUrl(stageMap?.['2']) ||
                          toDisplayUrl(stageMap?.[2]) ||
                          toDisplayUrl(stageMap?.stage2) ||
                          toDisplayUrl(result?.stage2Url) ||
                          toDisplayUrl(result?.result?.stage2Url) ||
                          toDisplayUrl(preEditSnapshot?.stage2) ||
                          null;
                        const stage1BUrl =
                          toDisplayUrl(stageMap?.['1B']) ||
                          toDisplayUrl(stageMap?.['1b']) ||
                          toDisplayUrl(stageMap?.stage1B) ||
                          toDisplayUrl(preEditSnapshot?.stage1B) ||
                          null;
                        const stage1AUrl =
                          toDisplayUrl(stageMap?.['1A']) ||
                          toDisplayUrl(stageMap?.['1a']) ||
                          toDisplayUrl(stageMap?.['1']) ||
                          toDisplayUrl(stageMap?.stage1A) ||
                          toDisplayUrl(preEditSnapshot?.stage1A) ||
                          null;

                        const finalResultUrl =
                          toDisplayUrl(result?.finalOutputUrl) ||
                          toDisplayUrl(result?.result?.finalOutputUrl) ||
                          toDisplayUrl(result?.resultUrl) ||
                          toDisplayUrl(result?.result?.resultUrl) ||
                          null;
                        const hasPreviewOutputs = !!(stage2Url || stage1BUrl || stage1AUrl);
                        const hasOutputs = hasPreviewOutputs || !!finalResultUrl;
                        let derivedUiStatus = uiStatus;
                        if (derivedUiStatus === "ok" && status === "failed" && hasOutputs) {
                          derivedUiStatus = "warning";
                        }
                        const isSuccessStatus = ["completed", "complete", "done"].includes(status);
                        if (isSuccessStatus && !finalResultUrl && hasPreviewOutputs) {
                          // Partial outputs arrived but final URL missing: treat as warning while still processing
                          derivedUiStatus = derivedUiStatus === "error" ? "error" : "warning";
                        }
                        const isError = (status === "failed") || derivedUiStatus === "error" || uiOverrideFailed;
                        // Determine target stage per image to avoid premature "Complete"
                        const targetStage: StageKey = (() => {
                          if (stage2Expected) return "2";
                          if (declutterRequested) return "1B";
                          return "1A";
                        })();

                        const targetUrlPresent = (() => {
                          if (targetStage === "2") return !!stage2Url;
                          if (targetStage === "1B") return !!stage1BUrl;
                          return !!stage1AUrl;
                        })();

                        const blockedStage = (result?.validation as any)?.blockedStage || (result?.result?.validation as any)?.blockedStage || result?.blockedStage || result?.result?.blockedStage || result?.meta?.blockedStage || null;
                        const fallbackStage = (result?.validation as any)?.fallbackStage || (result?.result?.validation as any)?.fallbackStage || result?.fallbackStage || result?.result?.fallbackStage || result?.meta?.fallbackStage || null;
                        const stageRank: Record<StageKey, number> = { "1A": 1, "1B": 2, "2": 3 };
                        const finalStageMeetsTarget = (() => {
                          if (!resultStage || !finalResultUrl) return false;
                          return stageRank[resultStage] >= stageRank[targetStage];
                        })();

                        const fallbackResolvedUrl = (() => {
                          if (fallbackStage === "1B" && stage1BUrl) return stage1BUrl;
                          if (fallbackStage === "1A" && stage1AUrl) return stage1AUrl;
                          if (stage1BUrl) return stage1BUrl;
                          if (stage1AUrl) return stage1AUrl;
                          return null;
                        })();
                        const fallbackTerminal = isSuccessStatus && !targetUrlPresent && !!fallbackResolvedUrl && !!(
                          blockedStage ||
                          fallbackStage ||
                          (targetStage === "2" && (resultStage === "1A" || resultStage === "1B"))
                        );

                        const resolvedFinalUrl = (finalResultUrl && finalStageMeetsTarget)
                          ? finalResultUrl
                          : (targetUrlPresent ? (targetStage === "2" ? stage2Url : targetStage === "1B" ? stage1BUrl : stage1AUrl) : (fallbackTerminal ? fallbackResolvedUrl : null));
                        const resolvedFinalStage: StageKey | null = (finalResultUrl && finalStageMeetsTarget)
                          ? (resultStage as StageKey | null)
                          : (targetUrlPresent ? targetStage : (fallbackTerminal ? ((fallbackStage === "1B" ? "1B" : fallbackStage === "1A" ? "1A" : (stage1BUrl ? "1B" : "1A")) as StageKey) : null));
                        const isDone = isSuccessStatus && !!resolvedFinalUrl && !isError;
                        const isUiComplete = (!isError && targetUrlPresent) || isDone;
                        
                        // ✅ FIX #3: Detect intermediate stage processing
                        // If backend says "completed" but we only have Stage 1A and targeting Stage 2, show as processing
                        const isIntermediateProcessing = isSuccessStatus && !targetUrlPresent && hasPreviewOutputs && !isError;
                        const intermediateStageMessage = (() => {
                          if (!isIntermediateProcessing) return null;
                          // Determine which stage we're waiting for
                          if (targetStage === "2") {
                            // Has Stage 1A, waiting for Stage 2
                            if (stage1AUrl && !stage1BUrl) return declutterRequested ? "Decluttering..." : "Preparing for staging...";
                            if (stage1BUrl && !stage2Url) return "Staging image...";
                          }
                          if (targetStage === "1B" && stage1AUrl && !stage1BUrl) {
                            return furnitureReplacement ? "Removing furniture..." : "Decluttering image...";
                          }
                          return "Processing next stage...";
                        })();
                        
                        const inFlightStatus = status === "processing" || status === "queued" || status === "active" || runState === 'running' || isUploading;
                        const isRetryActive = isRetrying || !!result?.retryInFlight;
                        const isProcessing = isEditing || isRetryActive || (!isUiComplete && !isError && (inFlightStatus || isIntermediateProcessing)) || (status === "queued" && hasPreviewOutputs);
                        const isStrictRetry = strictRetryingIndices.has(i);
                        const attempts = (result?.attempts || result?.result?.attempts || 1) as number;
                        const improvingMessage = stage2Expected
                          ? "Staging is being improved"
                          : declutterRequested
                          ? "Further decluttering required"
                          : "Enhancing";
                        const currentStage = normalizeCurrentStage(result?.currentStage || result?.result?.currentStage);
                        const displayStageKey = resolveDisplayStageKey({
                          status,
                          currentStage,
                          isDone,
                          isRetryActive,
                          isUploading,
                        });
                        const stageMessageKey = toProcessingMessageStage(displayStageKey);
                        const rotatingMessages = STAGE_MESSAGES[stageMessageKey] || STAGE_MESSAGES.stage1a;
                        const messageIndex = messageIndexByImage[i] ?? 0;
                        const rotatingMessage = rotatingMessages[messageIndex % rotatingMessages.length];
                        const stageProgressValue = isDone
                          ? 100
                          : (STAGE_PROGRESS[displayStageKey] ?? (isProcessing ? 35 : 0));
                        const stageTitle = isDone
                          ? STAGE_TITLES.completed
                          : (STAGE_TITLES[displayStageKey] || STAGE_TITLES.stage1a);
                        const baseProcessingMessage = (() => {
                          if (currentStage.includes("2")) return "Applying design...";
                          if (currentStage.includes("1b")) return furnitureReplacement ? "Removing furniture..." : "Simplifying space...";
                          if (currentStage.includes("1a")) return "Enhancing parameters...";
                          if (stage2Expected && requestedStage2) return "Applying design...";
                          if (declutterRequested) return furnitureReplacement ? "Removing furniture..." : "Simplifying space...";
                          return "Enhancing parameters...";
                        })();
                        const displayStatus = isError
                          ? "Enhancement Failed"
                          : result?.retryInFlight
                          ? getRetryStatusText(result?.retryStage)  // ✅ Show retry-specific message immediately
                          : isEditing
                          ? "Editing image..."  // ✅ Show explicit editing message
                          : isRetrying
                          ? "Retrying enhancement..."  // ✅ Show explicit retry message
                          : isIntermediateProcessing && intermediateStageMessage
                          ? intermediateStageMessage  // ✅ Show intermediate stage message
                          : isEditComplete
                          ? "Edit complete"
                          : isUiComplete
                          ? "Enhancement Complete"
                          : (isStrictRetry || attempts > 1)
                          ? improvingMessage
                          : isUploading
                          ? "Uploading..."
                          : isProcessing
                          ? baseProcessingMessage
                          : aiSteps[i] || "Waiting in queue...";
                        const hardFail = !!(result?.hardFail || result?.result?.hardFail);
                        const safeStage = resolveSafeStageUrl(result);
                        
                        // Image Preview Logic with stage preference (avoid failed/blocked outputs)
                        const disallowStage2 = (status === "failed") || !!blockedStage;
                        const stagePreviewUrl = safeStage.url || stage2Url || stage1BUrl || stage1AUrl || null;
                        const defaultStage: StageKey | undefined = safeStage.stage || (disallowStage2 ? (stage1BUrl ? "1B" : stage1AUrl ? "1A" : undefined) : (stage2Url ? "2" : stage1BUrl ? "1B" : stage1AUrl ? "1A" : undefined));
                        const editedUrl = toDisplayUrl(result?.editLatestUrl) || toDisplayUrl(result?.result?.editLatestUrl) || null;
                        const retriedUrl = toDisplayUrl(result?.retryLatestUrl) || toDisplayUrl(result?.result?.retryLatestUrl) || null;
                        const isRegionEditOutput = result?.completionSource === "region-edit" || result?.result?.completionSource === "region-edit";
                        const selectedStage = (() => {
                          const requested = displayStageByIndex[i] as DisplayOutputKey | undefined;
                          if (disallowStage2 && requested === "2") return defaultStage;
                          if (requested === "2" || requested === "1B" || requested === "1A" || requested === "retried" || requested === "edited") {
                            return requested;
                          }
                          if (isRegionEditOutput && editedUrl) return "edited";
                          if (!requested && retriedUrl) return "retried";
                          if (!requested && editedUrl) return "edited";
                          return requested || defaultStage;
                        })();
                        const stage1BLabel = "Decluttered";
                        const availableOutputs: { key: DisplayOutputKey; label: string; url: string | null }[] = (
                          [
                            stage2Url ? { key: "2" as DisplayOutputKey, label: "Staged", url: stage2Url } : null,
                            stage1BUrl ? { key: "1B" as DisplayOutputKey, label: stage1BLabel, url: stage1BUrl } : null,
                            stage1AUrl ? { key: "1A" as DisplayOutputKey, label: "Enhanced", url: stage1AUrl } : null,
                            retriedUrl ? { key: "retried" as DisplayOutputKey, label: "Retried", url: retriedUrl } : null,
                            editedUrl ? { key: "edited" as DisplayOutputKey, label: "Edited", url: editedUrl } : null,
                          ].filter(Boolean) as { key: DisplayOutputKey; label: string; url: string | null }[]
                        );
                        const defaultUrl = isDone ? (resolvedFinalUrl || stagePreviewUrl || previewUrls[i] || null) : (stagePreviewUrl || previewUrls[i] || null);
                        const displayedUrl = (() => {
                          if (!selectedStage) return defaultUrl;
                          if (selectedStage === "retried") return retriedUrl || defaultUrl;
                          if (selectedStage === "edited") return editedUrl || defaultUrl;
                          if (selectedStage === "2") return stage2Url || defaultUrl;
                          if (selectedStage === "1B") return stage1BUrl || defaultUrl;
                          if (selectedStage === "1A") return stage1AUrl || defaultUrl;
                          return defaultUrl;
                        })();
                        const bestAvailable = resolveBestStageOutput(result, selectedStage, previewUrls[i] || null, {
                          stage2: preEditSnapshot?.stage2 || null,
                          stage1B: preEditSnapshot?.stage1B || null,
                          stage1A: preEditSnapshot?.stage1A || null,
                        });
                        const bestDisplayUrl = bestAvailable.url || displayedUrl || previewUrls[i] || null;
                        const enhancedUrl = withVersion(bestDisplayUrl, result?.version || result?.updatedAt) || bestDisplayUrl;
                        const persistedOriginalUrl =
                          result?.result?.originalImageUrl ||
                          result?.originalImageUrl ||
                          result?.result?.originalUrl ||
                          result?.originalUrl ||
                          null;
                        const compareOriginalUrl = persistedOriginalUrl || (((file as any)?.__restored !== true && previewUrls[i] && previewUrls[i] !== RESTORED_PLACEHOLDER) ? previewUrls[i] : undefined);
                        const isNonTerminalProcessingStatus = ["queued", "uploading", "processing", "validating", "staging", "active", "waiting"].includes(status);
                        const canUseRemotePreview = status === "completed" || (status === "failed" && !!(resolvedFinalUrl || stagePreviewUrl || bestDisplayUrl));
                        const previewUrl = isNonTerminalProcessingStatus
                          ? (previewUrls[i] || null)
                          : canUseRemotePreview
                            ? (enhancedUrl || previewUrls[i] || null)
                            : (previewUrls[i] || null);
                        const canEditFromDisplayedOutput = !!previewUrl;

                        const stageBadgeLabel = (() => {
                          const artifactFinalLabel = stage2Url
                            ? "Staged"
                            : stage1BUrl
                              ? stage1BLabel
                              : "Enhanced";
                          
                          const stageLabel = selectedStage === "retried"
                            ? "Retried"
                            : selectedStage === "edited"
                              ? "Edited"
                              : selectedStage === "2" && stage2Url
                                ? "Staged"
                                : selectedStage === "1B"
                                  ? stage1BLabel
                                  : "Enhanced";
                          const finalStageLabel = artifactFinalLabel || stageLabel;
                          return isUiComplete ? `${finalStageLabel} (Final)` : `Preview • ${stageLabel}`;
                        })();

                        console.log('[ProcessingBatch] stage selection', {
                          index: i,
                          status,
                          isDone,
                          selectedStage: selectedStage || null,
                          displayedUrl: displayedUrl || null,
                          stage2Url: stage2Url || null,
                          stage1BUrl: stage1BUrl || null,
                          stage1AUrl: stage1AUrl || null,
                          finalResultUrl: finalResultUrl || null,
                          availableOutputs: availableOutputs.map(s => s.key),
                        });
                        if (stage2Url && !displayStageByIndex[i] && !isDone) {
                          console.assert(displayedUrl === stage2Url, "[DEV_ASSERT] Stage 2 should be the default when available", { index: i, displayedUrl, stage2Url });
                        }
                        
                        return (
                          <div 
                            key={i} 
                            className="group relative rounded-xl border border-slate-200 bg-white p-4 shadow-md hover:shadow-xl hover:-translate-y-[2px] transition-all duration-300 space-y-3"
                          >
                            {/* Thumbnail with Overlay */}
                            <div
                              className={`relative w-full aspect-[4/3] overflow-hidden rounded-lg bg-slate-100 border border-slate-100 cursor-pointer ${isDone ? 'ring-2 ring-emerald-500/30 transition-all duration-500' : ''}`}
                              onClick={() => {
                                if (!previewUrl) return;
                                openPreviewImage(i);
                              }}
                            >
                              <img 
                                src={previewUrl || ''} 
                                alt={file.name} 
                                className={`h-full w-full object-cover transition-opacity duration-500 ${isProcessing ? 'opacity-60' : 'opacity-100'}`}
                                onLoad={() => clearRetryFlags(i)}
                                onError={(e) => {
                                  clearRetryFlags(i);
                                  const localFallback = previewUrls[i] || "";
                                  if (localFallback && e.currentTarget.src !== localFallback) {
                                    e.currentTarget.src = localFallback;
                                  }
                                }}
                              />
                              {isProcessing && (
                                <div className="absolute inset-0 flex items-center justify-center bg-white/30 backdrop-blur-sm">
                                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent [background-size:200%_100%] animate-[shimmer_2s_infinite]" />
                                </div>
                              )}
                              {!isProcessing && isUiComplete && (
                                <div className="absolute inset-0 flex items-center justify-center bg-emerald-900/10 transition-opacity duration-500 animate-in fade-in zoom-in duration-300">
                                  <CheckCircle className="text-white w-6 h-6 shadow-sm drop-shadow-md" />
                                </div>
                              )}
                            </div>

                            {/* Info Column */}
                            <div className="space-y-2">
                              {isProcessing && !isError ? (
                                <div className="flex flex-col items-center justify-center mt-0 pt-2 pb-1">
                                  <Loader2 className="w-10 h-10 text-blue-600 animate-spin" />
                                  <p className="mt-1 text-base font-medium text-slate-700 text-center">
                                    {rotatingMessage}
                                  </p>
                                </div>
                              ) : (
                                <>
                                  <div className="flex justify-between items-center gap-3">
                                    <h3 className="font-semibold text-sm text-slate-900 truncate">{file.name}</h3>
                                    <span className="text-xs font-mono text-slate-500">
                                      {`${stageProgressValue}%`}
                                    </span>
                                  </div>
                                  {!isProcessing && stageTitle !== "Enhancement Complete" && !isUiComplete && (
                                    <p className="text-xs font-medium text-slate-700">{stageTitle}</p>
                                  )}
                                  
                                  {/* Status Badges */}
                                  <div className="flex items-center gap-3 mt-1.5 h-7">
                                    {isError ? (
                                        <div className="flex items-center gap-3">
                                          <StatusBadge status="failed" />
                                          <button
                                            onClick={() => handleOpenRetryDialog(i)}
                                            disabled={retryingImages.has(i)}
                                            className="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-medium text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 rounded-md transition-colors shadow-sm"
                                            title="Retry this image"
                                          >
                                            <RefreshCw className={`w-3 h-3 ${retryingImages.has(i) ? 'animate-spin' : ''}`} />
                                            Retry
                                          </button>
                                          {result.error && <span className="text-xs text-rose-600 truncate max-w-[200px]">{result.error}</span>}
                                        </div>
                                    ) : (isUiComplete || isEditComplete) ? (
                                       <div className="flex items-center gap-2">
                                         <StatusBadge status="completed" label={isEditComplete ? "Edit Complete" : "Enhancement Complete"} />
                                       </div>
                                    ) : (
                                      <StatusBadge status="queued" />
                                    )}
                                  </div>
                                  <p className="text-xs text-slate-500">
                                    {displayStatus}
                                  </p>
                                  {isError && (stage1BUrl || stage1AUrl) && stage2Expected && (
                                    <p className="mt-1 text-xs text-rose-600">
                                      {stage1BUrl ? "We couldn’t provide the staged image, but a decluttered image is available." : "We couldn’t provide the staged image, but an enhanced image is available."}
                                    </p>
                                  )}
                                  {autoInsertedStage1B && (
                                    <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-800">
                                      <Info className="mt-0.5 h-3.5 w-3.5 text-amber-600" />
                                      <div>
                                        <p>Furniture was automatically detected and removed before staging.</p>
                                        <p>An additional processing step was required, so 1 extra image credit was used.</p>
                                      </div>
                                    </div>
                                  )}
                                </>
                              )}

                              <div className="space-y-1.5">
                                <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${selectedStage === '2' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-50 text-slate-600 border border-slate-200'}`}>
                                  {stageBadgeLabel}
                                </span>
                                {availableOutputs.length > 1 && (
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="text-[11px] uppercase tracking-wide text-slate-500">Outputs:</span>
                                    {availableOutputs.map(({ key, label }) => (
                                      <button
                                        key={key}
                                        type="button"
                                        onClick={() => setDisplayStageByIndex(prev => ({ ...prev, [i]: key }))}
                                        className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold rounded border transition-colors ${selectedStage === key ? 'border-emerald-400 bg-emerald-50 text-emerald-700 shadow-sm' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
                                      >
                                        {label}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>

                              {(isProcessing || isUiComplete || isEditComplete) && (
                                <div className="mt-3 h-2 w-full rounded-full bg-slate-200 overflow-hidden">
                                  <div 
                                    className="h-full bg-gradient-to-r from-blue-500 to-blue-600 transition-all duration-500" 
                                    style={{ width: `${Math.max(0, Math.min(100, stageProgressValue))}%` }} 
                                  />
                                </div>
                              )}
                            </div>

                            {/* Action / Cancel Column */}
                            <div className="flex flex-wrap gap-2 pt-1">
                              {bestDisplayUrl && (isUiComplete || isError) && (
                                <>
                                  <button 
                                    onClick={() => openPreviewImage(i)}
                                    className="rounded-full px-4 py-2 text-xs font-semibold bg-gradient-to-r from-indigo-500 to-purple-500 text-white hover:opacity-90 transition"
                                  >
                                    Preview
                                  </button>
                                  <button 
                                    onClick={() => handleEditImage(i, previewUrl)}
                                    disabled={result?.retryInFlight || editingImages.has(i) || !canEditFromDisplayedOutput}
                                    className="rounded-full px-4 py-2 text-xs font-semibold border border-slate-300 hover:bg-slate-100 transition disabled:opacity-60 disabled:cursor-not-allowed"
                                  >
                                    Edit
                                  </button>
                                  {(isUiComplete || isEditComplete) && (
                                    <a
                                      href={enhancedUrl || previewUrl || "#"}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="rounded-full px-4 py-2 text-xs font-semibold border border-slate-300 hover:bg-slate-100 transition"
                                    >
                                      Download
                                    </a>
                                  )}
                                  <button
                                    onClick={() => handleOpenRetryDialog(i)}
                                    disabled={result?.retryInFlight || retryingImages.has(i) || editingImages.has(i)}
                                    className="rounded-full px-4 py-2 text-xs font-semibold border border-slate-300 hover:bg-slate-100 transition disabled:opacity-60 disabled:cursor-not-allowed"
                                    data-testid={`button-retry-${i}`}
                                  >
                                    {result?.retryInFlight || retryingImages.has(i) ? "Retrying..." : "Retry"}
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        );
                    })}
                </div>

                {/* Final Actions */}
                {runState === "done" && !hasInFlightResults && (
                  <div className="mt-8 flex flex-col items-center gap-3">
                    <p className="text-xs text-slate-500">Verify images before use in property marketing.</p>
                    <div className="flex justify-center gap-4">
                         <button 
                            onClick={downloadZip}
                            disabled={isDownloadingZip}
                            className="bg-emerald-600 text-white px-6 py-3 rounded-lg hover:bg-emerald-700 transition-colors font-medium shadow-sm flex items-center gap-2"
                        >
                            {isDownloadingZip && <Loader2 className="w-4 h-4 animate-spin"/>}
                            Download All (ZIP)
                        </button>
                        <button 
                            onClick={handleRestart}
                            className="bg-white border border-slate-300 text-slate-700 px-6 py-3 rounded-lg hover:bg-slate-50 transition-colors font-medium"
                        >
                            Start New Batch
                        </button>
                    </div>
                    </div>
                )}
                
                {/* Fallback: Show restart button if marked done but buttons are hidden (stuck state recovery) */}
                {runState === "done" && hasInFlightResults && (
                    <div className="mt-8 flex flex-col items-center gap-4">
                        <div className="text-center text-sm text-slate-600">
                            <p>Some images may still be processing. You can wait or start fresh.</p>
                        </div>
                        <button 
                            onClick={handleRestart}
                            className="bg-slate-600 text-white px-6 py-3 rounded-lg hover:bg-slate-700 transition-colors font-medium"
                        >
                            Clear & Start New Batch
                        </button>
                    </div>
                )}
                
             </div>
            )}
          </div>
        )}
      </div>

      {/* Preview/Edit Modals */}
      {previewImage && (
        <Modal isOpen={true} onClose={() => setPreviewImage(null)} maxWidth="full" contentClassName="max-w-7xl">
          {(() => {
            const previewEditSource = getEditSourceForIndex(previewImage.index);
            const canEditFromPreview = !!toDisplayUrl(previewImage.url) || !!previewEditSource.url;
            return (
          <div className="space-y-4">
            <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <h3 className="truncate text-lg font-semibold text-slate-900">{previewImage.filename}</h3>
                <p className="text-xs text-slate-500">{`Image ${previewImage.index + 1} of ${files.length}`}</p>
              </div>

              <div className="flex flex-wrap items-center gap-2 md:justify-end">
                <button
                  onClick={() => {
                    const index = previewImage.index;
                    setPreviewImage(null);
                    handleEditImage(index, previewImage.url);
                  }}
                  disabled={retryingImages.has(previewImage.index) || editingImages.has(previewImage.index) || !canEditFromPreview}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="button-edit-from-preview"
                >
                  Edit
                </button>
                <button
                  onClick={() => {
                    const index = previewImage.index;
                    setPreviewImage(null);
                    handleOpenRetryDialog(index);
                  }}
                  disabled={retryingImages.has(previewImage.index) || editingImages.has(previewImage.index)}
                  className="rounded-lg bg-action-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-action-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="button-retry-from-preview"
                >
                  Retry
                </button>
                <a
                  href={previewImage.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition"
                  data-testid="link-download-preview"
                >
                  Download
                </a>
                <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                  Enhanced ✓
                </span>
              </div>
            </div>

            <div className="group relative">
              <button
                type="button"
                onClick={goToPreviousPreviewImage}
                disabled={previewImage.index <= 0}
                className="absolute left-3 top-1/2 z-10 h-10 w-10 -translate-y-1/2 rounded-full bg-black/40 text-white backdrop-blur-sm transition-opacity hover:bg-black/55 opacity-0 group-hover:opacity-100 disabled:opacity-0 disabled:pointer-events-none"
                aria-label="Previous image"
              >
                <ChevronLeft className="mx-auto h-5 w-5" />
              </button>

              <button
                type="button"
                onClick={goToNextPreviewImage}
                disabled={previewImage.index >= files.length - 1}
                className="absolute right-3 top-1/2 z-10 h-10 w-10 -translate-y-1/2 rounded-full bg-black/40 text-white backdrop-blur-sm transition-opacity hover:bg-black/55 opacity-0 group-hover:opacity-100 disabled:opacity-0 disabled:pointer-events-none"
                aria-label="Next image"
              >
                <ChevronRight className="mx-auto h-5 w-5" />
              </button>

              {previewImage.originalUrl ? (
                <CompareSlider
                  originalImage={previewImage.originalUrl}
                  enhancedImage={previewImage.url}
                  height="80vh"
                  showLabels={true}
                  originalLabel="Original"
                  enhancedLabel="Enhanced ✨"
                  className="mx-auto"
                  data-testid="compare-slider-preview"
                />
              ) : (
                <img
                  src={previewImage.url}
                  alt={previewImage.filename}
                  className="max-h-[80vh] max-w-full mx-auto rounded border"
                  data-testid="img-preview-modal"
                  onError={(e) => {
                    console.error('[PREVIEW] Image failed to load:', {
                      url: previewImage.url,
                      filename: previewImage.filename,
                      error: e,
                    });
                  }}
                  onLoad={() => {
                    console.log('[PREVIEW] Image loaded successfully:', previewImage.url?.substring(0, 100));
                  }}
                />
              )}
            </div>
          </div>
            );
          })()}
        </Modal>
      )}

      {/* RegionEditor Modal - all edit controls and enlarged image are inside the modal */}
      {regionEditorOpen && editingImageIndex !== null && (
        <Modal isOpen={regionEditorOpen} onClose={() => { setRegionEditorOpen(false); if (editingImageIndex !== null) { setEditingImages(prev => { const next = new Set(prev); next.delete(editingImageIndex); return next; }); } setEditingImageIndex(null); setActiveEditSource(null); }} maxWidth="full" contentClassName="max-w-5xl h-[90vh] p-0 overflow-hidden" className="h-full m-0">
          <RegionEditor
            initialImageUrl={(() => {
              if (activeEditSource?.url) return activeEditSource.url;
              const item = results[editingImageIndex];
              if (!item) return undefined;
              
              // ✅ Use resolveSafeStageUrl for consistent stage-aware URL resolution
              // Priority: stage2 → stage1B → stage1A → publishedUrl → imageUrl
              const resolved = resolveSafeStageUrl(item);
              let imageUrl = resolved.url;
              
              // ✅ Apply version cache-busting if available
              if (imageUrl) {
                imageUrl = withVersion(imageUrl, item?.version || item?.updatedAt) || imageUrl;
              }
              
              // ✅ Fallback to preview URL if stage resolution failed
              const fallback = previewUrls[editingImageIndex] || undefined;
              const finalUrl = imageUrl || fallback;
              
              console.log('[EDIT][RegionEditor] Resolved initialImageUrl:', {
                resolvedStage: resolved.stage,
                hasUrl: !!imageUrl,
                hasFallback: !!fallback,
                finalUrlPreview: finalUrl ? finalUrl.substring(0, 100) : 'none'
              });
              
              return finalUrl;
            })()}
            editSourceUrl={activeEditSource?.url || undefined}
            editSourceStage={activeEditSource?.stage || undefined}
            sourceJobId={activeEditSource?.jobId || undefined}
            // ✅ Restore base: prefer explicit original, then stage1A quality-enhanced baseline
            originalImageUrl={(() => {
              const item = results[editingImageIndex];
              if (!item) return undefined;
              
              // Priority for restore base: explicitOriginal → stage1A → stage1B → preview
              const explicitOriginal = item?.result?.originalImageUrl || item?.originalImageUrl || item?.result?.originalUrl || item?.originalUrl;
              const stageUrls = item?.stageUrls || item?.result?.stageUrls || {};
              const stage1A = stageUrls?.['1A'] || stageUrls?.['1a'] || stageUrls?.['1'] || undefined;
              const stage1B = stageUrls?.['1B'] || stageUrls?.['1b'] || undefined;
              const previewFallback = previewUrls[editingImageIndex] || undefined;
              
              const resolved = explicitOriginal || stage1A || stage1B || previewFallback;
              
              console.log('[EDIT][RegionEditor] Resolved originalImageUrl:', {
                hasExplicitOriginal: !!explicitOriginal,
                hasStage1A: !!stage1A,
                hasStage1B: !!stage1B,
                hasPreview: !!previewFallback,
                resolvedPreview: resolved ? resolved.substring(0, 100) : 'none'
              });
              
              return resolved;
            })()}
            initialGoal={globalGoal}
            initialIndustry={industryMap[presetKey] || "Real Estate"}
            initialSceneType={(() => {
              const meta = results[editingImageIndex]?.meta || results[editingImageIndex]?.result?.meta || {};
              const sceneLabel = (meta?.scene?.label || meta?.sceneLabel || meta?.scene_type || meta?.sceneType || "").toString().toLowerCase();
              if (sceneLabel === "interior" || sceneLabel === "exterior") return sceneLabel as "interior" | "exterior";
              return "auto";
            })()}
            initialRoomType={(() => {
              const meta = results[editingImageIndex]?.meta || results[editingImageIndex]?.result?.meta || {};
              return meta?.roomType || meta?.room || meta?.room_type || undefined;
            })()}
            onStart={() => {
              // Force inline processing state immediately for every edit submit.
              const activeEditIndex = editingImageIndex;
              if (activeEditIndex != null && Number.isInteger(activeEditIndex) && activeEditIndex >= 0) {
                setEditingImages(prev => new Set(prev).add(activeEditIndex));
                setEditCompletedImages(prev => {
                  const next = new Set(prev);
                  next.delete(activeEditIndex);
                  return next;
                });
                setResults(prev => prev.map((r, i) => {
                  if (i !== activeEditIndex) return r;
                  return {
                    ...r,
                    status: "editing",
                    currentStage: "editing",
                    completionSource: null,
                    uiStatus: "ok",
                    error: null,
                    errorCode: undefined,
                    warnings: [],
                    progressLabel: "Editing image...",
                  } as any;
                }));
              }
              // Inline card indicators are used for edit progress; no extra popup state.
              setIsEditingInProgress(false);
            }}
            onJobStarted={(jobId: string) => {
              const activeEditIndex = editingImageIndex;
              if (activeEditIndex == null) {
                console.warn('[BatchProcessor] onJobStarted called but editingImageIndex is null');
                return;
              }
              console.log('[BatchProcessor] RegionEditor.onJobStarted', { jobId, editingImageIndex: activeEditIndex });

              // Close modal immediately after Enhance submits successfully
              setRegionEditorOpen(false);
              setEditingImageIndex(null);

              // Show inline per-image edit processing state
              setEditingImages(prev => new Set(prev).add(activeEditIndex));
              setEditCompletedImages(prev => {
                const next = new Set(prev);
                next.delete(activeEditIndex);
                return next;
              });
              setResults(prev => prev.map((r, i) => {
                if (i !== activeEditIndex) return r;
                return {
                  ...r,
                  status: "editing",
                  currentStage: "editing",
                  completionSource: null,
                  uiStatus: "ok",
                  error: null,
                  errorCode: undefined,
                  warnings: [],
                  progressLabel: "Editing image...",
                } as any;
              }));

              clearEditFallbackTimer(activeEditIndex);
              editFallbackTimersRef.current[activeEditIndex] = setTimeout(() => {
                if (!editingImagesRef.current.has(activeEditIndex)) return;
                console.warn('[edit-ui] fallback completion timer fired', { index: activeEditIndex, ms: EDIT_COMPLETE_FALLBACK_MS });
                setEditingImages(prev => {
                  const next = new Set(prev);
                  next.delete(activeEditIndex);
                  return next;
                });
                setEditCompletedImages(prev => new Set(prev).add(activeEditIndex));
                setResults(prev => prev.map((r, i) => {
                  if (i !== activeEditIndex) return r;
                  return {
                    ...r,
                    status: (String(r?.status || '').toLowerCase() === 'failed') ? r.status : 'completed',
                    completionSource: r?.completionSource || 'region-edit',
                    uiStatus: r?.uiStatus === 'error' ? 'error' : 'ok',
                  };
                }));
              }, EDIT_COMPLETE_FALLBACK_MS);

              // Prefer card-level spinner/status over popup dialog while processing
              setIsEditingInProgress(false);
              startRegionEditPolling(jobId, activeEditIndex);
            }}
            onComplete={(result: { imageUrl: string; originalUrl: string; maskUrl: string; mode?: string; shouldAutoClose?: boolean }) => {
              setIsEditingInProgress(false);
              if (typeof editingImageIndex === 'number' && Number.isInteger(editingImageIndex) && editingImageIndex >= 0) {
                clearEditFallbackTimer(editingImageIndex);
                const preservedOriginalUrl =
                  results[editingImageIndex]?.result?.originalImageUrl ||
                  results[editingImageIndex]?.result?.originalUrl ||
                  results[editingImageIndex]?.originalImageUrl ||
                  results[editingImageIndex]?.originalUrl;
                const preservedQualityEnhancedUrl = results[editingImageIndex]?.result?.qualityEnhancedUrl || results[editingImageIndex]?.qualityEnhancedUrl;
                
                // ✅ PATCH 1: Preserve original stage URLs - never overwrite stage baselines with edit outputs
                const existingStageUrls = results[editingImageIndex]?.stageUrls || results[editingImageIndex]?.result?.stageUrls || {};
                const stageSnapshot = preEditStageUrlsRef.current[editingImageIndex] || {};
                const preservedStage2 =
                  toDisplayUrl(existingStageUrls?.['2']) ||
                  toDisplayUrl(existingStageUrls?.[2]) ||
                  toDisplayUrl(existingStageUrls?.stage2) ||
                  toDisplayUrl(stageSnapshot.stage2) ||
                  null;
                const preservedStage1B =
                  toDisplayUrl(existingStageUrls?.['1B']) ||
                  toDisplayUrl(existingStageUrls?.['1b']) ||
                  toDisplayUrl(existingStageUrls?.stage1B) ||
                  toDisplayUrl(stageSnapshot.stage1B) ||
                  null;
                const preservedStage1A =
                  toDisplayUrl(existingStageUrls?.['1A']) ||
                  toDisplayUrl(existingStageUrls?.['1a']) ||
                  toDisplayUrl(existingStageUrls?.['1']) ||
                  toDisplayUrl(existingStageUrls?.stage1A) ||
                  toDisplayUrl(stageSnapshot.stage1A) ||
                  null;
                const preservedStageUrls = {
                  ...(existingStageUrls || {}),
                  '2': preservedStage2,
                  '1B': preservedStage1B,
                  '1A': preservedStage1A,
                  stage2: preservedStage2,
                  stage1B: preservedStage1B,
                  stage1A: preservedStage1A,
                };
                
                // ✅ Track edit lineage separately from stage pipeline
                const editHistory = results[editingImageIndex]?.editHistory || [];
                const updatedEditHistory = [
                  ...editHistory,
                  {
                    url: result.imageUrl,
                    ts: Date.now(),
                    maskUrl: result.maskUrl,
                    mode: result.mode || "region-edit"
                  }
                ];
                
                const mergedMeta = {
                  ...(results[editingImageIndex]?.meta || {}),
                  ...(results[editingImageIndex]?.result?.meta || {}),
                };
                
                setResults(prev => prev.map((r, i) =>
                  i === editingImageIndex ? {
                    ...r,
                    image: result.imageUrl,
                    imageUrl: result.imageUrl,
                    resultUrl: result.imageUrl,
                    version: Date.now(),
                    mode: result.mode,
                    originalImageUrl: preservedOriginalUrl,
                    qualityEnhancedUrl: preservedQualityEnhancedUrl,
                    
                    // ✅ Keep original stage URLs intact - never overwrite with edit outputs
                    stageUrls: preservedStageUrls,
                    
                    // ✅ Store edit lineage separately
                    editHistory: updatedEditHistory,
                    editLatestUrl: result.imageUrl,
                    
                    status: "completed",
                    uiStatus: "ok",
                    uiOverrideFailed: false,
                    error: null,
                    errorCode: undefined,
                    warnings: [],
                    resultStage: null, // ✅ Don't mark as stage2 - this is an edit
                    finalStage: null,
                    completionSource: "region-edit",
                    result: {
                      ...(normalizeBatchItem(result) || {}),
                      image: result.imageUrl,
                      imageUrl: result.imageUrl,
                      resultUrl: result.imageUrl,
                      originalImageUrl: preservedOriginalUrl,
                      qualityEnhancedUrl: preservedQualityEnhancedUrl,
                      stageUrls: preservedStageUrls, // ✅ Preserve original stage URLs
                      editLatestUrl: result.imageUrl,
                      status: "completed",
                      resultStage: null,
                      finalStage: null,
                      meta: mergedMeta,
                    },
                    filename: r?.filename
                  } : r
                ));
                setDisplayStageByIndex(prev => {
                  const next = { ...prev };
                  delete next[editingImageIndex];
                  return next;
                });
                setProcessedImagesByIndex(prev => ({ ...prev, [String(editingImageIndex)]: result.imageUrl }));
                setProcessedImages(prev => {
                  const newSet = new Set(prev);
                  newSet.add(result.imageUrl);
                  return Array.from(newSet);
                });
                toast({
                  title: 'Region edit complete',
                  description: `Image ${editingImageIndex + 1} edited successfully. You can do more edits or close the modal.`,
                });
              }
              refreshUser();
              
              // 🔒 Check shouldAutoClose flag from RegionEditor
              if (result.shouldAutoClose) {
                console.log('[BatchProcessor] Auto-closing region editor on successful completion');
                setRegionEditorOpen(false);
                setEditingImageIndex(null);
                setActiveEditSource(null);
                setEditingImages(prev => {
                  const next = new Set(prev);
                  if (editingImageIndex !== null) next.delete(editingImageIndex);
                  return next;
                });
              }
              // Otherwise keep modal open so user can do more edits
            }}
            onCancel={() => {
              setIsEditingInProgress(false);
              if (typeof editingImageIndex === 'number') {
                clearEditFallbackTimer(editingImageIndex);
                setEditingImages(prev => {
                  const next = new Set(prev);
                  next.delete(editingImageIndex);
                  return next;
                });
              }
              setRegionEditorOpen(false);
              setEditingImageIndex(null);
            }}
            onError={(errorMessage?: string) => {
              console.error('[batch-processor] Region edit error:', errorMessage);
              setIsEditingInProgress(false);
              if (typeof editingImageIndex === 'number') {
                clearEditFallbackTimer(editingImageIndex);
                setEditingImages(prev => {
                  const next = new Set(prev);
                  next.delete(editingImageIndex);
                  return next;
                });
              }
              setRegionEditorOpen(false);
              setEditingImageIndex(null);
              setActiveEditSource(null);
              // The error toast is already shown by RegionEditor, so we don't duplicate it here
            }}
          />
        </Modal>
      )}

      {/* Retry Dialog */}
      <RetryDialog
        isOpen={retryDialog.isOpen}
        onClose={handleCloseRetryDialog}
        onSubmit={handleRetrySubmit}
        isLoading={retryDialog.imageIndex !== null && retryingImages.has(retryDialog.imageIndex)}
        imageIndex={retryDialog.imageIndex || 0}
        originalImageUrl={retryDialog.imageIndex !== null ? (results[retryDialog.imageIndex]?.result?.originalImageUrl || results[retryDialog.imageIndex]?.originalImageUrl || previewUrls[retryDialog.imageIndex]) : undefined}
        enhancedImageUrl={retryDialog.imageIndex !== null ? withVersion(getDisplayUrl(results[retryDialog.imageIndex]), results[retryDialog.imageIndex]?.version || results[retryDialog.imageIndex]?.updatedAt) || undefined : undefined}
        defaultSceneType={retryDialog.imageIndex !== null ? (() => {
          const res = results[retryDialog.imageIndex];
          const sceneLabel = String(res?.meta?.scene?.label || res?.result?.meta?.scene?.label || imageSceneTypesById[getImageIdForIndex(retryDialog.imageIndex) || ""] || "auto").toLowerCase();
          return (sceneLabel === "interior" || sceneLabel === "exterior") ? (sceneLabel as any) : "auto";
        })() : "auto"}
        defaultRoomType={retryDialog.imageIndex !== null ? (() => {
          const imgId = getImageIdForIndex(retryDialog.imageIndex);
          return imgId ? (imageRoomTypesById[imgId] || "auto") : "auto";
        })() : "auto"}
      />

      <Dialog
        open={creditGateModal.open}
        onOpenChange={(open) => setCreditGateModal((prev) => ({ ...prev, open }))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Not enough credits to enhance this batch.</DialogTitle>
            <DialogDescription>
              Batch requires {creditGateModal.requiredCredits} credits — you have {creditGateModal.availableCredits} available.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              type="button"
              onClick={() => {
                window.open(addonHref, "_blank");
              }}
            >
              Buy Add-On Bundle
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                window.open(billingHref, "_blank");
              }}
            >
              Upgrade Plan
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Editing in Progress Alert */}
      {isEditingInProgress && (
        <Dialog open={true}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                Editing image as requested
              </DialogTitle>
              <DialogDescription>
                Please wait while we enhance your image with the requested changes...
              </DialogDescription>
            </DialogHeader>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// Lightweight inline dropdown component for scene override
function OverrideDropdown({ currentLabel, onSelect }: { currentLabel: string; onSelect: (label: string) => void | Promise<void> }) {
  const labels = [
    'exterior','living_room','kitchen','bathroom','bedroom','dining','twilight','floorplan','hallway','garage','balcony','other'
  ];
  const [open, setOpen] = React.useState(false);
  return (
    <div className="relative inline-block text-left">
      <button
        className="text-blue-600 hover:text-blue-700 text-sm font-medium underline"
        onClick={() => setOpen(v => !v)}
      >
        Change
      </button>
      {open && (
        <div className="absolute z-10 mt-2 w-48 rounded-md bg-white shadow-lg ring-1 ring-black ring-opacity-5">
          <div className="py-1 max-h-64 overflow-y-auto">
            {labels.map(l => (
              <button
                key={l}
                onClick={async () => { setOpen(false); await onSelect(l); }}
                className={`block w-full text-left px-3 py-2 text-sm hover:bg-gray-100 ${l===currentLabel ? 'font-semibold text-gray-900' : 'text-gray-700'}`}
              >
                {l.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
