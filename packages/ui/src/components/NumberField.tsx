import { NumberField as BaseNumberField } from "@base-ui/react/number-field";

export type NumberFieldProps = {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  "aria-label": string;
  suffix?: string;
  disabled?: boolean;
};

export function NumberField({
  value,
  onValueChange,
  min,
  max,
  step = 1,
  suffix,
  disabled,
  "aria-label": ariaLabel,
}: NumberFieldProps) {
  return (
    <BaseNumberField.Root
      className="r-number-field"
      value={value}
      onValueChange={(v) => v != null && onValueChange(v)}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
    >
      <BaseNumberField.Group className="r-number-field__group">
        <BaseNumberField.Decrement className="r-number-field__step" aria-label={`Decrease ${ariaLabel}`}>
          −
        </BaseNumberField.Decrement>
        <BaseNumberField.Input className="r-number-field__input" aria-label={ariaLabel} />
        {suffix && <span className="r-number-field__suffix">{suffix}</span>}
        <BaseNumberField.Increment className="r-number-field__step" aria-label={`Increase ${ariaLabel}`}>
          +
        </BaseNumberField.Increment>
      </BaseNumberField.Group>
    </BaseNumberField.Root>
  );
}
