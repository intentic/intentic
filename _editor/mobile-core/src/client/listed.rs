//! What a refreshed sandbox list does to the kept one. The platform stays the authority, but only its clear word removes
//! a row: a list from the same database as the kept one (the platform's identity, `GET /api/identity`) replaces it
//! whole, so a sandbox deleted or unshared there goes. A list from another database, or from one that could not say
//! which it is, is a reset rather than a deletion: the rows it lacks are kept after the ones it lists, as the web client
//! keeps them (`deviceDirectory.ts`, `mergeListed`). Before 2026-11-09 any list replaced the kept one, so a platform
//! answering an empty list off a restored or wrong database emptied the phone of every sandbox.

use crate::wire::platform::SandboxSummary;

/// The list to keep, and the identity to keep it under.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Kept {
    pub sandboxes: Vec<SandboxSummary>,
    pub identity: Option<String>,
}

/// `listed` from a database that said it is `identity`, against the kept `held` and the identity it came from.
///
/// The kept identity stays the database the kept rows are confirmed by: it moves to a new one only when the new list
/// lacks none of the kept rows, since a list that loses nothing loses nothing by being believed. So a platform reading
/// another database keeps being a reset for as long as it does, however many lists it answers, and the first list from
/// the kept database again is the one that removes what it lacks. Pure.
pub(crate) fn merge(
    held: &[SandboxSummary],
    held_identity: Option<&str>,
    listed: Vec<SandboxSummary>,
    identity: Option<&str>,
) -> Kept {
    let same = identity.is_some() && identity == held_identity;
    if same {
        return Kept {
            sandboxes: listed,
            identity: identity.map(str::to_owned),
        };
    }
    // A kept row is still listed when the list names its id, or its address under another id (a sandbox the new
    // database adopted again), so a reset never shows one sandbox twice.
    let lacking: Vec<SandboxSummary> = held
        .iter()
        .filter(|kept| {
            !listed.iter().any(|row| {
                row.id == kept.id
                    || (kept.daemon_url.is_some() && row.daemon_url == kept.daemon_url)
            })
        })
        .cloned()
        .collect();
    if lacking.is_empty() {
        return Kept {
            sandboxes: listed,
            identity: identity.or(held_identity).map(str::to_owned),
        };
    }
    log::info!(
        "sandboxes: the list lacks {} kept, from {} database; keeping them",
        lacking.len(),
        if identity.is_none() {
            "an unnamed"
        } else {
            "another"
        }
    );
    let mut sandboxes = listed;
    sandboxes.extend(lacking);
    Kept {
        sandboxes,
        identity: held_identity.map(str::to_owned),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, daemon_url: Option<&str>) -> SandboxSummary {
        let sample: serde_json::Value =
            serde_json::from_str(include_str!("../wire/samples/platform.json")).unwrap();
        let mut row: SandboxSummary = serde_json::from_value(
            sample["sandbox.list:output"]
                .as_object()
                .and_then(|samples| samples.values().next())
                .map(|list| list["sandboxes"][0].clone())
                .unwrap(),
        )
        .unwrap();
        row.id = id.to_owned();
        row.daemon_url = daemon_url.map(str::to_owned);
        row
    }

    fn ids(kept: &Kept) -> Vec<&str> {
        kept.sandboxes.iter().map(|row| row.id.as_str()).collect()
    }

    #[test]
    fn the_same_database_replaces_the_kept_list_whole() {
        let held = [row("a", Some("https://a")), row("b", Some("https://b"))];
        let kept = merge(
            &held,
            Some("db1"),
            vec![row("a", Some("https://a"))],
            Some("db1"),
        );
        assert_eq!(ids(&kept), ["a"]);
        assert_eq!(kept.identity.as_deref(), Some("db1"));
        let emptied = merge(&held, Some("db1"), Vec::new(), Some("db1"));
        assert_eq!(ids(&emptied), Vec::<&str>::new());
    }

    #[test]
    fn another_database_or_an_unnamed_one_keeps_what_its_list_lacks() {
        let held = [row("a", Some("https://a")), row("b", Some("https://b"))];
        for identity in [Some("db2"), None] {
            let kept = merge(&held, Some("db1"), Vec::new(), identity);
            assert_eq!(ids(&kept), ["a", "b"], "{identity:?}");
            // The rows stand on the database they came from, so its next list is still the one that may remove them.
            assert_eq!(kept.identity.as_deref(), Some("db1"), "{identity:?}");
            let joined = merge(
                &held,
                Some("db1"),
                vec![row("c", Some("https://c"))],
                identity,
            );
            assert_eq!(ids(&joined), ["c", "a", "b"], "{identity:?}");
        }
        // A kept list from before identities were kept is confirmed by nothing yet.
        let first = merge(&held, None, Vec::new(), Some("db1"));
        assert_eq!(ids(&first), ["a", "b"]);
        assert_eq!(first.identity, None);
        let next = merge(
            &first.sandboxes,
            first.identity.as_deref(),
            Vec::new(),
            Some("db1"),
        );
        assert_eq!(ids(&next), ["a", "b"]);
        assert_eq!(next.identity, None);
        let unnamed = merge(&held, None, Vec::new(), None);
        assert_eq!(ids(&unnamed), ["a", "b"]);
        assert_eq!(unnamed.identity, None);
    }

    #[test]
    fn a_list_that_lacks_nothing_moves_the_kept_identity() {
        let held = [row("a", Some("https://a"))];
        let listed = vec![row("a", Some("https://a")), row("b", None)];
        let moved = merge(&held, Some("db1"), listed.clone(), Some("db2"));
        assert_eq!(ids(&moved), ["a", "b"]);
        assert_eq!(moved.identity.as_deref(), Some("db2"));
        let unnamed = merge(&held, Some("db1"), listed, None);
        assert_eq!(unnamed.identity.as_deref(), Some("db1"));
    }

    // A database that adopted a sandbox again lists it under a new id at the same address: one row, the listed one.
    #[test]
    fn a_sandbox_listed_again_under_another_id_is_not_kept_twice() {
        let held = [row("old", Some("https://a")), row("bare", None)];
        let kept = merge(
            &held,
            Some("db1"),
            vec![row("new", Some("https://a"))],
            Some("db2"),
        );
        assert_eq!(ids(&kept), ["new", "bare"]);
    }
}
