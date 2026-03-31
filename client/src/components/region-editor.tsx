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
import { Brush, ZoomIn, ZoomOut, Move, RotateCcw, Sparkles, Loader2 } from "lucide-react";

function stripTransientQueryParams(urlValue?: string | null): string {
  if (!urlValue) return "";
  try {
    const parsed = new URL(urlValue);
    const transientParams = ["v", "t", "ts", "cb", "cacheBust"];
    transientParams.forEach((key) => parsed.searchParams.delete(key));
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return urlValue;
  }
}

function inferEditIntentFromInstruction(instruction: string): "add" | "remove" | "replace" {
  const text = String(instruction || "").toLowerCase();
  if (text.includes("remove") || text.includes("delete") || text.includes("take out")) return "remove";
  if (text.includes("add") || text.includes("place") || text.includes("insert")) return "add";
  return "replace";
}

interface RegionEditorProps {
  onComplete?: (result: {
    imageUrl: string;
    originalUrl: string;
    maskUrl: string;
    jobId?: string | null;
    mode?: string;
    shouldAutoClose?: boolean;
  }) => void;
  onCancel?: () => void;
  onStart?: () => void; // Called when processing starts (for immediate UI feedback)
  onError?: (errorMessage?: string) => void; // Called when processing fails
  onJobStarted?: (jobId: string) => void; // Optional: delegate polling to parent
  initialImageUrl?: string;
  originalImageUrl?: string; // URL to original image for pixel-level restoration
  editSourceUrl?: string;
  editSourceStage?: "original" | "1A" | "1B" | "2" | "retry" | "edit";
  sourceJobId?: string;
  currentCardJobId?: string;
  sourceImageId?: string;
  initialGoal?: string;
  initialIndustry?: string;
  initialSceneType?: "auto" | "interior" | "exterior";
  initialRoomType?: string;
}

export function RegionEditor({
  onComplete,
  onCancel,
  onStart,
  onError,
  onJobStarted,
  initialImageUrl,
  originalImageUrl,
  editSourceUrl,
  editSourceStage,
  sourceJobId,
  currentCardJobId,
  sourceImageId,
  initialGoal,
  initialIndustry,
  initialSceneType,
  initialRoomType,
}: RegionEditorProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(
    initialImageUrl || null,
  );

  // Only two modes: 'edit' and 'restore_original'
  const [mode, setMode] = useState<"edit" | "restore_original">("edit");
  // NOTE: Restore Original temporarily disabled for RealEnhance v2.0 launch.
  // This mode will be re-enabled in v3.0 when the multi-stage pipeline is finalized.

  // Debug: Log incoming props on mount and when they change
  useEffect(() => {
    console.log('[RegionEditor] initialImageUrl:', initialImageUrl);
    console.log('[RegionEditor] originalImageUrl:', originalImageUrl);
    console.log('[RegionEditor] editSourceUrl:', editSourceUrl);
    console.log('[RegionEditor] editSourceStage:', editSourceStage);
    console.log('[RegionEditor] sourceJobId:', sourceJobId);
    console.log('[RegionEditor] currentCardJobId:', currentCardJobId);
  }, [initialImageUrl, originalImageUrl, editSourceUrl, editSourceStage, sourceJobId, currentCardJobId]);
  // Quick high-level prop + derived base log for easier debugging of restore flow
  useEffect(() => {
    const strictSource = editSourceUrl || "";
    console.log('[RegionEditor] props summary:', { mode, initialImageUrl, originalImageUrl, editSourceUrl, editSourceStage, sourceJobId, currentCardJobId, strictSource });
  }, [mode, initialImageUrl, originalImageUrl, editSourceUrl, editSourceStage, sourceJobId, currentCardJobId]);

  // Reset state when a new image/meta is provided (opening editor for another item)
  useEffect(() => {
    setInstructions(initialGoal || "");
    setIndustry(initialIndustry || "Real Estate");
    setSceneType(initialSceneType || "auto");
    setRoomType(initialRoomType || "auto");
    setPreviewUrl(initialImageUrl || null);
    setMaskData(null);
  }, [initialGoal, initialIndustry, initialSceneType, initialRoomType, initialImageUrl]);
  const [maskData, setMaskData] = useState<Blob | null>(null);
  const [instructions, setInstructions] = useState(initialGoal || "");
  const [industry, setIndustry] = useState(initialIndustry || "Real Estate");
  const [sceneType, setSceneType] = useState<
    "auto" | "interior" | "exterior"
  >(initialSceneType || "auto");
  const [smartReinstate, setSmartReinstate] = useState(true);
  const [isDrawing, setIsDrawing] = useState(false);
  const [brushSize, setBrushSize] = useState(20);
  const [baseFitScale, setBaseFitScale] = useState(1);
  const [userZoom, setUserZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPoint, setLastPanPoint] = useState({ x: 0, y: 0 });
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [workspaceSize, setWorkspaceSize] = useState({ width: 0, height: 0 });
  // 🔒 Auto-close control: signals parent that edit completed successfully
  const [shouldAutoClose, setShouldAutoClose] = useState(false);
  // Staging style is now batch-level only; removed from region editor
  const [roomType, setRoomType] = useState<string>(initialRoomType || "auto");
  const [imageLoading, setImageLoading] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const pollingAbortRef = useRef<{ abort: boolean }>({ abort: false });
  const workspaceRef = useRef<HTMLElement>(null);

  const { toast } = useToast();
  const effectiveScale = baseFitScale * userZoom;

  const applyCanvasDisplaySize = useCallback(
    (imageWidth: number, imageHeight: number, scale: number) => {
      const canvas = canvasRef.current;
      const previewCanvas = previewCanvasRef.current;
      if (!canvas || !previewCanvas) return;

      const displayWidth = Math.max(1, Math.round(imageWidth * scale));
      const displayHeight = Math.max(1, Math.round(imageHeight * scale));

      canvas.style.width = `${displayWidth}px`;
      canvas.style.height = `${displayHeight}px`;
      previewCanvas.style.width = `${displayWidth}px`;
      previewCanvas.style.height = `${displayHeight}px`;
    },
    [],
  );

  const initializeCanvasesForImage = useCallback(
    (img: HTMLImageElement) => {
      const canvas = canvasRef.current;
      const previewCanvas = previewCanvasRef.current;
      if (!canvas || !previewCanvas) return;

      const imageWidth = img.naturalWidth || img.width;
      const imageHeight = img.naturalHeight || img.height;
      const dpr = window.devicePixelRatio || 1;

      setImageSize({ width: imageWidth, height: imageHeight });

      canvas.width = Math.max(1, Math.round(imageWidth * dpr));
      canvas.height = Math.max(1, Math.round(imageHeight * dpr));
      previewCanvas.width = Math.max(1, Math.round(imageWidth * dpr));
      previewCanvas.height = Math.max(1, Math.round(imageHeight * dpr));

      applyCanvasDisplaySize(imageWidth, imageHeight, effectiveScale);

      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.scale(dpr, dpr);
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, imageWidth, imageHeight);
      }

      const previewCtx = previewCanvas.getContext("2d");
      if (previewCtx) {
        previewCtx.setTransform(1, 0, 0, 1, 0, 0);
        previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
        previewCtx.scale(dpr, dpr);
        previewCtx.drawImage(img, 0, 0, imageWidth, imageHeight);
      }

      imageRef.current = img;
    },
    [applyCanvasDisplaySize, effectiveScale],
  );

  useEffect(() => {
    const updateWorkspaceSize = () => {
      const workspaceEl = workspaceRef.current;
      if (!workspaceEl) return;
      const rect = workspaceEl.getBoundingClientRect();
      setWorkspaceSize({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };

    updateWorkspaceSize();

    let observer: ResizeObserver | null = null;
    if (workspaceRef.current && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(updateWorkspaceSize);
      observer.observe(workspaceRef.current);
    }

    window.addEventListener("resize", updateWorkspaceSize);
    return () => {
      window.removeEventListener("resize", updateWorkspaceSize);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (
      imageSize.width <= 0 ||
      imageSize.height <= 0 ||
      workspaceSize.width <= 0 ||
      workspaceSize.height <= 0
    ) {
      return;
    }

    const fitScale = Math.min(
      workspaceSize.width / imageSize.width,
      workspaceSize.height / imageSize.height,
      1,
    );
    setBaseFitScale(Number.isFinite(fitScale) && fitScale > 0 ? fitScale : 1);
  }, [imageSize.height, imageSize.width, workspaceSize.height, workspaceSize.width]);

  useEffect(() => {
    if (imageSize.width <= 0 || imageSize.height <= 0) return;
    applyCanvasDisplaySize(imageSize.width, imageSize.height, effectiveScale);
  }, [applyCanvasDisplaySize, effectiveScale, imageSize.height, imageSize.width]);

  useEffect(() => {
    if (userZoom <= 1) {
      setIsPanning(false);
      setPanOffset((prev) =>
        prev.x === 0 && prev.y === 0 ? prev : { x: 0, y: 0 },
      );
    }
  }, [userZoom]);

  // Redraw preview and mask canvases whenever previewUrl changes
  useEffect(() => {
    if (!previewUrl) return;
    setImageLoading(true);
    let cancelled = false;
    let retryCount = 0;
    const maxRetries = 3;

    const loadImage = () => {
      const img = new window.Image();
      img.onload = () => {
        if (cancelled) return;
        setImageLoading(false);
        initializeCanvasesForImage(img);
      };
      img.onerror = () => {
        if (cancelled) return;
        retryCount += 1;
        if (retryCount < maxRetries) {
          const retryDelay = 500 * Math.pow(2, retryCount - 1);
          setTimeout(loadImage, retryDelay);
          return;
        }
        setImageLoading(false);
      };
      img.src = previewUrl;
    };

    loadImage();
    return () => {
      cancelled = true;
    };
  }, [initializeCanvasesForImage, previewUrl]);

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
    },
    [toast],
  );

  // Map pointer position into image-space coordinates.
  const getImageCoords = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();

      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        imageSize.width <= 0 ||
        imageSize.height <= 0
      ) {
        return { x: 0, y: 0 };
      }

      const normalizedX = (e.clientX - rect.left) / rect.width;
      const normalizedY = (e.clientY - rect.top) / rect.height;
      const clampedX = Math.min(1, Math.max(0, normalizedX));
      const clampedY = Math.min(1, Math.max(0, normalizedY));

      const x = Math.min(
        imageSize.width - 1,
        Math.max(0, Math.round(clampedX * imageSize.width)),
      );
      const y = Math.min(
        imageSize.height - 1,
        Math.max(0, Math.round(clampedY * imageSize.height)),
      );

      return { x, y };
    },
    [imageSize.height, imageSize.width],
  );

  // Drawing functions for mask creation
  const startDrawing = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      setIsDrawing(true);
      const { x, y } = getImageCoords(e);
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (ctx) {
        ctx.beginPath();
        ctx.moveTo(x, y);
      }
    },
    [getImageCoords],
  );

  const draw = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDrawing) return;
      const { x, y } = getImageCoords(e);
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (ctx) {
        // Keep brush radius stable in image space across zoom levels.
        ctx.lineWidth = brushSize;
        ctx.lineCap = "round";
        ctx.strokeStyle = "white";
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y);
      }
    },
    [brushSize, getImageCoords, isDrawing],
  );

  // Panning
  const startPanning = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if ((e.altKey || e.ctrlKey) && userZoom > 1) {
      setIsPanning(true);
      setLastPanPoint({ x: e.clientX, y: e.clientY });
      e.preventDefault();
    }
  }, [userZoom]);

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
      const newZoom = Math.max(0.5, Math.min(3, userZoom * zoomFactor));
      setUserZoom(newZoom);
    },
    [userZoom],
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
      
      // ✅ Validate mask matches image dimensions
      const imageElem = imageRef.current;
      const imageDimensions = {
        width: imageElem?.naturalWidth || 0,
        height: imageElem?.naturalHeight || 0
      };
      const dimensionMatch = originalWidth === imageDimensions.width && 
                            originalHeight === imageDimensions.height;
      
      console.log("[region-editor] 🔍 Mask-to-Image dimension check:", {
        maskWidth: originalWidth,
        maskHeight: originalHeight,
        imageWidth: imageDimensions.width,
        imageHeight: imageDimensions.height,
        dimensionsMatch: dimensionMatch
      });
      
      if (!dimensionMatch) {
        console.warn("[region-editor] ⚠️ Mask dimensions don't match image - mask may not align correctly");
      }

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
        if (userZoom > 1) {
          startPanning(e);
        }
        return;
      }
      startDrawing(e);
    },
    [startDrawing, startPanning, userZoom],
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

      let response: Response;
      try {
        // AUDIT FIX: added timeout to prevent hung region-edit submit
        response = await fetch(api("/api/region-edit"), {
          method: "POST",
          body: data,
          credentials: "include",
          signal: AbortSignal.timeout(30_000),
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
        let errorMessage = response.statusText;
        try {
          const errorData = await response.json();
          console.error("[region-editor] ❌ HTTP ERROR - Response not OK");
          console.error("[region-editor]   - Status:", response.status);
          console.error("[region-editor]   - Response body:", errorData);
          // Extract user-friendly message if available
          errorMessage = errorData.message || errorData.error || response.statusText;
        } catch {
          console.error(
            "[region-editor] ❌ HTTP ERROR - Could not read response body",
          );
        }
        throw new Error(errorMessage);
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
        onError?.(result.error || "Could not start edit");
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

      // If parent handles job polling, delegate and stop here
      if (onJobStarted) {
        console.log(
          "[region-editor] 🧩 Notifying parent via onJobStarted (delegating polling to parent)",
        );
        onJobStarted(result.jobId);
        return;
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
          // AUDIT FIX: added timeout to prevent hung poll requests
          const res = await fetch(pollUrl, { credentials: "include", signal: AbortSignal.timeout(15_000) });
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
              onError?.(item.error || "Edit failed");
              return;
            }

            if (isCompleted && item.imageUrl) {
              polling = false;
              console.log(
                "[region-editor] ✅ Job completed with imageUrl:",
                item.imageUrl,
              );

              // 🔒 Single preview update at completion (no intermediate updates)
              const cacheBuster = `${Date.now()}`;
              const previewUrlWithVersion =
                item.imageUrl +
                (item.imageUrl.includes("?") ? "&" : "?") +
                "v=" + cacheBuster;

              console.log(
                "[region-editor] SETTING NEW PREVIEW URL:",
                previewUrlWithVersion,
              );

              // Update preview and reset editor state
              setPreviewUrl(previewUrlWithVersion);
              setSelectedFile(null);
              setMaskData(null);
              setUserZoom(1);
              setPanOffset({ x: 0, y: 0 });

              if (regionEditMutation.reset) {
                setTimeout(() => regionEditMutation.reset(), 0);
              }

              // 🖼️ Show success toast
              toast({
                title: "Edit completed",
                description: "Your image has been successfully edited",
              });
              
              // 🔒 Signal auto-close to parent
              setShouldAutoClose(true);

              // IMPORTANT: pass canonical URL (without cache-busting) to parent
              onComplete?.({
                imageUrl: item.imageUrl,
                originalUrl: item.originalUrl || "",
                maskUrl: item.maskUrl || "",
                jobId: result.jobId || item.id || null,
                mode: item.mode || "",
                shouldAutoClose: true, // 🔒 Tell parent to close modal automatically
              });

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
          onError?.(
            e instanceof Error
              ? e.message
              : "Network error while polling edit job"
          );
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

      toast({
        title: "Enhancement failed",
        description: errorMessage,
        variant: "destructive",
      });
      onError?.(errorMessage);
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
      initialImageUrl?.substring(0, 80),
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

    // Source is locked at click-time by parent UI and must be trusted as-is.
    const rawEditSourceUrl = editSourceUrl || "";
    const sanitizedEditSourceUrl = stripTransientQueryParams(rawEditSourceUrl);
    const baseImageUrlRaw =
      (mode as string) === "restore_original"
        ? (originalImageUrl || "")
        : rawEditSourceUrl;
    const baseImageUrl = stripTransientQueryParams(baseImageUrlRaw);

    console.log("[region-editor] Mode:", mode);
    console.log("[region-editor] originalImageUrl:", originalImageUrl);
    console.log("[region-editor] editSourceUrl:", editSourceUrl);
    console.log("[region-editor] editSourceStage:", editSourceStage);
    console.log("[region-editor] sourceJobId:", sourceJobId);
    console.log("[region-editor] initialImageUrl:", initialImageUrl);
    console.log("[region-editor] sanitizedEditSourceUrl:", sanitizedEditSourceUrl);
    console.log("[region-editor] Final baseImageUrl:", baseImageUrl);

    try {
      if (!selectedFile && !sanitizedEditSourceUrl) {
        toast({
          title: "No image",
          description: "Please select an image first",
          variant: "destructive",
        });
        return;
      }

      if (!sanitizedEditSourceUrl) {
        toast({
          title: "Missing source image",
          description: "The selected tab does not have a valid source URL.",
          variant: "destructive",
        });
        return;
      }

      if (!editSourceStage) {
        toast({
          title: "Missing source stage",
          description: "The selected tab does not have a valid source stage.",
          variant: "destructive",
        });
        return;
      }

      if (!sourceJobId) {
        toast({
          title: "Missing source lineage",
          description: "This edit source is missing a parent job reference. Please refresh and try again.",
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
      } else if (sanitizedEditSourceUrl) {
        formData.append("imageUrl", sanitizedEditSourceUrl);
      }
      // Always append baseImageUrl if present
      if (baseImageUrl) {
        formData.append("baseImageUrl", baseImageUrl);
      }
      formData.append("sourceUrl", sanitizedEditSourceUrl);
      formData.append("sourceStage", editSourceStage);
      formData.append("uiSelectedTab", editSourceStage);
      formData.append("editSourceUrl", sanitizedEditSourceUrl);
      formData.append("editSourceStage", editSourceStage);
      if (sourceJobId) {
        formData.append("jobId", sourceJobId);
      }
      if (currentCardJobId) {
        formData.append("currentCardJobId", currentCardJobId);
      }
      if (sourceImageId) {
        formData.append("imageId", sourceImageId);
      }
      formData.append("mode", mode);
      if (mode === "edit") {
        formData.append("goal", instructions);
        formData.append("editIntent", inferEditIntentFromInstruction(instructions));
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
    initialImageUrl,
    originalImageUrl,
    editSourceUrl,
    editSourceStage,
    sourceJobId,
    maskData,
    instructions,
    industry,
    mode,
    sceneType,
    roomType,
    smartReinstate,
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
    <div className="grid h-screen w-screen grid-cols-1 grid-rows-[minmax(0,1fr)_auto] bg-slate-50 rounded-none overflow-hidden lg:grid-cols-[280px_minmax(0,1fr)_320px]">
      <aside className="h-full border-b border-slate-200 bg-white p-6 lg:border-b-0 lg:border-r lg:overflow-y-auto flex flex-col">
        <div className="space-y-2">
          <h2 className="text-xl font-semibold text-slate-900">Edit Image</h2>
          <p className="text-sm text-slate-600">
            Draw a mask and describe what you want to add, remove, or replace.
          </p>
        </div>

        {!initialImageUrl && (
          <div className="mt-6 rounded-lg border border-dashed border-slate-300 bg-white p-4 w-full">
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

        <div className="mt-6 min-h-[220px] rounded-lg border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Controls</p>
          <p className="mt-2 text-sm text-slate-600">
            Sidebar placeholder for advanced edit controls.
          </p>
        </div>
      </aside>

      <section ref={workspaceRef} className="relative flex flex-1 items-center justify-center h-full w-full min-h-0 bg-[#f1f5f9] overflow-hidden lg:col-start-2">
        <div className="flex h-full w-full items-center justify-center p-0">
          {previewUrl ? (
            <div className="relative flex flex-1 h-full w-full items-center justify-center overflow-hidden">
              {/* Unified toolbar row - anchored to center workspace only */}
              <div className="absolute left-1/2 top-4 z-20 -translate-x-1/2 flex items-center gap-3 rounded-2xl border border-slate-200 bg-white/90 px-3 py-2 shadow-xl backdrop-blur-md">
                <div className="flex items-center gap-2 text-xs text-slate-700">
                  <Brush className="h-4 w-4 text-slate-700" />
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

                <div className="h-5 w-px bg-slate-200" />

                <div className="flex items-center gap-2 text-xs text-slate-700">
                  <Move className="h-4 w-4 text-slate-700" />
                  <span>Hold Alt/Ctrl + drag to pan</span>
                </div>

                <div className="h-5 w-px bg-slate-200" />

                <div className="flex items-center gap-1 text-slate-700">
                  <button
                    onClick={() => setUserZoom(Math.max(0.5, userZoom - 0.25))}
                    disabled={userZoom <= 0.5}
                    className="flex items-center gap-1 rounded-full px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50"
                    data-testid="button-zoom-out"
                  >
                    <ZoomOut className="h-4 w-4" />
                  </button>
                  <span className="min-w-[46px] text-center text-xs font-medium">{Math.round(userZoom * 100)}%</span>
                  <button
                    onClick={() => setUserZoom(Math.min(3, userZoom + 0.25))}
                    disabled={userZoom >= 3}
                    className="flex items-center gap-1 rounded-full px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50"
                    data-testid="button-zoom-in"
                  >
                    <ZoomIn className="h-4 w-4" />
                  </button>
                  <div className="mx-1 h-4 w-px bg-slate-200" />
                  <button
                    onClick={() => {
                      setUserZoom(1);
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

              {regionEditMutation.isPending && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm">
                  <div className="bg-white rounded-lg p-6 shadow-xl flex flex-col items-center gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-brand-600" />
                    <p className="text-sm font-medium text-slate-700">Processing edit...</p>
                    <p className="text-xs text-slate-500">This may take 10-30 seconds</p>
                  </div>
                </div>
              )}

              <div
                className="relative h-full w-full overflow-hidden flex justify-center items-center"
                style={{
                  transform: `translate(${userZoom > 1 ? panOffset.x : 0}px, ${userZoom > 1 ? panOffset.y : 0}px)`,
                  transformOrigin: "center",
                }}
              >
                {!previewUrl && !imageLoading && (
                  <div className="absolute inset-0 flex items-center justify-center text-slate-500">
                    <p>No image loaded. Please select an image file above.</p>
                  </div>
                )}
                <canvas
                  ref={previewCanvasRef}
                  className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 object-contain"
                  style={{ display: previewUrl ? "block" : "none" }}
                />
                <canvas
                  ref={canvasRef}
                  className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 object-contain opacity-60"
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
          ) : (
            <div className="flex h-full w-full items-center justify-center border-dashed border-slate-300 bg-slate-50 text-slate-500">
              <p className="text-sm">No image loaded. Please select an image file.</p>
            </div>
          )}
        </div>
      </section>

      <aside className="h-full border-t border-slate-200 bg-white p-6 lg:col-start-3 lg:border-t-0 lg:border-l lg:overflow-y-auto flex flex-col">
        <div className="space-y-2 flex-1">
          <Label htmlFor="instructions" className="text-sm font-medium text-slate-800">
            Describe what you want to add, remove, or replace
          </Label>
          <textarea
            id="instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Describe what you want to add, remove, or replace..."
            data-testid="input-instructions"
            className={`min-h-[220px] w-full rounded-md border bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-action-500 ${mode === "edit" && !instructions.trim() ? "border-red-200 focus-visible:ring-red-300" : "border-slate-300"}`}
          />
          <p className="text-xs text-slate-500">Be specific for best results.</p>
        </div>
      </aside>

      <div className="col-span-full grid grid-cols-1 border-t border-slate-200 bg-white shadow-[0_-4px_10px_rgba(0,0,0,0.02)] z-10 lg:grid-cols-[280px_minmax(0,1fr)_320px]">
        <div className="px-4 py-2 flex items-center lg:px-6 lg:py-3">
          <Button
            onClick={clearMask}
            variant="outline"
            size="sm"
            data-testid="button-clear-mask"
          >
            Clear Mask
          </Button>
        </div>

        <div className="px-4 py-2 text-xs text-slate-500 lg:px-6 lg:py-3 flex items-center justify-center">
          <span>White areas will be edited. Alt/Ctrl + drag to pan, scroll to zoom.</span>
        </div>

        <div className="px-4 py-2 lg:px-6 lg:py-3 flex items-center justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              pollingAbortRef.current.abort = true;
              onCancel?.();
            }}
            data-testid="button-cancel-region-edit"
          >
            Cancel
          </Button>

          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!isFormValid || regionEditMutation.isPending}
            data-testid="button-apply-region-edit"
            className="bg-action-600 text-white hover:bg-action-700"
          >
            {regionEditMutation.isPending ? "Applying edit..." : "Apply Edit"}
          </Button>
        </div>
      </div>
    </div>
  );
}

