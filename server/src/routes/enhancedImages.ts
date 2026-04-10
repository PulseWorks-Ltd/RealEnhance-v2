/**
 * Enhanced Images API Routes
 *
 * Endpoints for "Previously Enhanced Images" history feature.
 * Provides quota-bound retention (3 months of plan allowance).
 */

import { Router, type Request, type Response } from 'express';
import { listEnhancedImages, getEnhancedImage } from '../services/enhancedImages.js';
import { makeZip } from '../services/zipper.js';

const ENHANCED_IMAGES_DEFAULT_LIMIT = Math.max(1, Number(process.env.ENHANCED_IMAGES_DEFAULT_LIMIT || 200));
const ENHANCED_IMAGES_MAX_LIMIT = Math.max(ENHANCED_IMAGES_DEFAULT_LIMIT, Number(process.env.ENHANCED_IMAGES_MAX_LIMIT || 5000));
const ENHANCED_IMAGES_ZIP_MAX_FILES = Math.max(1, Number(process.env.ENHANCED_IMAGES_ZIP_MAX_FILES || 250));

type DownloadZipManifestItem = {
  filename?: unknown;
  url?: unknown;
  dataUrl?: unknown;
};

function getRequestOrigin(req: Request): string {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0]?.trim();
  const protocol = forwardedProto || req.protocol || 'https';
  const host = req.get('host') || 'localhost';
  return `${protocol}://${host}`;
}

function normalizeManifestItems(req: Request, input: unknown): Array<{ filename: string; url?: string; dataUrl?: string }> {
  if (!Array.isArray(input)) return [];

  return input
    .map((raw): { filename: string; url?: string; dataUrl?: string } | null => {
      const item = (raw || {}) as DownloadZipManifestItem;
      const filename = String(item.filename || '').trim();
      const rawUrl = typeof item.url === 'string' ? item.url.trim() : '';
      const dataUrl = typeof item.dataUrl === 'string' ? item.dataUrl.trim() : '';

      if (!filename) return null;
      if (!rawUrl && !dataUrl) return null;

      if (dataUrl.startsWith('data:image/')) {
        return { filename, dataUrl };
      }

      if (!rawUrl) return null;

      try {
        const resolvedUrl = new URL(rawUrl, getRequestOrigin(req));
        if (!['http:', 'https:'].includes(resolvedUrl.protocol)) {
          return null;
        }
        return { filename, url: resolvedUrl.toString() };
      } catch {
        return null;
      }
    })
    .filter((item): item is { filename: string; url?: string; dataUrl?: string } => !!item)
    .slice(0, ENHANCED_IMAGES_ZIP_MAX_FILES);
}

export function enhancedImagesRouter() {
  const router = Router();

  /**
   * GET /api/enhanced-images
   *
   * List previously enhanced images for the authenticated user
   *
   * Query params:
  * - limit: Max results (default: 200, max: 5000)
   * - offset: Pagination offset (default: 0)
   *
   * Permissions:
   * - Regular users: See only their own images
   * - Agency admins/owners: See all agency images
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      // Require authentication
      const user = (req.session as any)?.user;
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Check if user has agency (required for enhanced images)
      if (!user.agencyId) {
        return res.json({ images: [], total: 0 }); // No agency = no enhanced images
      }

      // Parse query params
      const requestedLimit = parseInt(req.query.limit as string, 10);
      const limit = Math.max(
        1,
        Math.min(Number.isFinite(requestedLimit) ? requestedLimit : ENHANCED_IMAGES_DEFAULT_LIMIT, ENHANCED_IMAGES_MAX_LIMIT)
      );
      const offset = parseInt(req.query.offset as string) || 0;

      // Check user role for permissions
      const isAdminOrOwner = user.role === 'owner' || user.role === 'admin';

      // List images (admin sees all in agency, agents/members only see their own)
      const result = await listEnhancedImages(
        user.agencyId,
        isAdminOrOwner ? undefined : user.id, // undefined = all agency images
        limit,
        offset
      );

      res.json(result);
    } catch (error) {
      console.error('[enhanced-images] List error:', error);
      res.status(500).json({ error: 'Failed to list enhanced images' });
    }
  });

  /**
   * GET /api/enhanced-images/:id/download
   * Server-side gated download redirect.
   */
  router.get('/:id/download', async (req: Request, res: Response) => {
    try {
      const user = (req.session as any)?.user;
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (user.emailVerified !== true) {
        return res.status(403).json({
          error: 'EMAIL_NOT_VERIFIED',
          message: 'Please confirm your email address to download the images.',
        });
      }

      if (!user.agencyId) {
        return res.status(404).json({ error: 'Image not found' });
      }

      const imageId = req.params.id;
      const isAdminOrOwner = user.role === 'owner' || user.role === 'admin';

      const image = await getEnhancedImage(
        imageId,
        user.agencyId,
        isAdminOrOwner ? undefined : user.id
      );

      if (!image?.publicUrl) {
        return res.status(404).json({ error: 'Image not found' });
      }

      return res.redirect(302, image.publicUrl);
    } catch (error) {
      console.error('[enhanced-images] Download gate error:', error);
      return res.status(500).json({ error: 'Failed to prepare download' });
    }
  });

  router.post('/download-zip', async (req: Request, res: Response) => {
    try {
      const user = (req.session as any)?.user;
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (user.emailVerified !== true) {
        return res.status(403).json({
          error: 'EMAIL_NOT_VERIFIED',
          message: 'Please confirm your email address to download the images.',
        });
      }

      const manifest = normalizeManifestItems(req, (req.body as any)?.files);
      if (!manifest.length) {
        return res.status(400).json({ error: 'No images provided for ZIP download' });
      }

      const zipInputs: Array<{ filename: string; dataUrl?: string; buffer?: Buffer; contentType?: string | null }> = [];
      let failedCount = 0;

      for (const item of manifest) {
        if (item.dataUrl) {
          zipInputs.push({ filename: item.filename, dataUrl: item.dataUrl });
          continue;
        }

        if (!item.url) {
          failedCount += 1;
          continue;
        }

        try {
          const response = await fetch(item.url, {
            redirect: 'follow',
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) {
            failedCount += 1;
            continue;
          }

          const arrayBuffer = await response.arrayBuffer();
          if (!arrayBuffer.byteLength) {
            failedCount += 1;
            continue;
          }

          const contentType = response.headers.get('content-type');
          if (contentType && !contentType.toLowerCase().startsWith('image/')) {
            failedCount += 1;
            continue;
          }

          zipInputs.push({
            filename: item.filename,
            buffer: Buffer.from(arrayBuffer),
            contentType,
          });
        } catch (error) {
          console.warn('[enhanced-images] ZIP fetch failed', { url: item.url, error });
          failedCount += 1;
        }
      }

      const zipResult = await makeZip({
        userId: String(user.id || 'anonymous'),
        files: zipInputs,
      });

      const totalFailed = failedCount + zipResult.skippedCount;
      if (zipResult.addedCount === 0) {
        return res.status(502).json({ error: 'No images could be downloaded' });
      }

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="enhanced-images-${Date.now()}.zip"`);
      res.setHeader('X-Zip-Added-Count', String(zipResult.addedCount));
      res.setHeader('X-Zip-Failed-Count', String(totalFailed));
      return res.send(zipResult.buffer);
    } catch (error) {
      console.error('[enhanced-images] ZIP download error:', error);
      return res.status(500).json({ error: 'Failed to create ZIP file' });
    }
  });

  /**
   * GET /api/enhanced-images/:id
   *
   * Get a single enhanced image by ID
   *
   * Permissions:
   * - Regular users: Can only access their own images
   * - Agency admins/owners: Can access all agency images
   */
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      // Require authentication
      const user = (req.session as any)?.user;
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Check if user has agency
      if (!user.agencyId) {
        return res.status(404).json({ error: 'Image not found' });
      }

      const imageId = req.params.id;

      // Check user role for permissions
      const isAdminOrOwner = user.role === 'owner' || user.role === 'admin';

      // Get image (admin sees all, regular user sees only their own)
      const image = await getEnhancedImage(
        imageId,
        user.agencyId,
        isAdminOrOwner ? undefined : user.id
      );

      if (!image) {
        return res.status(404).json({ error: 'Image not found' });
      }

      res.json(image);
    } catch (error) {
      console.error('[enhanced-images] Get error:', error);
      res.status(500).json({ error: 'Failed to get enhanced image' });
    }
  });

  return router;
}
