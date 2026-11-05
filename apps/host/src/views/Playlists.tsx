import {
  Artwork,
  Badge,
  Button,
  Dialog,
  DragHandleIcon,
  PlusIcon,
  QueueIcon,
  RepeatIcon,
  SearchIcon,
  Surface,
  Switch,
  TextField,
  Tooltip,
  TrashIcon,
  transition,
} from "@station/ui";
import { AnimatePresence, motion, Reorder, useDragControls } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDuration, type Playlist, type Track } from "../data";
import type { StationSim } from "../sim";

const totalDuration = (ids: string[], sim: StationSim) =>
  ids.reduce((sum, id) => sum + (sim.state.tracks.find((t) => t.id === id)?.durationSec ?? 0), 0);

const formatLong = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};

export function PlaylistsView({ sim }: { sim: StationSim }) {
  const { state, dispatch } = sim;
  const [selectedId, setSelectedId] = useState<string | null>(state.playlists[0]?.id ?? null);
  const selected = state.playlists.find((p) => p.id === selectedId) ?? null;

  // A just-created playlist appears after the next state refresh; don't jump away from it meanwhile.
  const justCreated = useRef<string | null>(null);
  useEffect(() => {
    if (selectedId && state.playlists.some((p) => p.id === selectedId)) {
      if (justCreated.current === selectedId) justCreated.current = null;
      return;
    }
    if (selectedId && justCreated.current === selectedId) return;
    setSelectedId(state.playlists[0]?.id ?? null);
  }, [selectedId, state.playlists]);

  const create = async () => {
    const p = (await dispatch({ type: "createPlaylist", name: `New playlist ${state.playlists.length + 1}` }).catch(
      () => null,
    )) as Playlist | null;
    if (p) {
      justCreated.current = p.id;
      setSelectedId(p.id);
    }
  };

  return (
    <div className="host-page">
      <header className="host-page__header">
        <div>
          <h1 className="host-h1">Playlists</h1>
          <p className="host-sub">
            Queue a whole playlist, or pick one to repeat automatically whenever the queue runs out.
          </p>
        </div>
        <Button variant="accent" onClick={() => void create()}>
          <PlusIcon />
          New playlist
        </Button>
      </header>

      <div className="host-playlists">
        <Surface className="host-card host-pl-list">
          <ul>
            <AnimatePresence initial={false}>
              {state.playlists.map((p) => (
                <motion.li
                  key={p.id}
                  layout="position"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -8 }}
                  transition={transition.panel}
                >
                  <button
                    className="host-pl-item"
                    aria-current={p.id === selectedId ? "true" : undefined}
                    onClick={() => setSelectedId(p.id)}
                  >
                    {p.id === selectedId && (
                      <motion.span layoutId="host-pl-active" className="host-nav__active" transition={transition.panel} />
                    )}
                    <PlaylistCover ids={p.trackIds} sim={sim} />
                    <span className="host-queue__meta">
                      <span className="host-queue__title">{p.name}</span>
                      <span className="host-queue__artist">
                        {p.trackIds.length} tracks · {formatLong(totalDuration(p.trackIds, sim))}
                      </span>
                    </span>
                    {p.id === state.fallbackPlaylistId && (
                      <Tooltip content="Plays when the queue runs out">
                        <span className="host-pl-fallback" aria-label="Fallback playlist">
                          <RepeatIcon size={16} />
                        </span>
                      </Tooltip>
                    )}
                  </button>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
          {state.playlists.length === 0 && <div className="host-empty">No playlists yet.</div>}
        </Surface>

        <AnimatePresence mode="wait" initial={false}>
          {selected ? (
            <motion.div
              key={selected.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={transition.panel}
            >
              <PlaylistDetail playlist={selected} sim={sim} />
            </motion.div>
          ) : (
            <Surface className="host-card host-empty">Create a playlist to get started.</Surface>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function PlaylistCover({ ids, sim }: { ids: string[]; sim: StationSim }) {
  const arts = ids
    .map((id) => sim.state.tracks.find((t) => t.id === id)?.artworkUrl)
    .filter(Boolean)
    .slice(0, 4) as string[];
  if (arts.length < 4) return <Artwork src={arts[0]} className="host-pl-cover" />;
  return (
    <span className="host-pl-cover host-pl-cover--grid" aria-hidden>
      {arts.map((src, i) => (
        <img key={i} src={src} alt="" />
      ))}
    </span>
  );
}

function PlaylistDetail({ playlist: p, sim }: { playlist: Playlist; sim: StationSim }) {
  const { state, dispatch } = sim;
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [queued, setQueued] = useState(false);
  const update = (patch: Partial<Playlist>) => dispatch({ type: "updatePlaylist", playlist: { ...p, ...patch } });
  const isFallback = state.fallbackPlaylistId === p.id;

  useEffect(() => {
    if (!queued) return;
    const t = setTimeout(() => setQueued(false), 1600);
    return () => clearTimeout(t);
  }, [queued]);

  return (
    <Surface className="host-card host-pl-detail">
      <div className="host-pl-head">
        <PlaylistCover ids={p.trackIds} sim={sim} />
        <div className="host-pl-head__text">
          <input
            className="host-pl-name"
            value={p.name}
            aria-label="Playlist name"
            onChange={(e) => update({ name: e.target.value })}
            onBlur={(e) => !e.target.value.trim() && update({ name: "Untitled playlist" })}
          />
          <span className="r-label">
            {p.trackIds.length} tracks · {formatLong(totalDuration(p.trackIds, sim))}
            {isFallback && " · plays when the queue runs out"}
          </span>
        </div>
        <div className="host-actions">
          <Button variant="outline" onClick={() => setAdding(true)}>
            <PlusIcon />
            Add tracks
          </Button>
          <Button
            variant="primary"
            disabled={p.trackIds.length === 0}
            onClick={() => {
              const ids = p.shuffle ? [...p.trackIds].sort(() => Math.random() - 0.5) : p.trackIds;
              dispatch({ type: "enqueue", ids });
              setQueued(true);
            }}
          >
            <QueueIcon />
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={String(queued)} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={transition.fast}>
                {queued ? "Added to queue" : "Queue all"}
              </motion.span>
            </AnimatePresence>
          </Button>
        </div>
      </div>

      <div className="host-pl-options">
        <label className="host-pl-option">
          <Switch aria-label="Use as fallback playlist" checked={isFallback} onCheckedChange={(on) => dispatch({ type: "setFallback", id: on ? p.id : null })} />
          <span>
            <span className="host-gen__label">Repeat when the queue runs out</span>
            <span className="r-label">Only one playlist can be the fallback. Without one, the station goes idle.</span>
          </span>
        </label>
        <label className="host-pl-option">
          <Switch aria-label="Shuffle" checked={p.shuffle} onCheckedChange={(shuffle) => update({ shuffle })} />
          <span>
            <span className="host-gen__label">Shuffle</span>
            <span className="r-label">Applies when queueing and when repeating as fallback.</span>
          </span>
        </label>
      </div>

      {p.trackIds.length === 0 ? (
        <div className="host-empty">
          <p>This playlist is empty.</p>
          <span className="r-label">Add tracks from the library.</span>
        </div>
      ) : (
        <Reorder.Group axis="y" values={p.trackIds} onReorder={(trackIds) => update({ trackIds })} className="host-queue">
          <AnimatePresence initial={false}>
            {p.trackIds.map((id, i) => (
              <PlaylistRow
                key={id}
                track={sim.trackById(id)}
                position={i + 1}
                onRemove={() => update({ trackIds: p.trackIds.filter((t) => t !== id) })}
              />
            ))}
          </AnimatePresence>
        </Reorder.Group>
      )}

      <div className="host-pl-footer">
        <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
          <TrashIcon />
          Delete playlist
        </Button>
      </div>

      <AddTracksDialog
        open={adding}
        onOpenChange={setAdding}
        tracks={state.tracks.filter((t) => t.kind === "music" && !p.trackIds.includes(t.id))}
        onAdd={(ids) => {
          update({ trackIds: [...p.trackIds, ...ids] });
          setAdding(false);
        }}
      />

      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${p.name}”?`}
        description={
          isFallback
            ? "This is the fallback playlist. After deleting it, the station goes idle when the queue runs out."
            : "Tracks stay in the library; only the playlist is removed."
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirmDelete(false);
                dispatch({ type: "deletePlaylist", id: p.id });
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="host-hint">Tracks already in the queue are not affected.</p>
      </Dialog>
    </Surface>
  );
}

function PlaylistRow({ track, position, onRemove }: { track: Track; position: number; onRemove: () => void }) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={track.id}
      dragListener={false}
      dragControls={controls}
      className="host-queue__item"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -12, transition: { duration: 0.2 } }}
      whileDrag={{ scale: 1.015, boxShadow: "0 14px 30px rgb(20 20 20 / 0.12)" }}
      transition={transition.panel}
    >
      <div className="host-queue__row">
        <button className="host-queue__handle" aria-label={`Reorder ${track.title}`} onPointerDown={(e) => controls.start(e)}>
          <DragHandleIcon />
        </button>
        <span className="host-queue__pos r-label r-tnum">{position}</span>
        <Artwork src={track.artworkUrl} className="host-queue__art" />
        <div className="host-queue__meta">
          <span className="host-queue__title">{track.title}</span>
          <span className="host-queue__artist">{track.artists.join(", ") || "Unknown artist"}</span>
        </div>
        {track.licence && <Badge tone={track.licence.includes("NC") ? "warning" : "success"}>{track.licence}</Badge>}
        <span className="r-label r-tnum">{formatDuration(track.durationSec)}</span>
        <Tooltip content="Remove from playlist">
          <Button size="sm" variant="ghost" iconOnly aria-label={`Remove ${track.title} from playlist`} onClick={onRemove}>
            <TrashIcon />
          </Button>
        </Tooltip>
      </div>
    </Reorder.Item>
  );
}

function AddTracksDialog({
  open,
  onOpenChange,
  tracks,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tracks: Track[];
  onAdd: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    if (open) {
      setQuery("");
      setPicked([]);
    }
  }, [open]);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tracks.filter((t) => !q || [t.title, ...t.artists, t.album ?? ""].some((s) => s.toLowerCase().includes(q)));
  }, [tracks, query]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add tracks"
      description="Pick music from the library. Tracks are added in the order you select them."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="accent" disabled={!picked.length} onClick={() => onAdd(picked)}>
            <PlusIcon />
            Add {picked.length || ""}
          </Button>
        </>
      }
    >
      <div className="host-catalogue">
        <TextField
          aria-label="Search library"
          type="search"
          value={query}
          onValueChange={setQuery}
          placeholder="Search title, artist or album"
          leading={<SearchIcon />}
        />
        <ul className="host-results">
          {results.map((t) => {
            const index = picked.indexOf(t.id);
            const on = index >= 0;
            return (
              <li key={t.id}>
                <label className="host-result" data-selected={on ? "" : undefined}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => setPicked(on ? picked.filter((id) => id !== t.id) : [...picked, t.id])}
                  />
                  <Artwork src={t.artworkUrl} className="host-queue__art" />
                  <span className="host-queue__meta">
                    <span className="host-queue__title">{t.title}</span>
                    <span className="host-queue__artist">{t.artists.join(", ") || "Unknown artist"}</span>
                  </span>
                  {on && <span className="host-pick-order r-tnum">{index + 1}</span>}
                  <span className="r-label r-tnum">{formatDuration(t.durationSec)}</span>
                </label>
              </li>
            );
          })}
          {results.length === 0 && <li className="host-empty">Every matching track is already in this playlist.</li>}
        </ul>
      </div>
    </Dialog>
  );
}
