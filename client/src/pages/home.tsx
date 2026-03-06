// client/src/pages/home.tsx
import BatchProcessor from "@/components/batch-processor";

export default function Home() {
  return (
    <div className="w-full" data-testid="home-page">
      <div className="mx-auto mb-12 max-w-4xl px-4 text-center sm:px-6 lg:px-8">
        <h1 className="bg-gradient-to-b from-slate-900 to-slate-700 bg-clip-text text-4xl font-extrabold tracking-tight text-transparent">
          Turn Every Listing into a Show-Home
        </h1>
        <p className="mt-2 text-lg text-slate-500">
          Transform your full property gallery into market-ready assets in under 2 minutes
        </p>
      </div>
      
      {/* Batch Processor - Main Interface */}
      <BatchProcessor />
    </div>
  );
}
