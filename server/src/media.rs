//! ffmpeg/ffprobe helpers: validation, tag reading, artwork, test audio.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

#[derive(Debug, Clone)]
pub struct Probe {
    pub duration_ms: u64,
    pub title: Option<String>,
    pub artists: Vec<String>,
    pub album: Option<String>,
    pub has_cover: bool,
    pub container: String,
}

#[derive(Deserialize)]
struct FfprobeOut {
    format: Option<FfFormat>,
    #[serde(default)]
    streams: Vec<FfStream>,
}
#[derive(Deserialize)]
struct FfFormat {
    format_name: Option<String>,
    duration: Option<String>,
    #[serde(default)]
    tags: std::collections::HashMap<String, String>,
}
#[derive(Deserialize)]
struct FfStream {
    codec_type: Option<String>,
    #[serde(default)]
    disposition: std::collections::HashMap<String, i64>,
    #[serde(default)]
    tags: std::collections::HashMap<String, String>,
}

const ALLOWED_CONTAINERS: &[&str] = &["mp3", "flac", "ogg", "wav", "mov", "mp4", "m4a", "aiff", "aac", "matroska", "webm"];

/// Validates that a file is decodable audio and reads its tags.
pub async fn probe(ffprobe: &Path, file: &Path) -> Result<Probe> {
    let out = Command::new(ffprobe)
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(file)
        .stdin(Stdio::null())
        .output()
        .await
        .context("running ffprobe")?;
    if !out.status.success() {
        // ffprobe prefixes errors with the (internal) file path; keep only the reason.
        let msg = String::from_utf8_lossy(&out.stderr);
        let line = msg.lines().next().unwrap_or("unknown error");
        let reason = line.rsplit_once(": ").map_or(line, |(_, r)| r).trim();
        bail!("not a readable audio file ({reason})");
    }
    let parsed: FfprobeOut = serde_json::from_slice(&out.stdout).context("parsing ffprobe output")?;
    let format = parsed.format.ok_or_else(|| anyhow!("no container information"))?;
    let container = format.format_name.unwrap_or_default();
    if !container.split(',').any(|c| ALLOWED_CONTAINERS.contains(&c)) {
        bail!("unsupported format '{container}'");
    }
    let audio = parsed.streams.iter().find(|s| s.codec_type.as_deref() == Some("audio"));
    let Some(audio) = audio else { bail!("file has no audio stream") };
    let duration_ms = format
        .duration
        .and_then(|d| d.parse::<f64>().ok())
        .map(|s| (s * 1000.0) as u64)
        .unwrap_or(0);
    if duration_ms < 500 {
        bail!("audio is too short or truncated");
    }
    // Tags may live on the container (MP3/FLAC) or the stream (Ogg/Opus). Keys vary in case.
    let tag = |key: &str| {
        format
            .tags
            .iter()
            .chain(audio.tags.iter())
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let artists = tag("artist")
        .or_else(|| tag("album_artist"))
        .map(|a| a.split(';').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    let has_cover = parsed
        .streams
        .iter()
        .any(|s| s.codec_type.as_deref() == Some("video") && s.disposition.get("attached_pic") == Some(&1));
    Ok(Probe { duration_ms, title: tag("title"), artists, album: tag("album"), has_cover, container })
}

/// Extracts embedded cover art to a 600px JPEG.
pub async fn extract_cover(ffmpeg: &Path, file: &Path, dest: &Path) -> Result<()> {
    let status = Command::new(ffmpeg)
        .args(["-v", "error", "-y", "-i"])
        .arg(file)
        .args(["-an", "-frames:v", "1", "-vf", "scale='min(600,iw)':-2", "-q:v", "3"])
        .arg(dest)
        .stdin(Stdio::null())
        .status()
        .await?;
    if !status.success() {
        bail!("could not extract cover art");
    }
    Ok(())
}

pub async fn sha256_file(path: &Path) -> Result<String> {
    let mut f = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// What the Test library generator should produce for one item.
pub struct TestTone<'a> {
    pub title: &'a str,
    pub artist: &'a str,
    pub album: &'a str,
    pub seconds: u32,
    pub base_hz: f64,
    pub jingle: bool,
}

/// Generates a short, pleasant synthetic MP3 with tags (no third-party rights).
pub async fn generate_test_tone(ffmpeg: &Path, t: &TestTone<'_>, dest: &PathBuf) -> Result<()> {
    let f = t.base_hz;
    let expr = if t.jingle {
        // Rising three-note ident.
        format!(
            "0.25*sin(2*PI*({f}*(1+0.25*floor(t*3/{d}*3)/3))*t)*exp(-3*mod(t,{step}))",
            d = t.seconds,
            step = f64::from(t.seconds) / 3.0
        )
    } else {
        // Major triad pad with slow tremolo, plus a soft pulse.
        format!(
            "(0.16*sin(2*PI*{f}*t)+0.12*sin(2*PI*{f}*1.26*t)+0.1*sin(2*PI*{f}*1.5*t))*(0.8+0.2*sin(2*PI*0.25*t))+0.12*sin(2*PI*55*t)*exp(-8*mod(t,0.625))"
        )
    };
    let fade_out_start = f64::from(t.seconds).max(2.0) - 1.5;
    let status = Command::new(ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
        .arg(format!("aevalsrc='{expr}|{expr}':s=44100:d={}", t.seconds))
        .args(["-af", &format!("afade=t=in:d=0.5,afade=t=out:st={fade_out_start}:d=1.5")])
        .args(["-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3"])
        .args(["-metadata", &format!("title={}", t.title)])
        .args(["-metadata", &format!("artist={}", t.artist)])
        .args(["-metadata", &format!("album={}", t.album)])
        .arg(dest)
        .stdin(Stdio::null())
        .status()
        .await?;
    if !status.success() {
        bail!("ffmpeg failed to generate test audio");
    }
    Ok(())
}

/// Converts an image to a square `size`×`size` JPEG (centre-cropped). Fails for non-images.
pub async fn make_square_jpeg(ffmpeg: &Path, input: &Path, dest: &Path, size: u32) -> Result<()> {
    let status = Command::new(ffmpeg)
        .args(["-v", "error", "-y", "-i"])
        .arg(input)
        .args([
            "-vf",
            &format!("scale={size}:{size}:force_original_aspect_ratio=increase,crop={size}:{size}"),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            "-f",
            "image2",
            "-c:v",
            "mjpeg",
        ])
        .arg(dest)
        .stdin(Stdio::null())
        .status()
        .await?;
    if !status.success() {
        bail!("not a readable image");
    }
    Ok(())
}

/// EBU R128 measurement: integrated loudness (LUFS) and true peak (dBTP).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Loudness {
    pub lufs: f64,
    pub true_peak_db: f64,
}

/// Target for loudness normalisation (common for music streaming/radio).
pub const TARGET_LUFS: f64 = -16.0;
/// Never let gain push the true peak above this.
const PEAK_CEILING_DB: f64 = -1.0;

impl Loudness {
    /// Playback gain in dB: towards the target, limited to ±12 dB and by peak headroom.
    pub fn gain_db(self) -> f64 {
        if !self.lufs.is_finite() || self.lufs < -60.0 {
            return 0.0; // silence or unmeasurable: leave alone
        }
        let towards_target = TARGET_LUFS - self.lufs;
        let headroom = PEAK_CEILING_DB - self.true_peak_db;
        towards_target.min(headroom).clamp(-12.0, 12.0)
    }
}

/// Everything learned from one full decode of a track at import.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Analysis {
    pub loudness: Loudness,
    /// Audible region after trimming leading/trailing silence (ms from file start).
    pub audio_start_ms: u64,
    pub audio_end_ms: u64,
    /// Actual decoded duration (more reliable than container estimates for VBR files).
    pub duration_ms: u64,
}

/// Below this level for at least SILENCE_MIN, a file start/end counts as silence.
const SILENCE_DB: &str = "-45dB";
const SILENCE_MIN: &str = "0.3";

/// Decodes the file once: loudness (EBU R128), silence at either end, real duration.
pub async fn analyze(ffmpeg: &Path, file: &Path) -> Result<Analysis> {
    let out = Command::new(ffmpeg)
        .args(["-hide_banner", "-i"])
        .arg(file)
        .args(["-vn", "-af", &format!("silencedetect=n={SILENCE_DB}:d={SILENCE_MIN},ebur128=peak=true"), "-f", "null", "-"])
        .stdin(Stdio::null())
        .output()
        .await
        .context("running ffmpeg analysis")?;
    parse_analysis(&String::from_utf8_lossy(&out.stderr)).ok_or_else(|| anyhow!("no analysis summary in ffmpeg output"))
}

fn parse_analysis(stderr: &str) -> Option<Analysis> {
    let loudness = parse_ebur128(stderr)?;
    // Progress lines use \r; the last "time=" is the decoded duration.
    let duration_ms = stderr
        .rsplit(['\r', '\n'])
        .find_map(|l| l.split("time=").nth(1)?.split_whitespace().next().and_then(parse_clock))?;
    let mut silences = vec![]; // (start_ms, end_ms)
    let mut open: Option<u64> = None;
    for line in stderr.lines() {
        if let Some(v) = line.split("silence_start: ").nth(1) {
            open = v.split_whitespace().next().and_then(|x| x.parse::<f64>().ok()).map(|x| (x.max(0.0) * 1000.0) as u64);
        } else if let Some(v) = line.split("silence_end: ").nth(1) {
            let mut parts = v.split('|');
            let end = parts.next()?.trim().parse::<f64>().ok()?;
            let dur = parts.next().and_then(|d| d.split(':').nth(1)?.trim().parse::<f64>().ok()).unwrap_or(0.0);
            let start = open.take().unwrap_or(((end - dur).max(0.0) * 1000.0) as u64);
            silences.push((start, (end * 1000.0) as u64));
        }
    }
    if let Some(start) = open {
        silences.push((start, duration_ms)); // silence ran to the end of the file
    }
    let audio_start_ms = silences.iter().find(|(s, _)| *s <= 50).map_or(0, |(_, e)| *e);
    let audio_end_ms = silences
        .iter()
        .rev()
        .find(|(_, e)| *e + 50 >= duration_ms)
        .map_or(duration_ms, |(s, _)| (*s + 100).min(duration_ms)); // keep a short natural tail
    if audio_end_ms <= audio_start_ms + 200 {
        // (Nearly) silent file: don't trim it away entirely.
        return Some(Analysis { loudness, audio_start_ms: 0, audio_end_ms: duration_ms, duration_ms });
    }
    Some(Analysis { loudness, audio_start_ms, audio_end_ms, duration_ms })
}

/// "00:03:21.45" → 201450 ms.
fn parse_clock(s: &str) -> Option<u64> {
    let mut parts = s.split(':').rev();
    let secs: f64 = parts.next()?.parse().ok()?;
    let mins: f64 = parts.next().unwrap_or("0").parse().ok()?;
    let hours: f64 = parts.next().unwrap_or("0").parse().ok()?;
    Some(((hours * 3600.0 + mins * 60.0 + secs) * 1000.0).round() as u64)
}

/// Parses the summary block printed by ffmpeg's ebur128 filter.
fn parse_ebur128(stderr: &str) -> Option<Loudness> {
    let summary = &stderr[stderr.rfind("Summary:")?..];
    let value = |key: &str| {
        summary.lines().find_map(|l| {
            let l = l.trim();
            l.strip_prefix(key)?.split_whitespace().next()?.parse::<f64>().ok()
        })
    };
    Some(Loudness { lufs: value("I:")?, true_peak_db: value("Peak:").unwrap_or(0.0) })
}

/// Container framing of the encoder output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Framing {
    Mp3,
    Adts,
    Ogg,
}

/// One whole frame (MP3/ADTS) or page (Ogg) with the audio duration it carries.
pub struct Frame {
    pub bytes: Vec<u8>,
    /// Audio carried, in seconds × sample rate (0 for headers).
    pub samples: u64,
    pub sample_rate: u32,
    /// Ogg header pages (OpusHead/OpusTags), needed by every new listener.
    pub header: bool,
}

impl Frame {
    pub fn duration_ms(&self) -> f64 {
        if self.sample_rate == 0 { 0.0 } else { self.samples as f64 * 1000.0 / f64::from(self.sample_rate) }
    }
}

/// Splits the encoder's byte stream into whole frames so every chunk sent to a
/// listener starts on a frame boundary and its exact media duration is known.
pub struct FrameSplitter {
    framing: Framing,
    buf: Vec<u8>,
    last_granule: i64,
}

/// Parses a frame header: (frame length in bytes, samples, sample rate).
type HeaderParser = fn(&[u8]) -> Option<(usize, u64, u32)>;

const MP3_BITRATES_V1: [u32; 15] = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATES_V2: [u32; 15] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const ADTS_RATES: [u32; 13] = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/// (frame length in bytes, samples, sample rate) for an MPEG audio Layer III header.
fn mp3_header(h: &[u8]) -> Option<(usize, u64, u32)> {
    if h.len() < 4 || h[0] != 0xFF || h[1] & 0xE0 != 0xE0 {
        return None;
    }
    let version = (h[1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    let layer = (h[1] >> 1) & 3; // 1 = Layer III
    let bitrate_idx = (h[2] >> 4) as usize;
    let rate_idx = ((h[2] >> 2) & 3) as usize;
    if version == 1 || layer != 1 || bitrate_idx == 0 || bitrate_idx == 15 || rate_idx == 3 {
        return None;
    }
    let padding = u32::from((h[2] >> 1) & 1);
    let (bitrate, rate, coef, samples) = match version {
        3 => (MP3_BITRATES_V1[bitrate_idx], [44100, 48000, 32000][rate_idx], 144_000, 1152),
        2 => (MP3_BITRATES_V2[bitrate_idx], [22050, 24000, 16000][rate_idx], 72_000, 576),
        _ => (MP3_BITRATES_V2[bitrate_idx], [11025, 12000, 8000][rate_idx], 72_000, 576),
    };
    Some(((coef * bitrate / rate + padding) as usize, samples, rate))
}

/// (frame length, samples, sample rate) for an ADTS (AAC) header.
fn adts_header(h: &[u8]) -> Option<(usize, u64, u32)> {
    if h.len() < 7 || h[0] != 0xFF || h[1] & 0xF6 != 0xF0 {
        return None;
    }
    let rate = *ADTS_RATES.get(((h[2] >> 2) & 0x0F) as usize)?;
    let len = (usize::from(h[3] & 3) << 11) | (usize::from(h[4]) << 3) | usize::from(h[5] >> 5);
    let blocks = u64::from(h[6] & 3) + 1;
    (len >= 7).then_some((len, 1024 * blocks, rate))
}

impl FrameSplitter {
    pub fn new(framing: Framing) -> Self {
        Self { framing, buf: Vec::new(), last_granule: 0 }
    }

    pub fn push(&mut self, data: &[u8]) -> Vec<Frame> {
        self.buf.extend_from_slice(data);
        let mut frames = vec![];
        loop {
            let next = match self.framing {
                Framing::Ogg => self.next_ogg(),
                Framing::Mp3 => self.next_with(mp3_header, 4),
                Framing::Adts => self.next_with(adts_header, 7),
            };
            match next {
                Some(f) => frames.push(f),
                None => break,
            }
        }
        frames
    }

    /// MP3/ADTS: find a valid header, wait for the full frame, then cut it off.
    fn next_with(&mut self, header: HeaderParser, min: usize) -> Option<Frame> {
        loop {
            if self.buf.len() < min {
                return None;
            }
            let Some((len, samples, rate)) = header(&self.buf) else {
                // Not at a frame boundary (e.g. a tag or garbage): resynchronise.
                let skip = self.buf[1..].iter().position(|&b| b == 0xFF).map_or(self.buf.len(), |p| p + 1);
                self.buf.drain(..skip);
                continue;
            };
            if self.buf.len() < len {
                return None;
            }
            let bytes: Vec<u8> = self.buf.drain(..len).collect();
            return Some(Frame { bytes, samples, sample_rate: rate, header: false });
        }
    }

    fn next_ogg(&mut self) -> Option<Frame> {
        let start = self.buf.windows(4).position(|w| w == b"OggS");
        let Some(start) = start else {
            let keep = self.buf.len().min(3);
            self.buf.drain(..self.buf.len() - keep);
            return None;
        };
        self.buf.drain(..start);
        if self.buf.len() < 27 {
            return None;
        }
        let segments = self.buf[26] as usize;
        if self.buf.len() < 27 + segments {
            return None;
        }
        let body: usize = self.buf[27..27 + segments].iter().map(|&b| b as usize).sum();
        let total = 27 + segments + body;
        if self.buf.len() < total {
            return None;
        }
        let granule = i64::from_le_bytes(self.buf[6..14].try_into().ok()?);
        let bytes: Vec<u8> = self.buf.drain(..total).collect();
        // Opus granule positions count 48 kHz samples; header pages have granule 0.
        let header = granule == 0;
        let samples = if header { 0 } else { (granule - self.last_granule).max(0) as u64 };
        if !header {
            self.last_granule = granule;
        }
        Some(Frame { bytes, samples, sample_rate: 48_000, header })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ebur128_summary() {
        let stderr = "[Parsed_ebur128_0 @ 0x1] t: 1 M: -20 S: -20 I: -99 LUFS\n\
            [Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -18.3 LUFS\n    Threshold: -28.4 LUFS\n\n  \
            Loudness range:\n    LRA:         3.1 LU\n\n  True peak:\n    Peak:       -0.4 dBFS\n";
        let l = parse_ebur128(stderr).unwrap();
        assert_eq!(l, Loudness { lufs: -18.3, true_peak_db: -0.4 });
    }

    #[test]
    fn analysis_trims_silence_and_reads_real_duration() {
        let stderr = "[silencedetect @ 0x1] silence_start: 0\n\
            [silencedetect @ 0x1] silence_end: 1.5 | silence_duration: 1.5\n\
            [silencedetect @ 0x1] silence_start: 5.5\n\
            size=N/A time=00:00:03.00 bitrate=N/A\r\
            [silencedetect @ 0x1] silence_end: 7.5 | silence_duration: 2\n\
            [Parsed_ebur128_1 @ 0x1] Summary:\n  Integrated loudness:\n    I:         -22.5 LUFS\n  True peak:\n    Peak:      -20.8 dBFS\n\
            size=N/A time=00:00:07.50 bitrate=N/A speed= 193x\n";
        let a = parse_analysis(stderr).unwrap();
        assert_eq!((a.audio_start_ms, a.audio_end_ms, a.duration_ms), (1500, 5600, 7500));
        assert_eq!(a.loudness.lufs, -22.5);
    }

    #[test]
    fn analysis_keeps_mid_track_silence_and_silent_files() {
        // A pause in the middle is not trimmed.
        let mid = "[s] silence_start: 3\n[s] silence_end: 4 | silence_duration: 1\n\
            Summary:\n    I: -14.0 LUFS\n    Peak: -1.0 dBFS\ntime=00:00:10.00 \n";
        let a = parse_analysis(mid).unwrap();
        assert_eq!((a.audio_start_ms, a.audio_end_ms), (0, 10_000));
        // Entirely silent: keep the whole file rather than trimming to nothing.
        let silent = "[s] silence_start: 0\nSummary:\n    I: -70.0 LUFS\n    Peak: -90 dBFS\ntime=00:00:05.00 \n";
        let a = parse_analysis(silent).unwrap();
        assert_eq!((a.audio_start_ms, a.audio_end_ms), (0, 5_000));
    }

    #[test]
    fn gain_moves_towards_target_within_peak_headroom() {
        // Quiet track with lots of headroom: full boost to target.
        assert!((Loudness { lufs: -22.0, true_peak_db: -9.0 }.gain_db() - 6.0).abs() < 1e-9);
        // Quiet track but peaky: boost limited so the peak stays at -1 dBTP.
        assert!((Loudness { lufs: -22.0, true_peak_db: -3.0 }.gain_db() - 2.0).abs() < 1e-9);
        // Loud track: cut.
        assert!((Loudness { lufs: -9.0, true_peak_db: 0.0 }.gain_db() + 7.0).abs() < 1e-9);
        // Silence is left alone; extremes are clamped.
        assert_eq!(Loudness { lufs: -70.0, true_peak_db: -70.0 }.gain_db(), 0.0);
        assert_eq!(Loudness { lufs: -50.0, true_peak_db: -40.0 }.gain_db(), 12.0);
    }

    fn page(granule: i64, body: &[u8]) -> Vec<u8> {
        let mut p = b"OggS".to_vec();
        p.push(0); // version
        p.push(0); // header type
        p.extend_from_slice(&granule.to_le_bytes());
        p.extend_from_slice(&[0; 12]); // serial, sequence, crc
        p.push(1); // one segment
        p.push(body.len() as u8);
        p.extend_from_slice(body);
        p
    }

    #[test]
    fn ogg_pages_split_across_reads_with_durations() {
        let mut stream = page(0, b"OpusHead");
        stream.extend(page(9600, b"audio"));
        stream.extend(page(19200, b"audio"));
        let mut s = FrameSplitter::new(Framing::Ogg);
        let (a, b) = stream.split_at(20);
        assert!(s.push(a).is_empty());
        let pages = s.push(b);
        assert_eq!(pages.len(), 3);
        assert!(pages[0].header);
        assert_eq!((pages[1].duration_ms(), pages[2].duration_ms()), (200.0, 200.0));
    }

    fn split_all(framing: Framing, data: &[u8]) -> Vec<Frame> {
        // Feed in awkward slices to exercise partial frames.
        let mut s = FrameSplitter::new(framing);
        data.chunks(1000).flat_map(|c| s.push(c)).collect()
    }

    #[test]
    fn mp3_frames_match_ffprobe_count_and_duration() {
        let data = include_bytes!("../tests/fixtures/tone.mp3");
        let frames = split_all(Framing::Mp3, data);
        assert_eq!(frames.len(), 78, "ffprobe counts 78 frames");
        assert_eq!(frames.iter().map(|f| f.bytes.len()).sum::<usize>(), data.len(), "every byte accounted for");
        let ms: f64 = frames.iter().map(Frame::duration_ms).sum();
        assert!((ms - 78.0 * 1152.0 / 44.1).abs() < 0.01);
    }

    #[test]
    fn adts_frames_match_ffprobe_count() {
        let data = include_bytes!("../tests/fixtures/tone.aac");
        let frames = split_all(Framing::Adts, data);
        assert_eq!(frames.len(), 88, "ffprobe counts 88 frames");
        assert_eq!(frames.iter().map(|f| f.bytes.len()).sum::<usize>(), data.len());
    }

    #[test]
    fn splitter_resyncs_after_garbage() {
        let data = include_bytes!("../tests/fixtures/tone.mp3");
        let mut noisy = b"ID3garbage\xff\x00".to_vec();
        noisy.extend_from_slice(data);
        assert_eq!(split_all(Framing::Mp3, &noisy).len(), 78);
    }
}
