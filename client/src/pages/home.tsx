// client/src/pages/home.tsx
import BatchProcessor from "@/components/batch-processor";
import { PageHeader } from "@/components/ui/page-header";

export default function Home() {
  return (
    <div className="space-y-6" data-testid="home-page">
      <PageHeader
        title="Enhance Property Photos"
        description="Upload property photos to declutter, enhance, and stage them with professional AI in seconds"
      />
      
      {/* Batch Processor - Main Interface */}
      <BatchProcessor />
    </div>
  );
}
