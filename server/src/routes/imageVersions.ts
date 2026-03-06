import { Router, type Request, type Response } from 'express';
import { getImageVersions } from '../services/enhancedImages.js';

export function imageVersionsRouter() {
  const router = Router();

  router.get('/images/:imageId/versions', async (req: Request, res: Response) => {
    try {
      const user = (req.session as any)?.user;
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (!user.agencyId) {
        return res.status(404).json({ error: 'Image not found' });
      }

      const imageId = req.params.imageId;
      const isAdminOrOwner = user.role === 'admin' || user.role === 'owner';

      const versions = await getImageVersions(
        imageId,
        user.agencyId,
        isAdminOrOwner ? undefined : user.id
      );

      if (!versions.length) {
        return res.status(404).json({ error: 'Image not found' });
      }

      return res.json({ imageId, versions });
    } catch (error) {
      console.error('[image-versions] Get versions error:', error);
      return res.status(500).json({ error: 'Failed to fetch image versions' });
    }
  });

  return router;
}
