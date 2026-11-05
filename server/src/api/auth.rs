//! Host authentication.
//!
//! - Password: Argon2id hash stored in SQLite. `STATION_HOST_PASSWORD` sets the
//!   initial password (or resets it with `STATION_RESET_PASSWORD=1`).
//! - Sessions: random 256-bit token in an HttpOnly, SameSite=Strict cookie. Only the
//!   token's SHA-256 is stored, so a database leak doesn't expose live sessions.

use std::time::Duration;

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::Json;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use super::{ApiError, ApiResult};
use crate::state::{Shared, now_ms};

const COOKIE: &str = "station_session";
const SESSION_TTL: Duration = Duration::from_secs(14 * 24 * 3600);
pub const MIN_PASSWORD_CHARS: usize = 12;

pub fn hash_password(password: &str) -> anyhow::Result<String> {
    // 16 random bytes (UUID v4 uses the OS CSPRNG).
    let salt = SaltString::encode_b64(uuid::Uuid::new_v4().as_bytes()).map_err(|e| anyhow::anyhow!("salt: {e}"))?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!("hashing password: {e}"))
}

fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
}

/// Argon2 is deliberately slow; keep it off the async runtime threads.
async fn verify_blocking(state: &Shared, password: String) -> bool {
    let hash = state.password_hash.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || verify_password(&password, &hash)).await.unwrap_or(false)
}

fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn session_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|c| c.trim().split_once('='))
        .find(|(k, _)| *k == COOKIE)
        .map(|(_, v)| v.to_string())
}

fn is_valid(state: &Shared, headers: &HeaderMap) -> bool {
    session_token(headers)
        .is_some_and(|t| state.db().session_valid(&token_hash(&t), now_ms()).unwrap_or(false))
}

pub async fn require_host(State(state): State<Shared>, req: Request, next: Next) -> Response {
    if is_valid(&state, req.headers()) {
        next.run(req).await
    } else {
        ApiError(StatusCode::UNAUTHORIZED, "Sign in required".into()).into_response()
    }
}

fn cookie(state: &Shared, value: &str, max_age: u64) -> String {
    let secure = if state.config.secure_cookies { "; Secure" } else { "" };
    format!("{COOKIE}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{secure}")
}

#[derive(Deserialize)]
pub struct Login {
    password: String,
}

pub async fn login(State(state): State<Shared>, Json(body): Json<Login>) -> ApiResult<Response> {
    if !verify_blocking(&state, body.password).await {
        tokio::time::sleep(Duration::from_millis(700)).await; // slow down guessing
        return Err(ApiError(StatusCode::UNAUTHORIZED, "Wrong password".into()));
    }
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    state.db().insert_session(&token_hash(&token), now_ms() + SESSION_TTL.as_millis() as i64)?;
    Ok(([(header::SET_COOKIE, cookie(&state, &token, SESSION_TTL.as_secs()))], Json(json!({ "ok": true })))
        .into_response())
}

pub async fn logout(State(state): State<Shared>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(token) = session_token(&headers) {
        state.db().delete_session(&token_hash(&token))?;
    }
    Ok(([(header::SET_COOKIE, cookie(&state, "", 0))], Json(json!({ "ok": true }))).into_response())
}

pub async fn session(State(state): State<Shared>, headers: HeaderMap) -> Json<serde_json::Value> {
    Json(json!({ "signedIn": is_valid(&state, &headers) }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordChange {
    current_password: String,
    new_password: String,
}

/// Changes the password and signs out every other session.
pub async fn change_password(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(b): Json<PasswordChange>,
) -> ApiResult<Json<serde_json::Value>> {
    if b.new_password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(ApiError::bad_request(format!("Use at least {MIN_PASSWORD_CHARS} characters")));
    }
    if !verify_blocking(&state, b.current_password).await {
        tokio::time::sleep(Duration::from_millis(700)).await;
        return Err(ApiError(StatusCode::FORBIDDEN, "Current password is wrong".into()));
    }
    let new = b.new_password;
    let hash = tokio::task::spawn_blocking(move || hash_password(&new)).await.map_err(anyhow::Error::from)??;
    state.db().put_doc("auth", &json!({ "passwordHash": hash }))?;
    *state.password_hash.lock().unwrap() = hash;
    let keep = session_token(&headers).map(|t| token_hash(&t));
    let revoked = state.db().delete_other_sessions(keep.as_deref(), now_ms())?;
    Ok(Json(json!({ "ok": true, "signedOutOthers": revoked })))
}

pub async fn revoke_other_sessions(State(state): State<Shared>, headers: HeaderMap) -> ApiResult<Json<serde_json::Value>> {
    let keep = session_token(&headers).map(|t| token_hash(&t));
    let revoked = state.db().delete_other_sessions(keep.as_deref(), now_ms())?;
    Ok(Json(json!({ "ok": true, "signedOutOthers": revoked })))
}

/// Resolves the stored password hash at startup.
pub fn initial_password_hash(db: &crate::db::Db, env_password: Option<&str>, reset: bool) -> anyhow::Result<String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Auth {
        password_hash: String,
    }
    let stored: Option<Auth> = db.get_doc("auth")?;
    match (stored, env_password) {
        (Some(a), _) if !reset => Ok(a.password_hash),
        (_, Some(pw)) => {
            if pw.chars().count() < MIN_PASSWORD_CHARS {
                anyhow::bail!("STATION_HOST_PASSWORD must be at least {MIN_PASSWORD_CHARS} characters");
            }
            let hash = hash_password(pw)?;
            db.put_doc("auth", &json!({ "passwordHash": hash }))?;
            if reset {
                db.delete_other_sessions(None, now_ms())?;
                tracing::warn!("host password reset from STATION_HOST_PASSWORD; all sessions signed out");
            }
            Ok(hash)
        }
        (None, None) => anyhow::bail!(
            "No host password set yet: start once with STATION_HOST_PASSWORD (at least {MIN_PASSWORD_CHARS} characters)"
        ),
        (Some(_), None) => anyhow::bail!("STATION_RESET_PASSWORD needs STATION_HOST_PASSWORD"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_hash_round_trip() {
        let h = hash_password("correct horse battery").unwrap();
        assert!(h.starts_with("$argon2"));
        assert!(verify_password("correct horse battery", &h));
        assert!(!verify_password("wrong", &h));
    }

    #[test]
    fn env_password_only_bootstraps() {
        let db = crate::db::Db::in_memory().unwrap();
        let first = initial_password_hash(&db, Some("first-password-123"), false).unwrap();
        // Later starts keep the stored (possibly changed) password even if env differs.
        let again = initial_password_hash(&db, Some("other-password-456"), false).unwrap();
        assert_eq!(first, again);
        let reset = initial_password_hash(&db, Some("other-password-456"), true).unwrap();
        assert!(verify_password("other-password-456", &reset));
    }
}
