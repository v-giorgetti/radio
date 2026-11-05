import { AnimatePresence, motion } from "motion/react";
import { useRef } from "react";
import { cx } from "../cx";
import { transition } from "../tokens";

export type AnimatedNumberProps = {
  value: number;
  locale?: string;
  className?: string;
};

/** Rolls changed digits up (increase) or down (decrease). */
export function AnimatedNumber({ value, locale, className }: AnimatedNumberProps) {
  const previous = useRef(value);
  const direction = value >= previous.current ? 1 : -1;
  previous.current = value;

  const text = new Intl.NumberFormat(locale).format(value);
  const chars = text.split("");

  return (
    <span className={cx("r-number", className)} aria-label={text} role="text">
      {chars.map((char, i) => {
        // Key by position from the right so units stay stable when digits are added.
        const slot = chars.length - i;
        return (
          <span key={slot} aria-hidden style={{ display: "inline-grid" }}>
            <AnimatePresence initial={false} mode="popLayout" custom={direction}>
              <motion.span
                key={char}
                className="r-number__digit"
                style={{ gridArea: "1 / 1" }}
                custom={direction}
                variants={{
                  enter: (d: number) => ({ y: `${d * 90}%`, opacity: 0 }),
                  center: { y: "0%", opacity: 1 },
                  exit: (d: number) => ({ y: `${d * -90}%`, opacity: 0 }),
                }}
                initial="enter"
                animate="center"
                exit="exit"
                transition={transition.panel}
              >
                {char}
              </motion.span>
            </AnimatePresence>
          </span>
        );
      })}
    </span>
  );
}
