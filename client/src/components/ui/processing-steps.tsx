import { cn } from "@/lib/utils";
import { Check, Loader2 } from "lucide-react";

export type ProcessingStep = {
  id: string;
  label: string;
  status: "pending" | "active" | "complete" | "error";
};

interface ProcessingStepsProps {
  steps: ProcessingStep[];
  className?: string;
}

/**
 * Visual processing steps indicator.
 * Shows progress through enhancement pipeline with clear status.
 */
export function ProcessingSteps({ steps, className }: ProcessingStepsProps) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {steps.map((step, index) => (
        <div key={step.id} className="flex items-center">
          {/* Step indicator */}
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium transition-colors",
                step.status === "complete" && "bg-status-success text-white",
                step.status === "active" && "bg-status-processing text-white",
                step.status === "error" && "bg-status-error text-white",
                step.status === "pending" && "bg-muted text-muted-foreground"
              )}
            >
              {step.status === "complete" ? (
                <Check className="w-3.5 h-3.5" />
              ) : step.status === "active" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                index + 1
              )}
            </div>
            <span
              className={cn(
                "text-sm hidden sm:inline",
                step.status === "active" && "font-medium text-foreground",
                step.status === "complete" && "text-status-success",
                step.status === "error" && "text-status-error",
                step.status === "pending" && "text-muted-foreground"
              )}
            >
              {step.label}
            </span>
          </div>

          {/* Connector line */}
          {index < steps.length - 1 && (
            <div
              className={cn(
                "w-8 h-0.5 mx-2",
                step.status === "complete" ? "bg-status-success" : "bg-border"
              )}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// Pre-defined step configurations for common flows
export const enhancementSteps: ProcessingStep[] = [
  { id: "upload", label: "Uploading", status: "pending" },
  { id: "enhance", label: "Enhancing", status: "pending" },
  { id: "validate", label: "Validating", status: "pending" },
  { id: "complete", label: "Complete", status: "pending" },
];

export function getStepsForProgress(
  currentStage: "upload" | "enhance" | "validate" | "complete" | "error",
  errorAt?: string
): ProcessingStep[] {
  const stageOrder = ["upload", "enhance", "validate", "complete"];
  const currentIndex = stageOrder.indexOf(currentStage);

  return enhancementSteps.map((step, index) => {
    if (errorAt === step.id) {
      return { ...step, status: "error" as const };
    }
    if (index < currentIndex) {
      return { ...step, status: "complete" as const };
    }
    if (index === currentIndex) {
      return { ...step, status: "active" as const };
    }
    return { ...step, status: "pending" as const };
  });
}

export default ProcessingSteps;
