import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentPropsWithoutRef } from "react";
import { cx } from "../cx";

export type ButtonVariant = "default" | "primary" | "accent" | "ghost" | "outline";

export type ButtonProps = ComponentPropsWithoutRef<typeof BaseButton> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  /** Square button holding only an icon. Requires an aria-label. */
  iconOnly?: boolean;
};

export function Button({
  variant = "default",
  size = "md",
  iconOnly,
  className,
  ...props
}: ButtonProps) {
  return (
    <BaseButton
      className={cx("r-button", typeof className === "string" && className)}
      data-variant={variant}
      data-size={size}
      data-icon-only={iconOnly ? "" : undefined}
      {...props}
    />
  );
}
