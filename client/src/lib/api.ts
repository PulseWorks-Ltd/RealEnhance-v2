// client/src/lib/api.ts
// Prefer build-time API base; otherwise, if we're on the deployed client domain, force the server URL.
const rawBase =
  (import.meta as any).env?.VITE_API_BASE_URL ||
  (typeof window !== "undefined" && window.location.hostname.includes("client-production-3021.up.railway.app")
    ? "https://server-production-96f7.up.railway.app"
    : typeof window !== "undefined"
      ? `${window.location.origin}`
      : "http://localhost:5000");

const API_BASE = rawBase.replace(/\/+$/, ""); // strip trailing slash

function joinUrl(base: string, path: string) {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

function withTimeout(ms: number) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(id) };
}

class ApiError extends Error {
  status: number; path: string; body?: string;
  constructor(msg: string, status: number, path: string, body?: string) {
    super(msg); this.status = status; this.path = path; this.body = body;
  }
}

export function api(path: string) {
  return joinUrl(API_BASE, path);
}

export async function apiFetch(path: string, opts: RequestInit = {}, timeoutMs = 30_000) {
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(api(path), {
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      signal: t.signal,
      ...opts,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`API ${res.status} ${path}:`, body);
      throw new ApiError(body || `Request failed`, res.status, path, body);
    }
    return res;
  } finally {
    t.done();
  }
}

export async function apiFetchSoft(path: string, opts: RequestInit = {}, timeoutMs = 30_000) {
  const t = withTimeout(timeoutMs);
  try {
    // identical to apiFetch but no throw on !ok
    return await fetch(api(path), {
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      signal: t.signal,
      ...opts,
    });
  } finally {
    t.done();
  }
}

export async function apiJson<T = unknown>(path: string, opts: RequestInit = {}) {
  const res = await apiFetch(path, opts);
  const ct = res.headers.get("content-type") || "";
  return (ct.includes("application/json") ? res.json() : res.text()) as Promise<T>;
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? ((await res.json()) as T) : ((await res.text()) as unknown as T);
}

export const clientApi = {
  request: async <T>(path: string, opts: RequestInit = {}) => {
    const res = await apiFetch(path, opts);
    // Log the body on error so it doesn’t crash the render path silently
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`API ${res.status} ${path}:`, body);
      throw new Error(body || `Request failed: ${res.status}`);
    }
    return res.json() as Promise<T>;
  },
};

export default clientApi;
