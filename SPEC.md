# Self-hosted radio — first-version scope

Status: agreed playback requirements, Rust backend, and separate listener and host
web pages. React frontend proposed in response to the user's preference; backend
framework and deployment details are proposed below.

## Objective

Provide reusable software that lets someone host their own internet radio station,
choose its music, and insert jingles between tracks. Listeners tune into the same
ongoing broadcast using a browser.

The product is genre-neutral and adaptable to different station identities. A
station's music, name, and visual identity belong to its operator; the product's
default interface must not assume a particular genre or music community.

Success means a host can populate a playlist, configure jingle rules, and broadcast
continuously to multiple listeners without serving complete song files to browsers.

## Agreed behavior

- The host controls an ordered music queue and playlists.
- The server performs playback and broadcasts a continuous audio stream.
- A listener joining midway hears the current broadcast rather than restarting a song.
- Browsers receive and buffer the stream rather than request complete music files.
- The host can add jingles and configure each one's frequency in songs, minutes, or both.
- A due jingle waits until the current music track finishes; it does not interrupt it.
- The backend is implemented in Rust.
- A public-facing listener page and an authenticated host-facing dashboard are provided.
- Both pages show the current listener count and now-playing artwork, artist(s), and title.
- The listener page includes an audio-reactive visualizer and local bass/mid/treble
  equalizer controls. Listener tone controls do not change the station's broadcast.
- The host dashboard prioritizes current playback, the upcoming queue, listener
  count, and jingle scheduling, with a polished responsive design.
- Station identity and public presentation can be configured independently of the
  playback engine and scheduling behavior.

## Proposed branding and design scope

- Provide a neutral, polished default listener page appropriate for any music genre.
- Initial station customization covers name, description, logo, accent color, and
  light/dark appearance. Treat these as proposed settings until design review.
- Use shared semantic design tokens and reusable React components, allowing station
  themes to change presentation without duplicating playback or dashboard logic.
- Keep player controls, track metadata, and accessibility behavior consistent across
  station themes. The visualization and EQ use neutral labels and presets.
- The host dashboard uses a consistent product interface centered on operating the
  station, with station identity visible in context.
- Mockup artists, station names, slogans, and music genres are sample content, not
  product branding or restrictions on the intended audience.
- A visual page builder, arbitrary executable themes, and a theme marketplace are
  outside the first-version scope.

## Visual direction (agreed)

Reference: [staging.angelarium.org/fr](https://staging.angelarium.org/fr/), adapted
to a **light theme**. Its stylesheet was inspected directly. We borrow its restraint,
not its content or branding:

- **Typography:** a single variable sans-serif (the reference uses Manrope, a
  free OFL font that can be self-hosted). Use tight negative tracking on display text
  (about −0.03 to −0.04em) and small 11–13px labels for metadata such as “on air since”
  and the listener count. Weights sit between 450 and 550, with 800 for display text only.
- **Palette:** a near-monochrome system of five semantic tokens (ground, panel,
  control, line, text/muted). It inverts the reference's dark values (#101010 /
  #1d1d1d / #3c3c3c / #f4f4f4) into a light set. Proposed: ground #f6f6f4,
  panel #ffffff, control #ececea, line #dcdcd8, text #141414, muted #6b6b6b. The
  station accent colour is the only saturated colour.
- **Surfaces:** small radii (6–9px), hairline borders, and soft, low-opacity
  shadows. No gradients or glassy chrome.
- **Spacing:** a responsive gutter token (16 → 24 → 40px across breakpoints).

### Components: Base UI

- Use [Base UI](https://base-ui.com) (`@base-ui/react`) unstyled primitives for
  interactive parts. Slider handles volume and the bass/mid/treble controls, Popover
  the EQ panel, Toggle or Button handles Listen/Stop, and Tooltip and Dialog are used
  where needed. On the host side it also provides Menu, Select, Tabs, Field, and Toast.
- Base UI supplies accessibility and behaviour; all visuals come from our own
  token-based CSS, styled through its `data-*` state attributes.

### Motion

- **One easing everywhere:** `cubic-bezier(.16, 1, .3, 1)` (an expo-out curve, as
  in the reference), exposed as `--ease`. Durations: ~150–200ms for micro-interactions
  (hover, press, toggle), ~300–450ms for panels, and ~500–700ms for now-playing changes.
- **Base UI popups** (EQ popover, tooltips, dialogs) animate with CSS transitions on
  `[data-starting-style]` / `[data-ending-style]`, following Base UI's animation
  guide. Opacity and slight scale come from `--transform-origin`, and transitions can
  be cancelled mid-way.
- **Layout and content motion** uses the [Motion](https://motion.dev) library
  for React. It covers now-playing crossfades and slides when the track or jingle changes,
  artwork swaps, listener-count number transitions, Listen/Stop state morphs, and
  host queue reordering through layout animations.
- Animate only `transform` and `opacity`. Motion must never delay playback or
  block input.
- `prefers-reduced-motion`: replace movement with short opacity fades and freeze
  the visualizer to a static level indicator, as the reference does with
  `animation: none`/`transition: none`.

## Listener experience details

The public page follows a compact, centered player layout from the original
wireframe, with the following hierarchy:

- One compact, centered player surface.
- Top left: “on air since” station status. Proposed interpretation: the start of
  the current uninterrupted broadcast, rather than the current track's start time.
- Top right: current listener count.
- Main area: square artwork on the left; title, artist(s) (labelled “Author” in
  the sketch), and album on the right.
- Bottom left: an EQ button. Proposed behavior: opens a compact panel with local
  bass/mid/treble controls, a flat/reset option, and an accessible close control.
- Bottom right: the audio-reactive visualizer.
- Preserve this hierarchy on mobile while allowing the main row and bottom controls
  to wrap or stack. The wireframe does not define colors or require a music genre.
- Bottom left, agreed: Listen/Stop, then volume, then the EQ button, in one control
  group. The visualizer stays bottom right. Do not rely on automatic playback.

- Listener count means active audio-stream connections, not verified unique people;
  opening multiple tabs can produce multiple connections. Count audio connections,
  not page views or metadata subscriptions.
- Now-playing metadata follows both music and jingle transitions. Metadata comes
  from imported tags and host edits; missing artwork gets a clear default image,
  and missing artist/title fields get usable fallbacks. Include album metadata where
  available, as shown in the wireframe.
- Bass, mids, and treble apply locally in the browser. Include a flat/reset state,
  accessible controls, and gain handling to reduce clipping when boosting bands.
- Audio-reactive visualization derives from decoded playback audio and respects
  reduced-motion preferences; it should not pretend playback is active while stopped.
- Starting playback requires an explicit listener interaction. Resume should return
  to the current live stream rather than intentionally retain old buffered playback.
- The layout adapts to phones and desktops; playback and station state remain usable
  if optional visualization or tone processing is unavailable.

## Proposed application stack

- Backend: Rust with Axum and Tokio for the HTTP API and asynchronous coordination.
- Frontend: React with TypeScript, built using Vite into static HTML, CSS, and
  JavaScript. Rust serves the resulting assets in production; Node.js is a build
  dependency, not a production application server.
- Persistence: SQLite for station settings, library metadata, queue, playlists, and
  jingle rules. Audio files live in a persistent filesystem directory.
- Updates: Server-Sent Events (SSE) for server-to-browser station state. Host actions
  use authenticated HTTP API requests. Audio uses a separate continuous stream.
- Delivery: separate frontend entry points for the listener and host pages, so a
  listener need not load the host dashboard's management code.
- Presentation: Base UI (`@base-ui/react`, v1.x) primitives styled with shared CSS
  design tokens; Motion for React for layout and content animation; native browser
  audio playback with Web Audio for the EQ and visualizer.

The audio engine remains to be chosen with a streaming proof before implementing
the full dashboard. Rust owns the queue, jingle rules, and station lifecycle; a
dedicated media engine may handle decoding and encoding. Audio is encoded once
for the station and distributed to listeners rather than encoded per listener.

## Page responsibilities

- `/`: station identity, tune-in/stop, volume, connection status, and current-track
  artwork/artist/title/album, broadcast start status, listener count, visualizer,
  and local equalizer controls.
  Stopping a listener's player does not stop the station. Public-facing
  describes its audience; when private listening is configured, access is gated.
- `/host/`: host login and dashboard for uploads, library management, playlists,
  queue ordering, jingle rules, and station controls.
- `/api/`: Rust API. Public station information is separated from authenticated
  host operations, with authorization enforced server-side.
- `/events`: SSE station metadata, filtered to the listener's permissions. Internal
  file paths, credentials, and host-only settings are never public event fields.
- `/stream`: shared audio broadcast, subject to the station's listener access mode.

Browser buffering can create small latency differences between listeners. This
version provides a shared broadcast timeline, not sample-accurate synchronization.

## Track importers (proposed)

The host adds music and jingles through **import sources**. Every source feeds the
same server-side pipeline, so adding a source never changes validation, the scheduler
or broadcasting.

Pipeline, owned by Rust and run as persistent, resumable jobs with progress over SSE:

1. **Fetch**: the source returns candidate items: a file stream plus source metadata.
2. **Validate**: probe the audio with the media engine. Reject unreadable, truncated or
   unsupported files, and report why.
3. **Normalise**: read the tags, merge them with source metadata, and extract artwork.
4. **Deduplicate**: use a content hash, and also the source ID when one exists.
5. **Store**: write to the library with **provenance**: source, source item ID,
   licence, attribution URL and import time.

Proposed Rust boundary: an `ImportSource` trait (`describe`, `configure`, `search?`,
`fetch`). The pipeline never relies on any one source's quirks.

First-version sources:

| Source | Purpose | Rights basis |
|---|---|---|
| **Files** (default) | Upload files or folders from the host's computer | Operator confirms they hold the broadcast rights |
| **Test library** | Generate N synthetic tracks and jingles with realistic tags, optionally with broken files, to test bulk import, validation, scheduling and long-running playback | Generated audio, no third-party rights |
| **Jamendo** | Search and bulk import Creative Commons music (needs a free client ID) | Per-track CC licence stored and shown |
| **Internet Archive** | Search netlabel, public-domain and CC collections | Only PD/CC items listed |

Rules:

- A source must declare its rights basis, which the host sees before importing.
- Non-commercial (NC) licences are flagged.
- API keys are stored server-side with the station settings and never sent to listeners.
- Sources that obtain tracks from streaming services without the rights holders'
  permission, such as Lucida-style rippers, are **excluded**. This repeats the
  out-of-scope item below.
- Further sources could be added later through the same trait, such as the operator's
  own S3, WebDAV or Nextcloud storage, or a licensed catalogue.

## Host dashboard draft

`apps/host` is a front-end draft using simulated data, with a 1× or 20× simulation
speed. It covers:

- **Live**: the track on air with progress, and the "Up next" queue with drag-to-reorder
  and the predicted jingle position after each track. It also shows the fallback
  playlist when the queue is empty, the listener count, and each jingle rule's progress
  towards its next play.
- **Library**: search, a type filter, the Import dialog, and import job progress
  including rejected files.
- **Jingles**: per-jingle enable/disable, rules in songs, minutes or both, and drag
  order for jingles that become due together.
- **Playlists**: create, rename and delete playlists. Reorder and remove tracks, add
  tracks from the library in the order you pick them, "Queue all", and shuffle. One
  playlist can be the **fallback**: it repeats when the queue runs out. Without a
  fallback the station shows as **idle**.
- **Settings**: changes are kept as a draft until saved, with a save/discard bar.
  - **Station identity**: name, description, logo (or a letter mark) and accent
    colour, with a live preview of the listener page.
  - **Listener access**: public or private with an access code. Generating a new code
    disconnects old listeners when saved.
  - **Stream**: Opus, MP3 or AAC, and bitrate. Saving warns that the stream restarts.
  - **Import sources**: enable or disable each source, and connect Jamendo's client ID.
  - **Privacy**: a statement of what the station stores (see below).
  - **Host account**: password fields shown but disabled until the backend exists.

Proposed privacy default (GDPR data minimisation): the listener count comes from
open audio connections only. The station stores no listener IP addresses,
identifiers or listening history, and the listener page sets no tracking cookies.
Server access logs, if enabled, should be short-lived and documented.


## Listener page draft

`apps/listener` follows the wireframe and the visual direction. The header has the
station mark and a Privacy link. Below it come the station name in large display
type with the description, then the player card.

- **Audio graph** (Web Audio): stream → bass low-shelf (160 Hz) → mid peaking (1 kHz)
  → treble high-shelf (4.5 kHz) → headroom → analyser + volume. Boosting a band
  lowers the headroom gain by the same amount, to prevent clipping. The visualizer
  taps the signal before the volume control.
- **Listen** starts only on a click. Each start loads a fresh, cache-busted stream URL,
  so it always joins at the live point. Stopping aborts the download, and errors
  retry with exponential backoff (1 s, doubling, up to 15 s).
- **Media Session**: lock-screen and hardware play/pause, track metadata, and a
  "▶ Title — Station" tab title.
- Volume and EQ are saved in the browser's `localStorage` only. The Privacy dialog
  explains this, along with the privacy default.
- **States**: live; private (an access code gate that the server must also enforce on
  `/stream`); off air (Listen disabled); idle; reconnecting; playback blocked.
- Without `VITE_STREAM_URL`, a quiet generated demo signal stands in for the stream,
  so the EQ and visualizer can be judged with real audio.

## Proposed scheduling details

These resolve edge cases and remain reviewable implementation assumptions:

- A rule using both units becomes due when either threshold is reached.
- Only completed music tracks count toward song-based frequency.
- Minute-based frequency uses elapsed broadcast time while the station is running.
- A jingle's counters reset after that jingle finishes playing.
- If multiple jingles become due together, play them in stable configured order at
  the track boundary. Each plays once; elapsed intervals do not accumulate copies.
- A repeating playlist can continue when the manually queued music runs out.
- When no playable music exists, report that the station is idle.

## Working assumptions

- Each installation hosts one station.
- The operator supplies audio files; the software ships without a music catalogue.
- Music and jingles are separate library item types.
- Queue, playlists, jingle rules, and station settings persist across restarts.
- Public versus access-restricted listening is a station setting; management access
  always requires authentication when exposed over a network.
- Restricting listener access must protect the audio endpoint, not only the webpage.

## System boundaries

- Library: stores audio, metadata, and validated media properties.
- Scheduler: chooses the next music track or due jingle at playback boundaries.
- Broadcaster: plays server-side audio and distributes one shared stream.
- Management interface: configures the library, queue, playlists, and jingle rules.
- Listener interface: provides tune-in, volume, and current-track information.

The scheduler should be independently testable using a controlled clock and track
completion events. The broadcaster owns elapsed playback time and completion events;
individual listener actions never advance the station's queue.

## Verification criteria

- Two listeners joining at different times receive the same current broadcast.
- Browser network inspection shows a continuous stream rather than full-song requests.
- A rule set to every four songs plays after the fourth completed song.
- A rule set to every 30 minutes waits for the current song to finish after becoming due.
- Combined rules trigger once when either threshold is reached.
- Jingles never count as music tracks or interrupt a playing track.
- Multiple due rules behave deterministically and do not replay a backlog of intervals.
- Playback continues without any listener being connected.
- Restarting preserves station configuration and its library.
- If private mode is included, an unauthenticated request cannot retrieve the stream.
- Listener counts track stream joins/disconnections without counting dashboard visits.
- Current artwork, artists, and title update when a music track or jingle changes.
- Adjusting one listener's EQ does not affect another listener or the source broadcast.
- Tune-in, volume, and EQ controls are labeled, keyboard-operable, and usable on mobile.
- Changing station branding does not require editing source code or changing the
  queue, scheduler, or broadcasting engine.

## Implementation conventions

Use descriptive domain names, explicit scheduling state, and small modules. For example,
language-neutral scheduling logic should express intent directly:

```text
on_music_track_completed(now):
    update_song_counters()
    enqueue_due_jingles(now)
    enqueue_next_music_track()
```

Always validate uploaded media and configuration, test scheduling boundary cases,
and document launch and recovery behavior. Never embed service credentials in source
or silently substitute a different music source.

## Outside the first-version scope

- A shared hosted platform with multiple station owners.
- Listener-selected tracks or on-demand playback.
- Lucida or other third-party music acquisition integrations.
- Live microphone mixing and jingles layered over music (transitions crossfade at boundaries only).
- Supplying music or music-licensing services.

## Decisions before implementation

1. Finalize the proposed React + Vite frontend and Axum-based Rust backend.
2. Deployment packaging? Proposed: Docker Compose on a host or VPS.
3. Prove continuous playback across music/jingle boundaries and choose the media engine.
4. Record exact development, build, test, and launch commands during scaffolding.

## Documentation consulted

- React with Vite and TypeScript: https://react.dev/learn/build-a-react-app-from-scratch
- Vite static production and multi-page builds: https://vite.dev/guide/build.html
- Axum SSE support: https://docs.rs/axum/latest/axum/response/sse/index.html
- Base UI animation handbook (CSS transitions and Motion integration):
  https://base-ui.com/react/handbook/animation
- Visual reference stylesheet: https://staging.angelarium.org/fr/ (inspected 2026-11-04)

## Backend implementation status

`server/` implements the backend (see README › Server):

- **Engine**: one long-running ffmpeg encoder receives paced raw PCM, 700 ms ahead of
  real time. Each item is decoded by a short-lived ffmpeg process, and silence fills
  idle time, so the stream never breaks between items. Listeners share one encoded
  output with a 48 KB start-up burst. Off air, `/stream` returns 503.
- **Scheduler**: a pure module with unit tests covering every rule above.
  Minute counters advance with broadcast time while on air, including idle time.
- **Persistence**: SQLite holds the `tracks` table plus JSON documents for the
  schedule (queue, rules, counters, pending jingles, fallback), playlists, settings
  and on-air state.
- **Imports**: file uploads and the Test library, through one pipeline: ffprobe
  validation, tag reading, SHA-256 dedupe, cover extraction, and provenance.
- **Security**: the host password comes from the environment, with constant-time
  comparison and a delay after failed attempts. Sessions use an HttpOnly,
  SameSite=Strict cookie. Private-mode codes are checked on `/api/station`,
  `/events` and `/stream`. Artwork names are validated, and audio files are never
  served.
- **Verified end to end**: two listeners received the same broadcast, the listener
  count rises and falls, there are no decode errors across item boundaries,
  "every 2 songs" jingle placement is correct, private mode returns 401/204 as
  expected, and state survives a restart.
- **Front ends are connected**:
  - **Host dashboard** (`apps/host/src/store.ts`): sign-in, then a live state stream.
    Edits show immediately and are saved through the API; rapid edits such as dragging
    are merged into one request. It covers file uploads with progress and rejection
    reasons, Test library jobs, track deletion, playlists and the fallback, jingle
    rules, settings with server validation messages, and logo upload.
  - **Listener page**: real station data, the stream, and access codes checked by the
    server and remembered for the browser session.
  - **Production**: the Rust server serves both from one origin, the listener page at
    `/` and the dashboard at `/host/`.

Since the first backend milestone:

- **Catalogue importers**:
  - **Internet Archive**: search; each item is expanded to one format family of
    audio files, at most 30 per item. Downloads retry on transient errors.
  - **Jamendo**: search and import; the client ID is verified, stored server-side and
    masked in the API.
  - Only CC and public-domain material is accepted, and NC licences are flagged.
  - Licence and source page are stored per track, and the listener page shows them as
    a credit.
- **Opus**: Ogg Opus output. New listeners first receive the cached header pages,
  then whole pages. Verified to decode after joining mid-stream, and to play in
  Chromium.
- **Loudness**: EBU R128 loudness and true peak are measured per track at import,
  with a background job measuring older tracks. Playback gain targets −16 LUFS, is
  limited by −1 dBTP headroom and capped at ±12 dB. It can be turned off in Settings.
  Verified: tracks at −8.9 and −22.3 LUFS both play at −16.0 LUFS.
- **Accounts**: the password is an Argon2 hash in SQLite; the environment variable
  only sets the initial password or a reset. Sessions are stored by token hash and
  survive restarts. Changing the password and signing out other sessions are
  available in Settings.
- **Live updates**: host SSE sends light `live` events (about 0.9 KB). The full
  library is fetched only when `libraryRev` changes.
- **Metadata timing**: the start-up burst is time-based (2 s). Now-playing is
  published after the lead plus the burst (about 2.7 s), when listeners hear the
  change. Measured at 2.77 s after a skip.

- **Transitions**: there is a two-voice mixer with equal-power crossfades, set in
  Settings (cut, 2, 3, 4 or 6 s; default 3 s). Silence at the start and end of each
  file is trimmed using `silencedetect` at import. Around jingles the fade is at most
  1 s, and Skip fades out over 0.8 s. The next item is chosen when the current one
  enters its transition window, so jingle rules still apply. Verified with test
  tones: about a 2.8 s overlap, with RMS steady (no dip).
- **Measured timing**:
  - **Decoder lead**: set from the worst recent decoder start-up latency (calibrated
    at boot, then updated on every track) plus one 100 ms chunk.
  - **Start-up burst**: each listener requests one from its measured round-trip time
    and jitter (two RTTs plus four times the jitter), 1.5 times larger after each
    stall.
  - **Frame timing**: encoder output is split into whole MP3, ADTS or Ogg frames, each
    with its exact sample duration.
  - **Metadata sync**: `/api/stream-sync` reports the media position a connection
    started at. The page computes its exact position from `currentTime` and shows the
    timeline item at that position.
  - **Verified**: against detected tones, 174 of 174 steady samples matched.
  - **Remaining delay**: Chrome itself buffers about 2.2 s before and during
    playback, which is the bulk of the remaining listener delay. The page displays it
    as "s behind live".
- **Jingles on the listener page**: shown as a configurable message ("You're listening
  to {station}") with the station logo, instead of the file title.

Remaining known limitations:

- Jamendo was tested against its error responses and with recorded JSON in tests,
  but not with a real client ID.
- Browser buffering (about 2 s in Chrome for progressive streams) sets the practical
  minimum delay. Going lower would need a Media Source Extensions player.
- ND ("no derivatives") licences are not flagged. Loudness gain is generally not
  treated as an adaptation, but operators should judge.

## Long metadata and processing capacity

- Host cards and queue rows constrain intrinsic text widths. Long titles, artists,
  albums, and queued jingle labels use ellipsis; fallback names and dialog headings
  wrap without moving controls outside their container.
- On the public player, only overflowing title, artist, and album text slides back
  and forth, resting at each end. No edge mask hides the final characters. It
  remeasures after text, font, or container-size changes and cancels old animations.
  Hover or keyboard focus pauses movement. Reduced motion uses static ellipsis and
  the full string remains available as text and a native tooltip.
- Boot decoder calibration samples up to three real library files through the same
  seek/gain/PCM path as playback. Synthetic fallback and unavailable calibration
  are reported explicitly. Recent playback starts keep updating the lead estimate.
- The host API and live events expose a bounded periodic processing-capacity probe,
  including measured codec, bitrate, normalization, sample duration, voice count,
  source, and timestamp. A probe runs once at boot and every 180 seconds while on
  air, processes at most three seconds of audio, times out after eight seconds, and
  never overlaps another probe. FFmpeg stages use one thread each.
- The factor is actual encoded audio duration divided by unpaced elapsed processing
  time, including process startup. The minimum of the last three successful results
  for the same encoding profile is displayed. It is an estimate of processing
  capacity, not live CPU usage or a promise that buffering cannot run dry.
- The Live dashboard flags a factor below 1.5×, distinguishes missing/failed probes,
  preserves the timestamp on old results, and marks results for an obsolete
  configuration as “Previous settings.”
- Verification: browser checks cover desktop/mobile overflow, scrolling endpoints,
  reduced motion, and stale capacity labels. Rust tests include actual FFmpeg probes
  for MP3/AAC/Opus and real-library/synthetic/unavailable startup calibration.
