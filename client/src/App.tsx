const API_BASE =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

export function api(path: string) {
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function apiFetch(path: string, opts: RequestInit = {}) {
  const res = await fetch(api(path), {
    ...opts,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  return res;
}

export async function apiGet<T = any>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status}`);
  }
  return res.json();
}

async function request<T>(path: string, opts: RequestInit = {}) {
  const res = await apiFetch(path, opts);
  if (!res.ok) {
    throw Object.assign(new Error(await res.text()), {
      code: res.status
    });
  }
  return res.json() as Promise<T>;
}

export const clientApi = {
  request
};


export default clientApi;
