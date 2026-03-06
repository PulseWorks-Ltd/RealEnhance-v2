/**
 * Enhanced Images Gallery
 *
 * Displays previously enhanced/edited images grouped by property folder.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useUsage } from '@/hooks/use-usage';
import type { EnhancedImageGalleryResponse, EnhancedImageListItem, PropertyFolder } from '@realenhance/shared/types';
import { CompareSlider } from '@/components/CompareSlider';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { ImageOff, Loader2, Info, Download, Eye, Folder } from 'lucide-react';

export default function EnhancedHistoryPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { usage } = useUsage();

  const [properties, setProperties] = useState<PropertyFolder[]>([]);
  const [unassignedImages, setUnassignedImages] = useState<EnhancedImageListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<EnhancedImageListItem | null>(null);

  const fetchImages = async () => {
    try {
      setLoading(true);
      setError(null);

      if (!user?.agencyId) {
        setProperties([]);
        setUnassignedImages([]);
        setTotal(0);
        setLoading(false);
        return;
      }

      const response = await apiFetch('/api/enhanced-images?limit=200&offset=0');
      if (!response.ok) {
        throw new Error('Failed to load enhanced images');
      }

      const data: EnhancedImageGalleryResponse = await response.json();
      setProperties(Array.isArray(data.properties) ? data.properties : []);
      setUnassignedImages(Array.isArray(data.unassignedImages) ? data.unassignedImages : []);
      setTotal(Number(data.total || 0));
    } catch (err) {
      console.error('[enhanced-history] Failed to fetch images:', err);
      setError('Failed to load enhanced images. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchImages();
  }, [user?.agencyId]);

  const allImages = useMemo(
    () => [...properties.flatMap((folder) => folder.images), ...unassignedImages],
    [properties, unassignedImages]
  );

  const handleDownload = (image: EnhancedImageListItem) => {
    const link = document.createElement('a');
    link.href = image.publicUrl;
    link.download = `enhanced-${image.auditRef}.jpg`;
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const planName = usage?.planName;
  const monthlyIncludedImages = usage?.mainAllowance;
  const retentionCount = monthlyIncludedImages ? monthlyIncludedImages * 3 : null;

  if (!user?.agencyId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Gallery" description="View and download your enhanced property photos" />
        <Alert>
          <AlertDescription>
            You need to be part of an organization to view enhanced images.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const renderImageCard = (image: EnhancedImageListItem) => (
    <div
      key={image.id}
      className="group relative rounded-lg overflow-hidden border border-border bg-card hover:border-action-400 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 cursor-pointer"
      onClick={() => setSelected(image)}
    >
      <div className="aspect-[4/3] bg-muted">
        <img
          src={image.thumbnailUrl}
          alt="Enhanced property photo"
          className="w-full h-full object-cover"
          loading="lazy"
        />
      </div>

      <div className="absolute top-2 right-2">
        <StatusBadge status="success" label="Ready" />
      </div>

      {Number(image.versionCount || 0) > 0 && (
        <div className="absolute top-2 left-2">
          <Badge variant="secondary" className="bg-black/65 text-white border-0">
            Edited ({image.versionCount} versions)
          </Badge>
        </div>
      )}

      <div className="absolute inset-0 bg-brand-900/80 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex flex-col items-center justify-center gap-3 p-4">
        <div className="flex gap-1 flex-wrap justify-center">
          {image.stagesCompleted.map((stage) => (
            <Badge key={`${image.id}-${stage}`} variant="secondary" className="text-xs bg-white/20 text-white border-0">
              {stage}
            </Badge>
          ))}
          {image.source && (
            <Badge variant="secondary" className="text-xs bg-white/20 text-white border-0">
              {image.source}
            </Badge>
          )}
        </div>

        <p className="text-white/80 text-xs">{new Date(image.createdAt).toLocaleDateString()}</p>

        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="bg-white/20 hover:bg-white/30 text-white border-0"
            onClick={(e) => {
              e.stopPropagation();
              window.open(image.publicUrl, '_blank');
            }}
          >
            <Eye className="w-4 h-4 mr-1" />
            View
          </Button>
          <Button
            size="sm"
            className="bg-action-500 hover:bg-action-600 text-white"
            onClick={(e) => {
              e.stopPropagation();
              handleDownload(image);
            }}
          >
            <Download className="w-4 h-4 mr-1" />
            Download
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Gallery"
        description={total > 0 ? `${total} enhanced images` : 'Your enhanced property photos'}
        action={
          <Button variant="action" onClick={() => navigate('/home')}>
            Enhance More Photos
          </Button>
        }
      />

      <Card>
        <CardContent className="pt-6 space-y-8">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 className="w-8 h-8 text-muted-foreground animate-spin mb-3" />
              <p className="text-sm text-muted-foreground">Loading your images...</p>
            </div>
          ) : error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : allImages.length === 0 ? (
            <EmptyState
              icon={ImageOff}
              title="No enhanced images yet"
              description="Your enhanced property photos will appear here after processing. Start by uploading some photos!"
              action={{
                label: 'Enhance Photos',
                onClick: () => navigate('/home'),
                variant: 'brand',
              }}
            />
          ) : (
            <>
              {properties.map((folder) => (
                <section key={folder.id} className="space-y-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <Folder className="w-4 h-4" />
                    <span>{folder.address}</span>
                    <Badge variant="outline">{folder.images.length}</Badge>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {folder.images.map(renderImageCard)}
                  </div>
                </section>
              ))}

              <section className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Folder className="w-4 h-4" />
                  <span>Unassigned</span>
                  <Badge variant="outline">{unassignedImages.length}</Badge>
                </div>
                {unassignedImages.length > 0 ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {unassignedImages.map(renderImageCard)}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No unassigned images.</p>
                )}
              </section>
            </>
          )}
        </CardContent>
      </Card>

      {allImages.length > 0 && (
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
                  <img src={selected.publicUrl} alt="Enhanced" className="max-h-[460px] object-contain rounded-lg" />
                  <p className="text-sm text-muted-foreground">Original image not available for comparison</p>
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
                  <Button variant="action" onClick={() => handleDownload(selected)}>
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
