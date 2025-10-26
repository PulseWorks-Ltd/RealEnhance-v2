import { useEffect, useRef, useState } from "react";

export type MaskResult = {
  maskPNG: Blob;
  bbox: { x: number; y: number; w: number; h: number };
};

export default function MaskCanvas({
  image,
  brushSize = 24,
  onChange
}: {
  image: HTMLImageElement | null;
  brushSize?: number;
  onChange?: (hasPaint: boolean) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [painting, setPainting] = useState(false);

  useEffect(() => {
    const c = ref.current;
    if (!c || !image) return;
    c.width = image.naturalWidth;
    c.height = image.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
  }, [image]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "white";
    ctx.globalCompositeOperation = "source-over";
    ctx.lineWidth = brushSize;

    let hasPaint = false;

    const pos = (e: PointerEvent) => {
      const rect = c.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * c.width;
      const y = ((e.clientY - rect.top) / rect.height) * c.height;
      return { x, y };
    };

    const down = (e: PointerEvent) => {
      setPainting(true);
      const { x, y } = pos(e);
      ctx.beginPath();
      ctx.moveTo(x, y);
      hasPaint = true;
      onChange?.(hasPaint);
      c.setPointerCapture(e.pointerId);
    };

    const move = (e: PointerEvent) => {
      if (!painting) return;
      const { x, y } = pos(e);
      ctx.lineTo(x, y);
      ctx.stroke();
    };

    const up = (e: PointerEvent) => {
      setPainting(false);
      c.releasePointerCapture(e.pointerId);
    };

    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      c.removeEventListener("pointerdown", down);
      c.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [painting, brushSize, onChange]);

  (MaskCanvas as any).exportMask = async (): Promise<MaskResult | null> => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    const img = ctx.getImageData(0, 0, c.width, c.height);
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        if (img.data[i] | img.data[i+1] | img.data[i+2] | img.data[i+3]) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    const w = maxX - minX + 1, h = maxY - minY + 1;
    const oc = document.createElement("canvas");
    oc.width = w; oc.height = h;
    const octx = oc.getContext("2d")!;
    octx.putImageData(ctx.getImageData(minX, minY, w, h), 0, 0);
    const blob: Blob = await new Promise(res => oc.toBlob(b => res(b!), "image/png"));
    return { maskPNG: blob, bbox: { x: minX, y: minY, w, h } };
  };

  (MaskCanvas as any).clear = () => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
  };

  return <canvas ref={ref} className="w-full h-auto touch-none cursor-crosshair" />;
}
