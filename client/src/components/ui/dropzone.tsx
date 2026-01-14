import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import { Upload, Image as ImageIcon, X, FileImage } from "lucide-react";

interface DropzoneProps {
  onFilesSelected: (files: File[]) => void;
  accept?: string;
  maxFiles?: number;
  maxSizeMB?: number;
  disabled?: boolean;
  className?: string;
}

/**
 * Premium dropzone component for file uploads.
 * Supports drag & drop with visual feedback.
 */
export function Dropzone({
  onFilesSelected,
  accept = "image/*",
  maxFiles = 10,
  maxSizeMB = 25,
  disabled = false,
  className,
}: DropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) setIsDragging(true);
  }, [disabled]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (disabled) return;

    const files = Array.from(e.dataTransfer.files).filter(
      file => file.type.startsWith("image/")
    );

    if (files.length > 0) {
      onFilesSelected(files.slice(0, maxFiles));
    }
  }, [disabled, maxFiles, onFilesSelected]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      onFilesSelected(files.slice(0, maxFiles));
    }
    // Reset input
    e.target.value = "";
  }, [maxFiles, onFilesSelected]);

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={cn(
        "relative rounded-xl border-2 border-dashed transition-all duration-200",
        isDragging
          ? "border-action-500 bg-action-50 scale-[1.01]"
          : "border-border hover:border-action-400 hover:bg-surface-subtle",
        disabled && "opacity-50 cursor-not-allowed",
        className
      )}
    >
      <label className={cn(
        "flex flex-col items-center justify-center py-12 px-6 cursor-pointer",
        disabled && "cursor-not-allowed"
      )}>
        <input
          type="file"
          accept={accept}
          multiple={maxFiles > 1}
          onChange={handleFileInput}
          disabled={disabled}
          className="sr-only"
        />

        {/* Icon */}
        <div className={cn(
          "w-14 h-14 rounded-full flex items-center justify-center mb-4 transition-colors",
          isDragging ? "bg-action-100" : "bg-muted"
        )}>
          {isDragging ? (
            <FileImage className="w-7 h-7 text-action-600" />
          ) : (
            <Upload className="w-7 h-7 text-muted-foreground" />
          )}
        </div>

        {/* Text */}
        <div className="text-center space-y-2">
          <p className="text-base font-medium text-foreground">
            {isDragging ? (
              "Drop your photos here"
            ) : (
              <>
                <span className="text-action-600 hover:text-action-700">Click to upload</span>
                {" "}or drag and drop
              </>
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            Property photos for enhancement
          </p>
          <p className="text-xs text-muted-foreground/80">
            JPG, PNG, WebP up to {maxSizeMB}MB each
            {maxFiles > 1 && ` (max ${maxFiles} files)`}
          </p>
        </div>
      </label>
    </div>
  );
}

export default Dropzone;
