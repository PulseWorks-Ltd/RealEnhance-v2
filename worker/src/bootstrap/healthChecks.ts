import { Storage } from "@google-cloud/storage";
import { nLog } from "../logger";
import { getVertexGenAiClient } from "../providers/vertex/adc";

function resolveVertexConnectivityModel(): string {
  return String(process.env.VERTEX_CONNECTIVITY_MODEL || "gemini-2.5-flash").trim() || "gemini-2.5-flash";
}

export async function runVertexConnectivityTest(params: {
  project: string;
  location: string;
}): Promise<{ model: string; latencyMs: number; sdkInitialized: boolean }> {
  const startedAt = Date.now();
  const model = resolveVertexConnectivityModel();
  let sdkInitialized = false;
  nLog("[VERTEX_CONNECTIVITY_TEST]", {
    project: params.project,
    region: params.location,
    model,
    sdkInitialized,
  });

  try {
    const ai = getVertexGenAiClient();
    sdkInitialized = true;
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: "Reply with OK." }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 8,
      },
    } as any);

    const text = (response?.candidates?.[0]?.content?.parts || [])
      .map((part: any) => String(part?.text || ""))
      .join("")
      .trim();

    if (!text) {
      throw new Error("vertex_connectivity_empty_response");
    }

    const latencyMs = Date.now() - startedAt;
    nLog("[VERTEX_CONNECTIVITY_SUCCESS]", {
      project: params.project,
      region: params.location,
      model,
      latencyMs,
      sdkInitialized,
    });

    return { model, latencyMs, sdkInitialized };
  } catch (error: any) {
    const latencyMs = Date.now() - startedAt;
    nLog("[VERTEX_CONNECTIVITY_FAILURE]", {
      project: params.project,
      region: params.location,
      model,
      latencyMs,
      sdkInitialized,
      error: error?.message || String(error),
    });
    throw error;
  }
}

export async function runGcsHealthcheck(params: {
  project: string;
  bucket: string;
}): Promise<{ objectPath: string; uploadLatencyMs: number; readLatencyMs: number }> {
  const storage = new Storage({ projectId: params.project });
  const bucket = storage.bucket(params.bucket);
  const objectPath = `healthcheck/${Date.now()}-${process.pid}.json`;
  const payload = Buffer.from(JSON.stringify({ ok: true, ts: new Date().toISOString() }), "utf8");

  nLog("[GCS_HEALTHCHECK]", {
    bucket: params.bucket,
    objectPath,
  });

  try {
    const uploadStartedAt = Date.now();
    await bucket.file(objectPath).save(payload, {
      resumable: false,
      contentType: "application/json",
      metadata: {
        cacheControl: "no-store",
      },
    });
    const uploadLatencyMs = Date.now() - uploadStartedAt;

    const readStartedAt = Date.now();
    const [downloaded] = await bucket.file(objectPath).download();
    const readLatencyMs = Date.now() - readStartedAt;

    if (downloaded.length !== payload.length) {
      throw new Error("gcs_healthcheck_payload_mismatch");
    }

    nLog("[GCS_HEALTHCHECK_SUCCESS]", {
      bucket: params.bucket,
      objectPath,
      uploadLatencyMs,
      readLatencyMs,
    });

    return { objectPath, uploadLatencyMs, readLatencyMs };
  } catch (error: any) {
    nLog("[GCS_HEALTHCHECK_FAILURE]", {
      bucket: params.bucket,
      objectPath,
      error: error?.message || String(error),
    });
    throw error;
  } finally {
    await bucket.file(objectPath).delete({ ignoreNotFound: true }).catch(() => {});
  }
}