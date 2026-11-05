import {
  Button,
  ConnectionIcon,
  Dialog,
  flatEq,
  InfoIcon,
  LockIcon,
  Player,
  SegmentedControl,
  StationTheme,
  Surface,
  TextField,
  transition,
  WarningIcon,
  type EqSettings,
  type NowPlayingItem,
} from "@station/ui";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type FormEvent } from "react";
import { useStationAudio } from "./audio";
import {
  DEMO_ACCESS_CODE,
  draftStates,
  audibleItem,
  readDraftState,
  realtimePositionMs,
  useBackendStation,
  usePublicStation,
  type DraftState,
  type PublicStation,
} from "./station";

type Prefs = { volume: number; muted: boolean; eq: EqSettings };
const PREFS_KEY = "station:listener-prefs";
const CODE_KEY = "station:access-code";

/** Volume and EQ stay on this device only (no identifiers, no server round-trip). */
function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(() => {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) return { volume: 0.8, muted: false, eq: flatEq, ...JSON.parse(raw) } as Prefs;
    } catch {
      /* ignore unreadable prefs */
    }
    return { volume: 0.8, muted: false, eq: flatEq };
  });
  useEffect(() => {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }, [prefs]);
  return [prefs, (patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch }))] as const;
}

export function App() {
  const forced = readDraftState();
  const [draft, setDraftState] = useState<DraftState>(forced ?? "live");
  // Remembered for this browser tab session only.
  const [code, setCodeState] = useState<string | null>(() => sessionStorage.getItem(CODE_KEY));
  const setCode = (c: string | null) => {
    if (c) sessionStorage.setItem(CODE_KEY, c);
    else sessionStorage.removeItem(CODE_KEY);
    setCodeState(c);
  };
  const backend = useBackendStation(code, forced === null);

  // The operator changed the code: forget the stale one so the gate shows again.
  useEffect(() => {
    if (code && backend.status === "connected" && backend.station?.locked) setCode(null);
  }, [code, backend.status, backend.station?.locked]); // eslint-disable-line react-hooks/exhaustive-deps
  const simulated = usePublicStation(backend.status === "connected" ? null : draft);
  const [privacyOpen, setPrivacyOpen] = useState(false);

  const live = backend.status === "connected" && backend.station !== null;
  const station: PublicStation = live ? backend.station! : simulated;
  const checking = backend.status === "checking";

  const setDraft = (d: DraftState) => {
    const url = new URL(location.href);
    url.searchParams.set("state", d);
    history.replaceState(null, "", url);
    setDraftState(d);
    setCode(null);
  };

  const locked = live ? backend.station!.locked : station.access === "private" && !code;

  /** Live: the server checks the code. Draft: the demo code. Returns false on mismatch. */
  const unlock = async (value: string) => {
    if (!live) {
      if (value !== DEMO_ACCESS_CODE) return false;
      setCode(value);
      return true;
    }
    const res = await fetch("/api/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: value }),
    });
    if (!res.ok) return false;
    setCode(value);
    return true;
  };

  return (
    <StationTheme accent={station.accent} className="ls">
      <header className="ls-header">
        <div className="ls-brand">
          <span className="ls-mark" aria-hidden>
            {station.logoUrl ? <img src={station.logoUrl} alt="" /> : station.name[0]}
          </span>
          <span className="ls-brand__name">{station.name}</span>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setPrivacyOpen(true)}>
          <InfoIcon />
          Privacy
        </Button>
      </header>

      <main className="ls-main">
        <motion.div
          className="ls-hero"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={transition.content}
        >
          <h1 className="r-display ls-title">{station.name}</h1>
          <p className="ls-description">{station.description}</p>
        </motion.div>

        <AnimatePresence mode="wait" initial={false}>
          {checking ? null : locked ? (
            <motion.div key="gate" className="ls-stage" {...enter}>
              <AccessGate onUnlock={unlock} showDemoHint={!live} />
            </motion.div>
          ) : (
            <motion.div key={live ? "player-live" : "player-demo"} className="ls-stage" {...enter}>
              <ListenerPlayer station={station} draft={live ? "live" : draft} accessCode={code} streamUrl={live ? "/stream" : null} />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <footer className="ls-footer r-label">
        <span>Listener counts are live audio connections only.</span>
        {!live && !checking && <span>Draft preview · simulated station and demo audio</span>}
      </footer>

      {!live && !checking && <DraftSwitcher value={draft} onChange={setDraft} />}

      <Dialog
        open={privacyOpen}
        onOpenChange={setPrivacyOpen}
        title="Privacy"
        description={`How ${station.name} handles your data.`}
        footer={<Button onClick={() => setPrivacyOpen(false)}>Close</Button>}
      >
        <div className="ls-privacy">
          <p>
            Listening is anonymous. While you listen, your browser keeps one audio connection open; the station only
            counts how many are open. It doesn't keep IP addresses, identifiers or listening history, and this page sets
            no tracking cookies.
          </p>
          <p>
            Your volume and equalizer settings are saved in this browser only, so they're there next time. Clearing
            your site data removes them.
          </p>
          <p className="r-label">Questions about this station's data handling go to the station operator.</p>
        </div>
      </Dialog>
    </StationTheme>
  );
}

const enter = {
  initial: { opacity: 0, y: 12, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -8, scale: 0.98 },
  transition: transition.panel,
};

function ListenerPlayer({
  station,
  draft,
  accessCode,
  streamUrl,
}: {
  station: PublicStation;
  draft: DraftState;
  accessCode: string | null;
  streamUrl: string | null;
}) {
  const [prefs, setPrefs] = usePrefs();
  const audio = useStationAudio({ ...prefs, accessCode, streamUrl });
  // Re-evaluate a few times per second: items change as the stream plays, not only on events.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 200);
    return () => clearInterval(id);
  }, []);
  const item = audibleItem(station, audio.sync);
  const heard = audio.sync && audio.sync.epoch === station.epoch ? audio.sync.positionMs() : null;
  const live = realtimePositionMs(station);
  const behindMs = heard !== null && live !== null ? Math.max(0, live - heard) : null;
  const offline = !station.onAirSince;

  // Stop playback if the station goes off air.
  useEffect(() => {
    if (offline && audio.status !== "stopped") audio.listen(false);
  }, [offline, audio]);

  useMediaSession(station, item, audio.status === "live", audio.listen);

  const simulatedDrop = draft === "reconnecting" && audio.status !== "stopped";
  const status = simulatedDrop ? "connecting" : audio.status;

  const notice = audio.reconnecting || simulatedDrop ? (
    <>
      <ConnectionIcon size={16} /> Connection lost. Reconnecting to the live stream…
    </>
  ) : audio.error ? (
    <>
      <WarningIcon size={16} /> Playback couldn't start. Press Listen to try again.
    </>
  ) : null;

  return (
    <div className="ls-player-wrap">
    <Player
      stationName={station.name}
      onAirSince={station.onAirSince}
      listeners={station.listeners}
      item={item}
      status={status}
      onListenChange={audio.listen}
      volume={prefs.volume}
      muted={prefs.muted}
      onVolumeChange={(volume) => setPrefs({ volume })}
      onMutedChange={(muted) => setPrefs({ muted })}
      eq={prefs.eq}
      onEqChange={(eq) => setPrefs({ eq })}
      levels={simulatedDrop ? null : audio.levels}
      listenDisabled={offline}
      empty={
        offline
          ? { title: "Off air", text: `${station.name} isn't broadcasting right now. Check back soon.` }
          : { title: "Nothing playing", text: "Music resumes when the next track starts." }
      }
      notice={notice}
    />
    {audio.status === "live" && behindMs !== null && audio.network && (
      <p className="r-label r-tnum ls-latency" data-behind-ms={Math.round(behindMs)}>
        {(behindMs / 1000).toFixed(1)} s behind live · ping {Math.round(audio.network.rttMs)} ms · buffer{" "}
        {(audio.network.burstMs / 1000).toFixed(1)} s
      </p>
    )}
    </div>
  );
}

/** Lock-screen / hardware media keys and the tab title. */
function useMediaSession(station: PublicStation, item: NowPlayingItem | null, playing: boolean, listen: (on: boolean) => void) {
  useEffect(() => {
    const title = item?.title ?? (item?.kind === "jingle" ? station.name : null);
    document.title = playing && title ? `▶ ${title} — ${station.name}` : station.name;
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    navigator.mediaSession.metadata = item
      ? new MediaMetadata({
          title: title ?? station.name,
          artist: item.artists?.join(", ") || station.name,
          album: item.album ?? station.name,
          artwork: item.artworkUrl ? [{ src: item.artworkUrl, sizes: "400x400" }] : [],
        })
      : null;
  }, [item, playing, station.name]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.setActionHandler("play", () => listen(true));
    navigator.mediaSession.setActionHandler("pause", () => listen(false));
    navigator.mediaSession.setActionHandler("stop", () => listen(false));
    return () => {
      for (const a of ["play", "pause", "stop"] as const) navigator.mediaSession.setActionHandler(a, null);
    };
  }, [listen]);
}

function AccessGate({ onUnlock, showDemoHint }: { onUnlock: (code: string) => Promise<boolean>; showDemoHint: boolean }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);
  const [shake, setShake] = useState(0);

  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await onUnlock(value.trim().toUpperCase()).catch(() => false);
    setBusy(false);
    if (!ok) {
      setError(true);
      setShake((n) => n + 1);
    }
  };

  return (
    <motion.div key={shake} animate={shake ? { x: [0, -8, 8, -5, 5, 0] } : undefined} transition={{ duration: 0.4 }}>
      <Surface elevation="raised" className="ls-gate">
        <span className="ls-gate__icon">
          <LockIcon />
        </span>
        <h2 className="ls-gate__title">This station is private</h2>
        <p className="ls-gate__text">Enter the access code you were given to start listening.</p>
        <form onSubmit={submit} className="ls-gate__form">
          <TextField
            aria-label="Access code"
            value={value}
            onValueChange={(v) => {
              setValue(v);
              setError(false);
            }}
            placeholder="e.g. WORD-1234"
          />
          <Button type="submit" variant="accent" disabled={!value.trim() || busy}>
            Continue
          </Button>
        </form>
        <AnimatePresence>
          {error && (
            <motion.p className="ls-gate__error" role="alert" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              That code doesn't match. Check it with the station operator.
            </motion.p>
          )}
        </AnimatePresence>
        {showDemoHint && <p className="r-label ls-gate__hint">Draft: the demo code is {DEMO_ACCESS_CODE}.</p>}
      </Surface>
    </motion.div>
  );
}

function DraftSwitcher({ value, onChange }: { value: DraftState; onChange: (d: DraftState) => void }) {
  return (
    <div className="ls-draft">
      <span className="r-label">Draft state</span>
      <SegmentedControl
        size="sm"
        aria-label="Preview page state"
        value={value}
        onValueChange={onChange}
        options={draftStates.map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) }))}
      />
    </div>
  );
}
