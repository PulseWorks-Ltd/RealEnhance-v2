import React, { useState, useEffect } from "react";
import { Modal } from "./Modal";
import { Button } from "@/components/ui/button";
import { CompareSlider } from "./CompareSlider";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";


export interface EditModalProps {
  isOpen: boolean;
  onClose: () => void;
  originalImage: string;
  enhancedImage?: string;
  onSubmit: (roiData: null, instructions?: string) => void;
  title?: string;
  submitButtonText?: string;
  isLoading?: boolean;
  "data-testid"?: string;
}

export function EditModal({
  isOpen,
  onClose,
  originalImage,
  enhancedImage,
  onSubmit,
  title = "Edit Image",
  submitButtonText = "Apply Changes", 
  isLoading = false,
  "data-testid": testId = "edit-modal"
}: EditModalProps) {
  const [instructions, setInstructions] = useState("");

  // Clear instructions when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setInstructions("");
    }
  }, [isOpen]);

  const handleSubmit = () => {
    // Close modal immediately and pass instructions
    onClose();
    onSubmit(null, instructions.trim() || undefined);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      maxWidth="2xl"
      data-testid={testId}
    >
      <div className="space-y-6">
        {/* Before/After Comparison */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Before vs After:</Label>
          <CompareSlider
            originalImage={originalImage}
            enhancedImage={enhancedImage || originalImage}
            height={400}
            showLabels={true}
            originalLabel="Before"
            enhancedLabel={enhancedImage ? "After ✨" : "Original"}
            data-testid={`${testId}-comparison`}
          />
        </div>

        {/* Instructions */}
        <div className="space-y-2">
          <Label htmlFor="edit-instructions" className="text-sm font-medium">
            Editing instructions:
          </Label>
          <Textarea
            id="edit-instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Describe what changes you want to make to this image..."
            rows={4}
            data-testid={`${testId}-instructions`}
          />
        </div>

        {/* Action Buttons */}
        <div className="flex justify-end space-x-3">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={isLoading}
            data-testid={`${testId}-cancel`}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={isLoading}
            data-testid={`${testId}-submit`}
          >
            {isLoading ? "Processing..." : submitButtonText}
          </Button>
        </div>
      </div>
    </Modal>
  );
}