import {
  Badge,
  Button,
  Dialog,
  FileAudioIcon,
  FlaskIcon,
  FolderIcon,
  GlobeIcon,
  InfoIcon,
  NumberField,
  SearchIcon,
  TextField,
  SegmentedControl,
  Switch,
  Tab,
  TabsList,
  TabsPanel,
  TabsRoot,
  TrashIcon,
  UploadIcon,
} from "@station/ui";
import { useEffect, useRef, useState, type ComponentType, type FormEvent } from "react";
import { api } from "../api";
import { formatDuration, type StationSettings, type Track } from "../data";
import { importSources } from "../importers";

export type ImportRequest =
  | { kind: "files"; files: File[]; fileKind: Track["kind"] }
  | { kind: "catalogue"; source: CatalogueSource; ids: string[] }
  | { kind: "generate"; body: { tracks: number; jingles: number; avgMinutes: number; includeBroken: boolean } };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset: { source?: string; kind?: Track["kind"] };
  integrations: StationSettings["integrations"];
  onImport: (req: ImportRequest) => void;
};

type CatalogueSource = "internet-archive" | "jamendo";

type CatalogueResult = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  durationSec: number | null;
  licence: string;
  licenceUrl: string;
  nonCommercial: boolean;
  pageUrl: string;
  imageUrl: string | null;
  isCollection: boolean;
};

const sourceIcons: Record<string, ComponentType> = {
  files: FolderIcon,
  "test-library": FlaskIcon,
  jamendo: GlobeIcon,
  "internet-archive": GlobeIcon,
};

export function ImportDialog({ open, onOpenChange, preset, integrations, onImport }: Props) {
  const [source, setSource] = useState<string>("files");
  const [kind, setKind] = useState<Track["kind"]>("music");
  const [files, setFiles] = useState<File[]>([]);
  const [gen, setGen] = useState({ tracks: 20, jingles: 3, minutes: 3, broken: true });
  const [picked, setPicked] = useState<Record<CatalogueSource, string[]>>({ "internet-archive": [], jamendo: [] });

  useEffect(() => {
    if (!open) return;
    setSource(preset.source ?? "files");
    setKind(preset.kind ?? "music");
    setFiles([]);
    setPicked({ "internet-archive": [], jamendo: [] });
  }, [open, preset]);

  const enabled: Record<string, boolean> = {
    files: true,
    "test-library": integrations.testLibrary,
    "internet-archive": integrations.internetArchive,
    jamendo: integrations.jamendo,
  };
  const sources = importSources.filter((s) => enabled[s.id]);
  const meta = importSources.find((s) => s.id === source) ?? importSources[0]!;
  const isCatalogue = source === "internet-archive" || source === "jamendo";
  const available = source !== "jamendo" || integrations.jamendoConnected;
  const count =
    source === "files"
      ? files.length
      : source === "test-library"
        ? gen.tracks + gen.jingles
        : isCatalogue
          ? picked[source as CatalogueSource].length
          : 0;

  const submit = () => {
    if (source === "files") onImport({ kind: "files", files, fileKind: kind });
    else if (isCatalogue) onImport({ kind: "catalogue", source: source as CatalogueSource, ids: picked[source as CatalogueSource] });
    else if (source === "test-library")
      onImport({
        kind: "generate",
        body: { tracks: gen.tracks, jingles: gen.jingles, avgMinutes: gen.minutes, includeBroken: gen.broken },
      });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Import tracks"
      description="Every import is validated, deduplicated and tagged with where it came from."
      footer={
        <>
          <span className="host-dialog-rights r-label">
            <InfoIcon size={14} /> {meta.rights}
          </span>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="accent" disabled={!available || count === 0} onClick={submit}>
            <UploadIcon />
            {source === "test-library" ? `Generate ${count}` : `Import ${count || ""}`.trim()}
          </Button>
        </>
      }
    >
      <TabsRoot value={source} onValueChange={(v) => setSource(v as string)}>
        <TabsList aria-label="Import source">
          {sources.map((s) => {
            const Icon = sourceIcons[s.id] ?? GlobeIcon;
            return (
              <Tab key={s.id} value={s.id}>
                <Icon />
                {s.name}
              </Tab>
            );
          })}
        </TabsList>

        <p className="host-dialog-desc">{meta.description}</p>

        <TabsPanel value="files">
          <FilesPanel files={files} setFiles={setFiles} kind={kind} setKind={setKind} />
        </TabsPanel>

        <TabsPanel value="test-library">
          <div className="host-gen">
            <GenRow label="Music tracks" hint="Tone and pulse beds with tags. About 2 seconds each to generate.">
              <NumberField aria-label="Music tracks" value={gen.tracks} min={1} max={500} step={5} onValueChange={(v) => setGen({ ...gen, tracks: v })} />
            </GenRow>
            <GenRow label="Average length" hint="Track lengths vary around this.">
              <NumberField aria-label="Average length" suffix="min" value={gen.minutes} min={1} max={15} onValueChange={(v) => setGen({ ...gen, minutes: v })} />
            </GenRow>
            <GenRow label="Jingles" hint="Short idents for testing schedule rules.">
              <NumberField aria-label="Jingles" value={gen.jingles} min={0} max={50} onValueChange={(v) => setGen({ ...gen, jingles: v })} />
            </GenRow>
            <GenRow label="Include broken files" hint="Adds invalid files to confirm that validation rejects them.">
              <Switch aria-label="Include broken files" checked={gen.broken} onCheckedChange={(c) => setGen({ ...gen, broken: c })} />
            </GenRow>
          </div>
        </TabsPanel>

        <TabsPanel value="internet-archive">
          <CataloguePanel
            source="internet-archive"
            picked={picked["internet-archive"]}
            onPick={(ids) => setPicked((p) => ({ ...p, "internet-archive": ids }))}
            hint="Results are albums or sessions. Each one imports all its tracks, up to 30."
          />
        </TabsPanel>
        <TabsPanel value="jamendo">
          {integrations.jamendoConnected ? (
            <CataloguePanel source="jamendo" picked={picked.jamendo} onPick={(ids) => setPicked((p) => ({ ...p, jamendo: ids }))} />
          ) : (
            <div className="host-empty">
              <p>Connect Jamendo first.</p>
              <span className="r-label">Add a free client ID under Settings › Import sources.</span>
            </div>
          )}
        </TabsPanel>
      </TabsRoot>
    </Dialog>
  );
}

function GenRow({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="host-gen__row">
      <div>
        <div className="host-gen__label">{label}</div>
        <div className="r-label">{hint}</div>
      </div>
      {children}
    </div>
  );
}

function CataloguePanel({
  source,
  picked,
  onPick,
  hint,
}: {
  source: CatalogueSource;
  picked: string[];
  onPick: (ids: string[]) => void;
  hint?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogueResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResults(await api<CatalogueResult[]>("GET", `/catalogue/${source}/search?q=${encodeURIComponent(query.trim())}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) => onPick(picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id]);

  return (
    <div className="host-catalogue">
      <form className="host-toolbar" onSubmit={(e) => void search(e)}>
        <TextField
          aria-label={`Search ${source}`}
          type="search"
          value={query}
          onValueChange={setQuery}
          placeholder="Search by artist, album, genre…"
          leading={<SearchIcon />}
          className="host-toolbar__search"
        />
        <Button size="sm" variant="outline" type="submit" disabled={busy || !query.trim()}>
          {busy ? "Searching…" : "Search"}
        </Button>
      </form>
      {error && <p className="host-error">{error}</p>}
      {results && results.length === 0 && <div className="host-empty">No openly licensed results.</div>}
      {results && results.length > 0 && (
        <ul className="host-results">
          {results.map((r) => {
            const on = picked.includes(r.id);
            return (
              <li key={r.id}>
                <label className="host-result" data-selected={on ? "" : undefined}>
                  <input type="checkbox" checked={on} onChange={() => toggle(r.id)} />
                  {r.imageUrl ? <img className="host-result__img" src={r.imageUrl} alt="" loading="lazy" /> : null}
                  <span className="host-queue__meta">
                    <span className="host-queue__title">{r.title}</span>
                    <span className="host-queue__artist">
                      {r.artist}
                      {r.album ? ` · ${r.album}` : ""}
                      {r.isCollection ? " · collection" : ""}
                    </span>
                  </span>
                  <a className="r-label host-result__link" href={r.pageUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                    Source
                  </a>
                  <a href={r.licenceUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                    <Badge tone={r.nonCommercial ? "warning" : "success"}>{r.licence}</Badge>
                  </a>
                  {r.durationSec != null && <span className="r-label r-tnum">{formatDuration(r.durationSec)}</span>}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <p className="host-hint">
        Only Creative Commons and public-domain items are listed. NC (non-commercial) licences are flagged: check they
        suit your station. Each track keeps its licence and source link, shown to listeners as a credit.
        {hint ? ` ${hint}` : ""}
      </p>
    </div>
  );
}

const ACCEPT = "audio/mpeg,audio/flac,audio/ogg,audio/wav,audio/x-wav,audio/aac,audio/mp4,.mp3,.flac,.ogg,.opus,.wav,.m4a";

function FilesPanel({
  files,
  setFiles,
  kind,
  setKind,
}: {
  files: File[];
  setFiles: (f: File[]) => void;
  kind: Track["kind"];
  setKind: (k: Track["kind"]) => void;
}) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const add = (list: FileList | null) => {
    if (!list) return;
    const audio = Array.from(list).filter((f) => f.type.startsWith("audio/") || /\.(mp3|flac|ogg|opus|wav|m4a)$/i.test(f.name));
    setFiles([...files, ...audio]);
  };

  return (
    <div className="host-files">
      <div className="host-files__kind">
        <span className="r-label">Import as</span>
        <SegmentedControl
          size="sm"
          aria-label="Import as"
          value={kind}
          onValueChange={setKind}
          options={[
            { value: "music", label: "Music" },
            { value: "jingle", label: "Jingles" },
          ]}
        />
      </div>
      <div
        className="host-drop"
        data-over={over ? "" : undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          add(e.dataTransfer.files);
        }}
      >
        <UploadIcon />
        <strong>Drop audio files here</strong>
        <span className="r-label">MP3, FLAC, Ogg/Opus, WAV, M4A</span>
        <div className="host-drop__actions">
          <Button size="sm" variant="outline" onClick={() => input.current?.click()}>
            <FileAudioIcon /> Choose files
          </Button>
          <Button size="sm" variant="ghost" onClick={() => folder.current?.click()}>
            <FolderIcon /> Choose folder
          </Button>
        </div>
        <input ref={input} type="file" multiple accept={ACCEPT} hidden onChange={(e) => add(e.target.files)} />
        <input
          ref={folder}
          type="file"
          multiple
          hidden
          onChange={(e) => add(e.target.files)}
          {...({ webkitdirectory: "" } as Record<string, string>)}
        />
      </div>
      {files.length > 0 && (
        <ul className="host-filelist">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="host-filelist__item">
              <FileAudioIcon />
              <span className="host-filelist__name">{f.name}</span>
              <span className="r-label r-tnum">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
              <Button size="sm" variant="ghost" iconOnly aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                <TrashIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
