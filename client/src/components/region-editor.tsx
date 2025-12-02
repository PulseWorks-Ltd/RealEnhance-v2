import { useState, useRef, useCallback, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

interface RegionEditorProps {
  onComplete?: (result: { imageUrl: string; originalUrl: string; maskUrl: string; mode?: string }) => void;
  onCancel?: () => void;
  onStart?: () => void;  // Called when processing starts (for immediate UI feedback)
  onError?: (errorMessage?: string) => void;  // Called when processing fails
  initialImageUrl?: string;
  originalImageUrl?: string;  // URL to original image for pixel-level restoration
  initialGoal?: string;
  initialIndustry?: string;
}

interface RegionEditResult {
  success: boolean;
  imageUrl?: string;
  originalUrl?: string;
  maskUrl?: string;
  creditsUsed: number;
  error?: string;
  mode?: string;
}

export function RegionEditor({ onComplete, onCancel, onStart, onError, initialImageUrl, originalImageUrl, initialGoal, initialIndustry }: RegionEditorProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(initialImageUrl || null);
  const [maskData, setMaskData] = useState<Blob | null>(null);
  const [instructions, setInstructions] = useState(initialGoal || "");
  const [industry, setIndustry] = useState(initialIndustry || "Real Estate");
  // Only two modes: 'edit' and 'restore_original'
  const [mode, setMode] = useState<"edit" | "restore_original">("edit");
  const [sceneType, setSceneType] = useState<"auto" | "interior" | "exterior">("auto");
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

  // Cleanup: Abort polling when component unmounts or modal closes
  useEffect(() => {
    return () => {
      console.log('[region-editor] 🧹 Component unmounting - aborting any active polling');
      pollingAbortRef.current.abort = true;
    };
  }, []);

  // Handle file selection
  const onFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    if (!file.type.startsWith('image/')) {
      toast({ title: "Invalid file", description: "Please select an image file", variant: "destructive" });
      return;
    }

    setSelectedFile(file);
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    setMaskData(null);
    
    // Load image and setup canvas
    const img = new Image();
    img.onload = () => {
      const canvas = canvasRef.current;
      const previewCanvas = previewCanvasRef.current;
      if (canvas && previewCanvas) {
        // Calculate display size - scale up to 1.75x for easier marking
        const displayScale = 1.75;
        const displayWidth = img.width * displayScale;
        const displayHeight = img.height * displayScale;
        
        // Setup main canvas for mask drawing with device pixel ratio
        const dpr = window.devicePixelRatio || 1;
        canvas.width = img.width * dpr;
        canvas.height = img.height * dpr;
        canvas.style.width = `${displayWidth}px`;
        canvas.style.height = `${displayHeight}px`;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.scale(dpr, dpr);
          ctx.fillStyle = 'black';
          ctx.fillRect(0, 0, img.width, img.height);
        }
        
        // Setup preview canvas with device pixel ratio
        previewCanvas.width = img.width * dpr;
        previewCanvas.height = img.height * dpr;
        previewCanvas.style.width = `${displayWidth}px`;
        previewCanvas.style.height = `${displayHeight}px`;
        const previewCtx = previewCanvas.getContext('2d');
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
  }, [toast]);

  // Load initial image URL if provided
  useEffect(() => {
    if (initialImageUrl && !selectedFile) {
      console.log('Loading initial image URL:', initialImageUrl);
      setImageLoading(true);

      // Retry logic for image loading (handles S3 eventual consistency and network issues)
      let retryCount = 0;
      const maxRetries = 3;

      const loadImage = () => {
        const img = new Image();
        img.crossOrigin = "anonymous";

        img.onload = () => {
          console.log('Image loaded successfully:', img.width, 'x', img.height);
          setImageLoading(false);
          const canvas = canvasRef.current;
          const previewCanvas = previewCanvasRef.current;
          if (canvas && previewCanvas) {
            // Calculate display size - scale up to 1.75x for easier marking
            const displayScale = 1.75;
            const displayWidth = img.width * displayScale;
            const displayHeight = img.height * displayScale;

            // Setup main canvas for mask drawing with device pixel ratio
            const dpr = window.devicePixelRatio || 1;
            canvas.width = img.width * dpr;
            canvas.height = img.height * dpr;
            canvas.style.width = `${displayWidth}px`;
            canvas.style.height = `${displayHeight}px`;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.scale(dpr, dpr);
              ctx.fillStyle = 'black';
              ctx.fillRect(0, 0, img.width, img.height);
            }

            // Setup preview canvas with device pixel ratio
            previewCanvas.width = img.width * dpr;
            previewCanvas.height = img.height * dpr;
            previewCanvas.style.width = `${displayWidth}px`;
            previewCanvas.style.height = `${displayHeight}px`;
            const previewCtx = previewCanvas.getContext('2d');
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
          console.error(`Failed to load initial image (attempt ${retryCount}/${maxRetries}):`, initialImageUrl, error);

          if (retryCount < maxRetries) {
            // Exponential backoff: 500ms, 1000ms, 2000ms
            const retryDelay = 500 * Math.pow(2, retryCount - 1);
            console.log(`Retrying in ${retryDelay}ms...`);
            setTimeout(loadImage, retryDelay);
          } else {
            setImageLoading(false);
            toast({
              title: "Image Load Error",
              description: "Failed to load the image after multiple attempts. Please close and try again.",
              variant: "destructive"
            });
          }
        };

        img.src = initialImageUrl;
      };

      loadImage();
    }
  }, [initialImageUrl, selectedFile, toast]);

  // Helper function for proper screen-to-canvas coordinate mapping
  const screenToCanvas = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    
    const displayScale = 1.75; // Must match the scale used in canvas setup
    
    // Get the container rect (includes CSS transforms)
    const rect = canvas.getBoundingClientRect();
    
    // Convert screen coordinates to CSS coordinates relative to canvas
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    
    // Convert from CSS display coordinates to canvas coordinates
    // 1. Account for displayScale (canvas CSS size is 1.75x the pixel size)
    // 2. Account for zoom level
    const x = (cssX / displayScale) / zoomLevel;
    const y = (cssY / displayScale) / zoomLevel;
    
    return { x, y };
  }, [zoomLevel]);

  // Drawing functions for mask creation
  const startDrawing = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    setIsDrawing(true);
    const { x, y } = screenToCanvas(e);
    
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (ctx) {
      ctx.beginPath();
      ctx.moveTo(x, y);
    }
  }, [screenToCanvas]);

  const draw = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    
    const { x, y } = screenToCanvas(e);
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (ctx) {
      ctx.lineWidth = brushSize;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'white';
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y);
    }
  }, [isDrawing, brushSize, screenToCanvas]);

  // Pan functionality
  const startPanning = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.altKey || e.ctrlKey) {
      setIsPanning(true);
      setLastPanPoint({ x: e.clientX, y: e.clientY });
      e.preventDefault();
    }
  }, []);

  const panCanvas = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isPanning) return;
    
    const deltaX = e.clientX - lastPanPoint.x;
    const deltaY = e.clientY - lastPanPoint.y;
    
    setPanOffset(prev => ({
      x: prev.x + deltaX,
      y: prev.y + deltaY
    }));
    
    setLastPanPoint({ x: e.clientX, y: e.clientY });
  }, [isPanning, lastPanPoint.x, lastPanPoint.y]);

  const stopPanning = useCallback(() => {
    setIsPanning(false);
  }, []);

  // Zoom functionality
  const handleZoom = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(0.5, Math.min(3, zoomLevel * zoomFactor));
    setZoomLevel(newZoom);
  }, [zoomLevel]);

  // Optimized auto-fill algorithm using efficient flood fill approach
  const autoFillEnclosedAreas = useCallback((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Reset transform for pixel operations
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const originalWidth = canvas.width;
    const originalHeight = canvas.height;
    
    // Work on a smaller version for performance, then scale up
    const maxDimension = 512;
    const scale = Math.min(maxDimension / originalWidth, maxDimension / originalHeight, 1);
    const workWidth = Math.floor(originalWidth * scale);
    const workHeight = Math.floor(originalHeight * scale);
    
    // Create working canvas
    const workCanvas = document.createElement('canvas');
    workCanvas.width = workWidth;
    workCanvas.height = workHeight;
    const workCtx = workCanvas.getContext('2d');
    if (!workCtx) return;
    
    // Draw scaled down version
    workCtx.imageSmoothingEnabled = false;
    workCtx.drawImage(canvas, 0, 0, workWidth, workHeight);
    
    // Close gaps by dilating white strokes
    workCtx.globalCompositeOperation = 'source-over';
    workCtx.filter = 'blur(2px)';
    workCtx.drawImage(workCanvas, 0, 0);
    workCtx.filter = 'none';
    
    // Get image data for flood fill
    const imageData = workCtx.getImageData(0, 0, workWidth, workHeight);
    const pixels = imageData.data;
    const filled = new Uint8ClampedArray(pixels);
    
    // Mark exterior pixels using border flood fill (much faster)
    const visited = new Uint8Array(workWidth * workHeight);
    const queue: number[] = [];
    
    // Start from all border pixels
    for (let x = 0; x < workWidth; x++) {
      // Top and bottom borders
      const topIndex = x;
      const bottomIndex = (workHeight - 1) * workWidth + x;
      if (pixels[topIndex * 4] < 128) queue.push(topIndex);
      if (pixels[bottomIndex * 4] < 128) queue.push(bottomIndex);
    }
    for (let y = 0; y < workHeight; y++) {
      // Left and right borders
      const leftIndex = y * workWidth;
      const rightIndex = y * workWidth + (workWidth - 1);
      if (pixels[leftIndex * 4] < 128) queue.push(leftIndex);
      if (pixels[rightIndex * 4] < 128) queue.push(rightIndex);
    }
    
    // Flood fill from borders to mark all exterior black pixels
    let queueStart = 0;
    while (queueStart < queue.length) {
      const pixelIndex = queue[queueStart++];
      if (visited[pixelIndex]) continue;
      visited[pixelIndex] = 1;
      
      const y = Math.floor(pixelIndex / workWidth);
      const x = pixelIndex % workWidth;
      
      // Check neighbors
      const neighbors = [
        [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]
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
    
    // Fill interior black pixels (not marked as exterior)
    for (let i = 0; i < workWidth * workHeight; i++) {
      const pixelIndex = i * 4;
      if (pixels[pixelIndex] < 128 && !visited[i]) {
        // Interior black pixel - fill with white
        filled[pixelIndex] = 255;     // R
        filled[pixelIndex + 1] = 255; // G
        filled[pixelIndex + 2] = 255; // B
      }
    }
    
    // Apply result to working canvas
    const resultData = new ImageData(filled, workWidth, workHeight);
    workCtx.putImageData(resultData, 0, 0);

    // Scale back up to original canvas
    // IMPORTANT: Don't clear the canvas - we want to ADD the filled areas to existing white strokes
    ctx.imageSmoothingEnabled = false;
    // Draw the autofilled areas on top of existing canvas (additive)
    ctx.globalCompositeOperation = 'lighten'; // Only add white pixels, don't remove existing white
    ctx.drawImage(workCanvas, 0, 0, originalWidth, originalHeight);
    ctx.globalCompositeOperation = 'source-over'; // Reset to default
    
    // Restore DPR scale for drawing
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, []);

  // Helper function to export mask at correct dimensions
  const exportMaskAtCorrectSize = useCallback((maskCanvas: HTMLCanvasElement) => {
    const previewCanvas = previewCanvasRef.current;
    if (!previewCanvas) return null;
    
    // Get the original image dimensions (not DPR-scaled)
    const originalWidth = previewCanvas.width / (window.devicePixelRatio || 1);
    const originalHeight = previewCanvas.height / (window.devicePixelRatio || 1);
    
    // Create an offscreen canvas at the original image size
    const offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = originalWidth;
    offscreenCanvas.height = originalHeight;
    
    const offscreenCtx = offscreenCanvas.getContext('2d');
    if (!offscreenCtx) return null;
    
    // Draw the mask canvas to the offscreen canvas, scaling it to match original size
    offscreenCtx.drawImage(maskCanvas, 0, 0, originalWidth, originalHeight);
    
    return offscreenCanvas.toDataURL('image/png');
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
    // Apply auto-fill to detect and fill enclosed areas
    setTimeout(() => {
      autoFillEnclosedAreas(canvas);
      console.log("[region-editor] stopDrawing: creating blob from canvas...");

      // IMPORTANT: Export mask at original image dimensions (not DPR-scaled)
      // The mask canvas is DPR-scaled, but we need to export at original image size
      const dpr = window.devicePixelRatio || 1;
      const originalWidth = canvas.width / dpr;
      const originalHeight = canvas.height / dpr;

      console.log("[region-editor] Mask dimensions:", {
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        dpr,
        originalWidth,
        originalHeight
      });

      // Create offscreen canvas at original (non-DPR) dimensions
      const offscreenCanvas = document.createElement('canvas');
      offscreenCanvas.width = originalWidth;
      offscreenCanvas.height = originalHeight;
      const offscreenCtx = offscreenCanvas.getContext('2d');

      if (offscreenCtx) {
        // Reset transform for pixel operations
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        }

        // Draw DPR-scaled canvas to offscreen canvas at original size
        offscreenCtx.drawImage(canvas, 0, 0, originalWidth, originalHeight);

        // Restore DPR scale for future drawing
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        // Export from offscreen canvas
        offscreenCanvas.toBlob((blob) => {
          if (blob) {
            console.log("[region-editor] ✅ Mask blob created successfully!");
            console.log("[region-editor]    - Size:", blob.size, "bytes");
            console.log("[region-editor]    - Type:", blob.type);
            console.log("[region-editor]    - Exported at:", originalWidth, "x", originalHeight);

            // DIAGNOSTIC: Log mask preview as data URL for debugging
            const maskPreview = offscreenCanvas.toDataURL('image/png');
            console.log("[region-editor] 📸 Mask preview (first 200 chars):", maskPreview.substring(0, 200));
            console.log("[region-editor] 💾 To download mask for inspection, run:");
            console.log(`      const a = document.createElement('a'); a.href = '${maskPreview.substring(0, 100)}...'; a.download = 'mask-debug.png'; a.click();`);

            setMaskData(blob);
          } else {
            console.error("[region-editor] ❌ offscreenCanvas.toBlob returned null!");
          }
        }, 'image/png');
      }
    }, 100);
  }, [autoFillEnclosedAreas]);

  // Combined mouse event handler
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.altKey || e.ctrlKey) {
      startPanning(e);
    } else {
      startDrawing(e);
    }
  }, [startPanning, startDrawing]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPanning) {
      panCanvas(e);
    } else {
      draw(e);
    }
  }, [isPanning, panCanvas, draw]);

  const handleMouseUp = useCallback(() => {
    stopDrawing();
    stopPanning();
  }, [stopDrawing, stopPanning]);




  const clearMask = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (ctx) {
      // Reset transform for pixel operations
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'black';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Restore DPR scale for drawing
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    setMaskData(null);
  }, []);

  // Region edit mutation
  // Custom region edit mutation with polling for job status
  const regionEditMutation = useMutation({
    mutationFn: async (data: FormData) => {
      console.log('[region-editor] 🚀 START: Submitting region-edit request...');
      console.log('[region-editor] API endpoint:', api("/api/region-edit"));

      let response: Response;
      try {
        response = await fetch(api("/api/region-edit"), {
          method: "POST",
          body: data,
          credentials: "include"
        });
        console.log('[region-editor] ✅ Fetch completed. Response status:', response.status, response.statusText);
      } catch (fetchError) {
        console.error('[region-editor] ❌ FETCH FAILED:', fetchError);
        throw new Error(`Network error: ${fetchError instanceof Error ? fetchError.message : 'Unknown error'}`);
      }

      if (!response.ok) {
        let errorText = '';
        try {
          errorText = await response.text();
          console.error('[region-editor] ❌ HTTP ERROR - Status:', response.status, 'Response:', errorText);
        } catch (e) {
          console.error('[region-editor] ❌ HTTP ERROR - Could not read response body');
        }
        throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
      }

      let result: { success: boolean; jobId?: string; error?: string };
      try {
        result = await response.json();
        console.log('[region-editor] ✅ Response JSON parsed:', result);
      } catch (jsonError) {
        console.error('[region-editor] ❌ JSON PARSE ERROR:', jsonError);
        throw new Error('Failed to parse server response');
      }

      return result;
    },
    onMutate: () => {
      // Abort any previous polling
      console.log('[region-editor] 🛑 Aborting any previous polling...');
      pollingAbortRef.current.abort = true;
      // Reset for this new request
      setTimeout(() => {
        pollingAbortRef.current = { abort: false };
      }, 100);
      onStart?.();
      // Do NOT call onCancel here; only call after a successful region edit.
    },
    onSuccess: async (result) => {
      console.log('[region-editor] onSuccess called with result:', result);
      console.log('[region-editor] Checking: success=', result.success, 'jobId=', result.jobId);

      if (!result.success || !result.jobId) {
        console.error('[region-editor] ❌ Invalid response - missing success or jobId');
        toast({
          title: "Enhancement failed",
          description: result.error || "Could not start edit",
          variant: "destructive"
        });
        onError?.();
        return;
      }

      console.log('[region-editor] ✅ Starting to poll job:', result.jobId);
      // Poll the edit job until success or error
      let polling = true;
      let pollCount = 0;
      // Create a local reference to track if THIS specific polling should be aborted
      const localAbortRef = pollingAbortRef.current;
      const pollJob = async () => {
        // Check if this polling has been aborted
        if (localAbortRef.abort) {
          polling = false;
          console.log('[region-editor] 🛑 Polling aborted (new request started)');
          return;
        }
        try {
          console.log(`[region-editor] Polling attempt ${pollCount + 1} for job:`, result.jobId);
          const res = await fetch(api(`/api/status/batch?ids=${result.jobId}`), { credentials: "include" });
          const json = await res.json();
          console.log('[region-editor] Poll response:', json);
          const item = json.items?.[0];
          if (!item) {
            console.log('[region-editor] No item in response, continuing...');
            return;
          }

          console.log('[region-editor] Job status:', item.status, 'hasImageUrl:', !!item.imageUrl);

          // Check for failed status
          if (item.status === "failed") {
            polling = false;
            console.error('[region-editor] ❌ Job failed:', item.error);
            toast({
              title: "Enhancement failed",
              description: item.error || "Edit failed",
              variant: "destructive"
            });
            onError?.();
            return;
          }

          // Check for completion
          if (item.status === "completed" && item.imageUrl) {
            polling = false;
            console.log('[region-editor] ✅ Job completed! Image URL:', item.imageUrl);
            onComplete?.({
              imageUrl: item.imageUrl,
              originalUrl: item.originalUrl || "",
              maskUrl: item.maskUrl || "",
              mode: item.mode || ""
            });
            // Only now call onCancel to close the editor after a successful region edit
            onCancel?.();
            return;
          }

          console.log('[region-editor] Still processing, will poll again...');
          // Otherwise still processing (queued or active) - continue polling
        } catch (e) {
          polling = false;
          console.error('[region-editor] ❌ Poll error:', e);
          toast({
            title: "Enhancement failed",
            description: e instanceof Error ? e.message : "Network error",
            variant: "destructive"
          });
          onError?.();
        }
      };
      // Poll every 1s up to 60s
      while (polling && pollCount < 60 && !localAbortRef.abort) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (localAbortRef.abort) {
          console.log('[region-editor] 🛑 Polling aborted during wait');
          break;
        }
        await pollJob();
        pollCount++;
      }
      if (polling && !localAbortRef.abort) {
        toast({
          title: "Enhancement failed",
          description: "Timed out waiting for edit job",
          variant: "destructive"
        });
        onError?.();
      }
    },
    onError: (error) => {
      console.error('[region-editor] ❌ Mutation onError called with:', error);
      console.error('[region-editor] Error type:', typeof error);
      console.error('[region-editor] Error keys:', error ? Object.keys(error) : 'null');

      let errorMessage = "Network error";
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      } else if (error && typeof error === 'object') {
        errorMessage = JSON.stringify(error);
      }

      console.error('[region-editor] Final error message:', errorMessage);

      toast({
        title: "Enhancement failed",
        description: errorMessage,
        variant: "destructive"
      });
      onError?.();
    }
  });

  // Robust handleSubmit with full validation and debug logging
  const handleSubmit = useCallback(async () => {
    try {
      console.log('[region-editor] ========== handleSubmit CALLED ==========');
      console.log('[region-editor] Mode:', mode);
      console.log('[region-editor] Has mask:', !!maskData);
      console.log('[region-editor] Instructions:', instructions);

    // 1. Validate image selection
    if (!selectedFile && !initialImageUrl) {
      toast({ title: "No image", description: "Please select an image first", variant: "destructive" });
      console.error("[region-editor] Submission blocked: No image selected.");
      return;
    }
    // 2. Validate instructions for edit mode
    if (mode === "edit" && !instructions.trim()) {
      toast({ title: "Instructions required", description: "Please provide instructions for Add/Remove/Replace", variant: "destructive" });
      console.error("[region-editor] Submission blocked: No instructions for edit mode.");
      return;
    }
    // 3. Validate mask presence
    if (!maskData) {
      toast({ title: "Mask required", description: "Please draw a region to edit or restore", variant: "destructive" });
      console.error("[region-editor] Submission blocked: No mask drawn.");
      return;
    }

    // 4. Convert mask Blob to data URL string
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
            reject(new Error("Failed to convert mask Blob to data URL"));
          }
        };
        reader.onerror = reject;
        reader.readAsDataURL(maskData);
      });
      console.log("[region-editor] ✅ Mask converted to data URL. Length:", maskAsDataUrl.length);
      console.log("[region-editor]    Mask preview:", maskAsDataUrl.substring(0, 100) + "...");
    } catch (e) {
      console.error("[region-editor] ❌ Failed to convert mask Blob to data URL:", e);
      toast({ title: "Mask error", description: "Failed to process mask data", variant: "destructive" });
      return;
    }

    // 5. Build FormData for submission
    const formData = new FormData();
    if (selectedFile) {
      formData.append("image", selectedFile);
      console.log("[region-editor] Appended image file to FormData.");
    } else if (initialImageUrl) {
      formData.append("imageUrl", initialImageUrl);
      if (originalImageUrl) {
        formData.append("baseImageUrl", originalImageUrl);
        console.log("[region-editor] Appended imageUrl and baseImageUrl to FormData.");
      } else {
        console.log("[region-editor] Appended imageUrl to FormData.");
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
    formData.append("regionMask", maskAsDataUrl); // Always as data URL string
    formData.append("smartReinstate", smartReinstate.toString());

    // 6. Debug log all FormData entries
    console.log("[region-editor] Submitting FormData:");
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string") {
        console.log(`  - ${key}:`, value.length > 120 ? value.substring(0, 120) + "..." : value);
      } else if (value instanceof File) {
        console.log(`  - ${key}: [File] name=${value.name}, size=${value.size}, type=${value.type}`);
      } else {
        console.log(`  - ${key}: [Unknown Type]`, value);
      }
    }

    // 7. Submit mutation
    console.log('[region-editor] 🎯 CALLING regionEditMutation.mutate()');
    console.log('[region-editor] Mutation state before call:', {
      isIdle: regionEditMutation.isIdle,
      isPending: regionEditMutation.isPending,
      isError: regionEditMutation.isError,
      isSuccess: regionEditMutation.isSuccess
    });
      regionEditMutation.mutate(formData);
      console.log('[region-editor] ✅ Mutation.mutate() called');
    } catch (error) {
      console.error('[region-editor] ❌❌❌ UNCAUGHT ERROR in handleSubmit:', error);
      console.error('[region-editor] Error stack:', error instanceof Error ? error.stack : 'N/A');
      toast({
        title: "Enhancement failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive"
      });
      onError?.();
    }
  }, [selectedFile, initialImageUrl, originalImageUrl, maskData, instructions, industry, mode, sceneType, roomType, smartReinstate, toast, onError]);
  // Note: regionEditMutation removed from deps - useMutation returns stable mutate function

  // Check if required fields are filled based on operation type
  const hasInstructions = instructions.trim().length > 0;
  const hasMask = maskData !== null;
  const isFormValid = (
    (mode === "edit" && hasInstructions && hasMask) ||
    (mode === "restore_original" && hasMask)
  );
  
  return (
    <div className="space-y-6">
      {/* File Upload - only show if no initial image */}
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

      {/* Image Canvas for Mask Drawing - now at the top */}
      {previewUrl && (
        <div className="space-y-4">
          <div>
            <Label className="text-base font-medium">Draw Region Mask (white = selected area)</Label>
            <p className="text-sm text-gray-600 mt-1 mb-3">
              Draw on the image to mark the region. Use Alt/Ctrl + drag to pan, mouse wheel to zoom.
            </p>
            
            {/* Drawing Controls */}
            <div className="flex flex-wrap items-center gap-3 p-2 bg-brand-light rounded-lg mb-3">
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
                <span className="text-xs text-gray-600 w-7">{brushSize}px</span>
              </div>
              
              <div className="flex items-center gap-1.5">
                <Label className="text-xs">Zoom:</Label>
                <button
                  onClick={() => setZoomLevel(Math.max(0.5, zoomLevel - 0.25))}
                  disabled={zoomLevel <= 0.5}
                  className="px-1.5 py-0.5 text-xs bg-white border rounded disabled:opacity-50"
                  data-testid="button-zoom-out"
                >
                  -
                </button>
                <span className="text-xs text-gray-600 w-9 text-center">{Math.round(zoomLevel * 100)}%</span>
                <button
                  onClick={() => setZoomLevel(Math.min(3, zoomLevel + 0.25))}
                  disabled={zoomLevel >= 3}
                  className="px-1.5 py-0.5 text-xs bg-white border rounded disabled:opacity-50"
                  data-testid="button-zoom-in"
                >
                  +
                </button>
                <button
                  onClick={() => { setZoomLevel(1); setPanOffset({ x: 0, y: 0 }); }}
                  className="px-1.5 py-0.5 text-xs bg-white border rounded"
                  data-testid="button-reset-view"
                >
                  Reset
                </button>
              </div>
            </div>
            
            <div className="relative border rounded-lg overflow-hidden bg-brand-light" style={{ minHeight: '600px' }}>
              {imageLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-brand-light/80 z-10">
                  <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-primary mx-auto mb-2"></div>
                    <p className="text-gray-600">Loading image...</p>
                  </div>
                </div>
              )}
              <div
                className="relative w-full h-full"
                style={{
                  minHeight: '600px',
                  transform: `scale(${zoomLevel}) translate(${panOffset.x / zoomLevel}px, ${panOffset.y / zoomLevel}px)`,
                  transformOrigin: 'top left'
                }}
              >
                {!previewUrl && !imageLoading && (
                  <div className="absolute inset-0 flex items-center justify-center text-gray-500">
                    <p>No image loaded. Please select an image file above.</p>
                  </div>
                )}
                <canvas
                  ref={previewCanvasRef}
                  className="absolute inset-0 w-full h-full object-contain"
                  style={{ display: previewUrl ? 'block' : 'none' }}
                />
                <canvas
                  ref={canvasRef}
                  className="absolute inset-0 w-full h-full object-contain opacity-60"
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseUp}
                  onWheel={handleZoom}
                  style={{
                    cursor: isPanning ? 'grabbing' : isDrawing ? 'crosshair' : 'crosshair',
                    display: previewUrl ? 'block' : 'none'
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

      {/* Required Fields Section */}
      <div className="space-y-4">
        <div>
          <Label htmlFor="instructions" className="text-base font-medium">
            Instructions{mode === "edit" && <span className="text-red-500">*</span>}
          </Label>
          <Textarea
            id="instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Describe your edit (required for Add/Remove/Replace)"
            rows={2}
            data-testid="textarea-instructions"
            className={mode === "edit" && !instructions.trim() ? "border-red-200 focus:border-red-300" : ""}
          />
        </div>

        <div>
          <Label htmlFor="mode" className="text-base font-medium">
            Operation <span className="text-red-500">*</span>
          </Label>
          <Select value={mode} onValueChange={(v) => setMode(v as any)}>
            <SelectTrigger data-testid="select-mode">
              <SelectValue placeholder="Choose Option" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="edit">Add / Remove / Replace (requires text)</SelectItem>
              <SelectItem value="restore_original">Restore Original (no text required)</SelectItem>
            </SelectContent>
          </Select>
          {mode === "edit" && (
            <div className="mt-2 text-sm text-gray-600">
              <p>Describe what to add, remove, or replace in the selected region. <b>Instructions are required.</b></p>
            </div>
          )}
          {mode === "restore_original" && (
            <div className="mt-2 text-sm text-gray-600">
              <p>Restore the masked region to its previous state. <b>No instructions required.</b></p>
            </div>
          )}
        </div>

        <div>
          <Label htmlFor="scene-type" className="text-base font-medium">Scene Type</Label>
          <Select value={sceneType} onValueChange={(v) => setSceneType(v as any)}>
            <SelectTrigger data-testid="select-scene-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto Detect</SelectItem>
              <SelectItem value="interior">Interior (furniture staging, lighting)</SelectItem>
              <SelectItem value="exterior">Exterior (sky, grass, deck staging)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center space-x-2">
          <input
            type="checkbox"
            id="smart-reinstate"
            checked={smartReinstate}
            onChange={(e) => setSmartReinstate(e.target.checked)}
            className="rounded"
            data-testid="checkbox-smart-reinstate"
          />
          <Label htmlFor="smart-reinstate">Enable Smart Reinstate</Label>
        </div>

        {/* Validation Message */}
        {!isFormValid && (
          <div className="flex items-center gap-2 text-red-600 text-sm">
            <span className="text-red-500">*</span>
            <span>Required for enhancing to commence</span>
          </div>
        )}

        {/* Staging style selection removed: now batch-level only */}
      </div>

      {/* Action Buttons */}
      <div className="flex gap-2">
        {onCancel && (
          <Button
            onClick={onCancel}
            variant="outline"
            disabled={regionEditMutation.isPending}
            data-testid="button-cancel-edit"
          >
            Cancel
          </Button>
        )}
        <Button
          onClick={handleSubmit}
          disabled={(!selectedFile && !initialImageUrl) || regionEditMutation.isPending || !isFormValid}
          className="flex-1"
          data-testid="button-process-region"
        >
          {regionEditMutation.isPending ? "Editing image as requested..." : "Enhance"}
        </Button>
      </div>
    </div>
  );
}