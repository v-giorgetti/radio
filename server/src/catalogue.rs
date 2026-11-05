//! Catalogue importers: Internet Archive and Jamendo.
//!
//! Only openly licensed material is offered: Creative Commons or public-domain
//! items. Every imported track keeps its licence and a link to its source page,
//! which the listener page shows as a credit. Non-commercial (NC) licences are
//! flagged for the host to judge. Downloads go through the shared import pipeline.

use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::import::{self, Provenance, update_job};
use crate::model::TrackKind;
use crate::state::{ImportJob, Rejection, Shared};

const MAX_DOWNLOAD_BYTES: u64 = 300 * 1024 * 1024;
const MAX_FILES_PER_ITEM: usize = 30;

pub fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("station-server/", env!("CARGO_PKG_VERSION"), " (self-hosted radio)"))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(600))
            .build()
            .expect("HTTP client")
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    InternetArchive,
    Jamendo,
}

impl Source {
    pub fn id(self) -> &'static str {
        match self {
            Source::InternetArchive => "internet-archive",
            Source::Jamendo => "jamendo",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Source::InternetArchive => "Internet Archive",
            Source::Jamendo => "Jamendo",
        }
    }
}

/// A search result: an IA item (album/session, several files) or a Jamendo track.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueResult {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_sec: Option<f64>,
    pub licence: String,
    pub licence_url: String,
    pub non_commercial: bool,
    pub page_url: String,
    pub image_url: Option<String>,
    /// True when one result expands into several tracks.
    pub is_collection: bool,
}

/// "https://creativecommons.org/licenses/by-nc-sa/4.0/" → ("CC BY-NC-SA 4.0", nc = true).
/// Returns None for anything that isn't CC or public domain.
pub fn licence_label(url: &str) -> Option<(String, bool)> {
    let u = url.trim().to_lowercase();
    if !u.contains("creativecommons.org") {
        return None;
    }
    if u.contains("/publicdomain/zero") {
        return Some(("CC0".into(), false));
    }
    if u.contains("/publicdomain/") {
        return Some(("Public domain".into(), false));
    }
    let rest = u.split("/licenses/").nth(1)?;
    let mut parts = rest.split('/').filter(|p| !p.is_empty());
    let kind = parts.next()?;
    if !kind.split('-').all(|k| matches!(k, "by" | "sa" | "nc" | "nd")) || !kind.starts_with("by") {
        return None;
    }
    let version = parts.next().filter(|v| v.chars().all(|c| c.is_ascii_digit() || c == '.'));
    let label = format!("CC {}{}", kind.to_uppercase(), version.map(|v| format!(" {v}")).unwrap_or_default());
    Some((label, kind.contains("nc")))
}

// ---------------- Internet Archive ----------------

#[derive(Deserialize)]
struct IaSearch {
    response: IaResponse,
}
#[derive(Deserialize)]
struct IaResponse {
    docs: Vec<IaDoc>,
}
#[derive(Deserialize)]
struct IaDoc {
    identifier: String,
    title: Option<IaText>,
    creator: Option<IaText>,
    licenseurl: Option<String>,
}
/// IA fields are sometimes a string, sometimes a list.
#[derive(Deserialize)]
#[serde(untagged)]
enum IaText {
    One(String),
    Many(Vec<String>),
}
impl IaText {
    fn text(self) -> String {
        match self {
            IaText::One(s) => s,
            IaText::Many(v) => v.join(", "),
        }
    }
}

fn ia_results(search: IaSearch) -> Vec<CatalogueResult> {
    search
        .response
        .docs
        .into_iter()
        .filter_map(|d| {
            let url = d.licenseurl?;
            let (licence, nc) = licence_label(&url)?;
            Some(CatalogueResult {
                page_url: format!("https://archive.org/details/{}", d.identifier),
                image_url: Some(format!("https://archive.org/services/img/{}", d.identifier)),
                title: d.title.map(IaText::text).unwrap_or_else(|| d.identifier.clone()),
                artist: d.creator.map(IaText::text).unwrap_or_else(|| "Unknown artist".into()),
                id: d.identifier,
                album: None,
                duration_sec: None,
                licence,
                licence_url: url,
                non_commercial: nc,
                is_collection: true,
            })
        })
        .collect()
}

async fn ia_search(query: &str) -> Result<Vec<CatalogueResult>> {
    let q = format!(
        "({}) AND mediatype:audio AND licenseurl:(*creativecommons.org*)",
        query.replace(['(', ')', '"'], " ")
    );
    let res = http()
        .get("https://archive.org/advancedsearch.php")
        .query(&[
            ("q", q.as_str()),
            ("fl[]", "identifier"),
            ("fl[]", "title"),
            ("fl[]", "creator"),
            ("fl[]", "licenseurl"),
            ("rows", "30"),
            ("output", "json"),
        ])
        .send()
        .await?
        .error_for_status()?;
    Ok(ia_results(res.json().await.context("parsing Internet Archive search")?))
}

#[derive(Deserialize)]
struct IaMetadata {
    metadata: IaItemMeta,
    #[serde(default)]
    files: Vec<IaFile>,
}
#[derive(Deserialize)]
struct IaItemMeta {
    title: Option<IaText>,
    creator: Option<IaText>,
    licenseurl: Option<String>,
}
#[derive(Deserialize)]
struct IaFile {
    name: String,
    format: Option<String>,
    title: Option<String>,
    creator: Option<String>,
    album: Option<String>,
    track: Option<String>,
    size: Option<String>,
}

/// One downloadable track with its provenance.
struct Download {
    url: String,
    name: String,
    provenance: Provenance,
}

/// Picks one audio format family per item (derivatives duplicate the originals).
fn ia_downloads(identifier: &str, meta: IaMetadata) -> Result<Vec<Download>> {
    let url = meta.metadata.licenseurl.clone().unwrap_or_default();
    let Some((licence, _)) = licence_label(&url) else {
        bail!("item isn't Creative Commons or public domain");
    };
    const PREFERENCE: &[&str] = &["VBR MP3", "128Kbps MP3", "MP3", "Ogg Vorbis", "MPEG-4 Audio", "Flac", "24bit Flac"];
    let format = PREFERENCE
        .iter()
        .find(|f| meta.files.iter().any(|x| x.format.as_deref() == Some(**f)))
        .ok_or_else(|| anyhow!("no playable audio files in this item"))?;
    let item_title = meta.metadata.title.map(IaText::text);
    let item_creator = meta.metadata.creator.map(IaText::text);
    let mut files: Vec<&IaFile> = meta.files.iter().filter(|f| f.format.as_deref() == Some(*format)).collect();
    files.sort_by_key(|f| (f.track.as_deref().and_then(|t| t.split('/').next()?.trim().parse::<u32>().ok()), f.name.clone()));
    Ok(files
        .into_iter()
        .filter(|f| f.size.as_deref().and_then(|s| s.parse::<u64>().ok()).is_none_or(|s| s <= MAX_DOWNLOAD_BYTES))
        .take(MAX_FILES_PER_ITEM)
        .map(|f| Download {
            url: format!(
                "https://archive.org/download/{identifier}/{}",
                f.name.split('/').map(urlencode).collect::<Vec<_>>().join("/")
            ),
            name: f.name.rsplit('/').next().unwrap_or(&f.name).to_string(),
            provenance: Provenance {
                source_id: Some(format!("{identifier}/{}", f.name)),
                licence: Some(licence.clone()),
                attribution_url: Some(format!("https://archive.org/details/{identifier}")),
                cover_url: Some(format!("https://archive.org/services/img/{identifier}")),
                title: f.title.clone(),
                artists: f.creator.clone().or(item_creator.clone()).into_iter().collect(),
                album: f.album.clone().or(item_title.clone()),
                ..Provenance::named("internet-archive")
            },
        })
        .collect())
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

async fn ia_item(identifier: &str) -> Result<Vec<Download>> {
    if !identifier.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
        bail!("invalid identifier");
    }
    let meta: IaMetadata = http()
        .get(format!("https://archive.org/metadata/{identifier}"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
        .context("parsing Internet Archive metadata")?;
    ia_downloads(identifier, meta)
}

// ---------------- Jamendo ----------------

#[derive(Deserialize)]
struct JamendoResponse {
    headers: JamendoHeaders,
    #[serde(default)]
    results: Vec<JamendoTrack>,
}
#[derive(Deserialize)]
struct JamendoHeaders {
    status: String,
    error_message: Option<String>,
}
#[derive(Debug, Deserialize)]
struct JamendoTrack {
    id: String,
    name: String,
    artist_name: String,
    album_name: Option<String>,
    duration: Option<f64>,
    audiodownload: Option<String>,
    #[serde(default)]
    audiodownload_allowed: bool,
    license_ccurl: Option<String>,
    shareurl: Option<String>,
    image: Option<String>,
}

fn jamendo_parse(res: JamendoResponse) -> Result<Vec<JamendoTrack>> {
    if res.headers.status != "success" {
        let msg = res.headers.error_message.unwrap_or_default();
        if msg.to_lowercase().contains("client id") {
            bail!("Jamendo rejected the client ID. Check it in Settings.");
        }
        bail!("Jamendo error: {msg}");
    }
    Ok(res
        .results
        .into_iter()
        .filter(|t| t.audiodownload_allowed && t.audiodownload.as_deref().is_some_and(|u| !u.is_empty()))
        .filter(|t| t.license_ccurl.as_deref().and_then(licence_label).is_some())
        .collect())
}

async fn jamendo_tracks(client_id: &str, params: &[(&str, &str)]) -> Result<Vec<JamendoTrack>> {
    if client_id.is_empty() {
        bail!("Connect Jamendo in Settings first (it needs a free client ID).");
    }
    let mut query = vec![("client_id", client_id), ("format", "json"), ("audiodlformat", "mp32"), ("include", "licenses")];
    query.extend_from_slice(params);
    let res: JamendoResponse = http()
        .get("https://api.jamendo.com/v3.0/tracks/")
        .query(&query)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
        .context("parsing Jamendo response")?;
    jamendo_parse(res)
}

fn jamendo_result(t: JamendoTrack) -> Option<CatalogueResult> {
    let url = t.license_ccurl.clone()?;
    let (licence, nc) = licence_label(&url)?;
    Some(CatalogueResult {
        page_url: t.shareurl.clone().unwrap_or_else(|| format!("https://www.jamendo.com/track/{}", t.id)),
        image_url: t.image.clone(),
        id: t.id,
        title: t.name,
        artist: t.artist_name,
        album: t.album_name,
        duration_sec: t.duration,
        licence,
        licence_url: url,
        non_commercial: nc,
        is_collection: false,
    })
}

/// Checks a client ID with a minimal request.
pub async fn verify_jamendo(client_id: &str) -> Result<()> {
    jamendo_tracks(client_id, &[("limit", "1")]).await.map(|_| ())
}

// ---------------- public API ----------------

pub async fn search(state: &Shared, source: Source, query: &str) -> Result<Vec<CatalogueResult>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(vec![]);
    }
    match source {
        Source::InternetArchive => ia_search(query).await,
        Source::Jamendo => {
            let id = state.station().settings.jamendo_client_id.clone();
            let tracks = jamendo_tracks(&id, &[("search", query), ("limit", "30"), ("audiodownload_allowed", "true")]).await?;
            Ok(tracks.into_iter().filter_map(jamendo_result).collect())
        }
    }
}

async fn expand(state: &Shared, source: Source, ids: &[String]) -> (Vec<Download>, Vec<Rejection>) {
    let mut downloads = vec![];
    let mut rejected = vec![];
    match source {
        Source::InternetArchive => {
            for id in ids {
                match ia_item(id).await {
                    Ok(d) => downloads.extend(d),
                    Err(e) => rejected.push(Rejection { name: id.clone(), reason: e.to_string() }),
                }
            }
        }
        Source::Jamendo => {
            let client_id = state.station().settings.jamendo_client_id.clone();
            let joined = ids.join("+");
            match jamendo_tracks(&client_id, &[("id", joined.as_str()), ("limit", "200")]).await {
                Ok(tracks) => {
                    for t in tracks {
                        let Some(url) = t.audiodownload.clone() else { continue };
                        let licence = t.license_ccurl.as_deref().and_then(licence_label).map(|(l, _)| l);
                        downloads.push(Download {
                            url,
                            name: format!("{}.mp3", t.name),
                            provenance: Provenance {
                                source_id: Some(t.id.clone()),
                                licence,
                                attribution_url: t.shareurl.clone(),
                                cover_url: t.image.clone(),
                                title: Some(t.name.clone()),
                                artists: vec![t.artist_name.clone()],
                                album: t.album_name.clone(),
                                ..Provenance::named("jamendo")
                            },
                        });
                    }
                }
                Err(e) => rejected.push(Rejection { name: "Jamendo".into(), reason: e.to_string() }),
            }
        }
    }
    (downloads, rejected)
}

/// Downloads with up to 3 attempts for transient failures (5xx, dropped connections).
async fn download(state: &Shared, url: &str) -> Result<std::path::PathBuf> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        match download_once(state, url).await {
            Ok(path) => return Ok(path),
            Err(e) if attempt < 3 && is_transient(&e) => {
                tracing::warn!("download attempt {attempt} failed for {url}: {e:#}; retrying");
                tokio::time::sleep(Duration::from_secs(2 * attempt)).await;
            }
            Err(e) => return Err(e),
        }
    }
}

fn is_transient(e: &anyhow::Error) -> bool {
    e.downcast_ref::<reqwest::Error>().is_some_and(|r| {
        r.is_timeout() || r.is_connect() || r.is_body() || r.status().is_some_and(|s| s.is_server_error() || s.as_u16() == 429)
    })
}

async fn download_once(state: &Shared, url: &str) -> Result<std::path::PathBuf> {
    let res = http().get(url).send().await?.error_for_status()?;
    if res.content_length().is_some_and(|l| l > MAX_DOWNLOAD_BYTES) {
        bail!("file is larger than 300 MB");
    }
    let tmp = import::tmp_path(state);
    let mut file = tokio::fs::File::create(&tmp).await?;
    let mut body = res.bytes_stream();
    let mut total = 0u64;
    while let Some(chunk) = body.next().await {
        let chunk = chunk?;
        total += chunk.len() as u64;
        if total > MAX_DOWNLOAD_BYTES {
            drop(file);
            let _ = tokio::fs::remove_file(&tmp).await;
            bail!("file is larger than 300 MB");
        }
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok(tmp)
}

/// Starts a background import of the selected results.
pub fn start_import(state: Shared, source: Source, ids: Vec<String>) -> String {
    let job_id = uuid::Uuid::new_v4().to_string();
    state.jobs.lock().unwrap().insert(
        0,
        ImportJob {
            id: job_id.clone(),
            source: source.id().into(),
            label: format!("{} from {}", ids.len(), source.label()),
            total: ids.len(),
            done: 0,
            imported: 0,
            rejected: vec![],
            finished: false,
        },
    );
    state.notify();
    let id = job_id.clone();
    tokio::spawn(async move {
        let (downloads, rejected) = expand(&state, source, &ids).await;
        update_job(&state, &id, |job| {
            job.total = downloads.len() + rejected.len();
            job.done = rejected.len();
            let n = downloads.len();
            job.label = format!("{n} track{} from {}", if n == 1 { "" } else { "s" }, source.label());
            job.rejected = rejected;
        });
        for d in downloads {
            let outcome = match download(&state, &d.url).await {
                Ok(tmp) => import::ingest_file(&state, &tmp, &d.name, TrackKind::Music, d.provenance).await,
                Err(e) => Err(format!("download failed: {e}")),
            };
            update_job(&state, &id, |job| {
                job.done += 1;
                match outcome {
                    Ok(_) => job.imported += 1,
                    Err(reason) => job.rejected.push(Rejection { name: d.name.clone(), reason }),
                }
            });
        }
        update_job(&state, &id, |job| job.finished = true);
    });
    job_id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn licence_labels() {
        assert_eq!(licence_label("http://creativecommons.org/licenses/by/4.0/"), Some(("CC BY 4.0".into(), false)));
        assert_eq!(licence_label("https://creativecommons.org/licenses/by-nc-sa/3.0/"), Some(("CC BY-NC-SA 3.0".into(), true)));
        assert_eq!(licence_label("https://creativecommons.org/publicdomain/zero/1.0/"), Some(("CC0".into(), false)));
        assert_eq!(licence_label("http://creativecommons.org/publicdomain/mark/1.0/"), Some(("Public domain".into(), false)));
        assert_eq!(licence_label("https://example.com/all-rights-reserved"), None);
        assert_eq!(licence_label("https://creativecommons.org/licenses/sampling+/1.0/"), None);
    }

    #[test]
    fn ia_search_keeps_only_open_licences_and_handles_list_fields() {
        let json = r#"{"response":{"docs":[
            {"identifier":"a","title":"Album A","creator":["X","Y"],"licenseurl":"http://creativecommons.org/licenses/by-nc/2.5/"},
            {"identifier":"b","title":"Closed","licenseurl":"https://example.com/closed"},
            {"identifier":"c","licenseurl":"https://creativecommons.org/publicdomain/zero/1.0/"}]}}"#;
        let r = ia_results(serde_json::from_str(json).unwrap());
        assert_eq!(r.len(), 2);
        assert_eq!((r[0].artist.as_str(), r[0].licence.as_str(), r[0].non_commercial), ("X, Y", "CC BY-NC 2.5", true));
        assert_eq!(r[1].title, "c");
    }

    #[test]
    fn ia_item_picks_one_format_in_track_order() {
        let json = r#"{"metadata":{"title":"Album","creator":"Band","licenseurl":"https://creativecommons.org/licenses/by/4.0/"},
            "files":[
              {"name":"02 two.mp3","format":"VBR MP3","track":"2/3","title":"Two"},
              {"name":"01 one.flac","format":"Flac","track":"1"},
              {"name":"01 one.mp3","format":"VBR MP3","track":"1/3"},
              {"name":"cover.png","format":"PNG"}]}"#;
        let d = ia_downloads("my-item", serde_json::from_str(json).unwrap()).unwrap();
        let names: Vec<_> = d.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, ["01 one.mp3", "02 two.mp3"]);
        assert_eq!(d[0].url, "https://archive.org/download/my-item/01%20one.mp3");
        assert_eq!(d[1].provenance.title.as_deref(), Some("Two"));
        assert_eq!(d[0].provenance.artists, ["Band"]);
        assert_eq!(d[0].provenance.licence.as_deref(), Some("CC BY 4.0"));
    }

    #[test]
    fn jamendo_errors_and_filtering() {
        let bad = r#"{"headers":{"status":"failed","code":5,"error_message":"Jamendo Api Invalid Client Id Error"},"results":[]}"#;
        let e = jamendo_parse(serde_json::from_str(bad).unwrap()).unwrap_err().to_string();
        assert!(e.contains("client ID"));
        let ok = r#"{"headers":{"status":"success"},"results":[
            {"id":"1","name":"Ok","artist_name":"A","audiodownload":"https://x/1.mp3","audiodownload_allowed":true,"license_ccurl":"http://creativecommons.org/licenses/by-sa/3.0/"},
            {"id":"2","name":"No download","artist_name":"A","audiodownload":"","audiodownload_allowed":false,"license_ccurl":"http://creativecommons.org/licenses/by/3.0/"}]}"#;
        let tracks = jamendo_parse(serde_json::from_str(ok).unwrap()).unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(jamendo_result(tracks.into_iter().next().unwrap()).unwrap().licence, "CC BY-SA 3.0");
    }
}
