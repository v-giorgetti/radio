//! Import pipeline shared by every source:
//! fetch → validate (ffprobe) → normalise tags → dedupe (SHA-256) → store with provenance.
//!
//! Sources: Files (uploads), Test library (generated audio) and catalogues
//! (Internet Archive, Jamendo — see `catalogue.rs`), which download a file and
//! pass it here with its `Provenance`.

use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::media::{self, TestTone};
use crate::model::{FrequencyUnit, JingleRule, Track, TrackKind};
use crate::state::{ImportJob, Rejection, Shared, now_ms};

#[derive(Debug, Clone)]
pub struct Provenance {
    pub source: String,
    pub source_id: Option<String>,
    pub licence: Option<String>,
    pub attribution_url: Option<String>,
    /// Cover image to use when the file has none embedded.
    pub cover_url: Option<String>,
    /// Metadata from the source, preferred over missing file tags.
    pub title: Option<String>,
    pub artists: Vec<String>,
    pub album: Option<String>,
}

impl Provenance {
    pub fn files() -> Self {
        Self::named("files")
    }
    pub fn named(source: &str) -> Self {
        Self {
            source: source.into(),
            source_id: None,
            licence: None,
            attribution_url: None,
            cover_url: None,
            title: None,
            artists: vec![],
            album: None,
        }
    }
}

fn container_ext(container: &str, original: &str) -> String {
    let first = container.split(',').next().unwrap_or("");
    let ext = match first {
        "mp3" => "mp3",
        "flac" => "flac",
        "ogg" => "ogg",
        "wav" => "wav",
        "aiff" => "aiff",
        "aac" => "aac",
        "matroska" | "webm" => "webm",
        "mov" | "mp4" | "m4a" => "m4a",
        _ => "",
    };
    if !ext.is_empty() {
        return ext.into();
    }
    Path::new(original)
        .extension()
        .and_then(|e| e.to_str())
        .filter(|e| e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("bin")
        .to_lowercase()
}

/// Validates and stores one local file. The temp file is consumed either way.
/// Returns the new track id, or a human-readable rejection reason.
pub async fn ingest_file(
    state: &Shared,
    tmp: &Path,
    original_name: &str,
    kind: TrackKind,
    provenance: Provenance,
) -> Result<String, String> {
    let result = ingest_inner(state, tmp, original_name, kind, provenance).await;
    let _ = tokio::fs::remove_file(tmp).await; // no-op if it was moved
    result
}

async fn ingest_inner(
    state: &Shared,
    tmp: &Path,
    original_name: &str,
    kind: TrackKind,
    provenance: Provenance,
) -> Result<String, String> {
    let cfg = &state.config;
    let probe = media::probe(&cfg.ffprobe, tmp).await.map_err(|e| e.to_string())?;
    let hash = media::sha256_file(tmp).await.map_err(|e| format!("could not read file: {e}"))?;
    if state.db().track_by_hash(&hash).map_err(|e| e.to_string())?.is_some() {
        return Err("already in the library (identical file)".into());
    }
    let analysis = match media::analyze(&cfg.ffmpeg, tmp).await {
        Ok(a) => Some(a),
        Err(e) => {
            tracing::warn!("audio analysis failed for {original_name}: {e:#}");
            None
        }
    };
    let file = format!("{hash}.{}", container_ext(&probe.container, original_name));
    tokio::fs::rename(tmp, cfg.media_dir().join(&file)).await.map_err(|e| format!("could not store file: {e}"))?;

    let artwork = if probe.has_cover {
        let name = format!("{hash}.jpg");
        match media::extract_cover(&cfg.ffmpeg, &cfg.media_dir().join(&file), &cfg.artwork_dir().join(&name)).await {
            Ok(()) => Some(name),
            Err(e) => {
                tracing::warn!("cover extraction failed for {original_name}: {e:#}");
                None
            }
        }
    } else if let Some(url) = &provenance.cover_url {
        download_cover(state, url, &hash).await
    } else {
        None
    };

    let fallback_title = Path::new(original_name).file_stem().and_then(|s| s.to_str()).map(str::to_string);
    let track = Track {
        id: uuid::Uuid::new_v4().to_string(),
        kind,
        title: probe.title.or(provenance.title).or(fallback_title),
        artists: if probe.artists.is_empty() { provenance.artists } else { probe.artists },
        album: probe.album.or(provenance.album),
        duration_ms: analysis.map_or(probe.duration_ms, |a| a.duration_ms),
        file,
        artwork,
        source: provenance.source,
        source_id: provenance.source_id,
        licence: provenance.licence,
        attribution_url: provenance.attribution_url,
        content_hash: hash,
        added_at: now_ms(),
        loudness_lufs: analysis.map(|a| a.loudness.lufs),
        true_peak_db: analysis.map(|a| a.loudness.true_peak_db),
        audio_start_ms: analysis.map(|a| a.audio_start_ms),
        audio_end_ms: analysis.map(|a| a.audio_end_ms),
    };
    state.db().upsert_track(&track).map_err(|e| e.to_string())?;
    let id = track.id.clone();
    {
        let mut st = state.station();
        if kind == TrackKind::Jingle {
            // New jingles start unscheduled; the host enables them explicitly.
            st.schedule.rules.push(JingleRule {
                jingle_id: id.clone(),
                enabled: false,
                unit: FrequencyUnit::Songs,
                every_songs: 5,
                every_minutes: 30,
            });
        }
        st.tracks.insert(id.clone(), track);
        state.persist(&st);
    }
    state.library_changed();
    Ok(id)
}

/// Downloads a cover image and stores it as 600px square artwork.
async fn download_cover(state: &Shared, url: &str, hash: &str) -> Option<String> {
    let bytes = async {
        let res = crate::catalogue::http().get(url).send().await?.error_for_status()?;
        res.bytes().await
    }
    .await
    .ok()?;
    if bytes.len() > 10 * 1024 * 1024 {
        return None;
    }
    let tmp = tmp_path(state);
    tokio::fs::write(&tmp, &bytes).await.ok()?;
    let name = format!("{hash}.jpg");
    let made = media::make_square_jpeg(&state.config.ffmpeg, &tmp, &state.config.artwork_dir().join(&name), 600).await;
    let _ = tokio::fs::remove_file(&tmp).await;
    made.ok().map(|_| name)
}

/// Analyses tracks imported before loudness/silence analysis existed.
pub async fn backfill_analysis(state: Shared) {
    let pending: Vec<(String, String)> = state
        .station()
        .tracks
        .values()
        .filter(|t| t.loudness_lufs.is_none() || t.audio_end_ms.is_none())
        .map(|t| (t.id.clone(), t.file.clone()))
        .collect();
    if pending.is_empty() {
        return;
    }
    tracing::info!("analysing {} existing tracks (loudness, silence, duration)", pending.len());
    for (id, file) in pending {
        let path = state.config.media_dir().join(&file);
        let Ok(a) = media::analyze(&state.config.ffmpeg, &path).await else { continue };
        let updated = {
            let mut st = state.station();
            st.tracks.get_mut(&id).map(|t| {
                t.loudness_lufs = Some(a.loudness.lufs);
                t.true_peak_db = Some(a.loudness.true_peak_db);
                t.audio_start_ms = Some(a.audio_start_ms);
                t.audio_end_ms = Some(a.audio_end_ms);
                t.duration_ms = a.duration_ms;
                t.clone()
            })
        };
        if let Some(t) = updated
            && let Err(e) = state.db().upsert_track(&t)
        {
            tracing::error!("saving loudness: {e:#}");
        }
    }
    state.library_changed();
}

pub fn tmp_path(state: &Shared) -> PathBuf {
    state.config.tmp_dir().join(uuid::Uuid::new_v4().to_string())
}

pub struct TestLibraryRequest {
    pub tracks: usize,
    pub jingles: usize,
    pub avg_minutes: u32,
    pub include_broken: bool,
}

pub fn update_job(state: &Shared, id: &str, f: impl FnOnce(&mut ImportJob)) {
    if let Some(job) = state.jobs.lock().unwrap().iter_mut().find(|j| j.id == id) {
        f(job);
    }
    state.notify();
}

/// Starts a background job generating synthetic tracks and jingles.
pub fn start_test_library(state: Shared, req: TestLibraryRequest) -> String {
    let job_id = uuid::Uuid::new_v4().to_string();
    let batch = (now_ms() / 1000) % 10_000;
    let total = req.tracks + req.jingles;
    state.jobs.lock().unwrap().insert(
        0,
        ImportJob {
            id: job_id.clone(),
            source: "test-library".into(),
            label: format!("Generated {} tracks + {} jingles", req.tracks, req.jingles),
            total,
            done: 0,
            imported: 0,
            rejected: vec![],
            finished: false,
        },
    );
    state.notify();
    let id = job_id.clone();
    tokio::spawn(async move {
        const NOTES: [f64; 7] = [220.0, 246.94, 261.63, 293.66, 329.63, 349.23, 392.0];
        for i in 0..total {
            let jingle = i >= req.tracks;
            let broken = req.include_broken && !jingle && i % 17 == 16;
            let n = i + 1;
            let title = if jingle { format!("Test jingle {}", n - req.tracks) } else { format!("Test Tone {n:03}") };
            let name = format!("{title}.mp3");
            let tmp = tmp_path(&state);
            let made = if broken {
                // Deliberately invalid: checks that validation rejects it.
                tokio::fs::write(&tmp, b"ID3 this is not really audio").await.map_err(anyhow::Error::from)
            } else {
                let seconds = if jingle {
                    4 + (i % 5) as u32
                } else {
                    let base = req.avg_minutes.max(1) * 60;
                    (base * (70 + (i as u32 * 37) % 60) / 100).max(20)
                };
                media::generate_test_tone(
                    &state.config.ffmpeg,
                    &TestTone {
                        title: &title,
                        artist: &format!("Generator {}", 1 + i % 7),
                        album: &format!("Test Library {batch} — Batch {}", 1 + i / 12),
                        seconds,
                        base_hz: NOTES[i % NOTES.len()] * if jingle { 2.0 } else { 1.0 },
                        jingle,
                    },
                    &tmp,
                )
                .await
            };
            let kind = if jingle { TrackKind::Jingle } else { TrackKind::Music };
            let provenance = Provenance {
                source_id: Some(format!("{batch}-{n}")),
                licence: Some("Generated".into()),
                ..Provenance::named("test-library")
            };
            let outcome = match made {
                Ok(()) => ingest_file(&state, &tmp, &name, kind, provenance).await,
                Err(e) => Err(format!("generation failed: {e}")),
            };
            update_job(&state, &id, |job| {
                job.done += 1;
                match outcome {
                    Ok(_) => job.imported += 1,
                    Err(reason) => job.rejected.push(Rejection { name, reason }),
                }
            });
        }
        update_job(&state, &id, |job| job.finished = true);
    });
    job_id
}
