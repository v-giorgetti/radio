import type { ComponentPropsWithoutRef } from "react";
import { cx } from "../cx";

export type SurfaceProps = ComponentPropsWithoutRef<"div"> & {
  elevation?: "flat" | "raised";
};

export function Surface({ elevation = "flat", className, ...props }: SurfaceProps) {
  return <div className={cx("r-surface", className)} data-elevation={elevation} {...props} />;
}
