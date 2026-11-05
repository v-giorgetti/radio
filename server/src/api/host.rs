//! Authenticated host API. All routes are behind `auth::require_host`.

use std::collections::HashSet;
use std::convert::Infallible;
use std::sync::atomic::Ordering;
use std::time::Duration;

use axum::Json;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio_stream::wrappers::WatchStream;

use super::{ApiError, ApiResult};
use crate::capacity::{CapacityMeasurement, DecoderCalibration};
use crate::catalogue::{self, CatalogueResult, Source};
use crate::import::{self, Provenance, TestLibraryRequest};
use crate::model::{JingleRule, Playlist, Settings, Track, TrackKind};
use crate::scheduler::Counters;
use crate::state::{Current, ImportJob, Rejection, Shared, now_ms};

// ---------- snapshot ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTrack {
    #[serde(flatten)]
    track: Track,
    artwork_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleView {
    #[serde(flatten)]
    rule: JingleRule,
    songs_since: u32,
    minutes_since: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveView {
    /// What the host asked for.
    on_air: bool,
    on_air_since: Option<i64>,
    current: Option<Current>,
    listeners: usize,
    processing_headroom: Option<CapacityMeasurement>,
    processing_probe_running: bool,
    processing_probe_error: Option<String>,
    decoder_lead_ms: u64,
    decoder_calibration: DecoderCalibration,
}

/// Settings as the host sees them: secrets replaced by "is it set?".
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSettings {
    #[serde(flatten)]
    settings: Settings,
    jamendo_connected: bool,
}

fn host_settings(s: &Settings) -> HostSettings {
    let mut settings = s.clone();
    let connected = !settings.jamendo_client_id.is_empty();
    settings.jamendo_client_id = String::new();
    HostSettings { settings, jamendo_connected: connected }
}

/// Frequently changing state, sent on every change.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSnapshot {
    server_time: i64,
    /// When this changes, re-fetch the full state (tracks, playlists, settings).
    library_rev: u64,
    live: LiveView,
    queue: Vec<String>,
    pending_jingles: Vec<String>,
    rules: Vec<RuleView>,
    fallback_playlist_id: Option<String>,
    jobs: Vec<ImportJob>,
}

/// Everything: live state plus the library, playlists and settings.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSnapshot {
    #[serde(flatten)]
    live: LiveSnapshot,
    tracks: Vec<HostTrack>,
    playlists: Vec<Playlist>,
    settings: HostSettings,
}

pub fn live_snapshot(state: &Shared) -> LiveSnapshot {
    let st = state.station();
    let live = state.live();
    let capacity = state.capacity.lock().unwrap();
    let rules = st
        .schedule
        .rules
        .iter()
        .map(|r| {
            let c = st.schedule.counters.get(&r.jingle_id).cloned().unwrap_or_default();
            RuleView { rule: r.clone(), songs_since: c.songs_since, minutes_since: c.ms_since as f64 / 60_000.0 }
        })
        .collect();
    LiveSnapshot {
        server_time: now_ms(),
        library_rev: state.library_rev.load(Ordering::SeqCst),
        live: LiveView {
            on_air: *state.engine.on_air.borrow(),
            on_air_since: live.on_air_since,
            current: live.current.clone(),
            listeners: state.listeners(),
            processing_headroom: capacity.measurement.clone(),
            processing_probe_running: capacity.running,
            processing_probe_error: capacity.error.clone(),
            decoder_lead_ms: state.lead.lock().unwrap().lead_ms(),
            decoder_calibration: state.decoder_calibration.lock().unwrap().clone(),
        },
        queue: st.schedule.queue.clone(),
        pending_jingles: st.schedule.pending.clone(),
        rules,
        fallback_playlist_id: st.schedule.fallback_playlist.clone(),
        jobs: state.jobs.lock().unwrap().iter().take(10).cloned().collect(),
    }
}

pub fn snapshot(state: &Shared) -> HostSnapshot {
    let live = live_snapshot(state);
    let st = state.station();
    let mut tracks: Vec<HostTrack> = st
        .tracks
        .values()
        .map(|t| HostTrack { artwork_url: t.artwork_url(), track: t.clone() })
        .collect();
    tracks.sort_by_key(|t| std::cmp::Reverse(t.track.added_at));
    HostSnapshot { live, tracks, playlists: st.playlists.clone(), settings: host_settings(&st.settings) }
}

pub async fn get_state(State(state): State<Shared>) -> Json<HostSnapshot> {
    Json(snapshot(&state))
}

/// Light snapshots on every change, at most ~4 per second. Clients re-fetch
/// `/state` when `libraryRev` changes, so large libraries aren't resent constantly.
pub async fn events(State(state): State<Shared>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let changes = tokio_stream::StreamExt::throttle(WatchStream::new(state.changes.subscribe()), Duration::from_millis(250));
    let stream =
        changes.map(move |_| Ok(Event::default().event("live").json_data(live_snapshot(&state)).unwrap_or_default()));
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

fn ok() -> Json<Value> {
    Json(json!({ "ok": true }))
}

// ---------- broadcast ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastBody {
    on_air: bool,
}

pub async fn set_broadcast(State(state): State<Shared>, Json(b): Json<BroadcastBody>) -> ApiResult<Json<Value>> {
    state.engine.on_air.send_replace(b.on_air);
    state.db().put_doc("on_air", &b.on_air)?;
    state.notify();
    Ok(ok())
}

pub async fn skip(State(state): State<Shared>) -> ApiResult<Json<Value>> {
    if state.live().current.is_none() {
        return Err(ApiError::conflict("Nothing is playing"));
    }
    state.engine.skip.store(true, Ordering::SeqCst);
    Ok(ok())
}

// ---------- queue ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackIds {
    track_ids: Vec<String>,
}

fn check_music(st: &crate::state::Station, ids: &[String]) -> ApiResult<()> {
    for id in ids {
        match st.tracks.get(id) {
            Some(t) if t.kind == TrackKind::Music => {}
            Some(_) => return Err(ApiError::bad_request("Only music tracks can be queued or added to playlists")),
            None => return Err(ApiError::not_found("Track")),
        }
    }
    Ok(())
}

/// Replaces the queue order (drag-to-reorder, removals).
pub async fn put_queue(State(state): State<Shared>, Json(b): Json<TrackIds>) -> ApiResult<Json<Value>> {
    let mut st = state.station();
    check_music(&st, &b.track_ids)?;
    st.schedule.queue = b.track_ids;
    state.persist(&st);
    drop(st);
    state.notify();
    Ok(ok())
}

/// Appends tracks (already-queued ones are skipped).
pub async fn append_queue(State(state): State<Shared>, Json(b): Json<TrackIds>) -> ApiResult<Json<Value>> {
    let mut st = state.station();
    check_music(&st, &b.track_ids)?;
    let existing: HashSet<String> = st.schedule.queue.iter().cloned().collect();
    let new: Vec<String> = b.track_ids.into_iter().filter(|id| !existing.contains(id)).collect();
    st.schedule.queue.extend(new);
    state.persist(&st);
    drop(st);
    state.notify();
    Ok(ok())
}

// ---------- playlists ----------

#[derive(Deserialize)]
pub struct NewPlaylist {
    name: String,
}

pub async fn create_playlist(State(state): State<Shared>, Json(b): Json<NewPlaylist>) -> ApiResult<Json<Playlist>> {
    let name = b.name.trim();
    if name.is_empty() || name.len() > 80 {
        return Err(ApiError::bad_request("Playlist name must be 1–80 characters"));
    }
    let p = Playlist { id: uuid::Uuid::new_v4().to_string(), name: name.into(), track_ids: vec![], shuffle: false };
    let mut st = state.station();
    st.playlists.push(p.clone());
    state.persist(&st);
    drop(st);
    state.library_changed();
    Ok(Json(p))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistUpdate {
    name: Option<String>,
    track_ids: Option<Vec<String>>,
    shuffle: Option<bool>,
}

pub async fn update_playlist(
    State(state): State<Shared>,
    Path(id): Path<String>,
    Json(b): Json<PlaylistUpdate>,
) -> ApiResult<Json<Playlist>> {
    let mut st = state.station();
    if let Some(ids) = &b.track_ids {
        check_music(&st, ids)?;
    }
    let p = st.playlists.iter_mut().find(|p| p.id == id).ok_or_else(|| ApiError::not_found("Playlist"))?;
    if let Some(name) = b.name {
        let name = name.trim();
        if name.is_empty() || name.len() > 80 {
            return Err(ApiError::bad_request("Playlist name must be 1–80 characters"));
        }
        p.name = name.into();
    }
    if let Some(ids) = b.track_ids {
        let mut seen = HashSet::new();
        p.track_ids = ids.into_iter().filter(|i| seen.insert(i.clone())).collect();
    }
    if let Some(shuffle) = b.shuffle {
        p.shuffle = shuffle;
    }
    let p = p.clone();
    state.persist(&st);
    drop(st);
    state.library_changed();
    Ok(Json(p))
}

pub async fn delete_playlist(State(state): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let mut st = state.station();
    let before = st.playlists.len();
    st.playlists.retain(|p| p.id != id);
    if st.playlists.len() == before {
        return Err(ApiError::not_found("Playlist"));
    }
    if st.schedule.fallback_playlist.as_deref() == Some(&id) {
        st.schedule.fallback_playlist = None;
    }
    state.persist(&st);
    drop(st);
    state.library_changed();
    Ok(ok())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fallback {
    playlist_id: Option<String>,
}

pub async fn set_fallback(State(state): State<Shared>, Json(b): Json<Fallback>) -> ApiResult<Json<Value>> {
    let mut st = state.station();
    if let Some(id) = &b.playlist_id
        && !st.playlists.iter().any(|p| &p.id == id)
    {
        return Err(ApiError::not_found("Playlist"));
    }
    st.schedule.fallback_playlist = b.playlist_id;
    st.schedule.fallback_cursor = 0;
    state.persist(&st);
    drop(st);
    state.notify();
    Ok(ok())
}

// ---------- jingles ----------

#[derive(Deserialize)]
pub struct Rules {
    rules: Vec<JingleRule>,
}

/// Replaces the ordered rule list. Every jingle in the library must appear once.
pub async fn put_rules(State(state): State<Shared>, Json(b): Json<Rules>) -> ApiResult<Json<Value>> {
    let mut st = state.station();
    let mut seen = HashSet::new();
    for r in &b.rules {
        if !st.tracks.get(&r.jingle_id).is_some_and(|t| t.kind == TrackKind::Jingle) {
            return Err(ApiError::bad_request("Rules may only reference jingles"));
        }
        if !seen.insert(r.jingle_id.clone()) {
            return Err(ApiError::bad_request("Each jingle may only have one rule"));
        }
        if !(1..=500).contains(&r.every_songs) || !(1..=1440).contains(&r.every_minutes) {
            return Err(ApiError::bad_request("Frequencies must be 1–500 songs and 1–1440 minutes"));
        }
    }
    st.schedule.set_rules(b.rules);
    for id in seen {
        st.schedule.counters.entry(id).or_insert_with(Counters::default);
    }
    state.persist(&st);
    drop(st);
    state.notify();
    Ok(ok())
}

// ---------- settings ----------

pub async fn put_settings(State(state): State<Shared>, Json(mut s): Json<Settings>) -> ApiResult<Json<HostSettings>> {
    s.name = s.name.trim().into();
    s.access_code = s.access_code.trim().to_uppercase();
    s.validate().map_err(ApiError::bad_request)?;
    let mut st = state.station();
    // Logos and integration secrets have their own endpoints; keep the stored values.
    s.logo = st.settings.logo.clone();
    s.jamendo_client_id = st.settings.jamendo_client_id.clone();
    let old = std::mem::replace(&mut st.settings, s.clone());
    state.persist(&st);
    drop(st);
    let stream_changed = old.stream_format != s.stream_format || old.bitrate != s.bitrate;
    let access_changed = old.access != s.access || old.access_code != s.access_code;
    if stream_changed || access_changed {
        // Restart the encoder: applies the new format and disconnects listeners
        // so they must reconnect under the new access rules.
        state.engine.restart.store(true, Ordering::SeqCst);
    }
    state.library_changed();
    Ok(Json(host_settings(&s)))
}

// ---------- tracks ----------

#[derive(Serialize)]
pub struct UploadResult {
    imported: Vec<String>,
    rejected: Vec<Rejection>,
}

/// Multipart upload. Send an optional `kind` field ("music" | "jingle") before the `files` fields.
pub async fn upload(State(state): State<Shared>, mut form: Multipart) -> ApiResult<Json<UploadResult>> {
    let mut kind = TrackKind::Music;
    let mut result = UploadResult { imported: vec![], rejected: vec![] };
    while let Some(mut field) = form.next_field().await.map_err(|e| ApiError::bad_request(e.to_string()))? {
        match field.name() {
            Some("kind") => {
                let v = field.text().await.map_err(|e| ApiError::bad_request(e.to_string()))?;
                kind = TrackKind::parse(v.trim()).ok_or_else(|| ApiError::bad_request("kind must be music or jingle"))?;
            }
            Some("files") => {
                let name = field.file_name().unwrap_or("upload").to_string();
                let tmp = import::tmp_path(&state);
                let mut file = tokio::fs::File::create(&tmp).await.map_err(anyhow::Error::from)?;
                while let Some(chunk) = field.chunk().await.map_err(|e| ApiError::bad_request(e.to_string()))? {
                    file.write_all(&chunk).await.map_err(anyhow::Error::from)?;
                }
                file.flush().await.map_err(anyhow::Error::from)?;
                drop(file);
                match import::ingest_file(&state, &tmp, &name, kind, Provenance::files()).await {
                    Ok(id) => result.imported.push(id),
                    Err(reason) => result.rejected.push(Rejection { name, reason }),
                }
            }
            _ => {}
        }
    }
    Ok(Json(result))
}

#[derive(Deserialize)]
pub struct TrackUpdate {
    title: Option<String>,
    artists: Option<Vec<String>>,
    album: Option<String>,
}

pub async fn update_track(
    State(state): State<Shared>,
    Path(id): Path<String>,
    Json(b): Json<TrackUpdate>,
) -> ApiResult<Json<Value>> {
    let mut st = state.station();
    let t = st.tracks.get_mut(&id).ok_or_else(|| ApiError::not_found("Track"))?;
    let clean = |s: String| Some(s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(title) = b.title {
        t.title = clean(title);
    }
    if let Some(album) = b.album {
        t.album = clean(album);
    }
    if let Some(artists) = b.artists {
        t.artists = artists.into_iter().filter_map(clean).collect();
    }
    let t = t.clone();
    drop(st);
    state.db().upsert_track(&t)?;
    state.library_changed();
    Ok(ok())
}

pub async fn delete_track(State(state): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    {
        let live = state.live();
        // The current item, or the previous one still fading out during a crossfade.
        let recent = live.timeline.iter().rev().take(2).any(|e| e.track_id.as_deref() == Some(id.as_str()));
        if recent || live.current.as_ref().is_some_and(|c| c.track_id == id) {
            return Err(ApiError::conflict("This track is on air. Delete it after it finishes."));
        }
    }
    let track = {
        let mut st = state.station();
        let track = st.tracks.remove(&id).ok_or_else(|| ApiError::not_found("Track"))?;
        st.schedule.forget_track(&id);
        for p in &mut st.playlists {
            p.track_ids.retain(|t| t != &id);
        }
        state.persist(&st);
        track
    };
    state.db().delete_track(&id)?;
    let _ = tokio::fs::remove_file(state.config.media_dir().join(&track.file)).await;
    if let Some(a) = &track.artwork {
        let _ = tokio::fs::remove_file(state.config.artwork_dir().join(a)).await;
    }
    state.library_changed();
    Ok(ok())
}

// ---------- imports ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestLibraryBody {
    tracks: usize,
    jingles: usize,
    avg_minutes: u32,
    include_broken: bool,
}

pub async fn import_test_library(
    State(state): State<Shared>,
    Json(b): Json<TestLibraryBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    if !state.station().settings.test_library_enabled {
        return Err(ApiError::bad_request("The Test library source is disabled in settings"));
    }
    if b.tracks + b.jingles == 0 || b.tracks > 500 || b.jingles > 50 || !(1..=15).contains(&b.avg_minutes) {
        return Err(ApiError::bad_request("Use 1–500 tracks, 0–50 jingles and 1–15 minutes"));
    }
    let id = import::start_test_library(
        state.clone(),
        TestLibraryRequest { tracks: b.tracks, jingles: b.jingles, avg_minutes: b.avg_minutes, include_broken: b.include_broken },
    );
    Ok((StatusCode::ACCEPTED, Json(json!({ "jobId": id }))))
}

// ---------- logo ----------

const MAX_LOGO_BYTES: usize = 5 * 1024 * 1024;

/// Multipart `file` field with a PNG/JPEG/WebP/SVG-rasterisable image.
pub async fn upload_logo(State(state): State<Shared>, mut form: Multipart) -> ApiResult<Json<HostSettings>> {
    let mut data = Vec::new();
    while let Some(field) = form.next_field().await.map_err(|e| ApiError::bad_request(e.to_string()))? {
        if field.name() == Some("file") {
            data = field.bytes().await.map_err(|e| ApiError::bad_request(e.to_string()))?.to_vec();
        }
    }
    if data.is_empty() {
        return Err(ApiError::bad_request("No image received"));
    }
    if data.len() > MAX_LOGO_BYTES {
        return Err(ApiError::bad_request("Logo must be 5 MB or smaller"));
    }
    let tmp = import::tmp_path(&state);
    let out = import::tmp_path(&state).with_extension("jpg");
    tokio::fs::write(&tmp, &data).await.map_err(anyhow::Error::from)?;
    let converted = crate::media::make_square_jpeg(&state.config.ffmpeg, &tmp, &out, 256).await;
    let _ = tokio::fs::remove_file(&tmp).await;
    if converted.is_err() {
        let _ = tokio::fs::remove_file(&out).await;
        return Err(ApiError::bad_request("That file isn't an image we can read"));
    }
    let name = format!("{}.jpg", crate::media::sha256_file(&out).await?);
    tokio::fs::rename(&out, state.config.artwork_dir().join(&name)).await.map_err(anyhow::Error::from)?;
    let old = {
        let mut st = state.station();
        let old = st.settings.logo.replace(name.clone());
        state.persist(&st);
        old
    };
    remove_unused_logo(&state, old).await;
    state.library_changed();
    Ok(Json(host_settings(&state.station().settings)))
}

pub async fn delete_logo(State(state): State<Shared>) -> ApiResult<Json<HostSettings>> {
    let old = {
        let mut st = state.station();
        let old = st.settings.logo.take();
        state.persist(&st);
        old
    };
    remove_unused_logo(&state, old).await;
    state.library_changed();
    Ok(Json(host_settings(&state.station().settings)))
}

async fn remove_unused_logo(state: &Shared, old: Option<String>) {
    let Some(old) = old else { return };
    let current = state.station().settings.logo.clone();
    // Artwork shares the directory; never delete a file a track still uses.
    let used_by_track = state.station().tracks.values().any(|t| t.artwork.as_deref() == Some(&old));
    if current.as_deref() != Some(&old) && !used_by_track {
        let _ = tokio::fs::remove_file(state.config.artwork_dir().join(old)).await;
    }
}

// ---------- catalogues ----------

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
}

fn source_enabled(state: &Shared, source: Source) -> ApiResult<()> {
    let st = state.station();
    let enabled = match source {
        Source::InternetArchive => st.settings.internet_archive_enabled,
        Source::Jamendo => st.settings.jamendo_enabled,
    };
    if enabled { Ok(()) } else { Err(ApiError::bad_request(format!("{} is disabled in Settings", source.label()))) }
}

pub async fn catalogue_search(
    State(state): State<Shared>,
    Path(source): Path<Source>,
    Query(q): Query<SearchQuery>,
) -> ApiResult<Json<Vec<CatalogueResult>>> {
    source_enabled(&state, source)?;
    catalogue::search(&state, source, &q.q)
        .await
        .map(Json)
        .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, e.to_string()))
}

#[derive(Deserialize)]
pub struct CatalogueImport {
    source: Source,
    ids: Vec<String>,
}

pub async fn import_catalogue(
    State(state): State<Shared>,
    Json(b): Json<CatalogueImport>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    source_enabled(&state, b.source)?;
    if b.ids.is_empty() || b.ids.len() > 100 {
        return Err(ApiError::bad_request("Select 1–100 items"));
    }
    let id = catalogue::start_import(state.clone(), b.source, b.ids);
    Ok((StatusCode::ACCEPTED, Json(json!({ "jobId": id }))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JamendoKey {
    client_id: String,
}

/// Saves (after verifying) or clears the Jamendo client ID.
pub async fn set_jamendo_key(State(state): State<Shared>, Json(b): Json<JamendoKey>) -> ApiResult<Json<HostSettings>> {
    let key = b.client_id.trim().to_string();
    if !key.is_empty() {
        catalogue::verify_jamendo(&key).await.map_err(|e| ApiError::bad_request(e.to_string()))?;
    }
    let settings = {
        let mut st = state.station();
        st.settings.jamendo_client_id = key;
        state.persist(&st);
        host_settings(&st.settings)
    };
    state.library_changed();
    Ok(Json(settings))
}
