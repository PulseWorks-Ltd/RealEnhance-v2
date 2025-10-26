import { useState, useCallback, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

interface UploadSectionProps {
  onFilesSelected: (files: File[]) => void;
  processingMode: 'single' | 'batch';
  onProcessingModeChange: (mode: 'single' | 'batch') => void;
}

type Preview = { file: File; url: string };

export function UploadSection({ onFilesSelected, processingMode, onProcessingModeChange }: UploadSectionProps) {
  const [previews, setPreviews] = useState<Preview[]>([]);
  const { toast } = useToast();

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (!acceptedFiles.length) return;
    const next = acceptedFiles.map(f => ({ file: f, url: URL.createObjectURL(f) }));
    setPreviews(next);
    onFilesSelected(acceptedFiles);
  }, [onFilesSelected]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "image/*": [".jpg",".jpeg",".png",".webp",".heic",".heif"] },
    maxFiles: processingMode === "batch" ? 10 : 1,
    multiple: processingMode === "batch",
    maxSize: 15 * 1024 * 1024
  });

  useEffect(() => () => { previews.forEach(p => URL.revokeObjectURL(p.url)); }, [previews]);

  return (
    <section className="w-full">
      {processingMode === "single" ? (
        // Single mode: Upload area transforms into preview
        <div className="flex justify-center">
          <Card className="w-full max-w-2xl">
            <CardContent className="p-4">
              {previews.length === 0 ? (
                // Upload state
                <>
                  <div
                    {...getRootProps()}
                    className={`border-2 border-dashed rounded-xl p-6 cursor-pointer text-center ${isDragActive ? "border-purple-500 bg-purple-500/5" : "border-muted"}`}
                  >
                    <input {...getInputProps()} />
                    <p className="text-sm text-muted-foreground">
                      Drag & drop image here, or click to select
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">JPG, PNG, WEBP, HEIC up to 15MB</p>
                  </div>
                  <div className="text-center text-xs text-muted-foreground mt-1">1 credit per image</div>
                </>
              ) : (
                // Preview state with change button
                <div className="text-center">
                  <img 
                    src={previews[0].url} 
                    alt={previews[0].file.name}
                    className="max-h-72 w-full object-contain rounded-lg border mb-4" 
                  />
                  <Button 
                    variant="outline" 
                    onClick={() => {
                      // Clear current preview and reset to upload state
                      previews.forEach(p => URL.revokeObjectURL(p.url));
                      setPreviews([]);
                      onFilesSelected([]);
                    }}
                    data-testid="change-image-button"
                  >
                    Change Image
                  </Button>
                  <div className="text-center text-xs text-muted-foreground mt-2">1 credit per image</div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      ) : (
        // Batch mode: Keep grid layout with separate preview
        <div className="grid md:grid-cols-2 gap-4">
          <Card>
            <CardContent className="p-4">
              <div
                {...getRootProps()}
                className={`border-2 border-dashed rounded-xl p-6 cursor-pointer text-center ${isDragActive ? "border-purple-500 bg-purple-500/5" : "border-muted"}`}
              >
                <input {...getInputProps()} />
                <p className="text-sm text-muted-foreground">
                  Drag & drop images here, or click to select
                </p>
                <p className="text-xs text-muted-foreground mt-1">JPG, PNG, WEBP, HEIC up to 15MB</p>
              </div>
              <div className="text-center text-xs text-muted-foreground mt-1">1 credit per image</div>
            </CardContent>
          </Card>

          {/* Batch preview pane */}
          <Card>
            <CardContent className="p-4">
              {previews.length === 0 ? (
                <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">
                  No images selected
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-2 max-h-72 overflow-auto pr-1">
                  {previews.map(p => (
                    <img key={p.url} src={p.url} alt={p.file.name}
                         className="h-24 w-full object-cover rounded-md border" />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </section>
  );
}