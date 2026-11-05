import { MuteIcon, VolumeIcon } from "../icons";
import { Button } from "./Button";
import { Slider } from "./Slider";
import { Tooltip } from "./Tooltip";

export type VolumeControlProps = {
  /** 0–1 */
  volume: number;
  muted: boolean;
  onVolumeChange: (volume: number) => void;
  onMutedChange: (muted: boolean) => void;
};

export function VolumeControl({ volume, muted, onVolumeChange, onMutedChange }: VolumeControlProps) {
  const effective = muted ? 0 : volume;
  return (
    <div className="r-volume">
      <Tooltip content={muted ? "Unmute" : "Mute"}>
        <Button
          variant="ghost"
          iconOnly
          aria-label={muted ? "Unmute" : "Mute"}
          aria-pressed={muted}
          onClick={() => onMutedChange(!muted)}
        >
          {effective === 0 ? <MuteIcon /> : <VolumeIcon level={effective} />}
        </Button>
      </Tooltip>
      <Slider
        aria-label="Volume"
        value={Math.round(effective * 100)}
        onValueChange={(v) => {
          if (muted && v > 0) onMutedChange(false);
          onVolumeChange(v / 100);
        }}
        getValueText={(v) => `${v}%`}
      />
    </div>
  );
}
