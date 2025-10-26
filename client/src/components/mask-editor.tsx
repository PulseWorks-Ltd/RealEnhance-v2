import React, { useMemo, useRef, useState } from "react";
import { useHistory, Action } from "../hooks/useHistory";

type Tool = "remove" | "add" | "restore";
type Props = {
  baseImage2A: string;          // base64 PNG of staged image
  onApply: (mask: ImageData, tool: Tool) => Promise<void>;
};

type EditorState = {
  tool: Tool;
  maskCanvas?: HTMLCanvasElement | null;
};

export default function MaskEditor({ baseImage2A, onApply }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [brush, setBrush] = useState(22);
  const { state, apply, undo, redo, canUndo, canRedo } = useHistory<EditorState>({ tool: "remove" });

  const img = useMemo(() => {
    const im = new Image();
    im.src = `data:image/png;base64,${baseImage2A}`;
    return im;
  }, [baseImage2A]);

  const reducer = (s: EditorState, a: Action<EditorState>) => {
    if (a.type === "SET_TOOL") return { ...s, tool: a.payload.tool };
    if (a.type === "UNDO") return s;
    return s;
  };

  function onPointer(e: React.PointerEvent) {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#ffffff"; // white = edit
    ctx.beginPath();
    ctx.arc(e.nativeEvent.offsetX, e.nativeEvent.offsetY, brush, 0, Math.PI*2);
    ctx.fill();
  }

  async function handleApply() {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const mask = ctx.getImageData(0,0,c.width,c.height);
    await onApply(mask, (state.tool || "remove") as Tool);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <label>Tool:</label>
        <select value={state.tool} onChange={e => apply({ id: crypto.randomUUID(), type:"SET_TOOL", payload:{ tool: e.target.value } as any}, reducer)}>
          <option value="remove">Remove</option>
          <option value="add">Add</option>
          <option value="restore">Restore</option>
        </select>
        <label>Brush:</label>
        <input type="range" min={8} max={64} value={brush} onChange={e=>setBrush(parseInt(e.target.value))}/>
        <button disabled={!canUndo} onClick={()=>undo(reducer)}>Undo</button>
        <button disabled={!canRedo} onClick={()=>redo(reducer)}>Redo</button>
      </div>
      <canvas
        ref={canvasRef}
        width={1024}
        height={576}
        onPointerDown={onPointer}
        onPointerMove={(e)=> e.buttons===1 && onPointer(e)}
        style={{ border: "1px solid #333", background: `url(data:image/png;base64,${baseImage2A}) center/contain no-repeat` }}
      />
      <div className="flex gap-2">
        <button onClick={handleApply}>Apply</button>
      </div>
    </div>
  );
}
