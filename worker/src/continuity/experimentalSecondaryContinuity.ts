import { randomUUID } from "crypto";
import { Queue, QueueEvents } from "bullmq";
import { bootstrapGoogleCredentialsFromEnv } from "../bootstrap/googleCredentials";
import { getVertexExperimentalQueueName } from "../bootstrap/envValidation";
import { nLog } from "../logger";
import { resolveGcsUri, resolveImageSource } from "../providers/imageTransport";
import type { ExperimentalSecondaryContinuityInput, VertexExperimentalContinuityJobPayload } from "./types";
import { VertexSecondaryContinuityError } from "./types";

const REDIS_URL = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || "redis://localhost:6379";
const DEFAULT_DISPATCH_TIMEOUT_MS = Math.max(60_000, Number(process.env.VERTEX_EXPERIMENTAL_DISPATCH_TIMEOUT_MS || 10 * 60 * 1000));

function buildContinuityQueueJobId(params: ExperimentalSecondaryContinuityInput): string {
  return [
    params.jobId,
    params.imageId,
    params.renderMode,
    String(params.attempt),
    randomUUID(),
  ]
    .map((part) => String(part).trim().replace(/[^a-zA-Z0-9_-]/g, "_"))
    .join("__");
}

async function ensureRemoteQueueImage(params: {
  sourceLabel: string;
  localPath: string;
  uri?: string | null;
  artifactName: string;
  jobId: string;
  imageId: string;
  continuityGroupId?: string | null;
}): Promise<string> {
  const resolved = await resolveImageSource({
    sourceLabel: params.sourceLabel,
    localPath: params.localPath,
    uri: params.uri,
    preferGcs: true,
    artifactName: params.artifactName,
    jobId: params.jobId,
    imageId: params.imageId,
    continuityGroupId: params.continuityGroupId,
  });

  if (resolved.kind === "gcs" && resolved.uri) {
    return resolved.uri;
  }

  throw new VertexSecondaryContinuityError(
    `${params.sourceLabel} must resolve to a persisted gs:// URI before dispatch to the vertex continuity worker`,
    "continuity_remote_uri_required"
  );
}

async function bootstrapQueueDispatchCredentialsIfNeeded(params: ExperimentalSecondaryContinuityInput): Promise<void> {
  const requiresSecondaryUpload = !resolveGcsUri(params.secondaryImageUri);
  const requiresMasterUpload = !resolveGcsUri(params.masterImageUri);

  if (!requiresSecondaryUpload && !requiresMasterUpload) {
    return;
  }

  const authBootstrap = await bootstrapGoogleCredentialsFromEnv();
  nLog("[CONTINUITY_PRODUCER_AUTH_READY]", {
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    renderMode: params.renderMode,
    credentialsPath: authBootstrap.credentialsPath,
    fileExists: authBootstrap.fileExists,
    bootstrapMs: authBootstrap.bootstrapMs,
    requiresSecondaryUpload,
    requiresMasterUpload,
  });
}

export async function runExperimentalSecondaryContinuity(params: ExperimentalSecondaryContinuityInput): Promise<string> {
  const queueName = params.queueName || getVertexExperimentalQueueName();
  const workerIdentity = process.env.WORKER_ROLE || "worker";
  const executionAuthority = "main-worker";
  const dispatchTarget = "worker-vertex-experimental";
  const provider = String(process.env.SECONDARY_CONTINUITY_PROVIDER || "vertex").trim().toLowerCase();
  const stage2Mode = params.intent?.promptScope || null;
  const queue = new Queue(queueName, {
    connection: { url: REDIS_URL },
  });
  const queueEvents = new QueueEvents(queueName, {
    connection: { url: REDIS_URL },
  });

  try {
    await queueEvents.waitUntilReady();

    nLog("[CONTINUITY_JOB_PRODUCER]", {
      continuityGroupId: params.continuityGroupId || null,
      imageId: params.imageId,
      jobId: params.jobId,
      renderMode: params.renderMode,
      queueName,
      workerIdentity,
      executionAuthority,
      executionMode: "queue-producer",
      dispatchTarget,
      provider,
      stage2Mode,
    });

    nLog("[CONTINUITY_QUEUE_NAME]", {
      continuityGroupId: params.continuityGroupId || null,
      imageId: params.imageId,
      jobId: params.jobId,
      renderMode: params.renderMode,
      queueName,
      workerIdentity,
      executionAuthority,
      executionMode: "queue-producer",
      dispatchTarget,
      provider,
      stage2Mode,
    });

    nLog("[SECONDARY_CONTINUITY_DISPATCH]", {
      continuityGroupId: params.continuityGroupId || null,
      imageId: params.imageId,
      jobId: params.jobId,
      renderMode: params.renderMode,
      queueName,
      workerIdentity,
      operationLabel: params.intent?.operationLabel || null,
      promptScope: params.intent?.promptScope || null,
    });

    await bootstrapQueueDispatchCredentialsIfNeeded(params);

    const secondaryImageUri = await ensureRemoteQueueImage({
      sourceLabel: "secondary-continuity-source",
      localPath: params.secondaryImagePath,
      uri: params.secondaryImageUri,
      artifactName: `${params.imageId}-secondary-source${params.attempt}.webp`,
      jobId: params.jobId,
      imageId: params.imageId,
      continuityGroupId: params.continuityGroupId,
    });
    const masterImageUri = await ensureRemoteQueueImage({
      sourceLabel: "secondary-continuity-master",
      localPath: params.masterImagePath,
      uri: params.masterImageUri,
      artifactName: `${params.imageId}-approved-master${params.attempt}.webp`,
      jobId: params.jobId,
      imageId: params.imageId,
      continuityGroupId: params.continuityGroupId,
    });

    const payload: VertexExperimentalContinuityJobPayload = {
      type: "vertex-continuity-experimental",
      requestedAt: new Date().toISOString(),
      ...params,
      secondaryImageUri,
      masterImageUri,
      queueName,
      workerIdentity,
    };
    const dispatchedJob = await queue.add("vertex-continuity-experimental", payload, {
      jobId: buildContinuityQueueJobId(params),
      removeOnComplete: 50,
      removeOnFail: 50,
    });

    nLog("[CONTINUITY_QUEUE_ADD]", {
      continuityGroupId: params.continuityGroupId || null,
      imageId: params.imageId,
      jobId: params.jobId,
      renderMode: params.renderMode,
      queueName,
      workerIdentity,
      executionAuthority,
      executionMode: "queue-producer",
      dispatchTarget,
      provider,
      stage2Mode,
      queueJobId: String(dispatchedJob.id || ""),
    });

    nLog("[SECONDARY_CONTINUITY_QUEUE]", {
      continuityGroupId: params.continuityGroupId || null,
      imageId: params.imageId,
      jobId: params.jobId,
      renderMode: params.renderMode,
      queueName,
      queueJobId: String(dispatchedJob.id || ""),
      workerIdentity,
      status: "enqueued",
    });

    const result = await dispatchedJob.waitUntilFinished(queueEvents, DEFAULT_DISPATCH_TIMEOUT_MS) as Record<string, unknown>;
    const outputPath = String(result?.outputPath || "").trim() || params.outputPath;

    nLog("[CONTINUITY_RESULT_RETURNED]", {
      continuityGroupId: params.continuityGroupId || null,
      imageId: params.imageId,
      jobId: params.jobId,
      renderMode: params.renderMode,
      queueName,
      workerIdentity,
      executionAuthority,
      executionMode: "orchestrator-await",
      dispatchTarget,
      provider,
      stage2Mode,
      resultWorkerIdentity: String(result?.workerIdentity || dispatchTarget),
      outputPath,
    });

    nLog("[VERTEX_CONTINUITY_RESULT]", {
      continuityGroupId: params.continuityGroupId || null,
      imageId: params.imageId,
      jobId: params.jobId,
      renderMode: params.renderMode,
      queueName,
      workerIdentity: String(result?.workerIdentity || params.workerIdentity || "worker-vertex-experimental"),
      outputPath,
      result: result?.ok === true ? "success" : "unknown",
      plannerVersion: result?.planner || null,
      rendererVersion: result?.renderer || null,
    });

    return outputPath;
  } catch (error: any) {
    const fallbackReason = error instanceof VertexSecondaryContinuityError
      ? error.fallbackReason
      : "vertex_secondary_continuity_error";
    nLog("[CONTINUITY_DISPATCH_FAILURE]", {
      continuityGroupId: params.continuityGroupId || null,
      imageId: params.imageId,
      jobId: params.jobId,
      renderMode: params.renderMode,
      queueName,
      workerIdentity,
      executionAuthority,
      executionMode: "queue-producer",
      dispatchTarget,
      provider,
      stage2Mode,
      error: String(error?.message || error),
      fallbackReason,
    });
    nLog("[VERTEX_CONTINUITY_FAILURE]", {
      continuityGroupId: params.continuityGroupId || null,
      imageId: params.imageId,
      jobId: params.jobId,
      renderMode: params.renderMode,
      queueName,
      workerIdentity,
      fallbackReason,
      error: String(error?.message || error),
    });
    if (error instanceof VertexSecondaryContinuityError) {
      throw error;
    }
    throw new VertexSecondaryContinuityError(
      String(error?.message || error || "vertex secondary continuity failed"),
      fallbackReason
    );
  } finally {
    await queue.close().catch(() => {});
    await queueEvents.close().catch(() => {});
  }
}