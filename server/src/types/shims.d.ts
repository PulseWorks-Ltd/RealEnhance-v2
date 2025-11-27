// server/src/types/shims.d.ts

// 1. Tell TS that these modules exist (we don't care about strong typing here)
declare module '@realenhance/shared';
declare module 'bullmq';

// 2. Augment Express Request for multer
import 'express';

declare global {
  namespace Express {
    interface Request {
      file?: any;
      files?: any;
    }

    // Some of your code references Express.Multer.* – define a minimal shape
    namespace Multer {
      interface File {
        [key: string]: any;
      }
    }
  }
}
