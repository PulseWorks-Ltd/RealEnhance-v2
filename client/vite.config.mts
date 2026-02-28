// client/vite.config.mts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const devApiTarget = process.env.VITE_DEV_API_TARGET || "http://localhost:5000";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Avoid aliasing to parent folders (../shared, ../attached_assets)
      // because the client service container won't include them.
    },
  },
  build: {
    outDir: "dist", // ✅ build stays inside client/
    emptyOutDir: true,
    // Enable better chunk splitting for lazy routes
    rollupOptions: {
      output: {
        manualChunks: {
          // Split vendor chunks for better caching
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'ui-vendor': ['@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu'],
        },
      },
    },
    // Generate manifest for tracking assets
    manifest: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: devApiTarget,
        changeOrigin: true,
        secure: false,
        ws: true,
      },
      "/auth": {
        target: devApiTarget,
        changeOrigin: true,
        secure: false,
        ws: true,
      },
    },
  },
  preview: {
    allowedHosts: true,
    host: "0.0.0.0",
    port: Number(process.env.PORT) || 8080,
    headers: {
      // Prevent caching of index.html
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  },
});