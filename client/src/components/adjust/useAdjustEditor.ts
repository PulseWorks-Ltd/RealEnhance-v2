// State and actions for "Adjust lighting & colour" (free slider edits).
// Used by AdjustControls (the sliders in the Edit Image left panel) and
// AdjustPreview (the live picture that replaces the mask canvas while open).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { autoTone, estimateStraighten } from "@/lib/adjust/auto";
import { fetchAdjustSource, saveAdjustedImage, type AdjustSaveResult, type AdjustSourceRef } from "@/lib/adjust/api";
import { planGeometry } from "@/lib/adjust/colour";
import { canRedo, canUndo, currentStep, pushStep, redo, startHistory, undo, type AdjustHistory } from "@/lib/adjust/history";
import { DEFAULT_ADJUST_PARAMS, adjustParamsEqual, isIdentityAdjust, type AdjustParams, type AdjustSliderKey } from "@/lib/adjust/params";
import { createAdjustRenderer, prepareAdjustSource, renderFullSizePng, type AdjustRenderer, type AdjustSource } from "@/lib/adjust/renderer";

export type AdjustLoadState = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "ready" };

function beforeParams(p: AdjustParams): AdjustParams {
  // "Before" keeps the geometry so the comparison lines up; only tone/colour revert.
  return { ...DEFAULT_ADJUST_PARAMS, rotate: p.rotate, straighten: p.straighten };
}

export function useAdjustEditor(sourceRef: AdjustSourceRef | null, enabled: boolean) {
  const { toast } = useToast();
  const [load, setLoad] = useState<AdjustLoadState>({ status: "idle" });
  const [history, setHistory] = useState<AdjustHistory>(() => startHistory(DEFAULT_ADJUST_PARAMS));
  // Live value while a slider is being dragged (committed to history on release).
  const [draft, setDraft] = useState<AdjustParams | null>(null);
  const [comparing, setComparing] = useState(false);
  const [splitView, setSplitView] = useState(false);
  const [split, setSplit] = useState(0.5);
  const [saving, setSaving] = useState(false);
  const [rendererKind, setRendererKind] = useState<"webgl2" | "cpu" | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });

  const src = useRef<AdjustSource | null>(null);
  const analysis = useRef<{ pixels: Uint8ClampedArray; width: number; height: number } | null>(null);
  const initial = useRef<AdjustParams>(DEFAULT_ADJUST_PARAMS);
  const stageEl = useRef<HTMLDivElement | null>(null);
  const canvasEl = useRef<HTMLCanvasElement | null>(null);
  const beforeCanvasEl = useRef<HTMLCanvasElement | null>(null);
  const renderer = useRef<AdjustRenderer | null>(null);
  const beforeRenderer = useRef<AdjustRenderer | null>(null);
  const frame = useRef<number | null>(null);

  const refKey = sourceRef ? `${sourceRef.sourceUrl}|${sourceRef.sourceImageId || ""}|${sourceRef.sourceJobId || ""}` : "";
  const stableRef = useMemo(() => sourceRef, [refKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const committed = currentStep(history);
  const params = draft || committed;
  const ready = load.status === "ready";
  const dirty = !adjustParamsEqual(committed, initial.current);
  const canSave = ready && !saving && !isIdentityAdjust(committed) && dirty;

  // ---- Load the photo once the panel is first opened (server returns the
  // clean parent + stored values when re-opening an adjusted version).
  const loadedKey = useRef<string>("");
  useEffect(() => {
    if (!enabled || !stableRef || loadedKey.current === refKey) return;
    const ctrl = new AbortController();
    let cancelled = false;
    src.current = null;
    analysis.current = null;
    setDraft(null);
    setLoad({ status: "loading" });
    (async () => {
      try {
        const { info, blob } = await fetchAdjustSource(stableRef, ctrl.signal);
        const prepared = await prepareAdjustSource(blob);
        if (cancelled) return;
        src.current = prepared.source;
        analysis.current = prepared.analysis;
        const start = info.adjustments || DEFAULT_ADJUST_PARAMS;
        initial.current = start;
        setHistory(startHistory(start));
        loadedKey.current = refKey;
        setLoad({ status: "ready" });
      } catch (err: any) {
        if (cancelled || err?.name === "AbortError") return;
        setLoad({ status: "error", message: err?.message || "Couldn't load the photo." });
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, stableRef]);

  // ---- Space available for the preview
  useEffect(() => {
    const el = stageEl.current;
    if (!enabled || !el) return;
    const ro = new ResizeObserver(() => setViewport({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setViewport({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [enabled, load.status]);

  // ---- Renderers (only while the panel is open)
  useEffect(() => {
    if (!enabled || !ready || !canvasEl.current || !src.current) return;
    const r = createAdjustRenderer(canvasEl.current, src.current);
    renderer.current = r;
    setRendererKind(r.kind);
    return () => {
      r.dispose();
      renderer.current = null;
    };
  }, [enabled, ready]);

  useEffect(() => {
    if (!enabled || !splitView || !ready || !beforeCanvasEl.current || !src.current) return;
    const r = createAdjustRenderer(beforeCanvasEl.current, src.current);
    beforeRenderer.current = r;
    return () => {
      r.dispose();
      beforeRenderer.current = null;
    };
  }, [enabled, splitView, ready]);

  const previewSize = useMemo(() => {
    const s = src.current;
    if (!s || viewport.w <= 0 || viewport.h <= 0) return null;
    const g = planGeometry(s.width, s.height, params);
    const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
    const fit = Math.min(viewport.w / g.outW, viewport.h / g.outH, 1 / dpr);
    const cssW = Math.max(1, Math.floor(g.outW * fit));
    const cssH = Math.max(1, Math.floor(g.outH * fit));
    return { cssW, cssH, pxW: Math.max(1, Math.round(cssW * dpr)), pxH: Math.max(1, Math.round(cssH * dpr)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, params.rotate, load.status]);

  useEffect(() => {
    if (!enabled || !previewSize || !renderer.current) return;
    if (frame.current != null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      try {
        renderer.current?.render(comparing ? beforeParams(params) : params, previewSize.pxW, previewSize.pxH);
        beforeRenderer.current?.render(beforeParams(params), previewSize.pxW, previewSize.pxH);
      } catch (err) {
        console.error("[adjust] render failed", err);
      }
    });
  }, [enabled, params, comparing, previewSize, rendererKind, splitView]);

  // ---- Actions
  const commit = useCallback((next: AdjustParams) => {
    setDraft(null);
    setHistory((h) => pushStep(h, next));
  }, []);

  const setSlider = (key: AdjustSliderKey, value: number) => setDraft({ ...(draft || committed), [key]: value });
  const commitSlider = (key: AdjustSliderKey, value: number) => commit({ ...(draft || committed), [key]: value });
  const resetSlider = (key: AdjustSliderKey) => commit({ ...committed, [key]: 0 });
  const resetAll = () => commit({ ...DEFAULT_ADJUST_PARAMS });
  const setRotate = (rotate: AdjustParams["rotate"]) => commit({ ...committed, rotate });

  const auto = () => {
    const a = analysis.current;
    if (a) commit({ ...committed, ...autoTone(a.pixels, a.width, a.height) });
  };

  const autoStraighten = () => {
    const a = analysis.current;
    if (!a) return;
    const value = estimateStraighten(a.pixels, a.width, a.height);
    commit({ ...committed, straighten: value });
    if (value === 0) toast({ title: "Already straight", description: "No noticeable tilt was found in this photo." });
  };

  const doUndo = useCallback(() => setHistory((h) => undo(h)), []);
  const doRedo = useCallback(() => setHistory((h) => redo(h)), []);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && (t as HTMLInputElement).type === "text"))) return;
      e.preventDefault();
      if (e.shiftKey) doRedo();
      else doUndo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, doRedo, doUndo]);

  /** Discard unsaved changes (closing the panel). */
  const discard = () => {
    setHistory(startHistory(initial.current));
    setDraft(null);
    setComparing(false);
    setSplitView(false);
  };

  const save = async (): Promise<AdjustSaveResult | null> => {
    const s = src.current;
    if (!s || !stableRef || !canSave) return null;
    setSaving(true);
    try {
      const png = await renderFullSizePng(s, committed);
      const result = await saveAdjustedImage(stableRef, png.blob, committed);
      toast({ title: "Photo saved", description: "Saved as a new version. Your original is unchanged." });
      initial.current = committed;
      return result;
    } catch (err: any) {
      toast({ title: "Couldn't save", description: err?.message || "Please try again.", variant: "destructive" });
      return null;
    } finally {
      setSaving(false);
    }
  };

  return {
    load,
    ready,
    params,
    committed,
    dirty,
    canSave,
    saving,
    rendererKind,
    comparing,
    setComparing,
    splitView,
    setSplitView,
    split,
    setSplit,
    previewSize,
    stageEl,
    canvasEl,
    beforeCanvasEl,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    undo: doUndo,
    redo: doRedo,
    setSlider,
    commitSlider,
    resetSlider,
    resetAll,
    setRotate,
    auto,
    autoStraighten,
    discard,
    save,
  };
}

export type AdjustEditor = ReturnType<typeof useAdjustEditor>;
