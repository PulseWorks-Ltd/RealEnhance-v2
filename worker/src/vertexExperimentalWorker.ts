import os from "os";
import path from "path";
import { QueueEvents, Worker, type Job } from "bullmq";
import { CONTINUITY_RENDER_QUEUE } from "../../shared/src/constants";
import { nLog } from "./logger";
import { bootstrapGoogleCredentialsFromEnv } from "./bootstrap/googleCredentials";
import { validateVertexExperimentalEnv } from "./bootstrap/envValidation";
import { runGcsHealthcheck, runVertexConnectivityTest } from "./bootstrap/healthChecks";
import { createContinuityRepairProvider } from "./providers";
import type { VertexExperimentalContinuityJobPayload } from "./continuity/types";
import type { ImageReference } from "./providers/types";

const REDIS_URL = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || "redis://localhost:6379";
const WORKER_IDENTITY = "worker-vertex-experimental";
const EXECUTION_AUTHORITY = "vertex-worker";

let queueEventsRef: QueueEvents | null = null;
let workerRef: Worker | null = null;

function isVertexExperimentalContinuityJobPayload(value: unknown): value is VertexExperimentalContinuityJobPayload {
  const payload = value as Partial<VertexExperimentalContinuityJobPayload> | null;
  return !!payload
    && payload.type === "vertex-continuity-experimental"
    && typeof payload.jobId === "string"
    && typeof payload.imageId === "string"
    && typeof payload.secondaryImage?.uri === "string"
    && typeof payload.masterImage?.uri === "string"
    && typeof payload.roomType === "string"
    && Number.isFinite(Number(payload.attempt));
}

function manifestToImageReference(manifest: VertexExperimentalContinuityJobPayload["secondaryImage"]): ImageReference {
  return {
    kind: "gcs",
    uri: manifest.uri,
    mimeType: manifest.mimeType,
    sourceLabel: manifest.sourceLabel,
    artifactName: manifest.artifactName,
  };
}

function buildWorkerOutputPath(payload: VertexExperimentalContinuityJobPayload): string {
  return path.join(
    os.tmpdir(),
    `vertex-continuity-${payload.jobId}-${payload.imageId}-attempt-${Math.max(1, Number(payload.attempt))}.webp`
  );
}

async function shutdown(signal: string): Promise<void> {
  nLog("[VERTEX_WORKER_SHUTDOWN]", { signal, workerIdentity: WORKER_IDENTITY });
  await workerRef?.close().catch(() => {});
  await queueEventsRef?.close().catch(() => {});
  process.exit(0);
}

async function processExperimentalJob(job: Job): Promise<Record<string, unknown>> {
  if (!isVertexExperimentalContinuityJobPayload(job.data)) {
    throw new Error("unsupported_vertex_experimental_payload");
  }

  const queueName = job.data.queueName || CONTINUITY_RENDER_QUEUE;
  const providerName = String(process.env.SECONDARY_CONTINUITY_PROVIDER || "vertex").trim().toLowerCase();
  const stage2Mode = job.data.intent?.promptScope || null;

  nLog("[SECONDARY_CONTINUITY_QUEUE]", {
    continuityGroupId: job.data.continuityGroupId || null,
    imageId: job.data.imageId,
    jobId: job.data.jobId,
    renderMode: job.data.renderMode,
    queueName,
    queueJobId: String(job.id || ""),
    workerIdentity: WORKER_IDENTITY,
    status: "processing",
  });

  nLog("[VERTEX_QUEUE_JOB_RECEIVED]", {
    continuityGroupId: job.data.continuityGroupId || null,
    imageId: job.data.imageId,
    jobId: job.data.jobId,
    renderMode: job.data.renderMode,
    queueName,
    workerIdentity: WORKER_IDENTITY,
    executionAuthority: EXECUTION_AUTHORITY,
    executionMode: "queue-consumer",
    dispatchTarget: WORKER_IDENTITY,
    provider: providerName,
    stage2Mode,
    queueJobId: String(job.id || ""),
  });

  nLog("[CONTINUITY_INPUT_MANIFEST]", {
    continuityGroupId: job.data.continuityGroupId || null,
    imageId: job.data.imageId,
    jobId: job.data.jobId,
    renderMode: job.data.renderMode,
    stage: "worker-start",
    inputs: {
      baseImage: {
        requestPath: null,
        requestUri: job.data.secondaryImage.uri,
      },
      masterImage: {
        requestPath: null,
        requestUri: job.data.masterImage.uri,
      },
      occupancyConstraintMask: {
        requestPath: null,
        requestUri: job.data.occupancyConstraintMask?.uri || null,
      },
    },
  });

  const provider = createContinuityRepairProvider();
  const outputPath = buildWorkerOutputPath(job.data);
  nLog("[VERTEX_RENDER_EXECUTION_START]", {
    continuityGroupId: job.data.continuityGroupId || null,
    imageId: job.data.imageId,
    jobId: job.data.jobId,
    renderMode: job.data.renderMode,
    queueName,
    workerIdentity: WORKER_IDENTITY,
    executionAuthority: EXECUTION_AUTHORITY,
    executionMode: "render-execution",
    dispatchTarget: WORKER_IDENTITY,
    provider: providerName,
    stage2Mode,
    queueJobId: String(job.id || ""),
    outputPath,
  });

  try {
    const result = await provider.repair({
      secondaryImage: manifestToImageReference(job.data.secondaryImage),
      masterImage: manifestToImageReference(job.data.masterImage),
      occupancyConstraintMask: job.data.occupancyConstraintMask
        ? manifestToImageReference(job.data.occupancyConstraintMask)
        : null,
      outputPath,
      roomType: job.data.roomType,
      stagingStyle: job.data.stagingStyle,
      roomConsistency: job.data.roomConsistency,
      continuityGroupId: job.data.continuityGroupId,
      jobId: job.data.jobId,
      imageId: job.data.imageId,
      attempt: Number(job.data.attempt),
      renderMode: job.data.renderMode,
      intent: job.data.intent,
      queueName,
      workerIdentity: WORKER_IDENTITY,
    });

    nLog("[VERTEX_RENDER_EXECUTION_COMPLETE]", {
      continuityGroupId: job.data.continuityGroupId || null,
      imageId: job.data.imageId,
      jobId: job.data.jobId,
      renderMode: job.data.renderMode,
      queueName,
      workerIdentity: WORKER_IDENTITY,
      executionAuthority: EXECUTION_AUTHORITY,
      executionMode: "render-execution",
      dispatchTarget: WORKER_IDENTITY,
      provider: providerName,
      stage2Mode,
      queueJobId: String(job.id || ""),
      outputPath: result.outputPath,
      outputUri: result.renderedImage.uri,
      planner: result.planner.model,
      renderer: result.render.model,
    });

    return {
      ok: true,
      jobId: job.data.jobId,
      imageId: job.data.imageId,
      renderMode: job.data.renderMode,
      outputPath: result.outputPath,
      outputUri: result.renderedImage.uri,
      planner: result.planner.model,
      renderer: result.render.model,
      queueName,
      workerIdentity: WORKER_IDENTITY,
    };
  } catch (error: any) {
    nLog("[VERTEX_RENDER_EXECUTION_FAILURE]", {
      continuityGroupId: job.data.continuityGroupId || null,
      imageId: job.data.imageId,
      jobId: job.data.jobId,
      renderMode: job.data.renderMode,
      queueName,
      workerIdentity: WORKER_IDENTITY,
      executionAuthority: EXECUTION_AUTHORITY,
      executionMode: "render-execution",
      dispatchTarget: WORKER_IDENTITY,
      provider: providerName,
      stage2Mode,
      queueJobId: String(job.id || ""),
      outputPath,
      inputArtifacts: {
        secondaryImageUri: job.data.secondaryImage.uri,
        masterImageUri: job.data.masterImage.uri,
        occupancyConstraintMaskUri: job.data.occupancyConstraintMask?.uri || null,
      },
      error: error?.message || String(error),
      stack: error instanceof Error ? error.stack || null : null,
    });
    throw error;
  }
}

async function main(): Promise<void> {
  process.env.WORKER_ROLE = process.env.WORKER_ROLE || WORKER_IDENTITY;

  const authBootstrap = await bootstrapGoogleCredentialsFromEnv();
  const env = validateVertexExperimentalEnv();
  const vertexConnectivity = await runVertexConnectivityTest({
    project: env.googleCloudProject,
    location: env.googleCloudLocation,
  });
  const gcsHealthcheck = await runGcsHealthcheck({
    project: env.googleCloudProject,
    bucket: env.vertexGcsBucket,
  });

  nLog("[VERTEX_QUEUE_BINDING]", {
    queue: env.vertexExperimentalQueue,
    workerIdentity: WORKER_IDENTITY,
    registration: "starting",
  });

  queueEventsRef = new QueueEvents(env.vertexExperimentalQueue, {
    connection: { url: REDIS_URL },
  });
  queueEventsRef.on("error", (error) => {
    nLog("[VERTEX_QUEUE_BINDING]", {
      queue: env.vertexExperimentalQueue,
      workerIdentity: WORKER_IDENTITY,
      registration: "error",
      error: (error as any)?.message || String(error),
    });
  });
  await queueEventsRef.waitUntilReady();

  workerRef = new Worker(
    env.vertexExperimentalQueue,
    processExperimentalJob,
    {
      connection: { url: REDIS_URL },
      concurrency: Math.max(1, Number(process.env.VERTEX_EXPERIMENTAL_WORKER_CONCURRENCY || 1)),
    },
  );

  workerRef.on("failed", (job, error) => {
    nLog("[VERTEX_EXPERIMENTAL_JOB_FAILURE]", {
      queue: env.vertexExperimentalQueue,
      workerIdentity: WORKER_IDENTITY,
      jobId: String(job?.id || ""),
      renderMode: (job?.data as any)?.renderMode || null,
      error: error?.message || String(error),
    });
    nLog("[VERTEX_CONTINUITY_FAILURE]", {
      continuityGroupId: (job?.data as any)?.continuityGroupId || null,
      imageId: (job?.data as any)?.imageId || null,
      jobId: (job?.data as any)?.jobId || null,
      renderMode: (job?.data as any)?.renderMode || null,
      queueName: env.vertexExperimentalQueue,
      workerIdentity: WORKER_IDENTITY,
      error: error?.message || String(error),
    });
  });

  workerRef.on("completed", (job, result) => {
    nLog("[VERTEX_EXPERIMENTAL_JOB_COMPLETE]", {
      queue: env.vertexExperimentalQueue,
      workerIdentity: WORKER_IDENTITY,
      jobId: String(job?.id || ""),
      renderMode: (job?.data as any)?.renderMode || null,
      result,
    });
  });

  await workerRef.waitUntilReady();

  nLog("[VERTEX_QUEUE_BINDING]", {
    queue: env.vertexExperimentalQueue,
    workerIdentity: WORKER_IDENTITY,
    registration: "success",
  });

  nLog("[VERTEX_WORKER_READY]", {
    workerIdentity: WORKER_IDENTITY,
    auth_bootstrap: authBootstrap.fileExists ? "success" : "failure",
    vertex_connectivity: "success",
    gcs_healthcheck: "success",
    queue: env.vertexExperimentalQueue,
    renderer: env.secondaryContinuityRenderer || "imagen3",
    planner: env.secondaryContinuityPlanner || "gemini25pro",
    connectivityTestModel: vertexConnectivity.model,
    credentialsPath: authBootstrap.credentialsPath,
    gcsObjectPath: gcsHealthcheck.objectPath,
  });
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("unhandledRejection", (reason) => {
  nLog("[VERTEX_WORKER_UNHANDLED_REJECTION]", {
    workerIdentity: WORKER_IDENTITY,
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack || null : null,
  });
});

process.on("uncaughtException", (error) => {
  nLog("[VERTEX_WORKER_UNCAUGHT_EXCEPTION]", {
    workerIdentity: WORKER_IDENTITY,
    error: error?.message || String(error),
    stack: error instanceof Error ? error.stack || null : null,
  });
  process.exit(1);
});

main().catch((error) => {
  nLog("[VERTEX_WORKER_STARTUP_FAILURE]", {
    workerIdentity: WORKER_IDENTITY,
    error: (error as any)?.message || String(error),
    stack: error instanceof Error ? error.stack || null : null,
  });
  process.exit(1);
});