import { AnimatePresence, motion } from "motion/react";
import { transition } from "../tokens";
import { Artwork } from "./Artwork";
import { Marquee } from "./Marquee";

export type NowPlayingItem = {
  /** Changes whenever a new item starts, even if metadata repeats. */
  id: string;
  kind: "music" | "jingle";
  title?: string | null;
  artists?: string[] | null;
  album?: string | null;
  artworkUrl?: string | null;
  /** Licence credit for openly licensed tracks, e.g. "CC BY 4.0" + source page. */
  credit?: { licence: string; url?: string | null } | null;
};

export type NowPlayingProps = {
  item: NowPlayingItem | null;
  stationName?: string;
  /** Shown when item is null. */
  empty?: { title: string; text: string };
};

const fallbackTitle = (item: NowPlayingItem, stationName?: string) =>
  item.title?.trim() || (item.kind === "jingle" ? `You're listening to ${stationName ?? "the station"}` : "Untitled track");

const fallbackArtist = (item: NowPlayingItem, stationName?: string) =>
  item.artists?.filter(Boolean).join(", ") || (item.kind === "jingle" ? "Station jingle" : (stationName ?? "Unknown artist"));

export function NowPlaying({
  item,
  stationName,
  empty = { title: "Nothing playing", text: "The station is idle." },
}: NowPlayingProps) {
  return (
    <div className="r-nowplaying">
      <Artwork src={item?.artworkUrl} />
      <div className="r-nowplaying__meta" aria-live="polite" aria-atomic>
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            key={item?.id ?? `empty-${empty.title}`}
            className="r-nowplaying__text"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={transition.content}
          >
            {item ? (
              <>
                <h2 className="r-nowplaying__title">
                  <Marquee>{fallbackTitle(item, stationName)}</Marquee>
                </h2>
                {/* Jingles show the station's message (set by the station) without an artist line. */}
                {(item.kind === "music" || item.artists?.length) && (
                  <span className="r-nowplaying__artist">
                    <Marquee>{fallbackArtist(item, stationName)}</Marquee>
                  </span>
                )}
                {item.album && (
                  <span className="r-nowplaying__album">
                    <Marquee>{item.album}</Marquee>
                  </span>
                )}
                {item.credit && (
                  <span className="r-nowplaying__credit">
                    {item.credit.url ? (
                      <a href={item.credit.url} target="_blank" rel="noreferrer">
                        {item.credit.licence} · Source
                      </a>
                    ) : (
                      item.credit.licence
                    )}
                  </span>
                )}
              </>
            ) : (
              <>
                <h2 className="r-nowplaying__title">{empty.title}</h2>
                <span className="r-nowplaying__album">{empty.text}</span>
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
