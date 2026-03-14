import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";


interface RetryDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (
    customInstructions: string,
    sceneType: "auto" | "interior" | "exterior",
    roomType?: string,
    referenceImage?: File
  ) => void;
  isLoading?: boolean;
  imageIndex: number;
  originalImageUrl?: string;
  enhancedImageUrl?: string;
  defaultSceneType?: "auto" | "interior" | "exterior";
  defaultRoomType?: string;
}

export function RetryDialog({ isOpen, onClose, onSubmit, isLoading = false, imageIndex, originalImageUrl, enhancedImageUrl, defaultSceneType = "auto", defaultRoomType = "auto" }: RetryDialogProps) {
  const [customInstructions, setCustomInstructions] = useState("");
  const [sceneType, setSceneType] = useState<"auto" | "interior" | "exterior">(defaultSceneType);
  const [roomType, setRoomType] = useState<string>(defaultRoomType);
  const [roomTypeError, setRoomTypeError] = useState<string>("");
  const [sliderPosition, setSliderPosition] = useState(50);
  const [referenceImage, setReferenceImage] = useState<File | null>(null);
  const [referencePreview, setReferencePreview] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setSceneType(defaultSceneType);
      setRoomType(defaultRoomType || "auto");
      setRoomTypeError("");
      setCustomInstructions("");
      setReferenceImage(null);
      setReferencePreview(null);
    }
  }, [isOpen, defaultSceneType, defaultRoomType]);


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
    if (sceneType === "interior") {
      if (!roomType || roomType === "auto") {
        setRoomTypeError("Room type is required for interior scenes.");
        return;
      }
    }
    setRoomTypeError("");
    handleClose();
    const effectiveRoom = sceneType === "interior" ? roomType : undefined;
    onSubmit(customInstructions, sceneType, effectiveRoom, referenceImage || undefined);
  };

  const handleClose = () => {
    setCustomInstructions("");
    setSceneType(defaultSceneType);
    setRoomType(defaultRoomType || "auto");
    setReferenceImage(null);
    setReferencePreview(null);
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent
        className="flex flex-col w-[min(1400px,calc(100vw-1.5rem))] max-w-[1400px] h-[min(96vh,960px)] p-0 overflow-hidden border border-slate-200 bg-white rounded-sm shadow-2xl"
        data-testid="retry-dialog"
      >
        <DialogHeader className="px-8 pt-7 pb-4 border-b border-action-200">
          <DialogTitle className="text-xl font-semibold text-slate-900">Retry Image Enhancement</DialogTitle>
          <p className="text-sm text-slate-600">
            Adjust scene controls, review the comparison, and run a focused retry.
          </p>
          <div className="h-0.5 w-full bg-gradient-to-r from-action-600 via-emerald-500 to-transparent" />
        </DialogHeader>

        <div className="flex-1 overflow-hidden px-8 pt-6 pb-6 space-y-6 bg-slate-50/30">
          {/* Before/After Preview Slider */}
          {originalImageUrl && enhancedImageUrl && (
            <section className="space-y-3">
              <Label className="text-sm font-semibold text-slate-800 block">Preview Comparison</Label>
              <div className="relative w-full h-[min(44vh,560px)] bg-slate-100 overflow-hidden border border-slate-200 shadow-sm">
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
                  className="absolute top-0 bottom-0 w-1 bg-action-500 cursor-ew-resize z-10"
                  style={{ left: `${sliderPosition}%` }}
                >
                  <div className="absolute top-1/2 left-1/2 w-9 h-9 -translate-x-1/2 -translate-y-1/2 bg-white rounded-full shadow-md flex items-center justify-center border-2 border-action-600">
                    <svg className="w-4 h-4 text-action-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
            </section>
          )}

          <section className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-6 items-start">
            <div className="lg:col-span-3 space-y-1">
              <Label htmlFor="scene-type" className="text-sm font-medium text-slate-800">
                Scene Type
              </Label>
              <Select value={sceneType} onValueChange={(v) => setSceneType(v as any)}>
                <SelectTrigger data-testid="select-retry-scene-type" className="border-slate-300 focus:ring-action-500">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto Detect</SelectItem>
                  <SelectItem value="interior">Interior</SelectItem>
                  <SelectItem value="exterior">Exterior</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {sceneType === "interior" && (
              <div className="lg:col-span-3 space-y-1">
                <Label htmlFor="room-type" className="text-sm font-medium text-slate-800">
                  Room Type <span className="text-indigo-600">*</span>
                </Label>
                <Select value={roomType} onValueChange={setRoomType}>
                  <SelectTrigger data-testid="select-retry-room-type" className="border-slate-300 focus:ring-action-500">
                    <SelectValue placeholder="Select room type" />
                  </SelectTrigger>
                  <SelectContent
                    side="bottom"
                    align="start"
                    sideOffset={8}
                    avoidCollisions={false}
                    className="max-h-[260px] overflow-y-auto z-[999]"
                  >
                    <SelectItem value="auto">Auto Detect</SelectItem>
                    <SelectItem value="bedroom">Bedroom</SelectItem>
                    <SelectItem value="living_room">Living</SelectItem>
                    <SelectItem value="dining_room">Dining</SelectItem>
                    <SelectItem value="kitchen">Kitchen</SelectItem>
                    <SelectItem value="kitchen_dining">Kitchen &amp; Dining</SelectItem>
                    <SelectItem value="kitchen_living">Kitchen &amp; Living</SelectItem>
                    <SelectItem value="living_dining">Living &amp; Dining</SelectItem>
                    <SelectItem value="multiple_living">Multiple Living</SelectItem>
                    <SelectItem value="study">Study</SelectItem>
                    <SelectItem value="office">Office</SelectItem>
                    <SelectItem value="bathroom-1">Bathroom 1</SelectItem>
                    <SelectItem value="bathroom-2">Bathroom 2</SelectItem>
                    <SelectItem value="garage">Garage</SelectItem>
                    <SelectItem value="laundry">Laundry</SelectItem>
                    <SelectItem value="outdoor">Outdoor</SelectItem>
                    <SelectItem value="sunroom">Sunroom</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
                {roomTypeError && <div className="text-indigo-700 text-xs">{roomTypeError}</div>}
              </div>
            )}

            <div className={`${sceneType === "interior" ? "lg:col-span-6" : "lg:col-span-9"} space-y-1`}>
              <Label htmlFor="custom-instructions" className="text-sm font-medium text-slate-800">
                Additional Instructions <span className="text-slate-500">(optional)</span>
              </Label>
              <Textarea
                id="custom-instructions"
                value={customInstructions}
                onChange={(e) => setCustomInstructions(e.target.value)}
                placeholder="Any specific instructions for this retry..."
                className="border-slate-300 focus-visible:ring-action-500"
                rows={2}
                data-testid="input-retry-instructions"
              />
            </div>

            <div className="lg:col-span-12 space-y-1">
              <Label className="text-sm font-medium text-slate-800">
                Reference Image <span className="text-slate-500">(optional)</span>
              </Label>
              {referencePreview ? (
                <div className="flex items-center gap-3 rounded-sm border border-slate-200 bg-white px-3 py-2">
                  <img src={referencePreview} alt="Reference" className="w-16 h-16 object-cover rounded-sm border border-slate-200" />
                  <Button variant="outline" size="sm" onClick={handleRemoveReference}>Remove</Button>
                </div>
              ) : (
                <Input
                  type="file"
                  accept="image/*"
                  onChange={handleReferenceImageSelect}
                  className="border-slate-300 focus-visible:ring-action-500"
                  data-testid="input-retry-reference"
                />
              )}
            </div>
          </section>
        </div>

        <div className="border-t border-slate-200 bg-white/95 backdrop-blur-sm px-8 py-4 flex items-center justify-end gap-3">
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isLoading}
            data-testid="button-retry-cancel"
            className="border-slate-300 text-slate-700 hover:bg-slate-100"
          >
            Cancel
          </Button>
          <Button
            variant="action"
            onClick={handleSubmit}
            disabled={isLoading}
            data-testid="button-retry-enhance"
            className="bg-gradient-to-r from-action-600 to-emerald-600 hover:from-action-700 hover:to-emerald-700 text-white border border-transparent px-6"
          >
            {isLoading ? "Enhancing..." : "Enhance"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}