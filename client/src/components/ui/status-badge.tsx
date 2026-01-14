import { cn } from "@/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2, CheckCircle2, XCircle, Clock, AlertCircle } from "lucide-react";

const statusBadgeVariants = cva(
  "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors",
  {
    variants: {
      status: {
        processing: "bg-status-processing/10 text-status-processing",
        success: "bg-white text-status-success border border-status-success/30 shadow-sm",
        error: "bg-status-error/10 text-status-error",
        warning: "bg-status-warning/10 text-status-warning",
        pending: "bg-muted text-muted-foreground",
        info: "bg-status-info/10 text-status-info",
      },
    },
    defaultVariants: {
      status: "pending",
    },
  }
);

interface StatusBadgeProps extends VariantProps<typeof statusBadgeVariants> {
  label?: string;
  showIcon?: boolean;
  className?: string;
}

const statusIcons = {
  processing: Loader2,
  success: CheckCircle2,
  error: XCircle,
  warning: AlertCircle,
  pending: Clock,
  info: AlertCircle,
};

const statusLabels = {
  processing: "Enhancing",
  success: "Ready",
  error: "Failed",
  warning: "Warning",
  pending: "Pending",
  info: "Info",
};

/**
 * Status badge component with consistent styling across the app.
 * Maps processing states to user-friendly labels.
 */
export function StatusBadge({
  status = "pending",
  label,
  showIcon = true,
  className,
}: StatusBadgeProps) {
  const Icon = statusIcons[status || "pending"];
  const displayLabel = label || statusLabels[status || "pending"];

  return (
    <span className={cn(statusBadgeVariants({ status }), className)}>
      {showIcon && (
        <span className={cn("inline-flex items-center justify-center rounded-full", status === "success" ? "bg-white w-5 h-5 shadow-[0_0_0_1px_rgba(34,197,94,0.35)]" : "")}
          aria-hidden="true"
        >
          <Icon
            className={cn(
              "w-3.5 h-3.5",
              status === "processing" && "animate-spin"
            )}
          />
        </span>
      )}
      {displayLabel}
    </span>
  );
}

export default StatusBadge;
