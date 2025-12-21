// Augment Express Request with multer fields
declare namespace Express {
  interface Request {
    file?: any;
    files?: any;
  }

  // Minimal Multer namespace to satisfy any references
  namespace Multer {
    interface File {
      [key: string]: any;
    }
  }
}
