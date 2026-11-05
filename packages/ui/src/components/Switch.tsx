import { Switch as BaseSwitch } from "@base-ui/react/switch";

export type SwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  "aria-label": string;
  disabled?: boolean;
};

export function Switch({ checked, onCheckedChange, disabled, "aria-label": ariaLabel }: SwitchProps) {
  return (
    <BaseSwitch.Root
      className="r-switch"
      checked={checked}
      onCheckedChange={(c) => onCheckedChange(c)}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      <BaseSwitch.Thumb className="r-switch__thumb" />
    </BaseSwitch.Root>
  );
}
