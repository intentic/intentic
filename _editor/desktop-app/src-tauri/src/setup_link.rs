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

/* WHO SENT THIS LINK — the whole of what this app can know about whether to believe it.
 *
 * `App` is a navigation the workspace window made itself: the SPA's own "Set up on this computer" button,
 * which says what it does in the sentence above it. `External` is everything else — the OS protocol handler
 * and a second instance's argv — where the link is one ANYBODY can put on a page, in an email or in a chat
 * message, and all the OS showed the user before handing it over was "Open Intentic?".
 *
 * Two of a setup link's values are dropped when it arrives `External`, because both are chosen by the sender
 * and neither is anything the user is shown:
 *   • `platform` names the server the setup code is redeemed against, and that server's answer decides the
 *     new sandbox's own token, the tunnel that puts it on the internet, and WHICH ACCOUNT OWNS IT. Honouring
 *     a stranger's copy stands up a sandbox on this computer that answers to them. Nothing real loses
 *     anything: the SPA only ever sets it when the platform is served from localhost, in local dev.
 *   • `cfToken` is dropped back to where this file's own doc comment already put it — riding the link only
 *     from the in-app webview, where the navigation is cancelled in-process and never reaches the OS. That
 *     was enforced on the SENDING side alone, which is no enforcement at all against a sender who isn't us.
 *
 * What survives (`code`, `name`, `syncDir`) is what the confirmation in windows.rs puts to the user instead. */
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    App,
    External,
}

/// `intentic://setup?code=…` — run the sandbox this setup code was minted for on this computer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupArgs {
    pub code: String,
    pub name: Option<String>,
    /// Own-Cloudflare only. It rides the link ONLY from the in-app webview, where the navigation is cancelled
    /// in-process and never reaches the OS — an external browser's deep link may be logged by the protocol
    /// handler, so from there the launcher asks for the token itself. [`Source`] is what enforces that.
    pub cf_token: Option<String>,
    pub sync_dir: Option<String>,
    /// The API origin the setup code is redeemed against. Local dev only, and [`Source::App`] only — see
    /// [`Source`] for what a stranger's copy of this value would buy them.
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

pub fn parse_link(url: &str, source: Source) -> Option<Link> {
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
        "setup" => {
            let from_app = source == Source::App;
            Some(Link::Setup(Box::new(SetupArgs {
                code: get("code")?,
                name: get("name"),
                cf_token: get("cfToken").filter(|_| from_app),
                sync_dir: get("syncDir"),
                platform_url: get("platform").filter(|_| from_app),
            })))
        }
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
        match parse_link(url, Source::App)? {
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
        assert_eq!(
            parse_link("intentic://signin", Source::App),
            Some(Link::SignIn)
        );
    }

    #[test]
    fn parses_both_recreate_modes() {
        assert_eq!(
            parse_link("intentic://recreate?slug=sandbox-abc", Source::App),
            Some(Link::Recreate(RecreateArgs {
                slug: "sandbox-abc".into(),
                hash: None
            }))
        );
        assert_eq!(
            parse_link(
                "intentic://recreate?slug=sandbox-abc&hash=deadbeef",
                Source::App
            ),
            Some(Link::Recreate(RecreateArgs {
                slug: "sandbox-abc".into(),
                hash: Some("deadbeef".into())
            }))
        );
    }

    #[test]
    fn parses_an_auth_handoff() {
        let Some(Link::Auth(args)) =
            parse_link("intentic://auth?handoff=tok&state=nonce", Source::App)
        else {
            panic!("expected an auth link");
        };
        assert_eq!(args.handoff, "tok");
        assert_eq!(args.state, "nonce");
    }

    #[test]
    fn rejects_foreign_or_incomplete_links() {
        assert_eq!(
            parse_link("https://app.intentic.dev/setup?code=x", Source::App),
            None
        );
        assert_eq!(parse_link("intentic://other?code=x", Source::App), None);
        assert_eq!(
            parse_link("intentic://setup?name=nameless", Source::App),
            None
        );
        // A handoff with no state cannot be matched to the request that started it, so it is not a handoff.
        assert_eq!(parse_link("intentic://auth?handoff=tok", Source::App), None);
    }

    /* THE ONE-CLICK TAKEOVER THIS DROP EXISTS TO STOP.
     *
     * Any page can navigate to `intentic://setup?…`, and the OS hands it to this app on a prompt that says
     * only "Open Intentic?". Were `platform` honoured from there, the setup code would be redeemed against
     * the sender's own server — which answers with the connect token, the tunnel that publishes the sandbox,
     * and the owner email. The victim's machine would then be running a sandbox the sender signs in to. */
    #[test]
    fn an_external_link_cannot_choose_the_platform_or_supply_a_cloudflare_token() {
        let url = "intentic://setup?code=abc123&syncDir=%2Fhome%2Fme&cfToken=cf&platform=https%3A%2F%2Fevil.example";
        let Some(Link::Setup(args)) = parse_link(url, Source::External) else {
            panic!("expected a setup link");
        };
        assert_eq!(args.platform_url, None);
        assert_eq!(args.cf_token, None);
        // The rest survives — it is what the confirmation puts to the user.
        assert_eq!(args.code, "abc123");
        assert_eq!(args.sync_dir.as_deref(), Some("/home/me"));

        // …and the same link from the app's own window keeps both, which is the local-dev path.
        let Some(Link::Setup(args)) = parse_link(url, Source::App) else {
            panic!("expected a setup link");
        };
        assert_eq!(args.platform_url.as_deref(), Some("https://evil.example"));
        assert_eq!(args.cf_token.as_deref(), Some("cf"));
    }
}
