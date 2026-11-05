import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { cx } from "../cx";

/** Fills `out` with one 0–255 level per bar. */
export type LevelSource = (out: Uint8Array) => void;

/** Builds a LevelSource from a Web Audio AnalyserNode using log-spaced bands. */
export function levelsFromAnalyser(analyser: AnalyserNode): LevelSource {
  const bins = new Uint8Array(analyser.frequencyBinCount);
  return (out) => {
    analyser.getByteFrequencyData(bins);
    const n = out.length;
    const maxBin = bins.length * 0.75; // skip near-inaudible top end
    for (let i = 0; i < n; i++) {
      const lo = Math.floor(2 ** ((i / n) * Math.log2(maxBin)));
      const hi = Math.max(lo + 1, Math.floor(2 ** (((i + 1) / n) * Math.log2(maxBin))));
      let peak = 0;
      for (let b = lo; b < hi && b < bins.length; b++) peak = Math.max(peak, bins[b]!);
      out[i] = peak;
    }
  };
}

export type VisualizerProps = {
  /** Only true while decoded audio is actually playing. */
  active: boolean;
  source?: LevelSource | null;
  bars?: number;
  className?: string;
};

const RESTING = 0.06;

export function Visualizer({ active, source, bars = 32, className }: VisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion() ?? false;
  const forcedReduced = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    forcedReduced.current = !!canvas.closest("[data-reduced-motion]");
    const staticMode = reduced || forcedReduced.current;

    const levels = new Uint8Array(bars);
    const heights = new Float32Array(bars).fill(RESTING);
    let frame = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = getComputedStyle(canvas).color;
      const gap = 3;
      const w = Math.max(1, (width - gap * (bars - 1)) / bars);
      for (let i = 0; i < bars; i++) {
        const h = Math.max(2, heights[i]! * height);
        const x = i * (w + gap);
        const y = (height - h) / 2;
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, Math.min(w / 2, 2));
        ctx.fill();
      }
    };

    const sample = () => {
      if (active && source) source(levels);
      else levels.fill(0);
    };

    const tick = () => {
      sample();
      for (let i = 0; i < bars; i++) {
        const target = active ? Math.max(RESTING, levels[i]! / 255) : RESTING;
        const current = heights[i]!;
        // Fast attack, slower release reads as "musical".
        const k = target > current ? 0.45 : 0.12;
        heights[i] = current + (target - current) * k;
      }
      draw();
      frame = requestAnimationFrame(tick);
    };

    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    ro.observe(canvas);
    resize();

    let interval: ReturnType<typeof setInterval> | undefined;
    if (staticMode) {
      // Reduced motion: a calm, slowly-updating overall level instead of moving bars.
      const update = () => {
        sample();
        let sum = 0;
        for (let i = 0; i < bars; i++) sum += levels[i]!;
        const avg = active ? Math.max(RESTING, sum / bars / 255) : RESTING;
        heights.fill(avg);
        draw();
      };
      update();
      interval = setInterval(update, 1000);
    } else {
      frame = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(frame);
      if (interval) clearInterval(interval);
      ro.disconnect();
    };
  }, [active, source, bars, reduced]);

  return (
    <canvas
      ref={canvasRef}
      className={cx("r-visualizer", className)}
      data-active={active}
      role="img"
      aria-label={active ? "Audio visualizer" : "Audio visualizer (stopped)"}
    />
  );
}
