import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { cx } from "../cx";
import { useStationTheme } from "./StationTheme";

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(reducedMotionQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const prefersReducedMotion = () => window.matchMedia(reducedMotionQuery).matches;

export type MarqueeProps = {
  children: ReactNode;
  className?: string;
  /** Scroll speed in px per second (each direction). */
  speed?: number;
  /** Seconds to rest at each end before moving again. */
  pause?: number;
};

/**
 * Single-line text that, only when it doesn't fit, slides back and forth to reveal
 * the whole string, resting at each end. Falls back to an ellipsis with reduced motion.
 */
export function Marquee({ children, className, speed = 32, pause = 1.6 }: MarqueeProps) {
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const animation = useRef<Animation | null>(null);
  const [overflow, setOverflow] = useState(0);
  const deviceReduced = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => true);
  const reduced = useStationTheme().reducedMotion === "always" || deviceReduced;
  const title = typeof children === "string" ? children : undefined;

  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i || reduced) return;
    const measure = () => {
      const d = Math.ceil(i.scrollWidth - o.clientWidth);
      setOverflow(d > 2 ? d : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(o);
    ro.observe(i); // fonts loading or text changing resize the inner span
    return () => ro.disconnect();
  }, [reduced, children]);

  // Rest → slide to the end → rest → slide back, with exact speed and pause.
  useLayoutEffect(() => {
    const i = inner.current;
    if (!i || reduced || !overflow) return;
    const travel = (overflow / Math.max(1, speed)) * 1000;
    const rest = Math.max(0, pause) * 1000;
    const total = 2 * travel + 2 * rest;
    const at = (ms: number) => ms / total;
    const anim = i.animate(
      [
        { transform: "translateX(0)", offset: 0 },
        { transform: "translateX(0)", offset: at(rest), easing: "ease-in-out" },
        { transform: `translateX(${-overflow}px)`, offset: at(rest + travel) },
        { transform: `translateX(${-overflow}px)`, offset: at(2 * rest + travel), easing: "ease-in-out" },
        { transform: "translateX(0)", offset: 1 },
      ],
      { duration: total, iterations: Infinity },
    );
    animation.current = anim;
    if (outer.current?.matches(":hover, :focus-within")) anim.pause();
    return () => {
      anim.cancel();
      animation.current = null;
    };
  }, [overflow, speed, pause, reduced]);

  if (reduced) {
    return <span className={cx("r-marquee", "r-marquee--static", className)} title={title}>{children}</span>;
  }

  const resume = () => {
    if (!outer.current?.matches(":hover, :focus-within")) animation.current?.play();
  };

  return (
    <span
      ref={outer}
      className={cx("r-marquee", className)}
      data-overflowing={overflow ? "" : undefined}
      title={title}
      tabIndex={overflow ? 0 : undefined}
      onMouseEnter={() => animation.current?.pause()}
      onMouseLeave={resume}
      onFocus={() => animation.current?.pause()}
      onBlur={resume}
    >
      <span ref={inner} className="r-marquee__inner">
        {children}
      </span>
    </span>
  );
}
