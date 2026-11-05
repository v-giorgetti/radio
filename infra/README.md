# Deploy your own radio

The Docker setup packages the Rust server, ffmpeg, public listener page (`/`), and
host dashboard (`/host/`) into one image. SQLite, uploaded audio, artwork, station
settings, and playlists live in a persistent Docker volume. You do not need a
separate database, Node.js server, or Icecast installation.

Run the commands below from the repository root. They use an explicit environment
file so the published port and container settings come from the same configuration.

## Requirements

- A machine with Docker Engine and the Docker Compose plugin.
- Git and enough free disk space for the image build and your audio library.
- For a public station: a domain pointing to your server, a reverse proxy, and
  access to ports 80 and 443 for the usual Caddy automatic HTTPS setup.

The image builds the front ends and Rust binary from source. Its first build takes
longer than later builds because dependencies and compilers are cached.

## First deployment

```sh
git clone https://github.com/v-giorgetti/radio-placeholder.git
cd radio-placeholder
cp infra/.env.example infra/.env
chmod 600 infra/.env
```

Edit `infra/.env` with your editor. Set `STATION_HOST_PASSWORD` to a unique password
of at least 12 characters. Keep `STATION_SECURE_COOKIES=1` for a public HTTPS site.
Leave `STATION_RESET_PASSWORD=0` for normal operation. Never commit this file.

```sh
docker compose --env-file infra/.env -f infra/compose.yaml config -q
docker compose --env-file infra/.env -f infra/compose.yaml up -d --build
docker compose --env-file infra/.env -f infra/compose.yaml ps
curl --fail http://127.0.0.1:8080/healthz
```

The service should become `healthy`; the health endpoint returns `ok`. Replace
`8080` in examples if you change `STATION_PORT`. The container listens on
`127.0.0.1` on the Docker host, so it is reached publicly through your reverse
proxy. Docker does not install or start Caddy for you.

### Publish through Caddy

The supplied [Caddyfile.example](Caddyfile.example) assumes Caddy runs directly on
the Docker host. Replace `radio.example.com` with your domain and match its upstream
port to `STATION_PORT`:

```caddyfile
radio.example.com {
	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1
	}
}
```

Merge this site block into your Caddyfile. On a Linux host using the standard Caddy
systemd service, validate the full configuration and then reload it:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

If your reverse proxy runs in another container, `127.0.0.1` refers to that proxy
container. Adapt the networking and upstream address instead of copying the
host-based configuration unchanged.

The continuous audio endpoint `/stream` and live metadata endpoints `/events` and
`/api/host/events` must pass through without response buffering, caching, or short
response timeouts. Preserve query strings, request bodies, and cookies, and forward
the whole site at its domain root. The host API accepts audio uploads up to 1 GiB
per request; adjust any proxy upload limit for the sizes you intend to use.

See Caddy's [streaming proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming)
and [automatic HTTPS requirements](https://caddyserver.com/docs/automatic-https).

### Set up the station

1. Open `https://radio.example.com/host/` and sign in with your initial password.
2. In **Settings**, choose your station name, description, accent colour, and logo.
   Choose public access or a private listener access code.
3. Add audio in **Library**, create a playlist, and choose a fallback playlist or
   add tracks to the queue.
4. Add jingles and their frequency rules if you want station idents between songs.
5. Start the broadcast in **Live** and open `https://radio.example.com/` to listen.

These settings are stored in the data volume and do not require an image rebuild.
The first-start password is stored as an Argon2 hash; subsequent changes belong in
**Settings → Host account**. Editing `STATION_HOST_PASSWORD` alone does not change
an existing account.

## Try it locally over HTTP

Use the same setup, but set `STATION_SECURE_COOKIES=0` in `infra/.env` before starting
the service. Open http://127.0.0.1:8080/ and http://127.0.0.1:8080/host/. Browsers
will not send `Secure` session cookies over ordinary HTTP, so the HTTPS setting can
otherwise prevent the local dashboard from staying signed in.

Restore `STATION_SECURE_COOKIES=1` when deploying behind HTTPS. Apply environment
changes with `docker compose ... up -d`; a container restart alone does not replace
its environment.

## Configuration

| Setting in `infra/.env` | Purpose |
| --- | --- |
| `STATION_HOST_PASSWORD` | Initial host password, or the replacement password during an explicit reset; at least 12 characters |
| `STATION_RESET_PASSWORD` | `0` normally; `1` resets the host password at startup and revokes existing sessions |
| `STATION_SECURE_COOKIES` | `1` for HTTPS; `0` only for local HTTP testing |
| `STATION_PORT` | Host loopback port; defaults to `8080` |

The image sets `STATION_BIND=0.0.0.0:8080`, `STATION_DATA_DIR=/data`, and the paths to
the compiled front ends. Keep these defaults unless you also adjust the Compose
ports, volume mount, or image layout. Other server environment options are documented
in the [main README](../README.md).

## Updates and logs

Make a data backup before updating. Rebuilding or recreating the one radio service
briefly interrupts listening; the data volume persists.

```sh
git pull --ff-only
docker compose --env-file infra/.env -f infra/compose.yaml up -d --build
docker compose --env-file infra/.env -f infra/compose.yaml ps
docker compose --env-file infra/.env -f infra/compose.yaml logs --tail 100 station
```

Use `logs -f station` to follow new messages. `docker compose ... stop station` stops
the radio without deleting its data. Do not use `down -v` unless you intend to
delete the database and media library.

## Back up the database and audio library

The named `station-data` volume contains `station.db`, its SQLite journal files,
`media/`, `artwork/`, and temporary import files in `tmp/`. With the default project
name, Docker calls it `station_station-data`; the commands below discover the
actual name instead of assuming it.

Stop the service for a consistent backup of SQLite and its matching audio files.
This interrupts the broadcast until it is started again. Do not copy only a live
`station.db` file: this application uses SQLite WAL mode.

Run this block as a script or a subshell. Its exit trap restarts the service even
if the backup fails:

```sh
(
  set -eu
  mkdir -p backups
  chmod 700 backups
  STATION_CONTAINER=$(docker compose --env-file infra/.env -f infra/compose.yaml ps -q station)
  STATION_DATA_VOLUME=$(docker inspect "$STATION_CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')
  test -n "$STATION_DATA_VOLUME"
  trap 'docker compose --env-file infra/.env -f infra/compose.yaml start station' EXIT
  docker compose --env-file infra/.env -f infra/compose.yaml stop station
  docker run --rm \
    --mount "type=volume,source=$STATION_DATA_VOLUME,target=/data,readonly" \
    --mount "type=bind,source=$PWD/backups,target=/backup" \
    debian:bookworm-slim \
    sh -c 'umask 077; tar czf "/backup/station-data-$(date +%Y%m%d-%H%M%S).tgz" -C /data .'
)
```

Confirm the archive was created successfully before relying on it, and copy it to
another machine or backup destination. Treat archives as private: they include
password hashes, sessions, private station codes, and any configured integration
credentials. Store `infra/.env` separately in a private backup if you need it.

### Restore on a fresh installation

Use an empty data volume and a compatible checkout. Copy the chosen archive to
`backups/restore.tgz`, prepare `infra/.env`, then build and create the service
without starting it:

```sh
(
  set -eu
  docker compose --env-file infra/.env -f infra/compose.yaml build station
  docker compose --env-file infra/.env -f infra/compose.yaml create station
  STATION_CONTAINER=$(docker compose --env-file infra/.env -f infra/compose.yaml ps -a -q station)
  STATION_DATA_VOLUME=$(docker inspect "$STATION_CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')
  test -n "$STATION_DATA_VOLUME"
  docker run --rm \
    --mount "type=volume,source=$STATION_DATA_VOLUME,target=/data" \
    --mount "type=bind,source=$PWD/backups,target=/backup,readonly" \
    debian:bookworm-slim \
    sh -ec '
      test -z "$(find /data -mindepth 1 -print -quit)" || {
        echo "Restore requires an empty data volume" >&2
        exit 1
      }
      tar xzf /backup/restore.tgz -C /data
      chown -R 10001 /data
    '
  docker compose --env-file infra/.env -f infra/compose.yaml up -d station
)
```

The runtime user has UID `10001`; restored files must be writable by it. The
restored database keeps its host password and station settings. For an existing
installation, stop it and back up its current volume first; do not merge unrelated
databases and media files by extracting one backup over another.

## Reset a forgotten host password

1. Set a new `STATION_HOST_PASSWORD` of at least 12 characters in `infra/.env` and
   set `STATION_RESET_PASSWORD=1`.
2. Run `docker compose --env-file infra/.env -f infra/compose.yaml up -d station`.
   Startup replaces the stored hash and signs out all existing sessions.
3. Set `STATION_RESET_PASSWORD=0` again, then run that `up -d station` command once
   more so future restarts do not keep resetting the password.
4. Sign in at `/host/` with the new password.

## Listener connections and capacity

The service's soft and hard open-file limits are both 65,536. Each listener normally
holds separate audio and metadata responses, alongside the server's database, media,
and other files. Raising this ceiling does not reserve memory or establish a listener
capacity. The proxy has its own limits, and CPU, memory, encoding settings, and network
bandwidth can become constraints first. Use the benchmark tooling documented in the
[benchmarking guide](../docs/benchmarking.md) to measure your own deployment.

Compose applies changed environment variables, port mappings, and open-file limits
when it recreates the service. `docker compose restart` does not apply these changes:

```sh
docker compose --env-file infra/.env -f infra/compose.yaml config -q
docker compose --env-file infra/.env -f infra/compose.yaml up -d --no-deps --no-build station
```

See the [Compose `ulimits` reference](https://docs.docker.com/reference/compose-file/services/#ulimits).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Container exits during first startup | Set an initial password of at least 12 characters, inspect `logs station`, and check data-volume permissions |
| Dashboard cannot stay signed in | Match `STATION_SECURE_COOKIES` to HTTP versus HTTPS and recreate the service after changing it |
| Public domain returns a proxy error | Check `ps`, `/healthz`, DNS, the upstream port, and whether the proxy runs on the host or in a separate container |
| Page loads but no music plays | Add music, queue it or select a nonempty fallback playlist, start broadcasting, and press Play in the listener page |
| Metadata arrives late or audio repeatedly reconnects | Check proxy buffering/timeouts, host resources, network bandwidth, and browser codec support |
| Upload is rejected by the proxy | Check its request-body size limit; the app's audio upload route allows up to 1 GiB per request |

Only broadcast audio you have permission to share. Installing or hosting this
software does not provide music rights or a broadcasting licence.
