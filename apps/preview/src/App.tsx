import {
  AnimatedNumber,
  Artwork,
  Button,
  EqPanel,
  flatEq,
  ListenButton,
  ListenerCount,
  NowPlaying,
  OnAirSince,
  palette,
  Player,
  Slider,
  StationTheme,
  Surface,
  Tooltip,
  TooltipProvider,
  Visualizer,
  VolumeControl,
  type EqSettings,
  type ListenStatus,
  type NowPlayingItem,
} from "@station/ui";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { sampleQueue, syntheticLevels } from "./samples";

const accents = ["#2b59ff", "#e4572e", "#1f8a70", "#7a4cff", "#141414", "#f2c14e"];

function useQueue() {
  const [index, setIndex] = useState(0);
  const counter = useRef(0);
  const [item, setItem] = useState<NowPlayingItem>({ id: "0", ...sampleQueue[0]! });
  const next = () => {
    const i = (index + 1) % sampleQueue.length;
    counter.current += 1;
    setIndex(i);
    setItem({ id: String(counter.current), ...sampleQueue[i]! });
  };
  return { item, next };
}

function useListen() {
  const [status, setStatus] = useState<ListenStatus>("stopped");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onListenChange = (listen: boolean) => {
    clearTimeout(timer.current);
    if (!listen) return setStatus("stopped");
    setStatus("connecting");
    timer.current = setTimeout(() => setStatus("live"), 900);
  };
  return { status, onListenChange };
}

export function App() {
  const [accent, setAccent] = useState(accents[0]!);
  const [reduced, setReduced] = useState(false);

  return (
    <StationTheme accent={accent} reducedMotion={reduced ? "always" : "user"} className="pv">
      <TooltipProvider delay={400}>
        <header className="pv-header">
          <div>
            <span className="r-label">@station/ui</span>
            <h1 className="r-display pv-h1">Component preview</h1>
          </div>
          <div className="pv-toolbar">
            <div className="pv-swatches" role="radiogroup" aria-label="Station accent">
              {accents.map((c) => (
                <button
                  key={c}
                  role="radio"
                  aria-checked={c === accent}
                  aria-label={`Accent ${c}`}
                  className="pv-swatch"
                  style={{ background: c }}
                  onClick={() => setAccent(c)}
                />
              ))}
            </div>
            <Button size="sm" variant={reduced ? "primary" : "outline"} aria-pressed={reduced} onClick={() => setReduced((r) => !r)}>
              Reduced motion {reduced ? "on" : "off"}
            </Button>
          </div>
        </header>

        <main className="pv-main">
          <PlayerDemo />
          <Foundations />
          <Section title="Buttons" note="Base UI Button. Press scale and colour use the shared easing.">
            <div className="pv-row">
              <Button>Default</Button>
              <Button variant="primary">Primary</Button>
              <Button variant="accent">Accent</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button disabled>Disabled</Button>
              <Button size="sm">Small</Button>
              <Tooltip content="Tooltips animate in from their trigger">
                <Button variant="outline">Hover me</Button>
              </Tooltip>
            </div>
          </Section>
          <ListenDemo />
          <ControlsDemo />
          <StatusDemo />
          <NowPlayingDemo />
          <VisualizerDemo />
        </main>
      </TooltipProvider>
    </StationTheme>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="pv-section">
      <div className="pv-section__head">
        <h2 className="r-title">{title}</h2>
        {note && <p className="pv-note">{note}</p>}
      </div>
      <Surface className="pv-stage">{children}</Surface>
    </section>
  );
}

function PlayerDemo() {
  const { item, next } = useQueue();
  const { status, onListenChange } = useListen();
  const [volume, setVolume] = useState(0.8);
  const [muted, setMuted] = useState(false);
  const [eq, setEq] = useState<EqSettings>(flatEq);
  const [listeners, setListeners] = useState(42);
  const levels = useMemo(syntheticLevels, []);
  const onAir = useMemo(() => new Date(Date.now() - 1000 * 60 * 137), []);

  return (
    <section className="pv-section pv-section--hero">
      <div className="pv-section__head">
        <h2 className="r-title">Listener player</h2>
        <p className="pv-note">The wireframe layout, put together from the components below. It uses simulated data.</p>
      </div>
      <div className="pv-hero">
        <Player
          stationName="Sample Station"
          onAirSince={onAir}
          listeners={listeners}
          item={item}
          status={status}
          onListenChange={onListenChange}
          volume={volume}
          muted={muted}
          onVolumeChange={setVolume}
          onMutedChange={setMuted}
          eq={eq}
          onEqChange={setEq}
          levels={levels}
        />
        <div className="pv-row pv-row--center">
          <Button size="sm" variant="outline" onClick={next}>Next item</Button>
          <Button size="sm" variant="outline" onClick={() => setListeners((n) => n + 1 + Math.floor(Math.random() * 9))}>Listeners +</Button>
          <Button size="sm" variant="outline" onClick={() => setListeners((n) => Math.max(0, n - 1 - Math.floor(Math.random() * 9)))}>Listeners −</Button>
        </div>
      </div>
    </section>
  );
}

function Foundations() {
  const swatches = Object.entries(palette);
  return (
    <Section title="Foundations" note="A light, nearly monochrome palette. Only the accent changes with the station.">
      <div className="pv-swatch-grid">
        {swatches.map(([name, value]) => (
          <div key={name} className="pv-token">
            <span className="pv-token__chip" style={{ background: name === "accent" ? "var(--r-accent)" : value }} />
            <span className="pv-token__name">{name}</span>
            <span className="r-label">{name === "accent" ? "station" : value}</span>
          </div>
        ))}
      </div>
      <div className="pv-type">
        <span className="r-display" style={{ fontSize: 56 }}>On air</span>
        <span className="r-title">Title · 22 / 700 / −0.03em</span>
        <span style={{ fontSize: 14, fontWeight: 550 }}>Body strong · 14 / 550</span>
        <span style={{ fontSize: 13 }}>Body · 13 / 450</span>
        <span className="r-label">Label · 11 / 550</span>
      </div>
      <MotionSample />
    </Section>
  );
}

function MotionSample() {
  const [on, setOn] = useState(false);
  return (
    <div className="pv-motion">
      <div className="pv-motion__track">
        <span className="pv-motion__dot" data-on={on || undefined} />
      </div>
      <Button size="sm" variant="outline" onClick={() => setOn((v) => !v)}>
        Play easing
      </Button>
      <span className="r-label">cubic-bezier(.16, 1, .3, 1) · 180 / 380 / 600 ms</span>
    </div>
  );
}

function ListenDemo() {
  const live = useListen();
  return (
    <Section title="Listen button" note="Base UI Toggle. Its icon and label change between states with Motion. It never starts playing automatically.">
      <div className="pv-row">
        <ListenButton {...live} />
        <span className="pv-divider" />
        <ListenButton status="stopped" onListenChange={() => {}} />
        <ListenButton status="connecting" onListenChange={() => {}} />
        <ListenButton status="live" onListenChange={() => {}} />
        <ListenButton status="stopped" onListenChange={() => {}} disabled />
      </div>
    </Section>
  );
}

function ControlsDemo() {
  const [volume, setVolume] = useState(0.6);
  const [muted, setMuted] = useState(false);
  const [eq, setEq] = useState<EqSettings>({ bass: 3, mid: 0, treble: -1.5 });
  const [raw, setRaw] = useState(40);
  return (
    <Section title="Volume, EQ and slider" note="Base UI Slider and Popover. The EQ only changes this device's sound, and a dot appears when it isn't flat.">
      <div className="pv-row">
        <VolumeControl volume={volume} muted={muted} onVolumeChange={setVolume} onMutedChange={setMuted} />
        <span className="pv-divider" />
        <EqPanel value={eq} onValueChange={setEq} />
        <span className="pv-divider" />
        <div style={{ width: 200 }}>
          <Slider aria-label="Example" value={raw} onValueChange={setRaw} tone="accent" />
        </div>
        <span className="r-label r-tnum">{raw}</span>
      </div>
    </Section>
  );
}

function StatusDemo() {
  const [n, setN] = useState(1284);
  const since = useMemo(() => new Date(Date.now() - 1000 * 60 * 60 * 30), []);
  return (
    <Section title="Station status" note="Shows when the broadcast started and how many listeners there are. Numbers roll in the direction they change.">
      <div className="pv-row">
        <OnAirSince since={new Date(Date.now() - 1000 * 60 * 42)} />
        <OnAirSince since={since} />
        <OnAirSince since={null} />
        <span className="pv-divider" />
        <ListenerCount count={n} />
        <ListenerCount count={1} />
      </div>
      <div className="pv-row">
        <span className="r-display" style={{ fontSize: 40 }}>
          <AnimatedNumber value={n} />
        </span>
        <Button size="sm" variant="outline" onClick={() => setN((v) => v + Math.ceil(Math.random() * 120))}>+</Button>
        <Button size="sm" variant="outline" onClick={() => setN((v) => Math.max(0, v - Math.ceil(Math.random() * 120)))}>−</Button>
      </div>
    </Section>
  );
}

function NowPlayingDemo() {
  const { item, next } = useQueue();
  return (
    <Section title="Now playing and artwork" note="Text and artwork crossfade when the item changes. Includes fallbacks for jingles, missing tags and missing artwork.">
      <div className="pv-row pv-row--top">
        <div style={{ flex: "1 1 320px", minWidth: 0 }}>
          <NowPlaying item={item} stationName="Sample Station" />
        </div>
        <Button size="sm" variant="outline" onClick={next}>Next item</Button>
      </div>
      <div className="pv-row">
        {sampleQueue.map((s, i) => (
          <Artwork key={i} src={s.artworkUrl} className="pv-art" />
        ))}
        <Artwork src="/missing.png" className="pv-art" />
      </div>
      <NowPlaying item={null} />
    </Section>
  );
}

function VisualizerDemo() {
  const [active, setActive] = useState(true);
  const levels = useMemo(syntheticLevels, []);
  return (
    <Section title="Visualizer" note="Draws on a canvas from an AnalyserNode (levelsFromAnalyser) and settles to a flat line when stopped. With reduced motion it shows one slowly updating level instead.">
      <div className="pv-row">
        <Button size="sm" variant="outline" onClick={() => setActive((a) => !a)} aria-pressed={active}>
          {active ? "Stop" : "Start"}
        </Button>
      </div>
      <Visualizer active={active} source={levels} />
      <div style={{ width: 220 }}>
        <Visualizer active={active} source={levels} bars={14} />
      </div>
    </Section>
  );
}
