import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { ChevronDown } from "lucide-react";

export function FixedSelect({
  value,
  onValueChange,
  children,
  placeholder,
  className = "",
  disabled = false,
}: {
  value?: string;
  onValueChange?: (val: string) => void;
  children: React.ReactNode;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        className={`relative flex w-full items-center justify-between rounded-md border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-white shadow-sm hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown className="h-4 w-4 opacity-60" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          side="bottom"
          sideOffset={4}
          align="start"
          position="popper"
          className="z-[99999] max-h-[260px] w-[var(--radix-select-trigger-width)] overflow-y-auto rounded-md border border-gray-600 bg-gray-800 text-white shadow-xl data-[side=top]:hidden"
        >
          <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function FixedSelectItem({
  value,
  children,
  className = "",
}: {
  value: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <SelectPrimitive.Item
      value={value}
      className={`relative flex cursor-pointer select-none items-center rounded-sm px-3 py-2 text-sm outline-none hover:bg-gray-700 focus:bg-gray-700 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 ${className}`}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}
