// "Adjust lighting & colour" UI pieces used inside the Edit Image screen:
//  - AdjustEntryCard: the closed state in the left panel
//  - AdjustControls:  the sliders (left panel, when open)
//  - AdjustPreview:   the live picture (centre, when open)

import { ArrowLeft, Columns2, Eye, Loader2, Redo2, RotateCcw, RotateCw, SlidersHorizontal, Sparkles, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { COLOUR_SLIDERS, LIGHT_SLIDERS, SLIDER_SPECS, formatSliderValue, isIdentityAdjust, rotateClockwise, type AdjustSliderKey } from "@/lib/adjust/params";
import type { AdjustEditor } from "./useAdjustEditor";

export const ADJUST_TITLE = "Adjust lighting & colour";

export function AdjustEntryCard({ onOpen, disabled }: { onOpen: () => void; disabled?: boolean }) {
  return (
    <>
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      data-testid="button-open-adjust"
      className="mt-6 w-full rounded-lg border border-slate-200 bg-slate-50 p-4 text-left transition hover:border-slate-300 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <SlidersHorizontal className="h-4 w-4" />
        {ADJUST_TITLE}
      </span>
      <span className="mt-1 block text-xs text-slate-500">Free · brightness, colour, straighten</span>
    </button>
    <p className="mt-2 text-xs leading-relaxed text-slate-500" data-testid="adjust-order-tip">
      <span className="font-medium text-slate-600">Tip:</span> make any changes using the text box or highlighting
      first. Once they've finished, adjust the lighting and colour last. Editing the photo again afterwards can undo
      your lighting and colour changes.
    </p>
    </>
  );
}

export function AdjustControls({ editor, onBack }: { editor: AdjustEditor; onBack: () => void }) {
  const busy = !editor.ready || editor.saving;

  const renderSlider = (key: AdjustSliderKey) => {
    const spec = SLIDER_SPECS[key];
    const value = editor.params[key];
    return (
      <div key={key} className="space-y-1" data-testid={`adjust-slider-${key}`}>
        <div className="flex items-center justify-between text-sm">
          <label className="font-medium text-slate-700" title={spec.help} onDoubleClick={() => editor.resetSlider(key)}>
            {spec.label}
          </label>
          <div className="flex items-center gap-1">
            <span className={`tabular-nums text-xs ${value === 0 ? "text-slate-400" : "font-medium text-slate-900"}`}>{formatSliderValue(key, value)}</span>
            <button
              type="button"
              aria-label={`Reset ${spec.label}`}
              className={`rounded p-0.5 text-slate-400 hover:text-slate-700 ${value === 0 ? "invisible" : ""}`}
              onClick={() => editor.resetSlider(key)}
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
            disabled={busy}
            aria-label={spec.label}
            onChange={(e) => editor.setSlider(key, Number(e.target.value))}
            onPointerUp={(e) => editor.commitSlider(key, Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => editor.commitSlider(key, Number((e.target as HTMLInputElement).value))}
            onBlur={(e) => editor.commitSlider(key, Number(e.target.value))}
          />
        </div>
      </div>
    );
  };

  return (
    <div className="mt-4 flex flex-col gap-4" data-testid="adjust-controls">
      <div className="flex items-center justify-between">
        <button type="button" onClick={onBack} className="flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900" data-testid="button-close-adjust">
          <ArrowLeft className="h-4 w-4" />
          Back to editing
        </button>
        <div className="flex items-center">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={editor.undo} disabled={!editor.canUndo || editor.saving} aria-label="Undo" title="Undo (Ctrl+Z)">
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={editor.redo} disabled={!editor.canRedo || editor.saving} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
            <Redo2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-900">{ADJUST_TITLE}</h3>
        <p className="text-xs text-slate-500">Free and instant. Saves as a new version.</p>
      </div>

      <Button variant="secondary" onClick={editor.auto} disabled={busy} data-testid="adjust-auto">
        <Sparkles className="mr-2 h-4 w-4" />Auto
      </Button>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Light</h4>
        {LIGHT_SLIDERS.map(renderSlider)}
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Colour</h4>
        {COLOUR_SLIDERS.map(renderSlider)}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Straighten</h4>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={editor.autoStraighten} disabled={busy}>Auto</Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => editor.setRotate(rotateClockwise(editor.committed.rotate))} disabled={busy} title="Rotate 90° clockwise">
              <RotateCw className="mr-1 h-3.5 w-3.5" />90°
            </Button>
          </div>
        </div>
        {renderSlider("straighten")}
        <p className="text-xs text-slate-500">Straightening zooms in slightly so there are no empty corners.</p>
      </div>

      <Button variant="ghost" size="sm" onClick={editor.resetAll} disabled={isIdentityAdjust(editor.committed) || editor.saving}>
        Reset all
      </Button>

      {editor.rendererKind === "cpu" && (
        <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-800">
          Your browser doesn't support fast previews, so changes may take a moment to appear.
        </p>
      )}
    </div>
  );
}

export function AdjustPreview({ editor }: { editor: AdjustEditor }) {
  const { load, previewSize, splitView, split } = editor;

  const onSplitPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.type === "pointerdown") (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (e.type === "pointermove" && !(e.buttons & 1)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    editor.setSplit(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
  };

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-[#f1f5f9]" data-testid="adjust-preview">
      <div className="flex justify-center gap-2 p-3">
        <Button
          variant="outline"
          size="sm"
          className="bg-white"
          disabled={!editor.ready}
          onPointerDown={() => editor.setComparing(true)}
          onPointerUp={() => editor.setComparing(false)}
          onPointerLeave={() => editor.setComparing(false)}
          onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") editor.setComparing(true); }}
          onKeyUp={() => editor.setComparing(false)}
          title="Hold to see the photo before your adjustments"
        >
          <Eye className="mr-1.5 h-4 w-4" />Hold to compare
        </Button>
        <Button variant={splitView ? "secondary" : "outline"} size="sm" className={splitView ? "" : "bg-white"} disabled={!editor.ready} onClick={() => editor.setSplitView(!splitView)} aria-pressed={splitView}>
          <Columns2 className="mr-1.5 h-4 w-4" />Split view
        </Button>
      </div>

      <div ref={editor.stageEl} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-4 pb-4">
        {(load.status === "loading" || load.status === "idle") && (
          <div className="flex items-center gap-2 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" />Loading photo…</div>
        )}
        {load.status === "error" && (
          <div className="max-w-sm rounded-lg border border-red-200 bg-white p-4 text-center text-sm text-red-700">{load.message}</div>
        )}
        {load.status === "ready" && (
          <div
            className="relative select-none shadow-lg"
            style={previewSize ? { width: previewSize.cssW, height: previewSize.cssH } : undefined}
            onPointerDown={splitView ? onSplitPointer : undefined}
            onPointerMove={splitView ? onSplitPointer : undefined}
          >
            <canvas ref={editor.canvasEl} className="block h-full w-full" data-testid="adjust-canvas" />
            {splitView && (
              <>
                <canvas
                  ref={editor.beforeCanvasEl}
                  className="pointer-events-none absolute inset-0 block h-full w-full"
                  style={{ clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }}
                />
                <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow" style={{ left: `${split * 100}%` }} />
                <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">Before</span>
                <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">After</span>
              </>
            )}
            {editor.comparing && !splitView && (
              <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">Before</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
