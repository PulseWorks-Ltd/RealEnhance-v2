import { JOB_QUEUE_NAME } from "../../../shared/src/constants";

const DEFAULT_VERTEX_EXPERIMENTAL_QUEUE = "continuity-experimental";

export type VertexExperimentalEnv = {
  googleApplicationCredentialsJson: string;
  googleApplicationCredentials: string;
  googleCloudProject: string;
  googleCloudLocation: string;
  vertexGcsBucket: string;
  vertexExperimentalQueue: string;
  vertexContinuityGuidanceScale?: string;
  secondaryContinuityPlanner?: string;
  secondaryContinuityRenderer?: string;
  secondaryContinuityProvider?: string;
};

function readRequiredEnv(name: string): string {
  return String(process.env[name] || "").trim();
}

function readOptionalEnv(name: string): string | undefined {
  const value = String(process.env[name] || "").trim();
  return value || undefined;
}

export function getVertexExperimentalQueueName(): string {
  return String(process.env.VERTEX_EXPERIMENTAL_QUEUE || DEFAULT_VERTEX_EXPERIMENTAL_QUEUE).trim()
    || DEFAULT_VERTEX_EXPERIMENTAL_QUEUE;
}

export function validateVertexExperimentalEnv(): VertexExperimentalEnv {
  const env: VertexExperimentalEnv = {
    googleApplicationCredentialsJson: readRequiredEnv("GOOGLE_APPLICATION_CREDENTIALS_JSON"),
    googleApplicationCredentials: readRequiredEnv("GOOGLE_APPLICATION_CREDENTIALS"),
    googleCloudProject: readRequiredEnv("GOOGLE_CLOUD_PROJECT"),
    googleCloudLocation: readRequiredEnv("GOOGLE_CLOUD_LOCATION"),
    vertexGcsBucket: readRequiredEnv("VERTEX_GCS_BUCKET"),
    vertexExperimentalQueue: getVertexExperimentalQueueName(),
    vertexContinuityGuidanceScale: readOptionalEnv("VERTEX_CONTINUITY_GUIDANCE_SCALE"),
    secondaryContinuityPlanner: readOptionalEnv("SECONDARY_CONTINUITY_PLANNER"),
    secondaryContinuityRenderer: readOptionalEnv("SECONDARY_CONTINUITY_RENDERER"),
    secondaryContinuityProvider: readOptionalEnv("SECONDARY_CONTINUITY_PROVIDER"),
  };

  const missing: string[] = [];
  if (!env.googleApplicationCredentialsJson) missing.push("GOOGLE_APPLICATION_CREDENTIALS_JSON");
  if (!env.googleApplicationCredentials) missing.push("GOOGLE_APPLICATION_CREDENTIALS");
  if (!env.googleCloudProject) missing.push("GOOGLE_CLOUD_PROJECT");
  if (!env.googleCloudLocation) missing.push("GOOGLE_CLOUD_LOCATION");
  if (!env.vertexGcsBucket) missing.push("VERTEX_GCS_BUCKET");

  if (missing.length > 0) {
    throw new Error(`Missing required Vertex experimental worker env vars: ${missing.join(", ")}`);
  }

  if (env.vertexExperimentalQueue === JOB_QUEUE_NAME) {
    throw new Error(
      `VERTEX_EXPERIMENTAL_QUEUE must not match production queue ${JOB_QUEUE_NAME}`
    );
  }

  return env;
}