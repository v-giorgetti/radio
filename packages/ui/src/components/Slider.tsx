import { Slider as BaseSlider } from "@base-ui/react/slider";
import { cx } from "../cx";

export type SliderProps = {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  orientation?: "horizontal" | "vertical";
  tone?: "neutral" | "accent";
  /** Fill from the midpoint outward — for bipolar values such as EQ gain. */
  centered?: boolean;
  disabled?: boolean;
  "aria-label": string;
  /** Human-readable value for assistive technology, e.g. "+3 dB". */
  getValueText?: (value: number) => string;
  className?: string;
};

export function Slider({
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  orientation = "horizontal",
  tone = "neutral",
  centered = false,
  disabled,
  getValueText,
  className,
  "aria-label": ariaLabel,
}: SliderProps) {
  return (
    <BaseSlider.Root
      className={cx("r-slider", className)}
      data-tone={tone}
      data-centered={centered ? "" : undefined}
      value={value}
      onValueChange={(next) => onValueChange(Array.isArray(next) ? next[0]! : next)}
      min={min}
      max={max}
      step={step}
      orientation={orientation}
      disabled={disabled}
    >
      <BaseSlider.Control className="r-slider__control">
        <BaseSlider.Track className="r-slider__track">
          {centered ? (
            <CenterFill value={value} min={min} max={max} orientation={orientation} />
          ) : (
            <BaseSlider.Indicator className="r-slider__indicator" />
          )}
          <BaseSlider.Thumb
            className="r-slider__thumb"
            aria-label={ariaLabel}
            getAriaValueText={getValueText ? (_formatted, v) => getValueText(v) : undefined}
          />
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  );
}

function CenterFill({
  value,
  min,
  max,
  orientation,
}: {
  value: number;
  min: number;
  max: number;
  orientation: "horizontal" | "vertical";
}) {
  const pct = ((value - min) / (max - min)) * 100;
  const lo = Math.min(50, pct);
  const hi = 100 - Math.max(50, pct);
  const style =
    orientation === "vertical" ? { bottom: `${lo}%`, top: `${hi}%` } : { left: `${lo}%`, right: `${hi}%` };
  return <div className="r-slider__indicator r-slider__center-fill" style={style} aria-hidden />;
}
