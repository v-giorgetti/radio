import { Toggle } from "@base-ui/react/toggle";
import { AnimatePresence, motion } from "motion/react";
import { PlayIcon, SpinnerIcon, StopIcon } from "../icons";
import { transition } from "../tokens";

export type ListenStatus = "stopped" | "connecting" | "live";

export type ListenButtonProps = {
  status: ListenStatus;
  /** Called with true to tune in, false to stop. Never auto-plays. */
  onListenChange: (listen: boolean) => void;
  disabled?: boolean;
};

const labels: Record<ListenStatus, string> = {
  stopped: "Listen",
  connecting: "Tuning in",
  live: "Stop",
};

const swap = {
  initial: { opacity: 0, y: 8, scale: 0.9 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -8, scale: 0.9 },
  transition: transition.panel,
};

export function ListenButton({ status, onListenChange, disabled }: ListenButtonProps) {
  const pressed = status !== "stopped";
  const Icon = status === "live" ? StopIcon : status === "connecting" ? SpinnerIcon : PlayIcon;

  return (
    <Toggle
      className="r-button r-listen"
      data-variant={pressed ? "primary" : "accent"}
      data-status={status}
      pressed={pressed}
      onPressedChange={onListenChange}
      disabled={disabled}
      aria-label={status === "live" ? "Stop listening" : "Listen live"}
      render={<motion.button layout transition={transition.panel} />}
    >
      <span className="r-listen__icon">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span key={status} style={{ display: "grid" }} {...swap}>
            <Icon />
          </motion.span>
        </AnimatePresence>
      </span>
      <span className="r-listen__label" aria-live="polite">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span key={status} {...swap}>
            {labels[status]}
          </motion.span>
        </AnimatePresence>
      </span>
    </Toggle>
  );
}
