import {
  Badge,
  Button,
  DragHandleIcon,
  JingleIcon,
  NumberField,
  PlusIcon,
  SegmentedControl,
  Surface,
  Switch,
  transition,
} from "@station/ui";
import { Reorder, useDragControls } from "motion/react";
import { formatDuration, type JingleRule } from "../data";
import type { StationSim } from "../sim";

function describe(r: JingleRule) {
  if (!r.enabled) return "Not scheduled.";
  const songs = `every ${r.everySongs === 1 ? "song" : `${r.everySongs} songs`}`;
  const minutes = `every ${r.everyMinutes} minutes`;
  const when = r.unit === "songs" ? songs : r.unit === "minutes" ? minutes : `${songs} or ${minutes}, whichever comes first`;
  return `Plays ${when}, after the current track finishes.`;
}

export function JinglesView({ sim, onAddJingle }: { sim: StationSim; onAddJingle: () => void }) {
  const { state, dispatch } = sim;
  return (
    <div className="host-page">
      <header className="host-page__header">
        <div>
          <h1 className="host-h1">Jingles</h1>
          <p className="host-sub">
            Jingles never interrupt a track. When several are due at once, they play in this order — drag to change it.
          </p>
        </div>
        <Button variant="accent" onClick={onAddJingle}>
          <PlusIcon />
          Add jingle
        </Button>
      </header>

      <Reorder.Group
        axis="y"
        values={state.rules}
        onReorder={(rules) => dispatch({ type: "reorderRules", rules })}
        className="host-jingles"
      >
        {state.rules.map((r, i) => (
          <RuleCard key={r.jingleId} rule={r} order={i + 1} sim={sim} />
        ))}
      </Reorder.Group>
    </div>
  );
}

function RuleCard({ rule: r, order, sim }: { rule: JingleRule; order: number; sim: StationSim }) {
  const controls = useDragControls();
  const jingle = sim.trackById(r.jingleId);
  const update = (patch: Partial<JingleRule>) => sim.dispatch({ type: "updateRule", rule: { ...r, ...patch } });

  return (
    <Reorder.Item value={r} dragListener={false} dragControls={controls} transition={transition.panel} className="host-jingle-item">
      <Surface className="host-card host-jingle" data-disabled={r.enabled ? undefined : ""}>
        <div className="host-jingle__head">
          <button className="host-queue__handle" aria-label={`Reorder ${jingle.title}`} onPointerDown={(e) => controls.start(e)}>
            <DragHandleIcon />
          </button>
          <span className="host-jingle__order r-label r-tnum">{order}</span>
          <span className="host-jingle__icon">
            <JingleIcon />
          </span>
          <div className="host-queue__meta">
            <span className="host-queue__title">{jingle.title}</span>
            <span className="host-queue__artist">{formatDuration(jingle.durationSec)}</span>
          </div>
          {r.enabled ? <Badge tone="accent">Scheduled</Badge> : <Badge>Off</Badge>}
          <Switch aria-label={`Schedule ${jingle.title}`} checked={r.enabled} onCheckedChange={(enabled) => update({ enabled })} />
        </div>

        <div className="host-jingle__rule">
          <SegmentedControl
            size="sm"
            aria-label={`${jingle.title} frequency unit`}
            value={r.unit}
            onValueChange={(unit) => update({ unit })}
            options={[
              { value: "songs", label: "Songs" },
              { value: "minutes", label: "Minutes" },
              { value: "both", label: "Both" },
            ]}
          />
          <div className="host-jingle__fields">
            <label className="host-jingle__field" data-hidden={r.unit === "minutes" ? "" : undefined}>
              <span className="r-label">Every</span>
              <NumberField
                aria-label="Songs between plays"
                suffix="songs"
                min={1}
                max={50}
                value={r.everySongs}
                onValueChange={(everySongs) => update({ everySongs })}
                disabled={!r.enabled || r.unit === "minutes"}
              />
            </label>
            <label className="host-jingle__field" data-hidden={r.unit === "songs" ? "" : undefined}>
              <span className="r-label">{r.unit === "both" ? "or every" : "Every"}</span>
              <NumberField
                aria-label="Minutes between plays"
                suffix="min"
                min={1}
                max={240}
                step={5}
                value={r.everyMinutes}
                onValueChange={(everyMinutes) => update({ everyMinutes })}
                disabled={!r.enabled || r.unit === "songs"}
              />
            </label>
          </div>
        </div>
        <p className="host-hint">{describe(r)}</p>
      </Surface>
    </Reorder.Item>
  );
}
