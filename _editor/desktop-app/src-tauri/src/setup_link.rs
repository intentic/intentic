use serde::{Deserialize, Serialize};

/* The workspace window shows remote content, so it gets no IPC at all — its capability list is empty. */

/* WHO SENT THIS LINK — the whole of what this app can know about whether to believe it. */
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    App,
    External,
}

/// `intentic://setup?code=…` — run the sandbox this setup code was minted for on this device.
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

/// `intentic://recreate?slug=…[&hash=…][&rollback=1]` — swap the sandbox onto a different image. This is what
/// turns the SPA's "paste this command on the machine that runs your sandbox" cards into buttons: the daemon
/// holds no host Docker socket, so it can never recreate its own container, and this app is the thing on that
/// machine. No hash updates to the fresh `:stable` base; a hash builds the owner-approved overlay pinned to
/// that digest — the same argument shapes the pasted command has always carried.
///
/// `rollback` is the third, and it carries no digest of its own: it names the image this sandbox ran BEFORE its
/// last update, which the machine already knows. It exists here because the card that offers it had a button on
/// every other path and a command block on this one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecreateArgs {
    pub slug: String,
    pub hash: Option<String>,
    pub rollback: bool,
}

/// `intentic://sync?url=…&pair=…[&name=…][&takeover=1][&mirror=1]` — enroll THIS device in desktop sync:
/// the SPA's Desktop sync card handing over the enrollment it just minted, so the app can ask for the folder
/// in a system dialog and run the same sync script the copy-paste one-liner runs. No folder rides the link —
/// choosing one natively is the whole point of the handoff.
///
/// [`Source::App`] ONLY, refused outright from outside. The pairing token enrolls a machine into TWO-WAY file
/// sync with whatever sandbox `url` names, and both values are chosen by the sender: honoured from the OS
/// handler, any page could put a victim one folder pick away from mirroring that folder into a sandbox the
/// sender signs in to. An external browser keeps the pasted one-liner, which at least shows what it carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncArgs {
    pub url: String,
    pub pair: String,
    /// The sandbox's display name, for the screen that runs it — the URL names a host, not the thing the
    /// user called their sandbox.
    pub name: Option<String>,
    /// Move sync here from another machine already enrolled (revokes its key) — the card's own opt-in.
    pub takeover: bool,
    /// A ports-only enrollment: the daemon granted a mirror pairing, so there is no folder to pick and no
    /// SYNC_DIR to pass. The app runs the same script; the agent learns the mode from the token it redeems.
    pub mirror: bool,
}

/// `intentic://auth?handoff=…&state=…[&profile=…]` — the credential coming back from a sign-in that happened
/// in the user's real browser (see auth.rs for why it never happens in the webview).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthArgs {
    pub handoff: String,
    pub state: String,
    /// The profile that browser was reading the app in (`@intentic/constants` profile.ts: `default`,
    /// `desk`), carried so the workspace this app opens is in the same look the reader arrived from. The
    /// page adopts it off its own query string; nothing here interprets it beyond checking it is a name.
    pub profile: Option<String>,
}

/// The profile names the page will adopt. Anything else is dropped rather than forwarded: the value lands
/// on a URL this app navigates to, and a name is the only thing it is allowed to be.
const PROFILES: [&str; 2] = ["default", "desk"];

/* Window links carry their action in the `do` query parameter. */
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowVerb {
    /* THE PAGE ANNOUNCING ITS OWN BAR IS UP, which is what keeps a frameless window from ever being a trap. */
    Ready,
    Minimize,
    /// Maximise or restore, one verb: it is one button, and which of the two it does is a fact about the
    /// window rather than about the press.
    Maximize,
    /// The × — which asks the same question the platform's × asked, through the same `request_close`.
    Close,
    /// A press on an empty stretch of the bar: hand the window to the platform's own move loop.
    Drag,
    /// The page saying which colour scheme it is drawn in, on load and whenever it changes — how the app's
    /// own faces come to be drawn in the same light as the workspace they stand in for.
    Mode(crate::state::Mode),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Link {
    Setup(Box<SetupArgs>),
    Recreate(RecreateArgs),
    Sync(SyncArgs),
    /// `intentic://signin` — the SPA's login screen asking to be signed in the way this app can be: in the
    /// user's real browser. It carries nothing, because everything it starts is minted afterwards.
    SignIn,
    Auth(AuthArgs),
    /* `intentic://update` — the workspace banner's button, and the reason the SPA can offer a swap it has no way to perform. */
    Update,
    /* `intentic://launcher` — the setup page's way back to the app's own face after "Back to your workspace" stepped it aside. */
    Launcher,
    /// See [`WindowVerb`]: the workspace SPA's own title bar, which is a link channel rather than IPC for the
    /// same reason everything else here is.
    Window(WindowVerb),
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
        "update" => (source == Source::App).then_some(Link::Update),
        "launcher" => (source == Source::App).then_some(Link::Launcher),
        // App-window only, like `update`, and for a sharper reason: see [`SyncArgs`]. There is nothing to
        // strip and keep — the url and the token ARE the request — so an external copy is refused whole.
        "sync" if source == Source::App => Some(Link::Sync(SyncArgs {
            url: get("url")?,
            pair: get("pair")?,
            name: get("name"),
            takeover: get("takeover").is_some(),
            mirror: get("mirror").is_some(),
        })),
        "sync" => None,
        // App-window only, like `sync`: this link runs its script the moment it lands, with nothing left to
        // confirm, and the only page that emits one is the SPA's own Update/Environment card.
        "recreate" if source == Source::App => {
            let rollback = get("rollback").is_some();
            Some(Link::Recreate(RecreateArgs {
                slug: get("slug")?,
                // A rollback names its own destination, so a digest arriving beside it is dropped rather than
                // silently turning the run into a rebuild — the same precedence recreate_script enforces.
                hash: get("hash").filter(|_| !rollback),
                rollback,
            }))
        }
        "recreate" => None,
        "auth" => Some(Link::Auth(AuthArgs {
            handoff: get("handoff")?,
            state: get("state")?,
            profile: get("profile").filter(|name| PROFILES.contains(&name.as_str())),
        })),
        // The page's own title bar. App-window only, and one verb per press — an unknown verb is a page newer
        // than this app, which is the ordinary skew between the two and is answered by doing nothing.
        "window" if source == Source::App => Some(Link::Window(match get("do")?.as_str() {
            "ready" => WindowVerb::Ready,
            "minimize" => WindowVerb::Minimize,
            "maximize" => WindowVerb::Maximize,
            "close" => WindowVerb::Close,
            "drag" => WindowVerb::Drag,
            "mode" => WindowVerb::Mode(crate::state::Mode::parse(&get("mode")?)?),
            _ => return None,
        })),
        "window" => None,
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
    fn parses_all_three_recreate_modes() {
        assert_eq!(
            parse_link("intentic://recreate?slug=sandbox-abc", Source::App),
            Some(Link::Recreate(RecreateArgs {
                slug: "sandbox-abc".into(),
                hash: None,
                rollback: false
            }))
        );
        assert_eq!(
            parse_link(
                "intentic://recreate?slug=sandbox-abc&hash=deadbeef",
                Source::App
            ),
            Some(Link::Recreate(RecreateArgs {
                slug: "sandbox-abc".into(),
                hash: Some("deadbeef".into()),
                rollback: false
            }))
        );
        assert_eq!(
            parse_link(
                "intentic://recreate?slug=sandbox-abc&rollback=1",
                Source::App
            ),
            Some(Link::Recreate(RecreateArgs {
                slug: "sandbox-abc".into(),
                hash: None,
                rollback: true
            }))
        );
    }

    /// A recreate acts on the container the moment it lands — no requirements pass, no card, nothing to
    /// answer — so an external one would let any page a reader visits restart their sandbox onto a rollback
    /// image or a digest the sender chose. The whole link is refused, as `sync` is.
    #[test]
    fn a_recreate_link_from_outside_the_app_is_refused_entirely() {
        for link in [
            "intentic://recreate?slug=sandbox-abc",
            "intentic://recreate?slug=sandbox-abc&hash=deadbeef",
            "intentic://recreate?slug=sandbox-abc&rollback=1",
        ] {
            assert_eq!(parse_link(link, Source::External), None, "{link}");
        }
    }

    /// Two destinations in one link is a caller's bug; the rollback wins and the digest is dropped, rather than
    /// the run quietly becoming a rebuild of an overlay nobody asked for.
    #[test]
    fn a_rollback_link_drops_any_digest_riding_with_it() {
        assert_eq!(
            parse_link(
                "intentic://recreate?slug=sandbox-abc&hash=deadbeef&rollback=1",
                Source::App
            ),
            Some(Link::Recreate(RecreateArgs {
                slug: "sandbox-abc".into(),
                hash: None,
                rollback: true
            }))
        );
    }

    /* THE ONE LINK THAT ENDS THE PROCESS, so it is the one link only this app's own window may send. */
    #[test]
    fn only_this_apps_own_window_can_ask_it_to_replace_itself() {
        assert_eq!(
            parse_link("intentic://update", Source::App),
            Some(Link::Update)
        );
        assert_eq!(parse_link("intentic://update", Source::External), None);
    }

    /// The way back to the setup card is the app's own window's to ask for, exactly like the update.
    #[test]
    fn the_launcher_link_is_honoured_from_the_app_and_refused_from_outside() {
        assert_eq!(
            parse_link("intentic://launcher", Source::App),
            Some(Link::Launcher)
        );
        assert_eq!(parse_link("intentic://launcher", Source::External), None);
    }

    #[test]
    fn parses_a_sync_enrollment_from_the_apps_own_window() {
        let Some(Link::Sync(args)) = parse_link(
            "intentic://sync?url=https%3A%2F%2Fsandbox-abc.example.dev&pair=tok123&name=My%20Sandbox&takeover=1",
            Source::App,
        ) else {
            panic!("expected a sync link");
        };
        assert_eq!(args.url, "https://sandbox-abc.example.dev");
        assert_eq!(args.pair, "tok123");
        assert_eq!(args.name.as_deref(), Some("My Sandbox"));
        assert!(args.takeover);
        assert!(!args.mirror);

        let Some(Link::Sync(mirror)) = parse_link(
            "intentic://sync?url=https%3A%2F%2Fsandbox-abc.example.dev&pair=tok123&mirror=1",
            Source::App,
        ) else {
            panic!("expected a mirror sync link");
        };
        assert!(mirror.mirror);
        assert_eq!(mirror.name, None);
    }

    /* THE FOLDER-EXFILTRATION LINK THIS REFUSAL EXISTS TO STOP. */
    #[test]
    fn a_sync_link_from_outside_the_app_is_refused_entirely() {
        assert_eq!(
            parse_link(
                "intentic://sync?url=https%3A%2F%2Fevil.example&pair=tok123",
                Source::External
            ),
            None
        );
    }

    #[test]
    fn a_sync_link_missing_its_sandbox_or_token_is_not_one() {
        assert_eq!(parse_link("intentic://sync?pair=tok123", Source::App), None);
        assert_eq!(
            parse_link(
                "intentic://sync?url=https%3A%2F%2Fsandbox-abc.example.dev",
                Source::App
            ),
            None
        );
    }

    /// Every press the page's own title bar can make, including the one that looks like it needs IPC: a drag
    /// is a link too, which is what lets a window with no command surface still be moved by its own bar.
    #[test]
    fn parses_every_verb_of_the_pages_own_title_bar() {
        for (link, verb) in [
            ("intentic://window?do=ready", WindowVerb::Ready),
            ("intentic://window?do=minimize", WindowVerb::Minimize),
            ("intentic://window?do=maximize", WindowVerb::Maximize),
            ("intentic://window?do=close", WindowVerb::Close),
            ("intentic://window?do=drag", WindowVerb::Drag),
            (
                "intentic://window?do=mode&mode=light",
                WindowVerb::Mode(crate::state::Mode::Light),
            ),
            (
                "intentic://window?do=mode&mode=dark",
                WindowVerb::Mode(crate::state::Mode::Dark),
            ),
        ] {
            assert_eq!(
                parse_link(link, Source::App),
                Some(Link::Window(verb)),
                "{link}"
            );
        }
    }

    /* THE BAR BELONGS TO THIS WINDOW, so only this window may work it. */
    #[test]
    fn a_title_bar_press_is_refused_from_outside_the_app_and_when_it_names_nothing() {
        assert_eq!(
            parse_link("intentic://window?do=close", Source::External),
            None
        );
        assert_eq!(
            parse_link("intentic://window?do=explode", Source::App),
            None
        );
        assert_eq!(parse_link("intentic://window", Source::App), None);
        // A scheme this app cannot draw is not one it remembers.
        assert_eq!(
            parse_link("intentic://window?do=mode&mode=sepia", Source::App),
            None
        );
        assert_eq!(parse_link("intentic://window?do=mode", Source::App), None);
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
        assert_eq!(args.profile, None);
    }

    /* THE LOOK THE READER ARRIVED IN rides the handoff — and only a name this app knows does. */
    #[test]
    fn an_auth_handoff_carries_a_known_profile_and_drops_anything_else() {
        let Some(Link::Auth(desk)) = parse_link(
            "intentic://auth?handoff=tok&state=nonce&profile=desk",
            Source::External,
        ) else {
            panic!("expected an auth link");
        };
        assert_eq!(desk.profile.as_deref(), Some("desk"));
        let Some(Link::Auth(odd)) = parse_link(
            "intentic://auth?handoff=tok&state=nonce&profile=..%2Fevil",
            Source::External,
        ) else {
            panic!("expected an auth link");
        };
        assert_eq!(
            odd.profile, None,
            "a value that is not a profile name never reaches a URL"
        );
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

    /* External setup links may not supply platform or Cloudflare credentials. */
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
