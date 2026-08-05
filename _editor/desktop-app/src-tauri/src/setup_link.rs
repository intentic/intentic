use serde::{Deserialize, Serialize};

/* THE ONLY CHANNEL FROM THE SPA INTO THIS APP.
 *
 * The workspace window shows remote content, so it gets no IPC at all — its capability list is empty. What it
 * gets instead is a navigation to `intentic://…` that the window handler intercepts in Rust and cancels, which
 * has two properties nothing else does: the same link works from an EXTERNAL browser (where the OS routes it
 * to the installed app), and a page that is somehow not ours can at worst ask for a setup it has no code for.
 *
 * Four actions, and the parse is deliberately total — anything unrecognised, or missing a value it cannot do
 * without, returns None rather than half a request. */

/// `intentic://setup?code=…` — run the sandbox this setup code was minted for on this computer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupArgs {
    pub code: String,
    pub name: Option<String>,
    /// Own-Cloudflare only. It rides the link ONLY from the in-app webview, where the navigation is cancelled
    /// in-process and never reaches the OS — an external browser's deep link may be logged by the protocol
    /// handler, so from there the launcher asks for the token itself.
    pub cf_token: Option<String>,
    pub sync_dir: Option<String>,
    pub platform_url: Option<String>,
}

/// `intentic://recreate?slug=…[&hash=…]` — swap the sandbox onto a different image. This is what turns the
/// SPA's two "paste this command on the machine that runs your sandbox" cards into buttons: the daemon holds
/// no host Docker socket, so it can never recreate its own container, and this app is the thing on that
/// machine. No hash updates to the fresh `:stable` base; a hash builds the owner-approved overlay pinned to
/// that digest — the same argument shape the pasted command has always carried.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecreateArgs {
    pub slug: String,
    pub hash: Option<String>,
}

/// `intentic://auth?handoff=…&state=…` — the credential coming back from a sign-in that happened in the
/// user's real browser (see auth.rs for why it never happens in the webview).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthArgs {
    pub handoff: String,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Link {
    Setup(Box<SetupArgs>),
    Recreate(RecreateArgs),
    /// `intentic://signin` — the SPA's login screen asking to be signed in the way this app can be: in the
    /// user's real browser. It carries nothing, because everything it starts is minted afterwards.
    SignIn,
    Auth(AuthArgs),
}

pub fn parse_link(url: &str) -> Option<Link> {
    let parsed = url::Url::parse(url).ok()?;
    if parsed.scheme() != "intentic" {
        return None;
    }
    let mut values: Vec<(String, String)> = Vec::new();
    for (key, value) in parsed.query_pairs() {
        let value = value.trim();
        if !value.is_empty() {
            values.push((key.to_string(), value.to_string()));
        }
    }
    let get = |name: &str| {
        values
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
    };
    match parsed.host_str()? {
        "setup" => Some(Link::Setup(Box::new(SetupArgs {
            code: get("code")?,
            name: get("name"),
            cf_token: get("cfToken"),
            sync_dir: get("syncDir"),
            platform_url: get("platform"),
        }))),
        "signin" => Some(Link::SignIn),
        "recreate" => Some(Link::Recreate(RecreateArgs {
            slug: get("slug")?,
            hash: get("hash"),
        })),
        "auth" => Some(Link::Auth(AuthArgs {
            handoff: get("handoff")?,
            state: get("state")?,
        })),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_of(url: &str) -> Option<SetupArgs> {
        match parse_link(url)? {
            Link::Setup(args) => Some(*args),
            _ => None,
        }
    }

    #[test]
    fn parses_a_full_setup_link() {
        let args = setup_of(
            "intentic://setup?code=abc123&name=My%20Sandbox&syncDir=%7E%2Fintentic%2Fwork&platform=https%3A%2F%2Fapi.intentic.dev",
        )
        .unwrap();
        assert_eq!(args.code, "abc123");
        assert_eq!(args.name.as_deref(), Some("My Sandbox"));
        assert_eq!(args.sync_dir.as_deref(), Some("~/intentic/work"));
        assert_eq!(
            args.platform_url.as_deref(),
            Some("https://api.intentic.dev")
        );
        assert_eq!(args.cf_token, None);
    }

    #[test]
    fn parses_a_signin_request() {
        assert_eq!(parse_link("intentic://signin"), Some(Link::SignIn));
    }

    #[test]
    fn parses_both_recreate_modes() {
        assert_eq!(
            parse_link("intentic://recreate?slug=sandbox-abc"),
            Some(Link::Recreate(RecreateArgs {
                slug: "sandbox-abc".into(),
                hash: None
            }))
        );
        assert_eq!(
            parse_link("intentic://recreate?slug=sandbox-abc&hash=deadbeef"),
            Some(Link::Recreate(RecreateArgs {
                slug: "sandbox-abc".into(),
                hash: Some("deadbeef".into())
            }))
        );
    }

    #[test]
    fn parses_an_auth_handoff() {
        let Some(Link::Auth(args)) = parse_link("intentic://auth?handoff=tok&state=nonce") else {
            panic!("expected an auth link");
        };
        assert_eq!(args.handoff, "tok");
        assert_eq!(args.state, "nonce");
    }

    #[test]
    fn rejects_foreign_or_incomplete_links() {
        assert_eq!(parse_link("https://app.intentic.dev/setup?code=x"), None);
        assert_eq!(parse_link("intentic://other?code=x"), None);
        assert_eq!(parse_link("intentic://setup?name=nameless"), None);
        // A handoff with no state cannot be matched to the request that started it, so it is not a handoff.
        assert_eq!(parse_link("intentic://auth?handoff=tok"), None);
    }
}
