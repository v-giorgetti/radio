import { MotionConfig } from "motion/react";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cx } from "../cx";
import { transition } from "../tokens";

type ThemeContextValue = {
  /** Element popups portal into, so they inherit theme variables. */
  portalContainer: HTMLElement | null;
  reducedMotion: "user" | "always";
};

const ThemeContext = createContext<ThemeContextValue>({ portalContainer: null, reducedMotion: "user" });

export const useStationTheme = () => useContext(ThemeContext);

export type StationThemeProps = {
  /** Station accent colour; the only saturated colour in the system. */
  accent?: string;
  /** "user" follows prefers-reduced-motion; "always" forces it (useful for review). */
  reducedMotion?: "user" | "always";
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
};

/** Pick black or white text for legibility on the accent colour. */
export function readableOn(hex: string): string {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => {
    const c = parseInt(h!, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.45 ? "#141414" : "#ffffff";
}

export function StationTheme({
  accent,
  reducedMotion = "user",
  className,
  style,
  children,
}: StationThemeProps) {
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ portalContainer, reducedMotion }), [portalContainer, reducedMotion]);

  const themeStyle = {
    ...(accent ? { "--r-accent": accent, "--r-on-accent": readableOn(accent) } : null),
    ...style,
  } as CSSProperties;

  return (
    <MotionConfig reducedMotion={reducedMotion} transition={transition.content}>
      <ThemeContext.Provider value={value}>
        <div
          className={cx("r-theme", className)}
          style={themeStyle}
          data-reduced-motion={reducedMotion === "always" ? "" : undefined}
        >
          {children}
          <div ref={setPortalContainer} />
        </div>
      </ThemeContext.Provider>
    </MotionConfig>
  );
}
