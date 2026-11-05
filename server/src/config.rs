//! Configuration from environment variables (see README › Server).

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result};

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub data_dir: PathBuf,
    /// Initial (or reset) host password; afterwards the stored hash is used.
    pub host_password: Option<String>,
    pub reset_password: bool,
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub listener_dist: Option<PathBuf>,
    pub host_dist: Option<PathBuf>,
    /// Set `Secure` on cookies (enable when served over HTTPS).
    pub secure_cookies: bool,
}

fn var(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let host_password = var("STATION_HOST_PASSWORD");
        // Built front ends: explicit env var, else the usual locations (repo root,
        // `server/` during development, or `/app` in the container).
        let dir = |key: &str, app: &str| {
            let candidates: Vec<PathBuf> = match var(key) {
                Some(p) => vec![p.into()],
                None => ["apps", "../apps", "/app/apps"].iter().map(|base| PathBuf::from(base).join(app).join("dist")).collect(),
            };
            candidates.into_iter().find(|p| p.join("index.html").exists())
        };
        Ok(Self {
            bind: var("STATION_BIND").unwrap_or_else(|| "127.0.0.1:8080".into()).parse().context("STATION_BIND")?,
            data_dir: var("STATION_DATA_DIR").unwrap_or_else(|| "./data".into()).into(),
            host_password,
            reset_password: var("STATION_RESET_PASSWORD").is_some_and(|v| v == "1" || v == "true"),
            ffmpeg: var("STATION_FFMPEG").unwrap_or_else(|| "ffmpeg".into()).into(),
            ffprobe: var("STATION_FFPROBE").unwrap_or_else(|| "ffprobe".into()).into(),
            listener_dist: dir("STATION_LISTENER_DIST", "listener"),
            host_dist: dir("STATION_HOST_DIST", "host"),
            secure_cookies: var("STATION_SECURE_COOKIES").is_some_and(|v| v == "1" || v == "true"),
        })
    }

    pub fn media_dir(&self) -> PathBuf {
        self.data_dir.join("media")
    }
    pub fn artwork_dir(&self) -> PathBuf {
        self.data_dir.join("artwork")
    }
    pub fn tmp_dir(&self) -> PathBuf {
        self.data_dir.join("tmp")
    }
}
