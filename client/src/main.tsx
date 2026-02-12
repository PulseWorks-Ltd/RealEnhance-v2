import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/context/AuthContext";
import App from "./App";
import "@/index.css";
import { ErrorBoundary } from "@/shared/ErrorBoundary";

// ============================================================================
// CHUNK LOADING ERROR HANDLER
// ============================================================================
// Handle Vite chunk loading failures (e.g., after redeployment with new hashes)
// If a dynamically imported module fails to load, reload the page once to get fresh chunks
let chunkLoadingErrorHandled = false;

window.addEventListener('error', (event) => {
  // Check if this is a chunk loading error
  const isChunkError = event.message?.includes('Failed to fetch dynamically imported module') ||
                       event.message?.includes('Importing a module script failed');
  
  if (isChunkError && !chunkLoadingErrorHandled) {
    chunkLoadingErrorHandled = true;
    console.warn('[App] Chunk loading failed - reloading page to fetch updated assets');
    
    // Store current path to restore after reload
    sessionStorage.setItem('vite-chunk-reload', window.location.href);
    
    // Reload to get fresh chunks
    window.location.reload();
    
    // Prevent default error handling
    event.preventDefault();
  }
}, true);

// Restore previous path after chunk reload
const reloadedFrom = sessionStorage.getItem('vite-chunk-reload');
if (reloadedFrom) {
  sessionStorage.removeItem('vite-chunk-reload');
  // If we were trying to navigate somewhere, go there after reload
  if (window.location.href !== reloadedFrom) {
    window.history.replaceState(null, '', reloadedFrom);
  }
}

    <QueryClientProvider client={qc}>
      <AuthProvider>
        <BrowserRouter>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>
); 

