import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ReactNode } from "react";
import { CloseIcon } from "../icons";
import { Button } from "./Button";
import { useStationTheme } from "./StationTheme";

export type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "md" | "lg";
};

export function Dialog({ open, onOpenChange, title, description, children, footer, size = "md" }: DialogProps) {
  const { portalContainer } = useStationTheme();
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal container={portalContainer}>
        <BaseDialog.Backdrop className="r-dialog__backdrop" />
        <BaseDialog.Popup className="r-popup r-dialog" data-size={size}>
          <header className="r-dialog__header">
            <div>
              <BaseDialog.Title className="r-dialog__title">{title}</BaseDialog.Title>
              {description && (
                <BaseDialog.Description className="r-dialog__description">{description}</BaseDialog.Description>
              )}
            </div>
            <BaseDialog.Close render={<Button variant="ghost" iconOnly size="sm" aria-label="Close" />}>
              <CloseIcon />
            </BaseDialog.Close>
          </header>
          <div className="r-dialog__body">{children}</div>
          {footer && <footer className="r-dialog__footer">{footer}</footer>}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
