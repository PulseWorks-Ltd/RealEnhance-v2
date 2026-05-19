import { QueueEvents, Worker, type Job } from "bullmq";
import type { RoomConsistencyContextV1 } from "../../shared/src/types";
import { nLog } from "./logger";
import { bootstrapGoogleCredentialsFromEnv } from "./bootstrap/googleCredentials";
import { validateVertexExperimentalEnv } from "./bootstrap/envValidation";
import { runGcsHealthcheck, runVertexConnectivityTest } from "./bootstrap/healthChecks";
import { createContinuityRepairProvider } from "./providers";

type VertexExperimentalContinuityJobPayload = {
  type: "vertex-continuity-experimental";
  jobId: string;
  imageId: string;
  attempt: number;
  secondaryImagePath: string;
  secondaryImageUri?: string | null;
  masterImagePath: string;
  masterImageUri?: string | null;
  outputPath: string;
  roomType: string;
  stagingStyle?: string;
  roomConsistency?: RoomConsistencyContextV1;
  continuityGroupId?: string | null;
};

const REDIS_URL = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || "redis://localhost:6379";
const WORKER_IDENTITY = "worker-vertex-experimental";

let queueEventsRef: QueueEvents | null = null;
let workerRef: Worker | null = null;

function isVertexExperimentalContinuityJobPayload(value: unknown): value is VertexExperimentalContinuityJobPayload {
  const payload = value as Partial<VertexExperimentalContinuityJobPayload> | null;
  return !!payload
    && payload.type === "vertex-continuity-experimental"
    && typeof payload.jobId === "string"
    && typeof payload.imageId === "string"
    && typeof payload.secondaryImagePath === "string"
    && typeof payload.masterImagePath === "string"
    && typeof payload.outputPath === "string"
    && typeof payload.roomType === "string"
    && Number.isFinite(Number(payload.attempt));
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

  const provider = createContinuityRepairProvider();
  const result = await provider.repair({
    secondaryImagePath: job.data.secondaryImagePath,
    secondaryImageUri: job.data.secondaryImageUri,
    masterImagePath: job.data.masterImagePath,
    masterImageUri: job.data.masterImageUri,
    outputPath: job.data.outputPath,
    roomType: job.data.roomType,
    stagingStyle: job.data.stagingStyle,
    roomConsistency: job.data.roomConsistency,
    continuityGroupId: job.data.continuityGroupId,
    jobId: job.data.jobId,
    imageId: job.data.imageId,
    attempt: Number(job.data.attempt),
  });

  return {
    ok: true,
    jobId: job.data.jobId,
    imageId: job.data.imageId,
    outputPath: result.outputPath,
    planner: result.planner.model,
    renderer: result.render.model,
  };
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
      error: error?.message || String(error),
    });
  });

  workerRef.on("completed", (job, result) => {
    nLog("[VERTEX_EXPERIMENTAL_JOB_COMPLETE]", {
      queue: env.vertexExperimentalQueue,
      workerIdentity: WORKER_IDENTITY,
      jobId: String(job?.id || ""),
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

main().catch((error) => {
  nLog("[VERTEX_WORKER_STARTUP_FAILURE]", {
    workerIdentity: WORKER_IDENTITY,
    error: (error as any)?.message || String(error),
  });
  process.exit(1);
});