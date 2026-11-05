/**
 * Public station state. In production this comes from GET /api/station and the
 * /events SSE stream (public fields only). Here it is simulated so every page
 * state can be reviewed; `?state=` picks one (live | private | offline | idle | reconnecting).
 */
import type { NowPlayingItem } from "@station/ui";
import { useEffect, useRef, useState } from "react";

export type TimelineEntry = {
  playId: number;
  mediaStartMs: number;
  /** Wall-clock (server) time it plays in real time. */
  startedAt: number;
  item: NowPlayingItem | null;
};

export type PublicStation = {
  name: string;
  description: string;
  accent: string;
  logoUrl: string | null;
  access: "public" | "private";
  onAirSince: Date | null;
  listeners: number;
  nowPlaying: NowPlayingItem | null;
  /** Recent items with media positions (live backend only). */
  timeline?: TimelineEntry[];
  epoch?: number;
  /** serverTime − Date.now() at the last update. */
  clockOffsetMs?: number;
};

export type DraftState = "live" | "private" | "offline" | "idle" | "reconnecting";
export const draftStates: DraftState[] = ["live", "private", "offline", "idle", "reconnecting"];

function art(a: string, b: string, shape: number) {
  const shapes = [
    `<circle cx="200" cy="200" r="120" fill="${b}"/><circle cx="260" cy="150" r="46" fill="${a}" opacity=".55"/>`,
    Array.from({ length: 7 }, (_, i) => `<path d="M0 ${110 + i * 32} Q100 ${70 + i * 32} 200 ${110 + i * 32} T400 ${110 + i * 32}" stroke="${b}" stroke-width="10" fill="none" opacity="${1 - i * 0.11}"/>`).join(""),
    Array.from({ length: 16 }, (_, i) => `<rect x="${60 + (i % 4) * 75}" y="${60 + Math.floor(i / 4) * 75}" width="55" height="55" rx="8" fill="${b}" opacity="${0.25 + ((i * 7) % 10) / 13}"/>`).join(""),
    `<path d="M40 320a160 160 0 0 1 320 0" stroke="${b}" stroke-width="56" fill="none"/><circle cx="200" cy="320" r="34" fill="${b}"/>`,
  ];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="${a}"/>${shapes[shape % shapes.length]}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const rotation: Omit<NowPlayingItem, "id">[] = [
  { kind: "music", title: "Paper Lanterns", artists: ["Mira Holt"], album: "Low Tide Hours", artworkUrl: art("#e9e4da", "#d0572f", 0) },
  { kind: "music", title: "Signal Through Fog", artists: ["The Quiet Engines", "Ada Ren"], album: "Northbound", artworkUrl: art("#dfe6e4", "#2f6f68", 1) },
  { kind: "jingle", title: null, artists: null, album: null, artworkUrl: null },
  { kind: "music", title: "Interiors II", artists: ["Orchestra of Small Rooms"], album: "Interiors, Vol. 2", artworkUrl: art("#ecebf3", "#4b4ac7", 2) },
  { kind: "music", title: "Morning Index", artists: ["Kiko Bals"], album: "Field Recordings", artworkUrl: art("#f2ece2", "#1d1d1d", 3) },
];

const base = {
  name: "Sample Station",
  description: "An always-on mix of independent music.",
  accent: "#2b59ff",
  logoUrl: null,
};

/** `?state=` forces the simulated draft; otherwise the real backend is used when reachable. */
export function readDraftState(): DraftState | null {
  const s = new URLSearchParams(location.search).get("state");
  return draftStates.includes(s as DraftState) ? (s as DraftState) : null;
}

type ApiItem = {
  playId: number;
  kind: "music" | "jingle";
  title: string | null;
  artists: string[];
  album: string | null;
  artworkUrl: string | null;
  licence: string | null;
  attributionUrl: string | null;
};

type ApiStation = {
  name: string;
  description: string;
  accent: string;
  logoUrl: string | null;
  access: "public" | "private";
  locked: boolean;
  onAirSince: number | null;
  listeners: number | null;
  nowPlaying: ApiItem | null;
  timeline: { playId: number; mediaStartMs: number; startedAt: number; item: ApiItem | null }[];
  epoch: number;
  serverTime: number;
};

const toItem = (i: ApiItem): NowPlayingItem => ({
  id: String(i.playId),
  kind: i.kind,
  title: i.title,
  artists: i.artists,
  album: i.album,
  artworkUrl: i.artworkUrl,
  credit: i.licence ? { licence: i.licence, url: i.attributionUrl } : null,
});

function fromApi(a: ApiStation): PublicStation & { locked: boolean } {
  return {
    name: a.name,
    description: a.description,
    accent: a.accent,
    logoUrl: a.logoUrl,
    access: a.access,
    locked: a.locked,
    onAirSince: a.onAirSince ? new Date(a.onAirSince) : null,
    listeners: a.listeners ?? 0,
    nowPlaying: a.nowPlaying ? toItem(a.nowPlaying) : null,
    timeline: a.timeline.map((e) => ({
      playId: e.playId,
      mediaStartMs: e.mediaStartMs,
      startedAt: e.startedAt,
      item: e.item ? toItem(e.item) : null,
    })),
    epoch: a.epoch,
    clockOffsetMs: a.serverTime - Date.now(),
  };
}

export type BackendStatus = "checking" | "connected" | "unavailable";

/** Real station state: GET /api/station, then live updates from /events (SSE). */
export function useBackendStation(code: string | null, enabled: boolean) {
  const [station, setStation] = useState<(PublicStation & { locked: boolean }) | null>(null);
  const [status, setStatus] = useState<BackendStatus>(enabled ? "checking" : "unavailable");

  useEffect(() => {
    if (!enabled) return;
    const q = code ? `?code=${encodeURIComponent(code)}` : "";
    let cancelled = false;
    fetch(`/api/station${q}`)
      .then((r) => (r.ok ? (r.json() as Promise<ApiStation>) : Promise.reject(new Error(String(r.status)))))
      .then((a) => {
        if (cancelled) return;
        setStation(fromApi(a));
        setStatus("connected");
      })
      .catch(() => !cancelled && setStatus((s) => (s === "connected" ? s : "unavailable")));
    const events = new EventSource(`/events${q}`);
    events.addEventListener("station", (e) => {
      setStation(fromApi(JSON.parse((e as MessageEvent<string>).data) as ApiStation));
      setStatus("connected");
    });
    return () => {
      cancelled = true;
      events.close();
    };
  }, [code, enabled]);

  return { station, status };
}

/** Simulated SSE: track changes every ~30 s and small listener fluctuations. */
export function usePublicStation(draft: DraftState | null): PublicStation {
  const since = useRef(new Date(Date.now() - 1000 * 60 * 137));
  const [index, setIndex] = useState(0);
  const [listeners, setListeners] = useState(42);

  useEffect(() => {
    if (!draft || draft === "offline" || draft === "idle") return;
    const track = setInterval(() => setIndex((i) => i + 1), 30_000);
    const count = setInterval(() => setListeners((n) => Math.max(1, n + Math.round((Math.random() - 0.45) * 4))), 4_000);
    return () => {
      clearInterval(track);
      clearInterval(count);
    };
  }, [draft]);

  const item = rotation[index % rotation.length]!;
  return {
    ...base,
    access: draft === "private" ? "private" : "public",
    onAirSince: draft === "offline" ? null : since.current,
    listeners: draft === "offline" ? 0 : listeners,
    nowPlaying: draft === "offline" || draft === "idle" ? null : { id: String(index), ...item },
  };
}

/** Demo code; the real check happens server-side and also guards /stream. */
export const DEMO_ACCESS_CODE = "LANTERN-4821";

/**
 * Which item is audible: from this player's exact media position when known,
 * otherwise what plays in real time on the server's clock.
 */
export function audibleItem(
  station: PublicStation,
  sync: { positionMs: () => number | null; epoch: number } | null,
): NowPlayingItem | null {
  const timeline = station.timeline;
  if (!timeline?.length) return station.nowPlaying;
  const pos = sync && sync.epoch === station.epoch ? sync.positionMs() : null;
  const pick =
    pos !== null
      ? [...timeline].reverse().find((e) => e.mediaStartMs <= pos)
      : [...timeline].reverse().find((e) => e.startedAt <= Date.now() + (station.clockOffsetMs ?? 0));
  return (pick ?? timeline[0]!).item;
}

/** Media position playing in real time on the server right now (estimated from the timeline). */
export function realtimePositionMs(station: PublicStation): number | null {
  const now = Date.now() + (station.clockOffsetMs ?? 0);
  const e = station.timeline && [...station.timeline].reverse().find((t) => t.startedAt <= now);
  return e ? e.mediaStartMs + (now - e.startedAt) : null;
}
