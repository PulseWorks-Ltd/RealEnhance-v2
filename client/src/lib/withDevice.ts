// client/src/lib/withDevice.ts
export function withDevice(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers || {});
  const id = localStorage.getItem("deviceId");
  if (id) headers.set("x-device-id", id);
  return { ...init, headers };
}