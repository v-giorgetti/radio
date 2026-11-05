import { Progress } from "@base-ui/react/progress";

export type ProgressBarProps = {
  /** 0–100, or null when indeterminate. */
  value: number | null;
  "aria-label": string;
  tone?: "neutral" | "accent";
};

export function ProgressBar({ value, tone = "accent", "aria-label": ariaLabel }: ProgressBarProps) {
  return (
    <Progress.Root className="r-progress" data-tone={tone} value={value} aria-label={ariaLabel}>
      <Progress.Track className="r-progress__track">
        <Progress.Indicator className="r-progress__indicator" />
      </Progress.Track>
    </Progress.Root>
  );
}
