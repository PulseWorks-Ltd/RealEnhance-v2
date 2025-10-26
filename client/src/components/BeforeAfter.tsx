import { useEffect, useRef, useState } from "react";

type Props = {
  beforeSrc: string;
  afterSrc: string;
  className?: string;
  altBefore?: string;
  altAfter?: string;
};

export default function BeforeAfter({
  beforeSrc,
  afterSrc,
  className,
  altBefore = "Before",
  altAfter = "After",
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(50);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onMove = (clientX: number) => {
      const rect = el.getBoundingClientRect();
      const clamped = Math.min(Math.max(clientX - rect.left, 0), rect.width);
      setPos(Math.round((clamped / rect.width) * 100));
    };
    const down = (e: PointerEvent) => {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      onMove(e.clientX);
      const move = (ev: PointerEvent) => onMove(ev.clientX);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };
    el.addEventListener("pointerdown", down);
    return () => el.removeEventListener("pointerdown", down);
  }, []);

  return (
    <div
      ref={containerRef}
      className={
        "relative select-none overflow-hidden rounded-2xl shadow " +
        (className ?? "")
      }
    >
      <img src={beforeSrc} alt={altBefore} className="block w-full h-auto" />
      <div
        className="absolute inset-0 overflow-hidden"
        style={{ width: `${pos}%` }}
      >
        <img src={afterSrc} alt={altAfter} className="block w-full h-auto" />
      </div>
      <div
        className="absolute inset-y-0"
        style={{ left: `${pos}%`, transform: "translateX(-50%)" }}
      >
        <div className="h-full w-0.5 bg-white/70 shadow-[0_0_0_1px_rgba(0,0,0,0.25)]" />
        <div className="absolute top-1/2 -translate-y-1/2 -left-4 right-4 flex items-center justify-between gap-4">
          <span className="px-2 py-0.5 rounded bg-white/90 text-xs font-medium text-gray-800 shadow">
            {altBefore}
          </span>
          <span className="px-2 py-0.5 rounded bg-white/90 text-xs font-medium text-gray-800 shadow">
            {altAfter}
          </span>
        </div>
        <div className="absolute top-1/2 -translate-y-1/2 -left-3 h-6 w-6 rounded-full bg-[#2E74C9] border-2 border-white shadow" />
      </div>
      <input
        aria-label="Comparison position"
        type="range"
        min={0}
        max={100}
        value={pos}
        onChange={(e) => setPos(Number(e.target.value))}
        className="absolute bottom-3 left-1/2 -translate-x-1/2 w-1/2 accent-[#2E74C9]"
      />
    </div>
  );
}
