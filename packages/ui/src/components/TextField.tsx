import { Field } from "@base-ui/react/field";
import { Input } from "@base-ui/react/input";
import type { ReactNode } from "react";
import { cx } from "../cx";

export type TextFieldProps = {
  label?: string;
  /** Required when no visible label is shown. */
  "aria-label"?: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  description?: ReactNode;
  type?: "text" | "search" | "password" | "url";
  leading?: ReactNode;
  className?: string;
};

export function TextField({
  label,
  value,
  onValueChange,
  placeholder,
  description,
  type = "text",
  leading,
  className,
  "aria-label": ariaLabel,
}: TextFieldProps) {
  return (
    <Field.Root className={cx("r-field", className)}>
      {label && <Field.Label className="r-field__label">{label}</Field.Label>}
      <div className="r-input" data-has-leading={leading ? "" : undefined}>
        {leading && <span className="r-input__leading">{leading}</span>}
        <Input
          className="r-input__control"
          type={type}
          value={value}
          placeholder={placeholder}
          aria-label={label ? undefined : ariaLabel}
          onValueChange={(v) => onValueChange(v)}
        />
      </div>
      {description && <Field.Description className="r-field__description">{description}</Field.Description>}
    </Field.Root>
  );
}
