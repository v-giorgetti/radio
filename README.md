# Radio Placeholder

**Deploy your own web radio. Make it look and sound like your station.**

Radio Placeholder is a self-hosted internet radio application with a Rust backend,
a React listener page, and a separate host dashboard. Upload your music, build a
queue or repeating playlist, schedule jingles, and share a single station URL.
Everyone tunes into the ongoing broadcast, while you choose what plays.

The default interface is deliberately genre-neutral. Change the station name,
description, logo, accent color, and jingle message from the dashboard. For a deeper
redesign, the listener page and shared component library are yours to customize.

The application runs in **one Docker container**, including the server, built web
pages, and FFmpeg. It uses SQLite and a persistent media volume; no external database,
Icecast installation, or JavaScript application server is required at runtime.

[Quick start](#quick-start-with-docker) · [Features](#features) ·
[Customization](#make-it-your-station) · [Deployment guide](infra/README.md) ·
[Development](#local-development) · [MIT license](LICENSE)

## Features

### For listeners

- A responsive public player with current artwork, title, artists, and album.
- Live listener count and broadcast status.
- Continuous streamed audio: joining starts at the current broadcast, without
  downloading complete songs or restarting the current track.
- Play/stop, volume, and a local bass/mid/treble equalizer with reset controls.
- An audio-reactive visualizer, smooth transitions, and reduced-motion support.
- Long titles and artist names scroll back and forth when they exceed the available space.
- Media Session integration for supported lock-screen and hardware controls.
- Automatic reconnection, with volume and EQ preferences stored on the listener's device.
- Optional private listening through an access code enforced by the server.

### For station hosts

- A password-protected dashboard at `/host/` with live station updates.
- Uploads for music and jingles, metadata editing, artwork extraction, and duplicate detection.
- An ordered playback queue with drag-to-reorder and skip controls.
- Playlists with reordering, shuffle, queue-all, and a repeating fallback playlist.
- Per-jingle scheduling by completed songs, elapsed broadcast minutes, or either
  threshold. Jingles wait for a track boundary and play in the configured order.
- Station identity settings with a listener-page preview.
- Configurable music crossfades, shorter jingle transitions, and loudness normalization.
- MP3, AAC, or Ogg/Opus streaming with selectable bitrates.
- File imports, a generated test library, and catalogue imports from Internet Archive
  and Jamendo. Jamendo requires your own client ID; catalogue availability depends on
  those services. Imported licence and attribution metadata are retained when supplied.
- Password changes and revocation of other host sessions.
- A processing-capacity indicator based on a recent decode/mix/encode benchmark.

## Quick start with Docker

You need Git, Docker Engine or Docker Desktop, and Docker Compose v2. Docker builds
both frontends and the Rust server, so Rust, Bun, and FFmpeg do not need to be installed
on the host for this setup.

```sh
git clone https://github.com/v-giorgetti/radio-placeholder.git
cd radio-placeholder
cp infra/.env.example infra/.env
```

Open `infra/.env` in your editor and configure:

```dotenv
STATION_HOST_PASSWORD=replace-with-your-own-long-password
STATION_RESET_PASSWORD=0
STATION_SECURE_COOKIES=0
STATION_PORT=8080
```

Choose your own password of at least **12 characters**. The password is used to
initialize the host account on first startup; later password changes are stored in
the database. `STATION_SECURE_COOKIES=0` is for this local HTTP example. Set it to
`1` when serving the station over HTTPS.

```sh
docker compose --env-file infra/.env -f infra/compose.yaml up -d --build
docker compose --env-file infra/.env -f infra/compose.yaml ps
```

The first build compiles Rust and downloads the build dependencies, so allow it time
to finish. Once the service is ready, open:

| Page | Local address |
| --- | --- |
| Public listener | <http://127.0.0.1:8080/> |
| Host dashboard | <http://127.0.0.1:8080/host/> |
| Health check | <http://127.0.0.1:8080/healthz> |

The Compose configuration binds to the host's loopback interface. For a public
station, put an HTTPS reverse proxy in front of it and point your domain at your
server. The [deployment guide](infra/README.md) includes Caddy configuration,
updates, backups, restores, and password recovery. If Caddy runs in another container,
use a shared Docker network and its service address instead of that container's loopback.

### Start your first broadcast

1. Sign in at `/host/` using the password you configured.
2. Open **Settings** to name the station, set its description, logo, and accent color.
3. Open **Library → Import** and upload music. To try the application without a music
   collection, use the generated test library, which produces synthetic audio.
4. Create a playlist and select it as the fallback for continuous playback, or add
   tracks to the queue.
5. Import jingles separately and configure their frequency in **Jingles**, if desired.
6. Start the broadcast from **Live**, open the listener page, and click **Listen**.

The browser requires a listener action to start audio. Closing the host dashboard
does not stop a broadcast. With no queued track or fallback playlist, the station
becomes idle. Your database, uploads, artwork, playlists, and settings live in the
`station-data` Docker volume and survive container replacement.

## Make it your station

### Customize from the dashboard

Most station setup requires no source edits or rebuild:

| Setting | What you can change |
| --- | --- |
| Station identity | Name, description, uploaded logo or letter mark, accent color |
| Jingle presentation | Listener-facing message, with `{station}` replaced by the station name |
| Listener access | Public station or private station with a shared access code |
| Stream | Codec, bitrate, crossfade length, and loudness normalization |
| Programming | Queue, playlists, repeating fallback, and individual jingle schedules |
| Import sources | Enable test/catalogue sources and configure your Jamendo client ID |

Save settings to apply them. Logo uploads save separately. Stream format, bitrate,
or access changes can restart active streams; branding changes apply without changing
the playback queue.

### Customize the design in code

The public page, dashboard, and shared controls are separate workspaces. You can
redesign the listener experience while keeping the scheduling and streaming backend.

| File or directory | Customize |
| --- | --- |
| `apps/listener/src/App.tsx` | Listener page composition, station heading, player layout |
| `apps/listener/src/listener.css` | Listener page spacing and responsive layout |
| `packages/ui/src/styles.css` | Shared colors, typography, radii, surfaces, control styles |
| `packages/ui/src/tokens.ts` | Shared palette and animation timing tokens |
| `packages/ui/src/components/` | Player, EQ, artwork, visualizer, and other reusable controls |
| `apps/host/src/` | Dashboard navigation, views, and host workflows |
| `apps/preview/` | Component gallery for reviewing the design independently |

`StationTheme` applies the station accent and motion preferences. For example,
this gives a custom React surface the shared styling and a different accent:

```tsx
import "@station/ui/styles.css";
import { StationTheme, Surface } from "@station/ui";

export function CustomStationCard() {
  return (
    <StationTheme accent="#1f8a70">
      <Surface>Welcome to your station.</Surface>
    </StationTheme>
  );
}
```

The default theme is light. Other palettes, including a dark appearance, require
editing the CSS tokens; there is currently no dashboard theme switcher or visual
page builder. When changing animation timings, keep the CSS and TypeScript tokens
in sync, and preserve reduced-motion behavior.

After source changes, rebuild with `bun run build` for a local server, or
`docker compose --env-file infra/.env -f infra/compose.yaml up -d --build` for Docker.

## How it works

1. The Rust server stores library metadata, settings, playlists, and scheduling state
   in SQLite, with audio and artwork on disk.
2. The scheduler chooses due jingles, then queued music, then the fallback playlist.
3. FFmpeg decodes and mixes the source audio. The station encodes one continuous
   broadcast and fans the encoded output out to connected listeners.
4. The browser receives `/stream` for audio and `/events` for live station metadata.
   The equalizer and visualizer run locally using Web Audio.
5. Authenticated host actions use `/api/host`; the production Rust server also serves
   the built public page at `/` and the dashboard at `/host/`.

| Layer | Technology |
| --- | --- |
| Backend | Rust, Axum, Tokio |
| Persistence | SQLite through rusqlite, filesystem media storage |
| Audio | FFmpeg and ffprobe |
| Frontends | React, TypeScript, Vite |
| UI | Base UI primitives, Motion, shared CSS tokens, locally bundled Manrope font |
| Build tooling | Bun workspaces and Cargo, with committed lockfiles |
| Deployment | Docker Compose plus your HTTPS reverse proxy |

## Stream formats and operational limits

| Format | Bitrates | Response content type |
| --- | --- | --- |
| MP3 | 128, 192, 256 kbps | `audio/mpeg` |
| AAC | 96, 128, 192 kbps | `audio/aac` |
| Opus in Ogg | 64, 96, 128 kbps | `audio/ogg` |

The default is MP3 at 128 kbps. The equalizer changes only the current listener's
playback. A shared broadcast does not imply sample-accurate synchronization: browser
buffering can cause small timing differences between listeners.

The listener count measures **active audio connections**, rather than verified
unique people. Server capacity depends on CPU, memory, network throughput, proxy
behavior, and file descriptor limits. There is no fixed listener-capacity guarantee.
See [the benchmarking guide](docs/benchmarking.md) for the included tools and how
to distinguish connected streams from continuously healthy playback.

The dashboard capacity factor is processing speed relative to real-time audio,
not a maximum listener estimate. It refreshes at startup and approximately every
three minutes while on air, using the lowest of the last three successful probes
for the same encoding settings. A settings change marks old measurements as previous
settings until a matching measurement is available.

This version runs one station with one host account per deployment. Separate
stations can use separate deployments and persistent volumes.

## Local development

For development without Docker, install **Bun 1.3+**, **Rust 1.89+**, and **FFmpeg
with ffprobe** on your PATH. Build both web applications from the repository root:

```sh
bun install --frozen-lockfile
bun run build
```

Then start the backend:

```sh
cd server
STATION_HOST_PASSWORD='replace-with-your-own-long-password' cargo run --locked
```

The default bind address is `127.0.0.1:8080`; the server discovers the built pages
in `apps/*/dist`. Starting from `server/` puts the default database and media under
`server/data/`. The Rust server reads process environment variables; it does not
automatically load `infra/.env`, which is used by Docker Compose.

For hot reload, keep the backend running and use another terminal at the repository
root:

| Command | Purpose |
| --- | --- |
| `bun run dev:listener` | Listener page at `http://localhost:5175/` |
| `bun run dev:host` | Host dashboard at `http://localhost:5174/host/` |
| `bun run dev` | Component gallery at `http://localhost:5173/` |
| `bun run typecheck` | Type-check all workspaces |
| `bun run build` | Build all three frontend applications |

The listener and host dev servers proxy API, audio, events, and artwork requests to
`127.0.0.1:8080`. Keep each page's requests on its dev origin so authentication cookies
work as expected. The listener can display simulated design states using
`?state=live`, `private`, `offline`, `idle`, or `reconnecting`. These are preview states,
not changes to the actual server's access mode or broadcast.

### Backend configuration

Paths below refer to the server process. Docker supplies its own container paths.

| Variable | Default | Purpose |
| --- | --- | --- |
| `STATION_HOST_PASSWORD` | Required on first start, at least 12 characters | Initialize the host account |
| `STATION_RESET_PASSWORD` | Off | With a password value, reset the host password and revoke all sessions |
| `STATION_BIND` | `127.0.0.1:8080` | HTTP listen address; Docker sets `0.0.0.0:8080` inside the container |
| `STATION_DATA_DIR` | `./data` | SQLite database, audio, artwork, and temporary imports; Docker uses `/data` |
| `STATION_FFMPEG` | `ffmpeg` | FFmpeg binary path |
| `STATION_FFPROBE` | `ffprobe` | ffprobe binary path |
| `STATION_LISTENER_DIST` | Auto-detected | Built listener page directory |
| `STATION_HOST_DIST` | Auto-detected | Built host dashboard directory |
| `STATION_SECURE_COOKIES` | Off | Set to `1` when the site is served over HTTPS |
| `STATION_PORT` | `8080` in Compose | Host loopback port mapped to the container; read by Compose |
| `RUST_LOG` | `station_server=info,tower_http=warn` | Logging filters |

Keep real passwords and integration credentials out of Git. Use `infra/.env.example`
as a template and store deployment-specific configuration in the ignored `infra/.env`.

### Checks

```sh
bun run typecheck
bun run build
(cd server && cargo test --locked)
python3 scripts/test-benchmark-listeners.py
python3 scripts/test-radio-load-worker.py
python3 scripts/test-benchmark-radio-scale.py
python3 scripts/test-h2load-radio-helpers.py
```

The Python checks require Python 3.11+ and test the benchmark helpers locally;
they do not run a load test against a station. Some Rust media tests need FFmpeg.

For browser layout regression checks, install `agent-browser` and its browser runtime,
start `bun run dev:listener`, then run `bun run test:text-overflow`. The checks use an
isolated browser session to exercise long metadata, responsive layouts, scrolling,
reduced motion, and dashboard containment. Set `STATION_TEST_URL` if your listener
dev server uses another URL.

## Project layout

```text
apps/listener/        Public React listener page
apps/host/            Authenticated React host dashboard
apps/preview/         Shared component gallery
packages/ui/          Reusable components, theme, icons, and motion tokens
server/src/           Rust API, scheduler, media engine, persistence, and importers
server/tests/fixtures/ Synthetic audio fixtures for media parsing tests
infra/                Docker image, Compose configuration, and deployment guide
scripts/              Browser regression checks and listener benchmark tools
docs/benchmarking.md  Load-test instructions and measurement limits
SPEC.md               Original requirements and design notes, including proposed work
```

The feature list and deployment instructions above describe the current application.
`SPEC.md` also preserves earlier proposals and is not a checklist of shipped features.

## License and audio content

The software is available under the [MIT license](LICENSE). You can deploy it, modify
it, and reuse it for your own station under those terms. Third-party dependencies
retain their own licenses.

The repository includes generated demo visuals and synthetic test tones, rather
than a music catalogue. The software license does not grant rights to music, artwork,
or other content you broadcast. Supply your own content and the necessary permissions;
check each imported catalogue item's license and attribution requirements.
