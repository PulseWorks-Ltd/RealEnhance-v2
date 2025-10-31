// client/src/lib/api.ts
const rawBase =
  (import.meta as any).env?.VITE_API_BASE_URL ||
  (typeof window !== "undefined" ? `${window.location.origin}` : "http://localhost:5000");

const API_BASE = rawBase.replace(/\/+$/, ""); // strip trailing slash

function joinUrl(base: string, path: string) {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

export function api(path: string) {
  return joinUrl(API_BASE, path);
}

export async function apiFetch(path: string, opts: RequestInit = {}) {
  const res = await fetch(api(path), {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  return res;
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
    if (!res.ok) {
      const msg = await res.text().catch(() => `${res.status} ${res.statusText}`);
      throw Object.assign(new Error(msg), { code: res.status });
    }
    const ct = res.headers.get("content-type") || "";
    return (ct.includes("application/json") ? res.json() : res.text()) as Promise<T>;
  },
};

export default clientApi;
