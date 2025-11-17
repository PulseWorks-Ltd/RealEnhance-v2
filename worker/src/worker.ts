import { Worker, Job } from "bullmq";
import { JOB_QUEUE_NAME } from "@realenhance/shared/dist/constants";
import {
  AnyJobPayload,
  EnhanceJobPayload,
  EditJobPayload
} from "@realenhance/shared/dist/types";

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
import { getGeminiClient, enhanceWithGemini } from "./ai/gemini";
import { checkCompliance } from "./ai/compliance";
import { toBase64 } from "./utils/images";
import { isCancelled } from "./utils/cancel";
import { getStagingProfile } from "./utils/groups";
import { publishImage } from "./utils/publish";
import { downloadToTemp } from "./utils/remote";

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
  console.log(`========== PROCESSING JOB ${payload.jobId} ==========`);
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
    console.log(`[WORKER] Normalized declutter '${rawDeclutter}' → ${payload.options.declutter}`);
  }
  if (typeof rawVirtualStage !== 'boolean') {
    console.log(`[WORKER] Normalized virtualStage '${rawVirtualStage}' → ${payload.options.virtualStage}`);
  }
  
  // Check if we have a remote original URL (multi-service deployment)
  const remoteUrl: string | undefined = (payload as any).remoteOriginalUrl;
  let origPath: string;
  
  if (remoteUrl) {
    // Multi-service mode: Download original from S3
    try {
      process.stdout.write(`[WORKER] Remote original detected, downloading: ${remoteUrl}\n`);
      origPath = await downloadToTemp(remoteUrl, payload.jobId);
      process.stdout.write(`[WORKER] Remote original downloaded to: ${origPath}\n`);
    } catch (e) {
      process.stderr.write(`[WORKER] ERROR: Failed to download remote original: ${(e as any)?.message || e}\n`);
      updateJob(payload.jobId, { status: "error", errorMessage: `Failed to download original: ${(e as any)?.message || 'unknown error'}` });
      return;
    }
  } else {
    // Legacy single-service mode: Read from local filesystem
    process.stderr.write("[WORKER] WARN: Job lacks remoteOriginalUrl. Attempting to read from local filesystem.\n");
    process.stderr.write("[WORKER] In production multi-service deployment, server should upload originals to S3 and provide remoteOriginalUrl.\n");
    
    const rec = readImageRecord(payload.imageId);
    if (!rec) {
      process.stderr.write(`[WORKER] ERROR: Image record not found for ${payload.imageId} and no remoteOriginalUrl provided.\n`);
      updateJob(payload.jobId, { status: "error", errorMessage: "image not found - no remote URL and local record missing" });
      return;
    }
    origPath = getOriginalPath(rec);
    if (!fs.existsSync(origPath)) {
      process.stderr.write(`[WORKER] ERROR: Local original file not found at ${origPath}\n`);
      updateJob(payload.jobId, { status: "error", errorMessage: "original file not accessible in this container" });
      return;
    }
  }

  const timings: Record<string, number> = {};
  const t0 = Date.now();

  // Publish original so client can render before/after across services
  process.stdout.write(`\n[WORKER] ═══════════ Publishing original image ═══════════\n`);
  const publishedOriginal = await publishImage(origPath);
  process.stdout.write(`[WORKER] Original published: kind=${publishedOriginal?.kind} url=${(publishedOriginal?.url||'').substring(0, 80)}...\n\n`);
  // surface early so UI can show before/after immediately
  updateJob(payload.jobId, { stage: "upload-original", progress: 10, originalUrl: publishedOriginal?.url });

  // Auto detection: primary scene (interior/exterior) + room type
  let detectedRoom: string | undefined;
  let sceneLabel = (payload.options.sceneType as any) || "auto";
  let scenePrimary: any = undefined;
  let allowStaging = true;
  let stagingRegionGlobal: any = null;
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
        const { getGeminiClient } = await import("./ai/gemini");
        const { detectStagingArea } = await import("./ai/staging-area-detector");
        const { detectStagingRegion } = await import("./ai/region-detector");
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
          console.log(`[WORKER] Exterior gating: areaType='${areaType}' not in allowedTypes=[${allowedTypes.join(', ')}] → disallow staging`);
        }
        // Confidence gate
        const level = String(stagingResult.confidence || 'low').toLowerCase();
        if (confRank(level) < minRank) {
          allowStaging = false;
          console.log(`[WORKER] Exterior gating: confidence='${level}' < minLevel='${minConfLevel}' → disallow staging`);
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
                console.log(`[WORKER] Exterior staging region below threshold: ${(coverage*100).toFixed(1)}% < ${(minCoverage*100).toFixed(0)}% → disallow staging`);
              } else {
                console.log(`[WORKER] Exterior staging region coverage: ${(coverage*100).toFixed(1)}% (>= ${(minCoverage*100).toFixed(0)}%)`);
              }
              if (requireRegion && !stagingRegion) {
                allowStaging = false;
                console.log(`[WORKER] Exterior gating: requireRegion=1 but no region detected → disallow staging`);
              }
              // If region has areaType metadata, ensure it matches allowed types
              const regionType = String((stagingRegion as any)?.areaType || areaType).toLowerCase();
              if (!allowedTypes.includes(regionType)) {
                allowStaging = false;
                console.log(`[WORKER] Exterior gating: region.areaType='${regionType}' not allowed → disallow staging`);
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
                  console.log(`[WORKER] Exterior region green check: green=${(greenRatio*100).toFixed(1)}% max=${(maxGreen*100).toFixed(0)}% → ${decision ? 'allow' : 'disallow'}`);
                  if (!decision) {
                    allowStaging = false;
                  }
                } catch (e) {
                  console.warn('[WORKER] Green-region check failed; proceeding without this gate', e);
                }
              }
              // attach coverage for meta/debugging
              (stagingRegion as any).coverage = coverage;
            }
          } catch (e) {
            console.warn('[WORKER] Failed to compute staging coverage; proceeding without area gate', e);
          }
        }
        console.log(`[WORKER] Outdoor staging area: has=${stagingResult.hasStagingArea}, type=${stagingResult.areaType}, conf=${stagingResult.confidence}`);
        console.log(`[WORKER] Exterior staging decision: allowStaging=${allowStaging} (minConf=${minConfLevel}, minCoverage=${Number(process.env.EXTERIOR_STAGING_MIN_COVERAGE || 0.2)})`);
        if (stagingRegion) {
          console.log(`[WORKER] Staging region:`, stagingRegion);
        }
        stagingRegionGlobal = stagingRegion;
      } catch (e) {
        allowStaging = false;
        stagingRegion = null;
        stagingRegionGlobal = null;
        console.warn(`[WORKER] Outdoor staging area/region detection failed, defaulting to no staging:`, e);
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
      console.log(`[WORKER] Scene resolved: primary=${primary?.label}(${(primary?.confidence??0).toFixed(2)}) → resolved=${sceneLabel}, room=${room.label}`);
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
      console.log(`[WORKER] Structural mask computed: ${mask.width}x${mask.height}`);
    } catch (e) {
      console.warn('[WORKER] Failed to compute structural mask:', e);
    }
  } catch (e) {
    console.warn('[WORKER] Canonical preprocess failed; falling back to original for stages', e);
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
  } catch {}
  let path1A: string = origPath;
  // Stage 1A: Always run Gemini for quality enhancement (HDR, color, sharpness)
  path1A = await runStage1A(canonicalPath, {
    replaceSky: payload.options.replaceSky ?? (sceneLabel === "exterior"),
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
  } catch (e) {
    console.warn('[worker] failed to publish 1A', e);
  }
  updateJob(payload.jobId, { stage: "1A", progress: 35, stageUrls: { "1A": pub1AUrl } });
  if (await isCancelled(payload.jobId)) {
    updateJob(payload.jobId, { status: "error", errorMessage: "cancelled" });
    return;
  }

  // STAGE 1B (optional declutter)
  const t1B = Date.now();
  let path1B: string | undefined = undefined;
  console.log(`[WORKER] Checking Stage 1B: payload.options.declutter=${payload.options.declutter}`);
  if (payload.options.declutter) {
    console.log(`[WORKER] ✅ Stage 1B ENABLED - will remove furniture from enhanced 1A output`);
    try {
      // Stage 1B: Always run as a separate Gemini call, only for furniture/clutter removal
      path1B = await runStage1B(path1A, {
        replaceSky: false, // Never combine with sky replacement
        sceneType: sceneLabel,
      });
    } catch (e: any) {
      const errMsg = e?.message || String(e);
      console.error(`[worker] Stage 1B failed: ${errMsg}`);
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
      console.warn('[worker] failed to publish 1B', e);
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
  console.log(`[WORKER] Stage 2 ${payload.options.virtualStage ? 'ENABLED' : 'DISABLED'}; USE_GEMINI_STAGE2=${process.env.USE_GEMINI_STAGE2 || 'unset'}`);
  // Stage 2 input selection:
  // - Interior: use Stage 1B (decluttered) if declutter enabled; else Stage 1A
  // - Exterior: always use Stage 1A
  const isExteriorScene = sceneLabel === "exterior";
  const stage2InputPath = isExteriorScene ? path1A : (payload.options.declutter && path1B ? path1B : path1A);
  const stage2BaseStage: "1A"|"1B" = isExteriorScene ? "1A" : (payload.options.declutter && path1B ? "1B" : "1A");
  console.log(`[WORKER] Stage 2 source: baseStage=${stage2BaseStage}, inputPath=${stage2InputPath}`);
  let path2: string = stage2InputPath;
  try {
    // Only allow exterior staging if allowStaging is true
    if (sceneLabel === "exterior" && !allowStaging) {
      console.log(`[WORKER] Exterior image: No suitable outdoor area detected, skipping staging. Returning ${payload.options.declutter && path1B ? '1B' : '1A'} output.`);
      path2 = payload.options.declutter && path1B ? path1B : path1A; // Only enhancement, no staging
    } else {
      path2 = payload.options.virtualStage
        ? await runStage2(stage2InputPath, stage2BaseStage, {
            roomType: payload.options.roomType || String(detectedRoom || "living_room"),
            sceneType: sceneLabel as any,
            profile,
            angleHint,
            stagingRegion: (sceneLabel === "exterior" && allowStaging) ? (stagingRegionGlobal as any) : undefined,
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
    console.error(`[worker] Stage 2 failed: ${errMsg}`);
    updateJob(payload.jobId, {
      status: "error",
      errorMessage: errMsg,
      error: errMsg,
      meta: { scene: { label: sceneLabel as any, confidence: 0.5 }, scenePrimary }
    });
    return;
  }
  timings.stage2Ms = Date.now() - t2;
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
      process.stderr.write(`[worker] Note: Could not record Stage 2 version in images.json (expected in multi-service deployment)\n`);
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
      console.log(`[worker] ✅ Stage 2 published: ${pub2Url}`);
    } catch (e) {
      console.warn('[worker] failed to publish Stage 2', e);
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
      console.warn(`[worker] ❌ Job ${payload.jobId} failed compliance: ${lastViolationMsg} (retry ${retries+1})`);
      temperature = Math.max(0.1, temperature - 0.1);
      // Call Gemini enhancement directly with reduced temperature
      retryPath2 = await enhanceWithGemini(path1B, { ...payload.options, temperature });
      const baseFinalRetry = toBase64(retryPath2);
      compliance = await checkCompliance(ai as any, base1A.data, baseFinalRetry.data);
      retries++;
    }
    if (compliance && compliance.ok === false) {
      lastViolationMsg = `Structural violations detected: ${(compliance.reasons || ["Compliance check failed"]).join("; ")}`;
      updateJob(payload.jobId, {
        status: "error",
        errorMessage: lastViolationMsg,
        error: lastViolationMsg,
        message: "Image enhancement failed after 3 attempts due to structural violations.",
        meta: { scene: { label: sceneLabel as any, confidence: 0.5 }, scenePrimary, compliance }
      });
      console.error(`[worker] ❌ Job ${payload.jobId} failed compliance after retries: ${lastViolationMsg}`);
      return;
    }
  } catch (e) {
    // proceed if Gemini not configured or any error
    // console.warn("[worker] compliance check skipped:", (e as any)?.message || e);
  }
  timings.validateMs = Date.now() - tVal;

  // stage 1B publishing was deferred until here; attach URL and surface progress
  // pub1BUrl already declared above; removed duplicate
  if (payload.options.declutter) {
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
    } catch (e) {
      console.warn('[worker] failed to publish 1B', e);
    }
  }

  let finalPathVersion: any = null;
  try {
    finalPathVersion = pushImageVersion({
      imageId: payload.imageId,
      userId: payload.userId,
      stageLabel: payload.options.virtualStage ? "2" : "1B/1A",
      filePath: path2,
      note: payload.options.virtualStage ? "Virtual staging" : "Final enhanced"
    });
  } catch (e) {
    // Silently ignore - images.json is not available in multi-service deployment
  }

  // Publish final for client consumption and attach to version
  let publishedFinal: any = null;
  let pubFinalUrl: string | undefined = undefined;
  
  // Optimization: If final path is same as 1A (no declutter, no staging), reuse 1A URL
  if (path2 === path1A && pub1AUrl) {
    process.stdout.write(`\n[WORKER] ═══════════ Final image same as 1A - reusing URL ═══════════\n`);
    pubFinalUrl = pub1AUrl;
    publishedFinal = { url: pub1AUrl, kind: 's3' };
    process.stdout.write(`[WORKER] Final URL (reused from 1A): ${(pubFinalUrl||'').substring(0, 80)}...\n\n`);
  } else {
    // Final is different (declutter or staging applied), publish it
    try {
      process.stdout.write(`\n[WORKER] ═══════════ Publishing final enhanced image ═══════════\n`);
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
      process.stdout.write(`[WORKER] Final published: kind=${publishedFinal?.kind} url=${(pubFinalUrl||'').substring(0, 80)}...\n\n`);
    } catch (e) {
      process.stderr.write(`[WORKER] CRITICAL: Failed to publish final image: ${e}\n`);
      process.stderr.write(`[WORKER] publishedFinal: ${JSON.stringify(publishedFinal)}\n`);
    }
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
    ...(compliance ? { compliance } : {})
  };

  updateJob(payload.jobId, {
    status: "complete",
    stageOutputs: {
      "1A": path1A,
      "1B": payload.options.declutter ? path1B : undefined,
      "2": payload.options.virtualStage ? path2 : undefined
    },
    resultVersionId: finalPathVersion?.versionId || undefined,
    meta,
    originalUrl: publishedOriginal?.url,
    resultUrl: pubFinalUrl,
    stageUrls: {
      "1A": pub1AUrl,
      "1B": pub1BUrl,
      "2": pub2Url  // Use separately published Stage2 URL
    }
  });

  // Return value for BullMQ status consumers
  const returnValue = {
    ok: true,
    imageId: payload.imageId,
    jobId: payload.jobId,
    finalPath: path2,
    originalUrl: publishedOriginal?.url || null,
    resultUrl: pubFinalUrl || null,
    stageUrls: {
      "1A": pub1AUrl || null,
      "1B": pub1BUrl || null,
      "2": pub2Url || null  // Use separately published Stage2 URL
    },
    meta
  };
  
  // Log the return value for debugging
  process.stdout.write('\n[WORKER] ═══════════ JOB RETURN VALUE ═══════════\n');
  process.stdout.write(`[WORKER] imageId: ${returnValue.imageId}\n`);
  process.stdout.write(`[WORKER] originalUrl: ${returnValue.originalUrl ? (String(returnValue.originalUrl).substring(0, 80) + '...') : 'NULL'}\n`);
  process.stdout.write(`[WORKER] resultUrl: ${returnValue.resultUrl ? (String(returnValue.resultUrl).substring(0, 80) + '...') : 'NULL'}\n`);
  process.stdout.write(`[WORKER] stageUrls.2: ${returnValue.stageUrls["2"] ? (String(returnValue.stageUrls["2"]).substring(0, 80) + '...') : 'NULL'}\n`);
  process.stdout.write('═══════════════════════════════════════════════\n\n');
  
  return returnValue;
}

// handle "edit" pipeline
async function handleEditJob(payload: EditJobPayload) {
  // Check if we have remote URLs (multi-service deployment)
  const remoteBaseUrl: string | undefined = (payload as any).remoteBaseUrl;
  const remoteRestoreUrl: string | undefined = (payload as any).remoteRestoreUrl;
  let basePath: string;
  
  if (remoteBaseUrl) {
    // Multi-service mode: Download base from S3
    try {
      console.log(`[worker-edit] Downloading base from: ${remoteBaseUrl}`);
      basePath = await downloadToTemp(remoteBaseUrl, payload.jobId + '-base');
      console.log(`[worker-edit] Base downloaded to: ${basePath}`);
    } catch (e) {
      console.error(`[worker-edit] Failed to download remote base: ${(e as any)?.message || e}`);
      updateJob(payload.jobId, { status: "error", errorMessage: `Failed to download base: ${(e as any)?.message || 'unknown'}` });
      return;
    }
  } else {
    // Legacy single-service mode: Read from local filesystem
    const rec = readImageRecord(payload.imageId);
    if (!rec) {
      updateJob(payload.jobId, { status: "error", errorMessage: "image not found" });
      return;
    }
    const localPath = getVersionPath(rec, payload.baseVersionId);
    if (!localPath || !fs.existsSync(localPath)) {
      updateJob(payload.jobId, { status: "error", errorMessage: "base version not found" });
      return;
    }
    basePath = localPath;
  }

  let restoreFromPath: string | undefined;
  if (payload.mode === "Restore") {
    if (remoteRestoreUrl) {
      // Download restore source from S3
      try {
        console.log(`[worker-edit] Downloading restore source from: ${remoteRestoreUrl}`);
        restoreFromPath = await downloadToTemp(remoteRestoreUrl, payload.jobId + '-restore');
        console.log(`[worker-edit] Restore source downloaded to: ${restoreFromPath}`);
      } catch (e) {
        console.warn(`[worker-edit] Failed to download restore source, using base: ${(e as any)?.message}`);
        restoreFromPath = basePath;
      }
    } else {
      // Legacy: try to find enhancement stage in local record
      const rec = readImageRecord(payload.imageId);
      if (rec) {
        const stage1B = rec.history.find(v => v.stageLabel === "1B");
        const stage1A = rec.history.find(v => v.stageLabel === "1A");
        const restoreVersion = stage1B || stage1A;
        if (restoreVersion?.filePath && fs.existsSync(restoreVersion.filePath)) {
          restoreFromPath = restoreVersion.filePath;
          console.log(`[worker-edit] Restore mode: using ${stage1B ? 'Stage 1B' : 'Stage 1A'} as restore source: ${restoreFromPath}`);
        } else {
          console.warn(`[worker-edit] Enhancement stage not found locally, using base`);
          restoreFromPath = basePath;
        }
      } else {
        restoreFromPath = basePath;
      }
    }
  }

  const editedPath = await applyEdit({
    baseImagePath: basePath,
    mask: payload.mask,
    mode: payload.mode,
    instruction: payload.instruction,
    restoreFromPath
  });

  const newVersion = pushImageVersion({
    imageId: payload.imageId,
    userId: payload.userId,
    stageLabel: "edit",
    filePath: editedPath,
    note: `${payload.mode}: ${payload.instruction}`
  });
  // Publish edited image and attach public URL for client consumption
  try {
    const pub = await publishImage(editedPath);
    try {
      setVersionPublicUrl(payload.imageId, newVersion.versionId, pub.url);
    } catch {}
    updateJob(payload.jobId, { status: "complete", resultVersionId: newVersion.versionId, resultUrl: pub.url });
  } catch (e) {
    updateJob(payload.jobId, { status: "complete", resultVersionId: newVersion.versionId });
  }
}

// Determine Redis URL with preference for private/internal in hosted environments
const REDIS_URL = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || "redis://localhost:6379";

// DEPLOYMENT VERIFICATION
const BUILD_VERSION = "2025-11-07_16:00_S3_VERBOSE_LOGS";
console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║                   WORKER STARTING                              ║');
console.log('╚════════════════════════════════════════════════════════════════╝');
console.log(`[WORKER] BUILD: ${BUILD_VERSION}`);
console.log(`[WORKER] Queue: ${JOB_QUEUE_NAME}`);
console.log(`[WORKER] Redis: ${REDIS_URL}`);
process.stdout.write('\n'); // Force flush

// Log S3 configuration on startup
console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║                   S3 CONFIGURATION                             ║');
console.log('╚════════════════════════════════════════════════════════════════╝');
console.log('  S3_BUCKET:', process.env.S3_BUCKET || '❌ NOT SET');
console.log('  AWS_REGION:', process.env.AWS_REGION || '❌ NOT SET');
console.log('  AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? `✅ SET (${process.env.AWS_ACCESS_KEY_ID.substring(0, 8)}...)` : '❌ NOT SET');
console.log('  AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? '✅ SET' : '❌ NOT SET');
console.log('  S3_PUBLIC_BASEURL:', process.env.S3_PUBLIC_BASEURL || 'NOT SET (will use S3 direct URLs)');
const s3Enabled = !!(process.env.S3_BUCKET && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
console.log('  📊 Status:', s3Enabled ? '✅ ENABLED - Images will upload to S3' : '❌ DISABLED - Will use data URLs');
console.log('╚════════════════════════════════════════════════════════════════╝');
process.stdout.write('\n'); // Force flush

// BullMQ worker
const worker = new Worker(
  JOB_QUEUE_NAME,
  async (job: Job) => {
    const payload = job.data as AnyJobPayload;

    updateJob((payload as any).jobId, { status: "processing" });

    try {
      if (payload.type === "enhance") {
        return await handleEnhanceJob(payload as any);
      } else if (payload.type === "edit") {
        return await handleEditJob(payload as any);
      } else {
        updateJob((payload as any).jobId, { status: "error", errorMessage: "unknown job type" });
      }
    } catch (err: any) {
      console.error("[worker] job failed", err);
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
    console.log("[worker] ready and listening");
  } catch (e) {
    console.error("[worker] failed to initialize", e);
  }
})();

worker.on("completed", (job, result: any) => {
  const url = (result && (result as any).resultUrl) ? String((result as any).resultUrl).slice(0, 120) : undefined;
  console.log(`[worker] completed job ${job.id}${url ? ` → ${url}` : ""}`);
  
  // CRITICAL DEBUG: Verify result was captured
  if (result) {
    console.log(`[worker] ✅ Result captured by BullMQ:`, {
      hasResultUrl: !!result.resultUrl,
      hasOriginalUrl: !!result.originalUrl,
      hasStageUrls: !!result.stageUrls,
      keys: Object.keys(result)
    });
  } else {
    console.error(`[worker] ❌ NO RESULT captured for job ${job.id} - BullMQ returnvalue will be empty!`);
  }
});

worker.on("failed", (job, err) => {
  console.error(`[worker] failed job ${job?.id}`, err);
});
