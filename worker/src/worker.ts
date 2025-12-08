import type { ComplianceVerdict } from "./ai/compliance";
import { Worker, Job } from "bullmq";
import { JOB_QUEUE_NAME } from "@realenhance/shared/constants";
import {
  AnyJobPayload,
  EnhanceJobPayload,
  EditJobPayload,
  RegionEditJobPayload
} from "@realenhance/shared/types";

import fs from "fs";
import sharp from "sharp";

import { runStage1A } from "./pipeline/stage1A";
import { runStage1B } from "./pipeline/stage1B";
import { runStage2 } from "./pipeline/stage2";
import { computeStructuralEdgeMask } from "./validators/structuralMask";
import { applyEdit } from "./pipeline/editApply";
import { preprocessToCanonical } from "./pipeline/preprocess";

import { detectSceneFromImage } from "./ai/scene-detector";
import { detectRoomType } from "./ai/room-detector";
import { classifyScene } from "./validators/scene-classifier";

import {
  updateJob,
  pushImageVersion,
  readImageRecord,
  getVersionPath,
  getOriginalPath
} from "./utils/persist";
import { setVersionPublicUrl } from "./utils/persist";
import { recordEnhancedImage } from "../../shared/src/imageHistory";
import { recordEnhancedImageRedis } from "@realenhance/shared";
import { getGeminiClient, enhanceWithGemini } from "./ai/gemini";
import { checkCompliance } from "./ai/compliance";
import { toBase64 } from "./utils/images";
import { isCancelled } from "./utils/cancel";
import { getStagingProfile } from "./utils/groups";
import { publishImage } from "./utils/publish";
import { downloadToTemp } from "./utils/remote";
import { runStructuralCheck } from "./validators/structureValidatorClient";
import { logValidatorConfig } from "./validators/validatorMode";
import {
  runUnifiedValidation,
  logUnifiedValidationCompact,
  type UnifiedValidationResult
} from "./validators/runValidation";
import { runSemanticStructureValidator } from "./validators/semanticStructureValidator";
import { runMaskedEdgeValidator } from "./validators/maskedEdgeValidator";
import { vLog, nLog } from "./logger";
import { VALIDATOR_FOCUS } from "./config";

/**
 * FILENAME ENFORCEMENT: Build stage path with explicit pass numbering
 * Stage 1B-1 → -1B-1.webp
 * Stage 1B-2 → -1B-2.webp
 * Rewrites legacy "-1B.webp" to "-1B-1.webp" if no pass number detected
 */
function buildStagePath(sourcePath: string, stageCode: "1B-1" | "1B-2"): string {
  const path = require("path");
  const dir = path.dirname(sourcePath);
  const base = path.basename(sourcePath, path.extname(sourcePath));
  
  // Remove any existing stage markers
  const cleanBase = base.replace(/-1[AB](-[12])?$/, "");
  
  // Add new stage marker
  const newBase = `${cleanBase}-${stageCode}.webp`;
  return path.join(dir, newBase);
}

/**
 * OPTIMIZED GEMINI API CALL STRATEGY
 * ==================================
 * 
 * To minimize costs and API calls, we use these strategies:
 * 
 * Case A - Enhance Only (no declutter, no staging):
 *   • Stage 1A: Sharp pre-process → 1 Gemini call (enhance-only prompt) → save as 1A
 *   • Total: 1 Gemini call per image
 * 
 * Case B - Enhance + Declutter (no staging):
 *   • Stage 1A: Sharp pre-process → save as 1A (no Gemini, just technical prep)
 *   • Stage 1B: 1 Gemini call (combined enhance+declutter prompt) → save as 1B
 *   • Total: 1 Gemini call per image (saves cost vs separate enhance + declutter)
 * 
 * Case C - Enhance + Declutter + Staging:
 *   • Stage 1A: Sharp pre-process → save as 1A (no Gemini)
 *   • Stage 1B: 1 Gemini call (combined enhance+declutter prompt) → save as 1B
 *   • Stage 2: 1 Gemini call (virtual staging) → save as 2
 *   • Total: 2 Gemini calls per image
 * 
 * Maximum reduction: From 3 potential calls → 2 max, 1 typical
 */

// handle "enhance" pipeline
async function handleEnhanceJob(payload: EnhanceJobPayload) {
  nLog(`========== PROCESSING JOB ${payload.jobId} ==========`);
  // Strict boolean normalization to avoid truthy string issues (e.g. "false" becoming true)
  const strictBool = (v: any): boolean => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v === 1;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (["true","1","yes","y","on"].includes(s)) return true;
      if (["false","0","no","n","off",""] .includes(s)) return false;
    }
    return false;
  };
  const rawDeclutter = (payload as any).options.declutter;
  const rawVirtualStage = (payload as any).options.virtualStage;
  (payload as any).options.declutter = strictBool(rawDeclutter);
  (payload as any).options.virtualStage = strictBool(rawVirtualStage);
  if (typeof rawDeclutter !== 'boolean') {
    nLog(`[WORKER] Normalized declutter '${rawDeclutter}' → ${payload.options.declutter}`);
  }
  if (typeof rawVirtualStage !== 'boolean') {
    nLog(`[WORKER] Normalized virtualStage '${rawVirtualStage}' → ${payload.options.virtualStage}`);
  }
  
  // Check if we have a remote original URL (multi-service deployment)
  const remoteUrl: string | undefined = (payload as any).remoteOriginalUrl;
  let origPath: string;
  
  if (remoteUrl) {
    // Multi-service mode: Download original from S3
    try {
      nLog(`[WORKER] Remote original detected, downloading: ${remoteUrl}\n`);
      origPath = await downloadToTemp(remoteUrl, payload.jobId);
      nLog(`[WORKER] Remote original downloaded to: ${origPath}\n`);
    } catch (e) {
      nLog(`[WORKER] ERROR: Failed to download remote original: ${(e as any)?.message || e}\n`);
      updateJob(payload.jobId, { status: "error", errorMessage: `Failed to download original: ${(e as any)?.message || 'unknown error'}` });
      return;
    }
  } else {
    // Legacy single-service mode: Read from local filesystem
    nLog("[WORKER] WARN: Job lacks remoteOriginalUrl. Attempting to read from local filesystem.\n");
    nLog("[WORKER] In production multi-service deployment, server should upload originals to S3 and provide remoteOriginalUrl.\n");
    
    const rec = readImageRecord(payload.imageId);
    if (!rec) {
      nLog(`[WORKER] ERROR: Image record not found for ${payload.imageId} and no remoteOriginalUrl provided.\n`);
      updateJob(payload.jobId, { status: "error", errorMessage: "image not found - no remote URL and local record missing" });
      return;
    }
    origPath = getOriginalPath(rec);
    if (!fs.existsSync(origPath)) {
      nLog(`[WORKER] ERROR: Local original file not found at ${origPath}\n`);
      updateJob(payload.jobId, { status: "error", errorMessage: "original file not accessible in this container" });
      return;
    }
  }

  // ═══════════ STAGE-2-ONLY RETRY MODE ═══════════
  // ✅ Smart retry: Skip 1A/1B, run only Stage-2 from validated 1B output
  if (payload.stage2OnlyMode?.enabled && payload.stage2OnlyMode?.base1BUrl) {
    nLog(`[worker] 🚀 ═══════════ STAGE-2-ONLY RETRY MODE ACTIVATED ═══════════`);
    nLog(`[worker] Reusing validated Stage-1B output: ${payload.stage2OnlyMode.base1BUrl}`);

    // ✅ RETRY SAFETY: Validate stage provenance
    const base1BUrl = payload.stage2OnlyMode.base1BUrl;
    if (!base1BUrl.includes('-1B') && !base1BUrl.includes('stage1B') && !base1BUrl.includes('/1B/')) {
      const errMsg = "❌ Retry blocked — invalid stage provenance (Stage2OnlyMode requires Stage1B source)";
      nLog(errMsg);
      updateJob(payload.jobId, {
        status: "error",
        errorMessage: errMsg,
        error: errMsg,
        meta: { blockReason: 'invalid-retry-provenance' }
      });
      throw new Error(errMsg);
    }

    try {
      const timings: Record<string, number> = {};
      const t0 = Date.now();
      const t2 = Date.now();

      // Download Stage-1B base image
      const basePath = await downloadToTemp(payload.stage2OnlyMode.base1BUrl, `${payload.jobId}-stage1B`);
      nLog(`[worker] Downloaded Stage-1B base to: ${basePath}`);

      // Run Stage-2 only (using 1B as base)
      const path2 = await runStage2(basePath, "1B", {
        stagingStyle: payload.options.stagingStyle || "nz_standard",
        roomType: payload.options.roomType,
        sceneType: payload.options.sceneType as any,
        angleHint: undefined,
        profile: undefined,
        stagingRegion: undefined,
      });

      timings.stage2Ms = Date.now() - t2;
      nLog(`[worker] Stage-2-only completed in ${timings.stage2Ms}ms`);

      // Run validators on Stage-2 output (log-only)
      const sceneLabel = payload.options.sceneType === "exterior" ? "exterior" : "interior";

      // Note: runStructuralCheck requires URLs, but we'll skip geometry for stage2-only for now
      // The semantic and masked edge validators are the key ones for Stage-2

      await runSemanticStructureValidator({
        originalImagePath: basePath,
        enhancedImagePath: path2,
        scene: sceneLabel as any,
        mode: "log",
      });

      await runMaskedEdgeValidator({
        originalImagePath: basePath,
        enhancedImagePath: path2,
        scene: sceneLabel as any,
        mode: "log",
      });

      // Publish Stage-2 result
      const pub2 = await publishImage(path2);
      const pub2Url = pub2.url;

      timings.totalMs = Date.now() - t0;

      updateJob(payload.jobId, {
        status: "complete",
        resultUrl: pub2Url,
        stageUrls: {
          "1A": null,
          "1B": payload.stage2OnlyMode.base1BUrl,
          "2": pub2Url
        },
        meta: {
          stage2OnlyRetry: true,
          timings,
          scene: { label: sceneLabel as any, confidence: 0.5 }
        }
      });

      nLog(`[worker] ✅ Stage-2-only retry complete: ${pub2Url}`);
      return; // ✅ Exit early - full pipeline not needed

    } catch (err: any) {
      nLog(`[worker] ❌ Stage-2-only retry failed: ${err?.message || err}`);
      nLog(`[worker] Falling back to full pipeline retry`);
      // Continue to full pipeline below
    }
  }

  const timings: Record<string, number> = {};
  const t0 = Date.now();

  // UNIFIED VALIDATION CONFIGURATION
  // Set to true to enable blocking on validation failures
  // For now: LOG-ONLY MODE (never blocks images)
  const VALIDATION_BLOCKING_ENABLED = false;

  // VALIDATOR FOCUS MODE: Print session header
  if (VALIDATOR_FOCUS) {
    vLog("════════ IMAGE VALIDATION SESSION ════════");
    const imageLabel = (payload as any).label || (payload as any).originalFilename || payload.imageId || 'unknown';
    vLog(`[VAL][job=${payload.jobId}] label="${imageLabel}"`);
    vLog(`[VAL][job=${payload.jobId}] originalUrl=${remoteUrl || origPath}`);
  }

  // Publish original so client can render before/after across services
  nLog(`\n[WORKER] ═══════════ Publishing original image ═══════════`);
  const publishedOriginal = await publishImage(origPath);
  nLog(`[WORKER] Original published: kind=${publishedOriginal?.kind} url=${(publishedOriginal?.url||'').substring(0, 80)}...\n\n`);
  // surface early so UI can show before/after immediately
  updateJob(payload.jobId, { stage: "upload-original", progress: 10, originalUrl: publishedOriginal?.url });

  // Auto detection: primary scene (interior/exterior) + room type
  let detectedRoom: string | undefined;
  let sceneLabel = (payload.options.sceneType as any) || "auto";
  let scenePrimary: any = undefined;
  let allowStaging = true;
  let stagingRegionGlobal: any = null;
  // Manual scene override flag passed from client/server
  const manualSceneOverride = strictBool((payload as any).manualSceneOverride) || strictBool(((payload as any).options || {}).manualSceneOverride);
  const tScene = Date.now();
  try {
    const buf = fs.readFileSync(origPath);
    // Primary scene (ONNX + heuristic fallback)
    const primary = await detectSceneFromImage(buf);
    scenePrimary = primary;
    // Room type (ONNX + heuristic fallback; fallback again to legacy heuristic)
    let room = await detectRoomType(buf).catch(async () => null as any);
    if (!room) {
      const heur = await classifyScene(origPath);
      room = { label: heur.label, confidence: heur.confidence } as any;
    }
    detectedRoom = room.label as string;
    // Use primary scene detector for interior/exterior when sceneType=auto
    if (sceneLabel === "auto" || !sceneLabel) sceneLabel = (primary?.label as any) || "interior";
    // Outdoor staging area detection for exteriors
    let stagingRegion: any = null;
    if (sceneLabel === "exterior") {
      try {
        const { getGeminiClient } = await import("./ai/gemini.js");
        const { detectStagingArea } = await import("./ai/staging-area-detector.js");
        const { detectStagingRegion } = await import("./ai/region-detector.js");
        const sharpMod: any = await import("sharp");
        const ai = getGeminiClient();
        const base64 = toBase64(origPath).data;
        const stagingResult = await detectStagingArea(ai, base64);
        // ---------- Exterior gating rules ----------
        // Allowed types and confidence
        const allowedTypes = (process.env.EXTERIOR_STAGING_ALLOWED_TYPES || "deck,patio,balcony,terrace,verandah")
          .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
        const minConfLevel = (process.env.EXTERIOR_STAGING_MIN_CONFIDENCE_LEVEL || "medium").toLowerCase();
        const confRank = (c: string) => c === 'high' ? 3 : (c === 'medium' ? 2 : 1);
        const minRank = confRank(minConfLevel);

        // Initial decision from detector
        allowStaging = !!stagingResult.hasStagingArea;
        // Area type filter (defensive)
        const areaType = String(stagingResult.areaType || 'none').toLowerCase();
        if (!allowedTypes.includes(areaType)) {
          allowStaging = false;
          nLog(`[WORKER] Exterior gating: areaType='${areaType}' not in allowedTypes=[${allowedTypes.join(', ')}] → disallow staging`);
        }
        // Confidence gate
        const level = String(stagingResult.confidence || 'low').toLowerCase();
        if (confRank(level) < minRank) {
          allowStaging = false;
          nLog(`[WORKER] Exterior gating: confidence='${level}' < minLevel='${minConfLevel}' → disallow staging`);
        }

        // Region detection only if preliminarily allowed
        if (allowStaging) {
          stagingRegion = await detectStagingRegion(ai, base64);
          // Compute coverage % if region detected and image size known
          try {
            const meta = await sharpMod.default(origPath).metadata();
            const W = meta.width || 0;
            const H = meta.height || 0;
            if (stagingRegion && W > 0 && H > 0) {
              const area = Math.max(0, Math.min(stagingRegion.width, W)) * Math.max(0, Math.min(stagingRegion.height, H));
              const coverage = area / (W * H);
              const minCoverage = Number(process.env.EXTERIOR_STAGING_MIN_COVERAGE || 0.2);
              // Optional: require region to exist for staging
              const requireRegion = (process.env.EXTERIOR_STAGING_REQUIRE_REGION || '1') === '1';
              if (coverage < minCoverage) {
                allowStaging = false;
                nLog(`[WORKER] Exterior staging region below threshold: ${(coverage*100).toFixed(1)}% < ${(minCoverage*100).toFixed(0)}% → disallow staging`);
              } else {
                nLog(`[WORKER] Exterior staging region coverage: ${(coverage*100).toFixed(1)}% (>= ${(minCoverage*100).toFixed(0)}%)`);
              }
              if (requireRegion && !stagingRegion) {
                allowStaging = false;
                nLog(`[WORKER] Exterior gating: requireRegion=1 but no region detected → disallow staging`);
              }
              // If region has areaType metadata, ensure it matches allowed types
              const regionType = String((stagingRegion as any)?.areaType || areaType).toLowerCase();
              if (!allowedTypes.includes(regionType)) {
                allowStaging = false;
                nLog(`[WORKER] Exterior gating: region.areaType='${regionType}' not allowed → disallow staging`);
              }
              // Green dominance sanity check inside region (avoid staging on lawns)
              const greenCheck = (process.env.EXTERIOR_REGION_GREEN_CHECK || '1') === '1';
              if (allowStaging && greenCheck) {
                try {
                  const analysisSize = Math.max(64, Number(process.env.EXTERIOR_REGION_ANALYSIS_SIZE || 256));
                  const H_MIN = Number(process.env.EXTERIOR_GREEN_H_MIN || 70);
                  const H_MAX = Number(process.env.EXTERIOR_GREEN_H_MAX || 160);
                  const S_MIN = Number(process.env.EXTERIOR_GREEN_S_MIN || 0.28);
                  const V_MIN = Number(process.env.EXTERIOR_GREEN_V_MIN || 0.25);
                  const maxGreen = Math.min(0.9, Math.max(0, Number(process.env.EXTERIOR_REGION_GREEN_MAX || 0.25)));
                  // Shrink region by 5% margins to avoid boundary bleed
                  const shrinkX = Math.floor(stagingRegion.width * 0.05);
                  const shrinkY = Math.floor(stagingRegion.height * 0.05);
                  const rx = Math.max(0, Math.min(W - 1, Math.floor(stagingRegion.x + shrinkX)));
                  const ry = Math.max(0, Math.min(H - 1, Math.floor(stagingRegion.y + shrinkY)));
                  const rw = Math.max(1, Math.min(W - rx, Math.floor(stagingRegion.width - shrinkX * 2)));
                  const rh = Math.max(1, Math.min(H - ry, Math.floor(stagingRegion.height - shrinkY * 2)));
                  const patch = await sharpMod.default(origPath)
                    .extract({ left: rx, top: ry, width: rw, height: rh })
                    .resize(analysisSize, analysisSize, { fit: 'cover' })
                    .raw()
                    .toBuffer({ resolveWithObject: true });
                  const buf = patch.data as Buffer;
                  const w = analysisSize, h = analysisSize;
                  let green = 0, total = 0;
                  for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                      const i = (y * w + x) * 3; // raw() defaults to 3 channels without alpha
                      const r = buf[i] / 255, g = buf[i+1] / 255, b = buf[i+2] / 255;
                      const max = Math.max(r,g,b), min = Math.min(r,g,b);
                      const v = max; const d = max - min; const s = max === 0 ? 0 : d / max;
                      let hdeg = 0;
                      if (d !== 0) {
                        if (max === r) hdeg = ((g - b) / d) % 6; else if (max === g) hdeg = (b - r) / d + 2; else hdeg = (r - g) / d + 4;
                        hdeg *= 60; if (hdeg < 0) hdeg += 360;
                      }
                      const isGreen = (v > V_MIN) && (s > S_MIN) && (hdeg >= H_MIN && hdeg <= H_MAX);
                      if (isGreen) green++;
                      total++;
                    }
                  }
                  const greenRatio = green / Math.max(1, total);
                  const decision = greenRatio <= maxGreen;
                  nLog(`[WORKER] Exterior region green check: green=${(greenRatio*100).toFixed(1)}% max=${(maxGreen*100).toFixed(0)}% → ${decision ? 'allow' : 'disallow'}`);
                  if (!decision) {
                    allowStaging = false;
                  }
                } catch (e) {
                  nLog('[WORKER] Green-region check failed; proceeding without this gate', e);
                }
              }
              // attach coverage for meta/debugging
              (stagingRegion as any).coverage = coverage;
            }
          } catch (e) {
            nLog('[WORKER] Failed to compute staging coverage; proceeding without area gate', e);
          }
        }
        nLog(`[WORKER] Outdoor staging area: has=${stagingResult.hasStagingArea}, type=${stagingResult.areaType}, conf=${stagingResult.confidence}`);
        nLog(`[WORKER] Exterior staging decision: allowStaging=${allowStaging} (minConf=${minConfLevel}, minCoverage=${Number(process.env.EXTERIOR_STAGING_MIN_COVERAGE || 0.2)})`);
        if (stagingRegion) {
          nLog(`[WORKER] Staging region:`, stagingRegion);
        }
        stagingRegionGlobal = stagingRegion;
      } catch (e) {
        allowStaging = false;
        stagingRegion = null;
        stagingRegionGlobal = null;
        nLog(`[WORKER] Outdoor staging area/region detection failed, defaulting to no staging:`, e);
      }
    }
    // store interim meta (non-fatal if write fails)
    updateJob(payload.jobId, { meta: {
      scenePrimary: primary,
      scene: { label: room.label as any, confidence: room.confidence },
      allowStaging,
      stagingRegion: stagingRegionGlobal,
      roomTypeDetected: detectedRoom,
      roomType: payload.options.roomType || undefined
    } });
    try {
      nLog(`[WORKER] Scene resolved: primary=${primary?.label}(${(primary?.confidence??0).toFixed(2)}) → resolved=${sceneLabel}, room=${room.label}`);
    } catch {}
  } catch {
    if (sceneLabel === "auto" || !sceneLabel) sceneLabel = "other" as any;
    allowStaging = false;
  }
  timings.sceneDetectMs = Date.now() - tScene;

  if (await isCancelled(payload.jobId)) {
    updateJob(payload.jobId, { status: "error", errorMessage: "cancelled" });
    return;
  }

  // CANONICAL PREPROCESS (new) for structural baseline
  let canonicalPath = origPath.replace(/\.(jpg|jpeg|png|webp)$/i, "-canonical.webp");
  try {
    await preprocessToCanonical(origPath, canonicalPath, sceneLabel);
    (global as any).__canonicalPath = canonicalPath;
    // Precompute structural mask (architecture only) from canonical
    try {
      const mask = await computeStructuralEdgeMask(canonicalPath);
      (global as any).__structuralMask = mask;
      nLog(`[WORKER] Structural mask computed: ${mask.width}x${mask.height}`);
    } catch (e) {
      nLog('[WORKER] Failed to compute structural mask:', e);
    }
  } catch (e) {
    nLog('[WORKER] Canonical preprocess failed; falling back to original for stages', e);
    canonicalPath = origPath; // fallback
    (global as any).__canonicalPath = canonicalPath;
  }

  // STAGE 1A
  const t1A = Date.now();
  // Inject per-job tuning into global for pipeline modules (simple dependency injection)
  try {
    const s = (payload.options as any)?.sampling || {};
    (global as any).__jobSampling = {
      temperature: typeof s.temperature === 'number' ? s.temperature : undefined,
      topP: typeof s.topP === 'number' ? s.topP : undefined,
      topK: typeof s.topK === 'number' ? s.topK : undefined,
    };
    (global as any).__jobDeclutterIntensity = (payload.options as any)?.declutterIntensity;
    (global as any).__furnitureRemovalMode = (payload.options as any)?.furnitureRemovalMode || 'auto';
  } catch {}
  let path1A: string = origPath;
  // Stage 1A: Always run Gemini for quality enhancement (HDR, color, sharpness)
  // SKY SAFEGUARD: compute safeReplaceSky using manual override + pergola/roof detection
  let safeReplaceSky: boolean = ((): boolean => {
    const explicit = (payload.options.replaceSky as any);
    const explicitBool = typeof explicit === 'boolean' ? explicit : undefined;
    const defaultExterior = sceneLabel === "exterior";
    return explicitBool === undefined ? defaultExterior : explicitBool;
  })();
  if (manualSceneOverride) {
    safeReplaceSky = false;
    nLog(`[WORKER] Sky Safeguard: manualSceneOverride=1 → disable sky replacement`);
  }
  if (sceneLabel === "exterior") {
    try {
      const { detectRoofOrPergola } = await import("./validators/pergolaGuard.js");
      const hasRoof = await detectRoofOrPergola(origPath);
      if (hasRoof) {
        safeReplaceSky = false;
        nLog(`[WORKER] Sky Safeguard: pergola/roof detected → disable sky replacement`);
      }
    } catch (e) {
      nLog(`[WORKER] Sky Safeguard: pergola detector error (fail-open):`, (e as any)?.message || e);
    }
  }
  path1A = await runStage1A(canonicalPath, {
    replaceSky: safeReplaceSky,
    declutter: false, // Never declutter in Stage 1A - that's Stage 1B's job
    sceneType: sceneLabel,
    interiorProfile: ((): any => {
      const p = (payload.options as any)?.interiorProfile;
      if (p === 'nz_high_end' || p === 'nz_standard') return p;
      return undefined;
    })(),
  });
  timings.stage1AMs = Date.now() - t1A;
  
  // Record 1A version (optional in multi-service mode where images.json is not shared)
  let v1A: any = null;
  try {
    v1A = pushImageVersion({ imageId: payload.imageId, userId: payload.userId, stageLabel: "1A", filePath: path1A, note: "Quality enhanced" });
  } catch (e) {
    // Silently ignore - images.json is not available in multi-service deployment
    // This is expected and normal behavior
  }
  
  let pub1AUrl: string | undefined = undefined;
  let pub1BUrl: string | undefined = undefined;
  try {
    const pub1A = await publishImage(path1A);
    pub1AUrl = pub1A.url;
    if (v1A) {
      try {
        setVersionPublicUrl(payload.imageId, v1A.versionId, pub1A.url);
      } catch (e) {
        // Ignore - images.json not accessible in multi-service mode
      }
    }
    // VALIDATOR FOCUS: Log Stage 1A URL
    vLog(`[VAL][job=${payload.jobId}] stage1AUrl=${pub1AUrl}`);
  } catch (e) {
    nLog('[worker] failed to publish 1A', e);
  }
  updateJob(payload.jobId, { stage: "1A", progress: 35, stageUrls: { "1A": pub1AUrl } });
  if (await isCancelled(payload.jobId)) {
    updateJob(payload.jobId, { status: "error", errorMessage: "cancelled" });
    return;
  }

  // ═══════════ STAGE 1B — ENFORCED DUAL-PASS EXECUTION ═══════════
  const t1B = Date.now();
  let path1B: string | undefined = undefined;
  let stage1BPass1Complete = false;
  let stage1BPass1Path: string | undefined = undefined;
  let stage1BPass2Complete = false;
  let stage1BPass2Path: string | undefined = undefined;
  const requiresHeavyDeclutter = ((payload.options as any)?.furnitureRemovalMode === 'heavy');
  
  nLog(`[WORKER] Checking Stage 1B: payload.options.declutter=${payload.options.declutter}, requiresHeavyDeclutter=${requiresHeavyDeclutter}`);
  
  if (payload.options.declutter) {
    nLog(`[WORKER] ✅ Stage 1B ENABLED - enforced dual-pass furniture removal`);
    try {
      // ✅ ALWAYS RUN PRIMARY PASS (Stage 1B-1)
      nLog(`[stage1B-1] 🚪 PRIMARY furniture removal started`, {
        jobId: payload.jobId,
        mode: "main-only",
        input: path1A
      });
      
      // Run Stage 1B which handles the dual-pass internally
      path1B = await runStage1B(path1A, {
        replaceSky: false,
        sceneType: sceneLabel,
        roomType: payload.options.roomType,
      });
      
      // Determine which passes were executed based on filename
      if (path1B && path1B !== path1A) {
        if (path1B.includes("-1B-2")) {
          // Heavy mode: both passes executed
          stage1BPass1Complete = true;
          stage1BPass2Complete = true;
          stage1BPass2Path = path1B;
          // Derive pass1 path (even though it's intermediate)
          stage1BPass1Path = path1B.replace("-1B-2", "-1B-1");
          nLog(`[stage1B] ✅ Dual-pass complete: 1B-1 → 1B-2`);
        } else {
          // Standard mode: only pass1 executed
          stage1BPass1Complete = true;
          stage1BPass1Path = path1B;
          stage1BPass2Complete = false;
          stage1BPass2Path = undefined;
          nLog(`[stage1B] ✅ Single-pass complete: 1B-1 only`);
        }
      }
      
      nLog(`[stage1B-1] ✅ PRIMARY furniture removal complete`, {
        jobId: payload.jobId,
        output: stage1BPass1Path || path1B
      });
      
      if (requiresHeavyDeclutter && stage1BPass2Complete) {
        nLog(`[stage1B-2] ✅ SECONDARY declutter pass complete`, {
          jobId: payload.jobId,
          output: stage1BPass2Path
        });
      }
      
    } catch (e: any) {
      const errMsg = e?.message || String(e);
      nLog(`[worker] Stage 1B failed: ${errMsg}`);
      updateJob(payload.jobId, {
        status: "error",
        errorMessage: errMsg,
        error: errMsg,
        meta: { scene: { label: sceneLabel as any, confidence: 0.5 }, scenePrimary }
      });
      return;
    }
    timings.stage1BMs = Date.now() - t1B;
    if (await isCancelled(payload.jobId)) {
      updateJob(payload.jobId, { status: "error", errorMessage: "cancelled" });
      return;
    }
  }

  // Record Stage 1B publish if it exists and is different from 1A
  // pub1BUrl already declared above; removed duplicate
  if (path1B && path1B !== path1A) {
    try {
      const pub1B = await publishImage(path1B);
      pub1BUrl = pub1B.url;
      updateJob(payload.jobId, { stage: payload.options.declutter ? "1B" : "1A", progress: 55, stageUrls: { "1B": pub1BUrl }, imageUrl: pub1BUrl });
    } catch (e) {
      nLog('[worker] failed to publish 1B', e);
    }
  }

  // ═══════════ Post-1B Structural Validation (LOG-ONLY) ═══════════
  let stage1BStructuralSafe = true;

  if (path1B && pub1AUrl && pub1BUrl) {
    try {
      nLog(`[worker] ═══════════ Running Post-1B Structural Validators ═══════════`);

      // Geometry validator (requires published URLs)
      const geo = await runStructuralCheck(pub1AUrl, pub1BUrl);

      const sem = await runSemanticStructureValidator({
        originalImagePath: path1A,
        enhancedImagePath: path1B,
        scene: (sceneLabel === "exterior" ? "exterior" : "interior") as any,
        mode: "log",
      });

      const mask = await runMaskedEdgeValidator({
        originalImagePath: path1A,
        enhancedImagePath: path1B,
        scene: (sceneLabel === "exterior" ? "exterior" : "interior") as any,
        mode: "log",
      });

      // ✅ Aggregate structural safety decision
      stage1BStructuralSafe =
        geo?.isSuspicious !== true &&
        sem?.passed === true &&
        mask?.createdOpenings === 0 &&
        mask?.closedOpenings === 0;

      nLog(
        `[worker] Post-1B Structural Safety: ${
          stage1BStructuralSafe ? "SAFE ✅" : "UNSAFE ❌"
        }`
      );

    } catch (err) {
      nLog(`[worker] Post-1B validation error (fail-open):`, err);
      stage1BStructuralSafe = false;
    }
  }

  if (await isCancelled(payload.jobId)) {
    updateJob(payload.jobId, { status: "error", errorMessage: "cancelled" });
    return;
  }

  // STAGE 2 (optional virtual staging via Gemini)
  const t2 = Date.now();
  const profileId = (payload as any)?.options?.stagingProfileId as string | undefined;
  const profile = profileId ? getStagingProfile(profileId) : undefined;
  const angleHint = (payload as any)?.options?.angleHint as any; // "primary" | "secondary" | "other"
  nLog(`[WORKER] Stage 2 ${payload.options.virtualStage ? 'ENABLED' : 'DISABLED'}; USE_GEMINI_STAGE2=${process.env.USE_GEMINI_STAGE2 || 'unset'}`);
  
  // ═══════════ STAGE 2 — HARD ENFORCEMENT ═══════════
  const isExteriorScene = sceneLabel === "exterior";
  let stage2InputPath: string;
  let stage2BaseStage: "1A"|"1B-1"|"1B-2";
  let stage2SourceVerified = false;
  
  if (payload.options.declutter && !isExteriorScene) {
    // Interior with declutter: enforce correct Stage1B pass
    if (requiresHeavyDeclutter) {
      // Heavy mode: MUST use Stage 1B-2 output
      if (!stage1BPass2Complete || !stage1BPass2Path) {
        const errMsg = "❌ STAGE 2 BLOCKED — Heavy declutter required but Stage1B-2 does not exist";
        nLog(errMsg);
        updateJob(payload.jobId, {
          status: "error",
          errorMessage: errMsg,
          error: errMsg,
          meta: { scene: { label: sceneLabel as any, confidence: 0.5 }, scenePrimary, blockReason: 'missing-stage1B-2' }
        });
        throw new Error(errMsg);
      }
      stage2InputPath = stage1BPass2Path;
      stage2BaseStage = "1B-2";
      stage2SourceVerified = true;
      nLog(`[stage2] ✅ Using input source: Stage1B-2 (heavy declutter) - verified`);
    } else {
      // Standard mode: MUST use Stage 1B-1 output
      if (!stage1BPass1Complete || !stage1BPass1Path) {
        const errMsg = "❌ STAGE 2 BLOCKED — Stage1B-1 output missing";
        nLog(errMsg);
        updateJob(payload.jobId, {
          status: "error",
          errorMessage: errMsg,
          error: errMsg,
          meta: { scene: { label: sceneLabel as any, confidence: 0.5 }, scenePrimary, blockReason: 'missing-stage1B-1' }
        });
        throw new Error(errMsg);
      }
      stage2InputPath = stage1BPass1Path;
      stage2BaseStage = "1B-1";
      stage2SourceVerified = true;
      nLog(`[stage2] ✅ Using input source: Stage1B-1 (standard declutter) - verified`);
    }
    // Backward compatibility: set path1B for legacy code
    path1B = stage2InputPath;
  } else {
    // Exterior or no declutter: use Stage 1A
    stage2InputPath = path1A;
    stage2BaseStage = "1A";
    stage2SourceVerified = true;
    nLog(`[stage2] ✅ Using input source: Stage1A (${isExteriorScene ? 'exterior' : 'interior no-declutter'}) - verified`);
  }
  
  nLog(`[WORKER] Stage 2 source: baseStage=${stage2BaseStage}, inputPath=${stage2InputPath}, verified=${stage2SourceVerified}`);
  let path2: string = stage2InputPath;
  try {
    // Only allow exterior staging if allowStaging is true
    if (sceneLabel === "exterior" && !allowStaging) {
      nLog(`[WORKER] Exterior image: No suitable outdoor area detected, skipping staging. Returning ${payload.options.declutter && path1B ? '1B' : '1A'} output.`);
      path2 = payload.options.declutter && path1B ? path1B : path1A; // Only enhancement, no staging
    } else {
      // Surface incoming stagingStyle before calling Stage 2
      const stagingStyleRaw: any = (payload as any)?.options?.stagingStyle;
      console.info("[stage2] incoming stagingStyle =", stagingStyleRaw);
      const stagingStyleNorm = stagingStyleRaw && typeof stagingStyleRaw === 'string' ? stagingStyleRaw.trim() : undefined;

      // Forensic logging: Stage 2 execution start with enforced source
      nLog(`[stage2] 🎬 Virtual staging started`, {
        jobId: payload.jobId,
        input: stage2InputPath,
        sourceStage: stage2BaseStage,
        verified: stage2SourceVerified,
        enforced: true
      });

      // Normalize stage identifier for runStage2 (expects '1A' | '1B')
      const normalizedStage = stage2BaseStage.startsWith("1B") ? "1B" as const : "1A" as const;
      
      path2 = payload.options.virtualStage
        ? await runStage2(stage2InputPath, normalizedStage, {
            roomType: (
              !payload.options.roomType ||
              ["auto", "unknown"].includes(String(payload.options.roomType).toLowerCase())
            )
              ? String(detectedRoom || "living_room")
              : payload.options.roomType,
            sceneType: sceneLabel as any,
            profile,
            angleHint,
            stagingRegion: (sceneLabel === "exterior" && allowStaging) ? (stagingRegionGlobal as any) : undefined,
            stagingStyle: stagingStyleNorm,
            onStrictRetry: ({ reasons }) => {
              try {
                const msg = reasons && reasons.length
                  ? `Validation failed: ${reasons.join('; ')}. Retrying with stricter settings...`
                  : "Validation failed. Retrying with stricter settings...";
                updateJob(payload.jobId, {
                  message: msg,
                  meta: {
                    ...(sceneLabel ? { scene: { label: sceneLabel as any, confidence: 0.5 } } : {}),
                    scenePrimary,
                    strictRetry: true,
                    strictRetryReasons: reasons || []
                  }
                });
              } catch {}
            }
          })
        : (payload.options.declutter && path1B ? path1B : path1A);
    }
  } catch (e: any) {
    const errMsg = e?.message || String(e);
    nLog(`[worker] Stage 2 failed: ${errMsg}`);
    updateJob(payload.jobId, {
      status: "error",
      errorMessage: errMsg,
      error: errMsg,
      meta: { scene: { label: sceneLabel as any, confidence: 0.5 }, scenePrimary }
    });
    return;
  }
  timings.stage2Ms = Date.now() - t2;
  
  // Forensic logging: Stage 2 completion
  if (payload.options.virtualStage && path2 !== stage2InputPath) {
    nLog(`[stage2] ✅ Virtual staging complete`, {
      jobId: payload.jobId,
      output: path2,
      inputVerifiedFrom: stage2BaseStage.startsWith("1B") ? stage2BaseStage : "Stage1A"
    });
  }
  
  updateJob(payload.jobId, { stage: payload.options.virtualStage ? "2" : (payload.options.declutter ? "1B" : "1A"), progress: payload.options.virtualStage ? 75 : (payload.options.declutter ? 55 : 45) });

  if (await isCancelled(payload.jobId)) {
    updateJob(payload.jobId, { status: "error", errorMessage: "cancelled" });
    return;
  }

  // Publish Stage 2 immediately if virtualStage was requested
  let pub2Url: string | undefined = undefined;
  if (payload.options.virtualStage && path2 !== path1B) {
    let v2: any = null;
    try {
      v2 = pushImageVersion({ imageId: payload.imageId, userId: payload.userId, stageLabel: "2", filePath: path2, note: "Virtual staging" });
    } catch (e) {
      nLog(`[worker] Note: Could not record Stage 2 version in images.json (expected in multi-service deployment)\n`);
    }
    try {
      const pub2 = await publishImage(path2);
      pub2Url = pub2.url;
      if (v2) {
        try {
          setVersionPublicUrl(payload.imageId, v2.versionId, pub2.url);
        } catch (e) {
          // Ignore
        }
      }
      updateJob(payload.jobId, { stage: "2", progress: 85, stageUrls: { "2": pub2Url }, imageUrl: pub2Url });
      // VALIDATOR FOCUS: Log Stage 2 URL
      vLog(`[VAL][job=${payload.jobId}] stage2Url=${pub2Url}`);
      nLog(`[worker] ✅ Stage 2 published: ${pub2Url}`);
    } catch (e) {
      nLog('[worker] failed to publish Stage 2', e);
    }
  }

  // ===== UNIFIED STRUCTURAL VALIDATION =====
  // Run unified validation pipeline for Stage 2
  let unifiedValidation: UnifiedValidationResult | undefined = undefined;
  if (path2 && payload.options.virtualStage) {
    try {
      const validationStartTime = Date.now();

      // Determine which stage to validate
      const validationStage: "1A" | "1B" | "2" = payload.options.virtualStage ? "2" :
                                                 (payload.options.declutter ? "1B" : "1A");

      // Get the base path (original or Stage 1A for comparison)
      const validationBasePath = path1A;

      nLog(`[worker] ═══════════ Running Unified Structural Validation ═══════════`);

      unifiedValidation = await runUnifiedValidation({
        originalPath: validationBasePath,
        enhancedPath: path2,
        stage: validationStage,
        sceneType: (sceneLabel === "exterior" ? "exterior" : "interior") as any,
        roomType: payload.options.roomType,
        mode: VALIDATION_BLOCKING_ENABLED ? "enforce" : "log",
        jobId: payload.jobId,
        stagingStyle: payload.options.stagingStyle || "nz_standard",
      });

      const validationElapsed = Date.now() - validationStartTime;
      nLog(`[worker] Unified validation completed in ${validationElapsed}ms`);
      nLog(`[worker] Validation result: ${unifiedValidation.passed ? "PASSED" : "FAILED"} (score: ${unifiedValidation.score})`);

      // VALIDATOR FOCUS: Compact unified validation output
      if (VALIDATOR_FOCUS && unifiedValidation) {
        vLog(""); // Blank line for readability
        logUnifiedValidationCompact(
          payload.jobId,
          unifiedValidation,
          validationStage,
          sceneLabel === "exterior" ? "exterior" : "interior"
        );
      }

      // Store validation results in job metadata
      updateJob(payload.jobId, {
        meta: {
          ...(sceneLabel ? { scene: { label: sceneLabel as any, confidence: 0.5 } } : {}),
          scenePrimary,
          unifiedValidation: {
            passed: unifiedValidation.passed,
            score: unifiedValidation.score,
            reasons: unifiedValidation.reasons,
          },
        },
      });

      // Handle blocking logic (currently disabled)
      if (VALIDATION_BLOCKING_ENABLED && !unifiedValidation.passed) {
        const failureMsg = `Structural validation failed: ${unifiedValidation.reasons.join("; ")}`;
        nLog(`[worker] ❌ BLOCKING IMAGE due to structural validation failure`);
        nLog(`[worker] Validation score: ${unifiedValidation.score}`);
        nLog(`[worker] Reasons: ${unifiedValidation.reasons.join("; ")}`);

        updateJob(payload.jobId, {
          status: "error",
          errorMessage: failureMsg,
          error: failureMsg,
          message: `Image failed structural validation (score: ${unifiedValidation.score})`,
          meta: {
            scene: { label: sceneLabel as any, confidence: 0.5 },
            scenePrimary,
            unifiedValidation,
            structuralValidationFailed: true,
          },
        });

        // In blocking mode, stop here and don't publish
        // For now this code path never runs (VALIDATION_BLOCKING_ENABLED = false)
        return;
      }

    } catch (validationError: any) {
      // Validation errors should never crash the job
      nLog(`[worker] Unified validation error (non-fatal):`, validationError);
      nLog(`[worker] Stack:`, validationError?.stack);
      // Continue processing - fail-open behavior
    }
  }

  // ===== SEMANTIC STRUCTURAL VALIDATION (Stage-2 ONLY) =====
  // Run semantic structure validator ONLY after Stage-2 virtual staging
  // This validator detects window/door count changes, wall drift, and opening modifications
  // MODE: LOG-ONLY (non-blocking)
  if (path2 && payload.options.virtualStage) {
    try {
      nLog(`[worker] ═══════════ Running Semantic Structure Validator (Stage-2) ═══════════`);

      await runSemanticStructureValidator({
        originalImagePath: path1A,  // Pre-staging baseline
        enhancedImagePath: path2,   // Final staged output
        scene: (sceneLabel === "exterior" ? "exterior" : "interior") as any,
        mode: "log",
      });

      nLog(`[worker] Semantic validation completed (log-only, non-blocking)`);
    } catch (semanticError: any) {
      // Semantic validation errors should never crash the job
      nLog(`[worker] Semantic validation error (non-fatal):`, semanticError);
      nLog(`[worker] Stack:`, semanticError?.stack);
      // Continue processing - fail-open behavior
    }
  }

  // ===== MASKED EDGE GEOMETRY VALIDATOR (Stage-2 ONLY) =====
  // Run masked edge validator ONLY after Stage-2 virtual staging
  // This validator focuses on architectural lines only (walls, doors, windows)
  // Ignores furniture, curtains, plants, and other non-structural elements
  // MODE: LOG-ONLY (non-blocking)
  if (path2 && payload.options.virtualStage) {
    try {
      nLog(`[worker] ═══════════ Running Masked Edge Geometry Validator (Stage-2) ═══════════`);

      await runMaskedEdgeValidator({
        originalImagePath: path1A,  // Pre-staging baseline
        enhancedImagePath: path2,   // Final staged output
        scene: (sceneLabel === "exterior" ? "exterior" : "interior") as any,
        mode: "log",
      });

      nLog(`[worker] Masked edge validation completed (log-only, non-blocking)`);
    } catch (maskedEdgeError: any) {
      // Masked edge validation errors should never crash the job
      nLog(`[worker] Masked edge validation error (non-fatal):`, maskedEdgeError);
      nLog(`[worker] Stack:`, maskedEdgeError?.stack);
      // Continue processing - fail-open behavior
    }
  }

  // COMPLIANCE VALIDATION (best-effort)
  let compliance: any = undefined;
  const tVal = Date.now();
  try {
    const ai = getGeminiClient();
    const base1A = toBase64(path1A);
    const baseFinal = toBase64(path2);
    compliance = await checkCompliance(ai as any, base1A.data, baseFinal.data);
    let retries = 0;
    let maxRetries = 2;
    let temperature = 0.5;
    let lastViolationMsg = "";
    let retryPath2 = path2;
    while (compliance && compliance.ok === false && retries < maxRetries) {
      lastViolationMsg = `Structural violations detected: ${(compliance.reasons || ["Compliance check failed"]).join("; ")}`;
      updateJob(payload.jobId, {
        status: "processing",
        errorMessage: lastViolationMsg,
        error: lastViolationMsg,
        message: `Validation failed. Retrying with stricter settings (attempt ${retries+2}/3)...`,
        meta: {
          scene: { label: sceneLabel as any, confidence: 0.5 },
          scenePrimary,
          compliance,
          strictRetry: true,
          strictRetryReasons: Array.isArray((compliance as any)?.reasons) ? (compliance as any).reasons : ["compliance retry"],
          strictRetryPhase: "compliance"
        }
      });
      nLog(`[worker] ❌ Job ${payload.jobId} failed compliance: ${lastViolationMsg} (retry ${retries+1})`);
      temperature = Math.max(0.1, temperature - 0.1);
      // Call Gemini enhancement directly with reduced temperature
      if (!path1B) {
        nLog("[worker] path1B is undefined – skipping retry for 1B.");
      } else {
        retryPath2 = await enhanceWithGemini(path1B, { ...payload.options, temperature });
        const baseFinalRetry = toBase64(retryPath2);
        compliance = await checkCompliance(ai, base1A.data, baseFinalRetry.data);
      }
      retries++;
    }
    if (compliance && compliance.ok === false) {
      lastViolationMsg = `Structural violations detected: ${(compliance.reasons || ["Compliance check failed"]).join("; ")}`;
      // Log the compliance failure, but DO NOT block publishing the image
      updateJob(payload.jobId, {
        status: "complete", // Mark as complete so UI receives the image
        errorMessage: lastViolationMsg,
        error: lastViolationMsg,
        message: "Image enhancement completed after 1 retry, but failed compliance validation.",
        meta: { scene: { label: sceneLabel as any, confidence: 0.5 }, scenePrimary, compliance, complianceFailed: true }
      });
      nLog(`[worker] Compliance failed for job ${payload.jobId} after retries: ${lastViolationMsg} (image still published)`);
      // Do NOT return; continue so image is published
    }
  } catch (e) {
    // proceed if Gemini not configured or any error
    // nLog("[worker] compliance check skipped:", (e as any)?.message || e);
  }
  timings.validateMs = Date.now() - tVal;

  // Log combined validation summary (normal mode)
  if (unifiedValidation || compliance) {
    nLog(`[worker] ═══════════ Validation Summary ═══════════`);
    if (unifiedValidation) {
      nLog(`[worker] Unified Structural: ${unifiedValidation.passed ? "✓ PASSED" : "✗ FAILED"} (score: ${unifiedValidation.score})`);
      if (!unifiedValidation.passed && unifiedValidation.reasons.length > 0) {
        nLog(`[worker] Structural issues: ${unifiedValidation.reasons.join("; ")}`);
      }
    }
    if (compliance) {
      nLog(`[worker] Gemini Compliance: ${compliance.ok ? "✓ PASSED" : "✗ FAILED"}`);
      if (!compliance.ok && compliance.reasons) {
        nLog(`[worker] Compliance issues: ${compliance.reasons.join("; ")}`);
      }
    }
    nLog(`[worker] Blocking mode: ${VALIDATION_BLOCKING_ENABLED ? "ENABLED" : "DISABLED (log-only)"}`);
    nLog(`[worker] ═══════════════════════════════════════════`);
  }

  // stage 1B publishing was deferred until here; attach URL and surface progress
  // pub1BUrl already declared above; removed duplicate
  if (payload.options.declutter) {
    if (!path1B) {
      throw new Error("Stage 1B path is undefined");
    }
    let v1B: any = null;
    try {
      v1B = pushImageVersion({ imageId: payload.imageId, userId: payload.userId, stageLabel: "1B", filePath: path1B, note: "Decluttered / depersonalized" });
    } catch (e) {
      // Silently ignore - images.json is not available in multi-service deployment
    }
    try {
      const pub1B = await publishImage(path1B);
      pub1BUrl = pub1B.url;
      if (v1B) {
        try {
          setVersionPublicUrl(payload.imageId, v1B.versionId, pub1B.url);
        } catch (e) {
          // Ignore
        }
      }
      updateJob(payload.jobId, { stage: "1B", progress: 55, stageUrls: { "1B": pub1BUrl } });
      // VALIDATOR FOCUS: Log Stage 1B URL
      vLog(`[VAL][job=${payload.jobId}] stage1BUrl=${pub1BUrl}`);
    } catch (e) {
      nLog('[worker] failed to publish 1B', e);
    }
  }

  // Decide final base path for versioning + final publish.
  // Preference order:
  //   1) Stage 2 (if virtualStage requested and validator succeeded)
  //   2) Stage 1B (decluttered) if available
  //   3) Stage 1A
  const hasStage2 = payload.options.virtualStage && !!pub2Url;
  const finalBasePath = hasStage2 ? path2 : (payload.options.declutter && path1B ? path1B! : path1A);

  let finalPathVersion: any = null;
  try {
    finalPathVersion = pushImageVersion({
      imageId: payload.imageId,
      userId: payload.userId,
      stageLabel: hasStage2 ? "2" : (payload.options.declutter ? "1B" : "1A"),
      filePath: finalBasePath,
      note: hasStage2 ? "Virtual staging" : (payload.options.declutter ? "Decluttered final" : "Final enhanced")
    });
  } catch (e) {
    // Silently ignore - images.json is not available in multi-service deployment
  }

  // Publish final for client consumption and attach to version

  let publishedFinal: any = null;
  let pubFinalUrl: string | undefined = undefined;

  // 🔍 OPENCV STRUCTURAL VALIDATOR
  // Run OpenCV-based structural validation before publishing final output
  // This must happen AFTER we know what the final output will be but BEFORE publishing
  // Note: We'll call it after publishing to get the public URL for the OpenCV service
  let structuralValidationResult: any = null;

  if (finalBasePath === path1A && pub1AUrl) {
    nLog(`\n[WORKER] ═══════════ Final image same as 1A - reusing URL ═══════════\n`);
    pubFinalUrl = pub1AUrl;
    publishedFinal = { url: pub1AUrl, kind: 's3' };
    nLog(`[WORKER] Final URL (reused from 1A): ${(pubFinalUrl||'').substring(0, 80)}...\n\n`);
  } else if (finalBasePath === path1B && pub1BUrl) {
    nLog(`\n[WORKER] ═══════════ Final image same as 1B - reusing URL ═══════════\n`);
    pubFinalUrl = pub1BUrl;
    publishedFinal = { url: pub1BUrl, kind: 's3' };
    nLog(`[WORKER] Final URL (reused from 1B): ${(pubFinalUrl||'').substring(0, 80)}...\n\n`);
  } else {
    try {
      nLog(`\n[WORKER] ═══════════ Publishing final enhanced image ═══════════\n`);
      publishedFinal = await publishImage(path2);
      pubFinalUrl = publishedFinal?.url;
      if (!pubFinalUrl) {
        throw new Error('publishImage returned no URL');
      }
      if (finalPathVersion) {
        try {
          setVersionPublicUrl(payload.imageId, finalPathVersion.versionId, pubFinalUrl);
        } catch (e) {
          // Ignore - images.json not accessible in multi-service mode
        }
      }
      nLog(`[WORKER] Final published: kind=${publishedFinal?.kind} url=${(pubFinalUrl||'').substring(0, 80)}...\n\n`);
      // VALIDATOR FOCUS: Log final URL
      vLog(`[VAL][job=${payload.jobId}] finalUrl=${pubFinalUrl}`);
    } catch (e) {
      nLog(`[WORKER] CRITICAL: Failed to publish final image: ${e}\n`);
      nLog(`[WORKER] publishedFinal: ${JSON.stringify(publishedFinal)}\n`);
    }
  }

  // VALIDATOR FOCUS: Log final URL if reused from earlier stage
  if (pubFinalUrl && !publishedFinal) {
    vLog(`[VAL][job=${payload.jobId}] finalUrl=${pubFinalUrl}`);
  }

  // 🔍 RUN OPENCV STRUCTURAL VALIDATION
  // Now that we have public URLs for both original and final, validate structure
  // This uses the Python OpenCV microservice for proper line detection
  if (pubFinalUrl && publishedOriginal?.url) {
    try {
      structuralValidationResult = await runStructuralCheck(
        publishedOriginal.url,
        pubFinalUrl
      );
      // Validation result is logged inside runStructuralCheck
      // If mode="block" and isSuspicious=true, it will throw and abort the job
    } catch (validationError: any) {
      // If validator throws (blocking mode), propagate the error
      if (validationError.message?.includes("Structural validation failed")) {
        nLog("[worker] Structural validation blocked the image");
        throw validationError;
      }
      // Otherwise just log and continue (fail open)
      nLog("[worker] Structural validation error (non-blocking):", validationError.message);
    }
  } else {
    nLog("[worker] Skipping structural validation (no public URLs available)");
  }

  // 🔹 Record final output in Redis for later region-edit lookups
  try {
    if (pubFinalUrl) {
      const baseKey = pubFinalUrl.split("?")[0].split("/").pop() || "";
      await recordEnhancedImageRedis({
        userId: payload.userId,
        imageId: payload.imageId,
        publicUrl: pubFinalUrl,
        baseKey, // recordEnhancedImageRedis will normalize & log if it tweaks this
        versionId: finalPathVersion?.versionId || "",
        stage: ((): "1A" | "1B" | "2" | "final" => {
          if (hasStage2) return "2";
          if (payload.options.declutter) return "1B";
          return "1A";
        })(),
      });
      nLog("[worker] Redis image history recorded", {
        userId: payload.userId,
        baseKey,
        imageId: payload.imageId,
      });
    } else {
      nLog("[worker] No pubFinalUrl, skipping Redis history record");
    }
  } catch (err) {
    nLog(
      "[worker] Failed to record image history in Redis:",
      (err as any)?.message || err
    );
  }

  updateJob(payload.jobId, { stage: "upload-final", progress: 90, resultUrl: pubFinalUrl });

  const meta = {
    scene: { label: sceneLabel as any, confidence: 0.5 },
    scenePrimary,
    roomTypeDetected: detectedRoom,
    roomType: payload.options.roomType || undefined,
    allowStaging,
    stagingRegion: stagingRegionGlobal,
    timings: { ...timings, totalMs: Date.now() - t0 },
    ...(compliance ? { compliance } : {}),
    // ✅ Save Stage-1B structural safety flag for smart retry routing
    ...(path1B ? { stage1BStructuralSafe } : {}),
    // ✅ Pipeline execution tracking for forensic audit
    stageExecutionProof: {
      stage1AComplete: !!path1A,
      stage1BComplete: !!(payload.options.declutter && path1B),
      stage1BPass1Complete,
      stage1BPass2Complete,
      stage2Complete: !!(payload.options.virtualStage && path2 !== stage2InputPath),
      stage2Source: payload.options.declutter 
        ? (requiresHeavyDeclutter && stage1BPass2Complete ? "1B-2" : "1B-1")
        : "1A"
    }
  };

  // ═══════════ JOB SUMMARY FOOTER (FORENSIC AUDIT) ═══════════
  nLog(`[job-summary] ✅ Pipeline execution proof`, {
    jobId: payload.jobId,
    requiresHeavyDeclutter,
    stages: {
      stage1A: !!path1A,
      stage1B_1: stage1BPass1Complete,
      stage1B_2: stage1BPass2Complete,
      stage2: !!(payload.options.virtualStage && path2 !== stage2InputPath)
    },
    stage2Source: payload.options.declutter 
      ? (requiresHeavyDeclutter && stage1BPass2Complete ? "1B-2" : "1B-1")
      : "1A",
    safeForAudit: true
  });

  updateJob(payload.jobId, {
    status: "complete",
    stageOutputs: {
      "1A": path1A,
      "1B": payload.options.declutter ? path1B : undefined,
      "2": hasStage2 ? path2 : undefined
    },
    resultVersionId: finalPathVersion?.versionId || undefined,
    meta,
    originalUrl: publishedOriginal?.url,
    resultUrl: pubFinalUrl,
    stageUrls: {
      "1A": pub1AUrl,
      "1B": pub1BUrl,
      "2": hasStage2 ? pub2Url : null
    }
  });

  // Return value for BullMQ status consumers
  const returnValue = {
    ok: true,
    imageId: payload.imageId,
    jobId: payload.jobId,
    finalPath: finalBasePath,
    originalUrl: publishedOriginal?.url || null,
    resultUrl: pubFinalUrl || null,
    stageUrls: {
      "1A": pub1AUrl || null,
      "1B": pub1BUrl || null,
      "2": hasStage2 ? (pub2Url || null) : null
    },
    meta
  };
  
  // Log the return value for debugging
  nLog('\n[WORKER] ═══════════ JOB RETURN VALUE ═══════════\n');
  nLog(`[WORKER] imageId: ${returnValue.imageId}\n`);
  nLog(`[WORKER] originalUrl: ${returnValue.originalUrl ? (String(returnValue.originalUrl).substring(0, 80) + '...') : 'NULL'}\n`);
  nLog(`[WORKER] resultUrl: ${returnValue.resultUrl ? (String(returnValue.resultUrl).substring(0, 80) + '...') : 'NULL'}\n`);
  nLog(`[WORKER] stageUrls.2: ${returnValue.stageUrls["2"] ? (String(returnValue.stageUrls["2"]).substring(0, 80) + '...') : 'NULL'}\n`);
  nLog('═══════════════════════════════════════════════\n\n');
  
  return returnValue;
}

// handle "edit" pipeline
async function handleEditJob(payload: any) {

  // 1) Download the enhanced image we’re editing
  const { jobId, baseImageUrl, maskBase64, userInstruction, userId, imageId } = payload;
  nLog("[worker-edit] Downloading base from:", baseImageUrl);
  const basePath = await downloadToTemp(baseImageUrl, `${jobId}-base`);
  nLog("[worker-edit] Base downloaded to:", basePath);

  // 2) Decode maskBase64 to Buffer
  let mask: Buffer | undefined = undefined;
  if (maskBase64) {
    if (maskBase64.startsWith("data:image/")) {
      const comma = maskBase64.indexOf(",");
      const b64 = maskBase64.slice(comma + 1);
      mask = Buffer.from(b64, "base64");
    } else {
      mask = Buffer.from(maskBase64, "base64");
    }
  }
  if (!mask) {
    nLog("[worker-edit] No mask provided, aborting edit.");
    return;
  }

  // 3) Call applyEdit – this will talk to Gemini & composite with mask
  const editPath = await applyEdit({
    baseImagePath: basePath,
    mask,
    mode: "Add", // Default to "Add"; adjust as needed if mode is in payload
    instruction: userInstruction || "",
    // restoreFromPath: undefined, // Add if needed
  });

  // 4) Publish edited image
  const pub = await publishImage(editPath);
  nLog("[worker-edit] Published edit URL:", pub.url);

  // 5) Record history in Redis
  await recordEnhancedImageRedis({
    userId,
    imageId,
    publicUrl: pub.url,
    baseKey: pub.url.split("?")[0].split("/").pop() || "",
    versionId: "",
    stage: "edit",
  });

  // 6) Update job – IMPORTANT: don’t hard-fail on compliance
  await updateJob(jobId, {
    status: "complete",
    success: true,
    imageUrl: pub.url,
    meta: {
      ...payload,
    },
  });
}


// Determine Redis URL with preference for private/internal in hosted environments
const REDIS_URL = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || "redis://localhost:6379";

// DEPLOYMENT VERIFICATION
const BUILD_VERSION = "2025-11-07_16:00_S3_VERBOSE_LOGS";
nLog('╔════════════════════════════════════════════════════════════════╗');
nLog('║                   WORKER STARTING                              ║');
nLog('╚════════════════════════════════════════════════════════════════╝');
nLog(`[WORKER] BUILD: ${BUILD_VERSION}`);
nLog(`[WORKER] Queue: ${JOB_QUEUE_NAME}`);
nLog(`[WORKER] Redis: ${REDIS_URL}`);
nLog('\n'); // Force flush

// Log S3 configuration on startup
nLog('╔════════════════════════════════════════════════════════════════╗');
nLog('║                   S3 CONFIGURATION                             ║');
nLog('╚════════════════════════════════════════════════════════════════╝');
nLog('  S3_BUCKET:', process.env.S3_BUCKET || '❌ NOT SET');
nLog('  AWS_REGION:', process.env.AWS_REGION || '❌ NOT SET');
nLog('  AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? `✅ SET (${process.env.AWS_ACCESS_KEY_ID.substring(0, 8)}...)` : '❌ NOT SET');
nLog('  AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? '✅ SET' : '❌ NOT SET');
nLog('  S3_PUBLIC_BASEURL:', process.env.S3_PUBLIC_BASEURL || 'NOT SET (will use S3 direct URLs)');
const s3Enabled = !!(process.env.S3_BUCKET && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
nLog('  📊 Status:', s3Enabled ? '✅ ENABLED - Images will upload to S3' : '❌ DISABLED - Will use data URLs');
nLog('╚════════════════════════════════════════════════════════════════╝');
nLog('\n'); // Force flush

// Log validator configuration on startup
logValidatorConfig();
nLog('\n'); // Force flush

// BullMQ worker
const worker = new Worker(
  JOB_QUEUE_NAME,
  async (job: Job) => {
    const payload = job.data as AnyJobPayload;
    updateJob((payload as any).jobId, { status: "processing" });
    try {
      if (typeof payload === "object" && payload && "type" in payload) {
        if (payload.type === "enhance") {
          return await handleEnhanceJob(payload as EnhanceJobPayload);
        } else if (payload.type === "edit") {
          return await handleEditJob(payload as EditJobPayload);
        } else if (payload.type === "region-edit") {
          const regionPayload = payload as RegionEditJobPayload;
          const regionAny = regionPayload as any;
          // ✅ ADD DETAILED DEBUG LOGGING
          nLog("[worker-region-edit] Received payload:", JSON.stringify({
            type: regionPayload.type,
            jobId: regionPayload.jobId,
            hasBaseImageUrl: !!regionAny.baseImageUrl,
            hasCurrentImageUrl: !!regionAny.currentImageUrl,
            hasImageUrl: !!regionAny.imageUrl,
            hasMask: !!regionAny.mask,
            allKeys: Object.keys(regionAny),
            baseImageUrl: regionAny.baseImageUrl,
            currentImageUrl: regionAny.currentImageUrl,
            imageUrl: regionAny.imageUrl,
            maskLength: regionAny.mask ? regionAny.mask.length : 0,
          }, null, 2));
          nLog("[worker-region-edit] Processing job:", {
            jobId: regionPayload.jobId,
            mode: regionAny.mode,
            hasBaseImageUrl: !!regionAny.baseImageUrl,
            hasMask: !!regionAny.mask,
          });

          // ✅ FIX: Get the correct URL field
          const baseImageUrl = 
            regionAny.baseImageUrl || 
            regionAny.currentImageUrl ||
            regionAny.imageUrl ||
            null;

          if (!baseImageUrl) {
            nLog("[worker-region-edit] No base image URL found in payload:", {
              jobId: regionPayload.jobId,
              payloadKeys: Object.keys(regionAny),
            });
            throw new Error("Missing base image URL for region-edit job");
          }

          nLog("[worker-region-edit] Downloading base from:", baseImageUrl);
          const basePath = await downloadToTemp(baseImageUrl, regionPayload.jobId + "-base");
          nLog("[worker-region-edit] Downloaded to:", basePath);

          // ✅ FIX: Get mask from payload (it's a base64 string)
          const maskBase64 = regionAny.mask;
          if (!maskBase64) {
            nLog("[worker-region-edit] No mask data in payload");
            throw new Error("Missing mask data for region-edit job");
          }

          // Convert mask base64 to Buffer
          const maskBuf = Buffer.from(maskBase64, "base64");
          nLog("[worker-region-edit] Mask buffer size:", maskBuf.length);

          // Get the instruction/prompt
          const prompt = regionAny.prompt || regionAny.instruction || "";

          // Normalize mode to capitalized form ("add" -> "Add", "remove" -> "Remove", etc.)
          const rawMode = regionAny.mode || "replace";
          const mode = rawMode.charAt(0).toUpperCase() + rawMode.slice(1).toLowerCase();

          nLog("[worker-region-edit] Calling applyEdit with mode:", mode);

          // Download restore source if provided (for pixel-level restoration)
          let restoreFromPath: string | undefined;
          if (mode === "Restore" && regionAny.restoreFromUrl) {
            // RESTORE PROVENANCE GUARD: Restore operations MUST only use Stage 1A output (quality-enhanced original)
            // Block if restoreFromUrl contains Stage 1B or Stage 2 markers to prevent restoring to wrong pipeline stage
            const restoreUrl = regionAny.restoreFromUrl;
            const hasStage1BMarker = restoreUrl.includes("-1B") || restoreUrl.includes("stage1B") || restoreUrl.includes("/1B/");
            const hasStage2Marker = restoreUrl.includes("-stage2") || restoreUrl.includes("stage2") || restoreUrl.includes("/stage2/");
            
            if (hasStage1BMarker || hasStage2Marker) {
              throw new Error(
                `❌ Restore/Retry blocked — invalid stage provenance. ` +
                `Restore operations can ONLY use Stage 1A output (quality-enhanced original). ` +
                `Detected Stage 1B or Stage 2 marker in restore URL: ${restoreUrl}`
              );
            }
            
            nLog("[worker-region-edit] Downloading restore source from:", restoreUrl);
            restoreFromPath = await downloadToTemp(restoreUrl, regionPayload.jobId + "-restore");
            nLog("[worker-region-edit] Restore source downloaded to:", restoreFromPath);
          }

          // Call applyEdit
          const outPath = await applyEdit({
            baseImagePath: basePath,
            mask: maskBuf,
            mode: mode as any,
            instruction: prompt,
            restoreFromPath: restoreFromPath || basePath, // Use restore source or fallback to base
          });

          nLog("[worker-region-edit] Edit complete, publishing:", outPath);

          // Publish the result
          const pub = await publishImage(outPath);

          nLog("[worker-region-edit] Published to:", pub.url);

          // Publish the mask for reference
          const maskPath = `/tmp/${regionPayload.jobId}-mask.png`;
          await sharp(maskBuf).toFile(maskPath);
          const pubMask = await publishImage(maskPath);
          nLog("[worker-region-edit] Mask published to:", pubMask.url);

          // Record in Redis for image history lookups (enables future edits on this result)
          try {
            await recordEnhancedImageRedis({
              userId: regionPayload.userId,
              imageId: regionAny.imageId || regionPayload.userId, // Use userId as fallback if imageId missing
              publicUrl: pub.url,
              baseKey: pub.url.split("?")[0].split("/").pop() || "",
              versionId: "", // Region edits don't have version IDs
              stage: "region-edit",
            });
            nLog("[worker-region-edit] Redis image history recorded");
          } catch (err) {
            nLog("[worker-region-edit] Failed to record image history in Redis:", (err as any)?.message || err);
          }

          // Update job status with all required fields (matches enhance job format for /api/status/batch)
          await updateJob(regionPayload.jobId, {
            status: "complete",
            success: true,
            resultUrl: pub.url, // Primary result URL (checked by status endpoint)
            imageUrl: pub.url, // Fallback field
            originalUrl: baseImageUrl, // Return the original input URL
            maskUrl: pubMask.url, // Return the published mask URL
            imageId: regionPayload.imageId, // Include imageId for tracking
            mode: regionAny.mode, // Include original mode from payload (add/remove/replace/restore)
            meta: {
              type: "region-edit",
              mode: mode, // Normalized mode (Add/Remove/Replace/Restore)
              instruction: prompt,
            },
          });
          nLog('[worker-region-edit] updateJob called', {
            jobId: regionPayload.jobId,
            imageUrl: pub.url,
            maskUrl: pubMask.url,
          });

          return {
            ok: true,
            resultUrl: pub.url,
            imageUrl: pub.url,
            originalUrl: baseImageUrl,
            maskUrl: pubMask.url,
          };
        } else {
          updateJob((payload as any).jobId, { status: "error", errorMessage: "unknown job type" });
        }
      } else {
        throw new Error("Job payload missing 'type' property or is not an object");
      }
    } catch (err: any) {
      nLog("[worker] job failed", err);
      updateJob((payload as any).jobId, { status: "error", errorMessage: err?.message || "unhandled worker error" });
      throw err;
    }
  },
  {
    connection: { url: REDIS_URL },
    concurrency: Number(process.env.WORKER_CONCURRENCY || 2)
  }
);

// Show readiness (optional in BullMQ v5)
(async () => {
  try {
    // @ts-ignore
    await worker.waitUntilReady?.();
    nLog("[worker] ready and listening");
  } catch (e) {
    nLog("[worker] failed to initialize", e);
  }
})();

worker.on("completed", (job, result: any) => {
  const url =
    result && (result as any).resultUrl
      ? String((result as any).resultUrl).slice(0, 120)
      : undefined;

  nLog(
    `[worker] completed job ${job.id}${url ? ` -> ${url}` : ""}`
  );
});

worker.on("failed", (job, err) => {
  nLog(`[worker] failed job ${job?.id}`, err);
});
