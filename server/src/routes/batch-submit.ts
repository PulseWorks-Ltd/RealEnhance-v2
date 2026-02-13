/**
 * Batch Upload Handler - Server Side
 * Splits batch uploads into individual BullMQ jobs
 */

import { Router } from 'express';
import { Queue } from 'bullmq';
import crypto from 'crypto';
import { JOB_QUEUE_NAME } from '@realenhance/shared/constants';
import { enqueueEnhanceJob } from '../services/jobs.js';

const REDIS_URL = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || 'redis://localhost:6379';
const enhanceQueue = new Queue(JOB_QUEUE_NAME, {
  connection: { url: REDIS_URL }
});

const router = Router();

interface BatchUploadRequest {
  userId: string;
  agencyId?: string;
  images: Array<{
    imageId: string;
    originalPath: string;
    originalUrl?: string;
    filename: string;
    options: {
      sceneType?: string;
      roomType?: string;
      declutter?: boolean;
      declutterMode?: 'light' | 'stage-ready';
      virtualStage?: boolean;
      stagingStyle?: string;
      replaceSky?: boolean;
    };
  }>;
}

/**
 * POST /api/batch/submit
 * Splits batch into individual jobs and returns batchId for tracking
 */
router.post('/submit', async (req, res) => {
  try {
    const sessUser = (req.session as any)?.user;
    if (!sessUser?.id) {
      return res.status(401).json({ error: 'not_authenticated' });
    }

    const { agencyId, images }: BatchUploadRequest = req.body;
    // Always derive userId from session — never trust request body
    const userId = sessUser.id;

    if (!userId) {
      return res.status(400).json({ error: 'userId required' });
    }

    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'images array required' });
    }

    // Generate unique batchId
    const batchId = `batch_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    
    console.log(`[Batch] Creating batch ${batchId} with ${images.length} images for user ${userId}`);

    // Create individual job for each image
    const jobPromises = images.map(async (image, index) => {
      const jobId = `${batchId}_img${index + 1}_${Date.now()}`;

      // Validate required fields
      if (!image.originalPath) {
        throw new Error(`Image ${image.imageId} missing originalPath`);
      }

      const { jobId: enqueuedJobId } = await enqueueEnhanceJob({
        userId,
        imageId: image.imageId,
        agencyId: agencyId || userId,
        remoteOriginalUrl: image.originalUrl,
        options: {
          sceneType: image.options.sceneType || 'auto',
          roomType: image.options.roomType || 'unknown',
          declutter: image.options.declutter || false,
          declutterMode: image.options.declutterMode,
          virtualStage: image.options.virtualStage || false,
          stagingStyle: image.options.stagingStyle,
          replaceSky: image.options.replaceSky
        }
      }, jobId);

      console.log(`[Batch] Created job ${enqueuedJobId} (${index + 1}/${images.length})`);

      return {
        jobId: enqueuedJobId,
        imageId: image.imageId,
        index
      };
    });

    const jobs = await Promise.all(jobPromises);

    // Return batch info
    res.json({
      ok: true,
      batchId,
      totalJobs: jobs.length,
      jobs: jobs.map(j => ({
        jobId: j.jobId,
        imageId: j.imageId,
        index: j.index
      }))
    });

  } catch (error: any) {
    console.error('[Batch] Error creating batch:', error);
    res.status(500).json({
      error: 'Failed to create batch',
      message: error.message
    });
  }
});

/**
 * GET /api/batch/status/:batchId
 * Get status of all jobs in a batch
 */
router.get('/status/:batchId', async (req, res) => {
  try {
    const sessUser = (req.session as any)?.user;
    if (!sessUser?.id) {
      return res.status(401).json({ error: 'not_authenticated' });
    }

    const { batchId } = req.params;

    // Find all jobs with this batchId
    const jobs = await enhanceQueue.getJobs(['waiting', 'active', 'completed', 'failed']);
    const batchJobs = jobs.filter((job: any) => job.data.batchId === batchId);

    if (batchJobs.length === 0) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    const jobStatuses = await Promise.all(
      batchJobs.map(async (job: any) => {
        const state = await job.getState();
        const progress = job.progress || 0;

        return {
          jobId: job.id,
          imageId: job.data.imageId,
          index: job.data.batchIndex,
          state,
          progress,
          returnvalue: job.returnvalue,
          failedReason: job.failedReason
        };
      })
    );

    // Sort by index
    jobStatuses.sort((a, b) => a.index - b.index);

    // Calculate overall progress
    const totalProgress = jobStatuses.reduce((sum, j) => sum + (j.progress || 0), 0);
    const avgProgress = Math.floor(totalProgress / jobStatuses.length);

    const completed = jobStatuses.filter(j => j.state === 'completed').length;
    const failed = jobStatuses.filter(j => j.state === 'failed').length;
    const processing = jobStatuses.filter(j => j.state === 'active').length;
    const queued = jobStatuses.filter(j => j.state === 'waiting').length;

    res.json({
      batchId,
      total: jobStatuses.length,
      completed,
      failed,
      processing,
      queued,
      progress: avgProgress,
      jobs: jobStatuses
    });

  } catch (error: any) {
    console.error('[Batch] Error getting status:', error);
    res.status(500).json({
      error: 'Failed to get batch status',
      message: error.message
    });
  }
});

export default router;
