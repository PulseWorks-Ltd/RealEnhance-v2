import React from "react";
import { createRoot } from "react-dom/client";  // ✅ Import createRoot directly
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/context/AuthContext";
import "@/index.css";
import { Toaster } from "@/components/ui/toaster";

// ✅ Setup query client
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

// ✅ Find root element and render once
const rootEl = document.getElementById("root");
if (!rootEl) throw new Error('Root element "#root" not found');

createRoot(rootEl).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <App />
          <Toaster />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>
);

// ✅ Surface any unhandled promise rejections
window.addEventListener("unhandledrejection", (e) => {
  console.error("Unhandled promise rejection:", e.reason);
});
