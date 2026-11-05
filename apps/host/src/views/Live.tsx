import {
  AnimatedNumber,
  Artwork,
  Badge,
  BroadcastIcon,
  Button,
  DragHandleIcon,
  JingleIcon,
  ProgressBar,
  RepeatIcon,
  SkipIcon,
  Surface,
  Tooltip,
  TrashIcon,
  transition,
} from "@station/ui";
import { AnimatePresence, motion, Reorder, useDragControls } from "motion/react";
import { formatDuration, type Track } from "../data";
import { isDue, type StationSim } from "../sim";
import { ProcessingCapacity } from "./ProcessingCapacity";

export function LiveView({ sim }: { sim: StationSim }) {
  const { state, dispatch, current, prediction, trackById, fallback } = sim;
  const remaining = current ? Math.max(0, current.durationSec - state.elapsed) : 0;

  return (
    <div className="host-page">
      <header className="host-page__header">
        <div>
          <h1 className="host-h1">Live</h1>
          <p className="host-sub">What's on air, what's next, and when jingles will play.</p>
        </div>
        <div className="host-actions">
          <Button
            variant={state.broadcasting ? "outline" : "accent"}
            onClick={() => dispatch({ type: "toggleBroadcast" })}
          >
            <BroadcastIcon />
            {state.broadcasting ? "Stop broadcast" : "Start broadcast"}
          </Button>
        </div>
      </header>

      <div className="host-live">
        <div className="host-col">
          <Surface className="host-card host-onair" data-elevation="raised">
            <div className="host-card__head">
              <span className="r-label">{!state.broadcasting ? "Station stopped" : current ? "On air now" : "Idle"}</span>
              <Tooltip content="Skip to the next item now">
                <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "finishTrack" })} disabled={!state.broadcasting || !current}>
                  <SkipIcon />
                  Skip
                </Button>
              </Tooltip>
            </div>
            {current ? (
            <div className="host-onair__body">
                <Artwork src={current.artworkUrl} className="host-onair__art" />
                <div className="host-onair__meta">
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.div
                      key={state.playCount}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={transition.content}
                      className="host-onair__text"
                    >
                      {current.kind === "jingle" && <Badge tone="accent">Jingle</Badge>}
                      <h2 className="host-onair__title" title={current.title}>
                        {current.title}
                      </h2>
                      <div className="host-onair__artist" title={current.artists.join(", ")}>
                        {current.artists.join(", ") || (current.kind === "jingle" ? "Station jingle" : "Unknown artist")}
                      </div>
                      {current.album && <div className="host-onair__album" title={current.album}>{current.album}</div>}
                    </motion.div>
                  </AnimatePresence>
                  <div className="host-onair__progress">
                    <ProgressBar
                      aria-label="Track progress"
                      tone="neutral"
                      value={Math.min(100, (state.elapsed / current.durationSec) * 100)}
                    />
                    <div className="host-onair__times r-label r-tnum">
                      <span>{formatDuration(state.elapsed)}</span>
                      <span>−{formatDuration(remaining)}</span>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="host-idle">
                <strong>Station idle</strong>
                <span className="r-label">
                  The queue is empty and no fallback playlist is set. Queue tracks or choose a fallback in Playlists.
                </span>
              </div>
            )}
            <AfterNotice jingles={[...prediction.dueNow, ...(prediction.after.current ?? [])]} />
          </Surface>

          <Surface className="host-card">
            <div className="host-card__head">
              <h2 className="host-h2">Up next</h2>
              <span className="r-label">{state.queue.length} queued · drag to reorder</span>
            </div>
            {state.queue.length === 0 ? (
              <EmptyQueue jingles={state.tracks.filter((t) => t.kind === "jingle").length} />
            ) : (
              <Reorder.Group
                axis="y"
                values={state.queue}
                onReorder={(queue) => dispatch({ type: "reorder", queue })}
                className="host-queue"
              >
                <AnimatePresence initial={false}>
                  {state.queue.map((id, i) => (
                    <QueueRow
                      key={id}
                      track={trackById(id)}
                      position={i + 1}
                      jinglesAfter={prediction.after[id] ?? []}
                      onRemove={() => dispatch({ type: "removeFromQueue", id })}
                    />
                  ))}
                </AnimatePresence>
              </Reorder.Group>
            )}
            <div className="host-queue__fallback r-label">
              <RepeatIcon />
              {fallback ? (
                <span>
                  When the queue runs out, the station continues with <strong>{fallback.name}</strong>
                  {fallback.shuffle ? " (shuffled)" : ""}.
                </span>
              ) : (
                <span>No fallback playlist — the station goes idle when the queue runs out.</span>
              )}
            </div>
          </Surface>
        </div>

        <div className="host-col host-col--side">
          <ProcessingCapacity state={state} />
          <Surface className="host-card host-stat">
            <span className="r-label">Listening now</span>
            <span className="r-display host-stat__value">
              <AnimatedNumber value={state.listeners} />
            </span>
            <span className="r-label">Active audio connections · tabs count separately</span>
          </Surface>

          <Surface className="host-card">
            <div className="host-card__head">
              <h2 className="host-h2">Jingle schedule</h2>
            </div>
            <ul className="host-rules">
              {state.rules.map((r) => {
                const jingle = trackById(r.jingleId);
                const playing = state.currentId === r.jingleId;
                const due = !playing && (isDue(r) || state.pendingJingles.includes(r.jingleId));
                const songPct = (r.songsSince / r.everySongs) * 100;
                const minPct = (r.minutesSince / r.everyMinutes) * 100;
                const pct = r.unit === "songs" ? songPct : r.unit === "minutes" ? minPct : Math.max(songPct, minPct);
                return (
                  <li key={r.jingleId} className="host-rule" data-disabled={r.enabled ? undefined : ""}>
                    <div className="host-rule__row">
                      <span className="host-rule__name">{jingle.title}</span>
                      {playing ? (
                        <Badge tone="success">On air</Badge>
                      ) : !r.enabled ? (
                        <Badge>Off</Badge>
                      ) : due ? (
                        <Badge tone="accent">After this track</Badge>
                      ) : null}
                    </div>
                    <ProgressBar aria-label={`${jingle.title} progress to next play`} value={r.enabled && !playing ? Math.min(100, pct) : 0} />
                    <span className="r-label r-tnum">
                      {r.unit !== "minutes" && `${Math.min(r.songsSince, r.everySongs)} / ${r.everySongs} songs`}
                      {r.unit === "both" && " · "}
                      {r.unit !== "songs" && `${Math.floor(Math.min(r.minutesSince, r.everyMinutes))} / ${r.everyMinutes} min`}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="host-hint">Jingles that are due wait for the current track to finish, then play once each in schedule order.</p>
          </Surface>
        </div>
      </div>
    </div>
  );
}

function AfterNotice({ jingles }: { jingles: Track[] }) {
  return (
    <AnimatePresence initial={false}>
      {jingles.length > 0 && (
        <motion.div
          className="host-after"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={transition.panel}
        >
          <JingleIcon />
          <span>
            After this track: <strong>{jingles.map((j) => j.title).join(", then ")}</strong>
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function QueueRow({
  track,
  position,
  jinglesAfter,
  onRemove,
}: {
  track: Track;
  position: number;
  jinglesAfter: Track[];
  onRemove: () => void;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={track.id}
      dragListener={false}
      dragControls={controls}
      className="host-queue__item"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -12, transition: { duration: 0.2 } }}
      whileDrag={{ scale: 1.015, boxShadow: "0 14px 30px rgb(20 20 20 / 0.12)" }}
      transition={transition.panel}
    >
      <div className="host-queue__row">
        <button
          className="host-queue__handle"
          aria-label={`Reorder ${track.title}`}
          onPointerDown={(e) => controls.start(e)}
        >
          <DragHandleIcon />
        </button>
        <span className="host-queue__pos r-label r-tnum">{position}</span>
        <Artwork src={track.artworkUrl} className="host-queue__art" />
        <div className="host-queue__meta">
          <span className="host-queue__title" title={track.title}>
            {track.title}
          </span>
          <span className="host-queue__artist">{track.artists.join(", ") || "Unknown artist"}</span>
        </div>
        <span className="r-label r-tnum">{formatDuration(track.durationSec)}</span>
        <Tooltip content="Remove from queue">
          <Button size="sm" variant="ghost" iconOnly aria-label={`Remove ${track.title} from queue`} onClick={onRemove}>
            <TrashIcon />
          </Button>
        </Tooltip>
      </div>
      {jinglesAfter.length > 0 && (
        <div className="host-queue__jingle r-label">
          <JingleIcon />
          <span title={jinglesAfter.map((j) => j.title).join(", ")}>then {jinglesAfter.map((j) => j.title).join(", ")}</span>
        </div>
      )}
    </Reorder.Item>
  );
}

function EmptyQueue({ jingles }: { jingles: number }) {
  return (
    <div className="host-empty">
      <p>The queue is empty.</p>
      <span className="r-label">Add tracks from the Library, or set a fallback playlist. {jingles} jingles in the library.</span>
    </div>
  );
}
