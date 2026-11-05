/**
 * Listener audio engine.
 *
 *   source ─► bass (lowshelf) ─► mid (peaking) ─► treble (highshelf) ─► headroom ─┬─► analyser
 *                                                                                └─► volume ─► speakers
 *
 * - The source is the station stream (HTMLAudioElement) or, without a stream URL, a demo signal.
 * - EQ is local to this browser; headroom gain offsets positive boosts to avoid clipping.
 * - The analyser taps before volume, so the visualizer reflects the music even when quiet.
 * - "Listen" always reconnects to the live edge instead of resuming stale buffered audio.
 * - Start-up burst is chosen from this listener's measured round-trip time and jitter,
 *   and grows after a stall. The server reports where this connection's audio starts in
 *   the media timeline, so the page knows exactly which item is audible (no fixed delays).
 */
import { EQ_RANGE_DB, levelsFromAnalyser, type EqSettings, type LevelSource, type ListenStatus } from "@station/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { createDemoSignal, type DemoSignal } from "./demoSignal";


type Graph = {
  ctx: AudioContext;
  input: GainNode;
  bass: BiquadFilterNode;
  mid: BiquadFilterNode;
  treble: BiquadFilterNode;
  headroom: GainNode;
  volume: GainNode;
  analyser: AnalyserNode;
};

function buildGraph(): Graph {
  const ctx = new AudioContext({ latencyHint: "playback" });
  const input = ctx.createGain();
  const bass = Object.assign(ctx.createBiquadFilter(), { type: "lowshelf" as BiquadFilterType });
  bass.frequency.value = 160;
  const mid = Object.assign(ctx.createBiquadFilter(), { type: "peaking" as BiquadFilterType });
  mid.frequency.value = 1000;
  mid.Q.value = 0.8;
  const treble = Object.assign(ctx.createBiquadFilter(), { type: "highshelf" as BiquadFilterType });
  treble.frequency.value = 4500;
  const headroom = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.75;
  const volume = ctx.createGain();
  input.connect(bass).connect(mid).connect(treble).connect(headroom);
  headroom.connect(analyser);
  headroom.connect(volume).connect(ctx.destination);
  return { ctx, input, bass, mid, treble, headroom, volume, analyser };
}

const clampDb = (v: number) => Math.max(-EQ_RANGE_DB, Math.min(EQ_RANGE_DB, v));

/** Measures round-trip time to the server (a few tiny requests). */
async function measureNetwork(samples = 4): Promise<{ rttMs: number; jitterMs: number }> {
  const rtts: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    try {
      await fetch(`/healthz?t=${Date.now()}-${i}`, { cache: "no-store" });
      rtts.push(performance.now() - t0);
    } catch {
      /* ignore a failed probe */
    }
  }
  if (!rtts.length) return { rttMs: 500, jitterMs: 500 }; // unreachable: be conservative
  rtts.sort((a, b) => a - b);
  return { rttMs: rtts[Math.floor(rtts.length / 2)]!, jitterMs: rtts[rtts.length - 1]! - rtts[0]! };
}

const STALLS_KEY = "station:stalls";

/**
 * Burst = time for the first bytes to arrive and keep arriving despite variation:
 * two round trips (request + TCP ramp-up) plus four times the observed jitter,
 * scaled up 1.5× for every stall this tab has seen. Bounded by what the server keeps.
 */
export function burstFor(rttMs: number, jitterMs: number, stalls: number) {
  const base = 2 * rttMs + 4 * jitterMs;
  return Math.round(Math.min(6000, Math.max(250, base * 1.5 ** stalls)));
}

export type StreamSync = {
  /** Media position (ms) currently audible from this player, or null if unknown. */
  positionMs: () => number | null;
  epoch: number;
};

export type StationAudio = {
  status: ListenStatus;
  /** True after playback failed and the engine is retrying. */
  reconnecting: boolean;
  error: string | null;
  levels: LevelSource | null;
  listen: (on: boolean) => void;
  /** Exact media-timeline sync for the live stream (null in demo mode or before it's known). */
  sync: StreamSync | null;
  /** How far this listener is behind the live edge, once known. */
  network: { rttMs: number; jitterMs: number; burstMs: number } | null;
};

export function useStationAudio({
  volume,
  muted,
  eq,
  accessCode,
  streamUrl,
}: {
  volume: number;
  muted: boolean;
  eq: EqSettings;
  accessCode?: string | null;
  /** null = generated demo signal. */
  streamUrl: string | null;
}): StationAudio {
  const graph = useRef<Graph | null>(null);
  const element = useRef<HTMLAudioElement | null>(null);
  const demo = useRef<DemoSignal | null>(null);
  const retry = useRef<{ timer?: ReturnType<typeof setTimeout>; attempt: number }>({ attempt: 0 });
  const [status, setStatus] = useState<ListenStatus>("stopped");
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<LevelSource | null>(null);
  const [sync, setSync] = useState<StreamSync | null>(null);
  const [network, setNetwork] = useState<StationAudio["network"]>(null);
  const connection = useRef<{ session: string; t0: number | null } | null>(null);

  // Smoothly apply volume and EQ.
  useEffect(() => {
    const g = graph.current;
    if (!g) return;
    const t = g.ctx.currentTime;
    g.volume.gain.setTargetAtTime(muted ? 0 : volume ** 2, t, 0.03);
  }, [volume, muted, status]);

  useEffect(() => {
    const g = graph.current;
    if (!g) return;
    const t = g.ctx.currentTime;
    const bass = clampDb(eq.bass);
    const mid = clampDb(eq.mid);
    const treble = clampDb(eq.treble);
    g.bass.gain.setTargetAtTime(bass, t, 0.03);
    g.mid.gain.setTargetAtTime(mid, t, 0.03);
    g.treble.gain.setTargetAtTime(treble, t, 0.03);
    const maxBoost = Math.max(0, bass, mid, treble);
    g.headroom.gain.setTargetAtTime(10 ** (-maxBoost / 20), t, 0.03);
  }, [eq, status]);

  const teardownSource = useCallback(() => {
    clearTimeout(retry.current.timer);
    demo.current?.stop();
    demo.current = null;
    const el = element.current;
    if (el) {
      el.pause();
      el.removeAttribute("src");
      el.load(); // aborts the network request so the stream stops downloading
    }
  }, []);

  const connectStream = useCallback(async () => {
    const g = graph.current!;
    if (!streamUrl) {
      demo.current = createDemoSignal(g.ctx);
      demo.current.output.connect(g.input);
      setTimeout(() => setStatus((s) => (s === "connecting" ? "live" : s)), 700);
      return;
    }
    let el = element.current;
    if (!el) {
      el = new Audio();
      el.crossOrigin = "anonymous";
      el.preload = "none";
      g.ctx.createMediaElementSource(el).connect(g.input);
      el.addEventListener("playing", () => {
        retry.current.attempt = 0;
        setReconnecting(false);
        setError(null);
        setStatus("live");
        const conn = connection.current;
        if (conn && conn.t0 === null) {
          // currentTime of the first audible frame (0 for MP3/AAC, a granule time for Ogg).
          conn.t0 = el!.currentTime;
          fetch(`/api/stream-sync?session=${conn.session}`)
            .then((r) => (r.ok ? (r.json() as Promise<{ epoch: number; startMediaMs: number }>) : null))
            .then((s) => {
              if (!s || connection.current !== conn) return;
              setSync({
                epoch: s.epoch,
                positionMs: () => (conn.t0 === null ? null : s.startMediaMs + (el!.currentTime - conn.t0) * 1000),
              });
            })
            .catch(() => {});
        }
      });
      el.addEventListener("waiting", () => {
        // Ran dry while playing: next connection asks for a bigger burst.
        if (connection.current?.t0 !== null && connection.current?.t0 !== undefined) {
          sessionStorage.setItem(STALLS_KEY, String(Number(sessionStorage.getItem(STALLS_KEY) ?? 0) + 1));
        }
      });
      const onFail = () => {
        if (!element.current?.src) return; // stopped on purpose
        setReconnecting(true);
        setStatus("connecting");
        const attempt = ++retry.current.attempt;
        clearTimeout(retry.current.timer);
        retry.current.timer = setTimeout(() => void connectStream(), Math.min(15000, 1000 * 2 ** (attempt - 1)));
      };
      el.addEventListener("error", onFail);
      el.addEventListener("ended", onFail);
      element.current = el;
    }
    const { rttMs, jitterMs } = await measureNetwork();
    const burstMs = burstFor(rttMs, jitterMs, Number(sessionStorage.getItem(STALLS_KEY) ?? 0));
    setNetwork({ rttMs, jitterMs, burstMs });
    const session = crypto.randomUUID();
    connection.current = { session, t0: null };
    setSync(null);
    // A fresh session id also busts caches: always join the live edge, never stale buffer.
    const url = new URL(streamUrl, location.href);
    url.searchParams.set("session", session);
    url.searchParams.set("burst", String(burstMs));
    if (accessCode) url.searchParams.set("code", accessCode);
    el.src = url.toString();
    el.play().catch((e: unknown) => {
      setError(e instanceof Error ? e.message : "Playback was blocked");
      setStatus("stopped");
    });
  }, [accessCode, streamUrl]);

  const listen = useCallback(
    (on: boolean) => {
      if (!on) {
        teardownSource();
        connection.current = null;
        setSync(null);
        setReconnecting(false);
        setStatus("stopped");
        graph.current?.ctx.suspend();
        return;
      }
      // Must run inside the click handler: browsers only allow audio after a user gesture.
      graph.current ??= buildGraph();
      const g = graph.current;
      setLevels(() => levelsFromAnalyser(g.analyser));
      setError(null);
      setStatus("connecting");
      g.volume.gain.value = muted ? 0 : volume ** 2;
      void g.ctx.resume();
      teardownSource();
      void connectStream();
    },
    [connectStream, teardownSource, muted, volume],
  );

  useEffect(
    () => () => {
      teardownSource();
      void graph.current?.ctx.close();
    },
    [teardownSource],
  );

  return { status, reconnecting, error, levels: status === "live" ? levels : null, listen, sync, network };
}
