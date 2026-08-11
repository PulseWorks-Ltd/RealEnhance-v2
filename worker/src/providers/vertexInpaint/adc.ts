import { GoogleGenAI } from "@google/genai";
import { VertexAuthError } from "./types";

// Ported from feature/vertex-secondary-inpainting-continuity's
// worker/src/providers/vertex/adc.ts, stripped of the continuity worker's
// credentials-file-on-disk bootstrap requirement — this experimental provider
// runs inline in the normal Stage 2 worker, not a separate
// worker-vertex-experimental process, so it relies on whatever ADC mechanism
// (GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_APPLICATION_CREDENTIALS_JSON /
// metadata-server ADC) the environment already provides.

let vertexClient: GoogleGenAI | null = null;

export function getVertexProjectConfig(): { project: string; location: string } {
  const project = String(process.env.GOOGLE_CLOUD_PROJECT || "").trim();
  const location = String(process.env.GOOGLE_CLOUD_LOCATION || "us-central1").trim();
  if (!project) {
    throw new VertexAuthError(
      "GOOGLE_CLOUD_PROJECT is required for Vertex AI (mask-inpainting experimental provider)",
      "vertex_missing_project"
    );
  }
  return { project, location };
}

export function getVertexGenAiClient(): GoogleGenAI {
  if (vertexClient) {
    return vertexClient;
  }
  const { project, location } = getVertexProjectConfig();
  vertexClient = new GoogleGenAI({
    vertexai: true,
    project,
    location,
  });
  return vertexClient;
}

// Test-only: allows tests to force a fresh client after resetting modules/env.
export function __resetVertexClientForTests(): void {
  vertexClient = null;
}
