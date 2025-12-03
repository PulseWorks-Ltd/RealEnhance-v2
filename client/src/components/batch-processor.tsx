// Client-side stub for room type detection (replace with real logic as needed)
  // Replaced by backend ML API call below
import React, { useEffect, useMemo, useState, useRef } from "react";
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

type RunState = "idle" | "running" | "done";

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
}

const BATCH_JOB_KEY = "pmf_batch_job";
const JOB_EXPIRY_HOURS = 24; // Jobs expire after 24 hours

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
  } catch (error) {
    console.warn("Failed to clear batch job state:", error);
  }
}

export default function BatchProcessor() {
    // Staging style preset for the batch
    const [stagingStyle, setStagingStyle] = useState<string>("Modern");
  // Tab state for clean UI flow
  const [activeTab, setActiveTab] = useState<"upload" | "describe" | "images" | "enhance">("upload");
  
  const [files, setFiles] = useState<File[]>([]);
  const [globalGoal, setGlobalGoal] = useState("");
  const [preserveStructure, setPreserveStructure] = useState<boolean>(true);
  const presetKey = "realestate"; // Locked to Real Estate only
  const [showAdditionalSettings, setShowAdditionalSettings] = useState(false);
  const [runState, setRunState] = useState<RunState>("idle");
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
  const [editingImages, setEditingImages] = useState<Set<number>>(new Set());
  
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
  const [imageRoomTypes, setImageRoomTypes] = useState<Record<number, string>>({});
  const [imageSkyReplacement, setImageSkyReplacement] = useState<Record<number, boolean>>({});
  const [linkImages, setLinkImages] = useState<boolean>(false);

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

  // Lightweight client-side scene detector (prefill UX): interior vs exterior
  // More robust heuristic using regional sampling and relaxed thresholds.
  async function detectSceneFromFile(f: File): Promise<"interior" | "exterior"> {
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

      // Helper: classify pixel H,S,V
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

        // Overall blue/green presence (broader bands)
        if (v > 0.45 && s > 0.10 && h >= 190 && h <= 255) blueOverall++;
        if (v > 0.30 && s > 0.30 && h >= 70 && h <= 160) greenOverall++;

        // Sky-like pixels: light, low-ish saturation blues
        const isSkyish = v > 0.65 && s < 0.55 && h >= 185 && h <= 245;
        // Grass-like pixels: green with reasonable sat
        const isGrass = v > 0.35 && s > 0.35 && h >= 75 && h <= 150;

        // Weight top region for sky, bottom region for grass
        if (isSkyish) {
          if (y < height * 0.10) skyTop10++;
          if (y < height * 0.40) skyTop40++;
        }
        if (isGrass && y > height * 0.60) grassBottom40++;
      }

      const denom = Math.max(1, total);
      const skyTop10Pct = skyTop10 / denom;
      const skyTop40Pct = skyTop40 / denom;
      const grassBottomPct = grassBottom40 / denom;
      const blueOverallPct = blueOverall / denom;
      const greenOverallPct = greenOverall / denom;
      const meanLum = luminanceSum / denom;

      // Heuristic rules tuned for typical RE photos
      // Primary cues
      const skyStrong = skyTop10Pct >= 0.06 || skyTop40Pct >= 0.12;
      const grassStrong = grassBottomPct >= 0.08;
      // Secondary cues supporting low sky/grass (e.g., cropped exterior, night)
      const blueSupport = blueOverallPct >= 0.18 && skyTop40Pct >= 0.05;
      const greenSupport = greenOverallPct >= 0.18 && grassBottomPct >= 0.05;
      // Night exterior: dim image, modest blue band near top
      const nightSkySupport = meanLum < 0.40 && skyTop40Pct >= 0.06;

      const isExterior = skyStrong || grassStrong || blueSupport || greenSupport || nightSkySupport;

      // Debug: surface quick metrics to help tuning if needed
      console.log("[SceneDetect] skyTop10=", skyTop10Pct.toFixed(3),
        " skyTop40=", skyTop40Pct.toFixed(3),
        " grassBottom=", grassBottomPct.toFixed(3),
        " blueOverall=", blueOverallPct.toFixed(3),
        " greenOverall=", greenOverallPct.toFixed(3),
        " meanLum=", meanLum.toFixed(3),
        " -> exterior=", isExterior);

      return isExterior ? "exterior" : "interior";
    } catch (e) {
      console.warn("[SceneDetect] Fallback to interior due to error:", e);
      return "interior";
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
        setImageRoomTypes({});
        setImageSkyReplacement({});
        setMetaByIndex({});
        setSelection(new Set());
      }
      filesFingerprintRef.current = fp;
    }
  }, [files]);

  // When user enters the Images tab, prefill scene types using client-side detector
  useEffect(() => {
    if (activeTab !== "images" || !files.length) return;
    let cancelled = false;
    (async () => {
      const next: Record<number, string> = {};
      const skyDefaults: Record<number, boolean> = {};
      await Promise.all(files.map(async (f, i) => {
        // only auto-fill if user hasn't set it
        if (imageSceneTypes[i] && imageSceneTypes[i] !== "auto") return;
        const scene = await detectSceneFromFile(f);
        if (!cancelled) {
          next[i] = scene;
          // Auto-enable sky replacement for exterior images (can be toggled off by user)
          if (scene === "exterior" && imageSkyReplacement[i] === undefined) {
            skyDefaults[i] = true;
          }
        }
      }));
      if (!cancelled && Object.keys(next).length) {
        setImageSceneTypes(prev => ({ ...prev, ...next }));
        if (Object.keys(skyDefaults).length) {
          setImageSkyReplacement(prev => ({ ...prev, ...skyDefaults }));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [activeTab, files]);

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
      const sceneType = imageSceneTypes[i] || "auto";
      if (sceneType !== "auto") metaItem.sceneType = sceneType;
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
  }, [metaByIndex, files, imageSceneTypes, imageRoomTypes, imageSkyReplacement, linkImages, temperatureInput, topPInput, topKInput, results, allowStaging, samplingUiEnabled]);

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
            originalImageUrl: next.result?.originalImageUrl || undefined,  // Preserve original URL for comparison slider
            error: next.error || norm?.error
          };
          return copy;
        });

        // If the server included job meta like scene detection, surface it
        if (next.result && next.result.meta && next.result.meta.scene) {
          const scene = next.result.meta.scene;
          setProgressText(`Detected: ${scene.label} (${Math.round((scene.confidence||0)*100)}%)`);
          setLastDetected({ index: next.index, label: scene.label, confidence: scene.confidence || 0 });
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
    () => files.map(f => URL.createObjectURL(f)),
    [files]
  );

  useEffect(() => () => previewUrls.forEach(u => URL.revokeObjectURL(u)), [previewUrls]);
  
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
      setRunState(savedState.runState);
      setResults(savedState.results);
      setProcessedImages(savedState.processedImages);
      setProcessedImagesByIndex(savedState.processedImagesByIndex);
      setGlobalGoal(savedState.goal);
      setPreserveStructure(savedState.settings.preserveStructure);
      setAllowStaging(savedState.settings.allowStaging);
      setAllowRetouch(savedState.settings.allowRetouch);
      setOutdoorStaging(savedState.settings.outdoorStaging as "auto" | "none");
      setFurnitureReplacement(savedState.settings.furnitureReplacement ?? true);
      setDeclutter(savedState.settings.declutter ?? false);
      if (savedState.settings.stagingStyle) setStagingStyle(savedState.settings.stagingStyle);
      
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
        startPollingExistingJob(savedState.jobId);
      } else if (savedState.runState === "done") {
        setActiveTab("enhance");
      }
    } else {
      // Fallback: check for activeJobId from enhanced polling (user may have navigated away)
      const activeJobId = localStorage.getItem("activeJobId");
      if (activeJobId) {
        console.log("Resuming polling for active job:", activeJobId);
        setJobId(activeJobId);
        setRunState("running");
        setActiveTab("enhance");
        startPollingExistingJob(activeJobId);
      }
    }
  }, []);

  // Auto-save state when key values change
  useEffect(() => {
    if (jobId && runState !== "idle") {
      const state: PersistedBatchJob = {
        jobId,
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
        }))
      };
      saveBatchJobState(state);
    }
  }, [jobId, runState, results, processedImages, processedImagesByIndex, files, globalGoal, presetKey, preserveStructure, allowStaging, allowRetouch, outdoorStaging, furnitureReplacement, declutter]);

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
            if (item && item.status === 'completed' && !processedSetRef.current.has(i)) {
              processedSetRef.current.add(i);
              queueRef.current.push({
                index: i,
                result: { imageUrl: url, originalImageUrl: item.originalImageUrl, qualityEnhancedUrl: item.qualityEnhancedUrl, mode: item.mode, note: item.note, meta: item.meta },
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
              queueRef.current.push({
                index: 0,
                result: { imageUrl: url, originalImageUrl: data.originalImageUrl || null, mode: 'enhanced' },
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
          const status = String(it?.status || "").toLowerCase();
          const isCompleted = status === "completed" || status === "complete" || status === "done";

          if (typeof idx === "number" && isCompleted && !processedSetRef.current.has(idx)) {
            processedSetRef.current.add(idx);
            queueRef.current.push({
              index: idx,
              result: {
                imageUrl: url,
                originalImageUrl: it.originalImageUrl || null,
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
          return;
        }

        delay = Math.max(BACKOFF_START_MS, Math.floor(delay / BACKOFF_FACTOR));
      } catch (e:any) {
        if (e.name === 'AbortError') return;
        delay = Math.min(BACKOFF_MAX_MS, Math.floor(delay * BACKOFF_FACTOR));
      }
      await new Promise(r => setTimeout(r, delay));
    }
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
          setRunState('done'); setAbortController(null); await refreshUser(); return;
        }
        delay = Math.max(BACKOFF_START_MS, Math.floor(delay / BACKOFF_FACTOR));
      } catch (e:any) {
        if (e.name === 'AbortError') return;
        delay = Math.min(BACKOFF_MAX_MS, Math.floor(delay * BACKOFF_FACTOR));
      }
      await new Promise(r=>setTimeout(r, delay));
    }
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

    // NEW: if staging is enabled, ensure every interior image has a room type selected
    if (allowStaging) {
      const missing: number[] = [];
      files.forEach((_, index) => {
        const scene = imageSceneTypes[index] || "interior"; // default to interior if unset
        const isInterior = scene !== "exterior";
        if (isInterior && !imageRoomTypes[index]) {
          missing.push(index + 1);
        }
      });
      if (missing.length) {
        alert(
          `Please select a room type for image(s): ${missing.join(", ")} before running staging.`
        );
        setActiveTab("images");
        return;
      }
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
    fd.append("preserveStructure", preserveStructure.toString());
    fd.append("allowStaging", allowStaging.toString());
    fd.append("stagingStyle", allowStaging ? stagingStyle : "");
    fd.append("allowRetouch", allowRetouch.toString());
    fd.append("furnitureReplacement", furnitureReplacement.toString());
    fd.append("declutter", declutter.toString());
    fd.append("outdoorStaging", outdoorStaging);
    // NEW: Manual room linking metadata
    fd.append("metaJson", metaJson);
    
    try {
      // Phase 1: Start batch processing with files
      const uploadResp = await fetch(api("/api/upload"), {
        method: "POST",
        body: fd,
        credentials: "include",
        headers: withDevice().headers,
        signal: controller.signal
      });

      if (!uploadResp.ok) {
        setRunState("idle");
        if (uploadResp.status === 401) {
          return alert("Unable to process as you're not logged in. Please login and click retry to continue.");
        }
        const err = await uploadResp.json().catch(() => ({}));
        return alert(err.message || "Failed to upload files");
      }

  const uploadResult = await uploadResp.json();
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
    fd.append("preserveStructure", preserveStructure.toString());
    fd.append("allowStaging", allowStaging.toString());
    fd.append("stagingStyle", allowStaging ? stagingStyle : "");
    fd.append("allowRetouch", allowRetouch.toString());
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
    if (!files || imageIndex >= files.length || retryingImages.has(imageIndex)) return;
    
    const fileToRetry = files[imageIndex];
    if (!fileToRetry) return;
    
    // Check if this is a synthetic placeholder file created from batch persistence
    const isPlaceholder = (fileToRetry as any).__restored === true;
    const originalFromStoreUrl = results[imageIndex]?.result?.originalImageUrl || results[imageIndex]?.originalImageUrl;
    
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
    
    // Mark this image as retrying
    setRetryingImages(prev => new Set(prev).add(imageIndex));
    
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
      fd.append("image", fileToRetry); // Correct field name for retry-single
      fd.append("goal", goalToSend);
      if (sceneType) fd.append("sceneType", sceneType);
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

        // Start polling for this job until it completes or fails
        setProgressText("Retry submitted. Waiting for enhanced image...");
        setRunState("running");
        const controller = new AbortController();
        setAbortController(controller);

        // Poll for the single job status using the batch endpoint for consistency
        const pollRetryJob = async () => {
          const pollStart = Date.now();
          const pollTimeout = 10 * 60 * 1000; // 10 minutes max
          let delay = 1000;
          while (Date.now() - pollStart < pollTimeout) {
            if (controller.signal.aborted) return;
            try {
              const resp = await fetch(api(`/api/status/batch?ids=${encodeURIComponent(jobId)}`), {
                method: "GET",
                credentials: "include",
                headers: { ...withDevice().headers, "Cache-Control": "no-cache" },
                signal: controller.signal
              });
              if (!resp.ok) {
                await new Promise(r => setTimeout(r, delay));
                continue;
              }
              const statusData = await resp.json();
              const items = Array.isArray(statusData.items) ? statusData.items : [];
              const job = items.find((j: any) => j.id === jobId) || items[0];
              if (job && job.status === "completed" && job.imageUrl) {
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
                const preservedOriginalUrl = results[imageIndex]?.result?.originalImageUrl || results[imageIndex]?.originalImageUrl;
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
                setRunState("done");
                setAbortController(null);
                setProgressText("Retry complete! Enhanced image is ready.");
                return;
              } else if (job && job.status === "failed") {
                setRunState("done");
                setAbortController(null);
                setProgressText("Retry failed. Unable to enhance image.");
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
          setRunState("done");
          setAbortController(null);
          setProgressText("Retry timed out. Please try again.");
          toast({
            title: "Retry timed out",
            description: "The retry job did not complete in time. Please try again.",
            variant: "destructive"
          });
        };
        pollRetryJob();
      } catch (error) {
        console.error("Retry failed:", error);
        toast({
          title: "Retry failed",
          description: error instanceof Error ? error.message : "Unknown error",
          variant: "destructive"
        });
      }
    } finally {
      setRetryingImages(prev => {
        const newSet = new Set(prev);
        newSet.delete(imageIndex);
        return newSet;
      });
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

  return (
  <div className="max-w-4xl mx-auto p-6 bg-brand-surface min-h-screen">
      {/* Main header and tab navigation remain unchanged. No legacy bottom edit section. All region editing is handled in the RegionEditor modal. */}

      {/* Tab Content */}
  <div className="bg-brand-surface/95 rounded-xl shadow-lg p-8">
        
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
            
            <div className="border-2 border-dashed border-gray-600 rounded-lg p-12 hover:border-purple-500 transition-colors">
              <input 
                type="file" 
                multiple 
                onChange={onFiles} 
                className="hidden"
                id="file-upload"
                accept="image/*"
                data-testid="input-batch-files"
              />
              <label htmlFor="file-upload" className="cursor-pointer">
                <div className="text-6xl mb-4">📸</div>
                <p className="text-lg font-medium text-white mb-2">
                  {files.length === 0 ? "Click to select images" : "Click to add more images"}
                </p>
                <p className="text-sm text-gray-400">
                  Supports JPEG, PNG, WEBP • Max 15MB per image
                </p>
              </label>
            </div>

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
                        selection.has(i) ? "border-blue-500 ring-2 ring-blue-500/30" : "border-gray-600"
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
                  className="mt-6 bg-purple-600 text-white px-6 py-3 rounded-lg hover:bg-purple-700 transition-colors font-medium"
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
                      checked={preserveStructure}
                      onChange={(e) => setPreserveStructure(e.target.checked)}
                      className="w-5 h-5 text-purple-600 border-gray-600 bg-gray-800 rounded focus:ring-purple-500"
                      data-testid="checkbox-preserve-structure"
                    />
                    <div>
                      <span className="text-sm font-medium text-white">Preserve original features</span>
                      <p className="text-xs text-gray-400">No structural changes to rooms or layouts</p>
                    </div>
                  </label>

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
                        <option value="Modern">Modern</option>
                        <option value="Contemporary">Contemporary</option>
                        <option value="Minimalist">Minimalist</option>
                        <option value="Scandinavian">Scandinavian</option>
                        <option value="Traditional">Traditional</option>
                        <option value="Industrial">Industrial</option>
                      </select>
                    </div>
                  )}

                  <label className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={allowRetouch}
                      onChange={(e) => setAllowRetouch(e.target.checked)}
                      className="w-5 h-5 text-purple-600 border-gray-600 bg-gray-800 rounded focus:ring-purple-500"
                      data-testid="checkbox-allow-retouch"
                    />
                    <div>
                      <span className="text-sm font-medium text-white">Allow retouch</span>
                      <p className="text-xs text-gray-400">Lighting, color, and cleanup adjustments</p>
                    </div>
                  </label>

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

                {preserveStructure && allowStaging && (
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
                  className="px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-medium"
                  data-testid="button-next-to-images"
                >
                  Next →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Images Tab */}
        {activeTab === "images" && (
          <div>
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-semibold text-white">Configure Your Images</h2>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="link-images"
                  checked={linkImages}
                  onChange={(e) => setLinkImages(e.target.checked)}
                  className="rounded border-gray-300"
                  data-testid="checkbox-link-images"
                />
                <label htmlFor="link-images" className="text-white text-sm">
                  Link Images
                </label>
              </div>
            </div>
            
            {/* Tuning Controls */}
            <div className="mb-6 p-4 rounded-lg border border-gray-700 bg-gray-800/60">
              <div className="flex flex-wrap items-end gap-4">
                {/* Declutter Intensity removed: always uses heavy/preset in backend prompt */}
                {!samplingUiEnabled ? (
                  <div className="text-xs text-gray-400 max-w-xl">
                    Temperature/topP/topK are disabled. Prompts embed temperature per stage/scene. Declutter intensity remains configurable here.
                  </div>
                ) : (
                  <>
                    <div>
                      <label className="block text-gray-300 text-xs font-medium mb-2">Temperature</label>
                      <input
                        type="number"
                        step="0.01"
                        placeholder="e.g. 0.55"
                        value={temperatureInput}
                        onChange={(e)=>setTemperatureInput(e.target.value)}
                        className="w-32 px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-gray-300 text-xs font-medium mb-2">topP</label>
                      <input
                        type="number"
                        step="0.01"
                        placeholder="e.g. 0.85"
                        value={topPInput}
                        onChange={(e)=>setTopPInput(e.target.value)}
                        className="w-32 px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-gray-300 text-xs font-medium mb-2">topK</label>
                      <input
                        type="number"
                        step="1"
                        placeholder="e.g. 40"
                        value={topKInput}
                        onChange={(e)=>setTopKInput(e.target.value)}
                        className="w-28 px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white text-sm"
                      />
                    </div>
                    <div className="text-xs text-gray-400 max-w-xl">
                      These optional controls apply to the whole batch. Leave blank to use smart defaults or server config.
                    </div>
                  </>
                )}
              </div>
            </div>

            <p className="text-gray-300 mb-8">
              Selecting scene type and room type is completely optional but will often get better results if completed. If you don't want to complete this section, just click "Start Enhancing" at the bottom of the page.
            </p>

            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {files.map((file, index) => (
                <div key={index} className="bg-gray-800 rounded-lg p-4 border border-gray-700">
                  {/* Image Preview */}
                  <div className="relative mb-4">
                    <img
                      src={previewUrls[index]}
                      alt={`Preview ${index + 1}`}
                      className="w-full h-32 object-cover rounded-lg"
                    />
                    <div className="absolute top-2 left-2 bg-black bg-opacity-70 text-white px-2 py-1 rounded text-xs">
                      {index + 1}
                    </div>
                  </div>

                  {/* Image Name */}
                  <div className="mb-4">
                    <p className="text-white text-sm font-medium truncate" title={file.name}>
                      {file.name}
                    </p>
                  </div>

                  {/* Scene Selector Dropdown */}
                  <div className="mb-4">
                    <label className="block text-gray-300 text-xs font-medium mb-2">
                      Scene Type
                    </label>
                    <select
                      value={imageSceneTypes[index] || "auto"}
                      onChange={(e) => setImageSceneTypes(prev => ({ ...prev, [index]: e.target.value }))}
                      className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                      data-testid={`select-scene-${index}`}
                    >
                      <option value="auto">Auto</option>
                      <option value="interior">Interior</option>
                      <option value="exterior">Exterior</option>
                    </select>
                  </div>

                  {/* Sky Replacement Toggle - Only show for exterior images */}
                  {imageSceneTypes[index] === "exterior" && (
                    <div className="mb-4 p-3 bg-gray-800/50 rounded-md border border-gray-700">
                      <label className="flex items-center justify-between cursor-pointer">
                        <div>
                          <span className="block text-gray-300 text-sm font-medium">
                            Replace Sky
                          </span>
                          <span className="block text-gray-500 text-xs mt-1">
                            Replace cloudy skies with clear blue
                          </span>
                        </div>
                        <input
                          type="checkbox"
                          checked={imageSkyReplacement[index] !== undefined ? imageSkyReplacement[index] : true}
                          onChange={(e) => setImageSkyReplacement(prev => ({ ...prev, [index]: e.target.checked }))}
                          className="ml-3 w-5 h-5 text-purple-600 bg-gray-700 border-gray-600 rounded focus:ring-purple-500 focus:ring-2"
                          data-testid={`toggle-sky-${index}`}
                        />
                      </label>
                    </div>
                  )}

                  {/* Room Type Dropdown */}
                  {/* Room Type Dropdown – only for interior images when staging is enabled */}
                  {allowStaging && (imageSceneTypes[index] || "interior") !== "exterior" && (
                    <div className="mb-4">
                      <label className="block text-gray-300 text-xs font-medium mb-2">
                        Room Type
                      </label>
                      <select
                        value={imageRoomTypes[index] || ""}
                        onChange={(e) =>
                          setImageRoomTypes((prev) => ({ ...prev, [index]: e.target.value }))
                        }
                        className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                        data-testid={`select-room-${index}`}
                      >
                        <option value="" disabled>
                          Select room type…
                        </option>
                        <option value="bedroom-1">Bedroom 1</option>
                        <option value="bedroom-2">Bedroom 2</option>
                        <option value="bedroom-3">Bedroom 3</option>
                        <option value="kitchen">Kitchen</option>
                        <option value="living-room">Living Room</option>
                        <option value="multi-living">Multiple Living Areas</option>
                        <option value="dining-room">Dining Room</option>
                        <option value="study">Study</option>
                        <option value="office">Office</option>
                        <option value="bathroom-1">Bathroom 1</option>
                        <option value="bathroom-2">Bathroom 2</option>
                        <option value="laundry">Laundry</option>
                        <option value="garden">Garden</option>
                        <option value="patio">Patio</option>
                        <option value="deck">Deck</option>
                        <option value="balcony">Balcony</option>
                        <option value="garage">Garage</option>
                        <option value="basement">Basement</option>
                        <option value="attic">Attic</option>
                        <option value="hallway">Hallway</option>
                        <option value="staircase">Staircase</option>
                        <option value="entryway">Entryway</option>
                        <option value="closet">Closet</option>
                        <option value="pantry">Pantry</option>
                      </select>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="flex justify-between items-center mt-8 pt-6 border-t border-gray-600">
              <button
                onClick={() => setActiveTab("describe")}
                className="px-6 py-3 border border-gray-600 text-gray-300 rounded-lg hover:bg-gray-800 transition-colors"
                data-testid="button-back-describe"
              >
                ← Back to Settings
              </button>
              <button
                onClick={() => {
                  setActiveTab("enhance");
                  // Auto-start processing when proceeding to enhance
                  startBatchProcessing();
                }}
                className="px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-medium"
                data-testid="button-proceed-enhance"
              >
                Enhance (max {allowStaging ? files.length * 2 : files.length} credits) →
              </button>
            </div>
          </div>
        )}

        {/* Enhance Tab */}
        {activeTab === "enhance" && (
          <div>
            <h2 className="text-2xl font-semibold text-gray-900 mb-6">Enhance Your Images</h2>
            
            {runState === "idle" && (
              <div className="text-center py-8">
                <div className="text-6xl mb-4">✨</div>
                <h3 className="text-xl font-medium text-gray-900 mb-2">
                  Ready to enhance {files.length} images
                </h3>
                <p className="text-gray-600 mb-6">
                  Industry: {industryMap[presetKey]} • {preserveStructure ? "Structure preserved" : "Flexible changes"} • {allowStaging ? (furnitureReplacement ? "Furniture upgrade mode" : "Staging enabled") : "No staging"}
                </p>
                <button
                  onClick={startBatchProcessing}
                  disabled={!files.length}
                  className="bg-blue-600 text-white px-8 py-4 rounded-lg hover:bg-blue-700 transition-colors font-medium text-lg disabled:opacity-50"
                  data-testid="button-start-batch"
                >
                  Enhance (max {allowStaging ? files.length * 2 : files.length} credits)
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
            )}

            {/* Progress Display */}
            {runState === "running" && progressText && (
              <div className="bg-brand-light border border-blue-200 rounded-lg p-6 mb-6">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mr-4"></div>
                  <span className="text-blue-800 font-medium" data-testid="text-progress-counter">
                    {progressText}
                  </span>
                  </div>
                  <div>
                    <button
                      onClick={cancelBatchProcessing}
                      className="px-3 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                      disabled={!abortController}
                      data-testid="button-cancel-batch"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
                {lastDetected && (
                  <div className="mt-3 flex items-center justify-center gap-2">
                    <span className="text-sm text-gray-700">
                      Detected: <span className="font-medium capitalize">{lastDetected.label.replace(/_/g, ' ')}</span> ({Math.round((lastDetected.confidence||0)*100)}%)
                    </span>
                    <OverrideDropdown
                      currentLabel={lastDetected.label}
                      onSelect={async (label) => {
                        try {
                          const fname = files[lastDetected.index]?.name;
                          if (!fname) return alert('Cannot re-queue: filename missing');
                          await apiJson(`/api/requeue/by-filename`, {
                            method: 'POST',
                            body: JSON.stringify({ filename: fname, sceneType: label })
                          });
                          toast({ title: 'Re-queued', description: `Reprocessing with scene: ${label}` });
                        } catch (e: any) {
                          alert(e?.message || 'Failed to re-queue');
                        }
                      }}
                    />
                  </div>
                )}
              </div>
            )}

            {/* Live Results Grid - Show immediately when processing starts */}
            {runState !== "idle" && files.length > 0 && (
              <div className="space-y-4">
                <h3 className="text-lg font-medium text-gray-900">Enhancement Results</h3>
                <div className="grid gap-4">
                  {files.map((file, i) => {
                    const result = results?.[i];
                    const baseUrl = getDisplayUrl(result);
                    // Add cache-busting version to force browser reload on retry/edit
                    const imageUrl = withVersion(baseUrl, result?.version || result?.updatedAt);
                    const displayName = result?.filename || file?.name || `Image ${i+1}`;
                    // Use server's original URL (from S3) for comparison slider, fallback to local preview
                    const originalUrl = result?.originalImageUrl || previewUrls[result?.index ?? i];
                    return (
                    <div key={i} className="bg-brand-light rounded-lg p-4 flex gap-4 items-start">
                      <div className="relative w-24 h-24">
                        {imageUrl ? (
                          <>
                            <img 
                              key={imageUrl}
                              src={imageUrl} 
                              className={`w-24 h-24 object-cover rounded-lg border border-gray-300 cursor-pointer hover:opacity-80 ${retryingImages.has(i) || editingImages.has(i) ? 'opacity-50' : ''}`}
                              onClick={() => {
                                if (retryingImages.has(i) || editingImages.has(i)) return;
                                console.log('[PREVIEW] Opening modal:', { imageUrl, displayName, originalUrl, index: i });
                                setPreviewImage({
                                  url: imageUrl,
                                  filename: displayName,
                                  originalUrl: originalUrl,
                                  index: i
                                });
                              }}
                              onLoad={() => {
                                // Show success toast only when new image loads during retry or edit
                                if (retryingImages.has(i)) {
                                  toast({
                                    title: "Retry complete",
                                    description: `${displayName} has been successfully enhanced.`
                                  });
                                  // Remove from retrying set
                                  setRetryingImages(prev => {
                                    const next = new Set(prev);
                                    next.delete(i);
                                    return next;
                                  });
                                } else if (editingImages.has(i)) {
                                  toast({
                                    title: "Edit complete",
                                    description: `${displayName} has been successfully enhanced with the advanced editor.`
                                  });
                                  // Remove from editing set
                                  setEditingImages(prev => {
                                    const next = new Set(prev);
                                    next.delete(i);
                                    return next;
                                  });
                                }
                              }}
                              data-testid={`img-result-${i}`}
                            />
                            {/* Loading overlay during retry or edit */}
                            {(retryingImages.has(i) || editingImages.has(i)) && (
                              <div className="absolute inset-0 bg-black bg-opacity-50 rounded-lg flex items-center justify-center">
                                <div className="text-center text-white">
                                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-white mx-auto mb-2"></div>
                                  <div className="text-xs font-medium">
                                    {retryingImages.has(i) ? "Enhancing..." : "Editing..."}
                                  </div>
                                </div>
                              </div>
                            )}
                            {/* Strict retry badge (validator-driven) */}
                            {strictRetryingIndices.has(i) && (
                              <div className="absolute top-1 left-1">
                                <span className="bg-purple-600 text-white text-[10px] px-2 py-0.5 rounded-full shadow">
                                  Strict retry
                                </span>
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="w-24 h-24 bg-gray-200 rounded-lg border border-gray-300 flex items-center justify-center text-sm text-gray-500">
                            {runState === "running" ? "..." : "No image"}
                          </div>
                        )}
                      </div>
                      <div className="flex-1">
                        <p className="font-medium text-gray-900">{displayName}</p>
                        {imageUrl ? (
                          <>
                            {/* NEW: Show different indicators for polish-only vs staged enhancements */}
                            {result?.result?.mode === 'polish-only' ? (
                              <>
                                <div className="flex items-center gap-2 mb-2">
                                  <span className="bg-amber-100 text-amber-800 text-xs px-2 py-1 rounded-full font-medium">
                                    POLISH ONLY
                                  </span>
                                  <p className="text-amber-700 text-sm">✓ Enhanced with polish-only mode</p>
                                </div>
                                {result?.result?.note && (
                                  <p className="text-gray-600 text-xs mb-2">{result.result.note}</p>
                                )}
                              </>
                            ) : (
                              <p className="text-green-600 text-sm mb-2">✓ Enhanced successfully</p>
                            )}
                            <div className="flex gap-3">
                              <button
                                onClick={() => setPreviewImage({
                                  url: imageUrl,
                                  filename: displayName,
                                  originalUrl: originalUrl,
                                  index: i
                                })}
                                className="text-blue-600 hover:text-blue-700 text-sm font-medium"
                                data-testid={`button-preview-${i}`}
                              >
                                Preview
                              </button>
                              <a 
                                href={imageUrl} 
                                target="_blank" 
                                className="text-blue-600 hover:text-blue-700 text-sm font-medium"
                              >
                                Download
                              </a>
                              <button
                                onClick={() => handleOpenRetryDialog(i)}
                                disabled={retryingImages.has(i) || editingImages.has(i)}
                                className="text-blue-600 hover:text-blue-700 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                                data-testid={`button-retry-${i}`}
                              >
                                {retryingImages.has(i) ? "Retrying..." : "Retry"}
                              </button>
                              <button
                                onClick={() => handleEditImage(i)}
                                disabled={retryingImages.has(i) || editingImages.has(i)}
                                className="text-blue-600 hover:text-blue-700 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                                data-testid={`button-edit-${i}`}
                              >
                                {editingImages.has(i) ? "Editing..." : "Edit"}
                              </button>
                            </div>
                            {/* Timings & Compliance badges if available */}
                            {result?.result?.meta?.timings || result?.result?.meta?.compliance ? (
                              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                                {result?.result?.meta?.timings && (
                                  <span className="bg-gray-100 text-gray-700 px-2 py-1 rounded">
                                    ⏱ {Math.round((result.result.meta.timings.totalMs||0)/100)/10}s
                                  </span>
                                )}
                                {result?.result?.meta?.compliance && (
                                  result.result.meta.compliance.ok ? (
                                    <span className="bg-green-100 text-green-700 px-2 py-1 rounded">Compliance OK</span>
                                  ) : (
                                    <span className="bg-red-100 text-red-700 px-2 py-1 rounded">Compliance blocked</span>
                                  )
                                )}
                              </div>
                            ) : null}
                            {/* Classification badges (scene + room + staging gate) */}
                            {(() => {
                              const meta = result?.result?.meta;
                              if (!meta) return null;
                              const sceneLabel = meta?.scene?.label;
                              const userRoom = imageRoomTypes[i];
                              const detectedRoom = meta?.roomTypeDetected || meta?.roomType;
                              const finalRoom = userRoom && userRoom !== 'auto' ? userRoom : detectedRoom;
                              const badges: React.ReactNode[] = [];
                              if (sceneLabel) {
                                badges.push(
                                  <span key="scene" className="bg-blue-100 text-blue-700 px-2 py-1 rounded">
                                    {String(sceneLabel).replace(/_/g,' ')}
                                  </span>
                                );
                              }
                              if (finalRoom) {
                                badges.push(
                                  <span key="room" className="bg-indigo-100 text-indigo-700 px-2 py-1 rounded">
                                    Room: {String(finalRoom).replace(/_/g,' ')}
                                  </span>
                                );
                              }
                              if (meta?.allowStaging === false) {
                                badges.push(<span key="staging-block" className="bg-yellow-100 text-yellow-700 px-2 py-1 rounded">Staging blocked</span>);
                              } else if (meta?.allowStaging) {
                                badges.push(<span key="staging-ok" className="bg-green-100 text-green-700 px-2 py-1 rounded">Staging OK</span>);
                              }
                              if (!badges.length) return null;
                              return (
                                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                                  {badges}
                                  <button
                                    onClick={() => handleOpenRetryDialog(i)}
                                    className="underline text-blue-600 hover:text-blue-700"
                                  >Override room</button>
                                </div>
                              );
                            })()}
                          </>
                        ) : result?.error ? (
                          <p className="text-red-600 text-sm">Error: {result.error}</p>
                        ) : (
                          <p className="text-gray-500 text-sm">Processing...</p>
                        )}
                      </div>
                    </div>
                  );
                })}
                </div>
              </div>
            )}

            {/* Action buttons after completion */}
            {runState === "done" && (() => {
              // Calculate successful results count for accurate ZIP counter
              const successfulResults = results.filter(r => r && !r.error && (r.result?.image || r.result?.imageUrl || r.image || r.imageUrl));
              
              return (
              <div className="mt-8 flex flex-wrap gap-4 justify-center">
                <button 
                  onClick={downloadZip}
                  disabled={successfulResults.length === 0 || isDownloadingZip}
                  className="bg-purple-600 text-white px-6 py-3 rounded-lg hover:bg-purple-700 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                  data-testid="button-download-zip"
                >
                  {isDownloadingZip ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                      Preparing ZIP...
                    </>
                  ) : (
                    `Download All as ZIP (${successfulResults.length})`
                  )}
                </button>
                
                {results.some(r => r?.error) && (
                  <button 
                    onClick={handleRetryFailed}
                    className="bg-yellow-600 text-white px-6 py-3 rounded-lg hover:bg-yellow-700 transition-colors font-medium"
                    data-testid="button-retry-failed"
                  >
                    Retry Failed Images
                  </button>
                )}
                
                <button 
                  onClick={handleRestart}
                  className="bg-gray-600 text-white px-6 py-3 rounded-lg hover:bg-gray-700 transition-colors font-medium"
                  data-testid="button-restart-batch"
                >
                  Start Over
                </button>
              </div>
              );
            })()}

          </div>
        )}
      </div>

      {/* Preview/Edit Modals */}
      {previewImage && (
        <Modal isOpen={true} onClose={() => setPreviewImage(null)} maxWidth="full" contentClassName="max-w-7xl">
          <div className="text-center">
            <h3 className="text-lg font-semibold mb-4">{previewImage.filename}</h3>
            
            {/* Debug logging removed: do not use console.log in JSX */}
              filename: previewImage.filename,
              hasUrl: !!previewImage.url,
              hasOriginal: !!previewImage.originalUrl
            
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
                className="px-4 py-2 bg-brand-light0 text-white rounded hover:bg-gray-600 transition-colors"
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
                className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
                className="px-4 py-2 bg-brand-accent text-white rounded hover:bg-brand-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="button-edit-from-preview"
              >
                Edit
              </button>
              <a 
                href={previewImage.url} 
                target="_blank" 
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
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
              const activeItem = results[editingImageIndex];
              console.log('[BatchProcessor] RAW ITEM FOR REGION EDIT', activeItem);
              const item = activeItem;
              // Prefer Stage 2 (current/enhanced) as the initial preview. If missing, fall back to Stage1 (quality) and lastly to display URL
              const stageUrls = item?.stageUrls || item?.result?.stageUrls || {};
              const stage2 = stageUrls?.['2'] || stageUrls?.[2] || undefined;
              const stage1b = stageUrls?.['1B'] || stageUrls?.['1b'] || undefined;
              const stage1a = stageUrls?.['1A'] || stageUrls?.['1a'] || undefined;
              const quality = stage1b || stage1a || undefined;
              const fallback = getDisplayUrl(results[editingImageIndex]) || undefined;
              const initial = stage2 || quality || fallback;
              console.log('[BatchProcessor] Resolved initialImageUrl (stage2||quality||fallback):', { stage2, stage1b, stage1a, initial, fallback });
              return initial;
            })()}
            // Explicit mapping for restore base: prefer Stage 1B then Stage 1A. No broad fallbacks.
            originalImageUrl={(() => {
              const item = results[editingImageIndex];
              const stageUrls = item?.stageUrls || item?.result?.stageUrls || {};
              const stage1b = stageUrls?.['1B'] || stageUrls?.['1b'] || undefined;
              const stage1a = stageUrls?.['1A'] || stageUrls?.['1a'] || undefined;
              const resolved = stage1b || stage1a || undefined;
              console.log('[BatchProcessor] Resolved originalImageUrl (1B||1A):', { stage1b, stage1a, resolved });
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
                const preservedOriginalUrl = results[editingImageIndex]?.result?.originalImageUrl || results[editingImageIndex]?.originalImageUrl;
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
              }
              refreshUser();
              setRegionEditorOpen(false);
              setEditingImageIndex(null);
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