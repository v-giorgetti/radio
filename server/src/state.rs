//! Shared application state: the in-memory station (source of truth, persisted
//! write-through to SQLite), live broadcast status, the audio hub and sessions.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use serde::Serialize;
use tokio::sync::{broadcast, watch};

use crate::config::Config;
use crate::db::Db;
use crate::model::{Playlist, Settings, StreamFormat, Track, TrackId};
use crate::scheduler::Schedule;

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub struct Station {
    pub tracks: HashMap<TrackId, Track>,
    pub schedule: Schedule,
    pub playlists: Vec<Playlist>,
    pub settings: Settings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Current {
    /// Unique per play, so repeated tracks still count as a new item.
    pub play_id: u64,
    pub track_id: TrackId,
    /// Wall-clock time (ms) at which this item plays in real time.
    pub started_at: i64,
    /// Position in the stream's media timeline (ms of audio since the encoder started).
    pub media_start_ms: f64,
}

/// One entry of the recent on-air history (an item, or idle silence).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEntry {
    pub play_id: u64,
    pub track_id: Option<TrackId>,
    pub started_at: i64,
    pub media_start_ms: f64,
}

/// Enough history to cover the largest start-up burst any listener can request.
pub const TIMELINE_LEN: usize = 16;

#[derive(Debug, Clone, Default)]
pub struct Live {
    pub on_air_since: Option<i64>,
    /// The item the engine most recently started (ahead of real time by the decoder lead).
    pub current: Option<Current>,
    /// Recent items with their media positions; listeners pick the one they're hearing.
    pub timeline: VecDeque<TimelineEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportJob {
    pub id: String,
    pub source: String,
    pub label: String,
    pub total: usize,
    pub done: usize,
    pub imported: usize,
    pub rejected: Vec<Rejection>,
    pub finished: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rejection {
    pub name: String,
    pub reason: String,
}

/// A whole encoded frame/page with its exact position in the media timeline.
#[derive(Clone)]
pub struct Chunk {
    pub media_start_ms: f64,
    pub bytes: Bytes,
}

/// Fan-out of the encoded stream. One encoder, many listeners.
pub struct Hub {
    pub tx: Mutex<Option<broadcast::Sender<Bytes>>>,
    /// Recent frames; each new listener gets the most recent `burst` of them.
    pub history: Mutex<VecDeque<Chunk>>,
    /// Container headers every listener needs first (Ogg Opus: OpusHead + OpusTags pages).
    pub headers: Mutex<Vec<Bytes>>,
    pub format: Mutex<StreamFormat>,
    pub listeners: AtomicUsize,
    /// Media position (ms) at the end of the newest published frame.
    pub media_end_ms: Mutex<f64>,
    /// Increments with every encoder session; media positions restart at 0 each time.
    pub epoch: AtomicU64,
    /// Listener connection id → media position of the first frame it received.
    pub connections: Mutex<HashMap<String, f64>>,
}

/// Upper bound for the start-up burst a listener may request (memory bound).
pub const HISTORY_MS: f64 = 6_000.0;

impl Hub {
    pub fn publish(&self, media_start_ms: f64, duration_ms: f64, bytes: Bytes) {
        let end = media_start_ms + duration_ms;
        {
            let mut history = self.history.lock().unwrap();
            history.push_back(Chunk { media_start_ms, bytes: bytes.clone() });
            while history.front().is_some_and(|c| c.media_start_ms < end - HISTORY_MS) {
                history.pop_front();
            }
            *self.media_end_ms.lock().unwrap() = end;
            if let Some(tx) = self.tx.lock().unwrap().as_ref() {
                let _ = tx.send(bytes);
            }
        }
    }
}

pub struct Engine {
    /// Desired on-air state, set by the host.
    pub on_air: watch::Sender<bool>,
    /// End the current item now (host "skip").
    pub skip: AtomicBool,
    /// Restart the encoder (stream format changed).
    pub restart: AtomicBool,
}

pub struct AppState {
    pub config: Config,
    db: Mutex<Db>,
    station: Mutex<Station>,
    live: Mutex<Live>,
    pub hub: Hub,
    pub engine: Engine,
    /// Bumped on every observable change; SSE handlers rebuild snapshots from it.
    pub changes: watch::Sender<u64>,
    pub jobs: Mutex<Vec<ImportJob>>,
    pub play_counter: AtomicU64,
    /// Measured decoder start-up latency → how far ahead of real time to feed.
    pub lead: Mutex<crate::engine::LeadEstimator>,
    pub decoder_calibration: Mutex<crate::capacity::DecoderCalibration>,
    pub capacity: Mutex<crate::capacity::Capacity>,
    /// Bumped when tracks, playlists or settings change (clients re-fetch the full state).
    pub library_rev: AtomicU64,
    /// Argon2 PHC string of the host password.
    pub password_hash: Mutex<String>,
}

pub type Shared = Arc<AppState>;

impl AppState {
    pub fn new(config: Config, db: Db, password_hash: String) -> anyhow::Result<Shared> {
        let tracks = db.load_tracks()?.into_iter().map(|t| (t.id.clone(), t)).collect();
        let schedule: Schedule = db.get_doc("schedule")?.unwrap_or_default();
        let playlists: Vec<Playlist> = db.get_doc("playlists")?.unwrap_or_default();
        let settings: Settings = db.get_doc("settings")?.unwrap_or_default();
        let on_air_saved: bool = db.get_doc("on_air")?.unwrap_or(false);
        let format = settings.stream_format;
        Ok(Arc::new(Self {
            config,
            db: Mutex::new(db),
            station: Mutex::new(Station { tracks, schedule, playlists, settings }),
            live: Mutex::new(Live::default()),
            hub: Hub {
                tx: Mutex::new(None),
                history: Mutex::new(VecDeque::new()),
                headers: Mutex::new(Vec::new()),
                media_end_ms: Mutex::new(0.0),
                epoch: AtomicU64::new(0),
                connections: Mutex::new(HashMap::new()),
                format: Mutex::new(format),
                listeners: AtomicUsize::new(0),
            },
            engine: Engine { on_air: watch::Sender::new(on_air_saved), skip: AtomicBool::new(false), restart: AtomicBool::new(false) },
            changes: watch::Sender::new(0),
            jobs: Mutex::new(Vec::new()),
            play_counter: AtomicU64::new(0),
            lead: Mutex::new(crate::engine::LeadEstimator::default()),
            decoder_calibration: Mutex::new(crate::capacity::DecoderCalibration::default()),
            capacity: Mutex::new(crate::capacity::Capacity::default()),
            library_rev: AtomicU64::new(1),
            password_hash: Mutex::new(password_hash),
        }))
    }

    pub fn station(&self) -> MutexGuard<'_, Station> {
        self.station.lock().unwrap()
    }
    pub fn live(&self) -> MutexGuard<'_, Live> {
        self.live.lock().unwrap()
    }
    pub fn db(&self) -> MutexGuard<'_, Db> {
        self.db.lock().unwrap()
    }

    pub fn notify(&self) {
        self.changes.send_modify(|v| *v += 1);
    }

    /// Tracks, playlists or settings changed.
    pub fn library_changed(&self) {
        self.library_rev.fetch_add(1, Ordering::SeqCst);
        self.notify();
    }

    pub fn listeners(&self) -> usize {
        self.hub.listeners.load(Ordering::Relaxed)
    }

    /// Persists the documents that can change at runtime.
    pub fn persist(&self, st: &Station) {
        let db = self.db();
        for result in [
            db.put_doc("schedule", &st.schedule),
            db.put_doc("playlists", &st.playlists),
            db.put_doc("settings", &st.settings),
        ] {
            if let Err(e) = result {
                tracing::error!("failed to persist station state: {e:#}");
            }
        }
    }
}
