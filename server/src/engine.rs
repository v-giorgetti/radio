//! The broadcaster: one long-running encoder fed with real-time paced PCM.
//!
//!   track file ─ffmpeg decode─► PCM ─┐
//!   silence (idle) ──────────────────┼─► pacer ─► ffmpeg encode (one process) ─► Hub ─► listeners
//!   next track …  ──────────────────┘
//!
//! Because the encoder never restarts between items, the stream is continuous
//! across music/jingle boundaries. Listener actions never affect this loop.

use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use bytes::Bytes;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{broadcast, watch};

use crate::media::{Framing, FrameSplitter, Loudness};
use crate::model::{StreamFormat, Track, TrackKind};
use crate::state::{Current, Shared, TIMELINE_LEN, TimelineEntry, now_ms};

const SAMPLE_RATE: u64 = 44_100;
const BYTES_PER_MS_X10: u64 = SAMPLE_RATE * 2 * 2 / 100; // bytes per 10 ms
const CHUNK_MS: u64 = 100;

/// How far ahead of real time the encoder is fed, derived from measured decoder
/// start-up latency on this machine (so a new track's decoder is always ready in time).
#[derive(Default)]
pub struct LeadEstimator {
    /// Recent "spawn → first chunk decoded" latencies, ms.
    samples: std::collections::VecDeque<u64>,
}

impl LeadEstimator {
    const KEEP: usize = 32;

    pub fn record(&mut self, ms: u64) {
        self.samples.push_back(ms);
        while self.samples.len() > Self::KEEP {
            self.samples.pop_front();
        }
    }

    /// Worst recent start-up time plus one chunk of slack; never less than two chunks.
    pub fn lead_ms(&self) -> u64 {
        let worst = self.samples.iter().copied().max().unwrap_or(0);
        (worst + CHUNK_MS).max(2 * CHUNK_MS)
    }
}

/// Measures the actual decoder path with real library files at boot. Fall back to
/// synthetic silence only if there are no readable files or every real probe fails.
pub async fn calibrate(state: &Shared) {
    use crate::capacity::{DecoderCalibration, ProbeSource, library_samples};

    let tracks = library_samples(state, 3);
    let mut samples = 0;
    for track in &tracks {
        // Voice::start applies exactly the same seek, gain and PCM conversion as
        // live playback. read_into records spawn→first chunk in LeadEstimator.
        let attempt = async {
            let mut voice = Voice::start(state, track.clone(), 0)?;
            let mut mix = vec![0.0; FRAMES_PER_CHUNK * 2];
            anyhow::ensure!(voice.read_into(state, &mut mix).await? > 0, "no decoded audio");
            Ok::<_, anyhow::Error>(())
        };
        if matches!(tokio::time::timeout(Duration::from_secs(3), attempt).await, Ok(Ok(()))) {
            samples += 1;
        }
    }
    let source = if samples > 0 {
        ProbeSource::Library
    } else {
        for _ in 0..3 {
            if let Some(ms) = synthetic_startup(state).await {
                state.lead.lock().unwrap().record(ms);
                samples += 1;
            }
        }
        if samples > 0 { ProbeSource::Synthetic } else { ProbeSource::Unavailable }
    };
    *state.decoder_calibration.lock().unwrap() = DecoderCalibration { source, samples };
    tracing::info!(?source, samples, "decoder lead calibrated to {} ms", state.lead.lock().unwrap().lead_ms());
}

async fn synthetic_startup(state: &Shared) -> Option<u64> {
    let attempt = async {
        let started = Instant::now();
        let mut decoder = Command::new(&state.config.ffmpeg)
            .args(["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "0.2"])
            .args(["-f", "s16le", "pipe:1"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .ok()?;
        let mut out = decoder.stdout.take()?;
        let mut pcm = vec![0; FRAMES_PER_CHUNK * 4];
        out.read_exact(&mut pcm).await.ok()?;
        Some(started.elapsed().as_millis() as u64)
    };
    tokio::time::timeout(Duration::from_secs(3), attempt).await.ok().flatten()
}

enum Outcome {
    Stop,
    Restart,
}

pub async fn run(state: Shared) {
    let mut on_air = state.engine.on_air.subscribe();
    loop {
        while !*on_air.borrow_and_update() {
            if on_air.changed().await.is_err() {
                return;
            }
        }
        match session(&state, &on_air).await {
            Ok(()) => {}
            Err(e) => {
                tracing::error!("broadcast session failed: {e:#}");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

fn spawn_encoder(state: &Shared, format: StreamFormat, bitrate: u32) -> Result<Child> {
    let mut cmd = Command::new(&state.config.ffmpeg);
    cmd.args(["-hide_banner", "-v", "error", "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", "pipe:0"]);
    match format {
        StreamFormat::Mp3 => cmd.args(["-c:a", "libmp3lame", "-b:a", &format!("{bitrate}k"), "-write_xing", "0", "-f", "mp3"]),
        StreamFormat::Aac => cmd.args(["-c:a", "aac", "-b:a", &format!("{bitrate}k"), "-f", "adts"]),
        // Short Ogg pages keep latency low; new listeners get the header pages first.
        StreamFormat::Opus => cmd.args([
            "-c:a", "libopus", "-b:a", &format!("{bitrate}k"), "-ar", "48000", "-f", "ogg", "-page_duration", "200000",
        ]),
    };
    cmd.args(["-flush_packets", "1", "pipe:1"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    cmd.spawn().context("starting ffmpeg encoder (is ffmpeg installed?)")
}

struct Pacer {
    start: Instant,
    sent_ms: u64,
}

impl Pacer {
    fn new() -> Self {
        Self { start: Instant::now(), sent_ms: 0 }
    }

    /// Media position (ms) that is playing in real time right now.
    fn realtime_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }

    async fn wait(&mut self, chunk_ms: u64, lead_ms: u64) {
        let now = Instant::now();
        let due = self.start + Duration::from_millis(self.sent_ms.saturating_sub(lead_ms));
        if now > due + Duration::from_millis(lead_ms.max(1000) * 2) {
            // We stalled (e.g. machine asleep). Re-anchor instead of bursting.
            self.start = now - Duration::from_millis(self.sent_ms.saturating_sub(lead_ms));
        } else if due > now {
            tokio::time::sleep_until(due.into()).await;
        }
        self.sent_ms += chunk_ms;
    }
}

struct Feed<'a> {
    state: &'a Shared,
    on_air: &'a watch::Receiver<bool>,
    stdin: ChildStdin,
    pacer: Pacer,
}

impl Feed<'_> {
    fn interrupted(&self) -> Option<Outcome> {
        if !*self.on_air.borrow() {
            return Some(Outcome::Stop);
        }
        if self.state.engine.restart.swap(false, Ordering::SeqCst) {
            return Some(Outcome::Restart);
        }
        None
    }

    async fn write(&mut self, pcm: &[u8]) -> Result<()> {
        let ms = (pcm.len() as u64 * 10 / BYTES_PER_MS_X10).max(1);
        let lead = self.state.lead.lock().unwrap().lead_ms();
        self.pacer.wait(ms, lead).await;
        self.stdin.write_all(pcm).await.context("encoder input closed")?;
        self.state.station().schedule.advance_time(ms);
        Ok(())
    }

    async fn silence(&mut self, ms: u64) -> Result<()> {
        let zeros = vec![0u8; (BYTES_PER_MS_X10 * ms / 10) as usize & !3];
        self.write(&zeros).await
    }

    /// Writes mixed float samples (interleaved stereo, ±1.0 full scale) as s16le.
    async fn write_f32(&mut self, samples: &[f32]) -> Result<()> {
        let mut pcm = Vec::with_capacity(samples.len() * 2);
        for &x in samples {
            let v = (x * 32767.0).round().clamp(-32768.0, 32767.0) as i16;
            pcm.extend_from_slice(&v.to_le_bytes());
        }
        self.write(&pcm).await
    }
}

// ---------------- transitions ----------------

const RATE: u64 = 44_100;
const FRAMES_PER_CHUNK: usize = (RATE * CHUNK_MS / 1000) as usize;
/// Tiny fade at every start so trimmed/seeked audio never clicks.
const CLICK_GUARD_MS: u64 = 15;
/// Jingle boundaries fade quickly so idents stay intelligible.
const JINGLE_FADE_MAX_MS: u64 = 1_000;
/// "Skip" fades the current item out over this long instead of cutting it.
pub const SKIP_FADE_MS: u64 = 800;

/// Gain at `t_ms` into a voice: equal-power (sine/cosine) fade-in and fade-out.
pub fn envelope(t_ms: f64, fade_in_ms: u64, fade_out: Option<(u64, u64)>) -> f32 {
    use std::f64::consts::FRAC_PI_2;
    let mut g = 1.0f64;
    if fade_in_ms > 0 && t_ms < fade_in_ms as f64 {
        g *= (t_ms / fade_in_ms as f64 * FRAC_PI_2).sin();
    }
    if let Some((start, len)) = fade_out
        && t_ms >= start as f64
    {
        let x = if len == 0 { 1.0 } else { ((t_ms - start as f64) / len as f64).min(1.0) };
        if x >= 1.0 {
            return 0.0;
        }
        g *= (x * FRAC_PI_2).cos();
    }
    g.max(0.0) as f32
}

/// Crossfade length between two consecutive items.
pub fn transition_ms(setting_ms: u64, outgoing: &Track, incoming: &Track) -> u64 {
    if setting_ms == 0 {
        return 0;
    }
    let jingle = outgoing.kind == TrackKind::Jingle || incoming.kind == TrackKind::Jingle;
    let x = if jingle { setting_ms.min(JINGLE_FADE_MAX_MS) } else { setting_ms };
    // Never more than half of either item.
    x.min(audible_ms(outgoing) / 2).min(audible_ms(incoming) / 2)
}

fn audible_ms(t: &Track) -> u64 {
    match (t.audio_start_ms, t.audio_end_ms) {
        (Some(s), Some(e)) if e > s => e - s,
        _ => t.duration_ms,
    }
}

/// One track being decoded, with its gain envelope.
struct Voice {
    track: Track,
    spawned: Option<Instant>,
    _decoder: tokio::process::Child,
    out: tokio::process::ChildStdout,
    /// Position within the audible region, in ms.
    pos_ms: f64,
    length_ms: u64,
    fade_in_ms: u64,
    fade_out: Option<(u64, u64)>,
    eof: bool,
    bytes: Vec<u8>,
}

impl Voice {
    fn start(state: &Shared, track: Track, fade_in_ms: u64) -> Result<Self> {
        let path = state.config.media_dir().join(&track.file);
        let normalize = state.station().settings.normalize_loudness;
        let gain = match (normalize, track.loudness_lufs, track.true_peak_db) {
            (true, Some(lufs), Some(true_peak_db)) => Loudness { lufs, true_peak_db }.gain_db(),
            _ => 0.0,
        };
        let mut cmd = Command::new(&state.config.ffmpeg);
        cmd.args(["-hide_banner", "-v", "error"]);
        // Skip leading silence and stop at the end of the audible region.
        if let Some(start) = track.audio_start_ms.filter(|s| *s > 0) {
            cmd.args(["-ss", &format!("{:.3}", start as f64 / 1000.0)]);
        }
        cmd.arg("-i").arg(&path);
        if let (Some(start), Some(end)) = (track.audio_start_ms, track.audio_end_ms) {
            cmd.args(["-t", &format!("{:.3}", end.saturating_sub(start) as f64 / 1000.0)]);
        }
        let mut decoder = cmd
            .args(["-vn", "-af", &format!("volume={gain:.2}dB")])
            .args(["-f", "s16le", "-ar", "44100", "-ac", "2", "pipe:1"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("starting decoder")?;
        let out = decoder.stdout.take().context("decoder stdout")?;
        Ok(Self {
            length_ms: audible_ms(&track),
            spawned: Some(Instant::now()),
            track,
            _decoder: decoder,
            out,
            pos_ms: 0.0,
            fade_in_ms: fade_in_ms.max(CLICK_GUARD_MS),
            fade_out: None,
            eof: false,
            bytes: vec![0u8; FRAMES_PER_CHUNK * 4],
        })
    }

    fn remaining_ms(&self) -> u64 {
        let end = match self.fade_out {
            Some((s, l)) => (s + l).min(self.length_ms),
            None => self.length_ms,
        };
        end.saturating_sub(self.pos_ms as u64)
    }

    /// Fade out over the next `ms`, then end.
    fn fade_out_over(&mut self, ms: u64) {
        let now = self.pos_ms as u64;
        let current_end = self.fade_out.map(|(s, l)| s + l);
        if current_end.is_none_or(|e| now + ms < e) {
            self.fade_out = Some((now, ms));
        }
    }

    /// Adds up to one chunk of enveloped audio into `mix`. Returns frames produced.
    async fn read_into(&mut self, state: &Shared, mix: &mut [f32]) -> Result<usize> {
        if self.eof {
            return Ok(0);
        }
        let mut filled = 0;
        while filled < self.bytes.len() {
            let n = self.out.read(&mut self.bytes[filled..]).await?;
            if n == 0 {
                self.eof = true;
                break;
            }
            filled += n;
        }
        if let Some(spawned) = self.spawned.take()
            && filled > 0
        {
            // Measured start-up latency feeds the lead estimate.
            state.lead.lock().unwrap().record(spawned.elapsed().as_millis() as u64);
        }
        let available = filled / 4;
        let ms_per_frame = 1000.0 / RATE as f64;
        let mut frames = 0;
        while frames < available {
            let i = frames;
            let t = self.pos_ms + i as f64 * ms_per_frame;
            if let Some((s, l)) = self.fade_out
                && t >= (s + l) as f64
            {
                self.eof = true; // faded out completely: this voice is done
                break;
            }
            let g = envelope(t, self.fade_in_ms, self.fade_out);
            let b = &self.bytes[i * 4..i * 4 + 4];
            mix[i * 2] += f32::from(i16::from_le_bytes([b[0], b[1]])) / 32768.0 * g;
            mix[i * 2 + 1] += f32::from(i16::from_le_bytes([b[2], b[3]])) / 32768.0 * g;
            frames += 1;
        }
        self.pos_ms += frames as f64 * ms_per_frame;
        Ok(frames)
    }
}

/// Records where an item (or idle silence) starts in the media timeline. Its first
/// sample is the next one written, which plays in real time `ahead` ms from now.
fn announce(state: &Shared, pacer: &Pacer, track: Option<&Track>) {
    let play_id = state.play_counter.fetch_add(1, Ordering::SeqCst) + 1;
    let media_start_ms = pacer.sent_ms as f64;
    let ahead = pacer.sent_ms.saturating_sub(pacer.realtime_ms()) as i64;
    let started_at = now_ms() + ahead;
    {
        let mut live = state.live();
        live.current = track.map(|t| Current { play_id, track_id: t.id.clone(), started_at, media_start_ms });
        live.timeline.push_back(TimelineEntry { play_id, track_id: track.map(|t| t.id.clone()), started_at, media_start_ms });
        while live.timeline.len() > TIMELINE_LEN {
            live.timeline.pop_front();
        }
    }
    state.notify();
}

fn finish(state: &Shared, track: &Track) {
    let mut st = state.station();
    st.schedule.on_finished(track);
    state.persist(&st);
}

fn pick(state: &Shared, rand: &mut impl FnMut(usize) -> usize) -> Option<Track> {
    let mut st = state.station();
    let st = &mut *st;
    let id = st.schedule.next(&st.tracks, &st.playlists, rand);
    state.persist(st);
    id.and_then(|id| st.tracks.get(&id).cloned())
}

fn rng() -> impl FnMut(usize) -> usize {
    let mut x = (now_ms() as u64) | 1;
    move |n| {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        (x % n.max(1) as u64) as usize
    }
}

async fn session(state: &Shared, on_air: &watch::Receiver<bool>) -> Result<()> {
    let (format, bitrate) = {
        let st = state.station();
        (st.settings.stream_format, st.settings.bitrate)
    };
    let mut encoder = spawn_encoder(state, format, bitrate)?;
    let stdin = encoder.stdin.take().context("encoder stdin")?;
    let mut stdout = encoder.stdout.take().context("encoder stdout")?;

    *state.hub.format.lock().unwrap() = format;
    state.hub.history.lock().unwrap().clear();
    state.hub.headers.lock().unwrap().clear();
    *state.hub.media_end_ms.lock().unwrap() = 0.0;
    state.hub.epoch.fetch_add(1, Ordering::SeqCst);
    state.live().timeline.clear();
    *state.hub.tx.lock().unwrap() = Some(broadcast::channel(512).0);
    state.engine.skip.store(false, Ordering::SeqCst);
    {
        let mut live = state.live();
        live.on_air_since.get_or_insert_with(now_ms);
    }
    state.notify();
    tracing::info!(?format, bitrate, "on air");

    let reader_state = state.clone();
    let reader = tokio::spawn(async move {
        let mut buf = vec![0u8; 4096];
        let framing = match format {
            StreamFormat::Mp3 => Framing::Mp3,
            StreamFormat::Aac => Framing::Adts,
            StreamFormat::Opus => Framing::Ogg,
        };
        let mut splitter = FrameSplitter::new(framing);
        // Media position from counted samples: exact, independent of wall-clock timing.
        let mut media_ms = 0.0f64;
        loop {
            match stdout.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for frame in splitter.push(&buf[..n]) {
                        if frame.header {
                            reader_state.hub.headers.lock().unwrap().push(Bytes::from(frame.bytes));
                        } else {
                            let d = frame.duration_ms();
                            reader_state.hub.publish(media_ms, d, Bytes::from(frame.bytes));
                            media_ms += d;
                        }
                    }
                }
            }
        }
    });

    let mut feed = Feed { state, on_air, stdin, pacer: Pacer::new() };
    let mut rand = rng();
    // Two voices at most: the current item and, during a crossfade, the next one.
    let mut cur: Option<Voice> = None;
    let mut next: Option<Voice> = None;
    // Chosen by the scheduler, waiting for its crossfade point.
    let mut pending: Option<Track> = None;
    let mut handed_over = false;
    let outcome = loop {
        if let Some(o) = feed.interrupted() {
            break o;
        }
        if cur.is_none() {
            handed_over = false;
            cur = next.take();
            if cur.is_none() {
                match pending.take().or_else(|| pick(state, &mut rand)) {
                    Some(track) => {
                        announce(state, &feed.pacer, Some(&track));
                        cur = Some(Voice::start(state, track, 0)?);
                    }
                    None => {
                        if state.live().current.is_some() {
                            announce(state, &feed.pacer, None);
                        }
                        feed.silence(500).await?;
                        continue;
                    }
                }
            }
        }
        let c = cur.as_mut().expect("current voice");
        if state.engine.skip.swap(false, Ordering::SeqCst) {
            c.fade_out_over(SKIP_FADE_MS);
            if let Some(n) = next.as_mut() {
                n.fade_out_over(SKIP_FADE_MS);
            }
        }
        let setting = u64::from(state.station().settings.crossfade_ms);
        // The current item counts as finished for scheduling once its transition
        // window starts, so jingle rules see it before the next item is chosen.
        if !handed_over && c.remaining_ms() <= setting.max(CHUNK_MS) {
            handed_over = true;
            finish(state, &c.track);
            pending = pick(state, &mut rand);
        }
        if let Some(incoming) = &pending {
            let x = transition_ms(setting, &c.track, incoming);
            if x > 0 && c.remaining_ms() <= x {
                let incoming = pending.take().expect("pending");
                let overlap = c.remaining_ms();
                c.fade_out_over(overlap);
                announce(state, &feed.pacer, Some(&incoming));
                next = Some(Voice::start(state, incoming, overlap)?);
            }
        }
        let mut mix = vec![0f32; FRAMES_PER_CHUNK * 2];
        let a = c.read_into(state, &mut mix).await?;
        let b = match next.as_mut() {
            Some(n) => n.read_into(state, &mut mix).await?,
            None => 0,
        };
        if c.eof {
            if !handed_over {
                // Ended earlier than its estimated length: hand over now, gaplessly.
                finish(state, &c.track);
                pending = pick(state, &mut rand);
            }
            if a == 0 && b == 0 && c.pos_ms < 1.0 {
                tracing::warn!(track = %c.track.id, "track produced no audio; skipping");
            }
            cur = None;
        }
        let frames = a.max(b);
        if frames > 0 {
            feed.write_f32(&mix[..frames * 2]).await?;
        }
    };

    // Tear down: closing the sender ends every listener stream.
    drop(feed);
    let _ = encoder.kill().await;
    reader.abort();
    *state.hub.tx.lock().unwrap() = None;
    state.hub.history.lock().unwrap().clear();
    state.hub.headers.lock().unwrap().clear();
    {
        let mut live = state.live();
        live.current = None;
        live.timeline.clear();
        if matches!(outcome, Outcome::Stop) {
            live.on_air_since = None;
        }
    }
    state.notify();
    tracing::info!("encoder stopped ({})", if matches!(outcome, Outcome::Restart) { "restarting" } else { "off air" });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lead_follows_measured_startup() {
        let mut l = LeadEstimator::default();
        assert_eq!(l.lead_ms(), 2 * CHUNK_MS, "floor before any measurement");
        l.record(40);
        l.record(380);
        l.record(60);
        assert_eq!(l.lead_ms(), 380 + CHUNK_MS, "worst recent start-up plus one chunk");
        for _ in 0..LeadEstimator::KEEP {
            l.record(50);
        }
        assert_eq!(l.lead_ms(), 2 * CHUNK_MS, "old outliers age out");
    }

    #[test]
    fn equal_power_crossfade_keeps_energy_constant() {
        let len = 3000;
        for t in [0.0, 750.0, 1500.0, 2250.0, 2999.0] {
            let out = envelope(t, 0, Some((0, len)));
            let inn = envelope(t, len, None);
            let power = out * out + inn * inn;
            assert!((power - 1.0).abs() < 1e-3, "t={t}: power {power}");
        }
        assert_eq!(envelope(3000.0, 0, Some((0, len))), 0.0);
        assert_eq!(envelope(5000.0, 0, None), 1.0);
    }

    fn track(kind: TrackKind, ms: u64) -> Track {
        Track {
            id: "x".into(),
            kind,
            title: None,
            artists: vec![],
            album: None,
            duration_ms: ms,
            file: String::new(),
            artwork: None,
            source: String::new(),
            source_id: None,
            licence: None,
            attribution_url: None,
            content_hash: String::new(),
            added_at: 0,
            loudness_lufs: None,
            true_peak_db: None,
            audio_start_ms: Some(0),
            audio_end_ms: Some(ms),
        }
    }

    #[test]
    fn transitions_are_shorter_around_jingles_and_short_items() {
        let song = track(TrackKind::Music, 200_000);
        let jingle = track(TrackKind::Jingle, 6_000);
        assert_eq!(transition_ms(4000, &song, &song), 4000);
        assert_eq!(transition_ms(4000, &song, &jingle), 1000);
        assert_eq!(transition_ms(4000, &jingle, &song), 1000);
        assert_eq!(transition_ms(0, &song, &song), 0);
        let short = track(TrackKind::Jingle, 1_200);
        assert_eq!(transition_ms(4000, &song, &short), 600, "at most half of the item");
    }
}
