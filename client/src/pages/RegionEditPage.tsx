// client/src/pages/RegionEditPage.tsx
import { useState } from "react";
import { RegionEditor } from "@/components/region-editor";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface RegionEditResult {
  imageUrl: string;
  originalUrl: string;
  maskUrl: string;
}

export function RegionEditPage() {
  const [result, setResult] = useState<RegionEditResult | null>(null);
  const [showComparison, setShowComparison] = useState(false);

  const handleComplete = (editResult: RegionEditResult) => {
    setResult(editResult);
    setShowComparison(true);
  };

  const handleReset = () => {
    setResult(null);
    setShowComparison(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-dark via-brand-primary to-brand-accent text-white p-6">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-4">Region Edit Workflow</h1>
          <p className="text-xl text-gray-300">
            Precisely edit specific regions of your images with AI enhancement and Smart Reinstate
          </p>
        </div>

        {!showComparison ? (
          <RegionEditor onComplete={handleComplete} />
        ) : (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-2xl font-semibold">Region Edit Results</h2>
              <Button onClick={handleReset} variant="outline" data-testid="button-reset-editor">
                Edit Another Image
              </Button>
            </div>

            {result && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Original Image */}
                <Card>
                  <CardHeader>
                    <CardTitle>Original</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <img
                      src={result.originalUrl}
                      alt="Original image"
                      className="w-full h-auto rounded-lg border border-gray-600"
                      data-testid="img-original-result"
                    />
                  </CardContent>
                </Card>

                {/* Region Mask */}
                <Card>
                  <CardHeader>
                    <CardTitle>Region Mask</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <img
                      src={result.maskUrl}
                      alt="Region mask"
                      className="w-full h-auto rounded-lg border border-gray-600 bg-black"
                      data-testid="img-mask-result"
                    />
                    <p className="text-sm text-gray-400 mt-2">
                      White areas show the edited region
                    </p>
                  </CardContent>
                </Card>

                {/* Enhanced Image */}
                <Card>
                  <CardHeader>
                    <CardTitle>Enhanced Result</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <img
                      src={result.imageUrl}
                      alt="Enhanced image"
                      className="w-full h-auto rounded-lg border border-gray-600"
                      data-testid="img-enhanced-result"
                    />
                    <div className="mt-4 space-y-2">
                      <Button
                        onClick={() => {
                          const link = document.createElement('a');
                          link.href = result.imageUrl;
                          link.download = 'enhanced-image.png';
                          link.click();
                        }}
                        className="w-full"
                        data-testid="button-download-result"
                      >
                        Download Enhanced Image
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* Smart Reinstate Feature */}
            <Card>
              <CardHeader>
                <CardTitle>Smart Reinstate</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-gray-300 mb-4">
                  If you're not satisfied with specific parts of the enhancement, you can use Smart Reinstate 
                  to restore selected regions to their original state while keeping other improvements.
                </p>
                <Button variant="outline" disabled data-testid="button-smart-reinstate">
                  Launch Smart Reinstate (Coming Soon)
                </Button>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

export default RegionEditPage;
