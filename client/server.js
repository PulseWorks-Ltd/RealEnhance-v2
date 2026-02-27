// Simple Express server to serve the built Vite app with SPA fallback
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// ============================================================================
// CACHE CONTROL MIDDLEWARE
// ============================================================================
// Apply proper caching strategy to prevent chunk loading errors after deployment
app.use((req, res, next) => {
  const url = req.url;
  
  // Don't cache index.html (or any HTML files)
  // This ensures users always get the latest version with correct chunk references
  if (url.endsWith('.html') || url === '/' || !url.includes('.')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  } 
  // Aggressively cache static assets with hash in filename
  // These are immutable and safe to cache long-term
  else if (url.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|webp|ico)$/)) {
    // If file has hash in name (e.g., app-abc123.js), cache for 1 year
    if (url.match(/\.[a-f0-9]{8,}\./)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } 
    // Otherwise cache for 1 hour (for assets without hashes)
    else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
  
  next();
});

// Serve static files from the dist directory
app.use(express.static(path.join(__dirname, 'dist')));

// SPA fallback - serve index.html for all non-file routes
app.get('*', (req, res) => {
  // Ensure index.html is never cached
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Client server listening on port ${PORT}`);
  console.log(`Cache control: HTML files = no-cache, Static assets = long-term cache`);
});
