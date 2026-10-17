// shadcn/ui Button，按 docs/ui-design.md §5.3 只留三种：
// - primary：实心深色（深色主题下反色），每屏最多一个；
// - secondary：浅灰底、无边框；只放图标的按钮（size icon / icon-sm）平时透明、悬停才出底色；
// - danger：只在确认框里出现，所以 Button 不接受它，只能用 dialog.tsx 的 DialogDangerButton。
// 高度 34 / 小号 28，圆角 10 / 8，文字 500。
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

export const buttonVariants = cva(
  "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-primary/85",
        secondary: "bg-secondary text-foreground hover:bg-secondary-hover",
        danger: "bg-danger text-on-danger hover:bg-danger/90",
      },
      size: {
        default: "h-[34px] rounded-lg px-3.5 text-sm [&_svg]:size-4",
        sm: "h-7 rounded-md px-2.5 text-xs [&_svg]:size-3.5",
        icon: "size-[34px] rounded-lg [&_svg]:size-5",
        "icon-sm": "size-7 rounded-md [&_svg]:size-4",
      },
    },
    compoundVariants: [
      { variant: "secondary", size: "icon", class: "bg-transparent hover:bg-hover" },
      { variant: "secondary", size: "icon-sm", class: "bg-transparent hover:bg-hover" },
    ],
    defaultVariants: { variant: "primary", size: "default" },
  },
);

/** 页面上可用的按钮样式；danger 只在确认框里（DialogDangerButton）。 */
export type ButtonVariant = "primary" | "secondary";

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    Omit<VariantProps<typeof buttonVariants>, "variant"> {
  variant?: ButtonVariant;
}

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return (
    <button
      type={type}
      data-variant={variant ?? "primary"}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
