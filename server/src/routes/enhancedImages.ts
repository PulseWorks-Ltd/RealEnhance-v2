/**
 * Enhanced Images API Routes
 *
 * Endpoints for "Previously Enhanced Images" history feature.
 * Provides quota-bound retention (3 months of plan allowance).
 */

import { Router, type Request, type Response } from 'express';
import { listEnhancedImages, getEnhancedImage } from '../services/enhancedImages.js';
import type { EnhancedImageListItem, EnhancedImage } from '@realenhance/shared/types';

export function enhancedImagesRouter() {
  const router = Router();

  /**
   * GET /api/enhanced-images
   *
   * List previously enhanced images for the authenticated user
   *
   * Query params:
   * - limit: Max results (default: 50, max: 100)
   * - offset: Pagination offset (default: 0)
   *
   * Permissions:
   * - Regular users: See only their own images
   * - Agency admins/owners: See all agency images
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      // Require authentication
      const user = req.session?.user;
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Check if user has agency (required for enhanced images)
      if (!user.agencyId) {
        return res.json({ images: [], total: 0 }); // No agency = no enhanced images
      }

      // Parse query params
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const offset = parseInt(req.query.offset as string) || 0;

      // Check user role for permissions
      const isAdminOrOwner = user.role === 'owner' || user.role === 'admin';

      // List images (admin sees all, regular user sees only their own)
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
      const user = req.session?.user;
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
