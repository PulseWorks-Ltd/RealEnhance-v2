import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";

interface BatchResult {
  index: number;
  filename: string;
  ok: boolean;
  image?: string;
  error?: string;
}

interface BatchGalleryProps {
  results: BatchResult[];
  onDownloadAll: () => void;
  onEnhanceMore: () => void;
  onDownloadSingle: (result: BatchResult) => void;
  onAmendImage?: (result: BatchResult, feedback: string) => void;
  onRetryFailed?: (result: BatchResult) => void;
  onRestart?: () => void;
}

function AmendModal({ isOpen, onClose, result, onSubmit }: {
  isOpen: boolean;
  onClose: () => void;
  result: BatchResult | null;
  onSubmit: (feedback: string) => void;
}) {
  const [feedback, setFeedback] = useState("");

  const handleSubmit = () => {
    if (feedback.trim()) {
      onSubmit(feedback);
      setFeedback("");
      onClose();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Refine this image</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Example: "Add 2 stools at the island", "Place plant near window", "Make lighting brighter and warmer".
          </p>
          <Textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Describe the changes you'd like..."
            rows={4}
            data-testid="textarea-amend-feedback"
          />
          <div className="flex justify-end space-x-2">
            <Button variant="outline" onClick={onClose} data-testid="button-amend-cancel">
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={!feedback.trim()} data-testid="button-amend-apply">
              Apply
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function BatchGallery({ results, onDownloadAll, onEnhanceMore, onDownloadSingle, onAmendImage, onRetryFailed, onRestart }: BatchGalleryProps) {
  const successfulResults = results.filter(r => r.ok && !r.error && r.image);
  const [amendModal, setAmendModal] = useState<{ isOpen: boolean; result: BatchResult | null }>({ isOpen: false, result: null });
  
  return (
    <section className="mb-12" data-testid="batch-gallery-section">
      <h3 className="text-2xl font-semibold mb-6 text-center">
        Your Enhanced Photos
        <span className="ml-2">✨</span>
      </h3>
      
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
        {results.map((result, index) => (
          <Card key={index} className="overflow-hidden" data-testid={`batch-result-${index}`}>
            <div className="relative h-48">
              {!result.ok || result.error ? (
                <div className="w-full h-full bg-red-100 dark:bg-red-900/20 flex items-center justify-center">
                  <div className="text-center">
                    <svg className="w-12 h-12 text-red-500 mx-auto mb-2" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
                    </svg>
                    <p className="text-red-500 text-sm font-medium">Processing Failed</p>
                    {result.error && (
                      <p className="text-red-400 text-xs mt-1 px-2">{result.error}</p>
                    )}
                    {onRetryFailed && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="mt-2 border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
                        onClick={() => onRetryFailed(result)}
                        data-testid={`button-retry-failed-${index}`}
                      >
                        <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                        </svg>
                        Try Again
                      </Button>
                    )}
                  </div>
                </div>
              ) : (
                <img 
                  src={result.image}
                  alt={`Enhanced ${result.filename}`}
                  className="w-full h-full object-cover"
                  data-testid={`enhanced-image-${index}`}
                />
              )}
              
              {result.ok && !result.error && (
                <>
                  <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent"></div>
                  <div className="absolute bottom-2 left-2 text-white text-sm font-medium">
                    Enhanced
                  </div>
                </>
              )}
            </div>
            
            <CardContent className="p-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground truncate" title={result.filename}>
                  {result.filename}
                </span>
                {result.ok && !result.error && (
                  <div className="flex space-x-2">
                    {onAmendImage && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setAmendModal({ isOpen: true, result })}
                        className="text-blue-500 hover:text-blue-400"
                        data-testid={`button-amend-${index}`}
                      >
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                        </svg>
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => onDownloadSingle(result)}
                      className="text-purple-500 hover:text-purple-400"
                      data-testid={`button-download-single-${index}`}
                    >
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                      </svg>
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      
      <div className="flex justify-center space-x-4">
        {successfulResults.length > 0 && (
          <Button 
            type="button"
            onClick={onDownloadAll}
            className="bg-gradient-to-r from-brand-primary to-brand-accent hover:from-purple-600 hover:to-purple-700 text-white shadow-lg shadow-purple-500/30 px-8 py-3"
            data-testid="button-download-all"
          >
            <svg className="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 24 24">
              <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
            </svg>
            Download All ({successfulResults.length})
          </Button>
        )}
        <Button 
          type="button"
          onClick={onEnhanceMore}
          variant="outline"
          data-testid="button-enhance-more"
        >
          <svg className="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 24 24">
            <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
          </svg>
          Load More Images
        </Button>
        {onRestart && (
          <Button 
            type="button"
            onClick={onRestart}
            variant="secondary"
            className="px-6 py-3"
            data-testid="button-restart"
          >
            <svg className="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58-8-8z"/>
            </svg>
            Start Over
          </Button>
        )}
      </div>
      
      <AmendModal
        isOpen={amendModal.isOpen}
        onClose={() => setAmendModal({ isOpen: false, result: null })}
        result={amendModal.result}
        onSubmit={(feedback) => {
          if (amendModal.result && onAmendImage) {
            onAmendImage(amendModal.result, feedback);
          }
        }}
      />
    </section>
  );
}
