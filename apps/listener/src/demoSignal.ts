/**
 * A quiet generated groove used only when no stream URL is configured, so the
 * EQ and visualizer can be judged with real audio. Not station content.
 */
export type DemoSignal = { output: AudioNode; stop: () => void };

const CHORDS = [
  [220.0, 277.18, 329.63, 415.3], // A maj7
  [185.0, 233.08, 277.18, 369.99], // F#m7
  [146.83, 185.0, 220.0, 277.18], // D maj7
  [164.81, 207.65, 246.94, 329.63], // E
];

export function createDemoSignal(ctx: AudioContext): DemoSignal {
  const out = ctx.createGain();
  out.gain.value = 0.9;

  // Pad: detuned triangles through a soft lowpass.
  const padFilter = ctx.createBiquadFilter();
  padFilter.type = "lowpass";
  padFilter.frequency.value = 1400;
  const padGain = ctx.createGain();
  padGain.gain.value = 0.05;
  padFilter.connect(padGain).connect(out);
  const voices = Array.from({ length: 4 }, (_, i) => {
    const osc = ctx.createOscillator();
    osc.type = i % 2 ? "triangle" : "sawtooth";
    osc.detune.value = (i - 1.5) * 6;
    osc.connect(padFilter);
    osc.start();
    return osc;
  });

  // Noise buffer for hats.
  const noise = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  const bpm = 96;
  const beat = 60 / bpm;
  let nextBeat = ctx.currentTime + 0.1;
  let step = 0;

  const kick = (t: number) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.55, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.4);
  };
  const hat = (t: number, level: number) => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    src.connect(hp).connect(g).connect(out);
    src.start(t);
    src.stop(t + 0.08);
  };
  const bass = (t: number, f: number) => {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = f / 2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + beat * 0.9);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + beat);
  };

  // Lookahead scheduler.
  const timer = setInterval(() => {
    while (nextBeat < ctx.currentTime + 0.25) {
      const chord = CHORDS[Math.floor(step / 8) % CHORDS.length]!;
      if (step % 8 === 0) {
        voices.forEach((v, i) => v.frequency.setTargetAtTime(chord[i]!, nextBeat, 0.08));
      }
      if (step % 2 === 0) kick(nextBeat);
      hat(nextBeat, step % 2 ? 0.07 : 0.03);
      hat(nextBeat + beat / 2, 0.04);
      if (step % 2 === 1) bass(nextBeat, chord[0]!);
      nextBeat += beat;
      step++;
    }
  }, 50);

  return {
    output: out,
    stop: () => {
      clearInterval(timer);
      voices.forEach((v) => v.stop());
      out.disconnect();
    },
  };
}
