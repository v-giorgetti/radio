import { Popover } from "@base-ui/react/popover";
import { EqIcon, ResetIcon } from "../icons";
import { Button } from "./Button";
import { Slider } from "./Slider";
import { useStationTheme } from "./StationTheme";

export type EqBand = "bass" | "mid" | "treble";
export type EqSettings = Record<EqBand, number>;

export const flatEq: EqSettings = { bass: 0, mid: 0, treble: 0 };
export const EQ_RANGE_DB = 12;

const bands: Array<{ key: EqBand; label: string }> = [
  { key: "bass", label: "Bass" },
  { key: "mid", label: "Mid" },
  { key: "treble", label: "Treble" },
];

const formatDb = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(v % 1 ? 1 : 0)}`;

export const isFlat = (eq: EqSettings) => bands.every(({ key }) => eq[key] === 0);

export type EqPanelProps = {
  value: EqSettings;
  onValueChange: (value: EqSettings) => void;
};

/** Local, per-listener tone controls. Never affects the broadcast. */
export function EqPanel({ value, onValueChange }: EqPanelProps) {
  const { portalContainer } = useStationTheme();
  const flat = isFlat(value);

  return (
    <Popover.Root>
      <Popover.Trigger
        render={<Button variant="ghost" />}
        className="r-button r-eq-trigger"
        data-modified={flat ? undefined : ""}
        aria-label={flat ? "Equalizer" : "Equalizer (adjusted)"}
      >
        <EqIcon />
        EQ
      </Popover.Trigger>
      <Popover.Portal container={portalContainer}>
        <Popover.Positioner side="top" align="start" sideOffset={10} collisionPadding={12}>
          <Popover.Popup className="r-popup r-eq">
            <div className="r-eq__header">
              <Popover.Title className="r-eq__title">Equalizer</Popover.Title>
              <Popover.Description className="r-label">Only on this device</Popover.Description>
            </div>
            <div className="r-eq__bands">
              {bands.map(({ key, label }) => (
                <div className="r-eq__band" key={key}>
                  <span className="r-eq__value" aria-hidden>
                    {formatDb(value[key])}
                  </span>
                  <Slider
                    orientation="vertical"
                    tone="accent"
                    centered
                    aria-label={`${label} gain`}
                    min={-EQ_RANGE_DB}
                    max={EQ_RANGE_DB}
                    step={0.5}
                    value={value[key]}
                    onValueChange={(v) => onValueChange({ ...value, [key]: v })}
                    getValueText={(v) => `${formatDb(v)} decibels`}
                  />
                  <span className="r-label">{label}</span>
                </div>
              ))}
            </div>
            <div className="r-eq__footer">
              <Button size="sm" variant="ghost" disabled={flat} onClick={() => onValueChange(flatEq)}>
                <ResetIcon />
                Flat
              </Button>
              <Popover.Close render={<Button size="sm" variant="outline" />}>Done</Popover.Close>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
