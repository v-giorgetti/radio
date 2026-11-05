//! The scheduler decides what plays next. It is pure: no clocks, no I/O.
//! The broadcaster reports elapsed broadcast time and finished items.
//!
//! Rules (SPEC.md › Proposed scheduling details):
//! - A rule is due when its song and/or minute threshold is reached ("both" = either).
//! - Only completed music tracks count as songs; minutes are broadcast time while on air.
//! - Due jingles wait for the current item to finish; they never interrupt it.
//! - Several due jingles play once each, in configured rule order; no backlog.
//! - A jingle's counters reset when that jingle finishes playing.
//! - Order of selection: due jingles → host queue → fallback playlist → idle (None).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::model::{FrequencyUnit, JingleRule, Playlist, PlaylistId, Track, TrackId, TrackKind};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Counters {
    pub songs_since: u32,
    pub ms_since: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub queue: Vec<TrackId>,
    /// Ordered: earlier rules win when several are due at once.
    pub rules: Vec<JingleRule>,
    pub counters: HashMap<TrackId, Counters>,
    /// Jingles that became due and wait for the next boundary.
    pub pending: Vec<TrackId>,
    pub fallback_playlist: Option<PlaylistId>,
    pub fallback_cursor: usize,
    #[serde(default)]
    pub last_fallback: Option<TrackId>,
}

/// Read-only view of the library the scheduler needs.
pub trait Library {
    fn get(&self, id: &str) -> Option<&Track>;
}

impl Library for HashMap<TrackId, Track> {
    fn get(&self, id: &str) -> Option<&Track> {
        HashMap::get(self, id)
    }
}

pub fn is_due(rule: &JingleRule, c: &Counters) -> bool {
    if !rule.enabled {
        return false;
    }
    let by_songs = c.songs_since >= rule.every_songs.max(1);
    let by_minutes = c.ms_since >= u64::from(rule.every_minutes.max(1)) * 60_000;
    match rule.unit {
        FrequencyUnit::Songs => by_songs,
        FrequencyUnit::Minutes => by_minutes,
        FrequencyUnit::Both => by_songs || by_minutes,
    }
}

impl Schedule {
    /// Broadcast time passes while on air (including idle silence).
    pub fn advance_time(&mut self, ms: u64) {
        for rule in &self.rules {
            self.counters.entry(rule.jingle_id.clone()).or_default().ms_since += ms;
        }
    }

    /// Called at every item boundary with the item that just finished.
    pub fn on_finished(&mut self, finished: &Track) {
        match finished.kind {
            TrackKind::Music => {
                for rule in &self.rules {
                    self.counters.entry(rule.jingle_id.clone()).or_default().songs_since += 1;
                }
            }
            TrackKind::Jingle => {
                self.counters.insert(finished.id.clone(), Counters::default());
            }
        }
        let newly_due: Vec<TrackId> = self
            .rules
            .iter()
            .filter(|r| r.jingle_id != finished.id && !self.pending.contains(&r.jingle_id))
            .filter(|r| is_due(r, self.counters.get(&r.jingle_id).unwrap_or(&Counters::default())))
            .map(|r| r.jingle_id.clone())
            .collect();
        self.pending.extend(newly_due);
    }

    /// Chooses and removes the next item. `rand` returns a value in [0, n).
    pub fn next(
        &mut self,
        lib: &impl Library,
        playlists: &[Playlist],
        rand: &mut impl FnMut(usize) -> usize,
    ) -> Option<TrackId> {
        // 1. Due jingles, in rule order (pending is appended in rule order).
        while !self.pending.is_empty() {
            let id = self.pending.remove(0);
            let still_scheduled = self.rules.iter().any(|r| r.jingle_id == id && r.enabled);
            if still_scheduled && lib.get(&id).is_some_and(|t| t.kind == TrackKind::Jingle) {
                return Some(id);
            }
        }
        // 2. Host queue.
        while !self.queue.is_empty() {
            let id = self.queue.remove(0);
            if lib.get(&id).is_some() {
                return Some(id);
            }
        }
        // 3. Fallback playlist (music only).
        let playlist = playlists.iter().find(|p| Some(&p.id) == self.fallback_playlist.as_ref())?;
        let ids: Vec<&TrackId> = playlist
            .track_ids
            .iter()
            .filter(|id| lib.get(id).is_some_and(|t| t.kind == TrackKind::Music))
            .collect();
        if ids.is_empty() {
            return None;
        }
        let pick = if playlist.shuffle {
            let mut i = rand(ids.len());
            // Avoid an immediate repeat when there's a choice.
            if ids.len() > 1 && Some(ids[i]) == self.last_fallback.as_ref() {
                i = (i + 1) % ids.len();
            }
            ids[i].clone()
        } else {
            let id = ids[self.fallback_cursor % ids.len()].clone();
            self.fallback_cursor = (self.fallback_cursor + 1) % ids.len();
            id
        };
        self.last_fallback = Some(pick.clone());
        Some(pick)
    }

    /// Keeps rules, counters and queue consistent after tracks are deleted.
    pub fn forget_track(&mut self, id: &str) {
        self.queue.retain(|t| t != id);
        self.pending.retain(|t| t != id);
        self.rules.retain(|r| r.jingle_id != id);
        self.counters.remove(id);
    }

    /// Replaces the rule list, keeping counters of rules that still exist.
    pub fn set_rules(&mut self, rules: Vec<JingleRule>) {
        self.counters.retain(|id, _| rules.iter().any(|r| &r.jingle_id == id));
        self.pending.retain(|id| rules.iter().any(|r| &r.jingle_id == id && r.enabled));
        self.rules = rules;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str, kind: TrackKind) -> Track {
        Track {
            id: id.into(),
            kind,
            title: Some(id.into()),
            artists: vec![],
            album: None,
            duration_ms: 180_000,
            file: format!("{id}.mp3"),
            artwork: None,
            source: "test".into(),
            source_id: None,
            licence: None,
            attribution_url: None,
            content_hash: id.into(),
            added_at: 0,
            loudness_lufs: None,
            true_peak_db: None,
            audio_start_ms: None,
            audio_end_ms: None,
        }
    }

    fn lib() -> HashMap<TrackId, Track> {
        let mut m = HashMap::new();
        for i in 0..10 {
            let id = format!("m{i}");
            m.insert(id.clone(), track(&id, TrackKind::Music));
        }
        for id in ["j1", "j2", "j3"] {
            m.insert(id.into(), track(id, TrackKind::Jingle));
        }
        m
    }

    fn rule(id: &str, unit: FrequencyUnit, songs: u32, minutes: u32) -> JingleRule {
        JingleRule { jingle_id: id.into(), enabled: true, unit, every_songs: songs, every_minutes: minutes }
    }

    fn no_rand(_: usize) -> usize {
        0
    }

    /// Plays `n` items, returning the ids, simulating `ms_per_item` of broadcast each.
    fn play(s: &mut Schedule, lib: &HashMap<TrackId, Track>, pls: &[Playlist], n: usize, ms: u64) -> Vec<String> {
        let mut out = vec![];
        for _ in 0..n {
            let Some(id) = s.next(lib, pls, &mut no_rand) else {
                out.push("idle".into());
                s.advance_time(ms);
                continue;
            };
            s.advance_time(ms);
            s.on_finished(&lib[&id]);
            out.push(id);
        }
        out
    }

    #[test]
    fn every_four_songs_plays_after_the_fourth() {
        let lib = lib();
        let mut s = Schedule {
            queue: (0..8).map(|i| format!("m{i}")).collect(),
            rules: vec![rule("j1", FrequencyUnit::Songs, 4, 30)],
            ..Default::default()
        };
        let got = play(&mut s, &lib, &[], 10, 1000);
        assert_eq!(got, ["m0", "m1", "m2", "m3", "j1", "m4", "m5", "m6", "m7", "j1"]);
    }

    #[test]
    fn minute_rule_waits_for_the_current_track() {
        let lib = lib();
        let mut s = Schedule {
            queue: vec!["m0".into(), "m1".into()],
            rules: vec![rule("j1", FrequencyUnit::Minutes, 99, 30)],
            ..Default::default()
        };
        // First track: due at 30 min mid-track, but nothing interrupts it.
        let first = s.next(&lib, &[], &mut no_rand).unwrap();
        s.advance_time(29 * 60_000);
        assert!(s.pending.is_empty());
        s.advance_time(2 * 60_000); // now past 30 min, still the same track
        assert!(s.pending.is_empty(), "jingles are only queued at boundaries");
        s.on_finished(&lib[&first]);
        assert_eq!(s.next(&lib, &[], &mut no_rand).as_deref(), Some("j1"));
    }

    #[test]
    fn combined_rule_triggers_once_on_either_threshold() {
        let lib = lib();
        let mut s = Schedule {
            queue: (0..6).map(|i| format!("m{i}")).collect(),
            rules: vec![rule("j1", FrequencyUnit::Both, 3, 5)],
            ..Default::default()
        };
        // 2 min per song: minutes (5) are reached during song 3, songs (3) at its end — one jingle.
        let got = play(&mut s, &lib, &[], 7, 2 * 60_000);
        assert_eq!(got, ["m0", "m1", "m2", "j1", "m3", "m4", "m5"]);
    }

    #[test]
    fn jingles_do_not_count_as_songs() {
        let lib = lib();
        let mut s = Schedule {
            queue: (0..6).map(|i| format!("m{i}")).collect(),
            rules: vec![rule("j1", FrequencyUnit::Songs, 2, 99), rule("j2", FrequencyUnit::Songs, 3, 99)],
            ..Default::default()
        };
        let got = play(&mut s, &lib, &[], 9, 1000);
        // j1 after m1; j2 after m2 (3 songs; j1 didn't count); then j1 after m3 (2 songs since j1).
        assert_eq!(got, ["m0", "m1", "j1", "m2", "j2", "m3", "j1", "m4", "m5"]);
    }

    #[test]
    fn several_due_play_once_each_in_rule_order_without_backlog() {
        let lib = lib();
        let mut s = Schedule {
            queue: vec!["m0".into(), "m1".into()],
            rules: vec![rule("j2", FrequencyUnit::Minutes, 99, 1), rule("j1", FrequencyUnit::Minutes, 99, 1)],
            ..Default::default()
        };
        let first = s.next(&lib, &[], &mut no_rand).unwrap();
        s.advance_time(10 * 60_000); // ten intervals elapsed
        s.on_finished(&lib[&first]);
        let got = play(&mut s, &lib, &[], 3, 1000);
        assert_eq!(got, ["j2", "j1", "m1"], "stable order, no repeated copies");
    }

    #[test]
    fn disabled_rules_never_fire() {
        let lib = lib();
        let mut r = rule("j1", FrequencyUnit::Songs, 1, 1);
        r.enabled = false;
        let mut s = Schedule { queue: vec!["m0".into(), "m1".into()], rules: vec![r], ..Default::default() };
        assert_eq!(play(&mut s, &lib, &[], 2, 120_000), ["m0", "m1"]);
    }

    #[test]
    fn fallback_playlist_repeats_then_idle_without_one() {
        let lib = lib();
        let pl = Playlist { id: "p".into(), name: "P".into(), track_ids: vec!["m8".into(), "j1".into(), "m9".into()], shuffle: false };
        let mut s = Schedule { queue: vec!["m0".into()], fallback_playlist: Some("p".into()), ..Default::default() };
        let got = play(&mut s, &lib, std::slice::from_ref(&pl), 5, 1000);
        assert_eq!(got, ["m0", "m8", "m9", "m8", "m9"], "jingles in playlists are skipped");
        s.fallback_playlist = None;
        assert_eq!(play(&mut s, &lib, &[pl], 1, 1000), ["idle"]);
    }

    #[test]
    fn deleted_tracks_are_skipped_and_forgotten() {
        let mut lib = lib();
        let mut s = Schedule {
            queue: vec!["m0".into(), "m1".into()],
            rules: vec![rule("j1", FrequencyUnit::Songs, 1, 99)],
            ..Default::default()
        };
        lib.remove("m0");
        assert_eq!(s.next(&lib, &[], &mut no_rand).as_deref(), Some("m1"));
        s.forget_track("j1");
        assert!(s.rules.is_empty());
    }

    #[test]
    fn shuffle_avoids_immediate_repeat() {
        let lib = lib();
        let pl = Playlist { id: "p".into(), name: "P".into(), track_ids: vec!["m1".into(), "m2".into()], shuffle: true };
        let mut s = Schedule { fallback_playlist: Some("p".into()), ..Default::default() };
        let mut always_zero = |_: usize| 0;
        let a = s.next(&lib, std::slice::from_ref(&pl), &mut always_zero).unwrap();
        let b = s.next(&lib, std::slice::from_ref(&pl), &mut always_zero).unwrap();
        assert_ne!(a, b);
    }
}
