// client/src/pages/home.tsx
import BatchProcessor from "@/components/batch-processor";
import { PageHeader } from "@/components/ui/page-header";

export default function Home() {
  return (
    <div className="space-y-6 w-full" data-testid="home-page">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <PageHeader
          title="Turn Every Listing into a Show-Home"
          description="Transform your full property gallery into market-ready assets in under 2 minutes"
        />
      </div>
      
      {/* Batch Processor - Main Interface */}
      <BatchProcessor />
    </div>
  );
}
