// client/src/pages/home.tsx
import BatchProcessor from "@/components/batch-processor";
import { PageHeader } from "@/components/ui/page-header";

export default function Home() {
  return (
    <div className="space-y-6" data-testid="home-page">
      <PageHeader
        title="Enhance Photos"
        description="Upload property photos and let AI enhance them with professional-quality improvements"
      />
      
      {/* Batch Processor - Main Interface */}
      <BatchProcessor />
    </div>
  );
}
