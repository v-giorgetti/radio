import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { cx } from "../cx";
import { DiscIcon } from "../icons";
import { transition } from "../tokens";

export type ArtworkProps = {
  src?: string | null;
  /** Describes the image; empty when the title next to it already says it all. */
  alt?: string;
  className?: string;
};

/** Square artwork that crossfades between images and falls back to a neutral disc. */
export function Artwork({ src, alt = "", className }: ArtworkProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const show = src && failed !== src ? src : null;

  return (
    <div className={cx("r-artwork", className)}>
      <AnimatePresence initial={false}>
        {show ? (
          <motion.img
            key={show}
            src={show}
            alt={alt}
            onError={() => setFailed(show)}
            initial={{ opacity: 0, scale: 1.04 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={transition.content}
          />
        ) : (
          <motion.div
            key="fallback"
            className="r-artwork__fallback"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transition.content}
          >
            <DiscIcon />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
