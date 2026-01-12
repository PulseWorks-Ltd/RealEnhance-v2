/**
 * Previously Enhanced Images History Page
 *
 * Displays a gallery of previously enhanced images with quota-bound retention.
 * Retention: up to 3 months of plan allowance (FIFO expiry).
 */

import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useUsage } from '@/hooks/use-usage';
import type { EnhancedImageListItem } from '@realenhance/shared/types';

export default function EnhancedHistoryPage() {
  const { user } = useAuth();
  const { usage } = useUsage();
  const [images, setImages] = useState<EnhancedImageListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const limit = 24; // Show 24 images per page

  // Fetch enhanced images
  const fetchImages = async (resetOffset = false) => {
    try {
      setLoading(true);
      setError(null);

      const currentOffset = resetOffset ? 0 : offset;

      if (!user?.agencyId) {
        setImages([]);
        setTotal(0);
        setLoading(false);
        return;
      }

      const response = await apiFetch(
        `/api/enhanced-images?limit=${limit}&offset=${currentOffset}`
      );

      if (!response.ok) {
        throw new Error('Failed to load enhanced images');
      }

      const data = await response.json();
      setImages(data.images || []);
      setTotal(data.total || 0);

      if (resetOffset) {
        setOffset(0);
      }
    } catch (err) {
      console.error('[enhanced-history] Failed to fetch images:', err);
      setError('Failed to load enhanced images. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchImages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset, user?.agencyId]);

  // Download image
  const handleDownload = (image: EnhancedImageListItem) => {
    const link = document.createElement('a');
    link.href = image.publicUrl;
    link.download = `enhanced-${image.auditRef}.jpg`;
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Pagination handlers
  const handlePrevious = () => {
    if (offset > 0) {
      setOffset(Math.max(0, offset - limit));
    }
  };

  const handleNext = () => {
    if (offset + limit < total) {
      setOffset(offset + limit);
    }
  };

  const fallbackRetentionCopy =
    'Previously enhanced images are retained for up to 3 months of your plan allowance. Please download any images you want to keep long-term.';

  const planName = usage?.planName;
  const monthlyIncludedImages = usage?.mainAllowance;
  const retentionCount = monthlyIncludedImages ? monthlyIncludedImages * 3 : null;
  const retentionCopy =
    planName && retentionCount
      ? `${planName} retains up to ${retentionCount} enhanced images (3 months of your plan allowance). Please download any images you want to keep long-term.`
      : fallbackRetentionCopy;

  if (!user?.agencyId) {
    return (
      <div className="container mx-auto p-6">
        <Alert>
          <AlertDescription>
            You need to be part of an agency to view previously enhanced images.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Previously Enhanced Images</CardTitle>
          <CardDescription>{retentionCopy}</CardDescription>
        </CardHeader>
        <CardContent>
          {loading && images.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              Loading...
            </div>
          ) : error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : images.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <p className="text-lg mb-2">No enhanced images yet</p>
              <p className="text-sm">
                Your enhanced images will appear here after processing
              </p>
            </div>
          ) : (
            <>
              {/* Image Grid */}
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 mb-6">
                {images.map((image) => (
                  <div
                    key={image.id}
                    className="group relative rounded-lg overflow-hidden border border-gray-200 hover:border-purple-500 transition-all cursor-pointer"
                  >
                    {/* Image */}
                    <div className="aspect-square">
                      <img
                        src={image.thumbnailUrl}
                        alt="Enhanced"
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    </div>

                    {/* Overlay on hover */}
                    <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-3 p-4">
                      {/* Stages badges */}
                      <div className="flex gap-1 flex-wrap justify-center">
                        {image.stagesCompleted.map((stage) => (
                          <Badge key={stage} variant="secondary" className="text-xs">
                            {stage}
                          </Badge>
                        ))}
                      </div>

                      {/* Date */}
                      <p className="text-white text-xs">
                        {new Date(image.createdAt).toLocaleDateString()}
                      </p>

                      {/* Actions */}
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => window.open(image.publicUrl, '_blank')}
                        >
                          View
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleDownload(image)}
                        >
                          Download
                        </Button>
                      </div>

                      {/* Audit ref (small) */}
                      <p className="text-white/70 text-[10px]">
                        Ref: {image.auditRef}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              {/* Pagination */}
              {total > limit && (
                <div className="flex items-center justify-between pt-4 border-t border-gray-200">
                  <p className="text-sm text-gray-600">
                    Showing {offset + 1}-{Math.min(offset + limit, total)} of {total} images
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handlePrevious}
                      disabled={offset === 0}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleNext}
                      disabled={offset + limit >= total}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Help Text */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Retention Policy</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-gray-600 space-y-2">
          <p>{retentionCopy}</p>
          <p>
            Older images are automatically removed when you exceed your retention limit (oldest
            first). We recommend downloading images you want to keep for longer than the retention
            period.
          </p>
          <p className="font-medium text-gray-700">
            This is not long-term storage. Download your images to keep them permanently.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
