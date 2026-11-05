import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { motion } from "motion/react";
import { useId, type ReactNode } from "react";
import { transition } from "../tokens";

export type SegmentedOption<T extends string> = { value: T; label: ReactNode };

export type SegmentedControlProps<T extends string> = {
  value: T;
  onValueChange: (value: T) => void;
  options: Array<SegmentedOption<T>>;
  "aria-label": string;
  size?: "sm" | "md";
};

/** Single-choice toggle group with a sliding selection pill. */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  size = "md",
  "aria-label": ariaLabel,
}: SegmentedControlProps<T>) {
  const layoutId = useId();
  return (
    <ToggleGroup
      className="r-segmented"
      data-size={size}
      value={[value]}
      onValueChange={(next) => {
        const picked = next[0] as T | undefined;
        if (picked) onValueChange(picked);
      }}
      aria-label={ariaLabel}
    >
      {options.map((o) => (
        <Toggle key={o.value} value={o.value} className="r-segmented__item">
          {o.value === value && (
            <motion.span layoutId={layoutId} className="r-segmented__pill" transition={transition.panel} />
          )}
          <span className="r-segmented__label">{o.label}</span>
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
