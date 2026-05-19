import { existsSync } from "fs";
import { GoogleGenAI } from "@google/genai";
import { assertGoogleCredentialsFileReadySync, getGoogleCredentialsPath } from "../../bootstrap/googleCredentials";
import { nLog } from "../../logger";
import { VertexSecondaryContinuityError } from "../../continuity/types";

let vertexClient: GoogleGenAI | null = null;

export function getVertexProjectConfig(): { project: string; location: string } {
  const project = String(process.env.GOOGLE_CLOUD_PROJECT || "").trim();
  const location = String(process.env.GOOGLE_CLOUD_LOCATION || "us-central1").trim();
  if (!project) {
    throw new VertexSecondaryContinuityError(
      "GOOGLE_CLOUD_PROJECT is required for Vertex AI ADC execution",
      "missing_vertex_project"
    );
  }
  return { project, location };
}

export function getVertexGenAiClient(): GoogleGenAI {
  if (vertexClient) {
    return vertexClient;
  }
  const { project, location } = getVertexProjectConfig();
  const credentialsPath = getGoogleCredentialsPath();
  if (String(process.env.WORKER_ROLE || "").trim() === "worker-vertex-experimental") {
    assertGoogleCredentialsFileReadySync(credentialsPath);
  }
  if (process.env.GEMINI_API_KEY || process.env.REALENHANCE_API_KEY || process.env.GOOGLE_API_KEY) {
    nLog("[VERTEX_CONTINUITY_AUTH]", {
      authMode: "adc",
      apiKeysDetectedIgnored: true,
      credentialsPath,
      credentialsFileExists: existsSync(credentialsPath),
      project,
      location,
    });
  } else {
    nLog("[VERTEX_CONTINUITY_AUTH]", {
      authMode: "adc",
      apiKeysDetectedIgnored: false,
      credentialsPath,
      credentialsFileExists: existsSync(credentialsPath),
      project,
      location,
    });
  }
  vertexClient = new GoogleGenAI({
    vertexai: true,
    project,
    location,
  });
  return vertexClient;
}