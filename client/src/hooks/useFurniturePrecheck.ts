// Furniture pre-check: as soon as photos are added (with staging
// switched on), a small preview of each is sent to the server, where the same
// furniture detector the pipeline uses decides whether the room needs decluttering.
// By the time the user clicks Process the answer is usually back, so the
// exact cost can be shown: a room that needs decluttering = declutter + stage =
// 2 credits, a room ready to stage = 1. The server reserves the same amount using the
// same stored answer. See server/src/routes/furniturePrecheck.ts.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { withDevice } from "@/lib/withDevice";

export type FurniturePrecheckEntry = {
  precheckId?: string;
  status: "uploading" | "pending" | "done" | "failed" | "missing";
  // requiresDeclutter per normalised room type ("" = room type not set)
  decisions?: Record<string, boolean | null>;
};

// Same normalisation as the server and worker.
export function normalizePrecheckRoomType(roomType: unknown): string {
  const normalized = String(roomType || "").toLowerCase().replace(/-/g, "_").trim();
  return normalized === "multiple_living_areas" || normalized === "multiple_living" ? "kitchen_living_dining" : normalized;
}

const ROOM_TYPE_ALIASES: Record<string, string> = {
  living: "living_room",
  dining: "dining_room",
};

/** true = furnished (declutter before staging), false = empty, null = not known yet / check failed. */
export function precheckRequiresDeclutter(entry: FurniturePrecheckEntry | undefined, roomType: unknown): boolean | null {
  if (!entry || entry.status !== "done" || !entry.decisions) return null;
  let key = normalizePrecheckRoomType(roomType);
  key = ROOM_TYPE_ALIASES[key] || key;
  if (/^bedroom_\d+$/.test(key)) key = "bedroom";
  const value = key in entry.decisions ? entry.decisions[key] : entry.decisions[""];
  return typeof value === "boolean" ? value : null;
}

const PREVIEW_MAX_SIDE = 1024;
const MAX_PARALLEL_UPLOADS = 3;
const POLL_MS = 2000;

async function makePreviewDataUrl(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  if (typeof (bmp as any).close === "function") (bmp as any).close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

export function useFurniturePrecheck(params: {
  files: File[];
  getFileId: (file: File) => string;
  enabled: boolean;
  /** Photos known to be exteriors are not checked. */
  isExterior: (imageId: string) => boolean;
}) {
  const { files, getFileId, enabled, isExterior } = params;
  const [entries, setEntries] = useState<Record<string, FurniturePrecheckEntry>>({});
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const inFlightRef = useRef(0);
  const queueRef = useRef<Array<{ imageId: string; file: File }>>([]);

  const update = useCallback((imageId: string, patch: FurniturePrecheckEntry) => {
    setEntries((prev) => ({ ...prev, [imageId]: { ...prev[imageId], ...patch } }));
  }, []);

  const pump = useCallback(() => {
    while (inFlightRef.current < MAX_PARALLEL_UPLOADS && queueRef.current.length) {
      const next = queueRef.current.shift()!;
      inFlightRef.current += 1;
      (async () => {
        try {
          const image = await makePreviewDataUrl(next.file);
          const res = await fetch(api("/api/precheck/furniture"), withDevice({
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image }),
          }));
          if (!res.ok) throw new Error(`precheck ${res.status}`);
          const json = await res.json();
          update(next.imageId, { status: "pending", precheckId: String(json.precheckId || "") });
        } catch (err) {
          console.warn("[FURNITURE_PRECHECK] could not start", { imageId: next.imageId, err });
          update(next.imageId, { status: "failed" });
        } finally {
          inFlightRef.current -= 1;
          pump();
        }
      })();
    }
  }, [update]);

  // Start a check for each new interior photo once staging/declutter is on.
  useEffect(() => {
    if (!enabled) return;
    for (const file of files) {
      const imageId = getFileId(file);
      if (entriesRef.current[imageId] || isExterior(imageId)) continue;
      if (queueRef.current.some((q) => q.imageId === imageId)) continue;
      entriesRef.current = { ...entriesRef.current, [imageId]: { status: "uploading" } };
      setEntries((prev) => ({ ...prev, [imageId]: { status: "uploading" } }));
      queueRef.current.push({ imageId, file });
    }
    pump();
  }, [enabled, files, getFileId, isExterior, pump]);

  // Forget photos that were removed.
  useEffect(() => {
    const ids = new Set(files.map((f) => getFileId(f)));
    setEntries((prev) => {
      const stale = Object.keys(prev).filter((id) => !ids.has(id));
      if (!stale.length) return prev;
      const copy = { ...prev };
      for (const id of stale) delete copy[id];
      return copy;
    });
  }, [files, getFileId]);

  const pollOnce = useCallback(async () => {
    const pending = Object.entries(entriesRef.current).filter(([, e]) => e.status === "pending" && e.precheckId);
    if (!pending.length) return;
    try {
      const ids = pending.map(([, e]) => e.precheckId).join(",");
      const res = await fetch(api(`/api/precheck/furniture?ids=${encodeURIComponent(ids)}`), withDevice({ credentials: "include" }));
      if (!res.ok) return;
      const json = await res.json();
      const results = (json?.results || {}) as Record<string, { status: string; decisions?: Record<string, boolean | null> }>;
      setEntries((prev) => {
        const copy = { ...prev };
        for (const [imageId, entry] of pending) {
          const r = results[entry.precheckId!];
          if (!r || r.status === "pending") continue;
          copy[imageId] = {
            ...copy[imageId],
            status: r.status === "done" ? "done" : r.status === "missing" ? "missing" : "failed",
            decisions: r.decisions,
          };
        }
        entriesRef.current = copy;
        return copy;
      });
    } catch {
      // keep polling
    }
  }, []);

  const hasPending = Object.values(entries).some((e) => e.status === "pending" || e.status === "uploading");
  useEffect(() => {
    if (!hasPending) return;
    const t = setInterval(() => { void pollOnce(); }, POLL_MS);
    return () => clearInterval(t);
  }, [hasPending, pollOnce]);

  /** Wait (up to timeoutMs) until the given photos' checks have finished. */
  const waitFor = useCallback(async (imageIds: string[], timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const unfinished = imageIds.filter((id) => {
        const s = entriesRef.current[id]?.status;
        return s === "pending" || s === "uploading";
      });
      if (!unfinished.length || Date.now() >= deadline) return entriesRef.current;
      await pollOnce();
      await new Promise((r) => setTimeout(r, 1000));
    }
  }, [pollOnce]);

  return { entries, waitFor };
}
