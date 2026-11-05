import {
  Badge,
  Button,
  CheckCircleIcon,
  flatEq,
  InfoIcon,
  Player,
  SegmentedControl,
  StationTheme,
  Surface,
  Switch,
  TextField,
  transition,
  UploadIcon,
  WarningIcon,
} from "@station/ui";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { upload, api } from "../api";
import { bitratesFor, type StationSettings } from "../data";
import type { StationSim } from "../sim";

const accents = ["#2b59ff", "#e4572e", "#1f8a70", "#7a4cff", "#141414", "#c2410c", "#0e7490"];
const HEX = /^#[\da-f]{6}$/i;

const sections = [
  { id: "identity", label: "Station identity" },
  { id: "access", label: "Listener access" },
  { id: "stream", label: "Stream" },
  { id: "sources", label: "Import sources" },
  { id: "privacy", label: "Privacy" },
  { id: "account", label: "Host account" },
] as const;


function newAccessCode() {
  const words = ["LANTERN", "HARBOUR", "COPPER", "MERIDIAN", "WREN", "TIDE", "SIGNAL"];
  const word = words[Math.floor(Math.random() * words.length)];
  return `${word}-${String(Math.floor(1000 + Math.random() * 9000))}`;
}

export function SettingsView({ sim, onSaved }: { sim: StationSim; onSaved: () => void }) {
  const saved = sim.state.settings;
  const [draft, setDraft] = useState<StationSettings>(saved);
  const [justSaved, setJustSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);

  // Logos save immediately (separate endpoint), so keep the draft in sync.
  useEffect(() => setDraft((d) => ({ ...d, logoUrl: saved.logoUrl })), [saved.logoUrl]);

  const changeLogo = async (file: File | null) => {
    setLogoError(null);
    try {
      if (file) {
        const form = new FormData();
        form.append("file", file);
        await upload("/logo", form);
      } else {
        await api("DELETE", "/logo");
      }
      onSaved();
    } catch (e) {
      setLogoError(e instanceof Error ? e.message : "Logo upload failed");
    }
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await sim.dispatch({ type: "saveSettings", settings: { ...draft, name: draft.name.trim() } });
      setDraft({ ...draft, name: draft.name.trim(), accessCode: draft.accessCode.trim().toUpperCase() });
      setJustSaved(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Saving failed");
    } finally {
      setSaving(false);
    }
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = (patch: Partial<StationSettings>) => setDraft((d) => ({ ...d, ...patch }));
  const setIntegrations = (patch: Partial<StationSettings["integrations"]>) =>
    setDraft((d) => ({ ...d, integrations: { ...d.integrations, ...patch } }));

  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), 1800);
    return () => clearTimeout(t);
  }, [justSaved]);

  const accentValid = HEX.test(draft.accent);
  const nameValid = draft.name.trim().length > 0;
  const formatChanged =
    draft.streamFormat !== saved.streamFormat ||
    draft.bitrate !== saved.bitrate ||
    draft.access !== saved.access ||
    (draft.access === "private" && draft.accessCode.trim().toUpperCase() !== saved.accessCode);

  return (
    <div className="host-page">
      <header className="host-page__header">
        <div>
          <h1 className="host-h1">Settings</h1>
          <p className="host-sub">Changes apply when you save. Branding never affects the queue or broadcast.</p>
        </div>
      </header>

      <div className="host-settings">
        <nav className="host-settings__nav" aria-label="Settings sections">
          {sections.map((s) => (
            <a key={s.id} href={`#settings-${s.id}`} className="host-settings__link">
              {s.label}
            </a>
          ))}
        </nav>

        <div className="host-settings__body">
          <Section id="identity" title="Station identity" description="Shown on the listener page and in this dashboard.">
            <div className="host-identity">
              <div className="host-identity__fields">
                <TextField label="Station name" value={draft.name} onValueChange={(name) => set({ name })} />
                {!nameValid && <span className="host-error">A station name is required.</span>}
                <TextField
                  label="Description"
                  value={draft.description}
                  onValueChange={(description) => set({ description })}
                  description="One line under the name on the listener page."
                />
                <TextField
                  label="Jingle message"
                  value={draft.jingleMessage}
                  onValueChange={(jingleMessage) => set({ jingleMessage })}
                  description={`Listeners see this while a jingle plays, instead of the jingle's file name. {station} becomes "${draft.name || "your station name"}".`}
                />
                <LogoField value={draft.logoUrl} name={draft.name} accent={draft.accent} onChange={(f) => void changeLogo(f)} error={logoError} />
                <div className="r-field">
                  <span className="r-field__label">Accent colour</span>
                  <div className="host-accent">
                    <div className="host-accent__swatches" role="radiogroup" aria-label="Accent presets">
                      {accents.map((c) => (
                        <button
                          key={c}
                          role="radio"
                          aria-checked={draft.accent.toLowerCase() === c}
                          aria-label={c}
                          className="host-swatch"
                          style={{ background: c }}
                          onClick={() => set({ accent: c })}
                        />
                      ))}
                    </div>
                    <TextField aria-label="Accent hex value" value={draft.accent} onValueChange={(accent) => set({ accent })} className="host-accent__hex" />
                  </div>
                  {!accentValid && <span className="host-error">Use a 6-digit hex colour, e.g. #2b59ff.</span>}
                </div>
              </div>
              <ListenerPreview settings={draft} sim={sim} />
            </div>
          </Section>

          <Section id="access" title="Listener access" description="Private mode protects the audio stream itself, not just the page.">
            <SegmentedControl
              aria-label="Listener access"
              value={draft.access}
              onValueChange={(access) => set({ access })}
              options={[
                { value: "public", label: "Public" },
                { value: "private", label: "Private" },
              ]}
            />
            <AnimatePresence initial={false} mode="wait">
              {draft.access === "public" ? (
                <motion.p key="pub" className="host-hint" {...fade}>
                  Anyone with the station address can listen.
                </motion.p>
              ) : (
                <motion.div key="priv" className="host-access" {...fade}>
                  <div className="host-access__row">
                    <div>
                      <span className="r-field__label">Access code</span>
                      <code className="host-code">{draft.accessCode}</code>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => set({ accessCode: newAccessCode() })}>
                      Generate new code
                    </Button>
                  </div>
                  <p className="host-hint">
                    Listeners enter this code before the stream starts. A new code disconnects listeners using the old
                    one when you save.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </Section>

          <Section id="stream" title="Stream" description="Encoded once on the server and shared by every listener.">
            <div className="host-stream">
              <div className="r-field">
                <span className="r-field__label">Format</span>
                <SegmentedControl
                  aria-label="Stream format"
                  value={draft.streamFormat}
                  onValueChange={(streamFormat) => {
                    const allowed = bitratesFor[streamFormat];
                    set({ streamFormat, bitrate: allowed.includes(draft.bitrate) ? draft.bitrate : 128 });
                  }}
                  options={[
                    { value: "opus", label: "Opus" },
                    { value: "mp3", label: "MP3" },
                    { value: "aac", label: "AAC" },
                  ]}
                />
              </div>
              <div className="r-field">
                <span className="r-field__label">Bitrate</span>
                <SegmentedControl
                  aria-label="Bitrate"
                  value={String(draft.bitrate)}
                  onValueChange={(v) => set({ bitrate: Number(v) })}
                  options={bitratesFor[draft.streamFormat].map((b) => ({ value: String(b), label: `${b} kbps` }))}
                />
              </div>
            </div>
            <p className="host-hint">
              {draft.streamFormat === "opus"
                ? "Opus sounds best at low bitrates and plays in all current browsers. Older stream players may not support it."
                : draft.streamFormat === "mp3"
                  ? "MP3 has the widest compatibility, including older devices and stream players."
                  : "AAC sounds better than MP3 at the same bitrate and is widely supported, especially on Apple devices."}
            </p>
            <div className="r-field">
              <span className="r-field__label">Transitions</span>
              <SegmentedControl
                aria-label="Crossfade between tracks"
                value={String(draft.crossfadeMs)}
                onValueChange={(v) => set({ crossfadeMs: Number(v) })}
                options={[0, 2000, 3000, 4000, 6000].map((ms) => ({ value: String(ms), label: ms ? `${ms / 1000} s` : "Cut" }))}
              />
              <span className="r-field__description">
                Songs overlap with an equal-power crossfade; silence at the start and end of each file is trimmed first.
                Around jingles the fade is at most 1 s so idents stay clear. Skip always fades out quickly.
              </span>
            </div>
            <label className="host-pl-option">
              <Switch
                aria-label="Normalise loudness"
                checked={draft.normalizeLoudness}
                onCheckedChange={(normalizeLoudness) => set({ normalizeLoudness })}
              />
              <span>
                <span className="host-gen__label">Even out loudness</span>
                <span className="r-label">
                  Each track is measured at import (EBU R128) and played at about −16 LUFS, without pushing peaks above
                  −1 dB. Applies from the next track.
                </span>
              </span>
            </label>
            <AnimatePresence initial={false}>
              {formatChanged && (
                <motion.div className="host-notice" data-tone="warning" {...fade}>
                  <WarningIcon size={16} /> Saving restarts the stream and disconnects current listeners. They reconnect
                  automatically{draft.access === "private" ? " if they have the new code" : ""}.
                </motion.div>
              )}
            </AnimatePresence>
          </Section>

          <Section id="sources" title="Import sources" description="Choose which sources appear in the Import dialog. Files is always available.">
            <ul className="host-sources">
              <SourceRow name="Files" note="Upload files or folders from your computer." badge={<Badge>Always on</Badge>} />
              <SourceRow
                name="Test library"
                note="Synthetic tracks and jingles for testing."
                control={<Switch aria-label="Enable Test library" checked={draft.integrations.testLibrary} onCheckedChange={(testLibrary) => setIntegrations({ testLibrary })} />}
              />
              <SourceRow
                name="Internet Archive"
                note="Netlabels, public-domain and CC-licensed collections. No key needed."
                control={
                  <Switch
                    aria-label="Enable Internet Archive"
                    checked={draft.integrations.internetArchive}
                    onCheckedChange={(internetArchive) => setIntegrations({ internetArchive })}
                  />
                }
              />
              <SourceRow
                name="Jamendo"
                note="Creative Commons music. Needs a free client ID from devportal.jamendo.com."
                badge={draft.integrations.jamendoConnected ? <Badge tone="success">Connected</Badge> : <Badge tone="warning">Needs key</Badge>}
                control={
                  <Switch aria-label="Enable Jamendo" checked={draft.integrations.jamendo} onCheckedChange={(jamendo) => setIntegrations({ jamendo })} />
                }
              >
                {draft.integrations.jamendo && <JamendoKey connected={saved.integrations.jamendoConnected} onChanged={onSaved} />}
              </SourceRow>
            </ul>
          </Section>

          <Section id="privacy" title="Privacy" description="Proposed default for listener data.">
            <div className="host-notice">
              <InfoIcon size={16} />
              <span>
                The listener count is the number of open audio connections. The station doesn't keep listener IP
                addresses, identifiers or listening history, and the listener page sets no tracking cookies.
              </span>
            </div>
          </Section>

          <Section id="account" title="Host account" description="The password protects this dashboard. Changing it signs out every other session.">
            <AccountSettings />
          </Section>
        </div>
      </div>

      <AnimatePresence>
        {(dirty || justSaved) && (
          <motion.div
            className="host-savebar"
            role="status"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={transition.panel}
          >
            {justSaved && !dirty ? (
              <span className="host-savebar__text">
                <CheckCircleIcon size={16} /> Settings saved
              </span>
            ) : (
              <>
                <span className="host-savebar__text">{saveError ?? "Unsaved changes"}</span>
                <Button size="sm" variant="ghost" onClick={() => setDraft(saved)}>
                  Discard
                </Button>
                <Button size="sm" variant="accent" disabled={!accentValid || !nameValid || saving} onClick={() => void save()}>
                  Save changes
                </Button>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const fade = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: transition.panel,
};

function Section({ id, title, description, children }: { id: string; title: string; description: string; children: ReactNode }) {
  return (
    <Surface className="host-card host-settings__section" id={`settings-${id}`}>
      <div>
        <h2 className="host-h2">{title}</h2>
        <p className="host-hint">{description}</p>
      </div>
      {children}
    </Surface>
  );
}

function SourceRow({
  name,
  note,
  badge,
  control,
  children,
}: {
  name: string;
  note: string;
  badge?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="host-source">
      <div className="host-source__row">
        <div className="host-source__text">
          <span className="host-gen__label">{name}</span>
          <span className="r-label">{note}</span>
        </div>
        {badge}
        {control}
      </div>
      {children && <div className="host-source__extra">{children}</div>}
    </li>
  );
}

function LogoField({
  value,
  name,
  accent,
  onChange,
  error,
}: {
  value: string | null;
  name: string;
  accent: string;
  onChange: (file: File | null) => void;
  error: string | null;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="r-field">
      <span className="r-field__label">Logo</span>
      <div className="host-logo">
        <StationMark logoUrl={value} name={name} accent={accent} size={48} />
        <Button size="sm" variant="outline" onClick={() => input.current?.click()}>
          <UploadIcon /> Upload
        </Button>
        {value && (
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            Remove
          </Button>
        )}
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onChange(file);
            e.target.value = "";
          }}
        />
      </div>
      {error && <span className="host-error">{error}</span>}
      <span className="r-field__description">
        PNG, JPEG or WebP, up to 5 MB. Saved immediately and cropped to a square. Without one, the first letter of the name is used.
      </span>
    </div>
  );
}

export function StationMark({ logoUrl, name, accent, size = 32 }: { logoUrl: string | null; name: string; accent: string; size?: number }) {
  return (
    <span className="host-mark" style={{ width: size, height: size, background: logoUrl ? undefined : accent, fontSize: size * 0.45 }} aria-hidden>
      {logoUrl ? <img src={logoUrl} alt="" /> : (name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

function ListenerPreview({ settings, sim }: { settings: StationSettings; sim: StationSim }) {
  const current = sim.current;
  const item = useMemo(
    () =>
      current
        ? { id: String(sim.state.playCount), kind: current.kind, title: current.title, artists: current.artists, album: current.album, artworkUrl: current.artworkUrl }
        : null,
    [current, sim.state.playCount],
  );
  return (
    <div className="host-preview">
      <span className="r-label">Listener page preview</span>
      <StationTheme accent={HEX.test(settings.accent) ? settings.accent : undefined} className="host-preview__frame">
        <div className="host-preview__brand">
          <StationMark logoUrl={settings.logoUrl} name={settings.name} accent={settings.accent} size={28} />
          <div>
            <div className="host-brand__name">{settings.name || "Station name"}</div>
            <div className="r-label">{settings.description}</div>
          </div>
        </div>
        <Player
          stationName={settings.name}
          onAirSince={sim.state.onAirSince}
          listeners={sim.state.listeners}
          item={item}
          status="stopped"
          onListenChange={() => {}}
          volume={0.8}
          muted={false}
          onVolumeChange={() => {}}
          onMutedChange={() => {}}
          eq={flatEq}
          onEqChange={() => {}}
        />
        {settings.access === "private" && <span className="r-label host-preview__lock">Private: listeners are asked for the access code</span>}
      </StationTheme>
    </div>
  );
}

function JamendoKey({ connected, onChanged }: { connected: boolean; onChanged: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (clientId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api("PUT", "/integrations/jamendo", { clientId });
      setValue("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the client ID");
    } finally {
      setBusy(false);
    }
  };
  if (connected) {
    return (
      <div className="host-account__actions">
        <span className="r-label">A client ID is saved on the server.</span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save("")}>
          Disconnect
        </Button>
      </div>
    );
  }
  return (
    <div className="host-account">
      <TextField
        label="Client ID"
        type="password"
        value={value}
        onValueChange={setValue}
        description="Checked with Jamendo, then stored on the server. It's never sent to listeners."
      />
      {error && <span className="host-error">{error}</span>}
      <div className="host-account__actions">
        <Button size="sm" variant="outline" disabled={!value.trim() || busy} onClick={() => void save(value.trim())}>
          {busy ? "Checking…" : "Connect"}
        </Button>
      </div>
    </div>
  );
}

function AccountSettings() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const tooShort = next.length > 0 && next.length < 12;
  const mismatch = confirm.length > 0 && confirm !== next;

  const change = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<{ signedOutOthers: number }>("POST", "/password", { currentPassword: current, newPassword: next });
      setCurrent("");
      setNext("");
      setConfirm("");
      setMessage({
        tone: "ok",
        text: `Password changed.${r.signedOutOthers ? ` Signed out ${r.signedOutOthers} other session${r.signedOutOthers === 1 ? "" : "s"}.` : ""}`,
      });
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : "Couldn't change the password" });
    } finally {
      setBusy(false);
    }
  };

  const signOutOthers = async () => {
    setMessage(null);
    try {
      const r = await api<{ signedOutOthers: number }>("POST", "/sessions/revoke-others");
      setMessage({ tone: "ok", text: r.signedOutOthers ? `Signed out ${r.signedOutOthers} other session${r.signedOutOthers === 1 ? "" : "s"}.` : "No other sessions were signed in." });
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : "Couldn't sign out other sessions" });
    }
  };

  return (
    <div className="host-account">
      <TextField label="Current password" type="password" value={current} onValueChange={setCurrent} />
      <TextField label="New password" type="password" value={next} onValueChange={setNext} description="At least 12 characters. A passphrase of several words works well." />
      {tooShort && <span className="host-error">Use at least 12 characters.</span>}
      <TextField label="Confirm new password" type="password" value={confirm} onValueChange={setConfirm} />
      {mismatch && <span className="host-error">The passwords don't match.</span>}
      {message && <span className={message.tone === "error" ? "host-error" : "host-success"}>{message.text}</span>}
      <div className="host-account__actions">
        <Button variant="outline" disabled={busy || !current || next.length < 12 || confirm !== next} onClick={() => void change()}>
          {busy ? "Saving…" : "Update password"}
        </Button>
        <Button variant="ghost" onClick={() => void signOutOthers()}>
          Sign out other sessions
        </Button>
      </div>
    </div>
  );
}
