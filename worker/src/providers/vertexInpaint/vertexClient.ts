import { getVertexGenAiClient, getVertexProjectConfig } from "./adc";
import { VertexApiError } from "./types";
import type { VertexEditPredictPayload, VertexWireImagePayload } from "./types";

// Raw REST Vertex Imagen call, per the proven contract in
// VERTEX_INPAINTING_INVESTIGATION.md §3 / §22 — the @google/genai SDK does not
// expose a typed method for reference-image editing, so this deliberately
// uses `(ai as any).apiClient.request()` against the publisher model
// `:predict` endpoint, exactly as the continuity branch's ~97-commit contract
// discovery found necessary. Do not replace this with an assumed SDK call.

const VERTEX_IMAGEN_MODEL = String(
  process.env.VERTEX_INPAINT_MODEL || "imagen-3.0-capability-001"
).trim();

const VERTEX_REQUEST_TIMEOUT_MS = 120000;

export function getVertexImagenModel(): string {
  return VERTEX_IMAGEN_MODEL;
}

function resolveModelResource(model: string): string {
  const { project, location } = getVertexProjectConfig();
  return `projects/${project}/locations/${location}/publishers/google/models/${model}`;
}

// Required shape per §3: source and mask are both entries in ONE
// referenceImages array (not top-level image/mask fields), maskMode is
// exactly "MASK_MODE_USER_PROVIDED", editMode is exactly
// "EDIT_MODE_INPAINT_INSERTION" (never silently substituted with
// EDIT_MODE_DEFAULT — §11), maskDilation is 0, numberOfImages is 1.
export function buildVertexInpaintPredictPayload(params: {
  prompt: string;
  sourcePayload: VertexWireImagePayload;
  maskPayload: VertexWireImagePayload;
}): VertexEditPredictPayload {
  return {
    instances: [
      {
        prompt: params.prompt,
        referenceImages: [
          {
            referenceId: 1,
            referenceType: "REFERENCE_TYPE_RAW",
            referenceImage: params.sourcePayload,
          },
          {
            referenceId: 2,
            referenceType: "REFERENCE_TYPE_MASK",
            referenceImage: params.maskPayload,
            maskImageConfig: {
              maskMode: "MASK_MODE_USER_PROVIDED",
              maskDilation: 0,
            },
          },
        ],
      },
    ],
    parameters: {
      editMode: "EDIT_MODE_INPAINT_INSERTION",
      numberOfImages: 1,
    },
  };
}

function extractGeneratedImage(response: any): { imageBytes: string; mimeType: string } {
  const prediction = response?.predictions?.[0] || response?.generatedImages?.[0] || null;
  const imageBytes = prediction?.bytesBase64Encoded || prediction?.image?.bytesBase64Encoded || prediction?.image?.imageBytes;
  const mimeType = prediction?.mimeType || prediction?.image?.mimeType || "image/png";
  if (!imageBytes || typeof imageBytes !== "string") {
    throw new VertexApiError(
      "Vertex Imagen response did not include image bytes",
      "vertex_response_missing_image",
      undefined,
      JSON.stringify(response).slice(0, 2000)
    );
  }
  return { imageBytes, mimeType };
}

export async function predictInpaint(
  payload: VertexEditPredictPayload,
  jobId: string,
  imageId: string
): Promise<{ imageBytes: string; mimeType: string }> {
  const ai = getVertexGenAiClient();
  const endpoint = `${resolveModelResource(VERTEX_IMAGEN_MODEL)}:predict`;
  const serializedPayload = JSON.stringify(payload);

  console.log("[STAGE2_VERTEX_INPAINT] vertex_request", {
    jobId,
    imageId,
    model: VERTEX_IMAGEN_MODEL,
    endpoint,
    editMode: payload.parameters.editMode,
    maskMode: payload.instances[0]?.referenceImages?.[1]?.maskImageConfig?.maskMode,
    maskDilation: payload.instances[0]?.referenceImages?.[1]?.maskImageConfig?.maskDilation,
    numberOfImages: payload.parameters.numberOfImages,
    payloadBytes: Buffer.byteLength(serializedPayload, "utf8"),
  });

  let rawResponse: any;
  try {
    const apiClient = (ai as any).apiClient;
    rawResponse = await apiClient
      .request({
        path: endpoint,
        body: serializedPayload,
        httpMethod: "POST",
        httpOptions: { timeout: VERTEX_REQUEST_TIMEOUT_MS },
      })
      .then((response: any) => response.json());
  } catch (err: any) {
    const status = err?.status || err?.response?.status;
    throw new VertexApiError(
      `Vertex Imagen predict call failed: ${err?.message || err}`,
      "vertex_predict_call_failed",
      status,
      typeof err?.body === "string" ? err.body.slice(0, 2000) : undefined
    );
  }

  return extractGeneratedImage(rawResponse);
}
