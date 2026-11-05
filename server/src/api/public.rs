//! Public listener endpoints: station info, SSE metadata, the audio stream and artwork.
//! Only public fields leave this module; private stations require the access code.

use std::convert::Infallible;
use std::sync::atomic::Ordering;
use std::time::Duration;

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures::{Stream, StreamExt, stream};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast::error::RecvError;
use tokio_stream::wrappers::WatchStream;

use super::{ApiError, ApiResult, secure_eq};
use crate::model::{ListenerAccess, StreamFormat, TrackKind};
use crate::state::{HISTORY_MS, Shared, now_ms};

#[derive(Deserialize)]
pub struct AccessQuery {
    code: Option<String>,
}

#[derive(Deserialize)]
pub struct StreamQuery {
    code: Option<String>,
    /// Random id chosen by the player, used to look up its start position.
    session: Option<String>,
    /// Start-up burst the player asks for (ms), derived from its measured network.
    burst: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicItem {
    play_id: u64,
    kind: TrackKind,
    title: Option<String>,
    artists: Vec<String>,
    album: Option<String>,
    artwork_url: Option<String>,
    started_at: i64,
    /// Credit for openly licensed tracks (shown by the listener page).
    licence: Option<String>,
    attribution_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicTimelineEntry {
    play_id: u64,
    /// Position in the stream's media timeline; compare with what the player is playing.
    media_start_ms: f64,
    /// Wall-clock time it plays in real time (for clients that aren't listening).
    started_at: i64,
    item: Option<PublicItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicStation {
    name: String,
    description: String,
    accent: String,
    logo_url: Option<String>,
    access: ListenerAccess,
    /// True when the station is private and no valid code was supplied.
    locked: bool,
    on_air: bool,
    on_air_since: Option<i64>,
    listeners: Option<usize>,
    /// What plays in real time right now (for clients that aren't listening).
    now_playing: Option<PublicItem>,
    /// Recent items with media positions, so a player shows exactly what it's hearing.
    timeline: Vec<PublicTimelineEntry>,
    /// Encoder session; media positions restart when it changes.
    epoch: u64,
    server_time: i64,
}

fn unlocked(state: &Shared, code: Option<&str>) -> bool {
    let st = state.station();
    st.settings.access == ListenerAccess::Public
        || code.is_some_and(|c| secure_eq(&c.trim().to_uppercase(), &st.settings.access_code.to_uppercase()))
}

fn public_item(st: &crate::state::Station, play_id: u64, track_id: &str, started_at: i64) -> Option<PublicItem> {
    let t = st.tracks.get(track_id)?;
    let logo = st.settings.logo.as_ref().map(|l| format!("/media/artwork/{l}"));
    Some(match t.kind {
        // Listeners see the station's message, not the jingle's file title.
        TrackKind::Jingle => PublicItem {
            play_id,
            kind: t.kind,
            title: Some(st.settings.jingle_message.replace("{station}", &st.settings.name)),
            artists: vec![],
            album: None,
            artwork_url: logo,
            started_at,
            licence: None,
            attribution_url: None,
        },
        TrackKind::Music => PublicItem {
            play_id,
            kind: t.kind,
            title: t.title.clone(),
            artists: t.artists.clone(),
            album: t.album.clone(),
            artwork_url: t.artwork_url(),
            started_at,
            licence: t.licence.clone().filter(|l| l != "Generated"),
            attribution_url: t.attribution_url.clone(),
        },
    })
}

pub fn snapshot(state: &Shared, code: Option<&str>) -> PublicStation {
    let open = unlocked(state, code);
    let st = state.station();
    let live = state.live();
    let now = now_ms();
    let timeline: Vec<PublicTimelineEntry> = if open {
        live.timeline
            .iter()
            .map(|e| PublicTimelineEntry {
                play_id: e.play_id,
                media_start_ms: e.media_start_ms,
                started_at: e.started_at,
                item: e.track_id.as_deref().and_then(|id| public_item(&st, e.play_id, id, e.started_at)),
            })
            .collect()
    } else {
        vec![]
    };
    // Real-time "now": the latest entry that has started playing in real time.
    let now_playing = live
        .timeline
        .iter()
        .rev()
        .find(|e| e.started_at <= now)
        .or(live.timeline.front())
        .filter(|_| open)
        .and_then(|e| e.track_id.as_deref().and_then(|id| public_item(&st, e.play_id, id, e.started_at)));
    PublicStation {
        name: st.settings.name.clone(),
        description: st.settings.description.clone(),
        accent: st.settings.accent.clone(),
        logo_url: st.settings.logo.as_ref().map(|l| format!("/media/artwork/{l}")),
        access: st.settings.access,
        locked: !open,
        on_air: live.on_air_since.is_some(),
        on_air_since: live.on_air_since,
        listeners: open.then(|| state.listeners()),
        now_playing,
        timeline,
        epoch: state.hub.epoch.load(Ordering::SeqCst),
        server_time: now,
    }
}

pub async fn station(State(state): State<Shared>, Query(q): Query<AccessQuery>) -> Json<PublicStation> {
    Json(snapshot(&state, q.code.as_deref()))
}

/// Checks a private-station code without exposing anything else.
pub async fn check_access(State(state): State<Shared>, Json(q): Json<AccessQuery>) -> ApiResult<StatusCode> {
    if unlocked(&state, q.code.as_deref()) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        tokio::time::sleep(Duration::from_millis(500)).await;
        Err(ApiError(StatusCode::UNAUTHORIZED, "That code doesn't match.".into()))
    }
}

pub async fn events(
    State(state): State<Shared>,
    Query(q): Query<AccessQuery>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let code = q.code;
    let stream = WatchStream::new(state.changes.subscribe()).map(move |_| {
        let snap = snapshot(&state, code.as_deref());
        Ok(Event::default().event("station").json_data(snap).unwrap_or_default())
    });
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

/// Decrements the listener count (and forgets the connection) when a stream ends.
struct ListenerGuard(Shared, Option<String>);
impl Drop for ListenerGuard {
    fn drop(&mut self) {
        if let Some(id) = &self.1 {
            self.0.hub.connections.lock().unwrap().remove(id);
        }
        self.0.hub.listeners.fetch_sub(1, Ordering::Relaxed);
        self.0.notify();
    }
}

/// Burst for players that don't ask for one (e.g. VLC or a hardware radio).
const DEFAULT_BURST_MS: f64 = 2_000.0;

fn valid_session(s: &str) -> bool {
    (8..=64).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub async fn audio_stream(State(state): State<Shared>, Query(q): Query<StreamQuery>) -> ApiResult<Response> {
    if !unlocked(&state, q.code.as_deref()) {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "Access code required".into()));
    }
    let session = q.session.filter(|s| valid_session(s));
    let burst_ms = q.burst.filter(|b| b.is_finite()).unwrap_or(DEFAULT_BURST_MS).clamp(0.0, HISTORY_MS);
    let (start, rx, format) = {
        // Same lock order as Hub::publish (history, then tx): copying the burst and
        // subscribing atomically means no frame is missed or duplicated.
        let history = state.hub.history.lock().unwrap();
        let tx = state.hub.tx.lock().unwrap();
        let Some(tx) = tx.as_ref() else {
            return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "Station is off air".into()));
        };
        let format = *state.hub.format.lock().unwrap();
        let mut start: Vec<Bytes> = state.hub.headers.lock().unwrap().clone();
        if format == StreamFormat::Opus && start.is_empty() {
            return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "Stream is starting, try again in a moment".into()));
        }
        // Every chunk is a whole frame/page, so the burst can start on any of them.
        let end = *state.hub.media_end_ms.lock().unwrap();
        let first = history.iter().position(|c| c.media_start_ms >= end - burst_ms).unwrap_or(history.len());
        let start_media = history.get(first).map_or(end, |c| c.media_start_ms);
        start.extend(history.iter().skip(first).map(|c| c.bytes.clone()));
        if let Some(id) = &session {
            state.hub.connections.lock().unwrap().insert(id.clone(), start_media);
        }
        (start, tx.subscribe(), format)
    };
    state.hub.listeners.fetch_add(1, Ordering::Relaxed);
    state.notify();
    let guard = ListenerGuard(state.clone(), session);

    let live = stream::unfold((rx, guard), |(mut rx, guard)| async move {
        loop {
            match rx.recv().await {
                Ok(chunk) => return Some((Ok::<_, Infallible>(chunk), (rx, guard))),
                // A slow client fell behind: skip ahead rather than disconnect.
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return None,
            }
        }
    });
    let body = Body::from_stream(stream::iter(start.into_iter().map(Ok)).chain(live));
    Ok((
        [
            (header::CONTENT_TYPE, format.content_type()),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        body,
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct SyncQuery {
    session: String,
}

/// Where a connection's audio started in the media timeline (for exact metadata sync).
pub async fn stream_sync(State(state): State<Shared>, Query(q): Query<SyncQuery>) -> ApiResult<Json<serde_json::Value>> {
    let start = state.hub.connections.lock().unwrap().get(&q.session).copied();
    match start {
        Some(start_media_ms) => Ok(Json(serde_json::json!({
            "epoch": state.hub.epoch.load(Ordering::SeqCst),
            "startMediaMs": start_media_ms,
        }))),
        None => Err(ApiError::not_found("Stream session")),
    }
}

pub async fn artwork(State(state): State<Shared>, Path(name): Path<String>) -> ApiResult<Response> {
    // Names are `<sha256>.jpg`; reject anything else (no path traversal).
    let valid = name.len() == 68 && name.ends_with(".jpg") && name[..64].chars().all(|c| c.is_ascii_hexdigit());
    if !valid {
        return Err(ApiError::not_found("Artwork"));
    }
    let path = state.config.artwork_dir().join(&name);
    let bytes = tokio::fs::read(&path).await.map_err(|_| ApiError::not_found("Artwork"))?;
    Ok((
        [(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, "public, max-age=31536000, immutable")],
        bytes,
    )
        .into_response())
}
