import React, { useState, useRef, useCallback, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Brush, ZoomIn, ZoomOut, Move, RotateCcw, Sparkles } from "lucide-react";

/**
 * Derive the Stage 1 base image URL from a Stage 2 filename.
 *
 * Examples:
 *   ...1764...-canonical-1A-1B-2-retry1.webp → ...1764...-canonical-1A-1B.webp
 *   ...1764...-canonical-1A-2.webp → ...1764...-canonical-1A.webp
 *
 * Returns null if the URL doesn't match the expected Stage 2 pattern.
 */
function deriveBaseFromInitial(initialUrl?: string | null): string | null {
  if (!initialUrl) return null;

  try {
    const url = new URL(initialUrl);
    const pathParts = url.pathname.split("/");
    const filename = pathParts.pop();
    if (!filename) return null;

    // Split name and extension (e.g., "1764...-canonical-1A-1B-2-retry1.webp")
    const match = filename.match(/^(.+)\.([^.]+)$/);
    if (!match) return null;
    const [, stem, ext] = match; // stem: "1764...-canonical-1A-1B-2-retry1"
    const tokens = stem.split("-");

    // Find the '2' token (indicates Stage 2) if present
    const idx2 = tokens.lastIndexOf("2");
    if (idx2 === -1) {
      // Not a Stage 2 filename → nothing to derive
      return null;
    }

    // Look for 1B or 1A before the '2'
    const idx1B = tokens.lastIndexOf("1B", idx2);
    const idx1A = tokens.lastIndexOf("1A", idx2);

    let baseTokens: string[] | null = null;

    if (idx1B !== -1) {
      // Pattern: ...-1A-1B-2[-retryX] → keep up to 1B
      baseTokens = tokens.slice(0, idx1B + 1);
    } else if (idx1A !== -1) {
      // Pattern: ...-1A-2[-retryX] → keep up to 1A
      baseTokens = tokens.slice(0, idx1A + 1);
    } else {
      // No 1A/1B markers → can't infer Stage 1
      return null;
    }

    const baseFilename = `${baseTokens.join("-")}.${ext}`;
    pathParts.push(baseFilename);
    url.pathname = pathParts.join("/");

    console.log("[deriveBaseFromInitial] Derived base URL:", {
      original: initialUrl,
      derived: url.toString(),
    });

    return url.toString();
  } catch (err) {
    console.warn("[deriveBaseFromInitial] Failed to parse URL:", err);
    return null;
  }
}

interface RegionEditorProps {
  onComplete?: (result: {
    imageUrl: string;
    originalUrl: string;
    maskUrl: string;
    mode?: string;
  }) => void;
  onCancel?: () => void;
  onStart?: () => void; // Called when processing starts (for immediate UI feedback)
  onError?: (errorMessage?: string) => void; // Called when processing fails
  onJobStarted?: (jobId: string) => void; // Optional: delegate polling to parent
  jobId?: string | null;
  imageId?: string | null;
  stageUrls?: Record<string, string | null> | null;
  initialImageUrl?: string;
  originalImageUrl?: string; // URL to original image for pixel-level restoration
  initialGoal?: string;
  initialIndustry?: string;
}

export function RegionEditor({
  onComplete,
  onCancel,
  onStart,
  onError,
  onJobStarted,
  jobId,
  imageId,
  stageUrls,
  initialImageUrl,
  originalImageUrl,
  initialGoal,
  initialIndustry,
}: RegionEditorProps) {
  // Only two modes: 'edit' and 'restore_original'
  const [mode, setMode] = useState<"edit" | "restore_original">("edit");
  // NOTE: Restore Original temporarily disabled for RealEnhance v2.0 launch.
  // This mode will be re-enabled in v3.0 when the multi-stage pipeline is finalized.

  // Debug: Log incoming props on mount and when they change
  useEffect(() => {
    console.log('[RegionEditor] initialImageUrl:', initialImageUrl);
    console.log('[RegionEditor] originalImageUrl:', originalImageUrl);
  }, [initialImageUrl, originalImageUrl]);
  // Quick high-level prop + derived base log for easier debugging of restore flow
  useEffect(() => {
    const derivedFromInitial = !originalImageUrl ? deriveBaseFromInitial(initialImageUrl) : null;
    const derivedBase =
      mode === "restore_original"
        ? (originalImageUrl || derivedFromInitial || "")
        : (originalImageUrl || initialImageUrl || "");
    console.log('[RegionEditor] props summary:', { mode, initialImageUrl, originalImageUrl, derivedFromInitial, derivedBase });
  }, [mode, initialImageUrl, originalImageUrl]);

  // Refresh latest image/original/stage URLs from server by jobId to avoid stale edits
  useEffect(() => {
    let cancelled = false;
    const fetchLatest = async () => {
      if (!jobId) return;
      try {
        const res = await fetch(api(`/api/status/${encodeURIComponent(jobId)}`), {
          method: "GET",
          credentials: "include",
        });
        const text = await res.text();
        if (cancelled || !text) return;
        let data: any = {};
        try {
          data = JSON.parse(text);
        } catch (err) {
          console.warn("[region-editor] Failed to parse status JSON", err);
          return;
        }
        const item = data?.job || (Array.isArray(data?.items) ? data.items[0] : data);
        if (!item) return;
        const latestImageUrl = item.imageUrl || item.resultUrl || item.image || null;
        const latestOriginal = item.originalUrl || item.originalImageUrl || item.original || null;
        const latestStageUrls = item.stageUrls || null;
        setResolvedImageUrl(latestImageUrl || null);
        setResolvedOriginalUrl(latestOriginal || null);
        setResolvedStageUrls(latestStageUrls || null);
        console.log("[region-editor] refreshed status", {
          jobId,
          imageId,
          imageUrl: latestImageUrl,
          originalUrl: latestOriginal,
          stageUrls: latestStageUrls,
        });
      } catch (err) {
        if (!cancelled) {
          console.warn("[region-editor] status refresh failed", { jobId, imageId, err });
        }
      }
    };
    fetchLatest();
    return () => {
      cancelled = true;
    };
  }, [jobId, imageId]);

  const effectiveStageUrls = resolvedStageUrls || stageUrls || null;
  const effectiveInitialImageUrl = resolvedImageUrl || initialImageUrl || effectiveStageUrls?.['2'] || null;
  const effectiveOriginalImageUrl = resolvedOriginalUrl || originalImageUrl || effectiveStageUrls?.['1B'] || effectiveStageUrls?.['1A'] || null;

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(
    effectiveInitialImageUrl || null,
  );
  const [maskData, setMaskData] = useState<Blob | null>(null);
  const [instructions, setInstructions] = useState(initialGoal || "");
  const [industry, setIndustry] = useState(initialIndustry || "Real Estate");
  const [sceneType, setSceneType] = useState<
    "auto" | "interior" | "exterior"
  >("auto");
  const [smartReinstate, setSmartReinstate] = useState(true);
  const [isDrawing, setIsDrawing] = useState(false);
  const [brushSize, setBrushSize] = useState(20);
  const [zoomLevel, setZoomLevel] = useState(0.5);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPoint, setLastPanPoint] = useState({ x: 0, y: 0 });
  // Staging style is now batch-level only; removed from region editor
  const [roomType, setRoomType] = useState<string>("auto");
  const [imageLoading, setImageLoading] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const pollingAbortRef = useRef<{ abort: boolean }>({ abort: false });

  const [resolvedImageUrl, setResolvedImageUrl] = useState<string | null>(null);
  const [resolvedOriginalUrl, setResolvedOriginalUrl] = useState<string | null>(null);
  const [resolvedStageUrls, setResolvedStageUrls] = useState<Record<string, string | null> | null>(null);

  const { toast } = useToast();

  // Redraw preview and mask canvases whenever previewUrl changes
  useEffect(() => {
    if (selectedFile) return;
    setPreviewUrl(effectiveInitialImageUrl || null);
  }, [effectiveInitialImageUrl, selectedFile]);

  useEffect(() => {
    if (!previewUrl) return;
    setImageLoading(true);
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      setImageLoading(false);
      const canvas = canvasRef.current;
      const previewCanvas = previewCanvasRef.current;
      if (canvas && previewCanvas) {
        const displayScale = 1.75;
        const displayWidth = img.width * displayScale;
        const displayHeight = img.height * displayScale;
        const dpr = window.devicePixelRatio || 1;

        // Mask canvas
        canvas.width = img.width * dpr;
        canvas.height = img.height * dpr;
        canvas.style.width = `${displayWidth}px`;
        canvas.style.height = `${displayHeight}px`;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.scale(dpr, dpr);
          ctx.fillStyle = "black";
          ctx.fillRect(0, 0, img.width, img.height);
        }

        // Preview canvas
        previewCanvas.width = img.width * dpr;
        previewCanvas.height = img.height * dpr;
        previewCanvas.style.width = `${displayWidth}px`;
        previewCanvas.style.height = `${displayHeight}px`;
        const previewCtx = previewCanvas.getContext("2d");
        if (previewCtx) {
          previewCtx.setTransform(1, 0, 0, 1, 0, 0);
          previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
          previewCtx.scale(dpr, dpr);
          previewCtx.drawImage(img, 0, 0, img.width, img.height);
        }
      }
      if (imageRef.current) {
        imageRef.current.src = previewUrl;
      }
    };
    img.onerror = () => setImageLoading(false);
    img.src = previewUrl;
  }, [previewUrl]);

  // Cleanup: Do not toggle abort on unmount; allow in-flight polling to finish
  useEffect(() => {
    return () => {
      console.log(
        "[region-editor] 🧹 Component unmounting (no longer toggling abort flag here)",
      );
      // IMPORTANT: Do NOT set pollingAbortRef.current.abort here.
      // Abort is only toggled in onMutate to cancel superseded jobs when a NEW edit starts.
    };
  }, []);

  // Handle file selection
  const onFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (!file.type.startsWith("image/")) {
        toast({
          title: "Invalid file",
          description: "Please select an image file",
          variant: "destructive",
        });
        return;
      }

      setSelectedFile(file);
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
      setMaskData(null);

      const img = new Image();
      img.onload = () => {
        const canvas = canvasRef.current;
        const previewCanvas = previewCanvasRef.current;
        if (canvas && previewCanvas) {
          const displayScale = 1.75;
          const displayWidth = img.width * displayScale;
          const displayHeight = img.height * displayScale;
          const dpr = window.devicePixelRatio || 1;

          canvas.width = img.width * dpr;
          canvas.height = img.height * dpr;
          canvas.style.width = `${displayWidth}px`;
          canvas.style.height = `${displayHeight}px`;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.scale(dpr, dpr);
            ctx.fillStyle = "black";
            ctx.fillRect(0, 0, img.width, img.height);
          }

          previewCanvas.width = img.width * dpr;
          previewCanvas.height = img.height * dpr;
          previewCanvas.style.width = `${displayWidth}px`;
          previewCanvas.style.height = `${displayHeight}px`;
          const previewCtx = previewCanvas.getContext("2d");
          if (previewCtx) {
            previewCtx.scale(dpr, dpr);
            previewCtx.drawImage(img, 0, 0, img.width, img.height);
          }
        }
      };
      img.src = url;
      if (imageRef.current) {
        imageRef.current.src = url;
      }
    },
    [toast],
  );

  // Load initial image URL if provided (first open) – drawing canvas setup
  useEffect(() => {
    if (effectiveInitialImageUrl && !selectedFile) {
      console.log("Loading initial image URL:", effectiveInitialImageUrl);
      setImageLoading(true);

      let retryCount = 0;
      const maxRetries = 3;

      const loadImage = () => {
        const img = new Image();
        img.crossOrigin = "anonymous";

        img.onload = () => {
          console.log(
            "Image loaded successfully:",
            img.width,
            "x",
            img.height,
          );
          setImageLoading(false);
          const canvas = canvasRef.current;
          const previewCanvas = previewCanvasRef.current;
          if (canvas && previewCanvas) {
            const displayScale = 1.75;
            const displayWidth = img.width * displayScale;
            const displayHeight = img.height * displayScale;
            const dpr = window.devicePixelRatio || 1;

            canvas.width = img.width * dpr;
            canvas.height = img.height * dpr;
            canvas.style.width = `${displayWidth}px`;
            canvas.style.height = `${displayHeight}px`;
            const ctx = canvas.getContext("2d");
            if (ctx) {
              ctx.scale(dpr, dpr);
              ctx.fillStyle = "black";
              ctx.fillRect(0, 0, img.width, img.height);
            }

            previewCanvas.width = img.width * dpr;
            previewCanvas.height = img.height * dpr;
            previewCanvas.style.width = `${displayWidth}px`;
            previewCanvas.style.height = `${displayHeight}px`;
            const previewCtx = previewCanvas.getContext("2d");
            if (previewCtx) {
              previewCtx.scale(dpr, dpr);
              previewCtx.drawImage(img, 0, 0, img.width, img.height);
            }
          }
          if (imageRef.current && effectiveInitialImageUrl) {
            imageRef.current.src = effectiveInitialImageUrl;
          }
        };

        img.onerror = (error) => {
          retryCount++;
          console.error(
            `Failed to load initial image (attempt ${retryCount}/${maxRetries}):`,
            effectiveInitialImageUrl,
            error,
          );

          if (retryCount < maxRetries) {
            const retryDelay = 500 * Math.pow(2, retryCount - 1);
            console.log(`Retrying in ${retryDelay}ms...`);
            setTimeout(loadImage, retryDelay);
          } else {
            setImageLoading(false);
            toast({
              title: "Image Load Error",
              description:
                "Failed to load the image after multiple attempts. Please close and try again.",
              variant: "destructive",
            });
          }
        };

        img.src = effectiveInitialImageUrl;
      };

      loadImage();
    }
  }, [effectiveInitialImageUrl, selectedFile, toast]);

  // Helper: map mouse screen coords to canvas coords
  const screenToCanvas = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };

      const displayScale = 1.75;
      const rect = canvas.getBoundingClientRect();

      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;

      const x = (cssX / displayScale) / zoomLevel;
      const y = (cssY / displayScale) / zoomLevel;

      return { x, y };
    },
    [zoomLevel],
  );

  // Drawing functions for mask creation
  const startDrawing = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      setIsDrawing(true);
      const { x, y } = screenToCanvas(e);
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (ctx) {
        ctx.beginPath();
        ctx.moveTo(x, y);
      }
    },
    [screenToCanvas],
  );

  const draw = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDrawing) return;
      const { x, y } = screenToCanvas(e);
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (ctx) {
        ctx.lineWidth = brushSize;
        ctx.lineCap = "round";
        ctx.strokeStyle = "white";
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y);
      }
    },
    [isDrawing, brushSize, screenToCanvas],
  );

  // Panning
  const startPanning = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.altKey || e.ctrlKey) {
      setIsPanning(true);
      setLastPanPoint({ x: e.clientX, y: e.clientY });
      e.preventDefault();
    }
  }, []);

  const panCanvas = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isPanning) return;

      const deltaX = e.clientX - lastPanPoint.x;
      const deltaY = e.clientY - lastPanPoint.y;

      setPanOffset((prev) => ({
        x: prev.x + deltaX,
        y: prev.y + deltaY,
      }));

      setLastPanPoint({ x: e.clientX, y: e.clientY });
    },
    [isPanning, lastPanPoint.x, lastPanPoint.y],
  );

  const stopPanning = useCallback(() => {
    setIsPanning(false);
  }, []);

  // Zoom
  const handleZoom = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.max(0.5, Math.min(3, zoomLevel * zoomFactor));
      setZoomLevel(newZoom);
    },
    [zoomLevel],
  );

  // --- autoFillEnclosedAreas and stopDrawing (unchanged, just kept as-is) ---
  const autoFillEnclosedAreas = useCallback((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const originalWidth = canvas.width;
    const originalHeight = canvas.height;

    const maxDimension = 512;
    const scale = Math.min(
      maxDimension / originalWidth,
      maxDimension / originalHeight,
      1,
    );
    const workWidth = Math.floor(originalWidth * scale);
    const workHeight = Math.floor(originalHeight * scale);

    const workCanvas = document.createElement("canvas");
    workCanvas.width = workWidth;
    workCanvas.height = workHeight;
    const workCtx = workCanvas.getContext("2d");
    if (!workCtx) return;

    workCtx.imageSmoothingEnabled = false;
    workCtx.drawImage(canvas, 0, 0, workWidth, workHeight);

    workCtx.globalCompositeOperation = "source-over";
    workCtx.filter = "blur(2px)";
    workCtx.drawImage(workCanvas, 0, 0);
    workCtx.filter = "none";

    const imageData = workCtx.getImageData(0, 0, workWidth, workHeight);
    const pixels = imageData.data;
    const filled = new Uint8ClampedArray(pixels);

    const visited = new Uint8Array(workWidth * workHeight);
    const queue: number[] = [];

    for (let x = 0; x < workWidth; x++) {
      const topIndex = x;
      const bottomIndex = (workHeight - 1) * workWidth + x;
      if (pixels[topIndex * 4] < 128) queue.push(topIndex);
      if (pixels[bottomIndex * 4] < 128) queue.push(bottomIndex);
    }
    for (let y = 0; y < workHeight; y++) {
      const leftIndex = y * workWidth;
      const rightIndex = y * workWidth + (workWidth - 1);
      if (pixels[leftIndex * 4] < 128) queue.push(leftIndex);
      if (pixels[rightIndex * 4] < 128) queue.push(rightIndex);
    }

    let queueStart = 0;
    while (queueStart < queue.length) {
      const pixelIndex = queue[queueStart++];
      if (visited[pixelIndex]) continue;
      visited[pixelIndex] = 1;

      const y = Math.floor(pixelIndex / workWidth);
      const x = pixelIndex % workWidth;

      const neighbors = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ];

      for (const [nx, ny] of neighbors) {
        if (nx >= 0 && nx < workWidth && ny >= 0 && ny < workHeight) {
          const nIndex = ny * workWidth + nx;
          if (!visited[nIndex] && pixels[nIndex * 4] < 128) {
            queue.push(nIndex);
          }
        }
      }
    }

    for (let i = 0; i < workWidth * workHeight; i++) {
      const pixelIndex = i * 4;
      if (pixels[pixelIndex] < 128 && !visited[i]) {
        filled[pixelIndex] = 255;
        filled[pixelIndex + 1] = 255;
        filled[pixelIndex + 2] = 255;
      }
    }

    const resultData = new ImageData(filled, workWidth, workHeight);
    workCtx.putImageData(resultData, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = "lighten";
    ctx.drawImage(workCanvas, 0, 0, originalWidth, originalHeight);
    ctx.globalCompositeOperation = "source-over";

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, []);

  const stopDrawing = useCallback(() => {
    setIsDrawing(false);
    const canvas = canvasRef.current;
    const previewCanvas = previewCanvasRef.current;
    if (!canvas || !previewCanvas) {
      console.warn("[region-editor] stopDrawing: no canvas ref");
      return;
    }
    console.log("[region-editor] stopDrawing: applying auto-fill...");
    setTimeout(() => {
      autoFillEnclosedAreas(canvas);
      console.log("[region-editor] stopDrawing: creating blob from canvas...");

      const dpr = window.devicePixelRatio || 1;
      const originalWidth = canvas.width / dpr;
      const originalHeight = canvas.height / dpr;

      console.log("[region-editor] Mask dimensions:", {
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        dpr,
        originalWidth,
        originalHeight,
      });

      const offscreenCanvas = document.createElement("canvas");
      offscreenCanvas.width = originalWidth;
      offscreenCanvas.height = originalHeight;
      const offscreenCtx = offscreenCanvas.getContext("2d");

      if (offscreenCtx) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        }

        offscreenCtx.drawImage(canvas, 0, 0, originalWidth, originalHeight);

        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        offscreenCanvas.toBlob(
          (blob) => {
            if (blob) {
              console.log(
                "[region-editor] ✅ Mask blob created successfully!",
              );
              console.log("[region-editor]    - Size:", blob.size, "bytes");
              console.log("[region-editor]    - Type:", blob.type);
              console.log(
                "[region-editor]    - Exported at:",
                originalWidth,
                "x",
                originalHeight,
              );

              const maskPreview = offscreenCanvas.toDataURL("image/png");
              console.log(
                "[region-editor] 📸 Mask preview (first 200 chars):",
                maskPreview.substring(0, 200),
              );

              setMaskData(blob);
            } else {
              console.error(
                "[region-editor] ❌ offscreenCanvas.toBlob returned null!",
              );
            }
          },
          "image/png",
        );
      }
    }, 100);
  }, [autoFillEnclosedAreas]);

  // Combined mouse handler
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (e.altKey || e.ctrlKey) {
        startPanning(e);
      } else {
        startDrawing(e);
      }
    },
    [startPanning, startDrawing],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (isPanning) {
        panCanvas(e);
      } else {
        draw(e);
      }
    },
    [isPanning, panCanvas, draw],
  );

  const handleMouseUp = useCallback(() => {
    stopDrawing();
    stopPanning();
  }, [stopDrawing, stopPanning]);

  const clearMask = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    setMaskData(null);
  }, []);

  // --- Region edit mutation with local polling (and optional parent hook) ---
  const regionEditMutation = useMutation({
    mutationFn: async (data: FormData) => {
      console.log(
        "[region-editor] ========== MUTATION FUNCTION STARTED ==========",
      );
      console.log(
        "[region-editor] 🚀 START: Submitting region-edit request...",
      );
      console.log("[region-editor] API endpoint:", api("/api/region-edit"));
      console.log("[region-editor] Request identifiers", { jobId, imageId });

      let response: Response;
      try {
        response = await fetch(api("/api/region-edit"), {
          method: "POST",
          body: data,
          credentials: "include",
        });
        console.log("[region-editor] ✅ Fetch completed successfully");
        console.log(
          "[region-editor]   - Status:",
          response.status,
          response.statusText,
        );
        console.log("[region-editor]   - response.ok:", response.ok);
      } catch (fetchError) {
        console.error(
          "[region-editor] ❌ FETCH FAILED (network error):",
          fetchError,
        );
        throw new Error(
          `Network error: ${
            fetchError instanceof Error ? fetchError.message : "Unknown error"
          }`,
        );
      }

      if (!response.ok) {
        let errorText = "";
        let parsed: any = null;
        try {
          errorText = await response.text();
          parsed = errorText ? JSON.parse(errorText) : null;
          console.error("[region-editor] ❌ HTTP ERROR - Response not OK", {
            status: response.status,
            statusText: response.statusText,
            body: parsed || errorText,
            jobId,
            imageId,
          });
        } catch {
          console.error(
            "[region-editor] ❌ HTTP ERROR - Could not read response body",
          );
        }

        if (parsed?.error === "image_not_found" || parsed?.error === "not_found") {
          const err: any = new Error("image_not_found");
          err.code = "image_not_found";
          err.payload = parsed;
          err.status = response.status;
          throw err;
        }

        throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
      }

      let result: { success: boolean; jobId?: string; error?: string };
      try {
        result = await response.json();
        console.log("[region-editor] ✅ Response JSON parsed successfully");
        console.log("[region-editor] Result keys:", Object.keys(result));
        console.log(
          "[region-editor] Result.success:",
          result.success,
          "(type:",
          typeof result.success,
          ")",
        );
        console.log(
          "[region-editor] Result.jobId:",
          result.jobId,
          "(type:",
          typeof result.jobId,
          ")",
        );
        console.log(
          "[region-editor] Full result:",
          JSON.stringify(result, null, 2),
        );
        console.log("[region-editor] region-edit response identifiers", {
          jobId,
          imageId,
          result,
        });
      } catch (jsonError) {
        console.error("[region-editor] ❌ JSON PARSE ERROR:", jsonError);
        throw new Error("Failed to parse server response");
      }

      console.log(
        "[region-editor] ========== MUTATION FUNCTION RETURNING ==========",
      );
      return result;
    },
    onMutate: () => {
      console.log(
        "[region-editor] onMutate: aborting any previous polling and signaling start",
      );
      pollingAbortRef.current.abort = true;
      onStart?.();
    },
    onSuccess: async (result: { success: boolean; jobId?: string; error?: string }) => {
      console.log(
        "[region-editor] ========== onSuccess HANDLER CALLED ==========",
      );
      console.log(
        "[region-editor] Full result object:",
        JSON.stringify(result, null, 2),
      );

      if (!result.success || !result.jobId) {
        console.error(
          "[region-editor] ❌ Invalid response - missing success or jobId",
        );
        toast({
          title: "Enhancement failed",
          description: result.error || "Could not start edit",
          variant: "destructive",
        });
        onError?.();
        return;
      }

      console.log(
        "[region-editor] ✅ Got jobId from /api/region-edit:",
        result.jobId,
      );
      console.log(
        `[region-editor] Batch status endpoint will be /api/status/batch?ids=${encodeURIComponent(
          result.jobId,
        )}`,
      );

      // Inform parent, but DO NOT exit – local polling still runs
      if (onJobStarted) {
        console.log(
          "[region-editor] 🧩 Notifying parent via onJobStarted (global batch polling will also track this job)",
        );
        onJobStarted(result.jobId);
      }

      // Always run local polling so the modal can update its preview image
      console.log(
        "[region-editor] ✅ Starting local polling so the edit modal can update the preview:",
        result.jobId,
      );

      let polling = true;
      let pollCount = 0;
      const localAbortRef = pollingAbortRef.current;

      const pollJob = async () => {
        if (localAbortRef.abort) {
          polling = false;
          console.log(
            "[region-editor] 🛑 Polling aborted (new request started or component unmounted)",
          );
          return;
        }
        try {
          const pollUrl = api(`/api/status/batch?ids=${result.jobId}`);
          console.log(
            `[region-editor] Polling attempt ${pollCount + 1} for job:`,
            result.jobId,
          );
          console.log("[region-editor] Polling URL:", pollUrl);
          const res = await fetch(pollUrl, { credentials: "include" });
          const json = await res.json();
          console.log("[region-editor] Poll response:", json);
          const item = json.items?.[0];
          if (item) {
            // PATCH 1: High-visibility log for item
            console.log("[DEBUG][region-editor] Item received:", {
              status: item.status,
              imageUrl: item.imageUrl,
              hasImageUrl: !!item.imageUrl,
              itemRaw: item,
            });

            const status = String(item.status || "").toLowerCase();
            const isCompleted =
              status === "completed" ||
              status === "done" ||
              status === "complete";

            // PATCH 2: Log status evaluation
            console.log("[DEBUG][region-editor] Status evaluation:", {
              status,
              isCompleted,
              abortFlag: localAbortRef.abort,
            });

            // PATCH 3: Log before completion condition
            console.log("[DEBUG][region-editor] Checking completion condition:", {
              isCompleted,
              hasImageUrl: !!item.imageUrl,
            });

            if (status === "failed") {
              polling = false;
              console.error("[region-editor] ❌ Job failed:", item.error);
              toast({
                title: "Enhancement failed",
                description: item.error || "Edit failed",
                variant: "destructive",
              });
              onError?.();
              return;
            }

            if (isCompleted && item.imageUrl) {
              polling = false;
              console.log(
                "[region-editor] ✅ Job completed with imageUrl:",
                item.imageUrl,
              );

                // 🔥 Cache-bust *for the preview only* so React + the browser
                // see a new image every time, even if the S3 key is reused
              // Always cache-bust the preview URL so React and the browser
              // re-render even when the S3 key stays identical
              const cacheBuster = `${Date.now()}`;
              const previewUrlWithVersion =
                item.imageUrl +
                (item.imageUrl.includes("?") ? "&" : "?") +
                "v=" + cacheBuster;

              console.log(
                "[region-editor] SETTING NEW PREVIEW URL:",
                previewUrlWithVersion,
              );

              // This must ALWAYS run—even on the second edit
              setPreviewUrl(previewUrlWithVersion);
              setSelectedFile(null);
              setMaskData(null);
              setZoomLevel(1);
              setPanOffset({ x: 0, y: 0 });

              if (regionEditMutation.reset) {
                setTimeout(() => regionEditMutation.reset(), 0);
              }

              // IMPORTANT: still pass the canonical URL (without cache-busting)
              // back to the parent/global state
              onComplete?.({
                imageUrl: item.imageUrl,
                originalUrl: item.originalUrl || "",
                maskUrl: item.maskUrl || "",
                mode: item.mode || "",
              });

              // Keep editor open so user can inspect or do further edits
              return;
            }
          }

          console.log("[region-editor] Still processing, will poll again...");
          // PATCH 4: Poll state
          console.log("[DEBUG][region-editor] Poll state:", {
            pollCount,
            abortFlag: localAbortRef.abort,
          });
        } catch (e) {
          polling = false;
          console.error("[region-editor] ❌ Poll error:", e);
          toast({
            title: "Enhancement failed",
            description:
              e instanceof Error
                ? e.message
                : "Network error while polling edit job",
            variant: "destructive",
          });
          onError?.();
          return;
        }

        pollCount++;
        if (polling) {
          setTimeout(
            pollJob,
            Math.min(2000 + pollCount * 500, 5000),
          );
        }
      };

      pollingAbortRef.current.abort = false;
      pollJob();
    },
    onError: (error) => {
      console.error("[region-editor] ❌ Mutation onError called with:", error);
      let errorMessage = "Network error";
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === "string") {
        errorMessage = error;
      } else if (error && typeof error === "object") {
        errorMessage = JSON.stringify(error);
      }

      if ((error as any)?.code === "image_not_found" || errorMessage === "image_not_found") {
        errorMessage = "Image is no longer available for editing. Please refresh or re-run enhancement.";
        console.warn("[region-editor] image_not_found from region-edit", {
          jobId,
          imageId,
          error,
        });
      }

      toast({
        title: "Enhancement failed",
        description: errorMessage,
        variant: "destructive",
      });
      onError?.();
    },
  });

  // handleSubmit (unchanged logic, just formatting)

  const handleSubmit = useCallback(async () => {
    console.log("[region-editor] ========== handleSubmit CALLED ==========");
    console.log("[region-editor] Mode:", mode);
    console.log("[region-editor] Has mask:", !!maskData);
    console.log("[region-editor] Instructions:", instructions);
    console.log("[region-editor] selectedFile:", !!selectedFile);
    console.log(
      "[region-editor] initialImageUrl:",
      effectiveInitialImageUrl?.substring(0, 80),
    );

    if (mode === "restore_original") {
      console.warn("[RegionEditor] 'restore_original' mode is disabled for v2.0");
      toast({
        title: "Feature disabled",
        description: "Restore Original will return in a future update.",
        variant: "default",
      });
      return;
    }

    // Derive Stage 1 base URL from Stage 2 filename if originalImageUrl not provided
    const derivedBaseFromInitial = !effectiveOriginalImageUrl
      ? deriveBaseFromInitial(effectiveInitialImageUrl)
      : null;

    // Compute baseImageUrl:
    // - For restore_original: use originalImageUrl (Stage 1) or derived base, never Stage 2
    // - For other modes: prefer originalImageUrl, fall back to initialImageUrl
    const baseImageUrl =
      mode === "restore_original"
        ? (effectiveOriginalImageUrl || derivedBaseFromInitial || "")
        : (effectiveOriginalImageUrl || effectiveInitialImageUrl || "");

    console.log("[region-editor] Mode:", mode);
    console.log("[region-editor] originalImageUrl:", effectiveOriginalImageUrl);
    console.log("[region-editor] initialImageUrl:", effectiveInitialImageUrl);
    console.log("[region-editor] derivedBaseFromInitial:", derivedBaseFromInitial);
    console.log("[region-editor] Final baseImageUrl:", baseImageUrl);

    try {
      if (!selectedFile && !effectiveInitialImageUrl) {
        toast({
          title: "No image",
          description: "Please select an image first",
          variant: "destructive",
        });
        return;
      }

      if (mode === "edit" && !instructions.trim()) {
        toast({
          title: "Instructions required",
          description: "Please provide instructions for Add/Remove/Replace",
          variant: "destructive",
        });
        return;
      }

      if (!maskData) {
        toast({
          title: "Mask required",
          description: "Please draw a region to edit or restore",
          variant: "destructive",
        });
        return;
      }

      let maskAsDataUrl = "";
      try {
        maskAsDataUrl = await new Promise<string>((resolve, reject) => {
          if (!maskData) {
            reject(new Error("No mask data"));
            return;
          }
          const reader = new FileReader();
          reader.onloadend = () => {
            if (typeof reader.result === "string") {
              resolve(reader.result);
            } else {
              reject(
                new Error("Failed to convert mask Blob to data URL"),
              );
            }
          };
          reader.onerror = reject;
          reader.readAsDataURL(maskData);
        });
        console.log(
          "[region-editor] ✅ Mask converted to data URL. Length:",
          maskAsDataUrl.length,
        );
      } catch (e) {
        console.error(
          "[region-editor] ❌ Failed to convert mask Blob to data URL:",
          e,
        );
        toast({
          title: "Mask error",
          description: "Failed to process mask data",
          variant: "destructive",
        });
        return;
      }

      const formData = new FormData();
      if (selectedFile) {
        formData.append("image", selectedFile);
      } else if (effectiveInitialImageUrl) {
        formData.append("imageUrl", effectiveInitialImageUrl);
      }
      // Always append baseImageUrl if present
      if (baseImageUrl) {
        formData.append("baseImageUrl", baseImageUrl);
      }
      if (imageId) {
        formData.append("imageId", imageId);
      }
      if (jobId) {
        formData.append("jobId", jobId);
      }
      formData.append("mode", mode);
      if (mode === "edit") {
        formData.append("goal", instructions);
      }
      formData.append("industry", industry);
      formData.append("sceneType", sceneType);
      if (roomType) {
        formData.append("roomType", roomType);
      }
      formData.append("preserveStructure", "true");
      formData.append("allowStaging", "false");
      formData.append("allowRetouch", "true");
      formData.append("regionMask", maskAsDataUrl);
      formData.append("smartReinstate", smartReinstate.toString());

      console.log("[region-editor] Submitting FormData:");
      for (const [key, value] of formData.entries()) {
        if (typeof value === "string") {
          console.log(
            `  - ${key}:`,
            value.length > 120 ? value.substring(0, 120) + "..." : value,
          );
        } else if (value instanceof File) {
          console.log(
            `  - ${key}: [File] name=${value.name}, size=${value.size}, type=${value.type}`,
          );
        }
      }

      if (!regionEditMutation || !regionEditMutation.mutate) {
        console.error(
          "[region-editor] ❌ regionEditMutation or .mutate is undefined!",
        );
        toast({
          title: "Enhancement failed",
          description: "Internal error: mutation not initialized",
          variant: "destructive",
        });
        onError?.();
        return;
      }

      regionEditMutation.mutate(formData);
      console.log(
        "[region-editor] ✅ Mutation.mutate() called successfully",
      );
    } catch (error) {
      console.error(
        "[region-editor] ❌❌❌ UNCAUGHT ERROR in handleSubmit:",
        error,
      );
      toast({
        title: "Enhancement failed",
        description:
          error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
      onError?.();
    }
  }, [
    selectedFile,
    effectiveInitialImageUrl,
    effectiveOriginalImageUrl,
    maskData,
    instructions,
    industry,
    mode,
    sceneType,
    roomType,
    smartReinstate,
    jobId,
    imageId,
    toast,
    onError,
    regionEditMutation,
  ]);

  const hasInstructions = instructions.trim().length > 0;
  const hasMask = maskData !== null;
  const isFormValid =
    (mode === "edit" && hasInstructions && hasMask) ||
    (mode === "restore_original" && hasMask);

  return (
    <div className="space-y-4 lg:space-y-6">
      <Card className="border border-slate-200 shadow-sm">
        <CardHeader className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between lg:gap-4">
          <div>
            <CardTitle className="text-xl font-semibold text-slate-900">Edit Image</CardTitle>
            <CardDescription className="text-sm text-slate-600">
              Draw a mask and describe what you want to add, remove, or replace.
            </CardDescription>
          </div>
          <Badge variant="secondary" className="flex items-center gap-1 border border-action-100 bg-action-50 text-action-700">
            <Sparkles className="h-4 w-4" /> AI-Assisted Edit
          </Badge>
        </CardHeader>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.7fr_1fr]">
        {/* Canvas Zone */}
        <Card className="border border-slate-200 shadow-sm overflow-hidden">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold text-slate-900">Mask & Preview</CardTitle>
            <CardDescription className="text-sm text-slate-600">Paint over the area you want to change. White = editable region.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 lg:space-y-4">
            {!effectiveInitialImageUrl && (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4">
                <Label htmlFor="image-upload" className="text-sm font-medium text-slate-700">Select Image</Label>
                <Input
                  id="image-upload"
                  type="file"
                  accept="image/*"
                  onChange={onFileSelect}
                  data-testid="input-region-image"
                  className="mt-2"
                />
              </div>
            )}

            {previewUrl && (
              <div className="space-y-3">
                <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-slate-100 shadow-sm">
                  {/* Floating toolbar */}
                  <div className="absolute left-4 top-4 z-10 flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-2 rounded-full bg-white/95 px-3 py-2 shadow-sm border border-slate-200">
                      <Brush className="h-4 w-4 text-slate-700" />
                      <div className="flex items-center gap-2 text-xs text-slate-700">
                        <span className="font-medium">Brush</span>
                        <input
                          type="range"
                          min="5"
                          max="50"
                          value={brushSize}
                          onChange={(e) => setBrushSize(Number(e.target.value))}
                          className="w-20"
                          data-testid="slider-brush-size"
                        />
                        <span className="w-10 text-right">{brushSize}px</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 rounded-full bg-white/95 px-3 py-2 shadow-sm border border-slate-200">
                      <Move className="h-4 w-4 text-slate-700" />
                      <span className="text-xs text-slate-700">Hold Alt/Ctrl + drag to pan</span>
                    </div>

                    <div className="flex items-center gap-1 rounded-full bg-white/95 px-2 py-2 shadow-sm border border-slate-200 text-slate-700">
                      <button
                        onClick={() => setZoomLevel(Math.max(0.5, zoomLevel - 0.25))}
                        disabled={zoomLevel <= 0.5}
                        className="flex items-center gap-1 rounded-full px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50"
                        data-testid="button-zoom-out"
                      >
                        <ZoomOut className="h-4 w-4" />
                      </button>
                      <span className="min-w-[46px] text-center text-xs font-medium">{Math.round(zoomLevel * 100)}%</span>
                      <button
                        onClick={() => setZoomLevel(Math.min(3, zoomLevel + 0.25))}
                        disabled={zoomLevel >= 3}
                        className="flex items-center gap-1 rounded-full px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50"
                        data-testid="button-zoom-in"
                      >
                        <ZoomIn className="h-4 w-4" />
                      </button>
                      <div className="mx-1 h-4 w-px bg-slate-200" />
                      <button
                        onClick={() => {
                          setZoomLevel(1);
                          setPanOffset({ x: 0, y: 0 });
                        }}
                        className="flex items-center gap-1 rounded-full px-2 py-1 text-xs hover:bg-slate-100"
                        data-testid="button-reset-view"
                      >
                        <RotateCcw className="h-4 w-4" />
                        Reset
                      </button>
                    </div>
                  </div>

                  {imageLoading && (
                    <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm">
                      <div className="text-center text-white">
                        <div className="mx-auto mb-3 h-12 w-12 animate-spin rounded-full border-2 border-white/30 border-b-white" />
                        <p className="text-sm font-medium">Loading image...</p>
                      </div>
                    </div>
                  )}

                  <div
                    className="relative h-full w-full"
                    style={{
                      minHeight: "620px",
                      transform: `scale(${zoomLevel}) translate(${panOffset.x / zoomLevel}px, ${panOffset.y / zoomLevel}px)`,
                      transformOrigin: "top left",
                    }}
                  >
                    {!previewUrl && !imageLoading && (
                      <div className="absolute inset-0 flex items-center justify-center text-slate-500">
                        <p>No image loaded. Please select an image file above.</p>
                      </div>
                    )}
                    <canvas
                      ref={previewCanvasRef}
                      className="absolute inset-0 h-full w-full object-contain"
                      style={{ display: previewUrl ? "block" : "none" }}
                    />
                    <canvas
                      ref={canvasRef}
                      className="absolute inset-0 h-full w-full object-contain opacity-60"
                      onMouseDown={handleMouseDown}
                      onMouseMove={handleMouseMove}
                      onMouseUp={handleMouseUp}
                      onMouseLeave={handleMouseUp}
                      onWheel={handleZoom}
                      style={{
                        cursor: isPanning
                          ? "grabbing"
                          : isDrawing
                            ? "crosshair"
                            : "crosshair",
                        display: previewUrl ? "block" : "none",
                      }}
                      data-testid="canvas-mask-drawing"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span>White areas will be edited. Alt/Ctrl + drag to pan, scroll to zoom.</span>
                  <Button
                    onClick={clearMask}
                    variant="outline"
                    size="sm"
                    data-testid="button-clear-mask"
                  >
                    Clear Mask
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Controls Panel */}
        <Card className="border border-slate-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold text-slate-900">Edit Settings</CardTitle>
            <CardDescription className="text-sm text-slate-600">Provide clear instructions, then choose the operation and context.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="instructions" className="text-sm font-semibold text-slate-900">
                  Instructions {mode === "edit" && <span className="text-red-500">*</span>}
                </Label>
                <span className="text-[11px] text-slate-500">Be specific.</span>
              </div>
              <Textarea
                id="instructions"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder={"e.g., Remove the couch and add a modern armchair.\nReplace the plant with a floor lamp."}
                rows={4}
                data-testid="textarea-instructions"
                className={`${mode === "edit" && !instructions.trim() ? "border-red-200 focus:border-red-300" : ""} resize-none`}
              />
              <p className="text-xs text-slate-500">Be specific. The AI preserves walls, doors, and windows.</p>
            </div>

            <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="mode" className="text-sm font-semibold text-slate-900">
                  Operation <span className="text-red-500">*</span>
                </Label>
              </div>
              <Select
                value={mode}
                onValueChange={(v) => setMode("edit")}
              >
                <SelectTrigger data-testid="select-mode">
                  <SelectValue placeholder="Choose Option" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="edit">Add / Remove / Replace (requires text)</SelectItem>
                  {false && (
                    <SelectItem value="restore_original">
                      Restore Original (no text required)
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-1 gap-3">
              <div className="space-y-2">
                <Label htmlFor="scene-type" className="text-sm font-semibold text-slate-900">Scene Type</Label>
                <Select
                  value={sceneType}
                  onValueChange={(v) => setSceneType(v as "auto" | "interior" | "exterior")}
                >
                  <SelectTrigger id="scene-type" data-testid="select-scene-type">
                    <SelectValue placeholder="Auto-detect" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    <SelectItem value="interior">Interior</SelectItem>
                    <SelectItem value="exterior">Exterior</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="room-type" className="text-sm font-semibold text-slate-900">Room Type</Label>
                <Select
                  value={roomType}
                  onValueChange={(v) => setRoomType(v)}
                >
                  <SelectTrigger id="room-type" data-testid="select-room-type">
                    <SelectValue placeholder="Auto-detect" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    <SelectItem value="living_room">Living Room</SelectItem>
                    <SelectItem value="bedroom">Bedroom</SelectItem>
                    <SelectItem value="kitchen">Kitchen</SelectItem>
                    <SelectItem value="bathroom">Bathroom</SelectItem>
                    <SelectItem value="dining">Dining</SelectItem>
                    <SelectItem value="exterior">Exterior</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <Input
                id="smart-reinstate"
                type="checkbox"
                checked={smartReinstate}
                onChange={(e) => setSmartReinstate(e.target.checked)}
                className="mt-1 h-4 w-4"
              />
              <div className="space-y-1">
                <Label htmlFor="smart-reinstate" className="text-sm font-semibold text-slate-900 cursor-pointer">
                  Smart Reinstate
                </Label>
                <p className="text-xs text-slate-600">Keeps structure and boundaries intact (recommended).</p>
              </div>
            </div>
          </CardContent>

          <div className="border-t border-slate-200 bg-white px-4 py-3">
            <div className="flex items-center justify-between text-xs text-slate-600">
              {mode === "edit" ? (
                <span>
                  Requires <span className="font-semibold">instructions</span> and a <span className="font-semibold">mask</span>.
                </span>
              ) : (
                <span>Restore Original is temporarily disabled.</span>
              )}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  pollingAbortRef.current.abort = true;
                  onCancel?.();
                }}
                data-testid="button-cancel-region-edit"
                className="w-full"
              >
                Cancel
              </Button>

              <Button
                type="button"
                onClick={handleSubmit}
                disabled={!isFormValid || regionEditMutation.isPending}
                data-testid="button-apply-region-edit"
                className="w-full bg-action-600 text-white hover:bg-action-700"
              >
                {regionEditMutation.isPending ? "Applying edit..." : "Apply Edit"}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

