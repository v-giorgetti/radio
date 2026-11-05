import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { useStationTheme } from "./StationTheme";

export type TooltipProps = {
  content: ReactNode;
  /** The trigger element; it receives the tooltip's trigger props. */
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
};

export const TooltipProvider = BaseTooltip.Provider;

export function Tooltip({ content, children, side = "top" }: TooltipProps) {
  const { portalContainer } = useStationTheme();
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal container={portalContainer}>
        <BaseTooltip.Positioner side={side} sideOffset={8}>
          <BaseTooltip.Popup className="r-popup r-tooltip">{content}</BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
