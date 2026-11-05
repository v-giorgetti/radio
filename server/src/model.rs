//! Domain types shared by the scheduler, persistence and API.

use serde::{Deserialize, Serialize};

pub type TrackId = String;
pub type PlaylistId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    Music,
    Jingle,
}

impl TrackKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TrackKind::Music => "music",
            TrackKind::Jingle => "jingle",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "music" => Some(TrackKind::Music),
            "jingle" => Some(TrackKind::Jingle),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: TrackId,
    pub kind: TrackKind,
    pub title: Option<String>,
    pub artists: Vec<String>,
    pub album: Option<String>,
    pub duration_ms: u64,
    /// File name inside the media directory. Never exposed publicly.
    #[serde(skip_serializing)]
    pub file: String,
    /// File name inside the artwork directory.
    #[serde(skip_serializing)]
    pub artwork: Option<String>,
    /// Provenance.
    pub source: String,
    pub source_id: Option<String>,
    pub licence: Option<String>,
    pub attribution_url: Option<String>,
    pub content_hash: String,
    pub added_at: i64,
    /// EBU R128 integrated loudness (LUFS) and true peak (dBTP), measured at import.
    pub loudness_lufs: Option<f64>,
    pub true_peak_db: Option<f64>,
    /// Audible region (silence trimmed), measured at import. Used for transitions.
    pub audio_start_ms: Option<u64>,
    pub audio_end_ms: Option<u64>,
}

impl Track {
    pub fn artwork_url(&self) -> Option<String> {
        self.artwork.as_ref().map(|a| format!("/media/artwork/{a}"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrequencyUnit {
    Songs,
    Minutes,
    Both,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JingleRule {
    pub jingle_id: TrackId,
    pub enabled: bool,
    pub unit: FrequencyUnit,
    pub every_songs: u32,
    pub every_minutes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: PlaylistId,
    pub name: String,
    pub track_ids: Vec<TrackId>,
    pub shuffle: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ListenerAccess {
    Public,
    Private,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamFormat {
    Mp3,
    Aac,
    Opus,
}

impl StreamFormat {
    pub fn content_type(self) -> &'static str {
        match self {
            StreamFormat::Mp3 => "audio/mpeg",
            StreamFormat::Aac => "audio/aac",
            StreamFormat::Opus => "audio/ogg",
        }
    }
    pub fn bitrates(self) -> &'static [u32] {
        match self {
            StreamFormat::Mp3 => &[128, 192, 256],
            StreamFormat::Aac => &[96, 128, 192],
            StreamFormat::Opus => &[64, 96, 128],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub name: String,
    pub description: String,
    pub accent: String,
    pub logo: Option<String>,
    pub access: ListenerAccess,
    pub access_code: String,
    pub stream_format: StreamFormat,
    pub bitrate: u32,
    /// Adjust playback gain towards a common loudness target.
    pub normalize_loudness: bool,
    /// Shown to listeners instead of a jingle's file title. `{station}` = station name.
    pub jingle_message: String,
    /// Crossfade between consecutive music tracks (0 = hard cut). Jingle boundaries use at most 1 s.
    pub crossfade_ms: u32,
    pub test_library_enabled: bool,
    pub internet_archive_enabled: bool,
    pub jamendo_enabled: bool,
    /// Secret. Never sent to browsers (the host view only sees whether it is set).
    pub jamendo_client_id: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            name: "My Station".into(),
            description: "An always-on mix.".into(),
            accent: "#2b59ff".into(),
            logo: None,
            access: ListenerAccess::Public,
            access_code: String::new(),
            stream_format: StreamFormat::Mp3,
            bitrate: 128,
            normalize_loudness: true,
            crossfade_ms: 3000,
            jingle_message: "You're listening to {station}".into(),
            test_library_enabled: true,
            internet_archive_enabled: true,
            jamendo_enabled: true,
            jamendo_client_id: String::new(),
        }
    }
}

impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() || self.name.len() > 80 {
            return Err("Station name must be 1–80 characters.".into());
        }
        if self.description.len() > 200 {
            return Err("Description must be at most 200 characters.".into());
        }
        let hex = self.accent.strip_prefix('#').unwrap_or("");
        if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("Accent must be a 6-digit hex colour like #2b59ff.".into());
        }
        if self.jingle_message.trim().is_empty() || self.jingle_message.len() > 120 {
            return Err("Jingle message must be 1–120 characters.".into());
        }
        if self.crossfade_ms > 10_000 {
            return Err("Crossfade must be between 0 and 10 seconds.".into());
        }
        let allowed = self.stream_format.bitrates();
        if !allowed.contains(&self.bitrate) {
            return Err(format!("Bitrate must be one of {allowed:?} kbps for this format."));
        }
        if self.access == ListenerAccess::Private && self.access_code.trim().len() < 6 {
            return Err("Private stations need an access code of at least 6 characters.".into());
        }
        Ok(())
    }
}
