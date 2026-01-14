import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { SafeSlot } from "@/components/ui/safe-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-brand-900 text-white hover:bg-brand-800 shadow-sm",
        primary: "bg-brand-900 text-white hover:bg-brand-800 shadow-sm", // Alias for default
        action: "bg-action-600 text-white hover:bg-action-700 shadow-sm", // Emerald Success
        destructive: "bg-red-600 text-white hover:bg-red-700 shadow-sm",
        outline: "border border-brand-200 bg-white hover:bg-brand-50 text-brand-900",
        secondary: "bg-brand-100 text-brand-900 hover:bg-brand-200",
        ghost: "hover:bg-brand-50 text-brand-700 hover:text-brand-900",
        link: "text-brand-900 underline-offset-4 hover:underline",

        // Mapped legacy variants
        brand: "bg-brand-900 text-white hover:bg-brand-800 shadow-sm",
        brandHighlight: "bg-gold-500 text-white hover:bg-gold-600 shadow-sm",
        brandSoft: "bg-surface-subtle text-brand-900 border border-brand-200 hover:bg-brand-50",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10 p-0",
      },
      loading: {
        true: "relative cursor-wait",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
  loading: false,
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

const Spinner = () => (
  <svg className="animate-spin -ml-0.5 mr-1 h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4A4 4 0 0 0 8 12H4z" />
  </svg>
);

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, asChild = false, children, disabled, ...props }, ref) => {
    // Use SafeSlot to avoid React.Children.only at runtime when asChild is misused
    const Comp: any = asChild ? SafeSlot : "button";
    return (
      <Comp
        ref={ref}
  className={cn(buttonVariants({ variant, size, loading: !!loading, className }))}
        disabled={disabled || loading}
        aria-busy={!!loading}
        {...props}
      >
        {loading ? <Spinner /> : null}
        {children}
      </Comp>
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };

