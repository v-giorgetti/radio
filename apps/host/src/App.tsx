import {
  Button,
  ConnectionIcon,
  DashboardIcon,
  JingleIcon,
  LibraryIcon,
  LockIcon,
  OnAirSince,
  QueueIcon,
  SettingsIcon,
  StationTheme,
  Surface,
  TextField,
  TooltipProvider,
  transition,
  WarningIcon,
} from "@station/ui";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState, type ComponentType, type FormEvent } from "react";
import { api, upload } from "./api";
import type { Track } from "./data";
import { predict, type StationSim } from "./sim";
import { useStation, type ServerJob } from "./store";
import { ImportDialog, type ImportRequest } from "./views/ImportDialog";
import { JinglesView } from "./views/Jingles";
import { LibraryView } from "./views/Library";
import { LiveView } from "./views/Live";
import { PlaylistsView } from "./views/Playlists";
import { SettingsView, StationMark } from "./views/Settings";

type ViewId = "live" | "library" | "jingles" | "playlists" | "settings";

const nav: Array<{ id: ViewId; label: string; Icon: ComponentType }> = [
  { id: "live", label: "Live", Icon: DashboardIcon },
  { id: "library", label: "Library", Icon: LibraryIcon },
  { id: "jingles", label: "Jingles", Icon: JingleIcon },
  { id: "playlists", label: "Playlists", Icon: QueueIcon },
  { id: "settings", label: "Settings", Icon: SettingsIcon },
];

/** An upload in progress in this browser (server jobs come from the snapshot). */
export type LocalJob = ServerJob & { progress: number };

export function App() {
  const station = useStation();
  const { state } = station;

  if (station.connection === "signed-out") {
    return (
      <StationTheme className="host-auth">
        <SignIn onSignIn={station.signIn} />
      </StationTheme>
    );
  }
  if (!state) {
    return (
      <StationTheme className="host-auth">
        <p className="r-label">{station.connection === "reconnecting" ? "Can't reach the station server. Retrying…" : "Loading…"}</p>
      </StationTheme>
    );
  }
  return <Dashboard station={station} />;
}

function Dashboard({ station }: { station: ReturnType<typeof useStation> }) {
  const state = station.state!;
  const [view, setView] = useState<ViewId>("live");
  const [importOpen, setImportOpen] = useState(false);
  const [importPreset, setImportPreset] = useState<{ source?: string; kind?: Track["kind"] }>({});
  const [localJobs, setLocalJobs] = useState<LocalJob[]>([]);

  const sim: StationSim = useMemo(() => {
    const viewState = { ...state, elapsed: station.elapsed };
    const byId = (id: string) => state.tracks.find((t) => t.id === id);
    return {
      state: viewState,
      dispatch: station.dispatch,
      current: station.current,
      prediction: predict(viewState, byId),
      trackById: station.trackById,
      fallback: station.fallback,
      error: station.error,
    };
  }, [state, station.elapsed, station.dispatch, station.current, station.trackById, station.fallback, station.error]);

  const openImport = (preset: typeof importPreset = {}) => {
    setImportPreset(preset);
    setImportOpen(true);
  };

  const startImport = async (req: ImportRequest) => {
    setImportOpen(false);
    setView("library");
    if (req.kind === "generate" || req.kind === "catalogue") {
      try {
        // Progress arrives via the live state stream.
        if (req.kind === "generate") await api("POST", "/import/test-library", req.body);
        else await api("POST", "/import/catalogue", { source: req.source, ids: req.ids });
      } catch (e) {
        const reason = e instanceof Error ? e.message : "failed";
        setLocalJobs((j) => [
          { id: `local-${Date.now()}`, source: req.kind === "generate" ? "test-library" : req.source, label: "Import", total: 1, done: 1, imported: 0, rejected: [{ name: "Request", reason }], finished: true, progress: 1 },
          ...j,
        ]);
      }
      return;
    }
    const id = `local-${Date.now()}`;
    const job: LocalJob = {
      id,
      source: "files",
      label: `${req.files.length} file${req.files.length === 1 ? "" : "s"}`,
      total: req.files.length,
      done: 0,
      imported: 0,
      rejected: [],
      finished: false,
      progress: 0,
    };
    setLocalJobs((j) => [job, ...j]);
    const update = (patch: Partial<LocalJob>) => setLocalJobs((jobs) => jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)));
    const form = new FormData();
    form.append("kind", req.fileKind);
    for (const f of req.files) form.append("files", f, f.name);
    try {
      const result = await upload<{ imported: string[]; rejected: { name: string; reason: string }[] }>("/tracks", form, (p) =>
        update({ progress: p }),
      );
      update({ done: req.files.length, imported: result.imported.length, rejected: result.rejected, finished: true, progress: 1 });
    } catch (e) {
      update({
        finished: true,
        done: req.files.length,
        rejected: [{ name: "Upload", reason: e instanceof Error ? e.message : "failed" }],
      });
    }
    void station.refresh();
  };

  const jobs: LocalJob[] = [...localJobs, ...state.jobs.map((j) => ({ ...j, progress: j.done / Math.max(1, j.total) }))];

  return (
    <StationTheme className="host" accent={state.settings.accent}>
      <TooltipProvider delay={400}>
        <aside className="host-nav">
          <div className="host-brand">
            <StationMark logoUrl={state.settings.logoUrl} name={state.settings.name} accent={state.settings.accent} />
            <div>
              <div className="host-brand__name">{state.settings.name}</div>
              <OnAirSince since={state.onAirSince} />
            </div>
          </div>
          <nav aria-label="Host sections">
            <ul className="host-nav__list">
              {nav.map(({ id, label, Icon }) => (
                <li key={id}>
                  <button className="host-nav__item" aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}>
                    {view === id && (
                      <motion.span layoutId="host-nav-active" className="host-nav__active" transition={transition.panel} />
                    )}
                    <Icon />
                    <span>{label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div className="host-nav__footer">
            <Button size="sm" variant="ghost" onClick={() => void station.signOut()}>
              Sign out
            </Button>
          </div>
        </aside>

        <main className="host-main">
          <AnimatePresence>
            {station.connection === "reconnecting" && (
              <motion.div className="host-banner" {...banner}>
                <ConnectionIcon size={16} /> Connection to the station server lost. Reconnecting…
              </motion.div>
            )}
            {station.error && (
              <motion.div className="host-banner" data-tone="danger" {...banner}>
                <WarningIcon size={16} /> {station.error}
                <Button size="sm" variant="ghost" onClick={station.clearError}>
                  Dismiss
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={view}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={transition.panel}
            >
              {view === "live" && <LiveView sim={sim} />}
              {view === "library" && <LibraryView sim={sim} jobs={jobs} onImport={() => openImport()} />}
              {view === "playlists" && <PlaylistsView sim={sim} />}
              {view === "settings" && <SettingsView sim={sim} onSaved={() => void station.refresh()} />}
              {view === "jingles" && <JinglesView sim={sim} onAddJingle={() => openImport({ source: "files", kind: "jingle" })} />}
            </motion.div>
          </AnimatePresence>
        </main>

        <ImportDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          preset={importPreset}
          integrations={state.settings.integrations}
          onImport={(req) => void startImport(req)}
        />
      </TooltipProvider>
    </StationTheme>
  );
}

const banner = {
  initial: { opacity: 0, height: 0 },
  animate: { opacity: 1, height: "auto" },
  exit: { opacity: 0, height: 0 },
  transition: transition.panel,
};

function SignIn({ onSignIn }: { onSignIn: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSignIn(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
      setPassword("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={transition.content}>
      <Surface elevation="raised" className="host-signin">
        <span className="ls-gate__icon host-signin__icon">
          <LockIcon />
        </span>
        <h1 className="host-signin__title">Host sign-in</h1>
        <p className="host-hint">Enter the station's host password.</p>
        <form onSubmit={submit} className="host-signin__form">
          <TextField label="Password" type="password" value={password} onValueChange={setPassword} />
          {error && (
            <p className="host-error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" variant="accent" disabled={!password || busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Surface>
    </motion.div>
  );
}
