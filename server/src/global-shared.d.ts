// Declare shared module used by the server
declare module '@realenhance/shared' {
  export function findByPublicUrlRedis(...args: any[]): Promise<any>;
}

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
// server/src/global-shared.d.ts

// Tell TypeScript “this module exists; treat everything as any”
declare module '@realenhance/shared' {
  const value: any;
  export = value;
}
