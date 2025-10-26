import React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
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
  children,
  className,
  contentClassName,
  showCloseButton = true,
  maxWidth = "lg",
  "data-testid": testId = "modal"
}: ModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent 
        className={cn(
          maxWidthClasses[maxWidth],
          contentClassName
        )}
        data-testid={testId}
      >
        <DialogHeader>
          <DialogTitle 
            className={!title ? "sr-only" : undefined}
            data-testid={`${testId}-title`}
          >
            {title || "Dialog"}
          </DialogTitle>
        </DialogHeader>
        
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