import React, { useRef, useState } from "react";

export type RegionEditorProps = {
  open: boolean;
  imageIndex: number | null;
  imageUrl: string | null;
  baseImageUrl?: string | null;
  onClose: () => void;
  onUpdated: (imageIndex: number, newUrl: string) => void;
};

const MODES = ["add", "remove", "restore"] as const;
type Mode = typeof MODES[number];

export const RegionEditor: React.FC<RegionEditorProps> = ({
  open,
  imageIndex,
  imageUrl,
  baseImageUrl,
  onClose,
  onUpdated,
}) => {
  const [mode, setMode] = useState<Mode>("add");
  const [prompt, setPrompt] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [painting, setPainting] = useState(false);

  if (!open || imageIndex === null || !imageUrl) return null;

  // Paint mask logic (simple circular brush)
  const handleMouseDown = (e: React.MouseEvent) => {
    setPainting(true);
    paintAt(e);
  };
  const handleMouseUp = () => setPainting(false);
  const handleMouseMove = (e: React.MouseEvent) => {
    if (painting) paintAt(e);
  };
  function paintAt(e: React.MouseEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    ctx.globalAlpha = 1.0;
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, 2 * Math.PI);
    ctx.fillStyle = "rgba(255,0,0,0.7)";
    ctx.fill();
  }

  // Export mask as PNG Blob
  async function getMaskBlob(): Promise<Blob> {
    const canvas = canvasRef.current;
    if (!canvas) throw new Error("No mask canvas");
    return new Promise(resolve => canvas.toBlob(blob => resolve(blob!), "image/png"));
  }

  async function handleConfirm() {
    if (imageIndex === null) return;
    const maskBlob = await getMaskBlob();
    onUpdated(imageIndex, "pending"); // Optionally show loading
    // Pass mode, prompt, maskBlob up
    // Parent should call handleRegionEdit
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-60">
      <div className="bg-white rounded shadow-lg p-4 w-[600px] relative">
        <div className="flex gap-2 mb-2">
          {MODES.map(m => (
            <button
              key={m}
              className={`px-3 py-1 rounded ${mode === m ? "bg-blue-500 text-white" : "bg-gray-200"}`}
              onClick={() => setMode(m)}
            >
              {m === "add" ? "Add" : m === "remove" ? "Remove" : "Restore Original"}
            </button>
          ))}
        </div>
        <div className="relative w-full h-[400px] border mb-2">
          <img src={imageUrl} alt="Edit" className="absolute w-full h-full object-contain" />
          <canvas
            ref={canvasRef}
            width={600}
            height={400}
            className="absolute top-0 left-0 w-full h-full"
            style={{ pointerEvents: mode === "restore" ? "none" : "auto" }}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onMouseMove={handleMouseMove}
          />
        </div>
        {mode !== "restore" && (
          <input
            type="text"
            className="border rounded px-2 py-1 w-full mb-2"
            placeholder="Prompt (e.g. add a sofa)"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
          />
        )}
        <div className="flex justify-end gap-2">
          <button className="px-4 py-2 bg-gray-300 rounded" onClick={onClose}>Cancel</button>
          <button className="px-4 py-2 bg-blue-600 text-white rounded" onClick={handleConfirm}>Confirm</button>
        </div>
      </div>
    </div>
  );
};
