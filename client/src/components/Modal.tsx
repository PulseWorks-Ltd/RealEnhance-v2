import React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  headerContent?: React.ReactNode;
  headerActions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  headerClassName?: string;
  showCloseButton?: boolean;
  maxWidth?: "sm" | "md" | "lg" | "xl" | "2xl" | "full";
  "data-testid"?: string;
}

const maxWidthClasses = {
  sm: "sm:max-w-sm",
  md: "sm:max-w-md", 
  lg: "sm:max-w-lg",
  xl: "sm:max-w-xl",
  "2xl": "sm:max-w-2xl",
  full: "sm:max-w-full"
};

export function Modal({
  isOpen,
  onClose,
  title,
  headerContent,
  headerActions,
  children,
  className,
  contentClassName,
  headerClassName,
  showCloseButton = true,
  maxWidth = "lg",
  "data-testid": testId = "modal"
}: ModalProps) {
  const hasCustomHeaderLayout = !!headerContent || !!headerActions;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent 
        className={cn(
          maxWidthClasses[maxWidth],
          contentClassName
        )}
        data-testid={testId}
      >
        {hasCustomHeaderLayout ? (
          <DialogHeader className={cn("space-y-3 text-left", headerClassName)}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <DialogTitle
                className={cn("min-w-0 text-left", !title ? "sr-only" : undefined)}
                data-testid={`${testId}-title`}
              >
                {title || "Dialog"}
              </DialogTitle>
              {headerActions ? (
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  {headerActions}
                </div>
              ) : null}
            </div>
            {headerContent ? (
              <div className="flex justify-center">
                {headerContent}
              </div>
            ) : null}
          </DialogHeader>
        ) : (
          <DialogHeader>
            <DialogTitle 
              className={!title ? "sr-only" : undefined}
              data-testid={`${testId}-title`}
            >
              {title || "Dialog"}
            </DialogTitle>
          </DialogHeader>
        )}
        
        <div 
          className={cn("space-y-4", className)}
          data-testid={`${testId}-content`}
        >
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}