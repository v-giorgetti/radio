//! SQLite persistence: a `tracks` table plus small JSON documents for the
//! schedule, playlists and settings. All calls are short and synchronous.

use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};

use crate::model::{Track, TrackKind};

pub struct Db {
    conn: Connection,
}

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS tracks (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL CHECK (kind IN ('music', 'jingle')),
    title           TEXT,
    artists         TEXT NOT NULL DEFAULT '[]',
    album           TEXT,
    duration_ms     INTEGER NOT NULL,
    file            TEXT NOT NULL,
    artwork         TEXT,
    source          TEXT NOT NULL,
    source_id       TEXT,
    licence         TEXT,
    attribution_url TEXT,
    content_hash    TEXT NOT NULL UNIQUE,
    added_at        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
);
"#;

/// Columns added after the first release, applied idempotently.
const MIGRATIONS: &[(&str, &str, &str)] = &[
    ("tracks", "loudness_lufs", "REAL"),
    ("tracks", "true_peak_db", "REAL"),
    ("tracks", "audio_start_ms", "INTEGER"),
    ("tracks", "audio_end_ms", "INTEGER"),
];

fn migrate(conn: &Connection) -> Result<()> {
    for (table, column, ty) in MIGRATIONS {
        let exists: bool = conn
            .prepare(&format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"))?
            .exists([column])?;
        if !exists {
            conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {ty}"))?;
        }
    }
    Ok(())
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn)?;
        Ok(Self { conn })
    }

    #[cfg(test)]
    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn)?;
        Ok(Self { conn })
    }

    pub fn load_tracks(&self) -> Result<Vec<Track>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, kind, title, artists, album, duration_ms, file, artwork, source, source_id,
                    licence, attribution_url, content_hash, added_at, loudness_lufs, true_peak_db,
                    audio_start_ms, audio_end_ms
             FROM tracks ORDER BY added_at",
        )?;
        let rows = stmt.query_map([], |r| {
            let artists: String = r.get(3)?;
            let kind: String = r.get(1)?;
            Ok(Track {
                id: r.get(0)?,
                kind: TrackKind::parse(&kind).unwrap_or(TrackKind::Music),
                title: r.get(2)?,
                artists: serde_json::from_str(&artists).unwrap_or_default(),
                album: r.get(4)?,
                duration_ms: r.get::<_, i64>(5)? as u64,
                file: r.get(6)?,
                artwork: r.get(7)?,
                source: r.get(8)?,
                source_id: r.get(9)?,
                licence: r.get(10)?,
                attribution_url: r.get(11)?,
                content_hash: r.get(12)?,
                added_at: r.get(13)?,
                loudness_lufs: r.get(14)?,
                true_peak_db: r.get(15)?,
                audio_start_ms: r.get::<_, Option<i64>>(16)?.map(|v| v as u64),
                audio_end_ms: r.get::<_, Option<i64>>(17)?.map(|v| v as u64),
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn track_by_hash(&self, hash: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT id FROM tracks WHERE content_hash = ?1", [hash], |r| r.get(0))
            .optional()?)
    }

    pub fn upsert_track(&self, t: &Track) -> Result<()> {
        self.conn.execute(
            "INSERT INTO tracks (id, kind, title, artists, album, duration_ms, file, artwork, source,
                                 source_id, licence, attribution_url, content_hash, added_at,
                                 loudness_lufs, true_peak_db, audio_start_ms, audio_end_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
             ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, title = excluded.title,
                 artists = excluded.artists, album = excluded.album, artwork = excluded.artwork,
                 loudness_lufs = excluded.loudness_lufs, true_peak_db = excluded.true_peak_db,
                 duration_ms = excluded.duration_ms, audio_start_ms = excluded.audio_start_ms,
                 audio_end_ms = excluded.audio_end_ms",
            params![
                t.id,
                t.kind.as_str(),
                t.title,
                serde_json::to_string(&t.artists)?,
                t.album,
                t.duration_ms as i64,
                t.file,
                t.artwork,
                t.source,
                t.source_id,
                t.licence,
                t.attribution_url,
                t.content_hash,
                t.added_at,
                t.loudness_lufs,
                t.true_peak_db,
                t.audio_start_ms.map(|v| v as i64),
                t.audio_end_ms.map(|v| v as i64),
            ],
        )?;
        Ok(())
    }

    pub fn delete_track(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM tracks WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn insert_session(&self, token_hash: &str, expires_at: i64) -> Result<()> {
        self.conn.execute("INSERT INTO sessions (token_hash, expires_at) VALUES (?1, ?2)", params![token_hash, expires_at])?;
        Ok(())
    }

    pub fn session_valid(&self, token_hash: &str, now: i64) -> Result<bool> {
        Ok(self
            .conn
            .prepare("SELECT 1 FROM sessions WHERE token_hash = ?1 AND expires_at > ?2")?
            .exists(params![token_hash, now])?)
    }

    pub fn delete_session(&self, token_hash: &str) -> Result<()> {
        self.conn.execute("DELETE FROM sessions WHERE token_hash = ?1", [token_hash])?;
        Ok(())
    }

    /// Signs out every session except `keep` (and removes expired ones).
    pub fn delete_other_sessions(&self, keep: Option<&str>, now: i64) -> Result<usize> {
        self.conn.execute("DELETE FROM sessions WHERE expires_at <= ?1", [now])?;
        Ok(self.conn.execute("DELETE FROM sessions WHERE token_hash != ?1", [keep.unwrap_or("")])?)
    }

    pub fn get_doc<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let raw: Option<String> = self
            .conn
            .query_row("SELECT value FROM documents WHERE key = ?1", [key], |r| r.get(0))
            .optional()?;
        raw.map(|s| serde_json::from_str(&s).with_context(|| format!("decoding document {key}")))
            .transpose()
    }

    pub fn put_doc<T: Serialize>(&self, key: &str, value: &T) -> Result<()> {
        self.conn.execute(
            "INSERT INTO documents (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, serde_json::to_string(value)?],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_expire_and_revoke() {
        let db = Db::in_memory().unwrap();
        db.insert_session("a", 100).unwrap();
        db.insert_session("b", 100).unwrap();
        assert!(db.session_valid("a", 50).unwrap());
        assert!(!db.session_valid("a", 150).unwrap(), "expired");
        assert_eq!(db.delete_other_sessions(Some("a"), 50).unwrap(), 1);
        assert!(db.session_valid("a", 50).unwrap());
        assert!(!db.session_valid("b", 50).unwrap());
    }

    #[test]
    fn migrations_are_idempotent() {
        let db = Db::in_memory().unwrap();
        migrate(&db.conn).unwrap();
        migrate(&db.conn).unwrap();
    }

    #[test]
    fn documents_round_trip() {
        let db = Db::in_memory().unwrap();
        db.put_doc("x", &vec![1, 2, 3]).unwrap();
        assert_eq!(db.get_doc::<Vec<i32>>("x").unwrap(), Some(vec![1, 2, 3]));
        assert_eq!(db.get_doc::<Vec<i32>>("missing").unwrap(), None);
    }
}
