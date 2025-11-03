"use client"

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"

type SafeSlotProps = React.ComponentPropsWithoutRef<typeof Slot> & {
  children: React.ReactNode
}

/**
 * SafeSlot only uses Radix <Slot> when there's exactly one valid React element child.
 * Otherwise, it falls back to a harmless <span> wrapper to avoid React.Children.only.
 */
export function SafeSlot({ children, ...props }: SafeSlotProps) {
  const arr = React.Children.toArray(children)
  const single = arr.length === 1 && React.isValidElement(arr[0])

  if (single) {
    return <Slot {...props}>{arr[0] as React.ReactElement}</Slot>
  }

  return <span {...props}>{children}</span>
}
