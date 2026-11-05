//! Station server: scheduler, broadcaster, public listener API and host API.

mod api;
mod capacity;
mod catalogue;
mod config;
mod db;
mod engine;
mod import;
mod media;
mod model;
mod scheduler;
mod state;

use anyhow::{Context, Result};
use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post, put};
use axum::{Router, middleware};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::api::{auth, host, public};
use crate::config::Config;
use crate::state::{AppState, Shared};

fn router(state: Shared) -> Router {
    let host_api = Router::new()
        .route("/state", get(host::get_state))
        .route("/events", get(host::events))
        .route("/broadcast", post(host::set_broadcast))
        .route("/skip", post(host::skip))
        .route("/queue", put(host::put_queue).post(host::append_queue))
        .route("/playlists", post(host::create_playlist))
        .route("/playlists/{id}", put(host::update_playlist).delete(host::delete_playlist))
        .route("/fallback", put(host::set_fallback))
        .route("/jingles", put(host::put_rules))
        .route("/settings", put(host::put_settings))
        .route("/logo", post(host::upload_logo).delete(host::delete_logo).layer(DefaultBodyLimit::max(6 * 1024 * 1024)))
        .route("/tracks", post(host::upload).layer(DefaultBodyLimit::max(1024 * 1024 * 1024)))
        .route("/tracks/{id}", put(host::update_track).delete(host::delete_track))
        .route("/import/test-library", post(host::import_test_library))
        .route("/import/catalogue", post(host::import_catalogue))
        .route("/catalogue/{source}/search", get(host::catalogue_search))
        .route("/integrations/jamendo", put(host::set_jamendo_key))
        .route("/password", post(auth::change_password))
        .route("/sessions/revoke-others", post(auth::revoke_other_sessions))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::require_host))
        .route("/login", post(auth::login))
        .route("/logout", post(auth::logout))
        .route("/session", get(auth::session));

    let mut app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/stream", get(public::audio_stream))
        .route("/events", get(public::events))
        .route("/api/station", get(public::station))
        .route("/api/access", post(public::check_access))
        .route("/api/stream-sync", get(public::stream_sync))
        .route("/media/artwork/{name}", get(public::artwork))
        .nest("/api/host", host_api);

    if let Some(dir) = &state.config.host_dist {
        app = app.nest_service("/host", ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html"))));
    }
    if let Some(dir) = &state.config.listener_dist {
        app = app.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html"))));
    }
    app.layer(TraceLayer::new_for_http()).with_state(state)
}

/// `station-server healthcheck`: exits 0 if the local server answers /healthz.
/// Used by the container HEALTHCHECK (the runtime image has no curl).
fn healthcheck() -> Result<()> {
    use std::io::{Read, Write};
    let bind = std::env::var("STATION_BIND").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let port = bind.rsplit(':').next().unwrap_or("8080");
    let mut conn = std::net::TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse()?, std::time::Duration::from_secs(3))?;
    conn.set_read_timeout(Some(std::time::Duration::from_secs(3)))?;
    conn.write_all(b"GET /healthz HTTP/1.0\r\nHost: localhost\r\n\r\n")?;
    let mut response = String::new();
    conn.read_to_string(&mut response)?;
    anyhow::ensure!(response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200"), "unhealthy: {response}");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        return healthcheck();
    }
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "station_server=info,tower_http=warn".into()))
        .init();

    let config = Config::from_env()?;
    for dir in [config.data_dir.clone(), config.media_dir(), config.artwork_dir(), config.tmp_dir()] {
        std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    // Leftover partial uploads from a previous run.
    for entry in std::fs::read_dir(config.tmp_dir())?.flatten() {
        let _ = std::fs::remove_file(entry.path());
    }
    let db = db::Db::open(&config.data_dir.join("station.db"))?;
    let password_hash = auth::initial_password_hash(&db, config.host_password.as_deref(), config.reset_password)?;
    let bind = config.bind;
    let state = AppState::new(config, db, password_hash)?;

    engine::calibrate(&state).await;
    tokio::spawn(engine::run(state.clone()));
    tokio::spawn(capacity::run(state.clone()));
    tokio::spawn(import::backfill_analysis(state.clone()));

    match (&state.config.listener_dist, &state.config.host_dist) {
        (Some(l), Some(h)) => tracing::info!("serving listener page from {} and dashboard from {}", l.display(), h.display()),
        _ => tracing::warn!(
            "built front ends not found, so / and /host/ will 404. Run `bun run build` in the repo root, \
             or set STATION_LISTENER_DIST / STATION_HOST_DIST"
        ),
    }
    let listener = tokio::net::TcpListener::bind(bind).await.with_context(|| format!("binding {bind}"))?;
    tracing::info!("listening on http://{bind} (host dashboard at /host/)");
    // Listener streams and SSE connections never finish on their own, so after the
    // signal give in-flight requests a short grace period, then exit.
    let (stopping_tx, mut stopping) = tokio::sync::watch::channel(false);
    let server = axum::serve(listener, router(state)).with_graceful_shutdown(async move {
        shutdown_signal().await;
        let _ = stopping_tx.send(true);
    });
    tokio::select! {
        result = server => result?,
        _ = async {
            let _ = stopping.wait_for(|s| *s).await;
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        } => tracing::info!("closed remaining listener connections"),
    }
    Ok(())
}

/// Ctrl-C locally, SIGTERM from `docker stop`.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutting down");
}
