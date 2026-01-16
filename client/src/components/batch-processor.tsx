// Client-side stub for room type detection (replace with real logic as needed)
  // Replaced by backend ML API call below
import React, { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FixedSelect, FixedSelectItem } from "@/components/ui/FixedSelect";
import { withDevice } from "@/lib/withDevice";
import { api, apiFetch, apiJson } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/context/AuthContext";
import { useAuthGuard } from "@/hooks/useAuthGuard";
import { Modal } from "./Modal";
import { EditModal } from "./EditModal";
import { CompareSlider } from "./CompareSlider";
import { RegionEditor } from "./region-editor";
import { RetryDialog } from "./retry-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dropzone } from "@/components/ui/dropzone";
import { ProcessingSteps, type ProcessingStep } from "@/components/ui/processing-steps";
import { Loader2, CheckCircle, XCircle, AlertCircle, Home, Armchair, ChevronLeft, ChevronRight, CloudSun, Info, Maximize2 } from 'lucide-react';
import { Switch } from "@/components/ui/switch";

type RunState = "idle" | "running" | "done";

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
  reason: "confident_interior" | "confident_exterior" | "uncertain";
  source?: "client" | "server";
};

const EMPTY_SCENE_FEATURES = { skyTop10: 0, skyTop40: 0, grassBottom: 0, blueOverall: 0, greenOverall: 0, meanLum: 0 };

// Clamp a number into [0,1]; return null when not finite
const clamp01 = (value: number | null | undefined): number | null => {
  if (!Number.isFinite(value as number)) return null;
  const v = Number(value);
  if (Number.isNaN(v)) return null;
  return Math.min(1, Math.max(0, v));
};

// Scene confidence guard (auto-accept only when >= guard)
// NOTE:
// If VITE_SCENE_CONF_THRESHOLD === 0,
// confidence does NOT gate auto-selection.
// Scene auto-select is based purely on LOW/HIGH hysteresis band.
const SCENE_CONFIDENCE_GUARD = (() => {
  const raw = Number((import.meta as any).env?.VITE_SCENE_CONF_THRESHOLD);
  const clamped = clamp01(raw);
  return clamped === null ? 0.75 : clamped;
})();

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
  const url = it.image || it.imageUrl || it.result?.imageUrl || (Array.isArray(it.images) && it.images[0]?.url) || null;
  if (it.error) return { ok: false, error: String(it.error), image: null };
  if (!url) return { ok: false, error: 'completed_no_url', image: null };
  return { ok: true, image: url };
}

function getDisplayUrl(data: any): string | null {
  return data?.image || data?.imageUrl || data?.result?.image || data?.result?.imageUrl || data?.result?.result?.imageUrl || null;
}

// Add cache-busting version to force browser reload (only when version exists)
function withVersion(url?: string | null, version?: string | number): string | null {
  if (!url) return null;
  // Only add version param if we have an explicit version (from retry/edit)
  // Don't use Date.now() as fallback - that would invalidate on every render
  if (!version) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${version}`;
}

// Batch job persistence interfaces and functions
interface PersistedFileMetadata {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

interface PersistedBatchJob {
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
    allowStaging: boolean;
    allowRetouch: boolean;
    outdoorStaging: string;
    furnitureReplacement: boolean;
    declutter: boolean;
    stagingStyle: string;
  };
  fileMetadata: PersistedFileMetadata[];
  jobIdToIndex: Record<string, number>;
}

const BATCH_JOB_KEY = "pmf_batch_job";
const ACTIVE_BATCH_KEY = "activeBatchJobIds";
const JOB_EXPIRY_HOURS = 24; // Jobs expire after 24 hours

// Stable placeholder for restored (non-image) file blobs so the UI never shows a broken icon
const RESTORED_PLACEHOLDER = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 90'><rect width='120' height='90' fill='%23e5e7eb'/><path d='M43 30h34l4 6h8a5 5 0 015 5v27a5 5 0 01-5 5H31a5 5 0 01-5-5V41a5 5 0 015-5h8l4-6z' fill='%23d1d5db'/><circle cx='60' cy='53' r='12' fill='%23cbd5e1'/><circle cx='60' cy='53' r='7' fill='%239ca3af'/><text x='50%' y='82%' dominant-baseline='middle' text-anchor='middle' font-family='Arial, sans-serif' font-size='10' fill='%239ca3af'>Preview</text></svg>";

function saveBatchJobState(state: PersistedBatchJob) {
  try {
    localStorage.setItem(BATCH_JOB_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn("Failed to save batch job state:", error);
  }
}

function loadBatchJobState(): PersistedBatchJob | null {
  try {
    const saved = localStorage.getItem(BATCH_JOB_KEY);
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

function clearBatchJobState() {
  try {
    localStorage.removeItem(BATCH_JOB_KEY);
    localStorage.removeItem(ACTIVE_BATCH_KEY);
    localStorage.removeItem("activeJobId");
  } catch (error) {
    console.warn("Failed to clear batch job state:", error);
  }
}

export default function BatchProcessor() {
    // Staging style preset for the batch - DEFAULT to NZ Standard Real Estate
    const [stagingStyle, setStagingStyle] = useState<string>("NZ Standard Real Estate");
  // Tab state for clean UI flow
  const [activeTab, setActiveTab] = useState<"upload" | "describe" | "images" | "enhance">("upload");
  const [isUploading, setIsUploading] = useState(false);
  
  const [files, setFiles] = useState<File[]>([]);
  const [globalGoal, setGlobalGoal] = useState("");
  const [preserveStructure, setPreserveStructure] = useState<boolean>(true);
  const presetKey = "realestate"; // Locked to Real Estate only
  const [showAdditionalSettings, setShowAdditionalSettings] = useState(false);
  const [runState, setRunState] = useState<RunState>("idle");

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

  const [jobId, setJobId] = useState<string>("");
  const [jobIds, setJobIds] = useState<string[]>([]); // multi-job batch ids
  const jobIdToIndexRef = useRef<Record<string, number>>({});
  const jobIdToImageIdRef = useRef<Record<string, string>>({});
  const [results, setResults] = useState<any[]>([]);
  const [progressText, setProgressText] = useState<string>("");
  const [lastDetected, setLastDetected] = useState<{ index: number; label: string; confidence: number } | null>(null);
  const [processedImages, setProcessedImages] = useState<string[]>([]); // Track processed image URLs for ZIP download
  const [processedImagesByIndex, setProcessedImagesByIndex] = useState<{[key: number]: string}>({}); // Track processed image URLs by original index
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  
  // Additional boolean flags for processing control
  const [allowStaging, setAllowStaging] = useState(true);
  const [allowRetouch, setAllowRetouch] = useState(true);
  const [outdoorStaging, setOutdoorStaging] = useState<"auto" | "none">("auto");
  const [furnitureReplacement, setFurnitureReplacement] = useState(true);
  // Declutter flag (drives Stage 1B in worker)
  const [declutter, setDeclutter] = useState<boolean>(false);
  const [declutterMode, setDeclutterMode] = useState<"light" | "stage-ready">("stage-ready");
  
  // Collapsible specific requirements
  const [showSpecificRequirements, setShowSpecificRequirements] = useState(false);
  
  // ZIP download loading state
  const [isDownloadingZip, setIsDownloadingZip] = useState(false);
  
  // Batch refine loading state
  const [isBatchRefining, setIsBatchRefining] = useState(false);
  const [hasRefinedImages, setHasRefinedImages] = useState(false);
  // Track cancellable job ids reported by the server (per-image jobs)
  const [cancelIds, setCancelIds] = useState<string[]>([]);
  
  // Preview/edit modal state
  const [previewImage, setPreviewImage] = useState<{ url: string, filename: string, originalUrl?: string, index: number } | null>(null);
  const [editingImageIndex, setEditingImageIndex] = useState<number | null>(null);
  const [regionEditorOpen, setRegionEditorOpen] = useState(false);
  const [retryingImages, setRetryingImages] = useState<Set<number>>(new Set());
  const [retryLoadingImages, setRetryLoadingImages] = useState<Set<number>>(new Set());
  const [editingImages, setEditingImages] = useState<Set<number>>(new Set());

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
  }, []);

  // Retry timeout safety (60 seconds max)
  const RETRY_TIMEOUT_MS = 60_000;
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
  
  // Images tab state
  const [imageSceneTypes, setImageSceneTypes] = useState<Record<number, string>>({});
  const [manualSceneTypes, setManualSceneTypes] = useState<Record<number, SceneLabel | null>>({});
  const [scenePredictions, setScenePredictions] = useState<Record<number, SceneDetectResult>>({});
  const [imageRoomTypes, setImageRoomTypes] = useState<Record<number, string>>({});
  const [imageSkyReplacement, setImageSkyReplacement] = useState<Record<number, boolean>>({});
  // Track manual scene overrides per-image (when user changes scene dropdown)
  const [manualSceneOverrideByIndex, setManualSceneOverrideByIndex] = useState<Record<number, boolean>>({});
  const [linkImages, setLinkImages] = useState<boolean>(false);
  // Studio view: current image being configured
  const [currentImageIndex, setCurrentImageIndex] = useState<number>(0);

  const manualSceneTypesRef = useRef<Record<number, SceneLabel | null>>({});
  const imageSceneTypesRef = useRef<Record<number, string>>({});
  const scenePredictionsRef = useRef<Record<number, SceneDetectResult>>({});
  useEffect(() => { manualSceneTypesRef.current = manualSceneTypes; }, [manualSceneTypes]);
  useEffect(() => { imageSceneTypesRef.current = imageSceneTypes; }, [imageSceneTypes]);
  useEffect(() => { scenePredictionsRef.current = scenePredictions; }, [scenePredictions]);

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

  // Industry mapping - locked to Real Estate only
  const industryMap: Record<string, string> = {
    "realestate": "Real Estate"
  };
  
  const { toast } = useToast();
  const { refreshUser } = useAuth();
  const { ensureLoggedInAndCredits } = useAuthGuard();

  const isSceneAutoAcceptable = (pred?: SceneDetectResult | null) => {
    if (!pred) return false;
    if (!pred.scene) return false;
    const conf = clamp01(pred.confidence);
    if (conf === null) return false;
    if (pred.reason === "uncertain") return false;
    return conf >= SCENE_CONFIDENCE_GUARD;
  };

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

      // Aggregate signal (pre-penalty)
      let signal = Math.max(
        features.skyTop10,
        features.skyTop40 * 0.9,
        features.grassBottom,
        features.blueOverall * 0.8,
        features.greenOverall * 0.8
      );

      // Contradiction penalties to push ambiguous cases to uncertain
      if (features.skyTop40 < 0.03 && features.blueOverall > 0.10) signal *= 0.7;
      if (features.grassBottom < 0.02 && features.greenOverall > 0.08) signal *= 0.8;
      if (features.meanLum > 0.70 && features.skyTop40 < 0.02) signal *= 0.85;

      // Two-threshold band decision
      let scene: SceneType | null = null;
      let reason: SceneDetectResult["reason"] = "uncertain";
      if (signal <= SCENE_SIGNAL_LOW) {
        scene = "interior";
        reason = "confident_interior";
      } else if (signal >= SCENE_SIGNAL_HIGH) {
        scene = "exterior";
        reason = "confident_exterior";
      }

      // Confidence based on distance from the uncertain band
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

  // When a brand-new file selection is made by the user (not a restore),
  // clear all per-image settings so previous batch state doesn't bleed over.
  function fingerprintFiles(list: File[]): string {
    return list.map((f: any) => `${f.name}:${f.size}:${f.lastModified}:${f.__restored ? 'R' : 'U'}`).join('|');
  }

  useEffect(() => {
    const fp = fingerprintFiles(files);
    if (fp !== filesFingerprintRef.current) {
      const userSelected = files.some(f => !(f as any).__restored);
      if (userSelected) {
        setImageSceneTypes({});
        setManualSceneTypes({});
        setImageRoomTypes({});
        setImageSkyReplacement({});
        setMetaByIndex({});
        setSelection(new Set());
        setManualSceneOverrideByIndex({});
        sceneDetectCacheRef.current = {};
      }
      filesFingerprintRef.current = fp;
    }
  }, [files]);

  // Cleanup retry timeout on unmount
  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    };
  }, []);

  // When user enters the Images tab, prefill scene predictions using client-side detector
  useEffect(() => {
    if (activeTab !== "images" || !files.length) return;
    let cancelled = false;
    console.log("[SceneDetect] starting auto-detect pass", { fileCount: files.length });
    (async () => {
      const nextPreds: Record<number, SceneDetectResult> = {};
      const skyDefaults: Record<number, boolean> = {};
      await Promise.all(files.map(async (f, i) => {
        if (cancelled) return;
        const manualScene = manualSceneTypesRef.current[i];
        if (manualScene) {
          console.log("[SceneDetect] skip manual scene", { index: i, scene: manualScene });
          return;
        }
        const explicit = imageSceneTypesRef.current[i];
        if (explicit && explicit !== "auto") {
          console.log("[SceneDetect] skip existing scene", { index: i, scene: explicit });
          return;
        }
        const existingPrediction = scenePredictionsRef.current[i];
        if (existingPrediction) {
          console.log("[SceneDetect] reuse cached prediction", { index: i, scene: existingPrediction.scene, source: existingPrediction.source });
          nextPreds[i] = existingPrediction;
          return;
        }
        const prediction = await detectSceneFromFile(f);
        if (!cancelled) {
          nextPreds[i] = prediction;
          if (isSceneAutoAcceptable(prediction) && prediction.scene && !manualSceneTypesRef.current[i]) {
            setImageSceneTypes(prev => {
              if (prev[i] && prev[i] !== "auto") return prev;
              return { ...prev, [i]: prediction.scene as string };
            });
            if (prediction.scene === "exterior" && imageSkyReplacement[i] === undefined) {
              skyDefaults[i] = true;
            }
          } else {
            setImageSceneTypes(prev => {
              const copy = { ...prev } as Record<number, string>;
              delete copy[i];
              return copy;
            });
          }
        }
      }));
      if (!cancelled && Object.keys(nextPreds).length) {
        setScenePredictions(prev => ({ ...prev, ...nextPreds }));
        if (Object.keys(skyDefaults).length) {
          setImageSkyReplacement(prev => ({ ...prev, ...skyDefaults }));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [activeTab, files]);

  const finalSceneForIndex = useCallback((index: number): SceneLabel | null => {
    const manual = manualSceneTypes[index];
    if (manual === "interior" || manual === "exterior") return manual;
    const explicit = imageSceneTypes[index];
    if (explicit === "interior" || explicit === "exterior") return explicit;
    const pred = scenePredictions[index];
    if (isSceneAutoAcceptable(pred) && pred?.scene) return pred.scene;
    return null;
  }, [imageSceneTypes, manualSceneTypes, scenePredictions]);

  const sceneRequiresInput = useCallback((index: number) => {
    const manual = manualSceneTypes[index];
    if (manual === "interior" || manual === "exterior") return false;
    const explicit = imageSceneTypes[index];
    if (explicit === "interior" || explicit === "exterior") return false;
    const pred = scenePredictions[index];
    if (isSceneAutoAcceptable(pred)) return false;
    return true; // no confident prediction and no user selection
  }, [imageSceneTypes, manualSceneTypes, scenePredictions]);

  const roomTypeRequiresInput = useCallback((index: number) => {
    if (!allowStaging) return false;
    const scene = finalSceneForIndex(index);
    if (scene === "exterior") return false;
    return !(imageRoomTypes[index]);
  }, [allowStaging, finalSceneForIndex, imageRoomTypes]);

  const imageValidationStatus = useCallback((index: number): "needs_input" | "ok" | "unknown" => {
    if (sceneRequiresInput(index) || roomTypeRequiresInput(index)) return "needs_input";
    const hasScene = !!finalSceneForIndex(index);
    const hasRoom = !!imageRoomTypes[index];
    return hasScene || hasRoom ? "ok" : "unknown";
  }, [finalSceneForIndex, imageRoomTypes, roomTypeRequiresInput, sceneRequiresInput]);

  const blockingIndices = useMemo(() => {
    const blockers: number[] = [];
    files.forEach((_, idx) => {
      if (imageValidationStatus(idx) === "needs_input") blockers.push(idx);
    });
    return blockers;
  }, [files, imageValidationStatus]);

  const recordScenePrediction = useCallback((index: number, prediction: SceneDetectResult) => {
    const normalized: SceneDetectResult = {
      scene: prediction?.scene ?? null,
      confidence: clamp01(prediction?.confidence) ?? 0,
      signal: clamp01(prediction?.signal) ?? 0,
      features: prediction?.features || EMPTY_SCENE_FEATURES,
      reason: prediction?.reason ?? "uncertain",
      source: prediction?.source || "server",
    };
    setScenePredictions(prev => ({ ...prev, [index]: normalized }));
    if (isSceneAutoAcceptable(normalized) && normalized.scene) {
      setImageSceneTypes(prev => {
        if (prev[index] && prev[index] !== "auto") return prev;
        return { ...prev, [index]: normalized.scene as string };
      });
      if (normalized.scene === "exterior" && imageSkyReplacement[index] === undefined) {
        setImageSkyReplacement(prev => ({ ...prev, [index]: true }));
      }
    }
  }, [imageSkyReplacement]);

  const blockingCount = blockingIndices.length;
  const firstBlockingIndex = blockingIndices[0] ?? 0;
  const currentFinalScene = finalSceneForIndex(currentImageIndex);

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
  // Build metaJson to send with the batch request
  const metaJson = useMemo(() => {
    // Build array of metadata for each image
    const arr: any[] = [];
    files.forEach((file, i) => {
      const metaItem: any = { index: i };
      // Room linking
      if (metaByIndex[i]?.roomKey) metaItem.roomKey = metaByIndex[i].roomKey;
      if (metaByIndex[i]?.angleOrder) metaItem.angleOrder = metaByIndex[i].angleOrder;
      // Scene type
        const sceneType = finalSceneForIndex(i) || "auto";
        if (sceneType !== "auto") metaItem.sceneType = sceneType;
        const pred = scenePredictions[i];
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
      if (manualSceneOverrideByIndex[i]) metaItem.manualSceneOverride = true;
      // Room type (only for interiors)
      if (allowStaging && (sceneType !== "exterior")) {
        const roomType = imageRoomTypes[i];
        if (roomType) metaItem.roomType = roomType;
      }
      // Sky replacement (only for exteriors)
      if (sceneType === "exterior" && imageSkyReplacement[i] !== undefined) {
        metaItem.replaceSky = imageSkyReplacement[i];
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
  }, [metaByIndex, files, finalSceneForIndex, imageSceneTypes, imageRoomTypes, imageSkyReplacement, manualSceneOverrideByIndex, linkImages, temperatureInput, topPInput, topKInput, results, allowStaging, samplingUiEnabled, scenePredictions]);

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
          copy[next.index] = {
            index: next.index,
            filename: next.filename,
            ok: !!norm?.ok,
            image: norm?.image || undefined,
            originalImageUrl: next.result?.originalImageUrl || next.result?.originalUrl || undefined,  // Preserve original URL for comparison slider
            error: next.error || norm?.error
          };
          return copy;
        });

        // If the server included job meta like scene detection, surface it
        if (next.result && next.result.meta && next.result.meta.scene) {
          const scene = next.result.meta.scene;
          const conf = clamp01(scene.confidence ?? null);
          recordScenePrediction(next.index, {
            scene: (scene.label as SceneLabel) ?? null,
            confidence: conf ?? 0,
            signal: clamp01(scene.signal ?? conf ?? null) ?? 0,
            features: scene.features || EMPTY_SCENE_FEATURES,
            reason: scene.reason || (scene.label ? (scene.label === "exterior" ? "confident_exterior" : "confident_interior") : "uncertain"),
            source: "server",
          });
          if (scene.label) {
            setProgressText(`Detected: ${scene.label} (${Math.round((conf || 0) * 100)}%)`);
            setLastDetected({ index: next.index, label: scene.label, confidence: conf || 0 });
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
    const savedState = loadBatchJobState();
    if (savedState) {
      console.log("Restoring batch job state:", savedState.jobId);
      setJobId(savedState.jobId);
      setJobIds(savedState.jobIds || (savedState.jobId ? [savedState.jobId] : []));
      setRunState(savedState.runState);
      setResults(savedState.results);
      setProcessedImages(savedState.processedImages);
      setProcessedImagesByIndex(savedState.processedImagesByIndex);
      jobIdToIndexRef.current = savedState.jobIdToIndex || {};
      if (!Object.keys(jobIdToIndexRef.current).length) {
        rebuildJobIndexMapping(savedState.jobIds, savedState.fileMetadata?.length || savedState.results?.length || 0);
      }
      setGlobalGoal(savedState.goal);
      setPreserveStructure?.(savedState.settings.preserveStructure);
      setAllowStaging(savedState.settings.allowStaging);
      setAllowRetouch?.(savedState.settings.allowRetouch);
      setOutdoorStaging(savedState.settings.outdoorStaging as "auto" | "none");
      setFurnitureReplacement(savedState.settings.furnitureReplacement ?? true);
      setDeclutter(savedState.settings.declutter ?? false);
      // DO NOT restore stagingStyle - always default to NZ Standard Real Estate
      // User must explicitly select a different style for each new session
      
      // Restore file metadata if available
      if (savedState.fileMetadata && savedState.fileMetadata.length > 0) {
        console.log("Restoring file metadata for", savedState.fileMetadata.length, "files");
        // Create placeholder File objects from metadata so the UI shows the upload queue
        const restoredFiles = savedState.fileMetadata.map((meta, index) => {
          // Create a minimal File-like object for display purposes
          const blob = new Blob([`Placeholder for ${meta.name}`], { type: meta.type });
          const file = new File([blob], meta.name, {
            type: meta.type,
            lastModified: meta.lastModified
          });
          // Add a flag to identify this as a restored file (for display only)
          (file as any).__restored = true;
          return file;
        });
        setFiles(restoredFiles);
      }
      
      // If the job was running, continue polling
      if (savedState.runState === "running") {
        setActiveTab("enhance");
        startPollingExistingBatch(savedState.jobIds && savedState.jobIds.length ? savedState.jobIds : [savedState.jobId]);
      } else if (savedState.runState === "done") {
        setActiveTab("enhance");
      }
    } else {
      // Fallback: check for active batch ids from enhanced polling (user may have navigated away)
      const activeBatchIdsRaw = localStorage.getItem(ACTIVE_BATCH_KEY);
      if (activeBatchIdsRaw) {
        try {
          const activeIds: string[] = JSON.parse(activeBatchIdsRaw);
          if (Array.isArray(activeIds) && activeIds.length) {
            console.log("Resuming polling for active batch:", activeIds);
            setJobId(activeIds[0]);
            setJobIds(activeIds);
            setRunState("running");
            setActiveTab("enhance");
            rebuildJobIndexMapping(activeIds, files.length || activeIds.length);
            startPollingExistingBatch(activeIds);
          }
        } catch {
          localStorage.removeItem(ACTIVE_BATCH_KEY);
        }
      }
    }
  }, []);

  // Auto-save state when key values change
  useEffect(() => {
    if (runState !== "idle" && (jobId || jobIds.length)) {
      const state: PersistedBatchJob = {
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
          stagingStyle
        },
        fileMetadata: files.map(file => ({
          name: file.name,
          size: file.size,
          type: file.type,
          lastModified: file.lastModified
        })),
        jobIdToIndex: { ...jobIdToIndexRef.current }
      };
      saveBatchJobState(state);
    }
  }, [jobId, jobIds, runState, results, processedImages, processedImagesByIndex, files, globalGoal, presetKey, preserveStructure, allowStaging, allowRetouch, outdoorStaging, furnitureReplacement, declutter, stagingStyle]);

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
    // Persist so we can resume after reload/nav
    localStorage.setItem("activeJobId", currentJobId);
    
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
          setRunState("idle");
          setAbortController(null);
          clearBatchJobState();
          localStorage.removeItem("activeJobId"); // Clear resume flag on terminal errors
          if (resp.status === 401) {
            return alert("Unable to process as you're not logged in. Please login and click retry to continue.");
          }
          if (resp.status === 404) {
            return alert("Batch job not found. Please try again.");
          }
          const err = await resp.json().catch(() => ({}));
          return alert(err.message || "Batch polling failed");
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
            if (item && item.status === 'completed' && !processedSetRef.current.has(i)) {
              processedSetRef.current.add(i);
              queueRef.current.push({
                index: i,
                result: { imageUrl: url, originalImageUrl: originalUrl, qualityEnhancedUrl: item.qualityEnhancedUrl, mode: item.mode, note: item.note, meta: item.meta },
                filename: item.filename || `image-${i + 1}`
              });
            } else if (item && item.status === 'failed' && !processedSetRef.current.has(i)) {
              processedSetRef.current.add(i);
              queueRef.current.push({
                index: i,
                error: item.error || "Processing failed",
                filename: item.filename || `image-${i + 1}`
              });
            }
            if (item?.meta?.scene) {
              const scene = item.meta.scene;
              const conf = clamp01(scene.confidence ?? null);
              recordScenePrediction(i, {
                scene: (scene.label as SceneLabel) ?? null,
                confidence: conf ?? 0,
                signal: clamp01(scene.signal ?? conf ?? null) ?? 0,
                features: scene.features || EMPTY_SCENE_FEATURES,
                reason: scene.reason || (scene.label ? (scene.label === "exterior" ? "confident_exterior" : "confident_interior") : "uncertain"),
                source: "server",
              });
            }
            // Merge room type detection (user override precedence)
            try {
              const detected = item?.meta?.roomTypeDetected || item?.meta?.roomType;
              if (detected) {
                setImageRoomTypes(prev => {
                  const current = prev[i];
                  if (!current || current === 'auto') {
                    setRoomTypeDetectionTick(tick => tick + 1); // Force re-render
                    return { ...prev, [i]: detected };
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
            setRunState('done');
            setAbortController(null);
            localStorage.removeItem('activeJobId');
            await refreshUser();
            setProgressText('Batch complete! 1 images enhanced successfully.');
            return;
          }
          if (['failed','error'].includes(data.status)) {
            setRunState('idle');
            setAbortController(null);
            localStorage.removeItem('activeJobId');
            setProgressText('Batch failed');
            return;
          }
        }
        
        if (data.done) {
          setRunState("done");
          setAbortController(null);
          localStorage.removeItem("activeJobId");
          await refreshUser(); // Refresh to show updated credits
          
          const completedCount = data.items ? data.items.filter((item: any) => item && item.status === 'completed').length : 0;
          setProgressText(`Batch complete! ${completedCount} images enhanced successfully.`);
          return;
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
    localStorage.setItem(ACTIVE_BATCH_KEY, JSON.stringify(ids));
    const MAX_POLL_MINUTES = 45;
    const MAX_POLL_MS = MAX_POLL_MINUTES * 60 * 1000;
    const BACKOFF_START_MS = 1000;
    const BACKOFF_MAX_MS = 5000;
    const BACKOFF_FACTOR = 1.5;
    let delay = BACKOFF_START_MS;
    const deadline = Date.now() + MAX_POLL_MS;

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
          setRunState("idle");
          setAbortController(null);
          localStorage.removeItem(ACTIVE_BATCH_KEY);
          localStorage.removeItem("activeJobId");
          // Fallback: if 404 (route missing on older deploy), poll per-id legacy endpoint
          if (resp.status === 404) {
            console.error("❌ BATCH STATUS 404 – WRONG ROUTE MATCH!", {
              url: `/api/status/batch?ids=${qs}`,
              status: resp.status,
              hint: "Check if Express is matching 'batch' as :jobId parameter"
            });
            await pollForBatchLegacy(ids, controller);
            return;
          }
          const err = await resp.json().catch(() => ({}));
          alert(err.message || "Batch polling failed");
          return;
        }
        const data = await resp.json();
        const items = Array.isArray(data.items) ? data.items : [];

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

        // progress
        const completed = items.filter((it: any) => it && it.status === 'completed').length;
        const total = ids.length;
        setProgressText(`Processing images: ${completed}/${total} completed`);

        // surface completed items (fix: resolve job index using id || jobId || job_id)
        for (const it of items) {
          const key = it?.id || it?.jobId || it?.job_id;
          const idx = key ? jobIdToIndexRef.current[key] : undefined;
          const url = it?.imageUrl || it?.resultUrl || it?.image || null;
          const originalUrl = it?.originalImageUrl || it?.originalUrl || it?.original || null;
          const status = String(it?.status || "").toLowerCase();
          const isCompleted = status === "completed" || status === "complete" || status === "done";

          if (typeof idx === "number" && isCompleted && !processedSetRef.current.has(idx)) {
            processedSetRef.current.add(idx);
            queueRef.current.push({
              index: idx,
              result: {
                imageUrl: url,
                originalImageUrl: originalUrl,
                qualityEnhancedUrl: null,
                mode: it.mode || "enhanced"
              },
              filename: files[idx]?.name || `image-${idx + 1}`
            });
          }

          if (typeof idx === "number" && status === "failed" && !processedSetRef.current.has(idx)) {
            processedSetRef.current.add(idx);
            queueRef.current.push({
              index: idx,
              result: null,
              error: it.error || it.message || "Edit failed",
              filename: files[idx]?.name || `image-${idx + 1}`
            });
          }
        }
        schedule();

        if (data.done) {
          setRunState("done");
          setAbortController(null);
          await refreshUser();
          setProgressText(`Batch complete! ${items.filter((i:any)=>i.status==='completed').length} images enhanced successfully.`);
          localStorage.removeItem(ACTIVE_BATCH_KEY);
          localStorage.removeItem("activeJobId");
          return;
        }

        delay = Math.max(BACKOFF_START_MS, Math.floor(delay / BACKOFF_FACTOR));
      } catch (e:any) {
        if (e.name === 'AbortError') return;
        delay = Math.min(BACKOFF_MAX_MS, Math.floor(delay * BACKOFF_FACTOR));
      }
      await new Promise(r => setTimeout(r, delay));
    }
    localStorage.removeItem(ACTIVE_BATCH_KEY);
    localStorage.removeItem("activeJobId");
  };

  // Helper: start polling a single region-edit job via the global batch status endpoint
  const startRegionEditPolling = async (jobId: string, imageIndex: number) => {
    console.log('[BatchProcessor] startRegionEditPolling', { jobId, imageIndex });

    // Map this jobId to the relevant image index so pollForBatch knows where to route results
    jobIdToIndexRef.current[jobId] = imageIndex;

    const controller = new AbortController();
    setAbortController(controller);

    try {
      await pollForBatch([jobId], controller);
    } finally {
      // Regardless of outcome, clear editing UI state
      setIsEditingInProgress(false);
      setRegionEditorOpen(false);
      setEditingImageIndex(null);
    }
  };

  // Legacy per-id polling fallback if /api/status/batch is unavailable
  const pollForBatchLegacy = async (ids: string[], controller: AbortController) => {
    const MAX_POLL_MS = 45 * 60 * 1000;
    const BACKOFF_START_MS = 1000, BACKOFF_MAX_MS = 5000, BACKOFF_FACTOR = 1.5;
    let delay = BACKOFF_START_MS; const deadline = Date.now() + MAX_POLL_MS;
    localStorage.setItem(ACTIVE_BATCH_KEY, JSON.stringify(ids));
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
            queueRef.current.push({ index: idx, result: { imageUrl: it.imageUrl || null, mode: 'enhanced' }, filename: files[idx]?.name || `image-${idx+1}` });
          }
          if (typeof idx === 'number' && it.status === 'failed' && !processedSetRef.current.has(idx)) {
            processedSetRef.current.add(idx);
            queueRef.current.push({ index: idx, error: 'Processing failed', filename: files[idx]?.name || `image-${idx+1}` });
          }
        }
        schedule();
        if (completed === ids.length) {
          setRunState('done'); setAbortController(null); await refreshUser();
          localStorage.removeItem(ACTIVE_BATCH_KEY);
          localStorage.removeItem("activeJobId");
          return;
        }
        delay = Math.max(BACKOFF_START_MS, Math.floor(delay / BACKOFF_FACTOR));
      } catch (e:any) {
        if (e.name === 'AbortError') return;
        delay = Math.min(BACKOFF_MAX_MS, Math.floor(delay * BACKOFF_FACTOR));
      }
      await new Promise(r=>setTimeout(r, delay));
    }
    localStorage.removeItem(ACTIVE_BATCH_KEY);
    localStorage.removeItem("activeJobId");
  };

  // Cancel entire batch: abort client polling and notify server to cancel queued jobs
  const cancelBatchProcessing = async () => {
    try {
      if (abortController) {
        abortController.abort();
        setAbortController(null);
      }
      const ids = cancelIds;
      if (ids.length) {
        await fetch(api('/api/jobs/cancel-batch'), withDevice({
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids })
        }));
      }
      setRunState("idle");
      setProgressText("Cancelled");
      localStorage.removeItem("activeJobId");
      localStorage.removeItem(ACTIVE_BATCH_KEY);
      toast({ title: 'Batch cancelled', description: ids.length ? `Requested cancel for ${ids.length} job(s).` : 'Stopped polling.' });
    } catch (e: any) {
      toast({ title: 'Cancel failed', description: e?.message || 'Unable to cancel batch on server', variant: 'destructive' });
    }
  };


  const startBatchProcessing = async () => {
    // Guard: no files, no spin
    if (!files.length) {
      alert("Please choose images first.");
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

    // Calculate credits needed based on two-stage system:
    // - Quality-only (no staging): 1 credit/image
    // - Staged (quality + staging): 2 credits/image
    const creditsPerImage = allowStaging ? 2 : 1;
    const totalCreditsNeeded = files.length * creditsPerImage;
    
    try {
      // Ensure signed in AND have enough credits (handles both in one call)
      await ensureLoggedInAndCredits(totalCreditsNeeded);
    } catch (e: any) {
      if (e.code === "INSUFFICIENT_CREDITS") {
        const more = e.needed || totalCreditsNeeded;
        const goBuy = confirm(
          `You need ${more} more credits to process ${files.length} images (${creditsPerImage} credit${creditsPerImage > 1 ? 's' : ''}/image). Buy credits now?`
        );
        if (goBuy) {
          // open checkout in a new tab; keep this page to preserve files
          window.open("/buy-credits", "_blank");
        }
        return;
      }
      alert(e.message || "Unable to start batch - please sign in and try again.");
      return;
    }

    // Start SSE batch processing
    setRunState("running");
    // Pre-size results array with nulls for immediate placeholder rendering
    setResults(Array.from({ length: files.length }, () => null));
    setProgressText("");
    setJobId("");
    setJobIds([]);
    setProcessedImages([]);
    setProcessedImagesByIndex({});
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
    if (declutter) {
      fd.append("declutterMode", declutterMode);
      console.log("[upload] UI sending options:", { declutter, declutterMode, allowStaging });
    }
    fd.append("outdoorStaging", outdoorStaging);
    // NEW: Manual room linking metadata
    fd.append("metaJson", metaJson);
    
    try {
      setIsUploading(true);
      // Phase 1: Start batch processing with files
      const uploadResp = await fetch(api("/api/upload"), {
        method: "POST",
        body: fd,
        credentials: "include",
        headers: withDevice().headers,
        signal: controller.signal
      });

      if (!uploadResp.ok) {
        setIsUploading(false);
        setRunState("idle");
        if (uploadResp.status === 401) {
          return alert("Unable to process as you're not logged in. Please login and click retry to continue.");
        }
        const err = await uploadResp.json().catch(() => ({}));
        return alert(err.message || "Failed to upload files");
      }

  const uploadResult = await uploadResp.json();
  setIsUploading(false);
  const jobs = Array.isArray(uploadResult.jobs) ? uploadResult.jobs : [];
  if (!jobs.length) throw new Error("Upload response missing jobs");
  const ids = jobs.map((j:any)=>j.jobId).filter(Boolean);
  setJobIds(ids);
  setCancelIds(ids);
  jobIdToIndexRef.current = {};
  jobIdToImageIdRef.current = {};
  jobs.forEach((j:any, i:number) => { jobIdToIndexRef.current[j.jobId] = i; jobIdToImageIdRef.current[j.jobId] = j.imageId; });
      
  // Phase 2: Poll multi-job status
  await pollForBatch(ids, controller);
      
    } catch (error: any) {
      setIsUploading(false);
      setRunState("idle");
      setProgressText("");
      setAbortController(null);
      if (error.name !== 'AbortError') {
        console.error("Batch processing error:", error);
        return alert(error.message || "Failed to start batch processing");
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
        // Mirror gallery display logic: processedImagesByIndex first, then fallback to getDisplayUrl
        const imageUrl = processedImagesByIndex[i] ?? getDisplayUrl(results[i]);
        
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
            const response = await fetch(item.url);
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
    // Manual room linking metadata (for retry)
    fd.append("metaJson", metaJson);

    try {
      const res = await fetch(api("/api/upload"), withDevice({
        method: "POST",
        body: fd,
        credentials: "include"
      }));
      
      if (!res.ok) {
        setRunState("done");
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

  const handleRetrySubmit = async (customInstructions: string, sceneType: "auto" | "interior" | "exterior", allowStaging: boolean, furnitureReplacementMode: boolean, roomType?: string, windowCount?: number, referenceImage?: File) => {
    if (retryDialog.imageIndex === null) return;
    
    const imageIndex = retryDialog.imageIndex;
    
    // Close dialog immediately and start retry process
    handleCloseRetryDialog();
    
    try {
      await handleRetryImage(imageIndex, customInstructions, sceneType, allowStaging, furnitureReplacementMode, roomType, windowCount, referenceImage);
    } catch (error) {
      // Error is already handled in handleRetryImage
    }
  };

  // Handle edit image - just open the modal (don't add to editing set yet)
  const handleEditImage = (imageIndex: number) => {
    setEditingImageIndex(imageIndex);
    setRegionEditorOpen(true);
    // Always use the latest enhanced image for modal preview
    // Use result.imageUrl if available, fallback to processedImagesByIndex, then results.imageUrl
    const latestEnhancedUrl = results[imageIndex]?.result?.imageUrl || processedImagesByIndex[imageIndex] || results[imageIndex]?.imageUrl;
    // Wire RegionEditor modal props below
    // The modal should call onComplete with the new imageUrl, which updates results
    // The handleRegionEdit logic is now handled inside RegionEditor via mutation
    // Pass latestEnhancedUrl and originalImageUrl to RegionEditor
  };

  const handleRetryImage = async (imageIndex: number, customInstructions?: string, sceneType?: "auto" | "interior" | "exterior", allowStagingOverride?: boolean, furnitureReplacementOverride?: boolean, roomType?: string, windowCount?: number, referenceImage?: File) => {
    // ✅ Prevent double retry on same image
    if (!files || imageIndex >= files.length || retryingImages.has(imageIndex)) return;

    const fileToRetry = files[imageIndex];
    if (!fileToRetry) return;

    // Check if this is a synthetic placeholder file created from batch persistence
    const isPlaceholder = (fileToRetry as any).__restored === true;
    const originalFromStoreUrl = results[imageIndex]?.result?.originalImageUrl || results[imageIndex]?.originalImageUrl;

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
        const resp = await fetch(originalFromStoreUrl);
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
          window.open("/buy-credits", "_blank");
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
    
    try {
      // Determine explicit scene type - prefer provided, then metadata, then auto
      const explicitScene = sceneType || imageSceneTypes[imageIndex] || "auto";
      
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

      try {
        const response = await fetch(api("/api/batch/retry-single"), withDevice({
          method: "POST",
          body: fd,
          credentials: "include"
        }));

        if (!response.ok) {
          if (response.status === 402) {
            const err = await response.json().catch(() => ({}));
            const goBuy = confirm("You need 1 more credit to retry this image. Buy credits now?");
            if (goBuy) {
              window.open("/buy-credits", "_blank");
            }
            return;
          }
          const err = await response.json().catch(() => ({}));
          // Handle retry-specific compliance failures
          if (err.code === "RETRY_COMPLIANCE_FAILED") {
            const violationDetails = err.reasons?.join(", ") || "structural preservation requirements";
            toast({
              title: "Cannot generate different result",
              description: `The AI cannot create a compliant variation due to ${violationDetails}. Try adjusting your settings or using a different approach. No credit was charged.`,
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
              if (job && job.status === "completed" && job.imageUrl) {
                // ✅ Clear timeout on success (spinner stays until onLoad)
                if (retryTimeoutRef.current) {
                  clearTimeout(retryTimeoutRef.current);
                  retryTimeoutRef.current = null;
                }

                // Update UI with the new image
                const stamp = Date.now();
                const retryResult = {
                  image: job.imageUrl,
                  imageUrl: job.imageUrl,
                  result: { imageUrl: job.imageUrl },
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
                setResults(prev => prev.map((r, i) =>
                  i === imageIndex ? {
                    ...r,
                    image: job.imageUrl,
                    imageUrl: job.imageUrl,
                    version: stamp,
                    mode: job.mode || "staged",
                    originalImageUrl: preservedOriginalUrl,
                    qualityEnhancedUrl: preservedQualityEnhancedUrl,
                    result: {
                      ...(normalizedResult || {}),
                      image: job.imageUrl,
                      imageUrl: job.imageUrl,
                      originalImageUrl: preservedOriginalUrl,
                      qualityEnhancedUrl: preservedQualityEnhancedUrl
                    },
                    error: null,
                    filename: r?.filename
                  } : r
                ));
                setProcessedImagesByIndex(prev => ({ ...prev, [String(imageIndex)]: job.imageUrl }));
                setProcessedImages(prev => {
                  const newSet = new Set(prev);
                  newSet.add(job.imageUrl);
                  return Array.from(newSet);
                });
                setProcessedImagesByIndex(prev => ({
                  ...prev,
                  [imageIndex]: job.imageUrl
                }));
                await refreshUser();

                // Mark retry as finished (spinner clears on image load, but clear now for buttons/state)
                clearRetryFlags(imageIndex);

                // ✅ DO NOT set global progress state
                // ❌ setRunState("done");
                // ❌ setAbortController(null);
                // ❌ setProgressText("Retry complete! Enhanced image is ready.");

                return;
              } else if (job && job.status === "failed") {
                // ✅ Clear timeout on failure
                if (retryTimeoutRef.current) {
                  clearTimeout(retryTimeoutRef.current);
                  retryTimeoutRef.current = null;
                }

                // ✅ DO NOT set global progress state
                // ❌ setRunState("done");
                // ❌ setAbortController(null);
                // ❌ setProgressText("Retry failed. Unable to enhance image.");

                clearRetryFlags(imageIndex);

                toast({
                  title: "Retry failed",
                  description: job.error || "The retry job failed to process.",
                  variant: "destructive"
                });
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

        clearRetryFlags(imageIndex);

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
      
      const response = await fetch(api("/api/batch/refine"), {
        method: "POST",
               headers: {
          "Content-Type": "application/json",
          ...withDevice().headers        },
        credentials: "include",
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
      if (error.code === 401) {
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

  const handleRestart = () => {
    // Clear all state to start fresh
    setFiles([]);
    setGlobalGoal("");
    setPreserveStructure(true);
    setRunState("idle");
    setJobId("");
  setJobIds([]);
    setResults([]);
    setProgressText("");
    setProcessedImages([]);
    setProcessedImagesByIndex({});
    setActiveTab("upload"); // Reset to first tab
    // Cancel any ongoing processing
    if (abortController) {
      abortController.abort();
      setAbortController(null);
    }
    
    // Reset refine states
    setIsBatchRefining(false);
    setHasRefinedImages(false);
    
    // Clear room linking state
    setSelection(new Set());
    setMetaByIndex({});
    
    // Clear persisted batch job state
    clearBatchJobState();
    
    toast({ title: "Restarted", description: "Ready for new batch processing." });
  };

  // Cancel batch request
  const cancelBatch = async () => {
    if (!jobIds.length) return;
    try {
      await fetch(api("/api/jobs/cancel-batch"), withDevice({
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: jobIds })
      }));
      if (abortController) abortController.abort();
      setRunState("idle");
      setProgressText("Batch cancelled");
    } catch (e) {
      console.warn("cancel-batch failed", e);
    }
  };

  // Helper function to check if user can proceed to next tab
  const canProceedToTab = (tab: "upload" | "describe" | "images" | "enhance"): boolean => {
    switch(tab) {
      case "describe": return files.length > 0;
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
    // Auto-advance to describe tab when files are selected
    if (fileList.length > 0 && activeTab === "upload") {
      setActiveTab("describe");
    }
  };

  const clearAllFiles = () => {
    setFiles([]);
    setSelection(new Set());
    setMetaByIndex({});
    setImageSceneTypes({});
    setImageRoomTypes({});
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
    // Update selection indices
    setSelection(prev => {
      const newSelection = new Set<number>();
      prev.forEach(i => {
        if (i < index) newSelection.add(i);
        else if (i > index) newSelection.add(i - 1);
      });
      return newSelection;
    });
    // Update metadata indices
    setMetaByIndex(prev => {
      const newMeta: Record<number, LocalItemMeta> = {};
      Object.entries(prev).forEach(([idx, meta]) => {
        const i = parseInt(idx);
        if (i < index) newMeta[i] = meta;
        else if (i > index) newMeta[i - 1] = meta;
      });
      return newMeta;
    });
    // Update scene type indices
    setImageSceneTypes(prev => {
      const newTypes: Record<number, string> = {};
      Object.entries(prev).forEach(([idx, type]) => {
        const i = parseInt(idx);
        if (i < index) newTypes[i] = type;
        else if (i > index) newTypes[i - 1] = type;
      });
      return newTypes;
    });
    // Update room type indices
    setImageRoomTypes(prev => {
      const newTypes: Record<number, string> = {};
      Object.entries(prev).forEach(([idx, type]) => {
        const i = parseInt(idx);
        if (i < index) newTypes[i] = type;
        else if (i > index) newTypes[i - 1] = type;
      });
      return newTypes;
    });
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

  return (
  <div className="w-full">
      {/* Main header and tab navigation remain unchanged. No legacy bottom edit section. All region editing is handled in the RegionEditor modal. */}

      {/* Tab Content */}
  <div className={activeTab === 'enhance' ? "w-full min-h-screen font-sans text-slate-900" : "bg-brand-surface/95 rounded-xl shadow-lg p-8"}>
        
        {/* Upload Tab */}
        {activeTab === "upload" && (
          <div className="text-center">
            <h2 className="text-2xl font-semibold text-white mb-4">Upload Your Images</h2>
            <p className="text-gray-300 mb-8">
              {files.length === 0 
                ? "Select multiple images to enhance in batch"
                : `${files.length} image${files.length === 1 ? '' : 's'} selected • Click below to add more from other folders`
              }
            </p>
            
            <Dropzone 
              onFilesSelected={(newFiles) => {
                setFiles(prev => [...prev, ...newFiles]);
                if (newFiles.length > 0) setActiveTab("describe");
              }}
              maxFiles={50}
              maxSizeMB={15}
              className="bg-brand-800/20"
            />

            {files.length > 0 && (
              <div className="mt-8">
                <h3 className="text-lg font-medium text-white mb-4">
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
                    className="rounded-md border border-red-600 px-3 py-1 text-sm text-white bg-red-900 hover:bg-red-800" 
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
                        className="absolute top-1 right-1 w-6 h-6 bg-red-600 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-700 z-10"
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
                          <span className="inline-block rounded-full bg-orange-600 text-white px-2 py-0.5 text-[10px] font-medium">
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
                  onClick={() => setActiveTab("describe")}
                  className="mt-6 bg-action-600 text-white px-6 py-3 rounded-lg hover:bg-action-700 transition-colors font-medium"
                  data-testid="button-proceed-describe"
                >
                  Next: Describe Enhancement →
                </button>
              </div>
            )}
          </div>
        )}

        {/* Describe Tab */}
        {activeTab === "describe" && (
          <div>
            <h2 className="text-2xl font-semibold text-white mb-6">Describe Your Enhancement</h2>
            
            <div className="grid md:grid-cols-2 gap-8">
              {/* Left Column - Settings */}
              <div className="space-y-6">
                <div className="space-y-4">
                  <h3 className="text-lg font-medium text-white">Enhancement Options</h3>

                  <label className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={declutter}
                      onChange={(e) => { 
                        const checked = e.target.checked;
                        setDeclutter(checked); 
                        setFurnitureReplacement(checked);
                      }}
                      className="w-5 h-5 text-purple-600 border-gray-600 bg-gray-800 rounded focus:ring-purple-500"
                      data-testid="checkbox-declutter"
                    />
                    <div>
                      <span className="text-sm font-medium text-white">Remove furniture & clutter</span>
                      <p className="text-xs text-gray-400">Clean out existing furniture and clutter (Stage 1B)</p>
                    </div>
                  </label>

                  {/* Declutter Mode Radio Buttons */}
                  {declutter && (
                    <div className="ml-8 space-y-2 mb-3">
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="declutterMode"
                          value="light"
                          checked={declutterMode === "light"}
                          onChange={(e) => setDeclutterMode(e.target.value as "light" | "stage-ready")}
                          className="w-4 h-4 text-purple-600 border-gray-600 bg-gray-800 focus:ring-purple-500"
                        />
                        <div>
                          <span className="text-sm text-white">Declutter Only (Remove Clutter)</span>
                          <p className="text-xs text-gray-400">Keeps furniture, removes mess and clutter</p>
                        </div>
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="declutterMode"
                          value="stage-ready"
                          checked={declutterMode === "stage-ready"}
                          onChange={(e) => setDeclutterMode(e.target.value as "light" | "stage-ready")}
                          className="w-4 h-4 text-purple-600 border-gray-600 bg-gray-800 focus:ring-purple-500"
                        />
                        <div>
                          <span className="text-sm text-white">Stage Ready (Empty Room)</span>
                          <p className="text-xs text-gray-400">Removes all furniture and clutter</p>
                        </div>
                      </label>
                    </div>
                  )}

                  <label className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={allowStaging}
                      onChange={(e) => setAllowStaging(e.target.checked)}
                      className="w-5 h-5 text-purple-600 border-gray-600 bg-gray-800 rounded focus:ring-purple-500"
                      data-testid="checkbox-allow-staging"
                    />
                    <div>
                      <span className="text-sm font-medium text-white">Add virtual staging</span>
                      <p className="text-xs text-gray-400">
                        {declutter 
                          ? "Stage the empty room with new furniture (Stage 2)" 
                          : "Add furniture and decor to existing room (Stage 2)"}
                      </p>
                    </div>
                  </label>
                  {/* Staging Style Dropdown - only shown if staging is enabled */}
                  {allowStaging && (
                    <div className="mb-2">
                      <label className="text-sm font-medium text-white block mb-1" htmlFor="staging-style-select">
                        Staging Style <span className="text-gray-400 text-xs">(applies to all staged images in this batch)</span>
                      </label>
                      <select
                        id="staging-style-select"
                        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white"
                        value={stagingStyle}
                        onChange={e => setStagingStyle(e.target.value)}
                        data-testid="select-staging-style"
                      >
                        <option value="NZ Standard Real Estate">NZ Standard Real Estate</option>
                        <option value="Coastal">Coastal</option>
                        <option value="Contemporary">Contemporary</option>
                        <option value="Hamptons">Hamptons</option>
                        <option value="Industrial">Industrial</option>
                        <option value="Japandi">Japandi</option>
                        <option value="Luxe Contemporary">Luxe Contemporary</option>
                        <option value="Minimalist">Minimalist</option>
                        <option value="Modern">Modern</option>
                        <option value="Modern Farmhouse">Modern Farmhouse</option>
                        <option value="NZ Modern">NZ Modern</option>
                        <option value="Scandinavian">Scandinavian</option>
                        <option value="Traditional">Traditional</option>
                        <option value="Urban Loft">Urban Loft</option>
                      </select>
                      <button
                        onClick={() => setStagingStyle("NZ Standard Real Estate")}
                        className="text-xs text-blue-400 hover:text-blue-300 underline mt-1"
                        type="button"
                      >
                        Reset to NZ Standard
                      </button>
                    </div>
                  )}

                  <div className="space-y-2">
                    <label className="text-sm font-medium text-white">Scene Selector</label>
                    <select
                      className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white"
                      value={outdoorStaging}
                      onChange={(e) => setOutdoorStaging(e.target.value as "auto" | "none")}
                      data-testid="select-scene-selector"
                      title="Affects exterior images only"
                    >
                      <option value="auto">Auto</option>
                      <option value="none">None (polish only)</option>
                    </select>
                    <p className="text-xs text-gray-400">Affects exterior images only</p>
                  </div>
                </div>

                {/* Image Consumption Notice */}
                <div className="bg-blue-900/20 border border-blue-500/30 rounded-lg p-3">
                  <p className="text-sm font-medium text-blue-300 mb-1">Image consumption per photo:</p>
                  <p className="text-sm text-blue-200">
                    {declutter && allowStaging ? (
                      <>
                        <span className="font-semibold">2 images</span> will be consumed per photo
                        <span className="text-xs block text-blue-300 mt-1">
                          (1 for enhancement + declutter, 1 for staging)
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="font-semibold">1 image</span> will be consumed per photo
                        <span className="text-xs block text-blue-300 mt-1">
                          ({declutter ? 'Enhancement + declutter' : allowStaging ? 'Enhancement + staging' : 'Enhancement only'})
                        </span>
                      </>
                    )}
                  </p>
                </div>

                <div>
                  <button
                    onClick={() => setShowSpecificRequirements(!showSpecificRequirements)}
                    className="flex items-center justify-between w-full text-left p-3 bg-gray-800 hover:bg-gray-700 rounded-lg border border-gray-600 transition-colors"
                    data-testid="button-toggle-specific-requirements"
                  >
                    <span className="text-sm font-medium text-white">
                      Specific Requirements <span className="text-gray-400">(optional)</span>
                    </span>
                    <span className={`transform transition-transform text-gray-400 ${showSpecificRequirements ? 'rotate-180' : ''}`}>
                      ▼
                    </span>
                  </button>
                  
                  {showSpecificRequirements && (
                    <div className="mt-2">
                      <textarea
                        className="w-full border border-gray-600 rounded-lg p-3 bg-gray-800 text-white focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                        rows={4}
                        placeholder="e.g., Stage interiors, brighten rooms, greener lawn, blue sky without clouds..."
                        value={globalGoal}
                        onChange={e => setGlobalGoal(e.target.value)}
                        data-testid="textarea-global-goal"
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Right Column - Preview */}
              <div>
                <h3 className="text-lg font-medium text-white mb-4">Image Preview</h3>
                {files.length > 0 && (
                  <div className="grid grid-cols-2 gap-3">
                    {previewUrls.slice(0, 4).map((url, i) => (
                      <img 
                        key={i}
                        src={url} 
                        alt={`preview-${i}`} 
                        className="w-full h-32 object-cover rounded-lg border border-gray-600"
                      />
                    ))}
                    {files.length > 4 && (
                      <div className="w-full h-32 bg-gray-800 rounded-lg border border-gray-600 flex items-center justify-center">
                        <span className="text-gray-400 text-sm">+{files.length - 4} more</span>
                      </div>
                    )}
                  </div>
                )}

                {allowStaging && (
                  <div className="mt-4 p-4 bg-purple-900/20 border border-purple-500/30 rounded-lg">
                    <div className="flex items-start gap-2">
                      <span className="text-purple-400 text-lg">📐</span>
                      <div>
                        <p className="text-sm font-medium text-purple-300">Preserve + Stage Mode</p>
                        <p className="text-xs text-purple-200 mt-1">
                          Items will be placed on floor planes only, keeping doors, windows, and cabinets fully visible.
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-8 pt-6 border-t border-gray-600">
              <div className="flex justify-between items-center">
                <button
                  onClick={() => setActiveTab("upload")}
                  className="px-6 py-3 border border-gray-600 text-gray-300 rounded-lg hover:bg-gray-800 transition-colors"
                  data-testid="button-back-upload"
                >
                  ← Back to Upload
                </button>
                <button
                  onClick={() => setActiveTab("images")}
                  className="px-6 py-3 bg-action-600 text-white rounded-lg hover:bg-action-700 transition-colors font-medium"
                  data-testid="button-next-to-images"
                >
                  Next →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Images Tab - Studio Layout */}
        {activeTab === "images" && (
          <div className="flex h-[calc(100vh-140px)] bg-slate-50 -mx-4 sm:-mx-6 lg:-mx-8 -my-6 lg:-my-8 rounded-lg overflow-hidden">

            {/* LEFT PANEL: The Canvas */}
            <div className="flex-1 bg-slate-100 relative flex items-center justify-center p-6 lg:p-8 overflow-hidden">
              {/* Back Navigation */}
              <button
                onClick={() => setActiveTab("describe")}
                className="absolute top-4 left-4 flex items-center gap-2 text-slate-500 hover:text-slate-800 transition-colors text-sm"
              >
                <ChevronLeft className="w-4 h-4" />
                Back to Settings
              </button>

              {/* Image Counter Badge */}
              <div className="absolute top-4 right-4 bg-white/90 backdrop-blur-sm px-3 py-1.5 rounded-full text-sm font-medium text-slate-700 shadow-sm">
                {currentImageIndex + 1} of {files.length}
              </div>

              {/* Navigation Arrows */}
              {files.length > 1 && (
                <>
                  <button
                    onClick={() => setCurrentImageIndex(i => Math.max(0, i - 1))}
                    disabled={currentImageIndex === 0}
                    className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 bg-white/90 backdrop-blur-sm rounded-full shadow-md flex items-center justify-center text-slate-600 hover:text-slate-900 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <button
                    onClick={() => setCurrentImageIndex(i => Math.min(files.length - 1, i + 1))}
                    disabled={currentImageIndex === files.length - 1}
                    className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 bg-white/90 backdrop-blur-sm rounded-full shadow-md flex items-center justify-center text-slate-600 hover:text-slate-900 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    <ChevronRight className="w-5 h-5" />
                  </button>
                </>
              )}

              {/* The Image Canvas */}
              <div className="relative shadow-2xl rounded-lg overflow-hidden max-h-[70vh] max-w-full">
                <img
                  src={previewUrls[currentImageIndex]}
                  alt={files[currentImageIndex]?.name || `Image ${currentImageIndex + 1}`}
                  className="max-h-[70vh] w-auto object-contain bg-white"
                />
                {/* Zoom Button Overlay */}
                <button
                  onClick={() => setPreviewImage({
                    url: previewUrls[currentImageIndex],
                    filename: files[currentImageIndex]?.name || '',
                    index: currentImageIndex
                  })}
                  className="absolute bottom-3 right-3 bg-black/60 hover:bg-black/80 text-white p-2 rounded-lg transition-colors"
                  title="View fullscreen"
                >
                  <Maximize2 className="w-4 h-4" />
                </button>
              </div>

              {/* Validation reminder above thumbnails */}
              {files.length > 1 && blockingCount > 0 && (
                <div className="absolute bottom-16 left-1/2 -translate-x-1/2 px-3 py-2 rounded-full bg-amber-50 text-amber-700 text-[11px] font-medium shadow-sm border border-amber-200 whitespace-nowrap">
                  Complete required fields for images highlighted in red to continue.
                </div>
              )}

              {/* Thumbnail Strip (for multiple images) */}
              {files.length > 1 && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex flex-nowrap gap-2 bg-white/90 backdrop-blur-sm p-2 rounded-lg shadow-md max-w-[80%] overflow-x-auto">
                  {files.map((file, idx) => {
                    const status = imageValidationStatus(idx);
                    const statusRing = status === "needs_input"
                      ? "ring-2 ring-red-500 ring-offset-1"
                      : status === "ok"
                        ? "ring-2 ring-emerald-500 ring-offset-1"
                        : "ring-1 ring-slate-200";
                    const activeState = idx === currentImageIndex
                      ? "outline outline-2 outline-action-500 outline-offset-2"
                      : "opacity-60 hover:opacity-100";
                    return (
                      <button
                        key={idx}
                        onClick={() => setCurrentImageIndex(idx)}
                        className={`w-12 h-12 rounded-md overflow-hidden flex-shrink-0 transition-all ${statusRing} ${activeState}`}
                        title={status === "needs_input" ? "Needs scene/room input" : undefined}
                      >
                        <img src={previewUrls[idx]} alt="" className="w-full h-full object-cover" />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* RIGHT PANEL: The Inspector Sidebar */}
            <div className="w-80 lg:w-96 bg-white border-l border-slate-200 flex flex-col shadow-xl">

              {/* Sidebar Header */}
              <div className="p-5 border-b border-slate-100">
                <div className="flex justify-between items-center mb-1">
                  <h2 className="text-lg font-semibold text-slate-900">Settings</h2>
                  <button
                    onClick={() => {
                      // Reset current image settings to auto
                      setImageSceneTypes(prev => ({ ...prev, [currentImageIndex]: "auto" }));
                      setManualSceneTypes(prev => {
                        const next = { ...prev } as Record<number, SceneLabel | null>;
                        delete next[currentImageIndex];
                        return next;
                      });
                      setManualSceneOverrideByIndex(prev => ({ ...prev, [currentImageIndex]: false }));
                      setImageSkyReplacement(prev => ({ ...prev, [currentImageIndex]: true }));
                      setImageRoomTypes(prev => ({ ...prev, [currentImageIndex]: "" }));
                    }}
                    className="text-xs text-action-600 font-medium hover:text-action-700"
                  >
                    Reset
                  </button>
                </div>
                <p className="text-xs text-slate-500 truncate" title={files[currentImageIndex]?.name}>
                  {files[currentImageIndex]?.name || `Image ${currentImageIndex + 1}`}
                </p>
              </div>

              {/* Scrollable Settings Area */}
              <div className="flex-1 overflow-y-auto p-5 space-y-6">

                {/* Scene Type Selection - Visual Cards */}
                <section>
                  <label className="text-sm font-medium text-slate-900 mb-3 block">Scene Type</label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={() => {
                        console.log("[SceneSelect] manual override set", { index: currentImageIndex, scene: "exterior" });
                        setManualSceneTypes(prev => ({ ...prev, [currentImageIndex]: "exterior" }));
                        setImageSceneTypes(prev => ({ ...prev, [currentImageIndex]: "exterior" }));
                        setManualSceneOverrideByIndex(prev => ({ ...prev, [currentImageIndex]: true }));
                      }}
                      data-testid={`select-scene-${currentImageIndex}`}
                      className={`p-4 rounded-lg border-2 flex flex-col items-center gap-2 transition-all ${
                        currentFinalScene === "exterior"
                          ? 'border-action-500 bg-action-50 text-action-700'
                          : 'border-slate-200 hover:border-slate-300 text-slate-600'
                      }`}
                    >
                      <Home className="w-6 h-6" />
                      <span className="text-sm font-medium">Exterior</span>
                    </button>
                    <button
                      onClick={() => {
                        console.log("[SceneSelect] manual override set", { index: currentImageIndex, scene: "interior" });
                        setManualSceneTypes(prev => ({ ...prev, [currentImageIndex]: "interior" }));
                        setImageSceneTypes(prev => ({ ...prev, [currentImageIndex]: "interior" }));
                        setManualSceneOverrideByIndex(prev => ({ ...prev, [currentImageIndex]: true }));
                        setImageSkyReplacement(prev => ({ ...prev, [currentImageIndex]: false }));
                      }}
                      className={`p-4 rounded-lg border-2 flex flex-col items-center gap-2 transition-all ${
                        currentFinalScene === "interior"
                          ? 'border-action-500 bg-action-50 text-action-700'
                          : 'border-slate-200 hover:border-slate-300 text-slate-600'
                      }`}
                    >
                      <Armchair className="w-6 h-6" />
                      <span className="text-sm font-medium">Interior</span>
                    </button>
                  </div>
                </section>

                {/* AI Enhancements Section */}
                <section className="space-y-4">
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">AI Enhancements</h3>

                  {/* Sky Replacement Toggle - Only for Exterior */}
                  {currentFinalScene === "exterior" && (
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex gap-3">
                        <div className="mt-0.5 text-slate-400"><CloudSun className="w-5 h-5" /></div>
                        <div>
                          <label className="text-sm font-medium text-slate-900 block">Blue Sky Replacement</label>
                          <p className="text-xs text-slate-500 mt-0.5">Replace overcast skies with clear blue.</p>
                        </div>
                      </div>
                      <Switch
                        checked={(() => {
                          const val = imageSkyReplacement[currentImageIndex] !== undefined ? imageSkyReplacement[currentImageIndex] : true;
                          return manualSceneOverrideByIndex[currentImageIndex] ? false : val;
                        })()}
                        onCheckedChange={(checked: boolean) => {
                          if (manualSceneOverrideByIndex[currentImageIndex]) return;
                          setImageSkyReplacement(prev => ({ ...prev, [currentImageIndex]: checked }));
                        }}
                        disabled={!!manualSceneOverrideByIndex[currentImageIndex]}
                        data-testid={`toggle-sky-${currentImageIndex}`}
                        className="data-[state=checked]:bg-action-600"
                      />
                    </div>
                  )}

                  {/* Link Images Toggle */}
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex gap-3">
                      <div className="mt-0.5 text-slate-400">
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                        </svg>
                      </div>
                      <div>
                        <label className="text-sm font-medium text-slate-900 block">Link Images</label>
                        <p className="text-xs text-slate-500 mt-0.5">Group multi-angle shots of same room.</p>
                      </div>
                    </div>
                    <Switch
                      checked={linkImages}
                      onCheckedChange={setLinkImages}
                      data-testid="checkbox-link-images"
                      className="data-[state=checked]:bg-action-600"
                    />
                  </div>
                </section>

                {/* Room Type Selection - Only for Interior when staging enabled */}
                {allowStaging && (currentFinalScene !== "exterior") && (
                  <section>
                    <label className="text-sm font-medium text-slate-900 mb-2 block">Room Type</label>
                    <FixedSelect
                      value={imageRoomTypes[currentImageIndex] || ""}
                      onValueChange={(v) => setImageRoomTypes((prev) => ({ ...prev, [currentImageIndex]: v }))}
                      placeholder="Select room type…"
                      className="w-full"
                    >
                      <FixedSelectItem value="bedroom-1">Bedroom 1</FixedSelectItem>
                      <FixedSelectItem value="bedroom-2">Bedroom 2</FixedSelectItem>
                      <FixedSelectItem value="bedroom-3">Bedroom 3</FixedSelectItem>
                      <FixedSelectItem value="bedroom-4">Bedroom 4</FixedSelectItem>
                      <FixedSelectItem value="kitchen">Kitchen</FixedSelectItem>
                      <FixedSelectItem value="living-room">Living Room</FixedSelectItem>
                      <FixedSelectItem value="multi-living">Multiple Living Areas</FixedSelectItem>
                      <FixedSelectItem value="dining-room">Dining Room</FixedSelectItem>
                      <FixedSelectItem value="study">Study</FixedSelectItem>
                      <FixedSelectItem value="office">Office</FixedSelectItem>
                      <FixedSelectItem value="bathroom-1">Bathroom 1</FixedSelectItem>
                      <FixedSelectItem value="bathroom-2">Bathroom 2</FixedSelectItem>
                      <FixedSelectItem value="laundry">Laundry</FixedSelectItem>
                      <FixedSelectItem value="garage">Garage</FixedSelectItem>
                      <FixedSelectItem value="basement">Basement</FixedSelectItem>
                      <FixedSelectItem value="attic">Attic</FixedSelectItem>
                      <FixedSelectItem value="hallway">Hallway</FixedSelectItem>
                      <FixedSelectItem value="staircase">Staircase</FixedSelectItem>
                      <FixedSelectItem value="entryway">Entryway</FixedSelectItem>
                      <FixedSelectItem value="closet">Closet</FixedSelectItem>
                      <FixedSelectItem value="pantry">Pantry</FixedSelectItem>
                    </FixedSelect>
                  </section>
                )}

                {/* Guidance / Alerts */}
                {(() => {
                  const sceneNeeds = sceneRequiresInput(currentImageIndex);
                  const roomNeeds = roomTypeRequiresInput(currentImageIndex);
                  const prediction = scenePredictions[currentImageIndex];
                  const conf = clamp01(prediction?.confidence ?? null);
                  const autoAccepted = isSceneAutoAcceptable(prediction);
                  const detectedLine = autoAccepted && prediction?.scene
                    ? `Scene type was auto-detected as ${prediction.scene}. You can change it if it looks wrong.`
                    : null;
                  const isAlert = sceneNeeds || roomNeeds;
                  const lines: string[] = [];
                  if (sceneNeeds) lines.push("We couldn’t confidently detect whether this image is interior or exterior. Please select one to continue.");
                  if (roomNeeds) lines.push("Room Type is required when Room Staging (Stage 2) is enabled.");
                  if (!lines.length && detectedLine) lines.push(detectedLine);
                  if (!lines.length) lines.push("Scene type is required for low-confidence images. If auto-detected, you can still change it.");
                  return (
                    <div className={`${isAlert ? 'bg-red-50 border border-red-200 text-red-700' : 'bg-blue-50 border border-blue-100 text-blue-700'} rounded-lg p-3 flex gap-3`}>
                      <Info className={`w-5 h-5 flex-shrink-0 mt-0.5 ${isAlert ? 'text-red-500' : 'text-blue-500'}`} />
                      <div className="text-xs leading-relaxed space-y-1">
                        {lines.map((line, idx) => (
                          <p key={idx}>{line}</p>
                        ))}
                        {IS_DEV && prediction && (
                          <div className="mt-2 text-[11px] text-slate-500">
                            <div className="font-semibold text-slate-600">Scene Debug</div>
                            <div className="flex flex-wrap gap-2">
                              <span>scene={prediction.scene ?? 'null'}</span>
                              <span>conf={(conf ?? 0).toFixed(2)}</span>
                              <span>reason={prediction.reason}</span>
                              <span>signal={(prediction.signal ?? 0).toFixed(3)}</span>
                              <span>low={SCENE_SIGNAL_LOW.toFixed(3)}</span>
                              <span>high={SCENE_SIGNAL_HIGH.toFixed(3)}</span>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <span>sky10={(prediction.features?.skyTop10 ?? 0).toFixed(3)}</span>
                              <span>sky40={(prediction.features?.skyTop40 ?? 0).toFixed(3)}</span>
                              <span>grass={(prediction.features?.grassBottom ?? 0).toFixed(3)}</span>
                              <span>blue={(prediction.features?.blueOverall ?? 0).toFixed(3)}</span>
                              <span>green={(prediction.features?.greenOverall ?? 0).toFixed(3)}</span>
                              <span>lum={(prediction.features?.meanLum ?? 0).toFixed(3)}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Sidebar Footer - Sticky */}
              <div className="p-5 border-t border-slate-200 bg-slate-50">
                <div className="flex justify-between text-sm mb-4">
                  <span className="text-slate-600">Estimated Cost</span>
                  <span className="font-semibold text-slate-900">
                    {files.length} {files.length === 1 ? 'Credit' : 'Credits'}
                  </span>
                </div>
                <div
                  onClick={() => {
                    if (blockingCount > 0) {
                      startBatchProcessing();
                    }
                  }}
                >
                  <button
                    onClick={() => {
                      setActiveTab("enhance");
                      startBatchProcessing();
                    }}
                    disabled={blockingCount > 0 || !files.length}
                    title={blockingCount ? `Complete required settings for ${blockingCount} image${blockingCount === 1 ? '' : 's'}.` : undefined}
                    className="w-full bg-action-600 hover:bg-action-700 text-white font-medium py-3 px-4 rounded-lg shadow-sm transition-all focus:ring-2 focus:ring-offset-2 focus:ring-action-500 disabled:opacity-60 disabled:cursor-not-allowed"
                    data-testid="button-proceed-enhance"
                  >
                    Start Enhancement ({files.length} {files.length === 1 ? 'Image' : 'Images'})
                  </button>
                </div>
                {blockingCount > 0 && (
                  <p className="mt-2 text-xs text-red-700">
                    Complete required settings for images highlighted in red to continue.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Enhance Tab - Premium Command Center */}
        {activeTab === "enhance" && (
          <div className="min-h-screen bg-slate-50 relative pointer-events-auto">
            
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
                      onClick={startBatchProcessing}
                      disabled={!files.length || blockingCount > 0}
                      title={blockingCount ? `Complete required settings for ${blockingCount} image${blockingCount === 1 ? '' : 's'}.` : undefined}
                      className="bg-emerald-600 text-white px-8 py-4 rounded hover:bg-emerald-700 transition-colors font-medium text-lg disabled:opacity-50 disabled:cursor-not-allowed shadow-md"
                      data-testid="button-start-batch"
                    >
                      Process Batch #{Math.floor(Math.random() * 1000) + 2000} ({files.length} Images)
                    </button>
                    <div className="flex justify-center mt-4">
                      <button
                        onClick={() => setActiveTab("describe")}
                        className="text-gray-500 hover:text-gray-700 text-sm"
                        data-testid="button-back-describe"
                      >
                        ← Back to settings
                      </button>
                    </div>
                  </div>
              </div>
            ) : (
             /* COMMAND CENTER VIEW */
             <div className="max-w-5xl mx-auto py-8 px-4">
                
                {/* 1. Header Section */}
                <div className="mb-8">
                    <div className="flex justify-between items-end mb-4">
                    <div>
                        <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">Processing Batch</h1>
                        <p className="text-slate-500 mt-1">Please keep this tab open. {files.length - results.filter(r => r?.result?.image && !r?.error).length} images remaining.</p>
                    </div>
                    <div className="text-right">
                        {(runState === 'running' || isUploading) && (
                            <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">
                                <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                                {isUploading ? "Uploading" : "Optimizing"}
                            </span>
                        )}
                        {runState === 'done' && (
                             <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">
                                <CheckCircle className="w-3 h-3 mr-2" />
                                Complete
                            </span>
                        )}
                    </div>
                    </div>

                    {/* 2. Global Progress Bar */}
                    <div className="h-3 w-full bg-slate-200 rounded-full overflow-hidden">
                     {/* Calculate total progress - use IIFE for clean variable scope */}
                     {(() => {
                         const completed = results.filter(r => (r?.result?.image || (r?.result?.imageUrl)) || r?.error).length;
                         const total = files.length || 1;
                         const pct = Math.round((completed / total) * 100);
                         const uploadPct = isUploading ? 10 : 0; 
                         const displayPct = isUploading ? 30 : Math.max(5, pct);
                         return (
                            <div 
                                className="h-full bg-emerald-600 transition-all duration-500 ease-out" 
                                style={{ width: `${runState === 'done' ? 100 : displayPct}%` }}
                            />
                         );
                     })()}
                    </div>
                </div>

                {/* 3. The List */}
                <div className="space-y-4">
                    {files.map((file, i) => {
                        const result = results[i];
                        const isRetrying = retryingImages.has(i) || retryLoadingImages.has(i);
                        const isDone = !!(result?.result?.image || result?.result?.imageUrl || result?.image || result?.imageUrl);
                        const isError = !!(result?.error) && !isRetrying;
                        const isProcessing = ((runState === 'running' || isUploading) && !isDone && !isError) || isRetrying;
                        const displayStatus = isError
                          ? "Failed"
                          : isDone
                          ? "Complete"
                          : isRetrying
                          ? "Retrying..."
                          : isUploading
                          ? "Uploading..."
                          : aiSteps[i] || "Waiting in queue...";
                        
                        // Image Preview Logic
                        const baseUrl = getDisplayUrl(result);
                        const enhancedUrl = withVersion(baseUrl, result?.version || result?.updatedAt);
                        const previewUrl = enhancedUrl || previewUrls[i];
                        
                        return (
                          <div 
                            key={i} 
                            className="group relative bg-white border border-slate-200 rounded-lg p-4 shadow-sm hover:shadow-md transition-all flex items-center gap-6"
                          >
                            {/* Thumbnail with Overlay */}
                            <div
                              className="relative h-20 w-32 shrink-0 bg-slate-100 rounded-md overflow-hidden border border-slate-100 cursor-pointer"
                              onClick={() => {
                                if (!previewUrl) return;
                                setPreviewImage({
                                  url: enhancedUrl || previewUrl,
                                  filename: file.name,
                                  originalUrl: previewUrls[i],
                                  index: i
                                });
                              }}
                            >
                              <img 
                                src={previewUrl || ''} 
                                alt={file.name} 
                                className={`h-full w-full object-cover transition-all ${isProcessing ? 'opacity-80' : ''}`}
                                onLoad={() => clearRetryFlags(i)}
                                onError={() => clearRetryFlags(i)}
                              />
                              {isProcessing && (
                                <div className="absolute inset-0 flex items-center justify-center bg-emerald-900/20">
                                  <div className="flex items-center gap-2 rounded-full bg-white/90 px-3 py-1 text-emerald-700 text-xs font-medium shadow-sm">
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    {isRetrying ? 'Retrying…' : 'Processing…'}
                                  </div>
                                </div>
                              )}
                              {!isProcessing && isDone && (
                                <div className="absolute inset-0 flex items-center justify-center bg-black/10">
                                  <CheckCircle className="text-white w-6 h-6 shadow-sm" />
                                </div>
                              )}
                            </div>

                            {/* Info Column */}
                            <div className="flex-1 min-w-0">
                              <div className="flex justify-between items-center mb-1">
                                <h3 className="text-sm font-semibold text-slate-900 truncate">{file.name}</h3>
                                {/* Individual % - Fake it if processing, real if done */}
                                <span className="text-xs font-mono text-slate-400">
                                    {isDone ? '100%' : isProcessing ? 'Processing...' : '0%'}
                                </span>
                              </div>
                              
                              {/* The "Transparent AI" Status Text */}
                              <div className="flex items-center gap-2">
                                {isProcessing ? (
                                   <>
                                    <Loader2 className="w-3 h-3 text-emerald-600 animate-spin" />
                                    <p className="text-sm text-emerald-700 font-medium animate-pulse">
                                      {displayStatus}
                                    </p>
                                   </>
                                ) : isError ? (
                                    <p className="text-sm text-red-600 flex items-center gap-2"><XCircle className="w-3 h-3"/> {result.error || "Error"}</p>
                                ) : isDone ? (
                                   <p className="text-sm text-slate-500">Enhancement complete</p> 
                                ) : (
                                  <p className="text-sm text-slate-400">{displayStatus}</p>
                                )}
                              </div>

                              {/* Individual Progress Line - Only when processing */}
                              {isProcessing && (
                                <div className="mt-3 h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                                  <div 
                                    className="h-full bg-emerald-500 transition-all duration-300 animate-pulse" 
                                    style={{ width: `${isUploading ? 30 : 60}%` }} 
                                  />
                                </div>
                              )}
                            </div>

                            {/* Action / Cancel Column */}
                            <div className="shrink-0 flex gap-2">
                                {isDone && (
                                    <>
                                        <button 
                                            onClick={() => setPreviewImage({
                                                url: enhancedUrl!,
                                                filename: file.name,
                                                originalUrl: previewUrls[i],
                                                index: i
                                            })}
                                            className="text-xs font-medium px-3 py-2 rounded bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
                                        >
                                            Preview
                                        </button>
                                         <button 
                                            onClick={() => handleEditImage(i)}
                                            className="text-xs font-medium px-3 py-2 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors"
                                        >
                                            Edit
                                        </button>
                                          <button
                                            onClick={() => handleOpenRetryDialog(i)}
                                            disabled={retryingImages.has(i)}
                                            className="text-xs font-medium px-3 py-2 rounded bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                                            data-testid={`button-retry-${i}`}
                                          >
                                            {retryingImages.has(i) ? "Retrying..." : "Retry"}
                                          </button>
                                    </>
                                )}
                            </div>
                          </div>
                        );
                    })}
                </div>

                {/* Final Actions */}
                {runState === "done" && (
                    <div className="mt-8 flex justify-center gap-4">
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
                )}

             </div>
            )}
          </div>
        )}
      </div>

      {/* Preview/Edit Modals */}
      {previewImage && (
        <Modal isOpen={true} onClose={() => setPreviewImage(null)} maxWidth="full" contentClassName="max-w-7xl">
          <div className="text-center">
            <h3 className="text-lg font-semibold mb-4">{previewImage.filename}</h3>
            
            {/* Show before/after slider if we have both original and enhanced images */}
            {previewImage.originalUrl ? (
              <div className="mb-4">
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
              </div>
            ) : (
              /* Fallback to just enhanced image if no original available */
              <img 
                src={previewImage.url} 
                alt={previewImage.filename} 
                className="max-w-full max-h-[80vh] mx-auto rounded border"
                data-testid="img-preview-modal"
                onError={(e) => {
                  console.error('[PREVIEW] Image failed to load:', {
                    url: previewImage.url,
                    filename: previewImage.filename,
                    error: e
                  });
                }}
                onLoad={() => {
                  console.log('[PREVIEW] Image loaded successfully:', previewImage.url?.substring(0, 100));
                }}
              />
            )}
            
            <div className="mt-4 flex justify-center gap-3">
              <button
                onClick={() => setPreviewImage(null)}
                className="px-4 py-2 bg-slate-600 text-white rounded-lg hover:bg-slate-700 transition-colors"
                data-testid="button-close-preview"
              >
                Close
              </button>
              <button
                onClick={() => {
                  const index = previewImage.index;
                  setPreviewImage(null);
                  handleOpenRetryDialog(index);
                }}
                disabled={retryingImages.has(previewImage.index) || editingImages.has(previewImage.index)}
                className="px-4 py-2 bg-action-600 text-white rounded-lg hover:bg-action-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="button-retry-from-preview"
              >
                Retry
              </button>
              <button
                onClick={() => {
                  const index = previewImage.index;
                  setPreviewImage(null);
                  handleEditImage(index);
                }}
                disabled={retryingImages.has(previewImage.index) || editingImages.has(previewImage.index)}
                className="px-4 py-2 bg-action-600 text-white rounded-lg hover:bg-action-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="button-edit-from-preview"
              >
                Edit
              </button>
              <a
                href={previewImage.url}
                target="_blank"
                className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors"
                data-testid="link-download-preview"
              >
                Download
              </a>
            </div>
          </div>
        </Modal>
      )}

      {/* RegionEditor Modal - all edit controls and enlarged image are inside the modal */}
      {regionEditorOpen && editingImageIndex !== null && (
        <Modal isOpen={regionEditorOpen} onClose={() => { setRegionEditorOpen(false); setEditingImageIndex(null); }} maxWidth="full" contentClassName="max-w-5xl">
          <RegionEditor
            initialImageUrl={(() => {
              const item = results[editingImageIndex];
              // Prefer Stage 2 (current/enhanced) as the initial preview. If missing, fall back to Stage1 (quality) and lastly to display URL
              const stageUrls = item?.stageUrls || item?.result?.stageUrls || {};
              const stage2 = stageUrls?.['2'] || stageUrls?.[2] || undefined;
              const stage1b = stageUrls?.['1B'] || stageUrls?.['1b'] || undefined;
              const stage1a = stageUrls?.['1A'] || stageUrls?.['1a'] || undefined;
              const quality = stage1b || stage1a || undefined;
              const display = withVersion(getDisplayUrl(results[editingImageIndex]), item?.version || item?.updatedAt) || undefined;
              const previewFallback = previewUrls[editingImageIndex];
              const initial = stage2 || quality || display || previewFallback;
              console.log('[BatchProcessor] Resolved initialImageUrl (stage2||quality||display||preview):', { stage2, stage1b, stage1a, display, previewFallback, initial });
              return initial;
            })()}
            // Explicit mapping for restore base: prefer Stage 1B then Stage 1A. No broad fallbacks.
            originalImageUrl={(() => {
              const item = results[editingImageIndex];
              const stageUrls = item?.stageUrls || item?.result?.stageUrls || {};
              const stage1b = stageUrls?.['1B'] || stageUrls?.['1b'] || undefined;
              const stage1a = stageUrls?.['1A'] || stageUrls?.['1a'] || undefined;
              const display = withVersion(getDisplayUrl(results[editingImageIndex]), item?.version || item?.updatedAt) || undefined;
              const previewFallback = previewUrls[editingImageIndex];
              const resolved = stage1b || stage1a || display || previewFallback || undefined;
              console.log('[BatchProcessor] Resolved originalImageUrl (1B||1A||display||preview):', { stage1b, stage1a, display, previewFallback, resolved });
              return resolved;
            })()}
            initialGoal={globalGoal}
            initialIndustry={industryMap[presetKey] || "Real Estate"}
            onStart={() => {
              setIsEditingInProgress(true);
            }}
            onJobStarted={(jobId: string) => {
              if (editingImageIndex == null) {
                console.warn('[BatchProcessor] onJobStarted called but editingImageIndex is null');
                return;
              }
              console.log('[BatchProcessor] RegionEditor.onJobStarted', { jobId, editingImageIndex });
              startRegionEditPolling(jobId, editingImageIndex);
            }}
            onComplete={(result: { imageUrl: string; originalUrl: string; maskUrl: string; mode?: string }) => {
              setIsEditingInProgress(false);
              if (typeof editingImageIndex === 'number' && Number.isInteger(editingImageIndex) && editingImageIndex >= 0) {
                const preservedOriginalUrl =
                  results[editingImageIndex]?.result?.originalImageUrl ||
                  results[editingImageIndex]?.result?.originalUrl ||
                  results[editingImageIndex]?.originalImageUrl ||
                  results[editingImageIndex]?.originalUrl;
                const preservedQualityEnhancedUrl = results[editingImageIndex]?.result?.qualityEnhancedUrl || results[editingImageIndex]?.qualityEnhancedUrl;
                setResults(prev => prev.map((r, i) =>
                  i === editingImageIndex ? {
                    ...r,
                    image: result.imageUrl,
                    imageUrl: result.imageUrl,
                    version: Date.now(),
                    mode: result.mode,
                    originalImageUrl: preservedOriginalUrl,
                    qualityEnhancedUrl: preservedQualityEnhancedUrl,
                    result: {
                      ...(normalizeBatchItem(result) || {}),
                      image: result.imageUrl,
                      imageUrl: result.imageUrl,
                      originalImageUrl: preservedOriginalUrl,
                      qualityEnhancedUrl: preservedQualityEnhancedUrl
                    },
                    error: null,
                    filename: r?.filename
                  } : r
                ));
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
              // DON'T close modal - keep it open so user can do more edits
              // User can manually close with the Cancel button
            }}
            onCancel={() => {
              setIsEditingInProgress(false);
              setRegionEditorOpen(false);
              setEditingImageIndex(null);
            }}
            onError={(errorMessage?: string) => {
              console.error('[batch-processor] Region edit error:', errorMessage);
              setIsEditingInProgress(false);
              setRegionEditorOpen(false);
              setEditingImageIndex(null);
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
        detectedRoomType={retryDialog.imageIndex !== null ? imageRoomTypes[retryDialog.imageIndex] : undefined}
      />

      {/* Editing in Progress Alert */}
      {isEditingInProgress && (
        <AlertDialog open={true}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                Editing image as requested
              </AlertDialogTitle>
              <AlertDialogDescription>
                Please wait while we enhance your image with the requested changes...
              </AlertDialogDescription>
            </AlertDialogHeader>
          </AlertDialogContent>
        </AlertDialog>
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