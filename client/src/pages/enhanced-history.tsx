/**
 * Enhanced Images Gallery
 *
 * Displays a gallery of previously enhanced images with quota-bound retention.
 * Retention: up to 3 months of plan allowance (FIFO expiry).
 */

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useUsage } from '@/hooks/use-usage';
import type { EnhancedImageListItem } from '@realenhance/shared/types';
import { CompareSlider } from '@/components/CompareSlider';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { Image, Download, Eye, ChevronLeft, ChevronRight, ImageOff, Loader2, Info } from 'lucide-react';

export default function EnhancedHistoryPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { usage } = useUsage();
  const [images, setImages] = useState<EnhancedImageListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<EnhancedImageListItem | null>(null);
  const limit = 24;

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

  const planName = usage?.planName;
  const monthlyIncludedImages = usage?.mainAllowance;
  const retentionCount = monthlyIncludedImages ? monthlyIncludedImages * 3 : null;

  if (!user?.agencyId) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Gallery"
          description="View and download your enhanced property photos"
        />
        <Alert>
          <AlertDescription>
            You need to be part of an organization to view enhanced images.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Gallery"
        description={`${total > 0 ? `${total} enhanced images` : 'Your enhanced property photos'}`}
        action={
          <Button variant="brand" onClick={() => navigate('/home')}>
            Enhance More Photos
          </Button>
        }
      />

      <Card>
        <CardContent className="pt-6">
          {loading && images.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 className="w-8 h-8 text-muted-foreground animate-spin mb-3" />
              <p className="text-sm text-muted-foreground">Loading your images...</p>
            </div>
          ) : error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : images.length === 0 ? (
            <EmptyState
              icon={ImageOff}
              title="No enhanced images yet"
              description="Your enhanced property photos will appear here after processing. Start by uploading some photos!"
              action={{
                label: "Enhance Photos",
                onClick: () => navigate('/home'),
                variant: "brand",
              }}
            />
          ) : (
            <>
              {/* Image Grid */}
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 mb-6">
                {images.map((image) => (
                  <div
                    key={image.id}
                    className="group relative rounded overflow-hidden border border-border bg-card hover:border-action-400 hover:shadow-card transition-all duration-200 cursor-pointer"
                    onClick={() => setSelected(image)}
                  >
                    {/* Image */}
                    <div className="aspect-square bg-muted">
                      <img
                        src={image.thumbnailUrl}
                        alt="Enhanced property photo"
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    </div>

                    {/* Status indicator */}
                    <div className="absolute top-2 right-2">
                      <StatusBadge 
                        status={(image as any).status === 'failed' ? 'error' : 'success'} 
                        label={(image as any).status === 'failed' ? 'Failed' : 'Ready'} 
                      />
                    </div>

                    {/* Overlay on hover */}
                    <div className="absolute inset-0 bg-brand-900/80 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex flex-col items-center justify-center gap-3 p-4">
                      {/* Stages badges */}
                      <div className="flex gap-1 flex-wrap justify-center">
                        {image.stagesCompleted.map((stage) => (
                          <Badge key={stage} variant="secondary" className="text-xs bg-white/20 text-white border-0">
                            {stage}
                          </Badge>
                        ))}
                      </div>

                      {/* Date */}
                      <p className="text-white/80 text-xs">
                        {new Date(image.createdAt).toLocaleDateString()}
                      </p>

                      {/* Actions */}
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          className="bg-white/20 hover:bg-white/30 text-white border-0"
                          onClick={(e) => { e.stopPropagation(); window.open(image.publicUrl, '_blank'); }}
                        >
                          <Eye className="w-4 h-4 mr-1" />
                          View
                        </Button>
                        <Button
                          size="sm"
                          className="bg-action-500 hover:bg-action-600 text-white"
                          onClick={(e) => { e.stopPropagation(); handleDownload(image); }}
                        >
                          <Download className="w-4 h-4 mr-1" />
                          Download
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Pagination */}
              {total > limit && (
                <div className="flex items-center justify-between pt-4 border-t border-border">
                  <p className="text-sm text-muted-foreground">
                    Showing {offset + 1}-{Math.min(offset + limit, total)} of {total} images
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handlePrevious}
                      disabled={offset === 0}
                    >
                      <ChevronLeft className="w-4 h-4 mr-1" />
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleNext}
                      disabled={offset + limit >= total}
                    >
                      Next
                      <ChevronRight className="w-4 h-4 ml-1" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Retention Policy Info */}
      {images.length > 0 && (
        <Card className="bg-surface-subtle border-border">
          <CardContent className="py-4">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-full bg-muted">
                <Info className="w-4 h-4 text-muted-foreground" />
              </div>
              <div className="text-sm text-muted-foreground space-y-1">
                <p className="font-medium text-foreground">Storage Policy</p>
                <p>
                  {planName && retentionCount
                    ? `Your ${planName} plan retains up to ${retentionCount} images (3 months of allowance).`
                    : 'Images are retained for up to 3 months of your plan allowance.'}
                  {' '}Download images you want to keep permanently.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Compare Modal */}
      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3">
              Compare Enhancement
              <StatusBadge status="success" label="Ready" />
            </DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4">
              {selected.originalUrl ? (
                <CompareSlider
                  originalImage={selected.originalUrl}
                  enhancedImage={selected.publicUrl}
                  height={520}
                  className="w-full rounded-lg overflow-hidden"
                  data-testid="history-compare-slider"
                />
              ) : (
                <div className="flex flex-col items-center justify-center gap-4 py-8 bg-muted rounded-lg">
                  <img
                    src={selected.publicUrl}
                    alt="Enhanced"
                    className="max-h-[460px] object-contain rounded-lg"
                  />
                  <p className="text-sm text-muted-foreground">
                    Original image not available for comparison
                  </p>
                </div>
              )}
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  Enhanced {new Date(selected.createdAt).toLocaleDateString()}
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setSelected(null)}>
                    Close
                  </Button>
                  <Button variant="brand" onClick={() => handleDownload(selected)}>
                    <Download className="w-4 h-4 mr-2" />
                    Download
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
