/**
 * View-facing station model. The data comes from the live store (store.ts);
 * this module adds pure display helpers: jingle due-ness and placement prediction.
 * Mirrors server/src/scheduler.rs.
 */
import type { JingleRule, Track } from "./data";
import type { Action, State, Station } from "./store";

export type ViewState = State & { elapsed: number };

export type Prediction = { dueNow: Track[]; after: Record<string, Track[]> };

export type StationSim = {
  state: ViewState;
  dispatch: (a: Action) => Promise<unknown>;
  current: Track | null;
  prediction: Prediction;
  trackById: (id: string) => Track;
  fallback: Station["fallback"];
  error: string | null;
};

export function isDue(r: JingleRule, songs = r.songsSince, minutes = r.minutesSince) {
  if (!r.enabled) return false;
  const bySongs = songs >= r.everySongs;
  const byMinutes = minutes >= r.everyMinutes;
  return r.unit === "songs" ? bySongs : r.unit === "minutes" ? byMinutes : bySongs || byMinutes;
}

/** Which jingles will play after which item (display only). */
export function predict(s: ViewState, byId: (id: string) => Track | undefined): Prediction {
  const dueNow = s.pendingJingles.map(byId).filter((t): t is Track => !!t);
  const after: Record<string, Track[]> = {};
  const current = s.currentId ? byId(s.currentId) : undefined;
  if (!current) return { dueNow, after };
  // A jingle on air resets its own counters when it finishes.
  const rules = s.rules.map((r) => (r.jingleId === current.id ? { ...r, songsSince: 0, minutesSince: 0 } : { ...r }));
  let minutesAhead = Math.max(0, current.durationSec - s.elapsed) / 60;
  const queued = new Set(s.pendingJingles);
  const step = (key: string, completedMusic: boolean) => {
    for (const r of rules) {
      if (completedMusic) r.songsSince += 1;
      const jingle = byId(r.jingleId);
      if (jingle && !queued.has(r.jingleId) && isDue(r, r.songsSince, r.minutesSince + minutesAhead)) {
        (after[key] ??= []).push(jingle);
        r.songsSince = 0;
        r.minutesSince = -minutesAhead;
      }
    }
  };
  step("current", current.kind === "music");
  for (const id of s.queue) {
    const t = byId(id);
    if (!t) continue;
    minutesAhead += t.durationSec / 60;
    step(id, true);
  }
  return { dueNow, after };
}
