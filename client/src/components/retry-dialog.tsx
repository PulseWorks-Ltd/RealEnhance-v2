import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";


interface RetryDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (customInstructions: string, sceneType: "auto" | "interior" | "exterior", allowStaging: boolean, furnitureReplacementMode: boolean, roomType?: string, windowCount?: number, referenceImage?: File) => void;
  isLoading?: boolean;
  imageIndex: number;
  originalImageUrl?: string;
  enhancedImageUrl?: string;
  detectedRoomType?: string;
}

export function RetryDialog({ isOpen, onClose, onSubmit, isLoading = false, imageIndex, originalImageUrl, enhancedImageUrl }: RetryDialogProps) {
  const [customInstructions, setCustomInstructions] = useState("");
  const [sceneType, setSceneType] = useState<"auto" | "interior" | "exterior">("auto");
  const safeDetectedRoomType = typeof detectedRoomType === 'undefined' ? "auto" : detectedRoomType;
  const [roomType, setRoomType] = useState<string>(safeDetectedRoomType);
  const [roomTypeError, setRoomTypeError] = useState<string>("");
  const [windowCount, setWindowCount] = useState<string>("");
  const [sliderPosition, setSliderPosition] = useState(50);
  const [referenceImage, setReferenceImage] = useState<File | null>(null);
  const [referencePreview, setReferencePreview] = useState<string | null>(null);


  const handleReferenceImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 15 * 1024 * 1024) {
        alert("Reference image must be under 15MB");
        return;
      }
      if (!file.type.startsWith("image/")) {
        alert("Please select an image file");
        return;
      }
      setReferenceImage(file);
      const reader = new FileReader();
      reader.onload = (e) => setReferencePreview(e.target?.result as string);
      reader.readAsDataURL(file);
    }
  };

  const handleRemoveReference = () => {
    setReferenceImage(null);
    setReferencePreview(null);
  };

  const handleSubmit = () => {
    if (!roomType || roomType === "auto") {
      setRoomTypeError("Room type is required for retry.");
      return;
    }
    setRoomTypeError("");
    // Close dialog immediately 
    handleClose();
    const windowCountNum = windowCount.trim() !== "" ? parseInt(windowCount, 10) : undefined;
    // Use batch preset for allowStaging/furnitureReplacementMode (not user-editable here)
    onSubmit(customInstructions, sceneType, undefined, undefined, roomType, windowCountNum, referenceImage || undefined);
  };

  const handleClose = () => {
    setCustomInstructions("");
    setSceneType("auto");
    setRoomType("auto");
    setWindowCount("");
    setReferenceImage(null);
    setReferencePreview(null);
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto" data-testid="retry-dialog">
        <DialogHeader>
          <DialogTitle>Retry Image Enhancement</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Customize your retry with specific instructions and scene type for better results. Staging style is set at batch upload and cannot be changed here.
          </p>

          {/* Before/After Preview Slider */}
          {originalImageUrl && enhancedImageUrl && (
            <div className="mb-4">
              <Label className="text-sm font-medium mb-2 block">Preview Comparison</Label>
              <div className="relative w-full h-64 bg-brand-light rounded-lg overflow-hidden border">
                <div className="absolute inset-0">
                  <img 
                    src={enhancedImageUrl} 
                    alt="Enhanced" 
                    className="absolute inset-0 w-full h-full object-contain"
                  />
                </div>
                <div 
                  className="absolute inset-0 overflow-hidden"
                  style={{ clipPath: `inset(0 ${100 - sliderPosition}% 0 0)` }}
                >
                  <img 
                    src={originalImageUrl} 
                    alt="Original" 
                    className="absolute inset-0 w-full h-full object-contain"
                  />
                </div>
                <div
                  className="absolute top-0 bottom-0 w-1 bg-white cursor-ew-resize z-10"
                  style={{ left: `${sliderPosition}%` }}
                >
                  <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-white rounded-full shadow-lg flex items-center justify-center">
                    <svg className="w-4 h-4 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l4-4 4 4m0 6l-4 4-4-4" />
                    </svg>
                  </div>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={sliderPosition}
                  onChange={(e) => setSliderPosition(Number(e.target.value))}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-ew-resize z-20"
                  data-testid="slider-retry-preview"
                />
              </div>
            </div>
          )}

          {/* Room Type Dropdown (Required, no empty value) */}
          <div>
            <Label htmlFor="room-type" className="text-sm font-medium">
              Room Type <span className="text-red-500">*</span>
            </Label>
            <Select value={roomType} onValueChange={setRoomType}>
              <SelectTrigger data-testid="select-retry-room-type">
                <SelectValue placeholder="Select room type" />
              </SelectTrigger>
              <SelectContent
                side="bottom"
                align="start"
                sideOffset={8}
                avoidCollisions={false}
                className="max-h-[260px] overflow-y-auto z-[999]"
              >
                <SelectItem value="auto">Auto Detect{safeDetectedRoomType ? ` (${safeDetectedRoomType})` : ""}</SelectItem>
                <SelectItem value="bedroom-1">Bedroom 1</SelectItem>
                <SelectItem value="bedroom-2">Bedroom 2</SelectItem>
                <SelectItem value="bedroom-3">Bedroom 3</SelectItem>
                <SelectItem value="bedroom-4">Bedroom 4</SelectItem>
                <SelectItem value="kitchen">Kitchen</SelectItem>
                <SelectItem value="living-room">Living Room</SelectItem>
                <SelectItem value="multiple-living-areas">Multiple Living Areas</SelectItem>
                <SelectItem value="dining-room">Dining Room</SelectItem>
                <SelectItem value="study">Study</SelectItem>
                <SelectItem value="office">Office</SelectItem>
                <SelectItem value="bathroom-1">Bathroom 1</SelectItem>
                <SelectItem value="bathroom-2">Bathroom 2</SelectItem>
                <SelectItem value="garage">Garage</SelectItem>
                <SelectItem value="laundry">Laundry</SelectItem>
                <SelectItem value="outdoor">Outdoor</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
            {roomTypeError && <div className="text-red-500 text-xs mt-1">{roomTypeError}</div>}
            <p className="text-xs text-muted-foreground mt-1">Auto-detected: <span className="font-semibold">{safeDetectedRoomType || "Unknown"}</span>. You can override if needed.</p>
          </div>

          <div>
            <Label htmlFor="scene-type" className="text-sm font-medium">
              Scene Type
            </Label>
            <Select value={sceneType} onValueChange={(v) => setSceneType(v as any)}>
              <SelectTrigger data-testid="select-retry-scene-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto Detect</SelectItem>
                <SelectItem value="interior">Interior (furniture staging, lighting)</SelectItem>
                <SelectItem value="exterior">Exterior (sky, grass, deck staging)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Only one Room Type select should be rendered (required above) */}

          <div>
            <Label htmlFor="window-count" className="text-sm font-medium">
              Window Openings in Original Image
            </Label>
            <Input
              id="window-count"
              type="number"
              min="0"
              value={windowCount}
              onChange={(e) => setWindowCount(e.target.value)}
              placeholder="e.g., 0, 1, 2..."
              data-testid="input-retry-window-count"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Count the areas where no wall exists. Multiple panes side-by-side = 1 opening.
            </p>
          </div>


          <div className="flex justify-end space-x-2">
            <Button 
              variant="outline" 
              onClick={handleClose}
              disabled={isLoading}
              data-testid="button-retry-cancel"
            >
              Cancel
            </Button>
            <Button 
              onClick={handleSubmit}
              disabled={isLoading}
              data-testid="button-retry-enhance"
            >
              {isLoading ? "Enhancing..." : "Enhance"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}