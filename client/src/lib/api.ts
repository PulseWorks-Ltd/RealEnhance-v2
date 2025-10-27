// client/src/lib/api.ts
const API_BASE =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

// unified fetch with credentials + headers
export async function apiFetch(path: string, opts: RequestInit = {}) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...opts,
    credentials: "include", // keep session cookie
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  return res;
}

// simple JSON wrapper
export async function apiGet<T = any>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

export const clientApi = {
  request: async <T>(path: string, opts: RequestInit = {}) => {
    const res = await apiFetch(path, opts);
    if (!res.ok) throw new Error(await res.text());
    return res.json() as Promise<T>;
  },
};

export default clientApi;
