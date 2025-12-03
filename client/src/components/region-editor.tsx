import React, { useState, useRef, useCallback, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

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
  initialImageUrl,
  originalImageUrl,
  initialGoal,
  initialIndustry,
}: RegionEditorProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(
    initialImageUrl || null,
  );
  const [maskData, setMaskData] = useState<Blob | null>(null);
  const [instructions, setInstructions] = useState(initialGoal || "");
  const [industry, setIndustry] = useState(initialIndustry || "Real Estate");
  // Only two modes: 'edit' and 'restore_original'
  const [mode, setMode] = useState<"edit" | "restore_original">("edit");
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

  const { toast } = useToast();

  // Redraw preview and mask canvases whenever previewUrl changes
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
    if (initialImageUrl && !selectedFile) {
      console.log("Loading initial image URL:", initialImageUrl);
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
          if (imageRef.current) {
            imageRef.current.src = initialImageUrl;
          }
        };

        img.onerror = (error) => {
          retryCount++;
          console.error(
            `Failed to load initial image (attempt ${retryCount}/${maxRetries}):`,
            initialImageUrl,
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

        img.src = initialImageUrl;
      };

      loadImage();
    }
  }, [initialImageUrl, selectedFile, toast]);

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
        try {
          errorText = await response.text();
          console.error("[region-editor] ❌ HTTP ERROR - Response not OK");
          console.error("[region-editor]   - Status:", response.status);
          console.error("[region-editor]   - Response body:", errorText);
        } catch {
          console.error(
            "[region-editor] ❌ HTTP ERROR - Could not read response body",
          );
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
      initialImageUrl?.substring(0, 80),
    );

    try {
      if (!selectedFile && !initialImageUrl) {
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
      } else if (initialImageUrl) {
        formData.append("imageUrl", initialImageUrl);
        if (originalImageUrl) {
          formData.append("baseImageUrl", originalImageUrl);
        }
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
    initialImageUrl,
    originalImageUrl,
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
    <div className="space-y-6">
      {!initialImageUrl && (
        <div>
          <Label htmlFor="image-upload">Select Image</Label>
          <Input
            id="image-upload"
            type="file"
            accept="image/*"
            onChange={onFileSelect}
            data-testid="input-region-image"
          />
        </div>
      )}

      {previewUrl && (
        <div className="space-y-4">
          <div>
            <Label className="text-base font-medium">
              Draw Region Mask (white = selected area)
            </Label>
            <p className="mt-1 mb-3 text-sm text-gray-600">
              Draw on the image to mark the region. Use Alt/Ctrl + drag to pan,
              mouse wheel to zoom.
            </p>

            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg bg-brand-light p-2">
              <div className="flex items-center gap-1.5">
                <Label className="text-xs">Brush:</Label>
                <input
                  type="range"
                  min="5"
                  max="50"
                  value={brushSize}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                  className="w-16"
                  data-testid="slider-brush-size"
                />
                <span className="w-7 text-xs text-gray-600">
                  {brushSize}px
                </span>
              </div>

              <div className="flex items-center gap-1.5">
                <Label className="text-xs">Zoom:</Label>
                <button
                  onClick={() =>
                    setZoomLevel(Math.max(0.5, zoomLevel - 0.25))
                  }
                  disabled={zoomLevel <= 0.5}
                  className="rounded border bg-white px-1.5 py-0.5 text-xs disabled:opacity-50"
                  data-testid="button-zoom-out"
                >
                  -
                </button>
                <span className="w-9 text-center text-xs text-gray-600">
                  {Math.round(zoomLevel * 100)}%
                </span>
                <button
                  onClick={() =>
                    setZoomLevel(Math.min(3, zoomLevel + 0.25))
                  }
                  disabled={zoomLevel >= 3}
                  className="rounded border bg-white px-1.5 py-0.5 text-xs disabled:opacity-50"
                  data-testid="button-zoom-in"
                >
                  +
                </button>
                <button
                  onClick={() => {
                    setZoomLevel(1);
                    setPanOffset({ x: 0, y: 0 });
                  }}
                  className="rounded border bg-white px-1.5 py-0.5 text-xs"
                  data-testid="button-reset-view"
                >
                  Reset
                </button>
              </div>
            </div>

            <div
              className="relative overflow-hidden rounded-lg border bg-brand-light"
              style={{ minHeight: "600px" }}
            >
              {imageLoading && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-brand-light/80">
                  <div className="text-center">
                    <div className="mx-auto mb-2 h-12 w-12 animate-spin rounded-full border-b-2 border-brand-primary" />
                    <p className="text-gray-600">Loading image...</p>
                  </div>
                </div>
              )}

              <div
                className="relative h-full w-full"
                style={{
                  minHeight: "600px",
                  transform: `scale(${zoomLevel}) translate(${panOffset.x / zoomLevel}px, ${panOffset.y / zoomLevel}px)`,
                  transformOrigin: "top left",
                }}
              >
                {!previewUrl && !imageLoading && (
                  <div className="absolute inset-0 flex items-center justify-center text-gray-500">
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
          </div>

          <Button
            onClick={clearMask}
            variant="outline"
            size="sm"
            data-testid="button-clear-mask"
          >
            Clear Mask
          </Button>
        </div>
      )}

      {/* Required Fields */}
      <div className="space-y-4">
        <div>
          <Label htmlFor="instructions" className="text-base font-medium">
            Instructions{mode === "edit" && (
              <span className="text-red-500">*</span>
            )}
          </Label>
          <Textarea
            id="instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Describe your edit (required for Add/Remove/Replace)"
            rows={2}
            data-testid="textarea-instructions"
            className={
              mode === "edit" && !instructions.trim()
                ? "border-red-200 focus:border-red-300"
                : ""
            }
          />
        </div>

        <div>
          <Label htmlFor="mode" className="text-base font-medium">
            Operation <span className="text-red-500">*</span>
          </Label>
          <Select
            value={mode}
            onValueChange={(v) => setMode(v as "edit" | "restore_original")}
          >
            <SelectTrigger data-testid="select-mode">
              <SelectValue placeholder="Choose Option" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="edit">
                Add / Remove / Replace (requires text)
              </SelectItem>
              <SelectItem value="restore_original">
                Restore Original (no text required)
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

                <div>
          <Label htmlFor="scene-type" className="text-base font-medium">
            Scene Type
          </Label>
          <Select
            value={sceneType}
            onValueChange={(v) =>
              setSceneType(v as "auto" | "interior" | "exterior")
            }
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

        <div>
          <Label htmlFor="room-type" className="text-base font-medium">
            Room Type
          </Label>
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

        <div className="flex items-center gap-2">
          <Input
            id="smart-reinstate"
            type="checkbox"
            checked={smartReinstate}
            onChange={(e) => setSmartReinstate(e.target.checked)}
            className="h-4 w-4"
          />
          <Label
            htmlFor="smart-reinstate"
            className="text-sm text-gray-700 cursor-pointer"
          >
            Smart Reinstate (keep structure & boundaries tight)
          </Label>
        </div>
      </div>

      {/* Footer buttons */}
      <div className="flex items-center justify-between pt-4 border-t">
        <div className="text-xs text-gray-500">
          {mode === "edit" ? (
            <span>
              Requires <span className="font-semibold">instructions</span> and a{" "}
              <span className="font-semibold">mask</span>.
            </span>
          ) : (
            <span>
              Restore Original requires only a{" "}
              <span className="font-semibold">mask</span>.
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
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
          >
            {regionEditMutation.isPending ? "Applying edit..." : "Apply Edit"}
          </Button>
        </div>
      </div>
    </div>
  );
}

