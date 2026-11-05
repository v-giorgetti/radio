//! Bounded, unpaced processing-capacity probes. Timing the live loop would measure
//! its deliberate sleeps and pipe buffering, not how much work the CPU can do.

use std::collections::VecDeque;
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, ensure};
use serde::Serialize;
use tokio::process::Command;

use crate::media::Loudness;
use crate::model::{Settings, StreamFormat, Track};
use crate::state::{Shared, now_ms};

const SAMPLE_MS: u64 = 3_000;
const DEADLINE: Duration = Duration::from_secs(8);
const INTERVAL: Duration = Duration::from_secs(180);
const KEEP: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProbeSource {
    Library,
    Synthetic,
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecoderCalibration {
    pub source: ProbeSource,
    pub samples: usize,
}

impl Default for DecoderCalibration {
    fn default() -> Self {
        Self { source: ProbeSource::Unavailable, samples: 0 }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapacityMeasurement {
    /// Lowest ratio from the last three successful probes of the same profile.
    /// Includes process start-up, decoding, gain, resampling, mixing and encoding.
    pub realtime_factor: f64,
    pub measured_at: i64,
    pub source: ProbeSource,
    pub sample_duration_ms: f64,
    pub crossfade_voices: usize,
    pub sample_count: usize,
    pub stream_format: StreamFormat,
    pub bitrate: u32,
    pub normalize_loudness: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Profile {
    format: StreamFormat,
    bitrate: u32,
    normalize: bool,
    voices: usize,
    source: ProbeSource,
}

#[derive(Default)]
pub struct Capacity {
    pub measurement: Option<CapacityMeasurement>,
    pub running: bool,
    pub error: Option<String>,
    profile: Option<Profile>,
    samples: VecDeque<f64>,
}

impl Capacity {
    fn record(&mut self, profile: Profile, media_ms: f64, elapsed: Duration) -> Result<()> {
        ensure!(media_ms.is_finite() && media_ms > 0.0 && !elapsed.is_zero(), "probe produced no timed audio");
        let factor = media_ms / elapsed.as_secs_f64() / 1000.0;
        ensure!(factor.is_finite() && factor > 0.0, "invalid processing capacity");
        if self.profile.as_ref() != Some(&profile) {
            self.samples.clear();
        }
        self.samples.push_back(factor);
        while self.samples.len() > KEEP {
            self.samples.pop_front();
        }
        self.measurement = Some(CapacityMeasurement {
            realtime_factor: self.samples.iter().copied().fold(f64::INFINITY, f64::min),
            measured_at: now_ms(),
            source: profile.source,
            sample_duration_ms: media_ms,
            crossfade_voices: profile.voices,
            sample_count: self.samples.len(),
            stream_format: profile.format,
            bitrate: profile.bitrate,
            normalize_loudness: profile.normalize,
        });
        self.profile = Some(profile);
        self.error = None;
        Ok(())
    }
}

/// Select real files deterministically, favoring the current item, then longer
/// recordings. Never hold the station mutex while doing process or filesystem I/O.
pub fn library_samples(state: &Shared, limit: usize) -> Vec<Track> {
    let current = state.live().current.as_ref().map(|c| c.track_id.clone());
    let mut tracks: Vec<_> = state.station().tracks.values().cloned().collect();
    tracks.sort_by(|a, b| {
        let a_current = current.as_ref() == Some(&a.id);
        let b_current = current.as_ref() == Some(&b.id);
        b_current.cmp(&a_current).then_with(|| b.duration_ms.cmp(&a.duration_ms)).then_with(|| a.id.cmp(&b.id))
    });
    tracks.into_iter().filter(|t| state.config.media_dir().join(&t.file).is_file()).take(limit).collect()
}

fn gain_db(track: &Track, normalize: bool) -> f64 {
    match (normalize, track.loudness_lufs, track.true_peak_db) {
        (true, Some(lufs), Some(true_peak_db)) => Loudness { lufs, true_peak_db }.gain_db(),
        _ => 0.0,
    }
}

fn configure_codec(cmd: &mut Command, settings: &Settings) {
    let codec = match settings.stream_format {
        StreamFormat::Mp3 => "libmp3lame",
        StreamFormat::Aac => "aac",
        StreamFormat::Opus => "libopus",
    };
    // A single thread per decoder/filter/encoder bounds impact on small shared
    // machines and makes this a conservative single-core capacity estimate.
    cmd.args(["-c:a", codec, "-b:a", &format!("{}k", settings.bitrate), "-threads", "1"]);
    if settings.stream_format == StreamFormat::Opus {
        cmd.args(["-ar", "48000"]);
    }
}

async fn probe(state: &Shared) -> Result<(Profile, f64, Duration)> {
    let settings = state.station().settings.clone();
    let tracks = library_samples(state, 2);
    let voices = if settings.crossfade_ms > 0 { 2 } else { 1 };
    let source = if tracks.is_empty() { ProbeSource::Synthetic } else { ProbeSource::Library };
    let profile =
        Profile { format: settings.stream_format, bitrate: settings.bitrate, normalize: settings.normalize_loudness, voices, source };
    let mut cmd = Command::new(&state.config.ffmpeg);
    cmd.args(["-hide_banner", "-v", "error", "-nostats", "-filter_threads", "1", "-filter_complex_threads", "1"]);
    let mut filters = Vec::new();
    for i in 0..voices {
        let gain = if tracks.is_empty() {
            cmd.args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100"]);
            0.0
        } else {
            let track = &tracks[i % tracks.len()];
            if let Some(start) = track.audio_start_ms.filter(|s| *s > 0) {
                cmd.args(["-ss", &format!("{:.3}", start as f64 / 1000.0)]);
            }
            cmd.args(["-threads", "1", "-i"]).arg(state.config.media_dir().join(&track.file));
            gain_db(track, settings.normalize_loudness)
        };
        filters.push(format!("[{i}:a:0]volume={gain:.2}dB,aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a{i}]"));
    }
    let map = if voices == 2 {
        filters.push("[a0][a1]amix=inputs=2:duration=shortest:weights='0.70710678 0.70710678':normalize=0[mix]".into());
        "[mix]"
    } else {
        "[a0]"
    };
    cmd.args(["-filter_complex", &filters.join(";"), "-map", map, "-vn", "-t", &format!("{:.3}", SAMPLE_MS as f64 / 1000.0)]);
    configure_codec(&mut cmd, &settings);
    cmd.args(["-progress", "pipe:1", "-f", "null", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let started = Instant::now();
    // No `-re` and no live-loop sleeps: elapsed is actual unpaced work, including
    // process startup. Dropping a timed-out child kills it, preventing probe overlap.
    let output = tokio::time::timeout(DEADLINE, cmd.output()).await.context("processing probe timed out")??;
    let elapsed = started.elapsed();
    ensure!(output.status.success(), "processing probe failed");
    let media_ms = parsed_duration_ms(&output.stdout).context("probe produced no timed audio")?;
    Ok((profile, media_ms, elapsed))
}

fn parsed_duration_ms(progress: &[u8]) -> Option<f64> {
    String::from_utf8_lossy(progress)
        .lines()
        .filter_map(|line| line.strip_prefix("out_time_us=")?.trim().parse::<u64>().ok())
        .next_back()
        .filter(|us| *us > 0)
        .map(|us| us as f64 / 1000.0)
}

async fn measure(state: &Shared) {
    state.capacity.lock().unwrap().running = true;
    state.notify();
    let result = probe(state).await;
    {
        let mut capacity = state.capacity.lock().unwrap();
        capacity.running = false;
        match result.and_then(|(profile, ms, elapsed)| capacity.record(profile, ms, elapsed)) {
            Ok(()) => {
                let measurement = capacity.measurement.as_ref().expect("recorded capacity");
                tracing::info!(factor = measurement.realtime_factor, source = ?measurement.source, voices = measurement.crossfade_voices, "processing capacity measured");
            }
            Err(error) => {
                tracing::warn!("processing capacity unavailable: {error:#}");
                // Preserve an earlier measurement with its original timestamp,
                // and signal failure instead of inventing a safe-looking ratio.
                capacity.error = Some("Capacity measurement unavailable; the probe failed or exceeded its time limit.".into());
            }
        }
    }
    state.notify();
}

/// Serial low-duty-cycle probes, independent of live audio. Skip periodic work
/// while off air; the initial probe still establishes deployment-time capacity.
pub async fn run(state: Shared) {
    measure(&state).await;
    loop {
        tokio::time::sleep(INTERVAL).await;
        if *state.engine.on_air.borrow() {
            measure(&state).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::db::Db;
    use crate::model::TrackKind;
    use crate::state::AppState;

    fn test_state(dir: &std::path::Path) -> Shared {
        AppState::new(
            Config {
                bind: "127.0.0.1:0".parse().unwrap(),
                data_dir: dir.to_path_buf(),
                host_password: None,
                reset_password: false,
                ffmpeg: "ffmpeg".into(),
                ffprobe: "ffprobe".into(),
                listener_dist: None,
                host_dist: None,
                secure_cookies: false,
            },
            Db::in_memory().unwrap(),
            String::new(),
        )
        .unwrap()
    }

    fn add_fixture(state: &Shared) {
        std::fs::create_dir_all(state.config.media_dir()).unwrap();
        std::fs::write(state.config.media_dir().join("tone.mp3"), include_bytes!("../tests/fixtures/tone.mp3")).unwrap();
        let track = Track {
            id: "fixture".into(),
            kind: TrackKind::Music,
            title: Some("Fixture tone".into()),
            artists: Vec::new(),
            album: None,
            duration_ms: 2000,
            file: "tone.mp3".into(),
            artwork: None,
            source: "test".into(),
            source_id: None,
            licence: None,
            attribution_url: None,
            content_hash: "fixture".into(),
            added_at: 0,
            loudness_lufs: Some(-20.0),
            true_peak_db: Some(-8.0),
            audio_start_ms: Some(0),
            audio_end_ms: Some(2000),
        };
        state.station().tracks.insert(track.id.clone(), track);
    }

    fn profile(source: ProbeSource, voices: usize) -> Profile {
        Profile { format: StreamFormat::Mp3, bitrate: 128, normalize: true, voices, source }
    }

    #[test]
    fn capacity_uses_actual_media_duration_and_conservative_recent_window() {
        let mut capacity = Capacity::default();
        let p = profile(ProbeSource::Library, 2);
        capacity.record(p.clone(), 3000.0, Duration::from_millis(600)).unwrap();
        assert_eq!(capacity.measurement.as_ref().unwrap().realtime_factor, 5.0);
        capacity.record(p.clone(), 3000.0, Duration::from_millis(1200)).unwrap();
        assert_eq!(capacity.measurement.as_ref().unwrap().realtime_factor, 2.5);
        for _ in 0..KEEP {
            capacity.record(p.clone(), 3000.0, Duration::from_millis(300)).unwrap();
        }
        assert_eq!(capacity.measurement.as_ref().unwrap().realtime_factor, 10.0);
        assert_eq!(capacity.measurement.as_ref().unwrap().sample_count, KEEP);
        capacity.record(p, 500.0, Duration::from_millis(1000)).unwrap();
        assert_eq!(capacity.measurement.as_ref().unwrap().realtime_factor, 0.5, "short or slow clips must not be called realtime-safe");
    }

    #[test]
    fn incompatible_probe_profiles_do_not_share_measurements() {
        let mut capacity = Capacity::default();
        capacity.record(profile(ProbeSource::Synthetic, 1), 3000.0, Duration::from_millis(1000)).unwrap();
        capacity.record(profile(ProbeSource::Library, 2), 3000.0, Duration::from_millis(300)).unwrap();
        let latest = capacity.measurement.as_ref().unwrap();
        assert_eq!(latest.realtime_factor, 10.0);
        assert_eq!(latest.source, ProbeSource::Library);
        assert_eq!(latest.crossfade_voices, 2);
        assert_eq!(latest.sample_count, 1);
    }

    #[test]
    fn absent_or_invalid_timing_does_not_create_headroom() {
        let mut capacity = Capacity::default();
        assert!(capacity.record(profile(ProbeSource::Library, 1), f64::NAN, Duration::from_secs(1)).is_err());
        assert!(capacity.record(profile(ProbeSource::Library, 1), 0.0, Duration::from_secs(1)).is_err());
        assert!(capacity.record(profile(ProbeSource::Library, 1), 3000.0, Duration::ZERO).is_err());
        assert!(capacity.measurement.is_none());
        assert_eq!(parsed_duration_ms(b"out_time_us=200000\nprogress=continue\nout_time_us=750000\nprogress=end\n"), Some(750.0));
        assert_eq!(parsed_duration_ms(b"out_time_us=N/A\n"), None);
        assert_eq!(parsed_duration_ms(b"out_time_us=0\n"), None);
    }

    #[tokio::test]
    async fn real_library_probe_encodes_each_supported_format_and_uses_actual_duration() {
        // ffmpeg/ffprobe are runtime prerequisites of this application.
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path());
        add_fixture(&state);
        for format in [StreamFormat::Mp3, StreamFormat::Aac, StreamFormat::Opus] {
            {
                let mut station = state.station();
                station.settings.stream_format = format;
                station.settings.bitrate = format.bitrates()[0];
                station.settings.crossfade_ms = 3000;
            }
            let (profile, ms, elapsed) = probe(&state).await.unwrap();
            assert_eq!(profile.source, ProbeSource::Library);
            assert_eq!(profile.voices, 2);
            assert_eq!(profile.format, format);
            assert!(ms > 1900.0 && ms < 2500.0, "use actual encoded duration, not the requested 3 seconds: {ms}");
            assert!(!elapsed.is_zero());
        }
        state.station().settings.crossfade_ms = 0;
        let (profile, _, _) = probe(&state).await.unwrap();
        assert_eq!(profile.voices, 1);
    }

    #[tokio::test]
    async fn boot_calibration_uses_real_library_and_reports_fallback_and_failure() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = test_state(dir.path());
        add_fixture(&state);
        crate::engine::calibrate(&state).await;
        assert_eq!(state.decoder_calibration.lock().unwrap().source, ProbeSource::Library);
        assert_eq!(state.decoder_calibration.lock().unwrap().samples, 1);
        state.station().tracks.clear();
        crate::engine::calibrate(&state).await;
        assert_eq!(state.decoder_calibration.lock().unwrap().source, ProbeSource::Synthetic);
        assert_eq!(state.decoder_calibration.lock().unwrap().samples, 3);
        let (profile, ms, _) = probe(&state).await.unwrap();
        assert_eq!(profile.source, ProbeSource::Synthetic);
        assert!((ms - SAMPLE_MS as f64).abs() < 100.0);
        // An ffmpeg failure must not claim that calibration or capacity succeeded.
        std::sync::Arc::get_mut(&mut state).unwrap().config.ffmpeg = dir.path().join("missing-ffmpeg");
        crate::engine::calibrate(&state).await;
        assert_eq!(state.decoder_calibration.lock().unwrap().source, ProbeSource::Unavailable);
        assert_eq!(state.decoder_calibration.lock().unwrap().samples, 0);
        measure(&state).await;
        let snapshot = serde_json::to_value(crate::api::host::live_snapshot(&state)).unwrap();
        assert!(snapshot["live"]["processingHeadroom"].is_null());
        assert_eq!(snapshot["live"]["processingProbeRunning"], false);
        assert!(snapshot["live"]["processingProbeError"].is_string());
        assert!(snapshot["live"]["decoderLeadMs"].as_u64().unwrap() >= 200);
    }
}
