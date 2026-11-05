# syntax=docker/dockerfile:1.7
# Station: one image with the Rust server, ffmpeg, and the built listener page + host dashboard.
# Build from the repository root:  docker compose -f infra/compose.yaml build

# ---- 1. Front ends (Bun + Vite) ----------------------------------------------------------
FROM oven/bun:1.3 AS web
WORKDIR /src
# Manifests first so dependency installs are cached.
COPY package.json bun.lock ./
COPY packages/ui/package.json packages/ui/
COPY apps/listener/package.json apps/listener/
COPY apps/host/package.json apps/host/
COPY apps/preview/package.json apps/preview/
RUN bun install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN bun --filter @station/listener build && bun --filter @station/host build

# ---- 2. Server (Rust) --------------------------------------------------------------------
FROM rust:1.89-slim-bookworm AS server
RUN apt-get update && apt-get install -y --no-install-recommends cmake pkg-config && rm -rf /var/lib/apt/lists/*
WORKDIR /src/server
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/server/target \
    cargo build --release --locked && cp target/release/station-server /station-server

# ---- 3. Runtime --------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin station \
    && mkdir -p /data && chown station:station /data
COPY --from=server /station-server /usr/local/bin/station-server
COPY --from=web /src/apps/listener/dist /app/apps/listener/dist
COPY --from=web /src/apps/host/dist /app/apps/host/dist

ENV STATION_BIND=0.0.0.0:8080 \
    STATION_DATA_DIR=/data \
    STATION_LISTENER_DIST=/app/apps/listener/dist \
    STATION_HOST_DIST=/app/apps/host/dist \
    RUST_LOG=station_server=info,tower_http=warn

USER station
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["/usr/local/bin/station-server", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/station-server"]
