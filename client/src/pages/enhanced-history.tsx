/**
 * Enhanced Images Gallery
 *
 * Displays previously enhanced/edited images grouped by property folder.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useUsage } from '@/hooks/use-usage';
import { useToast } from '@/hooks/use-toast';
import type { EnhancedImageGalleryResponse, EnhancedImageListItem, PropertyFolder } from '@realenhance/shared/types';
import { CompareSlider } from '@/components/CompareSlider';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { ImageOff, Loader2, Info, Download, Pencil, Folder } from 'lucide-react';
import { Modal } from '@/components/Modal';
import { RegionEditor } from '@/components/region-editor';
import type { SourceStageLabel } from '@/lib/edit-source';

const GALLERY_FETCH_LIMIT = 5000;

const DOWNLOAD_MIME_EXTENSION_MAP: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

function getExtensionFromMime(contentType?: string | null): string {
  const normalized = String(contentType || '').split(';')[0].trim().toLowerCase();
  return DOWNLOAD_MIME_EXTENSION_MAP[normalized] || '';
}

function getDownloadFilename(filenameBase: string, contentType?: string | null): string {
  const ext = getExtensionFromMime(contentType) || '.jpg';
  const baseName = String(filenameBase || 'enhanced-image').trim() || 'enhanced-image';
  return /^.+\.[a-z0-9]+$/i.test(baseName) ? baseName : `${baseName}${ext}`;
}

function resolveHistoryEditSourceStage(image: EnhancedImageListItem): SourceStageLabel | null {
  if (image.source === 'region-edit') return 'edit';

  const completedStages = new Set((image.stagesCompleted || []).map((stage) => String(stage).toUpperCase()));
  if (completedStages.has('2')) return '2';
  if (completedStages.has('1B')) return '1B';
  if (completedStages.has('1A') || completedStages.has('1')) return '1A';

  return image.publicUrl ? '2' : null;
}

type HistoryEditStatus = 'processing' | 'success' | 'failed';

function resolveHistoryStatusBadge(status?: HistoryEditStatus): { status: 'processing' | 'success' | 'error'; label: string } {
  if (status === 'processing') {
    return { status: 'processing', label: 'Editing' };
  }
  if (status === 'success') {
    return { status: 'success', label: 'Edited' };
  }
  if (status === 'failed') {
    return { status: 'error', label: 'Edit failed' };
  }
  return { status: 'success', label: 'Ready' };
}

export default function EnhancedHistoryPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { usage } = useUsage();
  const { toast } = useToast();

  const [properties, setProperties] = useState<PropertyFolder[]>([]);
  const [unassignedImages, setUnassignedImages] = useState<EnhancedImageListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<EnhancedImageListItem | null>(null);
  const [editingImage, setEditingImage] = useState<EnhancedImageListItem | null>(null);
  const [editStatusByImageId, setEditStatusByImageId] = useState<Record<string, HistoryEditStatus>>({});

  const fetchImages = useCallback(async () => {
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

      const response = await apiFetch(`/api/enhanced-images?limit=${GALLERY_FETCH_LIMIT}&offset=0`);
      if (!response.ok) {
        if (response.status >= 500) {
          throw new Error('Gallery is temporarily unavailable. Please try again in a few minutes.');
        }
        throw new Error('Failed to load enhanced images');
      }

      const data: EnhancedImageGalleryResponse = await response.json();
      setProperties(Array.isArray(data.properties) ? data.properties : []);
      setUnassignedImages(Array.isArray(data.unassignedImages) ? data.unassignedImages : []);
      setTotal(Number(data.total || 0));
    } catch (err) {
      console.error('[enhanced-history] Failed to fetch images:', err);
      const message = err instanceof Error ? err.message : 'Failed to load enhanced images. Please try again.';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [user?.agencyId]);

  useEffect(() => {
    void fetchImages();
  }, [fetchImages]);

  const allImages = useMemo(
    () => [...properties.flatMap((folder) => folder.images), ...unassignedImages],
    [properties, unassignedImages]
  );

  const handleDownload = async (image: EnhancedImageListItem) => {
    if (user?.emailVerified !== true) {
      toast({
        title: 'Email Verification Required',
        description: 'Please confirm your email address to download the images.',
        variant: 'destructive',
      });
      return;
    }

    try {
      if (!image.publicUrl) {
        throw new Error('Image is not available for download');
      }

      const fallbackFilename = `enhanced_${String(image.auditRef || image.id || 'image').trim() || 'image'}`;
      const response = await apiFetch('/api/enhanced-images/download-file', {
        method: 'POST',
        body: JSON.stringify({
          filename: fallbackFilename,
          url: image.publicUrl,
        }),
      }, 120_000);

      const blob = await response.blob();
      if (!blob.size) {
        throw new Error('Downloaded file was empty');
      }

      const contentType = blob.type || response.headers.get('content-type');
      if (!String(contentType || '').toLowerCase().startsWith('image/')) {
        throw new Error('Download response was not an image');
      }

      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = getDownloadFilename(fallbackFilename, contentType);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => window.URL.revokeObjectURL(objectUrl), 0);
    } catch (error) {
      console.error('[enhanced-history] Download failed:', error);
      toast({
        title: 'Download Failed',
        description: error instanceof Error ? error.message : 'Unable to download the image. Please try again.',
        variant: 'destructive',
      });
    }
  };

  const handleOpenEditor = useCallback((image: EnhancedImageListItem) => {
    const resolvedStage = resolveHistoryEditSourceStage(image);

    if (!image.publicUrl || !image.jobId || !image.id || !resolvedStage) {
      toast({
        title: 'Edit unavailable',
        description: 'This history item is missing persisted lineage required for editing.',
        variant: 'destructive',
      });
      return;
    }

    setEditingImage(image);
  }, [toast]);

  const handleOpenPreview = useCallback((image: EnhancedImageListItem) => {
    setPreviewImage(image);
  }, []);

  const handleEditFromPreview = useCallback(() => {
    if (!previewImage) return;
    setPreviewImage(null);
    handleOpenEditor(previewImage);
  }, [handleOpenEditor, previewImage]);

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
    (() => {
      const statusBadge = resolveHistoryStatusBadge(editStatusByImageId[String(image.id)]);

      return (
        <div
          key={image.id}
          className="group relative overflow-hidden rounded-xl border border-border bg-card shadow-sm hover:border-action-400 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200"
        >
      <button
        type="button"
        className="relative block aspect-[4/3] w-full overflow-hidden bg-muted text-left"
        onClick={() => handleOpenPreview(image)}
        aria-label="Preview enhanced image"
      >
        <img
          src={image.thumbnailUrl}
          alt="Enhanced property photo"
          className="w-full h-full object-cover"
          loading="lazy"
        />
        <div className="absolute inset-0 flex items-center justify-center bg-brand-900/55 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <span className="rounded-full bg-white/90 px-3 py-1 text-sm font-medium text-slate-900 shadow-sm">
            Preview
          </span>
        </div>
      </button>

      <div className="absolute top-2 right-2">
        <StatusBadge status={statusBadge.status} label={statusBadge.label} />
      </div>

      {Number(image.versionCount || 0) > 0 && (
        <div className="absolute top-2 left-2">
          <Badge variant="secondary" className="bg-black/65 text-white border-0">
            Edited ({image.versionCount} versions)
          </Badge>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-brand-950/90 via-brand-950/45 to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100 flex flex-col items-center justify-end gap-3 p-4">
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

        <div className="pointer-events-auto flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="bg-white/20 hover:bg-white/30 text-white border-0"
            onClick={(e) => {
              e.stopPropagation();
              handleOpenEditor(image);
            }}
          >
            <Pencil className="w-4 h-4 mr-1" />
            Edit
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
    })()
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
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-5">
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
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-5">
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

      {previewImage && (
        <Modal
          isOpen={!!previewImage}
          onClose={() => setPreviewImage(null)}
          title="Preview Image"
          maxWidth="2xl"
        >
          <div className="space-y-4">
            {previewImage.originalUrl ? (
              <CompareSlider
                originalImage={previewImage.originalUrl}
                enhancedImage={previewImage.publicUrl}
                height={520}
                className="w-full rounded-lg overflow-hidden"
                data-testid="history-compare-slider"
              />
            ) : (
              <div className="flex flex-col items-center justify-center gap-4 py-8 bg-muted rounded-lg">
                <img src={previewImage.publicUrl} alt="Enhanced" className="max-h-[460px] object-contain rounded-lg" />
                <p className="text-sm text-muted-foreground">Original image not available for comparison</p>
              </div>
            )}
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Enhanced {new Date(previewImage.createdAt).toLocaleDateString()}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setPreviewImage(null)}>
                  Close
                </Button>
                <Button
                  variant="secondary"
                  onClick={handleEditFromPreview}
                >
                  <Pencil className="w-4 h-4 mr-2" />
                  Edit
                </Button>
                <Button variant="action" onClick={() => handleDownload(previewImage)}>
                  <Download className="w-4 h-4 mr-2" />
                  Download
                </Button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {editingImage && (
        <Modal
          isOpen={!!editingImage}
          onClose={() => setEditingImage(null)}
          title="Edit Image"
          maxWidth="full"
          contentClassName="w-screen h-screen max-w-none !p-0 !m-0 !rounded-none border-0 overflow-hidden"
          className="h-full w-full !p-0 !m-0 !space-y-0 bg-transparent"
        >
          <RegionEditor
            source="history"
            initialImageUrl={editingImage.publicUrl}
            originalImageUrl={editingImage.originalUrl || undefined}
            editSourceUrl={editingImage.publicUrl}
            editSourceStage={resolveHistoryEditSourceStage(editingImage) || undefined}
            sourceJobId={editingImage.jobId}
            sourceImageId={editingImage.id}
            onCancel={() => setEditingImage(null)}
            onStart={() => {
              setEditStatusByImageId((current) => ({
                ...current,
                [String(editingImage.id)]: 'processing',
              }));
            }}
            onError={() => {
              setEditStatusByImageId((current) => ({
                ...current,
                [String(editingImage.id)]: 'failed',
              }));
            }}
            onComplete={() => {
              setEditStatusByImageId((current) => ({
                ...current,
                [String(editingImage.id)]: 'success',
              }));
              setEditingImage(null);
              void fetchImages();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
