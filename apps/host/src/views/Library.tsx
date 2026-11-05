import {
  Artwork,
  Badge,
  Button,
  CheckCircleIcon,
  Dialog,
  TrashIcon,
  PlusIcon,
  ProgressBar,
  SearchIcon,
  SegmentedControl,
  Surface,
  TextField,
  Tooltip,
  UploadIcon,
  WarningIcon,
  transition,
} from "@station/ui";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { formatDuration, sourceLabel, type Track } from "../data";
import type { LocalJob } from "../App";
import type { StationSim } from "../sim";

type Filter = "all" | "music" | "jingle";

export function LibraryView({ sim, jobs, onImport }: { sim: StationSim; jobs: LocalJob[]; onImport: () => void }) {
  const { state, dispatch } = sim;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [confirm, setConfirm] = useState<Track | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return state.tracks
      .filter((t) => filter === "all" || t.kind === filter)
      .filter((t) => !q || [t.title, ...t.artists, t.album ?? ""].some((s) => s.toLowerCase().includes(q))); // newest first (server order)
  }, [state.tracks, query, filter]);

  return (
    <div className="host-page">
      <header className="host-page__header">
        <div>
          <h1 className="host-h1">Library</h1>
          <p className="host-sub">
            {state.tracks.filter((t) => t.kind === "music").length} tracks ·{" "}
            {state.tracks.filter((t) => t.kind === "jingle").length} jingles
          </p>
        </div>
        <Button variant="accent" onClick={onImport}>
          <UploadIcon />
          Import
        </Button>
      </header>

      <AnimatePresence initial={false}>
        {jobs.length > 0 && (
          <motion.div
            className="host-jobs"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            transition={transition.panel}
          >
            {jobs.slice(0, 3).map((job) => (
              <Surface key={job.id} className="host-job">
                <div className="host-job__row">
                  {job.finished ? <CheckCircleIcon className="host-job__ok" /> : <UploadIcon />}
                  <span className="host-job__label">{job.label}</span>
                  <Badge>{sourceLabel[job.source] ?? job.source}</Badge>
                  <span className="r-label r-tnum host-job__count">
                    {!job.finished && job.source === "files"
                      ? `Uploading ${Math.round(job.progress * 100)}%`
                      : `${job.imported} / ${job.total} imported`}
                  </span>
                  {job.rejected.length > 0 && (
                    <Badge tone="danger">
                      <WarningIcon size={12} /> {job.rejected.length} rejected
                    </Badge>
                  )}
                </div>
                {!job.finished && <ProgressBar aria-label={`${job.label} progress`} value={job.progress * 100} />}
                {job.rejected.length > 0 && (
                  <details className="host-job__rejected">
                    <summary className="r-label">Why were files rejected?</summary>
                    <ul>
                      {job.rejected.map((r, i) => (
                        <li key={i}>
                          <strong>{r.name}</strong> — {r.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </Surface>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <Surface className="host-card host-table-card">
        <div className="host-toolbar">
          <TextField
            aria-label="Search library"
            type="search"
            value={query}
            onValueChange={setQuery}
            placeholder="Search title, artist or album"
            leading={<SearchIcon />}
            className="host-toolbar__search"
          />
          <SegmentedControl
            aria-label="Filter by type"
            value={filter}
            onValueChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "music", label: "Music" },
              { value: "jingle", label: "Jingles" },
            ]}
          />
        </div>
        <div className="host-table" role="table" aria-label="Library">
          <div className="host-table__head" role="row">
            <span role="columnheader">Title</span>
            <span role="columnheader">Album</span>
            <span role="columnheader">Source</span>
            <span role="columnheader" className="host-table__num">
              Length
            </span>
            <span role="columnheader" aria-label="Actions" />
          </div>
          <AnimatePresence initial={false}>
            {rows.map((t) => (
              <motion.div
                layout="position"
                key={t.id}
                role="row"
                className="host-table__row"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={transition.panel}
              >
                <span role="cell" className="host-table__title">
                  <Artwork src={t.artworkUrl} className="host-table__art" />
                  <span className="host-table__meta">
                    <span className="host-queue__title">{t.title}</span>
                    <span className="host-queue__artist">{t.artists.join(", ") || (t.kind === "jingle" ? "Jingle" : "Unknown artist")}</span>
                  </span>
                </span>
                <span role="cell" className="host-table__album">{t.album ?? "—"}</span>
                <span role="cell" className="host-table__source">
                  <Badge>{sourceLabel[t.source]}</Badge>
                  {t.licence &&
                    (t.attributionUrl ? (
                      <a href={t.attributionUrl} target="_blank" rel="noreferrer" title="Open source page">
                        <Badge tone={t.licence.includes("NC") ? "warning" : "success"}>{t.licence}</Badge>
                      </a>
                    ) : (
                      <Badge tone={t.licence.includes("NC") ? "warning" : "success"}>{t.licence}</Badge>
                    ))}
                </span>
                <span role="cell" className="host-table__num r-tnum">{formatDuration(t.durationSec)}</span>
                <span role="cell" className="host-table__actions">
                  {t.kind === "music" ? (
                    <Tooltip content={state.queue.includes(t.id) ? "Already queued" : "Add to queue"}>
                      <Button
                        size="sm"
                        variant="ghost"
                        iconOnly
                        aria-label={`Add ${t.title} to queue`}
                        disabled={state.queue.includes(t.id)}
                        onClick={() => dispatch({ type: "enqueue", ids: [t.id] })}
                      >
                        <PlusIcon />
                      </Button>
                    </Tooltip>
                  ) : (
                    <span className="host-table__spacer" aria-hidden />
                  )}
                  <Tooltip content={t.id === state.currentId ? "On air — can't delete now" : "Delete from library"}>
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      aria-label={`Delete ${t.title}`}
                      disabled={t.id === state.currentId}
                      onClick={() => setConfirm(t)}
                    >
                      <TrashIcon />
                    </Button>
                  </Tooltip>
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
          {rows.length === 0 && <div className="host-empty">No matches.</div>}
        </div>
      </Surface>
      <Dialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Delete “${confirm?.title ?? ""}”?`}
        description="The file is removed from the server, and the track is taken out of the queue, playlists and jingle schedule."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (confirm) void dispatch({ type: "deleteTrack", id: confirm.id }).catch(() => {});
                setConfirm(null);
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="host-hint">This can't be undone.</p>
      </Dialog>
    </div>
  );
}
