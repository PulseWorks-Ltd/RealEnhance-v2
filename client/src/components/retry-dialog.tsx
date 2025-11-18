import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

export type EnhancementMode = "quality-only" | "staging" | "furniture-replace";

interface RetryDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (customInstructions: string, sceneType: "auto" | "interior" | "exterior", allowStaging: boolean, furnitureReplacementMode: boolean, roomType?: string, windowCount?: number, referenceImage?: File) => void;
  isLoading?: boolean;
  imageIndex: number;
  originalImageUrl?: string;
  enhancedImageUrl?: string;
  defaultEnhancementMode?: EnhancementMode; // Default mode from original batch settings
  detectedRoomType?: string;
}

export function RetryDialog({ isOpen, onClose, onSubmit, isLoading = false, imageIndex, originalImageUrl, enhancedImageUrl, defaultEnhancementMode = "staging" }: RetryDialogProps) {
  const [customInstructions, setCustomInstructions] = useState("");
  const [sceneType, setSceneType] = useState<"auto" | "interior" | "exterior">("auto");
  const [enhancementMode, setEnhancementMode] = useState<EnhancementMode>(defaultEnhancementMode);
  const safeDetectedRoomType = typeof detectedRoomType === 'undefined' ? "auto" : detectedRoomType;
  const [roomType, setRoomType] = useState<string>(safeDetectedRoomType);
  const [windowCount, setWindowCount] = useState<string>("");
  const [sliderPosition, setSliderPosition] = useState(50);
  const [referenceImage, setReferenceImage] = useState<File | null>(null);
  const [referencePreview, setReferencePreview] = useState<string | null>(null);

  // Sync enhancement mode with prop when dialog opens
  useEffect(() => {
    if (isOpen) {
      setEnhancementMode(defaultEnhancementMode);
    }
  }, [isOpen, defaultEnhancementMode]);

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
    // Close dialog immediately 
    handleClose();
    const windowCountNum = windowCount.trim() !== "" ? parseInt(windowCount, 10) : undefined;
    
    // Convert enhancement mode to allowStaging and furnitureReplacementMode flags
    const allowStaging = enhancementMode !== "quality-only";
    const furnitureReplacementMode = enhancementMode === "furniture-replace";
    
    onSubmit(customInstructions, sceneType, allowStaging, furnitureReplacementMode, roomType !== "auto" ? roomType : undefined, windowCountNum, referenceImage || undefined);
  };

  const handleClose = () => {
    setCustomInstructions("");
    setSceneType("auto");
    setEnhancementMode(defaultEnhancementMode); // Reset to default from batch settings
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
            Customize your retry with specific instructions and scene type for better results.
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
                <div className="absolute bottom-2 left-2 bg-black/50 text-white text-xs px-2 py-1 rounded">
                  Original
                </div>
                <div className="absolute bottom-2 right-2 bg-black/50 text-white text-xs px-2 py-1 rounded">
                  Enhanced
                </div>
              </div>
            </div>
          )}
          
          <div>
            <Label htmlFor="custom-instructions" className="text-sm font-medium">
              Custom Instructions (Optional)
            </Label>
            <Textarea
              id="custom-instructions"
              value={customInstructions}
              onChange={(e) => setCustomInstructions(e.target.value)}
              placeholder="Example: 'Add more furniture', 'Brighter lighting', 'Different staging style'..."
              rows={3}
              data-testid="textarea-retry-instructions"
            />
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

          <div>
            <Label htmlFor="room-type" className="text-sm font-medium">
              Room Type (Optional)
            </Label>
            <Select value={roomType} onValueChange={setRoomType}>
              <SelectTrigger data-testid="select-retry-room-type">
                <SelectValue placeholder={safeDetectedRoomType || "Auto Detect"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto Detect{safeDetectedRoomType ? ` (${safeDetectedRoomType})` : ""}</SelectItem>
                <SelectItem value="bedroom-1">Bedroom 1</SelectItem>
                <SelectItem value="bedroom-2">Bedroom 2</SelectItem>
                <SelectItem value="bedroom-3">Bedroom 3</SelectItem>
                <SelectItem value="kitchen">Kitchen</SelectItem>
                <SelectItem value="living-room">Living Room</SelectItem>
                <SelectItem value="multiple-living-areas">Multiple Living Areas</SelectItem>
                <SelectItem value="dining-room">Dining Room</SelectItem>
                <SelectItem value="study">Study</SelectItem>
                <SelectItem value="office">Office</SelectItem>
                <SelectItem value="bathroom-1">Bathroom 1</SelectItem>
                <SelectItem value="bathroom-2">Bathroom 2</SelectItem>
                <SelectItem value="laundry">Laundry</SelectItem>
                <SelectItem value="garden">Garden</SelectItem>
                <SelectItem value="patio">Patio</SelectItem>
                <SelectItem value="deck">Deck</SelectItem>
                <SelectItem value="balcony">Balcony</SelectItem>
                <SelectItem value="garage">Garage</SelectItem>
                <SelectItem value="basement">Basement</SelectItem>
                <SelectItem value="attic">Attic</SelectItem>
                <SelectItem value="hallway">Hallway</SelectItem>
                <SelectItem value="staircase">Staircase</SelectItem>
                <SelectItem value="entryway">Entryway</SelectItem>
                <SelectItem value="closet">Closet</SelectItem>
                <SelectItem value="pantry">Pantry</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">Auto-detected: <span className="font-semibold">{safeDetectedRoomType || "Unknown"}</span>. You can override if needed.</p>
          </div>

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

          <div>
            <Label htmlFor="enhancement-mode" className="text-sm font-medium">
              Enhancement Mode
            </Label>
            <Select value={enhancementMode} onValueChange={(v) => setEnhancementMode(v as EnhancementMode)}>
              <SelectTrigger data-testid="select-retry-enhancement-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="quality-only">Enhance Quality Only (1 credit)</SelectItem>
                <SelectItem value="staging">Add Staging (2 credits)</SelectItem>
                <SelectItem value="furniture-replace">Replace Existing Furniture (2 credits)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              {enhancementMode === "quality-only" && "Improves color, exposure, and sharpness without adding furniture"}
              {enhancementMode === "staging" && "Adds modern furniture and staging to empty/sparse rooms"}
              {enhancementMode === "furniture-replace" && "Replaces ALL dated furniture with modern alternatives"}
            </p>
          </div>

          {/* Reference Image Upload */}
          {enhancementMode !== "quality-only" && (
            <div className="space-y-2 border-t pt-4">
              <Label htmlFor="reference-image" className="text-sm font-medium">
                Reference Staging Image (Optional)
              </Label>
              <p className="text-xs text-muted-foreground">
                Upload a reference image to match its staging style and furniture choices
              </p>
              
              {!referencePreview ? (
                <div className="flex items-center gap-2">
                  <Input
                    id="reference-image"
                    type="file"
                    accept="image/*"
                    onChange={handleReferenceImageSelect}
                    data-testid="input-retry-reference-image"
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="relative w-full h-48 bg-brand-light rounded-lg overflow-hidden border">
                    <img 
                      src={referencePreview} 
                      alt="Reference staging" 
                      className="w-full h-full object-contain"
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRemoveReference}
                    data-testid="button-retry-remove-reference"
                  >
                    Remove Reference Image
                  </Button>
                </div>
              )}
            </div>
          )}

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