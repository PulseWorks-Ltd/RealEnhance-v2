// client/src/App.tsx
import { Route, Switch } from "wouter";
import { Header } from "@/components/header";
import Home from "@/pages/home";
import Editor from "@/pages/Editor";
import Results from "@/pages/Results";
import { RegionEditPage } from "@/pages/RegionEditPage"; // keep your named export
import MyPhotos from "@/pages/MyPhotos";
import NotFound from "@/pages/not-found";
import Landing from "@/pages/landing"; // ⬅️ use the landing page you have

export default function App() {
  return (
    <main className="min-h-screen flex flex-col bg-brand-light text-foreground dark:bg-background">
      <Header />
      <div className="flex-1">
        <Switch>
          {/* New: show Landing at root */}
          <Route path="/" component={Landing} />

          {/* Old Home now lives at /app (and keep /home as alias) */}
          <Route path="/app" component={Home} />
          <Route path="/home" component={Home} />

          <Route path="/editor" component={Editor} />
          <Route path="/results" component={Results} />
          <Route path="/regions" component={RegionEditPage} />
          <Route path="/photos" component={MyPhotos} />
          <Route>
            <NotFound />
          </Route>
        </Switch>
      </div>
    </main>
  );
}

/**
 * PERF NOTE (Priority 3, to address in perf pass):
 * Slow switch to logged-in state is usually one of:
 * 1) popup postMessage timing; add a short `/api/auth/user` poll (1s up to ~20–30s) as fallback
 * 2) Railway warm-up delay right after deploy
 * 3) caching/stale React Query state
 */
