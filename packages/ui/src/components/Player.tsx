import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { transition } from "../tokens";
import { EqPanel, type EqSettings } from "./EqPanel";
import { ListenButton, type ListenStatus } from "./ListenButton";
import { ListenerCount } from "./ListenerCount";
import { NowPlaying, type NowPlayingItem } from "./NowPlaying";
import { OnAirSince } from "./OnAirSince";
import { Surface } from "./Surface";
import { TooltipProvider } from "./Tooltip";
import { Visualizer, type LevelSource } from "./Visualizer";
import { VolumeControl } from "./VolumeControl";

export type PlayerProps = {
  stationName?: string;
  onAirSince: Date | null;
  listeners: number;
  item: NowPlayingItem | null;
  status: ListenStatus;
  onListenChange: (listen: boolean) => void;
  volume: number;
  muted: boolean;
  onVolumeChange: (volume: number) => void;
  onMutedChange: (muted: boolean) => void;
  eq: EqSettings;
  onEqChange: (eq: EqSettings) => void;
  levels?: LevelSource | null;
  locale?: string;
  /** Disables tune-in, e.g. while the station is off air. */
  listenDisabled?: boolean;
  /** Short status line shown above the controls (connection problems, off air…). */
  notice?: ReactNode;
  /** Copy for the empty now-playing state (idle or off air). */
  empty?: { title: string; text: string };
};

/** The public listener player, laid out per the agreed wireframe. */
export function Player(props: PlayerProps) {
  return (
    <TooltipProvider delay={400}>
      <Surface elevation="raised" className="r-player" role="region" aria-label={props.stationName ?? "Radio player"}>
        <div className="r-player__top">
          <OnAirSince since={props.onAirSince} locale={props.locale} />
          <ListenerCount count={props.listeners} locale={props.locale} />
        </div>

        <NowPlaying item={props.item} stationName={props.stationName} empty={props.empty} />

        <AnimatePresence initial={false}>
          {props.notice && (
            <motion.div
              className="r-player__notice"
              role="status"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={transition.panel}
            >
              <div className="r-player__notice-inner">{props.notice}</div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="r-player__bottom">
          <div className="r-player__controls">
            <ListenButton status={props.status} onListenChange={props.onListenChange} disabled={props.listenDisabled} />
            <VolumeControl
              volume={props.volume}
              muted={props.muted}
              onVolumeChange={props.onVolumeChange}
              onMutedChange={props.onMutedChange}
            />
            <EqPanel value={props.eq} onValueChange={props.onEqChange} />
          </div>
          <div className="r-player__viz">
            <Visualizer active={props.status === "live"} source={props.levels} />
          </div>
        </div>
      </Surface>
    </TooltipProvider>
  );
}
