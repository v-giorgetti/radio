/**
 * Import sources shown in the Import dialog. The Rust server owns the pipeline
 * (validate → loudness → tags → dedupe → store with provenance). See SPEC.md › Track importers.
 */
export type ImportSourceKind = "files" | "generator" | "catalogue";

export type ImportSource = {
  id: string;
  name: string;
  kind: ImportSourceKind;
  description: string;
  /** What the operator is relying on to have broadcast rights. */
  rights: string;
  setup?: { field: string; help: string };
};

export const importSources: ImportSource[] = [
  {
    id: "files",
    name: "Files",
    kind: "files",
    description: "Upload audio files or a folder from this computer.",
    rights: "You confirm you hold the broadcast rights for these files.",
  },
  {
    id: "test-library",
    name: "Test library",
    kind: "generator",
    description: "Generate synthetic tracks and jingles with realistic tags for testing at scale.",
    rights: "Generated audio — no third-party rights involved.",
  },
  {
    id: "jamendo",
    name: "Jamendo",
    kind: "catalogue",
    description: "Independent music under Creative Commons licences.",
    rights: "Per-track Creative Commons licence; attribution is stored and shown.",
  },
  {
    id: "internet-archive",
    name: "Internet Archive",
    kind: "catalogue",
    description: "Netlabels, public-domain and CC-licensed audio collections.",
    rights: "Only items with a public-domain or CC licence are listed.",
  },
];
