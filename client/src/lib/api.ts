/* client/src/lib/api.ts
 * Unified API helper used by the client.
 * - Named export: clientApi  ✅
 * - Type export:  HealthResponse ✅
 * - Default export maintained for legacy imports (exports clientApi)
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export type HealthResponse = {
  ok: boolean;
  env: "production" | "development" | string;
  time: string;
  origin?: string;
  version?: string;
};

type ApiOptions = {
  baseUrl?: string;            // override base, mainly for tests
  headers?: Record<string, string>;
};

type FetchOpts = {
  method?: HttpMethod;
  body?: BodyInit | null;
  headers?: Record<string, string>;
  expect?: "json" | "blob" | "text";
  signal?: AbortSignal;
};

function joinUrl(base: string, path: string) {
  if (!base) return path;
  if (path.startsWith("http")) return path;
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function safeHeaders(extra?: Record<string, string>) {
  const h: Record<string, string> = {
    Accept: "application/json",
    ...(extra ?? {}),
  };
  // Note: don't set Content-Type when sending FormData (browser will set boundary)
  return h;
}

export function createApi(options: ApiOptions = {}) {
  const base = options.baseUrl ?? ""; // use same origin by default
  const defaultHeaders = options.headers ?? {};

  async function request<T = any>(
    url: string,
    opts: FetchOpts = {}
  ): Promise<T> {
    const full = joinUrl(base, url);
    const { expect = "json", method = "GET", body, signal } = opts;

    const hasForm =
      typeof FormData !== "undefined" && body instanceof FormData;

    const res = await fetch(full, {
      method,
      body,
      signal,
      headers: hasForm
        ? safeHeaders(defaultHeaders) // let browser set multipart boundary
        : safeHeaders({ "Content-Type": "application/json", ...defaultHeaders, ...(opts.headers ?? {}) }),
      credentials: "include",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
    }

    if (expect === "blob") return (await res.blob()) as any;
    if (expect === "text") return (await res.text()) as any;
    return (await res.json()) as T;
  }

  // ---------- Public endpoints ----------

  /** Simple connectivity / status check */
  function health() {
    return request<HealthResponse>("/api/health");
  }

  /** Return server version string */
  function version() {
    return request<{ version: string }>("/api/version");
  }

  /** Upload a single image to enhance immediately */
  function enhanceOne(file: Blob, presetKey?: string) {
    const form = new FormData();
    form.append("image", file, "upload.png");
    if (presetKey) form.append("presetKey", presetKey);
    return request<{ ok: boolean; jobId: string }>("/api/enhance", {
      method: "POST",
      body: form,
    });
  }

  /** Inpaint region endpoint */
  async function inpaintRegion(payload: {
    imageUrl: string;
    payload_bbox: { x: number; y: number; w: number; h: number };
    mode: string;
    maskPNG: Blob;
  }) {
    const form = new FormData();
    form.append("imageUrl", payload.imageUrl);
    form.append("bbox", JSON.stringify(payload.payload_bbox));
    form.append("mode", payload.mode);
    form.append("mask", payload.maskPNG, "mask.png");

    const blob = await request<Blob>("/api/enhance/inpaint", {
      method: "POST",
      body: form,
      expect: "blob",
    });
    return { patchPNG: blob };
  }

  /** Start a batch of images (returns job ids) */
  function startBatch(images: Blob[], presetKey?: string) {
    const form = new FormData();
    images.forEach((img, i) => form.append("images", img, `image_${i}.png`));
    if (presetKey) form.append("presetKey", presetKey);
    return request<{ ok: boolean; jobIds: string[] }>("/api/batch/start", {
      method: "POST",
      body: form,
    });
  }

  /** Poll a single job status */
  function jobStatus(jobId: string) {
    return request<{ status: "queued" | "running" | "done" | "error"; resultId?: string; error?: string }>(
      `/api/batch/status/${encodeURIComponent(jobId)}`
    );
  }

  /** Fetch an image result (blob) */
  function fetchResult(resultId: string) {
    return request<Blob>(`/api/enhance/result/${encodeURIComponent(resultId)}`, {
      expect: "blob",
    });
  }

  /** Save an edit to an enhanced image (for undo/redo stacks on client) */
  function saveEdit(resultId: string, editedPNG: Blob) {
    const form = new FormData();
    form.append("image", editedPNG, "edit.png");
    return request<{ ok: boolean }>(
      `/api/enhance/result/${encodeURIComponent(resultId)}/edit`,
      { method: "POST", body: form }
    );
  }

  return {
    request,
    health,
    version,
    enhanceOne,
    inpaintRegion,
    startBatch,
    jobStatus,
    fetchResult,
    saveEdit,
  };
}

// Create the default client used across the app
export const clientApi = createApi();

// Keep default export for legacy imports: `import api from "./lib/api"`
export default clientApi;

/* --- Back-compat layer: apiFetch + api.{get,post,put,delete} --- */

export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  // Plain fetch with cookies and JSON default accept header
  const headers = {
    Accept: "application/json",
    ...(init.headers || {}),
  } as Record<string, string>;
  return fetch(input, {
    credentials: "include",
    ...init,
    headers,
  });
}

export const api = {
  get: (url: string, init?: RequestInit) =>
    apiFetch(url, { ...init, method: "GET" }),

  delete: (url: string, init?: RequestInit) =>
    apiFetch(url, { ...init, method: "DELETE" }),

  post: (url: string, body?: unknown, init?: RequestInit) =>
    apiFetch(url, {
      ...init,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),

  put: (url: string, body?: unknown, init?: RequestInit) =>
    apiFetch(url, {
      ...init,
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
};