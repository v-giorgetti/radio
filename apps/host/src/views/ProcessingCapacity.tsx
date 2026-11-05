import { Badge, Surface, Tooltip } from "@station/ui";
import type { ProcessingStatus, StationSettings } from "../data";

/** A bounded processing benchmark, rather than a reading of the paced audio loop. */
export function ProcessingCapacity({ state }: { state: Partial<ProcessingStatus> & { settings?: StationSettings } }) {
  const measurement = state.processingHeadroom;
  const settings = state.settings;
  const stale = measurement && settings && (
    measurement.streamFormat !== settings.streamFormat || measurement.bitrate !== settings.bitrate ||
    measurement.normalizeLoudness !== settings.normalizeLoudness ||
    measurement.crossfadeVoices !== (settings.crossfadeMs > 0 ? 2 : 1)
  );
  const low = measurement && !stale && measurement.realtimeFactor < 1.5;
  const time = measurement ? new Date(measurement.measuredAt) : null;
  return (
    <Surface className="host-card host-capacity">
      <div className="host-card__head">
        <h2 className="host-h2">Processing capacity</h2>
        {stale ? <Badge tone="warning">Previous settings</Badge> : state.processingProbeRunning ? <Badge>Measuring</Badge> : low ? (
          <Badge tone={measurement.realtimeFactor < 1 ? "danger" : "warning"}>Low headroom</Badge>
        ) : null}
      </div>
      {measurement ? (
        <>
          <div>
            <span className="r-display host-capacity__value">{measurement.realtimeFactor.toFixed(1)}×</span>
            <span className="r-label"> real time</span>
          </div>
          <p className="host-hint">
            {measurement.streamFormat.toUpperCase()} · {measurement.bitrate} kbps · {measurement.normalizeLoudness ? "normalized" : "original gain"}
          </p>
          <p className="host-hint">
            {measurement.source === "library" ? "Library audio" : "Synthetic audio"}
            {" · "}{(measurement.sampleDurationMs / 1000).toFixed(1)} s sample
            {" · "}{measurement.crossfadeVoices === 2 ? "two-voice mix" : "single voice"}
          </p>
          {time && <time className="r-label" dateTime={time.toISOString()}>Measured {time.toLocaleTimeString()}</time>}
          {stale && <p className="host-hint" role="status">Stream settings changed. This result describes the previous configuration; a fresh probe runs periodically while on air.</p>}
          {low && <p className="host-hint" role="status">The last probe left little processing margin. Sustained server load may cause audio dropouts.</p>}
        </>
      ) : <p className="host-hint">{state.processingProbeRunning ? "Checking this server's audio processing speed…" : "No processing measurement yet."}</p>}
      {state.processingProbeError && <p className="host-hint" role="status">{state.processingProbeError}{measurement ? " Showing the previous measurement." : ""}</p>}
      <p className="host-hint">A short periodic benchmark. This is not CPU usage or a guarantee against dropouts.</p>
      {state.decoderCalibration?.source !== "unavailable" && state.decoderCalibration && (
        <Tooltip content="The decoder's measured startup lead. It adapts as files are played; this is not the listener's total delay.">
          <span className="r-label" tabIndex={0}>Decoder lead {Math.round(state.decoderLeadMs ?? 0)} ms · calibrated with {state.decoderCalibration.source === "library" ? "library audio" : "synthetic audio"}</span>
        </Tooltip>
      )}
    </Surface>
  );
}
