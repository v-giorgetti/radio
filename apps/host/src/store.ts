/**
 * Live station store for the host dashboard.
 *
 * - Loads GET /api/host/state, then follows GET /api/host/events (SSE snapshots).
 * - Mutations update the view immediately (optimistic), call the API, then
 *   re-fetch the authoritative state. Snapshots arriving mid-mutation are ignored.
 * - Rapid edits (drag-to-reorder, steppers) are coalesced per resource.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { JingleRule, Playlist, ProcessingStatus, StationSettings, StreamFormat, Track } from "./data";

// ---------- server shapes ----------

type ServerTrack = {
  id: string;
  kind: "music" | "jingle";
  title: string | null;
  artists: string[];
  album: string | null;
  durationMs: number;
  source: string;
  licence: string | null;
  attributionUrl: string | null;
  loudnessLufs: number | null;
  artworkUrl: string | null;
};
type ServerRule = {
  jingleId: string;
  enabled: boolean;
  unit: JingleRule["unit"];
  everySongs: number;
  everyMinutes: number;
  songsSince: number;
  minutesSince: number;
};
type ServerSettings = {
  name: string;
  description: string;
  accent: string;
  logo: string | null;
  access: "public" | "private";
  accessCode: string;
  streamFormat: StreamFormat;
  bitrate: number;
  normalizeLoudness: boolean;
  crossfadeMs: number;
  jingleMessage: string;
  testLibraryEnabled: boolean;
  internetArchiveEnabled: boolean;
  jamendoEnabled: boolean;
  jamendoConnected: boolean;
};
export type ServerJob = {
  id: string;
  source: string;
  label: string;
  total: number;
  done: number;
  imported: number;
  rejected: { name: string; reason: string }[];
  finished: boolean;
};
/** Light event: everything that changes often. */
type LiveSnapshot = {
  serverTime: number;
  libraryRev: number;
  live: Partial<ProcessingStatus> & {
    onAir: boolean;
    onAirSince: number | null;
    current: { playId: number; trackId: string; startedAt: number } | null;
    listeners: number;
  };
  queue: string[];
  pendingJingles: string[];
  rules: ServerRule[];
  fallbackPlaylistId: string | null;
  jobs: ServerJob[];
};
/** Full state: live plus library, playlists and settings. */
type Snapshot = LiveSnapshot & {
  tracks: ServerTrack[];
  playlists: Playlist[];
  settings: ServerSettings;
};

// ---------- view state ----------

export type State = ProcessingStatus & {
  tracks: Track[];
  broadcasting: boolean;
  onAirSince: Date | null;
  currentId: string | null;
  /** Server time (ms) when the current item became audible. */
  currentStartedAt: number | null;
  playCount: number;
  queue: string[];
  pendingJingles: string[];
  rules: JingleRule[];
  playlists: Playlist[];
  fallbackPlaylistId: string | null;
  settings: StationSettings;
  listeners: number;
  jobs: ServerJob[];
};

function fromSnapshot(s: Snapshot): State {
  const st = s.settings;
  return {
    tracks: s.tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title ?? "Untitled",
      artists: t.artists,
      album: t.album ?? undefined,
      durationSec: t.durationMs / 1000,
      artworkUrl: t.artworkUrl ?? undefined,
      source: t.source,
      licence: t.licence && t.licence !== "Generated" ? t.licence : undefined,
      attributionUrl: t.attributionUrl ?? undefined,
      loudnessLufs: t.loudnessLufs ?? undefined,
    })),
    broadcasting: s.live.onAir,
    onAirSince: s.live.onAirSince ? new Date(s.live.onAirSince) : null,
    currentId: s.live.current?.trackId ?? null,
    currentStartedAt: s.live.current?.startedAt ?? null,
    playCount: s.live.current?.playId ?? 0,
    queue: s.queue,
    pendingJingles: s.pendingJingles,
    rules: s.rules,
    playlists: s.playlists,
    fallbackPlaylistId: s.fallbackPlaylistId,
    settings: {
      name: st.name,
      description: st.description,
      accent: st.accent,
      logoUrl: st.logo ? `/media/artwork/${st.logo}` : null,
      access: st.access,
      accessCode: st.accessCode,
      streamFormat: st.streamFormat,
      bitrate: st.bitrate,
      normalizeLoudness: st.normalizeLoudness,
      crossfadeMs: st.crossfadeMs,
      jingleMessage: st.jingleMessage,
      integrations: {
        testLibrary: st.testLibraryEnabled,
        internetArchive: st.internetArchiveEnabled,
        jamendo: st.jamendoEnabled,
        jamendoConnected: st.jamendoConnected,
      },
    },
    listeners: s.live.listeners,
    jobs: s.jobs,
    ...processingStatus(s.live),
  };
}

/** Applies a light event on top of the last full state. */
function mergeLive(prev: State, s: LiveSnapshot): State {
  return {
    ...prev,
    broadcasting: s.live.onAir,
    onAirSince: s.live.onAirSince ? new Date(s.live.onAirSince) : null,
    currentId: s.live.current?.trackId ?? null,
    currentStartedAt: s.live.current?.startedAt ?? null,
    playCount: s.live.current?.playId ?? 0,
    queue: s.queue,
    pendingJingles: s.pendingJingles,
    rules: s.rules,
    fallbackPlaylistId: s.fallbackPlaylistId,
    listeners: s.live.listeners,
    jobs: s.jobs,
    ...processingStatus(s.live),
  };
}

// Tolerate a previous server version during an update; never invent a measurement.
function processingStatus(live: Partial<ProcessingStatus>): ProcessingStatus {
  return {
    processingHeadroom: live.processingHeadroom ?? null,
    processingProbeRunning: live.processingProbeRunning ?? false,
    processingProbeError: live.processingProbeError ?? null,
    decoderLeadMs: live.decoderLeadMs ?? 0,
    decoderCalibration: live.decoderCalibration ?? { source: "unavailable", samples: 0 },
  };
}

type ServerSettingsBody = Omit<ServerSettings, "logo" | "jamendoConnected"> & { logo: null; jamendoClientId: string };

function toServerSettings(s: StationSettings): ServerSettingsBody {
  return {
    name: s.name,
    description: s.description,
    accent: s.accent,
    logo: null, // ignored by the server; logos have their own endpoint
    access: s.access,
    accessCode: s.accessCode,
    streamFormat: s.streamFormat,
    bitrate: s.bitrate,
    normalizeLoudness: s.normalizeLoudness,
    crossfadeMs: s.crossfadeMs,
    jingleMessage: s.jingleMessage,
    testLibraryEnabled: s.integrations.testLibrary,
    internetArchiveEnabled: s.integrations.internetArchive,
    jamendoEnabled: s.integrations.jamendo,
    jamendoClientId: "", // ignored by the server; set via /integrations/jamendo
  };
}

const toServerRules = (rules: JingleRule[]) =>
  rules.map(({ jingleId, enabled, unit, everySongs, everyMinutes }) => ({ jingleId, enabled, unit, everySongs, everyMinutes }));

// ---------- actions ----------

export type Action =
  | { type: "toggleBroadcast" }
  | { type: "finishTrack" }
  | { type: "reorder"; queue: string[] }
  | { type: "removeFromQueue"; id: string }
  | { type: "enqueue"; ids: string[] }
  | { type: "updateRule"; rule: JingleRule }
  | { type: "reorderRules"; rules: JingleRule[] }
  | { type: "createPlaylist"; name: string }
  | { type: "updatePlaylist"; playlist: Playlist }
  | { type: "deletePlaylist"; id: string }
  | { type: "setFallback"; id: string | null }
  | { type: "saveSettings"; settings: StationSettings }
  | { type: "deleteTrack"; id: string };

function optimistic(s: State, a: Action): State {
  switch (a.type) {
    case "reorder":
      return { ...s, queue: a.queue };
    case "removeFromQueue":
      return { ...s, queue: s.queue.filter((id) => id !== a.id) };
    case "enqueue":
      return { ...s, queue: [...s.queue, ...a.ids.filter((id) => !s.queue.includes(id))] };
    case "updateRule":
      return { ...s, rules: s.rules.map((r) => (r.jingleId === a.rule.jingleId ? a.rule : r)) };
    case "reorderRules":
      return { ...s, rules: a.rules };
    case "updatePlaylist":
      return { ...s, playlists: s.playlists.map((p) => (p.id === a.playlist.id ? a.playlist : p)) };
    case "deletePlaylist":
      return {
        ...s,
        playlists: s.playlists.filter((p) => p.id !== a.id),
        fallbackPlaylistId: s.fallbackPlaylistId === a.id ? null : s.fallbackPlaylistId,
      };
    case "setFallback":
      return { ...s, fallbackPlaylistId: a.id };
    case "toggleBroadcast":
      return { ...s, broadcasting: !s.broadcasting };
    case "deleteTrack":
      return { ...s, tracks: s.tracks.filter((t) => t.id !== a.id), queue: s.queue.filter((id) => id !== a.id) };
    default:
      return s;
  }
}

export type Connection = "loading" | "signed-out" | "connected" | "reconnecting";

export function useStation() {
  const [state, setState] = useState<State | null>(null);
  const [connection, setConnection] = useState<Connection>("loading");
  /** Bumped on sign-in; the live connection effect depends only on this. */
  const [epoch, setEpoch] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<State | null>(null);
  const inFlight = useRef(0);
  const clockOffset = useRef(0); // serverTime - Date.now()
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [, setTick] = useState(0);

  const libraryRev = useRef(-1);

  const apply = useCallback((snap: Snapshot) => {
    clockOffset.current = snap.serverTime - Date.now();
    libraryRev.current = snap.libraryRev;
    const next = fromSnapshot(snap);
    stateRef.current = next;
    setState(next);
  }, []);

  const refresh = useCallback(async () => {
    const snap = await api<Snapshot>("GET", "/state");
    if (inFlight.current === 0) apply(snap);
  }, [apply]);

  /** Light events update live fields; a new library revision triggers a full re-fetch. */
  const applyLive = useCallback(
    (snap: LiveSnapshot) => {
      clockOffset.current = snap.serverTime - Date.now();
      const prev = stateRef.current;
      if (prev) {
        const next = mergeLive(prev, snap);
        stateRef.current = next;
        setState(next);
      }
      if (snap.libraryRev !== libraryRev.current) void refresh().catch(() => {});
    },
    [refresh],
  );

  // Session check + live updates.
  useEffect(() => {
    let events: EventSource | null = null;
    let cancelled = false;
    const connect = async () => {
      try {
        const { signedIn } = await api<{ signedIn: boolean }>("GET", "/session");
        if (cancelled) return;
        if (!signedIn) {
          setConnection("signed-out");
          return;
        }
        await refresh();
        events = new EventSource("/api/host/events");
        events.addEventListener("live", (e) => {
          if (inFlight.current === 0) applyLive(JSON.parse((e as MessageEvent<string>).data) as LiveSnapshot);
          setConnection("connected");
        });
        events.onerror = () => setConnection((c) => (c === "signed-out" ? c : "reconnecting"));
        setConnection("connected");
      } catch {
        if (!cancelled) setConnection("reconnecting");
      }
    };
    const onUnauthorized = () => {
      events?.close();
      setConnection("signed-out");
    };
    window.addEventListener("station:unauthorized", onUnauthorized);
    void connect();
    return () => {
      cancelled = true;
      events?.close();
      window.removeEventListener("station:unauthorized", onUnauthorized);
    };
  }, [epoch, applyLive, refresh]);

  // Re-render a few times per second so elapsed time moves.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, []);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      inFlight.current += 1;
      try {
        const result = await fn();
        setError(null);
        return result;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        inFlight.current -= 1;
        if (inFlight.current === 0) void refresh().catch(() => {});
      }
    },
    [refresh],
  );

  /** Coalesces rapid calls for the same key; only the last one is sent. */
  const debounced = useCallback(
    (key: string, fn: () => Promise<unknown>, ms = 350) => {
      const pending = timers.current.get(key);
      if (pending === undefined) inFlight.current += 1; // hold snapshots once per pending key
      else clearTimeout(pending);
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          inFlight.current -= 1;
          void run(fn).catch(() => {});
        }, ms),
      );
    },
    [run],
  );

  const dispatch = useCallback(
    async (a: Action): Promise<unknown> => {
      const current = stateRef.current;
      if (!current) return;
      const next = optimistic(current, a);
      if (next !== current) {
        stateRef.current = next;
        setState(next);
      }
      switch (a.type) {
        case "toggleBroadcast":
          return run(() => api("POST", "/broadcast", { onAir: !current.broadcasting }));
        case "finishTrack":
          return run(() => api("POST", "/skip"));
        case "reorder":
        case "removeFromQueue":
          return debounced("queue", () => api("PUT", "/queue", { trackIds: stateRef.current!.queue }));
        case "enqueue":
          return run(() => api("POST", "/queue", { trackIds: a.ids }));
        case "updateRule":
        case "reorderRules":
          return debounced("rules", () => api("PUT", "/jingles", { rules: toServerRules(stateRef.current!.rules) }));
        case "createPlaylist":
          return run(() => api<Playlist>("POST", "/playlists", { name: a.name }));
        case "updatePlaylist": {
          const p = a.playlist;
          if (!p.name.trim()) return; // wait until the name is valid
          return debounced(`playlist:${p.id}`, () =>
            api("PUT", `/playlists/${p.id}`, { name: p.name, trackIds: p.trackIds, shuffle: p.shuffle }),
          );
        }
        case "deletePlaylist":
          return run(() => api("DELETE", `/playlists/${a.id}`));
        case "setFallback":
          return run(() => api("PUT", "/fallback", { playlistId: a.id }));
        case "saveSettings":
          return run(() => api("PUT", "/settings", toServerSettings(a.settings)));
        case "deleteTrack":
          return run(() => api("DELETE", `/tracks/${a.id}`));
      }
    },
    [run, debounced],
  );

  const signIn = useCallback(async (password: string) => {
    await api("POST", "/login", { password });
    setConnection("loading");
    setEpoch((e) => e + 1);
  }, []);

  const signOut = useCallback(async () => {
    await api("POST", "/logout").catch(() => {});
    setState(null);
    stateRef.current = null;
    setConnection("signed-out");
  }, []);

  const byId = useMemo(() => new Map(state?.tracks.map((t) => [t.id, t]) ?? []), [state?.tracks]);
  const current = state?.currentId ? (byId.get(state.currentId) ?? null) : null;
  const elapsed =
    state?.currentStartedAt != null ? Math.max(0, (Date.now() + clockOffset.current - state.currentStartedAt) / 1000) : 0;

  return {
    state,
    connection,
    error,
    clearError: () => setError(null),
    dispatch,
    refresh,
    signIn,
    signOut,
    current,
    elapsed,
    trackById: (id: string) => byId.get(id)!,
    fallback: state?.playlists.find((p) => p.id === state.fallbackPlaylistId) ?? null,
  };
}

export type Station = ReturnType<typeof useStation>;
export { ApiError };
