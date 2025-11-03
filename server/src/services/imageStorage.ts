import { promises as fs } from 'fs';
import { join } from 'path';
import path from 'path';
import crypto from 'crypto';

// Simple image storage service to prevent memory issues with large base64 responses
class ImageStorageService {
  private readonly storageDir = join(process.cwd(), 'storage', 'images');
  private baseUrl = process.env.BASE_URL || 'http://localhost:5000';

  // Method to update base URL from request
  setBaseUrlFromRequest(req: any) {
    const proto = (req.headers["x-forwarded-proto"] as string) || "https";
    const host  = (req.headers["x-forwarded-host"] as string) || req.headers.host;
    if (host) {
      this.baseUrl = `${proto}://${host}`;
    }
  }

  constructor() {
    this.ensureStorageDir();
  }

  private async ensureStorageDir() {
    try {
      await fs.mkdir(this.storageDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create storage directory:', error);
    }
  }

  async storeEditImage(params: {
    userId: string;
    sourceDataUrl: string;
    filenameBase: string;
  }): Promise<{ path: string; url: string }> {
    const { userId, sourceDataUrl, filenameBase } = params;
    
    // Extract base64 data and detect format
    const matches = sourceDataUrl.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
    if (!matches) {
      throw new Error('Invalid data URL format');
    }
    
    const [, format, base64Data] = matches;
    const buffer = Buffer.from(base64Data, 'base64');
    
    // Generate secure filename with timestamp and random suffix
    const timestamp = Date.now();
    const randomSuffix = crypto.randomBytes(4).toString('hex');
    const filename = `${filenameBase}-${timestamp}-${randomSuffix}.${format}`;
    const userDir = join(this.storageDir, userId);
    
    // Ensure user directory exists
    await fs.mkdir(userDir, { recursive: true });
    
    const filePath = join(userDir, filename);
    // Use forward slashes for URLs, not OS-specific path separators
    const relativePath = `${userId}/${filename}`;
    
    // Save the image file
    await fs.writeFile(filePath, buffer);
    
    // Generate signed access URL
    const url = this.generateSignedUrl(relativePath);
    
    return { path: relativePath, url };
  }

  async getImage(imagePath: string): Promise<Buffer | null> {
    try {
      // Prevent path traversal attacks
      if (!imagePath || typeof imagePath !== 'string') {
        console.error('Invalid image path provided:', imagePath);
        return null;
      }
      
      // Normalize and validate the path to prevent directory traversal
      const normalizedPath = imagePath.replace(/\.\./g, '').replace(/^\/+/, '');
      if (normalizedPath !== imagePath) {
        console.error('Path traversal attempt detected:', imagePath);
        return null;
      }
      
      // Ensure path contains only valid characters (letters, numbers, slashes, hyphens, underscores, dots)
      if (!/^[a-zA-Z0-9\/_.-]+$/.test(normalizedPath)) {
        console.error('Invalid characters in image path:', imagePath);
        return null;
      }
      
      // Ensure the path follows expected format: userId/filename.ext
      const pathParts = normalizedPath.split('/');
      if (pathParts.length !== 2) {
        console.error('Invalid image path format, expected userId/filename:', imagePath);
        return null;
      }
      
      const [userId, filename] = pathParts;
      if (!userId || !filename || !filename.includes('.')) {
        console.error('Invalid userId or filename in path:', imagePath);
        return null;
      }
      
      const fullPath = join(this.storageDir, normalizedPath);
      
      // Additional security check: ensure resolved path is within storage directory
      const resolvedPath = path.resolve(fullPath);
      const resolvedStorageDir = path.resolve(this.storageDir);
      if (!resolvedPath.startsWith(resolvedStorageDir)) {
        console.error('Path traversal attempt - resolved path outside storage directory:', resolvedPath);
        return null;
      }
      
      return await fs.readFile(fullPath);
    } catch (error) {
      console.error('Failed to read image:', error);
      return null;
    }
  }

  async cleanupOldImages(maxAgeHours = 24 * 14): Promise<void> {
    try {
      const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);
      
      const userDirs = await fs.readdir(this.storageDir);
      
      for (const userDir of userDirs) {
        const userPath = join(this.storageDir, userDir);
        
        try {
          const files = await fs.readdir(userPath);
          
          for (const file of files) {
            const filePath = join(userPath, file);
            const stats = await fs.stat(filePath);
            
            if (stats.mtime.getTime() < cutoffTime) {
              await fs.unlink(filePath);
              console.log(`Cleaned up old image: ${file}`);
            }
          }
          
          // Remove empty user directories
          const remainingFiles = await fs.readdir(userPath);
          if (remainingFiles.length === 0) {
            await fs.rmdir(userPath);
          }
        } catch (error) {
          console.error(`Error cleaning user directory ${userDir}:`, error);
        }
      }
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  }

  // Generate a signed URL that expires after a certain time
  generateSignedUrl(imagePath: string, expiresInSeconds = 7 * 24 * 3600): string {
    const expiry = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const secret = process.env.IMAGE_SIGNING_SECRET;
    if (!secret) {
      throw new Error('IMAGE_SIGNING_SECRET environment variable is required for security');
    }
    
    const payload = `${imagePath}:${expiry}`;
    const signature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
    
    return `${this.baseUrl}/api/images/${imagePath}?expires=${expiry}&signature=${signature}`;
  }

  verifySignedUrl(imagePath: string, expires: string, signature: string): boolean {
    const now = Math.floor(Date.now() / 1000);
    const expiry = parseInt(expires);
    
    if (now > expiry) {
      return false; // URL has expired
    }
    
    const secret = process.env.IMAGE_SIGNING_SECRET;
    if (!secret) {
      throw new Error('IMAGE_SIGNING_SECRET environment variable is required for security');
    }
    const payload = `${imagePath}:${expiry}`;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
    
    return signature === expectedSignature;
  }
}

export const imageStorage = new ImageStorageService();

// Cleanup old images every hour
setInterval(() => {
  imageStorage.cleanupOldImages().catch(console.error);
}, 60 * 60 * 1000);