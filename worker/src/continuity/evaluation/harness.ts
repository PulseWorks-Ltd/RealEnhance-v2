import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { bootstrapGoogleCredentialsFromEnv } from "../../bootstrap/googleCredentials";
import { buildDeterministicPlanConstraintMask, compileDeterministicMask } from "../maskCompiler";
import { validateCompiledMask } from "../maskValidation";
import type { CompiledMaskResult, PlacementPlan } from "../types";
import { VertexSecondaryContinuityError } from "../types";
import { nLog } from "../../logger";
import { VertexSpatialPlannerProvider } from "../../providers/vertex/spatialPlannerProvider";
import { VertexImageRendererProvider, buildImagenInsertionPrompt } from "../../providers/vertex/imageRendererProvider";
import type { ImageReference } from "../../providers/types";

export type EvaluationMode =
  | "full"
  | "live"
  | "replay_planner"
  | "replay_occupancy"
  | "occupancy_only"
  | "replay_continuity"
  | "continuity_only"
  | "validator_only";

export type RoomGroupManifest = {
  roomKey: string;
  roomLabel: string;
  roomType: string;
  masterImage: string;
  secondaryImages: string[];
};

export type DatasetManifest = {
  generatedAt: string;
  datasetDir: string;
  totalRooms: number;
  totalSecondaryViews: number;
  groups: RoomGroupManifest[];
};

type EvaluationCase = {
  roomKey: string;
  roomLabel: string;
  roomType: string;
  masterImage: string;
  secondaryImage: string;
  secondaryView: number;
};

type RuntimeMemorySnapshot = {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
};

type RuntimePhase =
  | "idle"
  | "planner"
  | "occupancy"
  | "continuity"
  | "validator"
  | "checkpoint"
  | "finalizing";

type RuntimeCaseState = {
  roomKey: string | null;
  roomLabel: string | null;
  roomType: string | null;
  secondaryView: number | null;
  secondaryImage: string | null;
  status: CaseStatus | null;
  failureCategory: string | null;
  failureReason: string | null;
};

type EvaluationRuntimeState = {
  runDir: string;
  datasetDir: string;
  mode: EvaluationMode;
  sourceRunDir: string | null;
  useGeminiOccupancy: boolean;
  startTimeMs: number;
  currentPhase: RuntimePhase;
  currentProviderCall: string | null;
  currentCase: RuntimeCaseState;
  completedCases: number;
  failedCases: number;
  skippedCases: number;
  totalCases: number;
  checkpointPath: string;
  heartbeatPath: string;
  crashReportPath: string;
  pidFilePath: string;
  shutdownRequested: boolean;
  lastCheckpoint?: unknown;
};

type PlannerExecution = {
  plan: PlacementPlan;
  prompt: string;
  rawText: string;
  model: string;
  latencyMs: number;
  mode: "live" | "replay";
  sourcePath: string | null;
};

type ContinuityDriftSummary = {
  width: number;
  height: number;
  meanAbsoluteErrorAll: number;
  meanAbsoluteErrorOutsideMask: number;
  changedPixelsOutsideMask: number;
  changedRatioOutsideMask: number;
  changedPixelsInsideMask: number;
  changedRatioInsideMask: number;
  outsideMaskThreshold: number;
  driftPass: boolean;
};

type CaseStatus = "success" | "failure" | "skipped";

export type CaseResult = {
  roomKey: string;
  roomLabel: string;
  roomType: string;
  secondaryView: number;
  secondaryImage: string;
  status: CaseStatus;
  mode: EvaluationMode;
  plannerMode: "live" | "replay";
  plannerPath: string | null;
  occupancyGenerationMode: CompiledMaskResult["occupancyGenerationMode"] | null;
  outputDir: string;
  failureCategory: string | null;
  failureReason: string | null;
  telemetry: {
    plannerLatencyMs: number | null;
    occupancyLatencyMs: number | null;
    renderLatencyMs: number | null;
    occupancyAreaRatio: number | null;
    finalAreaRatio: number | null;
    requiredClusterOccupancy: number | null;
    optionalClusterOccupancy: number | null;
    unionOccupancy: number | null;
    retryCount: number | null;
    clusterApiCallCount: number | null;
    rateLimit429Count: number;
    validatorDriftPass: boolean | null;
  };
};

export type EvaluationSummary = {
  generatedAt: string;
  runDir: string;
  datasetDir: string;
  mode: EvaluationMode;
  sourceRunDir: string | null;
  totalRooms: number;
  totalSecondaryViews: number;
  completedCases: number;
  successCount: number;
  failureCount: number;
  skippedCount: number;
  successRate: number;
  plannerFailureRate: number;
  occupancyFailureRate: number;
  continuityPassRate: number;
  averageOccupancyAreaRatio: number;
  averageUnionOccupancyRatio: number;
  averageRequiredClusterOccupancy: number;
  averageOptionalClusterOccupancy: number;
  averageRetryCount: number;
  total429Count: number;
  failureCategories: Record<string, number>;
  roomTypeBreakdown: Record<string, {
    total: number;
    success: number;
    failures: number;
    successRate: number;
    averageOccupancyAreaRatio: number;
  }>;
  occupancyDistribution: {
    required: number[];
    optional: number[];
    union: number[];
    variance: number;
  };
  cases: CaseResult[];
};

export type RunContinuityEvaluationOptions = {
  datasetDir: string;
  outputRootDir: string;
  mode: EvaluationMode;
  sourceRunDir?: string;
  useGeminiOccupancy: boolean;
  maxCases?: number;
  resume?: boolean;
  runDir?: string;
  daemon?: boolean;
  pidFilePath?: string;
  heartbeatIntervalMs?: number;
};

type ResumeCheckpoint = {
  generatedAt?: string;
  runDir?: string;
  completedCases?: number;
  failedCases?: number;
  skippedCases?: number;
  totalCases?: number;
  cases?: Array<{
    roomKey: string;
    secondaryView: number;
    status: CaseStatus;
    roomLabel?: string;
    roomType?: string;
    secondaryImage?: string;
    mode?: EvaluationMode;
    plannerMode?: "live" | "replay";
    plannerPath?: string | null;
    occupancyGenerationMode?: CompiledMaskResult["occupancyGenerationMode"] | null;
    failureCategory?: string | null;
    failureReason?: string | null;
    outputDir?: string;
    telemetry?: CaseResult["telemetry"];
  }>;
};

function normalizeMode(mode: EvaluationMode): EvaluationMode {
  if (mode === "live") {
    return "full";
  }
  if (mode === "replay_occupancy") {
    return "occupancy_only";
  }
  if (mode === "replay_continuity") {
    return "continuity_only";
  }
  return mode;
}

function normalizeRoomKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "room";
}

function inferRoomType(roomLabel: string): string {
  const normalized = roomLabel.trim().toLowerCase();
  if (normalized.startsWith("bedroom")) return "bedroom";
  if (normalized.startsWith("kitchen")) return "kitchen";
  if (normalized.startsWith("lounge") || normalized.startsWith("living")) return "living_room";
  return normalized.split(/\s+/)[0] || "unknown";
}

function slugForRoomCase(roomKey: string, secondaryView: number): string {
  return `${roomKey}/secondary_${secondaryView}`;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: number[]): number {
  if (values.length === 0) return 0;
  const avg = mean(values);
  return mean(values.map((value) => (value - avg) ** 2));
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

function captureMemorySnapshot(): RuntimeMemorySnapshot {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

function formatMemoryMb(snapshot: RuntimeMemorySnapshot): Record<string, number> {
  return {
    rssMb: Number((snapshot.rss / 1024 / 1024).toFixed(1)),
    heapTotalMb: Number((snapshot.heapTotal / 1024 / 1024).toFixed(1)),
    heapUsedMb: Number((snapshot.heapUsed / 1024 / 1024).toFixed(1)),
    externalMb: Number((snapshot.external / 1024 / 1024).toFixed(1)),
    arrayBuffersMb: Number((snapshot.arrayBuffers / 1024 / 1024).toFixed(1)),
  };
}

async function bestEffortWriteJson(filePath: string, value: unknown): Promise<void> {
  try {
    await writeJson(filePath, value);
  } catch {
    // best-effort diagnostics only
  }
}

function createRuntimeState(params: {
  runDir: string;
  datasetDir: string;
  mode: EvaluationMode;
  sourceRunDir?: string;
  useGeminiOccupancy: boolean;
  totalCases: number;
  pidFilePath?: string;
}): EvaluationRuntimeState {
  const pidFilePath = params.pidFilePath || path.join(params.runDir, "continuity-eval.pid");
  return {
    runDir: params.runDir,
    datasetDir: params.datasetDir,
    mode: params.mode,
    sourceRunDir: params.sourceRunDir || null,
    useGeminiOccupancy: params.useGeminiOccupancy,
    startTimeMs: Date.now(),
    currentPhase: "idle",
    currentProviderCall: null,
    currentCase: {
      roomKey: null,
      roomLabel: null,
      roomType: null,
      secondaryView: null,
      secondaryImage: null,
      status: null,
      failureCategory: null,
      failureReason: null,
    },
    completedCases: 0,
    failedCases: 0,
    skippedCases: 0,
    totalCases: params.totalCases,
    checkpointPath: path.join(params.runDir, "progress-checkpoint.json"),
    heartbeatPath: path.join(params.runDir, "heartbeat.json"),
    crashReportPath: path.join(params.runDir, "crash-report.json"),
    pidFilePath,
    shutdownRequested: false,
  };
}

function runtimeSnapshot(state: EvaluationRuntimeState): Record<string, unknown> {
  const memory = captureMemorySnapshot();
  return {
    timestamp: new Date().toISOString(),
    uptimeMs: Date.now() - state.startTimeMs,
    ...formatMemoryMb(memory),
    currentPhase: state.currentPhase,
    currentProviderCall: state.currentProviderCall,
    currentCase: state.currentCase,
    completedCases: state.completedCases,
    failedCases: state.failedCases,
    skippedCases: state.skippedCases,
    totalCases: state.totalCases,
    datasetDir: state.datasetDir,
    mode: state.mode,
    sourceRunDir: state.sourceRunDir,
    useGeminiOccupancy: state.useGeminiOccupancy,
  };
}

async function writeCheckpoint(state: EvaluationRuntimeState, cases: CaseResult[]): Promise<void> {
  const payload = {
    generatedAt: new Date().toISOString(),
    runDir: state.runDir,
    datasetDir: state.datasetDir,
    mode: state.mode,
    sourceRunDir: state.sourceRunDir,
    useGeminiOccupancy: state.useGeminiOccupancy,
    completedCases: state.completedCases,
    failedCases: state.failedCases,
    skippedCases: state.skippedCases,
    totalCases: state.totalCases,
    currentPhase: state.currentPhase,
    currentProviderCall: state.currentProviderCall,
    currentCase: state.currentCase,
    cases: cases.map((item) => ({
      roomKey: item.roomKey,
      roomType: item.roomType,
      secondaryView: item.secondaryView,
      status: item.status,
      failureCategory: item.failureCategory,
      failureReason: item.failureReason,
      plannerMode: item.plannerMode,
      occupancyGenerationMode: item.occupancyGenerationMode,
      outputDir: item.outputDir,
      telemetry: item.telemetry,
    })),
  };
  state.lastCheckpoint = payload;
  await bestEffortWriteJson(state.checkpointPath, payload);
}

async function writeHeartbeat(state: EvaluationRuntimeState, cases: CaseResult[]): Promise<void> {
  const payload = {
    ...runtimeSnapshot(state),
    casesCompleted: cases.length,
    currentCaseStatus: state.currentCase.status,
  };
  await bestEffortWriteJson(state.heartbeatPath, payload);
}

async function writeCrashReport(state: EvaluationRuntimeState, error: unknown, signal?: NodeJS.Signals | string): Promise<void> {
  const payload = {
    ...runtimeSnapshot(state),
    signal: signal || null,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack || null : null,
    checkpointPath: state.checkpointPath,
  };
  await bestEffortWriteJson(state.crashReportPath, payload);
  await bestEffortWriteJson(state.checkpointPath, state.lastCheckpoint || payload);
}

function attachRuntimeHandlers(state: EvaluationRuntimeState, cases: CaseResult[]): () => void {
  let shuttingDown = false;

  const terminate = (signal: NodeJS.Signals | string, error?: unknown, exitCode = 128) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    state.shutdownRequested = true;
    void (async () => {
      await writeCrashReport(state, error || new Error(`Evaluation terminated by ${signal}`), signal);
      await writeHeartbeat(state, cases);
      process.exit(exitCode);
    })();
  };

  const onSigint = () => { terminate("SIGINT", undefined, 130); };
  const onSigterm = () => { terminate("SIGTERM", undefined, 143); };
  const onUncaughtException = (error: Error) => { terminate("uncaughtException", error, 1); };
  const onUnhandledRejection = (reason: unknown) => { terminate("unhandledRejection", reason, 1); };

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);

  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("uncaughtException", onUncaughtException);
    process.off("unhandledRejection", onUnhandledRejection);
  };
}

async function loadResumeCheckpoint(runDir: string): Promise<ResumeCheckpoint | null> {
  const checkpointPath = path.join(runDir, "progress-checkpoint.json");
  try {
    return await readJson<ResumeCheckpoint>(checkpointPath);
  } catch {
    return null;
  }
}

function mergeResumedCases(allCases: EvaluationCase[], checkpoint: ResumeCheckpoint | null): EvaluationCase[] {
  if (!checkpoint?.cases?.length) {
    return allCases;
  }
  const completed = new Set(checkpoint.cases.filter((item) => item.status === "success").map((item) => `${item.roomKey}:${item.secondaryView}`));
  return allCases.filter((item) => !completed.has(`${item.roomKey}:${item.secondaryView}`));
}

function materializeCheckpointCases(allCases: EvaluationCase[], checkpoint: ResumeCheckpoint | null, mode: EvaluationMode, runDir: string): CaseResult[] {
  if (!checkpoint?.cases?.length) {
    return [];
  }
  const lookup = new Map(allCases.map((item) => [`${item.roomKey}:${item.secondaryView}`, item]));
  return checkpoint.cases.map((item) => {
    const manifestCase = lookup.get(`${item.roomKey}:${item.secondaryView}`);
    return {
      roomKey: item.roomKey,
      roomLabel: item.roomLabel || manifestCase?.roomLabel || item.roomKey,
      roomType: item.roomType || manifestCase?.roomType || "unknown",
      secondaryView: item.secondaryView,
      secondaryImage: item.secondaryImage || manifestCase?.secondaryImage || "",
      status: item.status,
      mode: item.mode || mode,
      plannerMode: item.plannerMode || "replay",
      plannerPath: item.plannerPath || null,
      occupancyGenerationMode: item.occupancyGenerationMode || null,
      outputDir: item.outputDir || path.join(runDir, slugForRoomCase(item.roomKey, item.secondaryView)),
      failureCategory: item.failureCategory || null,
      failureReason: item.failureReason || null,
      telemetry: item.telemetry || {
        plannerLatencyMs: null,
        occupancyLatencyMs: null,
        renderLatencyMs: null,
        occupancyAreaRatio: null,
        finalAreaRatio: null,
        requiredClusterOccupancy: null,
        optionalClusterOccupancy: null,
        unionOccupancy: null,
        retryCount: null,
        clusterApiCallCount: null,
        rateLimit429Count: 0,
        validatorDriftPass: null,
      },
    };
  });
}

async function withRuntimePhase<T>(state: EvaluationRuntimeState, phase: RuntimePhase, providerCall: string | null, work: () => Promise<T>): Promise<T> {
  const previousPhase = state.currentPhase;
  const previousCall = state.currentProviderCall;
  const start = captureMemorySnapshot();
  const startedAt = Date.now();
  state.currentPhase = phase;
  state.currentProviderCall = providerCall;
  nLog("[EVAL_PHASE_START]", {
    phase,
    providerCall,
    ...formatMemoryMb(start),
  });
  try {
    return await work();
  } finally {
    const end = captureMemorySnapshot();
    nLog("[EVAL_PHASE_END]", {
      phase,
      providerCall,
      latencyMs: Date.now() - startedAt,
      ...formatMemoryMb(end),
    });
    state.currentPhase = previousPhase;
    state.currentProviderCall = previousCall;
  }
}

function parseDatasetFilename(fileName: string): { roomLabel: string; view: number } | null {
  const match = /^(.*)\.(\d+)\.(jpe?g|png|webp)$/i.exec(fileName.trim());
  if (!match) {
    return null;
  }
  const roomLabel = String(match[1] || "").trim();
  const view = Number(match[2]);
  if (!roomLabel || !Number.isFinite(view) || view < 1) {
    return null;
  }
  return { roomLabel, view };
}

export async function discoverDataset(datasetDir: string): Promise<DatasetManifest> {
  const entries = await fs.readdir(datasetDir, { withFileTypes: true });
  const groups = new Map<string, { roomLabel: string; files: Array<{ filePath: string; view: number }> }>();

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const parsed = parseDatasetFilename(entry.name);
    if (!parsed) {
      continue;
    }
    const roomKey = normalizeRoomKey(parsed.roomLabel);
    const filePath = path.join(datasetDir, entry.name);
    const current = groups.get(roomKey) || { roomLabel: parsed.roomLabel, files: [] };
    current.files.push({ filePath, view: parsed.view });
    groups.set(roomKey, current);
  }

  const normalizedGroups: RoomGroupManifest[] = [];
  for (const [roomKey, group] of groups.entries()) {
    const master = group.files.find((item) => item.view === 1);
    if (!master) {
      continue;
    }
    const secondaryImages = group.files
      .filter((item) => item.view >= 2)
      .sort((left, right) => left.view - right.view)
      .map((item) => item.filePath);

    if (secondaryImages.length === 0) {
      continue;
    }

    normalizedGroups.push({
      roomKey,
      roomLabel: group.roomLabel,
      roomType: inferRoomType(group.roomLabel),
      masterImage: master.filePath,
      secondaryImages,
    });
  }

  normalizedGroups.sort((left, right) => left.roomKey.localeCompare(right.roomKey));

  return {
    generatedAt: new Date().toISOString(),
    datasetDir,
    totalRooms: normalizedGroups.length,
    totalSecondaryViews: normalizedGroups.reduce((sum, group) => sum + group.secondaryImages.length, 0),
    groups: normalizedGroups,
  };
}

function expandCases(manifest: DatasetManifest): EvaluationCase[] {
  const cases: EvaluationCase[] = [];
  for (const group of manifest.groups) {
    for (const secondaryImage of group.secondaryImages) {
      const parsed = parseDatasetFilename(path.basename(secondaryImage));
      if (!parsed) {
        continue;
      }
      cases.push({
        roomKey: group.roomKey,
        roomLabel: group.roomLabel,
        roomType: group.roomType,
        masterImage: group.masterImage,
        secondaryImage,
        secondaryView: parsed.view,
      });
    }
  }
  return cases;
}

function classifyFailure(error: unknown): string {
  const message = String((error as { message?: unknown })?.message || error || "").toLowerCase();

  if (message.includes("planner returned no furniture zones") || message.includes("planner_empty")) return "planner_empty";
  if (message.includes("planner_") || message.includes("invalid planner")) return "planner_invalid";
  if (message.includes("too sparse") || message.includes("area too sparse") || message.includes("occupancy_sparse")) return "occupancy_sparse";
  if (message.includes("components exceeded") || message.includes("fragmented")) return "occupancy_fragmented";
  if (message.includes("wall") && message.includes("occupancy")) return "occupancy_wall_touch";
  if (message.includes("empty after cleanup") || message.includes("union")) return "occupancy_union_failure";
  if (message.includes("continuity_drift")) return "continuity_drift";
  if (message.includes("validator")) return "validator_failure";
  if (message.includes("render") || message.includes("imagen")) return "render_failure";
  if (message.includes("retry") && message.includes("exhaust")) return "retry_exhaustion";
  if (message.includes("429") || message.includes("resource_exhausted") || message.includes("too many requests")) return "429_retry_failure";
  return "provider_failure";
}

async function createReviewSheet(params: {
  masterPath: string;
  secondaryPath: string;
  occupancyMaskPath?: string | null;
  finalMaskPath?: string | null;
  continuityOutputPath?: string | null;
  validationOverlayPath?: string | null;
  outputPath: string;
}): Promise<void> {
  const cellWidth = 512;
  const cellHeight = 320;
  const canvasWidth = cellWidth * 3;
  const canvasHeight = cellHeight * 2;

  const panelPaths = [
    params.masterPath,
    params.secondaryPath,
    params.occupancyMaskPath || params.finalMaskPath || params.secondaryPath,
    params.finalMaskPath || params.secondaryPath,
    params.continuityOutputPath || params.secondaryPath,
    params.validationOverlayPath || params.secondaryPath,
  ];

  const composites: sharp.OverlayOptions[] = [];
  for (let index = 0; index < panelPaths.length; index += 1) {
    const panelPath = panelPaths[index];
    const resized = await sharp(panelPath)
      .resize(cellWidth, cellHeight, { fit: "contain", background: { r: 16, g: 16, b: 16, alpha: 1 } })
      .png()
      .toBuffer();
    const col = index % 3;
    const row = Math.floor(index / 3);
    composites.push({
      input: resized,
      left: col * cellWidth,
      top: row * cellHeight,
    });
  }

  await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background: { r: 8, g: 8, b: 8, alpha: 1 },
    },
  })
    .composite(composites)
    .png()
    .toFile(params.outputPath);
}

async function evaluateContinuityDrift(params: {
  sourceImagePath: string;
  renderedImagePath: string;
  maskPath: string;
  outputDir: string;
}): Promise<ContinuityDriftSummary> {
  const source = await sharp(params.sourceImagePath).removeAlpha().resize({ width: undefined, height: undefined }).raw().toBuffer({ resolveWithObject: true });
  const width = source.info.width;
  const height = source.info.height;

  const rendered = await sharp(params.renderedImagePath)
    .removeAlpha()
    .resize(width, height, { fit: "fill" })
    .raw()
    .toBuffer();
  const mask = await sharp(params.maskPath)
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .grayscale()
    .raw()
    .toBuffer();

  const sourceRaw = Buffer.from(source.data as Uint8Array);
  const threshold = 18;
  let totalMae = 0;
  let outsideMae = 0;
  let outsidePixels = 0;
  let changedOutside = 0;
  let insidePixels = 0;
  let changedInside = 0;
  const driftMap = Buffer.alloc(width * height * 4, 0);
  const overlay = Buffer.alloc(width * height * 4, 0);

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const baseOffset = pixel * 3;
    const rgbaOffset = pixel * 4;
    const dr = Math.abs(sourceRaw[baseOffset] - rendered[baseOffset]);
    const dg = Math.abs(sourceRaw[baseOffset + 1] - rendered[baseOffset + 1]);
    const db = Math.abs(sourceRaw[baseOffset + 2] - rendered[baseOffset + 2]);
    const delta = (dr + dg + db) / 3;
    totalMae += delta;

    const inMask = mask[pixel] > 0;
    if (!inMask) {
      outsidePixels += 1;
      outsideMae += delta;
      if (delta >= threshold) {
        changedOutside += 1;
      }
    } else {
      insidePixels += 1;
      if (delta >= threshold) {
        changedInside += 1;
      }
    }

    const heat = Math.max(0, Math.min(255, Math.round(delta * 4)));
    driftMap[rgbaOffset] = heat;
    driftMap[rgbaOffset + 1] = 0;
    driftMap[rgbaOffset + 2] = 0;
    driftMap[rgbaOffset + 3] = 255;

    overlay[rgbaOffset] = rendered[baseOffset];
    overlay[rgbaOffset + 1] = rendered[baseOffset + 1];
    overlay[rgbaOffset + 2] = rendered[baseOffset + 2];
    overlay[rgbaOffset + 3] = 255;
    if (!inMask && delta >= threshold) {
      overlay[rgbaOffset] = 255;
      overlay[rgbaOffset + 1] = 64;
      overlay[rgbaOffset + 2] = 64;
    }
  }

  const meanAbsoluteErrorAll = totalMae / Math.max(1, width * height);
  const meanAbsoluteErrorOutsideMask = outsideMae / Math.max(1, outsidePixels);
  const changedRatioOutsideMask = changedOutside / Math.max(1, outsidePixels);
  const changedRatioInsideMask = changedInside / Math.max(1, insidePixels);
  const driftPass = meanAbsoluteErrorOutsideMask <= 6 && changedRatioOutsideMask <= 0.035;

  await sharp(driftMap, { raw: { width, height, channels: 4 } }).png().toFile(path.join(params.outputDir, "drift-map.png"));
  await sharp(overlay, { raw: { width, height, channels: 4 } }).png().toFile(path.join(params.outputDir, "validation-overlay.png"));

  const summary: ContinuityDriftSummary = {
    width,
    height,
    meanAbsoluteErrorAll,
    meanAbsoluteErrorOutsideMask,
    changedPixelsOutsideMask: changedOutside,
    changedRatioOutsideMask,
    changedPixelsInsideMask: changedInside,
    changedRatioInsideMask,
    outsideMaskThreshold: threshold,
    driftPass,
  };
  await writeJson(path.join(params.outputDir, "validator-summary.json"), summary);
  return summary;
}

async function resolvePlannerExecution(params: {
  mode: EvaluationMode;
  caseItem: EvaluationCase;
  plannerDir: string;
  sourceRunDir?: string;
  secondaryRef: ImageReference;
  masterRef: ImageReference;
  runtime?: EvaluationRuntimeState;
}): Promise<PlannerExecution> {
  const mode = normalizeMode(params.mode);
  const replayModes: EvaluationMode[] = ["replay_planner", "occupancy_only", "continuity_only", "validator_only"];
  const shouldReplay = replayModes.includes(mode);
  const plannerPathInCase = path.join(params.plannerDir, "planner.json");

  if (shouldReplay) {
    if (!params.sourceRunDir) {
      throw new VertexSecondaryContinuityError(
        `Mode ${mode} requires --source-run-dir for deterministic planner replay`,
        "planner_replay_source_missing"
      );
    }
    const sourcePlannerPath = path.join(
      params.sourceRunDir,
      slugForRoomCase(params.caseItem.roomKey, params.caseItem.secondaryView),
      "planner",
      "planner.json",
    );
    const plan = await readJson<PlacementPlan>(sourcePlannerPath);
    await writeJson(plannerPathInCase, plan);
    await fs.writeFile(path.join(params.plannerDir, "planner-raw.txt"), JSON.stringify(plan, null, 2));
    const summary = {
      mode: "replay",
      sourcePlannerPath,
      plannerModel: "planner_replay",
      plannerLatencyMs: 0,
      zoneCount: plan.furnitureZones.length,
      roomType: plan.roomType,
    };
    await writeJson(path.join(params.plannerDir, "planner-summary.json"), summary);
    return {
      plan,
      prompt: "REPLAY_PLANNER",
      rawText: JSON.stringify(plan, null, 2),
      model: "planner_replay",
      latencyMs: 0,
      mode: "replay",
      sourcePath: sourcePlannerPath,
    };
  }

  const plannerProvider = new VertexSpatialPlannerProvider();
  const planner = await (params.runtime
    ? withRuntimePhase(params.runtime, "planner", `${params.caseItem.roomKey}-planner`, () => plannerProvider.plan({
        secondaryImage: params.secondaryRef,
        masterImage: params.masterRef,
        roomType: params.caseItem.roomType,
        continuityGroupId: `${params.caseItem.roomKey}-group`,
        jobId: `${params.caseItem.roomKey}-planner`,
        imageId: `${params.caseItem.roomKey}-view-${params.caseItem.secondaryView}`,
        renderMode: "full_secondary_continuity",
      }))
    : plannerProvider.plan({
        secondaryImage: params.secondaryRef,
        masterImage: params.masterRef,
        roomType: params.caseItem.roomType,
        continuityGroupId: `${params.caseItem.roomKey}-group`,
        jobId: `${params.caseItem.roomKey}-planner`,
        imageId: `${params.caseItem.roomKey}-view-${params.caseItem.secondaryView}`,
        renderMode: "full_secondary_continuity",
      }));

  await writeJson(plannerPathInCase, planner.plan);
  await fs.writeFile(path.join(params.plannerDir, "planner-raw.txt"), planner.rawText || "");
  await fs.writeFile(path.join(params.plannerDir, "planner-prompt.txt"), planner.prompt || "");
  await writeJson(path.join(params.plannerDir, "planner-summary.json"), {
    mode: "live",
    plannerModel: planner.model,
    plannerLatencyMs: planner.latencyMs,
    zoneCount: planner.plan.furnitureZones.length,
    roomType: planner.plan.roomType,
  });

  return {
    plan: planner.plan,
    prompt: planner.prompt,
    rawText: planner.rawText,
    model: planner.model,
    latencyMs: planner.latencyMs,
    mode: "live",
    sourcePath: null,
  };
}

function countApprox429FromRetryComparison(retryComparison: unknown): number {
  if (!Array.isArray(retryComparison)) {
    return 0;
  }
  return retryComparison.filter((entry) => {
    const record = entry as Record<string, unknown>;
    const threshold = Number(record.selectedThreshold || 0);
    const score = Number(record.score || 0);
    const area = Number(record.occupancyAreaRatio || 0);
    return threshold === 0 && score === 0 && area === 0;
  }).length;
}

async function runCase(params: {
  caseItem: EvaluationCase;
  mode: EvaluationMode;
  runDir: string;
  sourceRunDir?: string;
  useGeminiOccupancy: boolean;
  runtime: EvaluationRuntimeState;
  caseResults: CaseResult[];
}): Promise<CaseResult> {
  const caseOutputDir = path.join(params.runDir, slugForRoomCase(params.caseItem.roomKey, params.caseItem.secondaryView));
  const plannerDir = path.join(caseOutputDir, "planner");
  const occupancyDir = path.join(caseOutputDir, "occupancy");
  const continuityDir = path.join(caseOutputDir, "continuity");
  const telemetryDir = path.join(caseOutputDir, "telemetry");
  await ensureDir(plannerDir);
  await ensureDir(occupancyDir);
  await ensureDir(continuityDir);
  await ensureDir(telemetryDir);

  const statusBase: Omit<CaseResult, "status" | "failureCategory" | "failureReason" | "occupancyGenerationMode" | "plannerMode" | "plannerPath"> = {
    roomKey: params.caseItem.roomKey,
    roomLabel: params.caseItem.roomLabel,
    roomType: params.caseItem.roomType,
    secondaryView: params.caseItem.secondaryView,
    secondaryImage: params.caseItem.secondaryImage,
    mode: params.mode,
    outputDir: caseOutputDir,
    telemetry: {
      plannerLatencyMs: null,
      occupancyLatencyMs: null,
      renderLatencyMs: null,
      occupancyAreaRatio: null,
      finalAreaRatio: null,
      requiredClusterOccupancy: null,
      optionalClusterOccupancy: null,
      unionOccupancy: null,
      retryCount: null,
      clusterApiCallCount: null,
      rateLimit429Count: 0,
      validatorDriftPass: null,
    },
  };

  try {
    const secondaryRef: ImageReference = {
      kind: "local",
      localPath: params.caseItem.secondaryImage,
      sourceLabel: "secondary-continuity-source",
      mimeType: "image/jpeg",
      artifactName: path.basename(params.caseItem.secondaryImage),
    };
    const masterRef: ImageReference = {
      kind: "local",
      localPath: params.caseItem.masterImage,
      sourceLabel: "secondary-continuity-master",
      mimeType: "image/jpeg",
      artifactName: path.basename(params.caseItem.masterImage),
    };

    const planner = await resolvePlannerExecution({
      mode: params.mode,
      caseItem: params.caseItem,
      plannerDir,
      sourceRunDir: params.sourceRunDir,
      secondaryRef,
      masterRef,
      runtime: params.runtime,
    });

    const normalizedMode = normalizeMode(params.mode);
    let compiledMask: CompiledMaskResult | null = null;
    let continuityOutputPath: string | null = null;
    let driftSummary: ContinuityDriftSummary | null = null;

    if (normalizedMode !== "continuity_only" && normalizedMode !== "validator_only") {
      process.env.CONTINUITY_USE_GEMINI_OCCUPANCY_MASK = params.useGeminiOccupancy ? "true" : "false";
      const caseJobId = `eval-${params.caseItem.roomKey}_v${params.caseItem.secondaryView}`;
      const caseImageId = `${params.caseItem.roomKey}-view-${params.caseItem.secondaryView}`;
      const derivedConstraintMaskPath = path.join(occupancyDir, "occupancy-constraint-derived.png");
      await withRuntimePhase(params.runtime, "occupancy", `${caseJobId}-derive-constraint`, () =>
        buildDeterministicPlanConstraintMask({
          plan: planner.plan,
          secondaryImagePath: params.caseItem.secondaryImage,
          outputPath: derivedConstraintMaskPath,
        }),
      );
      compiledMask = await withRuntimePhase(params.runtime, "occupancy", caseJobId, () => compileDeterministicMask({
        plan: planner.plan,
        secondaryImagePath: params.caseItem.secondaryImage,
        masterImagePath: params.caseItem.masterImage,
        occupancyMaskPath: path.join(occupancyDir, "occupancy-mask.png"),
        exclusionMaskPath: path.join(occupancyDir, "exclusion-mask.png"),
        finalMaskPath: path.join(occupancyDir, "final-mask.png"),
        occupancyConstraintMaskPath: derivedConstraintMaskPath,
        continuityGroupId: params.caseItem.roomKey,
        jobId: caseJobId,
        imageId: caseImageId,
      }));

      if (!compiledMask) {
        throw new VertexSecondaryContinuityError("Missing compiled mask after occupancy generation", "occupancy_generation_failed");
      }
      const resolvedCompiledMask = compiledMask;

      const maskValidation = await withRuntimePhase(params.runtime, "validator", `${caseJobId}-mask-validation`, () => validateCompiledMask({
        sourceImagePath: params.caseItem.secondaryImage,
        compiledMask: resolvedCompiledMask,
        continuityGroupId: params.caseItem.roomKey,
        jobId: caseJobId,
        imageId: caseImageId,
      }));
      await writeJson(path.join(telemetryDir, "mask-validation.json"), maskValidation);

      statusBase.telemetry.occupancyAreaRatio = compiledMask.occupancyAreaRatio;
      statusBase.telemetry.finalAreaRatio = compiledMask.finalAreaRatio;
      statusBase.telemetry.occupancyLatencyMs = compiledMask.geminiMaskArtifacts?.latencyMs || 0;
      statusBase.telemetry.retryCount = compiledMask.geminiMaskArtifacts?.retryCount || 0;
      statusBase.telemetry.clusterApiCallCount = compiledMask.geminiMaskArtifacts?.clusterApiCallCount || 0;

      if (compiledMask.geminiMaskArtifacts?.occupancyCollapseAnalysisPath) {
        const collapse = await readJson<Record<string, unknown>>(compiledMask.geminiMaskArtifacts.occupancyCollapseAnalysisPath);
        statusBase.telemetry.requiredClusterOccupancy = Number(collapse.requiredClusterOccupancy || 0);
        statusBase.telemetry.optionalClusterOccupancy = Number(collapse.optionalClusterOccupancy || 0);
        statusBase.telemetry.unionOccupancy = Number(collapse.acceptedOccupancyRatio || 0);
      }

      if (compiledMask.geminiMaskArtifacts?.retryComparisonPath) {
        const retryComparison = await readJson<unknown>(compiledMask.geminiMaskArtifacts.retryComparisonPath);
        statusBase.telemetry.rateLimit429Count = countApprox429FromRetryComparison(retryComparison);
      }
    }

    let maskForRenderPath = compiledMask?.finalMaskPath || null;
    if (normalizedMode === "continuity_only" || normalizedMode === "validator_only") {
      if (!params.sourceRunDir) {
        throw new VertexSecondaryContinuityError(
          `Mode ${normalizedMode} requires --source-run-dir`,
          "replay_source_missing"
        );
      }
      const sourceMaskPath = path.join(
        params.sourceRunDir,
        slugForRoomCase(params.caseItem.roomKey, params.caseItem.secondaryView),
        "occupancy",
        "final-mask.png",
      );
      maskForRenderPath = sourceMaskPath;
      await fs.copyFile(sourceMaskPath, path.join(occupancyDir, "final-mask.png"));
      await fs.copyFile(
        path.join(params.sourceRunDir, slugForRoomCase(params.caseItem.roomKey, params.caseItem.secondaryView), "occupancy", "occupancy-mask.png"),
        path.join(occupancyDir, "occupancy-mask.png"),
      ).catch(() => Promise.resolve());
    }

    if (normalizedMode !== "occupancy_only" && normalizedMode !== "validator_only") {
      if (!maskForRenderPath) {
        throw new VertexSecondaryContinuityError("Missing mask path for continuity render", "continuity_mask_missing");
      }
      const renderer = new VertexImageRendererProvider();
      const prompt = buildImagenInsertionPrompt({
        plan: planner.plan,
        materialPalette: [],
        lightingHint: "adapted natural lighting",
      });
      const renderResult = await withRuntimePhase(params.runtime, "continuity", `eval-${params.caseItem.roomKey}_v${params.caseItem.secondaryView}-render`, () => renderer.render({
        sourceImage: secondaryRef,
        maskImage: {
          kind: "local",
          localPath: maskForRenderPath,
          sourceLabel: "continuity-mask",
          mimeType: "image/png",
          artifactName: "final-mask.png",
        },
        outputPath: path.join(continuityDir, "continuity-output.webp"),
        prompt,
        continuityGroupId: params.caseItem.roomKey,
        jobId: `eval-${params.caseItem.roomKey}_v${params.caseItem.secondaryView}`,
        imageId: `${params.caseItem.roomKey}-view-${params.caseItem.secondaryView}`,
        renderMode: "full_secondary_continuity",
      }));
      continuityOutputPath = renderResult.outputPath;
      statusBase.telemetry.renderLatencyMs = renderResult.latencyMs;
      await writeJson(path.join(continuityDir, "render-summary.json"), {
        model: renderResult.model,
        latencyMs: renderResult.latencyMs,
        mimeType: renderResult.mimeType,
        guidanceScale: renderResult.guidanceScale,
      });
    } else if (normalizedMode === "validator_only") {
      if (!params.sourceRunDir) {
        throw new VertexSecondaryContinuityError("validator_only requires --source-run-dir", "validator_source_missing");
      }
      const sourceRenderedPath = path.join(
        params.sourceRunDir,
        slugForRoomCase(params.caseItem.roomKey, params.caseItem.secondaryView),
        "continuity",
        "continuity-output.webp",
      );
      continuityOutputPath = sourceRenderedPath;
      await fs.copyFile(sourceRenderedPath, path.join(continuityDir, "continuity-output.webp"));
      continuityOutputPath = path.join(continuityDir, "continuity-output.webp");
    }

    if (continuityOutputPath && maskForRenderPath) {
      driftSummary = await withRuntimePhase(params.runtime, "validator", `${params.caseItem.roomKey}-drift`, () => evaluateContinuityDrift({
        sourceImagePath: params.caseItem.secondaryImage,
        renderedImagePath: continuityOutputPath,
        maskPath: maskForRenderPath,
        outputDir: continuityDir,
      }));
      statusBase.telemetry.validatorDriftPass = driftSummary.driftPass;
    }

    const validationOverlayPath = path.join(continuityDir, "validation-overlay.png");
    const resolvedValidationOverlayPath = await fs.access(validationOverlayPath)
      .then(() => validationOverlayPath)
      .catch(() => null);

    await createReviewSheet({
      masterPath: params.caseItem.masterImage,
      secondaryPath: params.caseItem.secondaryImage,
      occupancyMaskPath: path.join(occupancyDir, "occupancy-mask.png"),
      finalMaskPath: path.join(occupancyDir, "final-mask.png"),
      continuityOutputPath,
      validationOverlayPath: resolvedValidationOverlayPath,
      outputPath: path.join(caseOutputDir, "review-sheet.png"),
    });

    await writeJson(path.join(telemetryDir, "case-telemetry.json"), {
      roomKey: params.caseItem.roomKey,
      roomType: params.caseItem.roomType,
      secondaryView: params.caseItem.secondaryView,
      planner,
      driftSummary,
      telemetry: statusBase.telemetry,
    });

    return {
      ...statusBase,
      status: "success",
      plannerMode: planner.mode,
      plannerPath: planner.sourcePath || path.join(plannerDir, "planner.json"),
      occupancyGenerationMode: compiledMask?.occupancyGenerationMode || null,
      failureCategory: null,
      failureReason: null,
    };
  } catch (error) {
    const failureCategory = classifyFailure(error);
    const failureReason = String((error as { message?: unknown })?.message || error || "unknown error");
    await writeJson(path.join(telemetryDir, "case-error.json"), {
      failureCategory,
      failureReason,
      stack: (error as Error)?.stack || null,
    });

    return {
      ...statusBase,
      status: "failure",
      plannerMode: "replay",
      plannerPath: null,
      occupancyGenerationMode: null,
      failureCategory,
      failureReason,
    };
  }
}

function summarizeCases(params: {
  runDir: string;
  datasetManifest: DatasetManifest;
  mode: EvaluationMode;
  sourceRunDir?: string;
  cases: CaseResult[];
}): EvaluationSummary {
  const completedCases = params.cases.length;
  const successCases = params.cases.filter((item) => item.status === "success");
  const failureCases = params.cases.filter((item) => item.status === "failure");
  const skippedCases = params.cases.filter((item) => item.status === "skipped");

  const occupancyRatios = successCases
    .map((item) => item.telemetry.occupancyAreaRatio)
    .filter((value): value is number => Number.isFinite(value));
  const unionRatios = successCases
    .map((item) => item.telemetry.unionOccupancy)
    .filter((value): value is number => Number.isFinite(value));
  const requiredRatios = successCases
    .map((item) => item.telemetry.requiredClusterOccupancy)
    .filter((value): value is number => Number.isFinite(value));
  const optionalRatios = successCases
    .map((item) => item.telemetry.optionalClusterOccupancy)
    .filter((value): value is number => Number.isFinite(value));
  const retryCounts = successCases
    .map((item) => item.telemetry.retryCount)
    .filter((value): value is number => Number.isFinite(value));

  const failureCategories: Record<string, number> = {};
  for (const failure of failureCases) {
    const key = failure.failureCategory || "unknown";
    failureCategories[key] = (failureCategories[key] || 0) + 1;
  }

  const roomTypeBreakdown: EvaluationSummary["roomTypeBreakdown"] = {};
  for (const item of params.cases) {
    if (!roomTypeBreakdown[item.roomType]) {
      roomTypeBreakdown[item.roomType] = {
        total: 0,
        success: 0,
        failures: 0,
        successRate: 0,
        averageOccupancyAreaRatio: 0,
      };
    }
    const bucket = roomTypeBreakdown[item.roomType];
    bucket.total += 1;
    if (item.status === "success") {
      bucket.success += 1;
    }
    if (item.status === "failure") {
      bucket.failures += 1;
    }
  }

  for (const [roomType, bucket] of Object.entries(roomTypeBreakdown)) {
    bucket.successRate = bucket.total > 0 ? bucket.success / bucket.total : 0;
    const roomOccupancies = successCases
      .filter((item) => item.roomType === roomType)
      .map((item) => item.telemetry.occupancyAreaRatio)
      .filter((value): value is number => Number.isFinite(value));
    bucket.averageOccupancyAreaRatio = mean(roomOccupancies);
  }

  const plannerFailures = failureCases.filter((item) => (item.failureCategory || "").startsWith("planner")).length;
  const occupancyFailures = failureCases.filter((item) => (item.failureCategory || "").startsWith("occupancy")).length;
  const driftEvaluated = successCases.filter((item) => item.telemetry.validatorDriftPass !== null);
  const continuityPasses = driftEvaluated.filter((item) => item.telemetry.validatorDriftPass === true).length;
  const total429Count = params.cases.reduce((sum, item) => sum + item.telemetry.rateLimit429Count, 0);

  return {
    generatedAt: new Date().toISOString(),
    runDir: params.runDir,
    datasetDir: params.datasetManifest.datasetDir,
    mode: params.mode,
    sourceRunDir: params.sourceRunDir || null,
    totalRooms: params.datasetManifest.totalRooms,
    totalSecondaryViews: params.datasetManifest.totalSecondaryViews,
    completedCases,
    successCount: successCases.length,
    failureCount: failureCases.length,
    skippedCount: skippedCases.length,
    successRate: completedCases > 0 ? successCases.length / completedCases : 0,
    plannerFailureRate: completedCases > 0 ? plannerFailures / completedCases : 0,
    occupancyFailureRate: completedCases > 0 ? occupancyFailures / completedCases : 0,
    continuityPassRate: driftEvaluated.length > 0 ? continuityPasses / driftEvaluated.length : 0,
    averageOccupancyAreaRatio: mean(occupancyRatios),
    averageUnionOccupancyRatio: mean(unionRatios),
    averageRequiredClusterOccupancy: mean(requiredRatios),
    averageOptionalClusterOccupancy: mean(optionalRatios),
    averageRetryCount: mean(retryCounts),
    total429Count,
    failureCategories,
    roomTypeBreakdown,
    occupancyDistribution: {
      required: requiredRatios,
      optional: optionalRatios,
      union: unionRatios,
      variance: variance(unionRatios),
    },
    cases: params.cases,
  };
}

export async function runContinuityEvaluation(options: RunContinuityEvaluationOptions): Promise<{
  runDir: string;
  datasetManifest: DatasetManifest;
  summary: EvaluationSummary;
}> {
  const mode = normalizeMode(options.mode);
  await bootstrapGoogleCredentialsFromEnv();

  await ensureDir(options.outputRootDir);
  const runId = `run_${new Date().toISOString().replace(/[-:.TZ]/g, "")}`;
  const runDir = options.runDir ? path.resolve(options.runDir) : path.join(options.outputRootDir, runId);
  await ensureDir(runDir);

  nLog("[CONTINUITY_EVALUATION_START]", {
    datasetDir: options.datasetDir,
    mode,
    sourceRunDir: options.sourceRunDir || null,
    runDir,
    useGeminiOccupancy: options.useGeminiOccupancy,
  });

  const datasetManifest = await discoverDataset(options.datasetDir);
  await writeJson(path.join(runDir, "continuity-dataset-manifest.json"), datasetManifest);
  await writeJson(path.join(runDir, "dataset-manifest.json"), datasetManifest);
  await bestEffortWriteJson(path.join(options.outputRootDir, "latest-run.json"), { runDir, generatedAt: new Date().toISOString() });

  const allCases = expandCases(datasetManifest);
  const checkpoint = options.resume ? await loadResumeCheckpoint(runDir) : null;
  const targetCases = Number.isFinite(options.maxCases)
    ? allCases.slice(0, Math.max(0, Number(options.maxCases || 0)))
    : allCases;
  const pendingCases = options.resume ? mergeResumedCases(targetCases, checkpoint) : targetCases;
  const seededResults = materializeCheckpointCases(targetCases, checkpoint, mode, runDir);
  const runtime = createRuntimeState({
    runDir,
    datasetDir: options.datasetDir,
    mode,
    sourceRunDir: options.sourceRunDir,
    useGeminiOccupancy: options.useGeminiOccupancy,
    totalCases: pendingCases.length,
    pidFilePath: options.pidFilePath,
  });
  await bestEffortWriteJson(runtime.pidFilePath, { pid: process.pid, runDir, generatedAt: new Date().toISOString() });

  const caseResults: CaseResult[] = [...seededResults];
  const cleanupHandlers = attachRuntimeHandlers(runtime, caseResults);
  const heartbeatIntervalMs = Math.max(10_000, Math.floor(options.heartbeatIntervalMs || 30_000));
  const heartbeatTimer = setInterval(() => {
    void (async () => {
      nLog("[EVAL_HEARTBEAT]", {
        runDir,
        ...runtimeSnapshot(runtime),
      });
      await writeHeartbeat(runtime, caseResults);
      await writeCheckpoint(runtime, caseResults);
    })();
  }, heartbeatIntervalMs);
  heartbeatTimer.unref();

  try {
    runtime.currentPhase = "checkpoint";
    await writeCheckpoint(runtime, caseResults);

    for (const caseItem of pendingCases) {
      runtime.currentCase = {
        roomKey: caseItem.roomKey,
        roomLabel: caseItem.roomLabel,
        roomType: caseItem.roomType,
        secondaryView: caseItem.secondaryView,
        secondaryImage: caseItem.secondaryImage,
        status: null,
        failureCategory: null,
        failureReason: null,
      };
      runtime.currentPhase = "idle";
      nLog("[EVAL_MEMORY]", {
        scope: "case-start",
        roomKey: caseItem.roomKey,
        secondaryView: caseItem.secondaryView,
        ...formatMemoryMb(captureMemorySnapshot()),
      });

      const result = await runCase({
        caseItem,
        mode,
        runDir,
        sourceRunDir: options.sourceRunDir,
        useGeminiOccupancy: options.useGeminiOccupancy,
        runtime,
        caseResults,
      });
      caseResults.push(result);

      runtime.completedCases = caseResults.length;
      runtime.failedCases = caseResults.filter((item) => item.status === "failure").length;
      runtime.skippedCases = caseResults.filter((item) => item.status === "skipped").length;
      runtime.currentCase.status = result.status;
      runtime.currentCase.failureCategory = result.failureCategory;
      runtime.currentCase.failureReason = result.failureReason;

      nLog("[CONTINUITY_EVALUATION_CASE]", {
        roomKey: result.roomKey,
        secondaryView: result.secondaryView,
        status: result.status,
        failureCategory: result.failureCategory,
        outputDir: result.outputDir,
      });

      runtime.currentPhase = "checkpoint";
      await writeCheckpoint(runtime, caseResults);
      await writeHeartbeat(runtime, caseResults);
    }
  } finally {
    clearInterval(heartbeatTimer);
    cleanupHandlers();
    await writeCheckpoint(runtime, caseResults);
    await writeHeartbeat(runtime, caseResults);
    await bestEffortWriteJson(runtime.pidFilePath, { pid: process.pid, runDir, generatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  }

  const summary = summarizeCases({
    runDir,
    datasetManifest,
    mode,
    sourceRunDir: options.sourceRunDir,
    cases: caseResults,
  });

  await writeJson(path.join(runDir, "failure-analysis.json"), {
    generatedAt: new Date().toISOString(),
    failures: caseResults.filter((item) => item.status === "failure").map((item) => ({
      roomKey: item.roomKey,
      roomType: item.roomType,
      secondaryView: item.secondaryView,
      failureCategory: item.failureCategory,
      failureReason: item.failureReason,
      outputDir: item.outputDir,
    })),
  });
  await writeJson(path.join(runDir, "summary.json"), summary);
  await writeJson(path.join(runDir, "continuity-evaluation-summary.json"), summary);

  nLog("[CONTINUITY_EVALUATION_COMPLETE]", {
    runDir,
    totalCases: summary.completedCases,
    successCount: summary.successCount,
    failureCount: summary.failureCount,
    successRate: Number(summary.successRate.toFixed(4)),
  });

  return {
    runDir,
    datasetManifest,
    summary,
  };
}
