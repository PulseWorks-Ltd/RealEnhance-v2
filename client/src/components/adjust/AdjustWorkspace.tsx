// Photo Adjust workspace: free, instant, Lightroom-style sliders applied to a
// finished output. Saving creates a new linked version (the original stays).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Columns2, Eye, Loader2, Redo2, RotateCcw, RotateCw, Sparkles, Undo2, X } from "lucide-react";
import { EditModeSwitch } from "./EditModeSwitch";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { autoTone, estimateStraighten } from "@/lib/adjust/auto";
import { fetchAdjustSource, saveAdjustedImage, type AdjustSaveResult, type AdjustSourceRef } from "@/lib/adjust/api";
import { planGeometry } from "@/lib/adjust/colour";
import { canRedo, canUndo, currentStep, pushStep, redo, startHistory, undo, type AdjustHistory } from "@/lib/adjust/history";
import {
  COLOUR_SLIDERS,
  DEFAULT_ADJUST_PARAMS,
  LIGHT_SLIDERS,
  SLIDER_SPECS,
  formatSliderValue,
  isIdentityAdjust,
  rotateClockwise,
  type AdjustParams,
  type AdjustSliderKey,
} from "@/lib/adjust/params";
import { createAdjustRenderer, prepareAdjustSource, renderFullSizePng, type AdjustRenderer, type AdjustSource } from "@/lib/adjust/renderer";

export interface AdjustWorkspaceProps extends AdjustSourceRef {
  onClose: () => void;
  onSaved: (result: AdjustSaveResult) => void;
  /** Shows the "AI Edit" tab when provided. */
  onSwitchToAiEdit?: () => void;
}

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready" };

function beforeParams(p: AdjustParams): AdjustParams {
  // "Before" keeps the geometry so the comparison lines up; only tone/colour revert.
  return { ...DEFAULT_ADJUST_PARAMS, rotate: p.rotate, straighten: p.straighten };
}

export function AdjustWorkspace({ sourceUrl, sourceImageId, sourceJobId, onClose, onSaved, onSwitchToAiEdit }: AdjustWorkspaceProps) {
  const { toast } = useToast();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [history, setHistory] = useState<AdjustHistory>(() => startHistory(DEFAULT_ADJUST_PARAMS));
  // Live value while a slider is being dragged (committed to history on release).
  const [draft, setDraft] = useState<AdjustParams | null>(null);
  const [comparing, setComparing] = useState(false);
  const [splitView, setSplitView] = useState(false);
  const [split, setSplit] = useState(0.5);
  const [saving, setSaving] = useState(false);
  const [rendererKind, setRendererKind] = useState<"webgl2" | "cpu" | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });

  const ref = useMemo<AdjustSourceRef>(() => ({ sourceUrl, sourceImageId, sourceJobId }), [sourceUrl, sourceImageId, sourceJobId]);
  const sourceRef = useRef<AdjustSource | null>(null);
  const analysisRef = useRef<{ pixels: Uint8ClampedArray; width: number; height: number } | null>(null);
  const initialRef = useRef<AdjustParams>(DEFAULT_ADJUST_PARAMS);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const beforeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<AdjustRenderer | null>(null);
  const beforeRendererRef = useRef<AdjustRenderer | null>(null);
  const frameRef = useRef<number | null>(null);

  const committed = currentStep(history);
  const params = draft || committed;
  const dirty = !isIdentityAdjust(committed) && JSON.stringify(committed) !== JSON.stringify(initialRef.current);
  const canSave = load.status === "ready" && !saving && !isIdentityAdjust(params);

  // ---- Load the photo (server returns the clean parent when re-opening an Adjust version)
  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    setLoad({ status: "loading" });
    (async () => {
      try {
        const { info, blob } = await fetchAdjustSource(ref, ctrl.signal);
        const prepared = await prepareAdjustSource(blob);
        if (cancelled) return;
        sourceRef.current = prepared.source;
        analysisRef.current = prepared.analysis;
        const start = info.adjustments || DEFAULT_ADJUST_PARAMS;
        initialRef.current = start;
        setHistory(startHistory(start));
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
  }, [ref]);

  // ---- Track the space available for the preview
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setViewport({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [load.status]);

  // ---- Create renderers once the photo and canvas exist
  useEffect(() => {
    if (load.status !== "ready" || !canvasRef.current || !sourceRef.current) return;
    const r = createAdjustRenderer(canvasRef.current, sourceRef.current);
    rendererRef.current = r;
    setRendererKind(r.kind);
    return () => {
      r.dispose();
      rendererRef.current = null;
    };
  }, [load.status]);

  useEffect(() => {
    if (!splitView || load.status !== "ready" || !beforeCanvasRef.current || !sourceRef.current) return;
    const r = createAdjustRenderer(beforeCanvasRef.current, sourceRef.current);
    beforeRendererRef.current = r;
    return () => {
      r.dispose();
      beforeRendererRef.current = null;
    };
  }, [splitView, load.status]);

  // ---- Preview size: fit the output (rotation can swap width/height) into the stage
  const previewSize = useMemo(() => {
    const src = sourceRef.current;
    if (!src || viewport.w <= 0 || viewport.h <= 0) return null;
    const g = planGeometry(src.width, src.height, params);
    const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
    const fit = Math.min(viewport.w / g.outW, viewport.h / g.outH, 1 / dpr);
    const cssW = Math.max(1, Math.floor(g.outW * fit));
    const cssH = Math.max(1, Math.floor(g.outH * fit));
    return { cssW, cssH, pxW: Math.max(1, Math.round(cssW * dpr)), pxH: Math.max(1, Math.round(cssH * dpr)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, params.rotate, load.status]);

  // ---- Draw (one frame per change)
  useEffect(() => {
    if (!previewSize || !rendererRef.current) return;
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      try {
        rendererRef.current?.render(comparing ? beforeParams(params) : params, previewSize.pxW, previewSize.pxH);
        beforeRendererRef.current?.render(beforeParams(params), previewSize.pxW, previewSize.pxH);
      } catch (err) {
        console.error("[adjust] render failed", err);
      }
    });
  }, [params, comparing, previewSize, rendererKind, splitView]);

  // ---- Editing helpers
  const commit = useCallback((next: AdjustParams) => {
    setDraft(null);
    setHistory((h) => pushStep(h, next));
  }, []);

  const setSlider = (key: AdjustSliderKey, value: number) => setDraft({ ...(draft || committed), [key]: value });
  const commitSlider = (key: AdjustSliderKey, value: number) => commit({ ...(draft || committed), [key]: value });

  const handleAuto = () => {
    const a = analysisRef.current;
    if (!a) return;
    commit({ ...committed, ...autoTone(a.pixels, a.width, a.height) });
  };

  const handleAutoStraighten = () => {
    const a = analysisRef.current;
    if (!a) return;
    const value = estimateStraighten(a.pixels, a.width, a.height);
    commit({ ...committed, straighten: value });
    if (value === 0) toast({ title: "Already straight", description: "No noticeable tilt was found in this photo." });
  };

  const handleUndo = useCallback(() => setHistory((h) => undo(h)), []);
  const handleRedo = useCallback(() => setHistory((h) => redo(h)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) handleRedo();
      else handleUndo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleRedo, handleUndo]);

  const handleClose = () => {
    if (dirty && !window.confirm("Discard your adjustments?")) return;
    onClose();
  };

  const handleSwitch = () => {
    if (!onSwitchToAiEdit) return;
    if (dirty && !window.confirm("Switch to AI Edit? Your unsaved adjustments will be lost.")) return;
    onSwitchToAiEdit();
  };

  const handleSave = async () => {
    const src = sourceRef.current;
    if (!src || !canSave) return;
    setSaving(true);
    try {
      const png = await renderFullSizePng(src, committed);
      const result = await saveAdjustedImage(ref, png.blob, committed);
      toast({ title: "Adjusted photo saved", description: "Saved as a new version. Your original is unchanged." });
      onSaved(result);
    } catch (err: any) {
      toast({ title: "Couldn't save", description: err?.message || "Please try again.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  // ---- Split-view divider drag
  const onSplitPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.type === "pointerdown") (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (e.type === "pointermove" && !(e.buttons & 1)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setSplit(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
  };

  const renderSlider = (key: AdjustSliderKey) => {
    const spec = SLIDER_SPECS[key];
    const value = params[key];
    return (
      <div key={key} className="space-y-1.5" data-testid={`adjust-slider-${key}`}>
        <div className="flex items-center justify-between text-sm">
          <label className="font-medium text-slate-700" title={spec.help} onDoubleClick={() => commit({ ...committed, [key]: 0 })}>
            {spec.label}
          </label>
          <div className="flex items-center gap-1.5">
            <span className={`tabular-nums text-xs ${value === 0 ? "text-slate-400" : "text-slate-900 font-medium"}`}>{formatSliderValue(key, value)}</span>
            <button
              type="button"
              aria-label={`Reset ${spec.label}`}
              className={`rounded p-0.5 text-slate-400 hover:text-slate-700 ${value === 0 ? "invisible" : ""}`}
              onClick={() => commit({ ...committed, [key]: 0 })}
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          </div>
        </div>
        <div className="relative flex h-5 items-center">
          <span className="pointer-events-none absolute left-1/2 top-1/2 h-3 w-px -translate-y-1/2 bg-slate-300" aria-hidden />
          <input
            type="range"
            className="relative w-full cursor-pointer accent-slate-800 disabled:cursor-not-allowed"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={value}
            disabled={load.status !== "ready" || saving}
            aria-label={spec.label}
            onChange={(e) => setSlider(key, Number(e.target.value))}
            onPointerUp={(e) => commitSlider(key, Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => commitSlider(key, Number((e.target as HTMLInputElement).value))}
            onBlur={(e) => commitSlider(key, Number(e.target.value))}
          />
        </div>
      </div>
    );
  };

  return (
    <div className="grid h-screen w-screen grid-rows-[auto_minmax(0,1fr)] bg-slate-100 lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-[auto_minmax(0,1fr)]">
      {/* Top bar */}
      <header className="col-span-full flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 sm:px-4">
        {onSwitchToAiEdit ? (
          <EditModeSwitch active="adjust" onSelect={(m) => m === "ai" && handleSwitch()} />
        ) : (
          <h2 className="text-base font-semibold text-slate-900">Adjust photo</h2>
        )}
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={handleUndo} disabled={!canUndo(history) || saving} aria-label="Undo" title="Undo (Ctrl+Z)">
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={handleRedo} disabled={!canRedo(history) || saving} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
            <Redo2 className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={load.status !== "ready"}
            onPointerDown={() => setComparing(true)}
            onPointerUp={() => setComparing(false)}
            onPointerLeave={() => setComparing(false)}
            onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") setComparing(true); }}
            onKeyUp={() => setComparing(false)}
            title="Hold to see the photo before your adjustments"
          >
            <Eye className="mr-1.5 h-4 w-4" />Hold to compare
          </Button>
          <Button variant={splitView ? "secondary" : "outline"} size="sm" disabled={load.status !== "ready"} onClick={() => setSplitView((v) => !v)} aria-pressed={splitView}>
            <Columns2 className="mr-1.5 h-4 w-4" />Split view
          </Button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => commit({ ...DEFAULT_ADJUST_PARAMS })} disabled={isIdentityAdjust(committed) || saving}>
            Reset all
          </Button>
          <Button variant="outline" size="sm" onClick={handleClose} disabled={saving}>
            <X className="mr-1 h-4 w-4" />Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!canSave} data-testid="adjust-save">
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            {saving ? "Saving…" : "Save as new version"}
          </Button>
        </div>
      </header>

      {/* Preview */}
      <section ref={stageRef} className="relative flex min-h-0 items-center justify-center overflow-hidden p-3 sm:p-6">
        {load.status === "loading" && (
          <div className="flex items-center gap-2 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" />Loading photo…</div>
        )}
        {load.status === "error" && (
          <div className="max-w-sm rounded-lg border border-red-200 bg-white p-4 text-center text-sm text-red-700">
            {load.message}
            <div className="mt-3"><Button size="sm" variant="outline" onClick={onClose}>Close</Button></div>
          </div>
        )}
        {load.status === "ready" && (
          <div
            className="relative select-none shadow-lg"
            style={previewSize ? { width: previewSize.cssW, height: previewSize.cssH } : undefined}
            onPointerDown={splitView ? onSplitPointer : undefined}
            onPointerMove={splitView ? onSplitPointer : undefined}
          >
            <canvas ref={canvasRef} className="block h-full w-full" data-testid="adjust-canvas" />
            {splitView && (
              <>
                <canvas
                  ref={beforeCanvasRef}
                  className="pointer-events-none absolute inset-0 block h-full w-full"
                  style={{ clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }}
                />
                <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow" style={{ left: `${split * 100}%` }} />
                <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">Before</span>
                <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">After</span>
              </>
            )}
            {comparing && !splitView && (
              <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">Before</span>
            )}
          </div>
        )}
      </section>

      {/* Controls */}
      <aside className="max-h-[45vh] overflow-y-auto border-t border-slate-200 bg-white p-4 lg:max-h-none lg:border-l lg:border-t-0">
        <div className="space-y-5">
          <div>
            <Button className="w-full" variant="secondary" onClick={handleAuto} disabled={load.status !== "ready" || saving} data-testid="adjust-auto">
              <Sparkles className="mr-2 h-4 w-4" />Auto
            </Button>
            <p className="mt-1.5 text-xs text-slate-500">Free and instant. No credits are used.</p>
          </div>

          <div className="space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Light</h3>
            {LIGHT_SLIDERS.map(renderSlider)}
          </div>

          <div className="space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Colour</h3>
            {COLOUR_SLIDERS.map(renderSlider)}
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Straighten</h3>
              <div className="flex gap-1">
                <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={handleAutoStraighten} disabled={load.status !== "ready" || saving}>
                  Auto
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={() => commit({ ...committed, rotate: rotateClockwise(committed.rotate) })}
                  disabled={load.status !== "ready" || saving}
                  title="Rotate 90° clockwise"
                >
                  <RotateCw className="mr-1 h-3.5 w-3.5" />90°
                </Button>
              </div>
            </div>
            {renderSlider("straighten")}
            <p className="text-xs text-slate-500">Straightening zooms in slightly so there are no empty corners.</p>
          </div>

          {rendererKind === "cpu" && (
            <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-800">
              Your browser doesn't support fast previews, so changes may take a moment to appear.
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}

export default AdjustWorkspace;
