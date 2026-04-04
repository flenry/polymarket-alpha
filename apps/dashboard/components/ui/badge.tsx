import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-slate-950 focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-blue-600 text-white",
        secondary:
          "border-transparent bg-slate-100 text-slate-900",
        destructive:
          "border-transparent bg-red-500 text-white",
        outline: "text-slate-950",
        // Signal type variants
        purple:
          "border-transparent bg-purple-100 text-purple-800",
        blue:
          "border-transparent bg-blue-100 text-blue-800",
        orange:
          "border-transparent bg-orange-100 text-orange-800",
        teal:
          "border-transparent bg-teal-100 text-teal-800",
        indigo:
          "border-transparent bg-indigo-100 text-indigo-800",
        violet:
          "border-transparent bg-violet-100 text-violet-800",
        green:
          "border-transparent bg-green-100 text-green-800",
        amber:
          "border-transparent bg-amber-100 text-amber-800",
        red:
          "border-transparent bg-red-100 text-red-800",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
