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
  onComplete?: (result: { imageUrl: string; originalUrl: string; maskUrl: string }) => void;
  onCancel?: () => void;
  onStart?: () => void;  // Called when processing starts (for immediate UI feedback)
  onError?: () => void;  // Called when processing fails
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
  mode?: "staged" | "polish-only";
}

export function RegionEditor({ onComplete, onCancel, onStart, onError, initialImageUrl, originalImageUrl, initialGoal, initialIndustry }: RegionEditorProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(initialImageUrl || null);
  const [maskData, setMaskData] = useState<string | null>(null);
  const [instructions, setInstructions] = useState(initialGoal || "");
  const [industry, setIndustry] = useState(initialIndustry || "Real Estate");
  const [operation, setOperation] = useState<"add" | "remove" | "replace" | "enhance" | "restore" | "">("");
  const [sceneType, setSceneType] = useState<"auto" | "interior" | "exterior">("auto");
  const [smartReinstate, setSmartReinstate] = useState(true);
  const [isDrawing, setIsDrawing] = useState(false);
  const [brushSize, setBrushSize] = useState(20);
  const [zoomLevel, setZoomLevel] = useState(0.5);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPoint, setLastPanPoint] = useState({ x: 0, y: 0 });
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  
  const { toast } = useToast();

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
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        console.log('Image loaded successfully:', img.width, 'x', img.height);
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
        console.error('Failed to load initial image:', initialImageUrl, error);
        toast({
          title: "Image Load Error",
          description: "Failed to load the image. Please try uploading it again.",
          variant: "destructive"
        });
      };
      img.src = initialImageUrl;
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
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, originalWidth, originalHeight);
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, originalWidth, originalHeight);
    ctx.drawImage(workCanvas, 0, 0, originalWidth, originalHeight);
    
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
    if (!canvas) return;
    
    // Apply auto-fill to detect and fill enclosed areas
    setTimeout(() => {
      autoFillEnclosedAreas(canvas);
      
      // Export mask at correct dimensions (not DPR-scaled)
      const maskDataUrl = exportMaskAtCorrectSize(canvas);
      setMaskData(maskDataUrl);
    }, 100); // Small delay to ensure drawing is complete
  }, [autoFillEnclosedAreas, exportMaskAtCorrectSize]);

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
  const regionEditMutation = useMutation({
    mutationFn: async (data: FormData) => {
      const response = await fetch(api("/api/region-edit"), {
        method: "POST",
        body: data,
        credentials: "include"
      });
      if (!response.ok) {
        const errorText = await response.text();
        console.error('Region edit error response:', errorText);
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return (await response.json()) as RegionEditResult;
    },
    onMutate: () => {
      // Signal processing start (for immediate UI feedback)
      onStart?.();
      // Close modal immediately when processing starts
      onCancel?.();
    },
    onSuccess: (result) => {
      if (result.success && result.imageUrl && result.originalUrl && result.maskUrl) {
        // Don't show toast here - batch-processor handles it when image loads
        onComplete?.({ 
          imageUrl: result.imageUrl!, 
          originalUrl: result.originalUrl!, 
          maskUrl: result.maskUrl! 
        });
      } else {
        toast({ 
          title: "Enhancement failed", 
          description: result.error || "Unknown error", 
          variant: "destructive" 
        });
        onError?.(); // Signal processing failed
      }
    },
    onError: (error) => {
      toast({ 
        title: "Enhancement failed", 
        description: error instanceof Error ? error.message : "Network error", 
        variant: "destructive" 
      });
      onError?.(); // Signal processing failed
    }
  });

  const handleSubmit = useCallback(async () => {
    if (!selectedFile && !initialImageUrl) {
      toast({ title: "No image", description: "Please select an image first", variant: "destructive" });
      return;
    }
    
    // Operation-specific validation
    const hasInstructions = instructions.trim().length > 0;
    const hasMask = maskData !== null;
    
    // Validate based on operation type
    if (operation === "enhance") {
      // Enhance: instructions required, mask optional
      if (!hasInstructions) {
        toast({ title: "Instructions required", description: "Please provide enhancement instructions", variant: "destructive" });
        return;
      }
    } else if (["add", "replace", "remove"].includes(operation)) {
      // Add/Replace/Remove: both mask and instructions required
      if (!hasMask) {
        toast({ title: "Mask required", description: "Please draw a region to mark the area for this operation", variant: "destructive" });
        return;
      }
      if (!hasInstructions) {
        toast({ title: "Instructions required", description: "Please describe what you want to add, replace, or remove", variant: "destructive" });
        return;
      }
    } else if (operation === "restore") {
      // Restore: mask required to specify area to restore
      if (!hasMask) {
        toast({ title: "Mask required", description: "Please draw a region to mark the area to restore from the original image", variant: "destructive" });
        return;
      }
    } else {
      toast({ title: "Operation required", description: "Please select an operation type", variant: "destructive" });
      return;
    }
    
    const formData = new FormData();
    
    // Only append file if we have selectedFile (for file uploads)
    if (selectedFile) {
      formData.append("image", selectedFile);
    } else if (initialImageUrl) {
      // For gallery images, we'll pass the URL in the mutation
      console.log('Preparing to edit gallery image:', initialImageUrl);
      formData.append("imageUrl", initialImageUrl);
      
      // Pass quality-enhanced baseline URL for pixel-level restoration
      // The originalImageUrl prop is actually the quality-enhanced baseline (Stage 1 output)
      // This ensures restored pixels match the color/exposure of staged content
      // Send as both qualityEnhancedUrl (preferred) and originalUrl (fallback for legacy)
      if (originalImageUrl) {
        // Always send as baseImageUrl for server compatibility
        console.log('Using originalImageUrl for pixel-level restoration:', originalImageUrl);
        formData.append("baseImageUrl", originalImageUrl);
      }
    }
    
    // Use instructions directly as goal
    formData.append("goal", instructions);
    formData.append("industry", industry);
    formData.append("sceneType", sceneType);
    formData.append("preserveStructure", "true");
    formData.append("allowStaging", "true");
    formData.append("allowRetouch", "true");
    
    if (hasMask) {
      formData.append("regionMask", maskData);
      formData.append("regionOperation", operation);
      formData.append("smartReinstate", smartReinstate.toString());
    }
    
    regionEditMutation.mutate(formData);
  }, [selectedFile, initialImageUrl, originalImageUrl, maskData, instructions, industry, operation, smartReinstate, regionEditMutation, toast]);

  // Check if required fields are filled based on operation type
  const hasInstructions = instructions.trim().length > 0;
  const hasMask = maskData !== null;
  const hasOperation = operation !== "";
  
  const isFormValid = hasOperation && (
    // Enhance: instructions required, mask optional
    (operation === "enhance" && hasInstructions) ||
    // Add/Replace/Remove: both mask and instructions required
    (["add", "replace", "remove"].includes(operation) && hasMask && hasInstructions) ||
    // Restore: mask required, instructions optional (operation is self-explanatory)
    (operation === "restore" && hasMask)
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
              <div 
                className="relative w-full h-full"
                style={{
                  minHeight: '600px',
                  transform: `scale(${zoomLevel}) translate(${panOffset.x / zoomLevel}px, ${panOffset.y / zoomLevel}px)`,
                  transformOrigin: 'top left'
                }}
              >
                {!previewUrl && (
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
            Instructions <span className="text-red-500">*</span>
          </Label>
          <Textarea
            id="instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Example: 'Add 2 stools at the island', 'Make lighting brighter', 'Remove clutter from counter'"
            rows={2}
            data-testid="textarea-instructions"
            className={!instructions.trim() ? "border-red-200 focus:border-red-300" : ""}
          />
        </div>

        <div>
          <Label htmlFor="operation" className="text-base font-medium">
            Operation <span className="text-red-500">*</span>
          </Label>
          <Select value={operation} onValueChange={(v) => setOperation(v as any)}>
            <SelectTrigger data-testid="select-operation" className={operation === "" ? "border-red-200 focus:border-red-300" : ""}>
              <SelectValue placeholder="Choose Option" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="enhance">Polish (Enhance quality & lighting)</SelectItem>
              <SelectItem value="add">Add (Place new objects/content)</SelectItem>
              <SelectItem value="replace">Replace (Swap existing content)</SelectItem>
              <SelectItem value="remove">Remove (AI-based removal of objects)</SelectItem>
              <SelectItem value="restore">Restore Original (Pixel-level restoration)</SelectItem>
            </SelectContent>
          </Select>
          {/* Contextual guidance for operation requirements */}
          {operation && (
            <div className="mt-2 text-sm text-gray-600">
              {operation === "enhance" && (
                <p>✨ Polish mode: Enhance image quality, lighting, and colors. Instructions required, mask optional for targeted areas.</p>
              )}
              {operation === "add" && (
                <p>➕ Add mode: Place new objects or content in the image. Requires both mask (target area) and instructions (what to add).</p>
              )}
              {operation === "replace" && (
                <p>🔄 Replace mode: Swap existing content with something new. Requires both mask (what to replace) and instructions (replacement details).</p>
              )}
              {operation === "remove" && (
                <p>🗑️ Remove mode: Delete objects and restore the original background. Requires both mask (what to remove) and instructions (removal details).</p>
              )}
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