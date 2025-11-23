import fs from 'fs/promises';

export async function ensureValidLocalImage(localPath: string): Promise<void> {
  const exists = await fs
    .access(localPath)
    .then(() => true)
    .catch(() => false);

  if (!exists) {
    console.error('[retry] File does not exist:', localPath);
    throw new Error('Retry base file missing');
  }

  const buf = await fs.readFile(localPath).catch((err) => {
    console.error('[retry] Error reading file:', localPath, err);
    return null;
  });

  if (!buf || buf.length < 100) {
    console.error('[retry] Invalid or corrupt file detected:', localPath, buf?.length);
    throw new Error('Corrupt file on retry');
  }
}

// Usage example (in your retry handler):
// await ensureValidLocalImage(localPath);
// ...then call your existing pipeline logic
