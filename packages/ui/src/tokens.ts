/** Motion tokens mirrored from styles.css so JS animations match CSS ones. */
export const ease = [0.16, 1, 0.3, 1] as const;

export const duration = {
  fast: 0.18,
  panel: 0.38,
  content: 0.6,
} as const;

export const transition = {
  fast: { duration: duration.fast, ease },
  panel: { duration: duration.panel, ease },
  content: { duration: duration.content, ease },
} as const;

/** The neutral light palette. Station themes only override the accent. */
export const palette = {
  ground: "#f6f6f4",
  panel: "#ffffff",
  control: "#ececea",
  line: "#dcdcd8",
  text: "#141414",
  muted: "#6b6b6b",
  accent: "#2b59ff",
  live: "#e5484d",
} as const;
