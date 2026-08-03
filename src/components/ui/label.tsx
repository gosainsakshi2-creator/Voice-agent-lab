"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";

import { cn } from "@/lib/utils";

function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex select-none items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-subtle-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
