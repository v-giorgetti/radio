/** Host dashboard view types (mapped from the server API in store.ts). */

export type SourceId = "files" | "test-library" | "jamendo" | "internet-archive" | (string & {});

export type Track = {
  id: string;
  kind: "music" | "jingle";
  title: string;
  artists: string[];
  album?: string;
  durationSec: number;
  artworkUrl?: string;
  source: SourceId;
  licence?: string;
  /** Source page for openly licensed tracks (credit). */
  attributionUrl?: string;
  loudnessLufs?: number;
};

export type JingleRule = {
  jingleId: string;
  enabled: boolean;
  unit: "songs" | "minutes" | "both";
  everySongs: number;
  everyMinutes: number;
  /** Counters since this jingle last played (from the server). */
  songsSince: number;
  minutesSince: number;
};

export const sourceLabel: Record<string, string> = {
  files: "Files",
  "test-library": "Test library",
  jamendo: "Jamendo",
  "internet-archive": "Internet Archive",
};

export const formatDuration = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

export type Playlist = {
  id: string;
  name: string;
  trackIds: string[];
  shuffle: boolean;
};

export type ListenerAccess = "public" | "private";
export type StreamFormat = "mp3" | "aac" | "opus";

export type ProcessingStatus = {
  processingHeadroom: {
    realtimeFactor: number;
    measuredAt: number;
    source: "library" | "synthetic";
    sampleDurationMs: number;
    crossfadeVoices: number;
    sampleCount: number;
    streamFormat: StreamFormat;
    bitrate: number;
    normalizeLoudness: boolean;
  } | null;
  processingProbeRunning: boolean;
  processingProbeError: string | null;
  decoderLeadMs: number;
  decoderCalibration: { source: "library" | "synthetic" | "unavailable"; samples: number };
};

export const bitratesFor: Record<StreamFormat, number[]> = {
  mp3: [128, 192, 256],
  aac: [96, 128, 192],
  opus: [64, 96, 128],
};

export type StationSettings = {
  name: string;
  description: string;
  accent: string;
  /** Read-only here; logos upload separately. */
  logoUrl: string | null;
  access: ListenerAccess;
  accessCode: string;
  streamFormat: StreamFormat;
  bitrate: number;
  normalizeLoudness: boolean;
  /** 0 = hard cut. Jingle boundaries use at most 1 s. */
  crossfadeMs: number;
  /** Shown to listeners while a jingle plays; {station} = station name. */
  jingleMessage: string;
  integrations: { testLibrary: boolean; internetArchive: boolean; jamendo: boolean; jamendoConnected: boolean };
};
