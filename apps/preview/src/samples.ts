import type { LevelSource, NowPlayingItem } from "@station/ui";

/** Abstract placeholder artwork — sample content only, not product branding. */
function art(a: string, b: string, shape: "circle" | "arc" | "grid" | "wave") {
  const shapes = {
    circle: `<circle cx="200" cy="200" r="120" fill="${b}"/><circle cx="260" cy="150" r="46" fill="${a}" opacity=".55"/>`,
    arc: `<path d="M40 320a160 160 0 0 1 320 0" stroke="${b}" stroke-width="56" fill="none"/><circle cx="200" cy="320" r="34" fill="${b}"/>`,
    grid: Array.from({ length: 16 }, (_, i) => `<rect x="${60 + (i % 4) * 75}" y="${60 + Math.floor(i / 4) * 75}" width="55" height="55" rx="8" fill="${b}" opacity="${0.25 + ((i * 7) % 10) / 13}"/>`).join(""),
    wave: Array.from({ length: 7 }, (_, i) => `<path d="M0 ${110 + i * 32} Q100 ${70 + i * 32} 200 ${110 + i * 32} T400 ${110 + i * 32}" stroke="${b}" stroke-width="10" fill="none" opacity="${1 - i * 0.11}"/>`).join(""),
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="${a}"/>${shapes[shape]}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export const sampleQueue: Omit<NowPlayingItem, "id">[] = [
  { kind: "music", title: "Paper Lanterns", artists: ["Mira Holt"], album: "Low Tide Hours", artworkUrl: art("#e9e4da", "#d0572f", "circle") },
  { kind: "music", title: "Signal Through Fog", artists: ["The Quiet Engines", "Ada Ren"], album: "Northbound", artworkUrl: art("#dfe6e4", "#2f6f68", "wave") },
  { kind: "jingle", title: null, artists: null, album: null, artworkUrl: null },
  { kind: "music", title: "A Very Long Song Title That Needs To Truncate Gracefully", artists: ["Orchestra of Small Rooms"], album: "Interiors, Vol. 2", artworkUrl: art("#ecebf3", "#4b4ac7", "grid") },
  { kind: "music", title: "Untagged upload", artists: null, album: null, artworkUrl: null },
  { kind: "music", title: "Morning Index", artists: ["Kiko Bals"], album: "Field Recordings", artworkUrl: art("#f2ece2", "#1d1d1d", "arc") },
];

/** Synthetic spectrum for the preview, so the visualizer can be judged without audio. */
export function syntheticLevels(): LevelSource {
  const start = performance.now();
  return (out) => {
    const t = (performance.now() - start) / 1000;
    const beat = Math.max(0, Math.sin(t * Math.PI * 2 * 1.9)) ** 6;
    for (let i = 0; i < out.length; i++) {
      const x = i / out.length;
      const tilt = 1 - x * 0.65;
      const wobble = 0.5 + 0.5 * Math.sin(t * (2.1 + x * 5) + i * 0.9) * Math.cos(t * 1.3 + i * 0.37);
      const kick = x < 0.2 ? beat * (1 - x * 4) : 0;
      out[i] = Math.min(255, Math.round(255 * tilt * (0.25 + 0.55 * wobble + 0.5 * kick)));
    }
  };
}
