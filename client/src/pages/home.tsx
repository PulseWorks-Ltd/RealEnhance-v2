// client/src/pages/home.tsx
import BatchProcessor from "@/components/batch-processor";

export default function Home() {
  return (
    <div className="w-full h-screen overflow-hidden flex flex-col" data-testid="home-page">
      <div className="mx-auto mt-0 pt-2 mb-0 max-w-4xl px-4 text-center sm:px-6 lg:px-8 shrink-0">
        <h1 className="bg-gradient-to-b from-slate-900 to-slate-700 bg-clip-text text-lg sm:text-xl font-extrabold tracking-tight text-transparent">
          Turn Every Listing into a Show-Home
        </h1>
        <p className="mt-1 text-sm text-slate-500 hidden sm:block">
          Transform your full property gallery into market-ready assets in under 2 minutes
        </p>
      </div>
      
      {/* Batch Processor - Main Interface */}
      <div className="flex-1 min-h-0 relative">
        <BatchProcessor />
      </div>
    </div>
  );
}
