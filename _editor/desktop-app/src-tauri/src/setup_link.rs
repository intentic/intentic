use serde::{Deserialize, Serialize};

/* The workspace window shows remote content, so it gets no IPC at all — its capability list is empty. */

/* WHO SENT THIS LINK — the whole of what this app can know about whether to believe it. */
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source<'a> {
    /// One of this app's own windows, by label: the sender whose links are believed, and the window a
    /// [`WindowVerb`] works — a floating panel's bar works the floating panel's window, not the workspace.
    App {
        window: &'a str,
    },
    /// A window on a folder of the user's own disk (local.rs), by label. Local content, like the app's own
    /// faces, but it draws documents nobody vouched for (a Word file, an SVG, an EPUB), so it is believed about
    /// its own window and the folder it shows and about nothing else: never a setup, a sync, a recreate, a
    /// sign-in. See [`LocalVerb`].
    Files {
        window: &'a str,
    },
    External,
}

impl<'a> Source<'a> {
    pub fn is_app(self) -> bool {
        matches!(self, Source::App { .. })
    }

    /// The window a title-bar press came from, for the two kinds of window that draw their own bar.
    pub fn window(self) -> Option<&'a str> {
        match self {
            Source::App { window } | Source::Files { window } => Some(window),
            Source::External => None,
        }
    }
}

/// `intentic://local?do=…[&path=…]` — what a window on a local folder asks of the app, which it cannot do from
/// the page: pick another folder or file in the system dialog, or show an entry in the file manager. `path`
/// names an entry INSIDE the window's own folder, root-relative, and is resolved against that folder only
/// (local.rs); a page cannot point the app anywhere else by it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalVerb {
    OpenFolder,
    OpenFile,
    Reveal(Option<String>),
    /// "Work on this with an agent": the sandbox the window's folder has, or the question that makes one
    /// (project.rs). About the window's own folder, the only folder it could name.
    Sandbox,
    /// "Ask about this": one file of the window's own (root-relative; a document window's is its document), handed
    /// to the workspace read-only for a quarter of an hour (local.rs `ask`).
    Ask(String),
    /// What the window's project has changed in its sandbox copy, not yet brought back (project.rs).
    Changes,
    /// "Bring back changes": all of them, or only these root-relative paths. Keeps a restore point first.
    BringBack(Option<Vec<String>>),
    /// Put the folder back as it was at a restore point a bring-back kept.
    Restore(String),
    /// Which way the project's sync runs: `to-sandbox` (copy-first, the default) or `both`.
    Direction(String),
}

/// A path a local window names inside its own folder: root-relative, forward slashes, no step out of it, and
/// nothing a command line could read as a flag. No `:` anywhere either: on Windows `C:/x` and `C:x` name a drive
/// rather than an entry of the folder, and `name:stream` an alternate data stream. Everything else is refused before
/// it reaches a folder or an argument vector. The resolution against the folder itself (local.rs `inside`) is the
/// second check, not this.
pub fn is_relative_entry(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.starts_with('/')
        && !path.starts_with('-')
        && !path.contains(['\\', '\0', ':'])
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|segment| !matches!(segment, "" | "." | ".."))
}

/// A restore point's id as the machine agent names them: a plain token, never a flag or a path.
fn is_point_id(point: &str) -> bool {
    (1..=128).contains(&point.len())
        && !point.starts_with('-')
        && point
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

/// A platform sandbox id, the value a hostname carries (`<label>-<sandboxId>.<zone>`): letters, digits, `-` and `_`.
fn is_sandbox_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// A sandbox's slug as `ic` names its containers (`intentic-sandbox-<slug>`): the leading label of its hostname, or
/// twelve hex characters of its connect token. Letters, digits, `-` and `_`, starting with a letter or a digit, so it
/// can never be read as a flag, a path or a second argument.
pub fn is_slug(slug: &str) -> bool {
    (1..=63).contains(&slug.len())
        && slug
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && slug
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// A fix code as the recovery panel mints them: a short plain token, never a flag.
pub fn is_fix_code(code: &str) -> bool {
    (1..=64).contains(&code.len())
        && !code.starts_with('-')
        && code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// `bring-back`'s `paths`: a JSON array of one or more [`is_relative_entry`] paths. Anything else, an empty array
/// included, is no answer rather than "all of them": a page that meant everything sends no `paths` at all.
fn entries_of(json: &str) -> Option<Vec<String>> {
    let paths: Vec<String> = serde_json::from_str(json).ok()?;
    (!paths.is_empty() && paths.len() <= 10_000 && paths.iter().all(|path| is_relative_entry(path)))
        .then_some(paths)
}

/// `intentic://setup?code=…` — run the sandbox this setup code was minted for on this device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupArgs {
    pub code: String,
    /// The platform row this install is for. Grants nothing on its own — the code is the capability — and is
    /// carried so a run that stops here can hand the SAME sandbox back to /setup instead of a blank one.
    pub sandbox_id: Option<String>,
    pub name: Option<String>,
    /// Own-Cloudflare only. It rides the link ONLY from the in-app webview, where the navigation is cancelled
    /// in-process and never reaches the OS — an external browser's deep link may be logged by the protocol
    /// handler, so from there the setup asks for the token itself. [`Source`] is what enforces that.
    pub cf_token: Option<String>,
    pub sync_dir: Option<String>,
    /// The API origin the setup code is redeemed against. Local dev only, and [`Source::App`] only — see
    /// [`Source`] for what a stranger's copy of this value would buy them.
    pub platform_url: Option<String>,
    /// A folder of this computer becoming this sandbox's project (project.rs): its name inside `/work`, from the
    /// setup page. [`Source::App`] only, and never with a folder: the folder is the one this app parked when the
    /// user asked (`project::bind`), so a `syncDir` riding beside it is dropped.
    #[serde(default)]
    pub project: Option<String>,
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

/// `intentic://fix?slug=…[&code=…]`: the recovery panel's button for a sandbox on this machine that cannot be
/// reached. The app runs `ic sandbox fix` for it and shows the run on This device (fix.rs). `code` is a fix code the
/// browser minted, which `ic` claims so the panel that asked mirrors the run live; without one the run still reports
/// to the platform, and nothing waits for it.
///
/// [`Source::App`] only, as `recreate` is, for the same reason: the command starts the moment the link lands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixArgs {
    pub slug: String,
    pub code: Option<String>,
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
    /// A folder of this computer becoming a project of a HOSTED sandbox (project.rs `sync_project`): its name
    /// inside `/work`, validated as `setup`'s is. The folder is the one this app parked, never one on the link.
    #[serde(default)]
    pub project: Option<String>,
    /// The platform's row for that sandbox, remembered with the project so opening the folder again reaches it.
    #[serde(default)]
    pub sandbox_id: Option<String>,
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
    /// The × — which asks the same question the platform's × asked, through the same `request_close`. In a local
    /// window it is the platform's close, which the window's unsaved changes may hold (`confirmed` is the page
    /// saying it already asked, `window?do=close&confirmed=1`; windows.rs).
    Close {
        confirmed: bool,
    },
    /// The page saying whether it holds unsaved changes (`window?do=dirty&value=0|1`): what a local window's close
    /// and the app's Quit ask about first (windows.rs).
    Dirty(bool),
    /// A press on an empty stretch of the bar: hand the window to the platform's own move loop.
    Drag,
    /// Bring the window in front of the reader, out of the tray or from under other windows: what a page's
    /// `window.focus()` would do if a webview's script were allowed to raise the window it is in.
    Raise,
    /// Widen the window to at least this many CSS pixels; a window already that wide is left alone. The
    /// popped-out chat's `window.resizeTo`, which a webview ignores for the same reason as `focus()`.
    Fit(u32),
    /// The page saying which colour scheme it is drawn in, on load and whenever it changes — how the app's
    /// own faces come to be drawn in the same light as the workspace they stand in for.
    Mode(crate::state::Mode),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Link {
    Setup(Box<SetupArgs>),
    Recreate(RecreateArgs),
    Fix(FixArgs),
    Sync(SyncArgs),
    /// `intentic://signin[?switch=1]` — the SPA's login screen asking to be signed in the way this app can be:
    /// in the user's real browser. `switch` is the one thing it carries, because it is the one thing the page
    /// cannot work out for itself: the press meant "not the account you would pick on your own".
    SignIn {
        switch_account: bool,
    },
    Auth(AuthArgs),
    /* `intentic://update` — the workspace banner's button, and the reason the SPA can offer a swap it has no way to perform. */
    Update,
    /// `intentic://launcher[?to=files]`: the workspace's way back to this computer's face, the main local window. Bare,
    /// This device (the setup page's way back to the run it handed over); `to=files`, the folder itself (the sandbox
    /// switcher's "This computer"). The name is the launcher's, whose place the main window took: a page that predates
    /// it still sends it, and an app that predates `to` reads the bare link.
    Launcher {
        files: bool,
    },
    /// See [`WindowVerb`]: the workspace SPA's own title bar, which is a link channel rather than IPC for the
    /// same reason everything else here is.
    Window(WindowVerb),
    /// See [`LocalVerb`]; a local window's only other channel.
    Local(LocalVerb),
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
    let host = parsed.host_str()?;
    // A local window is heard on its own bar and its own folder, and on nothing else (see [`Source::Files`]).
    if matches!(source, Source::Files { .. }) && !matches!(host, "window" | "local") {
        return None;
    }
    match host {
        "local" if matches!(source, Source::Files { .. }) => {
            Some(Link::Local(match get("do")?.as_str() {
                "open-folder" => LocalVerb::OpenFolder,
                "open-file" => LocalVerb::OpenFile,
                "reveal" => LocalVerb::Reveal(get("path")),
                "sandbox" => LocalVerb::Sandbox,
                "ask" => LocalVerb::Ask(get("path").filter(|path| is_relative_entry(path))?),
                "changes" => LocalVerb::Changes,
                // No `paths` is everything; a `paths` that is not a list of entries is no request at all.
                "bring-back" => LocalVerb::BringBack(match get("paths") {
                    Some(json) => Some(entries_of(&json)?),
                    None => None,
                }),
                "restore" => LocalVerb::Restore(get("point").filter(|point| is_point_id(point))?),
                "direction" => LocalVerb::Direction(
                    get("value").filter(|value| matches!(value.as_str(), "to-sandbox" | "both"))?,
                ),
                _ => return None,
            }))
        }
        "local" => None,
        "setup" => {
            let from_app = source.is_app();
            let project = get("project")
                .filter(|_| from_app)
                .filter(|name| crate::project::is_project_dir_name(name));
            Some(Link::Setup(Box::new(SetupArgs {
                code: get("code")?,
                sandbox_id: get("sandbox"),
                name: get("name"),
                cf_token: get("cfToken").filter(|_| from_app),
                sync_dir: get("syncDir").filter(|_| project.is_none()),
                platform_url: get("platform").filter(|_| from_app),
                project,
            })))
        }
        "signin" => Some(Link::SignIn {
            switch_account: get("switch").is_some(),
        }),
        "update" => source.is_app().then_some(Link::Update),
        "launcher" => source.is_app().then(|| Link::Launcher {
            files: get("to").as_deref() == Some("files"),
        }),
        // App-window only, like `update`, and for a sharper reason: see [`SyncArgs`]. There is nothing to
        // strip and keep — the url and the token ARE the request — so an external copy is refused whole.
        "sync" if source.is_app() => {
            let mirror = get("mirror").is_some();
            // A link that names a project is a project's link or nothing: read without it, it would sync the
            // folder with the sandbox's whole `/work`, the one thing a project's folder must never be. So a name
            // that is not a project folder's is no link, and neither is a project on a ports-only pairing, which
            // has no folder to be one.
            let project = match get("project") {
                Some(name) if crate::project::is_project_dir_name(&name) && !mirror => Some(name),
                Some(_) => return None,
                None => None,
            };
            Some(Link::Sync(SyncArgs {
                url: get("url")?,
                pair: get("pair")?,
                name: get("name"),
                takeover: get("takeover").is_some(),
                mirror,
                // The sandbox id means something only beside the project it is remembered with.
                sandbox_id: get("sandbox")
                    .filter(|id| is_sandbox_id(id))
                    .filter(|_| project.is_some()),
                project,
            }))
        }
        "sync" => None,
        // App-window only, like `sync`: this link runs its script the moment it lands, with nothing left to
        // confirm, and the only page that emits one is the SPA's own Update/Environment card.
        "recreate" if source.is_app() => {
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
        // App-window only, like `recreate`: `ic sandbox fix` starts the moment this lands. Both values reach its
        // command line, so each is held to its shape, and a value that is there and malformed drops the link rather
        // than running a fix the page did not ask for (a slug-less `ic sandbox fix` picks the machine's only sandbox).
        "fix" if source.is_app() => {
            let code = match get("code") {
                Some(code) if is_fix_code(&code) => Some(code),
                Some(_) => return None,
                None => None,
            };
            Some(Link::Fix(FixArgs {
                slug: get("slug").filter(|slug| is_slug(slug))?,
                code,
            }))
        }
        "fix" => None,
        "auth" => Some(Link::Auth(AuthArgs {
            handoff: get("handoff")?,
            state: get("state")?,
            profile: get("profile").filter(|name| PROFILES.contains(&name.as_str())),
        })),
        // The page's own title bar. App-window only, and one verb per press — an unknown verb is a page newer
        // than this app, which is the ordinary skew between the two and is answered by doing nothing.
        "window" if source.window().is_some() => Some(Link::Window(match get("do")?.as_str() {
            "ready" => WindowVerb::Ready,
            "minimize" => WindowVerb::Minimize,
            "maximize" => WindowVerb::Maximize,
            "close" => WindowVerb::Close {
                confirmed: switch(get("confirmed"))?,
            },
            "dirty" => WindowVerb::Dirty(switch(Some(get("value")?))?),
            "drag" => WindowVerb::Drag,
            "raise" => WindowVerb::Raise,
            "fit" => WindowVerb::Fit(get("width")?.parse().ok()?),
            "mode" => WindowVerb::Mode(crate::state::Mode::parse(&get("mode")?)?),
            _ => return None,
        })),
        "window" => None,
        _ => None,
    }
}

/// A yes/no a window link carries: `1` or `0`, absent being no. Any other spelling is not an answer, and the
/// link carrying it is dropped rather than guessed at.
fn switch(value: Option<String>) -> Option<bool> {
    match value.as_deref() {
        None | Some("0") => Some(false),
        Some("1") => Some(true),
        Some(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /* The app's own workspace window, which is where every in-app link in these tests comes from. */
    const APP: Source<'static> = Source::App {
        window: crate::windows::WORKSPACE,
    };

    fn setup_of(url: &str) -> Option<SetupArgs> {
        match parse_link(url, APP)? {
            Link::Setup(args) => Some(*args),
            _ => None,
        }
    }

    #[test]
    fn parses_a_full_setup_link() {
        let args = setup_of(
            "intentic://setup?code=abc123&sandbox=sbx_7&name=My%20Sandbox&syncDir=%7E%2Fintentic%2Fwork&platform=https%3A%2F%2Fapi.intentic.dev",
        )
        .unwrap();
        assert_eq!(args.code, "abc123");
        assert_eq!(args.sandbox_id.as_deref(), Some("sbx_7"));
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
            parse_link("intentic://signin", APP),
            Some(Link::SignIn {
                switch_account: false
            })
        );
    }

    /* The press that means "not this account" — dropped here, it becomes a sign-in that repeats itself. */
    #[test]
    fn parses_a_signin_that_asks_for_a_different_account() {
        assert_eq!(
            parse_link("intentic://signin?switch=1", APP),
            Some(Link::SignIn {
                switch_account: true
            })
        );
    }

    #[test]
    fn parses_all_three_recreate_modes() {
        assert_eq!(
            parse_link("intentic://recreate?slug=sandbox-abc", APP),
            Some(Link::Recreate(RecreateArgs {
                slug: "sandbox-abc".into(),
                hash: None,
                rollback: false
            }))
        );
        assert_eq!(
            parse_link("intentic://recreate?slug=sandbox-abc&hash=deadbeef", APP),
            Some(Link::Recreate(RecreateArgs {
                slug: "sandbox-abc".into(),
                hash: Some("deadbeef".into()),
                rollback: false
            }))
        );
        assert_eq!(
            parse_link("intentic://recreate?slug=sandbox-abc&rollback=1", APP),
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
                APP
            ),
            Some(Link::Recreate(RecreateArgs {
                slug: "sandbox-abc".into(),
                hash: None,
                rollback: true
            }))
        );
    }

    /// The recovery panel's button, with the fix code that mirrors the run on that panel and without one; from any of
    /// the app's own windows, as every app link is.
    #[test]
    fn parses_a_fix_link_with_and_without_its_code() {
        assert_eq!(
            parse_link("intentic://fix?slug=sandbox-3f2a9c1d7e4b&code=Xy_9-k2", APP),
            Some(Link::Fix(FixArgs {
                slug: "sandbox-3f2a9c1d7e4b".into(),
                code: Some("Xy_9-k2".into()),
            }))
        );
        assert_eq!(
            parse_link("intentic://fix?slug=work", APP),
            Some(Link::Fix(FixArgs {
                slug: "work".into(),
                code: None,
            }))
        );
        // An empty value is no value, as on every link: a fix the panel does not mirror.
        assert_eq!(
            parse_link("intentic://fix?slug=work&code=", APP),
            Some(Link::Fix(FixArgs {
                slug: "work".into(),
                code: None,
            }))
        );
        assert_eq!(
            parse_link(
                "intentic://fix?slug=work&code=abc",
                Source::App {
                    window: "floating-chat"
                }
            ),
            Some(Link::Fix(FixArgs {
                slug: "work".into(),
                code: Some("abc".into()),
            }))
        );
    }

    /// A fix runs a command the moment it lands, so only the app's own windows may ask for one: not a page in the
    /// user's browser, and not a document in a local window.
    #[test]
    fn a_fix_link_from_outside_the_app_or_a_local_window_is_refused() {
        for link in [
            "intentic://fix?slug=work",
            "intentic://fix?slug=work&code=abc123",
        ] {
            assert_eq!(parse_link(link, Source::External), None, "{link}");
            assert_eq!(parse_link(link, FILES), None, "{link}");
        }
    }

    /// Both values reach `ic`'s command line, so a slug or a code that is not a plain token drops the whole link,
    /// and a link with no slug is none: a slug-less `ic sandbox fix` would pick the machine's only sandbox itself.
    #[test]
    fn a_fix_link_carrying_a_value_it_may_not_is_no_link() {
        for link in [
            "intentic://fix",
            "intentic://fix?code=abc",
            "intentic://fix?slug=-rf",
            "intentic://fix?slug=--code",
            "intentic://fix?slug=_work",
            "intentic://fix?slug=a%2Fb",
            "intentic://fix?slug=..",
            "intentic://fix?slug=a.b",
            "intentic://fix?slug=a%20b",
            "intentic://fix?slug=a%3Bb",
            "intentic://fix?slug=a%0Ab",
            "intentic://fix?slug=work&code=--accept",
            "intentic://fix?slug=work&code=-x",
            "intentic://fix?slug=work&code=a%20b",
            "intentic://fix?slug=work&code=a%2Fb",
            "intentic://fix?slug=work&code=a.b",
            "intentic://fix?slug=work&code=a%2Cb",
        ] {
            assert_eq!(parse_link(link, APP), None, "{link}");
        }
        let longest = format!("intentic://fix?slug={}", "a".repeat(63));
        assert!(matches!(parse_link(&longest, APP), Some(Link::Fix(_))));
        let too_long = format!("intentic://fix?slug={}", "a".repeat(64));
        assert_eq!(parse_link(&too_long, APP), None);
        let longest_code = format!("intentic://fix?slug=work&code={}", "c".repeat(64));
        assert!(matches!(parse_link(&longest_code, APP), Some(Link::Fix(_))));
        let too_long_code = format!("intentic://fix?slug=work&code={}", "c".repeat(65));
        assert_eq!(parse_link(&too_long_code, APP), None);
    }

    /* THE ONE LINK THAT ENDS THE PROCESS, so it is the one link only this app's own window may send. */
    #[test]
    fn only_this_apps_own_window_can_ask_it_to_replace_itself() {
        assert_eq!(parse_link("intentic://update", APP), Some(Link::Update));
        assert_eq!(parse_link("intentic://update", Source::External), None);
    }

    /// The way back to this computer's face is the app's own window's to ask for, exactly like the update.
    #[test]
    fn the_launcher_link_is_honoured_from_the_app_and_refused_from_outside() {
        assert_eq!(
            parse_link("intentic://launcher", APP),
            Some(Link::Launcher { files: false })
        );
        assert_eq!(
            parse_link("intentic://launcher?to=files", APP),
            Some(Link::Launcher { files: true })
        );
        // Anything else it might say is This device, as a bare link is.
        assert_eq!(
            parse_link("intentic://launcher?to=elsewhere", APP),
            Some(Link::Launcher { files: false })
        );
        assert_eq!(parse_link("intentic://launcher", Source::External), None);
    }

    #[test]
    fn parses_a_sync_enrollment_from_the_apps_own_window() {
        let Some(Link::Sync(args)) = parse_link(
            "intentic://sync?url=https%3A%2F%2Fsandbox-abc.example.dev&pair=tok123&name=My%20Sandbox&takeover=1",
            APP,
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
            APP,
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
        assert_eq!(parse_link("intentic://sync?pair=tok123", APP), None);
        assert_eq!(
            parse_link(
                "intentic://sync?url=https%3A%2F%2Fsandbox-abc.example.dev",
                APP
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
            (
                "intentic://window?do=close",
                WindowVerb::Close { confirmed: false },
            ),
            (
                "intentic://window?do=close&confirmed=1",
                WindowVerb::Close { confirmed: true },
            ),
            (
                "intentic://window?do=close&confirmed=0",
                WindowVerb::Close { confirmed: false },
            ),
            (
                "intentic://window?do=dirty&value=1",
                WindowVerb::Dirty(true),
            ),
            (
                "intentic://window?do=dirty&value=0",
                WindowVerb::Dirty(false),
            ),
            ("intentic://window?do=drag", WindowVerb::Drag),
            ("intentic://window?do=raise", WindowVerb::Raise),
            ("intentic://window?do=fit&width=1280", WindowVerb::Fit(1280)),
            (
                "intentic://window?do=mode&mode=light",
                WindowVerb::Mode(crate::state::Mode::Light),
            ),
            (
                "intentic://window?do=mode&mode=dark",
                WindowVerb::Mode(crate::state::Mode::Dark),
            ),
        ] {
            assert_eq!(parse_link(link, APP), Some(Link::Window(verb)), "{link}");
        }
    }

    /* THE BAR BELONGS TO THIS WINDOW, so only this window may work it. */
    #[test]
    fn a_title_bar_press_is_refused_from_outside_the_app_and_when_it_names_nothing() {
        assert_eq!(
            parse_link("intentic://window?do=close", Source::External),
            None
        );
        assert_eq!(parse_link("intentic://window?do=explode", APP), None);
        assert_eq!(parse_link("intentic://window", APP), None);
        // A scheme this app cannot draw is not one it remembers.
        assert_eq!(
            parse_link("intentic://window?do=mode&mode=sepia", APP),
            None
        );
        assert_eq!(parse_link("intentic://window?do=mode", APP), None);
        // A width that is not a whole number of pixels is not a size this app can give a window.
        assert_eq!(parse_link("intentic://window?do=fit", APP), None);
        assert_eq!(parse_link("intentic://window?do=fit&width=wide", APP), None);
        assert_eq!(parse_link("intentic://window?do=fit&width=-4", APP), None);
        // Unsaved changes are a yes or a no, said outright: no value, or any other spelling, is not an answer.
        assert_eq!(parse_link("intentic://window?do=dirty", APP), None);
        assert_eq!(
            parse_link("intentic://window?do=dirty&value=yes", APP),
            None
        );
        assert_eq!(parse_link("intentic://window?do=dirty&value=2", APP), None);
        assert_eq!(
            parse_link("intentic://window?do=close&confirmed=yes", APP),
            None
        );
        assert_eq!(
            parse_link("intentic://window?do=dirty&value=1", Source::External),
            None
        );
        assert_eq!(
            parse_link("intentic://window?do=close&confirmed=1", Source::External),
            None
        );
    }

    /* A LINK FROM A WINDOW NAMES THAT WINDOW, whichever of the app's own it is. */
    #[test]
    fn a_window_link_is_believed_from_any_of_the_apps_own_windows() {
        let floating = Source::App {
            window: "floating-chat",
        };
        assert!(floating.is_app());
        assert!(!Source::External.is_app());
        assert_eq!(
            parse_link("intentic://window?do=close", floating),
            Some(Link::Window(WindowVerb::Close { confirmed: false }))
        );
    }

    #[test]
    fn parses_an_auth_handoff() {
        let Some(Link::Auth(args)) = parse_link("intentic://auth?handoff=tok&state=nonce", APP)
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
            parse_link("https://app.intentic.dev/setup?code=x", APP),
            None
        );
        assert_eq!(parse_link("intentic://other?code=x", APP), None);
        assert_eq!(parse_link("intentic://setup?name=nameless", APP), None);
        // A handoff with no state cannot be matched to the request that started it, so it is not a handoff.
        assert_eq!(parse_link("intentic://auth?handoff=tok", APP), None);
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
        let Some(Link::Setup(args)) = parse_link(url, APP) else {
            panic!("expected a setup link");
        };
        assert_eq!(args.platform_url.as_deref(), Some("https://evil.example"));
        assert_eq!(args.cf_token.as_deref(), Some("cf"));
    }

    /* A LOCAL WINDOW draws documents nobody vouched for, so it is heard on its own bar and its own folder alone. */

    const FILES: Source<'static> = Source::Files { window: "files-1" };

    /// A project's folder is the one the app parked, so a link may name the project but never where it lives.
    #[test]
    fn a_project_setup_carries_its_name_from_the_app_and_no_folder() {
        let args = setup_of("intentic://setup?code=abc&project=my-app&syncDir=%2Fetc").unwrap();
        assert_eq!(args.project.as_deref(), Some("my-app"));
        assert_eq!(args.sync_dir, None);
        let Some(Link::Setup(outside)) =
            parse_link("intentic://setup?code=abc&project=my-app", Source::External)
        else {
            panic!("an external setup link still parses");
        };
        assert_eq!(outside.project, None);
        assert_eq!(
            setup_of("intentic://setup?code=abc&project=..%2Fetc")
                .unwrap()
                .project,
            None
        );
    }

    #[test]
    fn a_local_window_asks_for_a_dialog_or_the_file_manager_about_its_own_folder() {
        assert_eq!(
            parse_link("intentic://local?do=open-folder", FILES),
            Some(Link::Local(LocalVerb::OpenFolder))
        );
        assert_eq!(
            parse_link("intentic://local?do=open-file", FILES),
            Some(Link::Local(LocalVerb::OpenFile))
        );
        assert_eq!(
            parse_link("intentic://local?do=reveal&path=docs%2Fa.md", FILES),
            Some(Link::Local(LocalVerb::Reveal(Some("docs/a.md".into()))))
        );
        assert_eq!(
            parse_link("intentic://local?do=reveal", FILES),
            Some(Link::Local(LocalVerb::Reveal(None)))
        );
        assert_eq!(parse_link("intentic://local?do=delete", FILES), None);
        assert_eq!(
            parse_link("intentic://window?do=close", FILES),
            Some(Link::Window(WindowVerb::Close { confirmed: false }))
        );
        // The unsaved-changes protocol is a local window's own bar too.
        assert_eq!(
            parse_link("intentic://window?do=close&confirmed=1", FILES),
            Some(Link::Window(WindowVerb::Close { confirmed: true }))
        );
        assert_eq!(
            parse_link("intentic://window?do=dirty&value=1", FILES),
            Some(Link::Window(WindowVerb::Dirty(true)))
        );
    }

    /// The project verbs and "Ask about this", each carrying only what its value may be.
    #[test]
    fn a_local_window_asks_about_a_file_and_works_its_project() {
        for (link, verb) in [
            (
                "intentic://local?do=ask&path=docs%2Fbrief.docx",
                LocalVerb::Ask("docs/brief.docx".into()),
            ),
            ("intentic://local?do=changes", LocalVerb::Changes),
            ("intentic://local?do=bring-back", LocalVerb::BringBack(None)),
            (
                "intentic://local?do=bring-back&paths=%5B%22src%2Fa.ts%22%2C%22My%20Notes.md%22%5D",
                LocalVerb::BringBack(Some(vec!["src/a.ts".into(), "My Notes.md".into()])),
            ),
            (
                "intentic://local?do=restore&point=2026-09-28T10-00-00Z.1",
                LocalVerb::Restore("2026-09-28T10-00-00Z.1".into()),
            ),
            (
                "intentic://local?do=direction&value=to-sandbox",
                LocalVerb::Direction("to-sandbox".into()),
            ),
            (
                "intentic://local?do=direction&value=both",
                LocalVerb::Direction("both".into()),
            ),
        ] {
            assert_eq!(parse_link(link, FILES), Some(Link::Local(verb)), "{link}");
        }
    }

    /// Every value is held to its shape before it reaches a folder or the machine agent's command line: no step out
    /// of the folder, no absolute path, nothing that reads as a flag, no direction this app does not know.
    #[test]
    fn a_local_verb_carrying_a_value_it_may_not_is_refused_whole() {
        for link in [
            "intentic://local?do=ask",
            "intentic://local?do=ask&path=..%2Fsecret.txt",
            "intentic://local?do=ask&path=docs%2F..%2F..%2Fx",
            "intentic://local?do=ask&path=%2Fetc%2Fpasswd",
            "intentic://local?do=ask&path=C%3A%5Cx",
            "intentic://local?do=ask&path=a%2F%2Fb",
            "intentic://local?do=ask&path=.%2Fa",
            "intentic://local?do=ask&path=-rf",
            // A drive, however it is spelled, and an alternate data stream: never an entry of the folder.
            "intentic://local?do=ask&path=C%3A%2FWindows%2Fwin.ini",
            "intentic://local?do=ask&path=C%3Asecret.txt",
            "intentic://local?do=ask&path=docs%2Fa.md%3Ahidden",
            "intentic://local?do=bring-back&paths=%5B%22C%3A%2Fx%22%5D",
            "intentic://local?do=bring-back&paths=%5B%5D",
            "intentic://local?do=bring-back&paths=not-json",
            "intentic://local?do=bring-back&paths=%5B1%5D",
            "intentic://local?do=bring-back&paths=%5B%22..%2Fx%22%5D",
            "intentic://local?do=bring-back&paths=%22a.md%22",
            "intentic://local?do=restore",
            "intentic://local?do=restore&point=--all",
            "intentic://local?do=restore&point=a%2Fb",
            "intentic://local?do=restore&point=a%20b",
            "intentic://local?do=direction",
            "intentic://local?do=direction&value=from-sandbox",
            "intentic://local?do=direction&value=BOTH",
        ] {
            assert_eq!(parse_link(link, FILES), None, "{link}");
        }
        assert!(is_relative_entry("a/b c/d.md"));
        assert!(!is_relative_entry(""));
        assert!(!is_relative_entry("a/"));
        assert!(!is_relative_entry("a\u{7}b"));
        assert!(!is_relative_entry(&"a".repeat(4097)));
        assert!(!is_relative_entry("C:/Windows/win.ini"));
        assert!(!is_relative_entry("C:secret.txt"));
        assert!(!is_relative_entry("notes/a.md:stream"));
        assert!(!is_relative_entry("D:"));
    }

    /// The project verbs are a local window's alone, like every other local verb.
    #[test]
    fn the_project_verbs_are_refused_from_the_workspace_and_from_outside() {
        for link in [
            "intentic://local?do=ask&path=a.md",
            "intentic://local?do=changes",
            "intentic://local?do=bring-back",
            "intentic://local?do=restore&point=p1",
            "intentic://local?do=direction&value=both",
        ] {
            assert_eq!(parse_link(link, APP), None, "{link}");
            assert_eq!(parse_link(link, Source::External), None, "{link}");
        }
    }

    /// A hosted sandbox's project: the name is held to the same rule `setup`'s is, the sandbox id to what a
    /// hostname carries, and the id means nothing without a project beside it.
    #[test]
    fn a_sync_link_may_name_a_project_and_its_sandbox() {
        let Some(Link::Sync(args)) = parse_link(
            "intentic://sync?url=https%3A%2F%2Fsandbox-abc.example.dev&pair=tok&project=my-app&sandbox=sbx_7",
            APP,
        ) else {
            panic!("expected a sync link");
        };
        assert_eq!(args.project.as_deref(), Some("my-app"));
        assert_eq!(args.sandbox_id.as_deref(), Some("sbx_7"));

        // A malformed id is not remembered, and the project still is: it names nothing the sync acts on.
        let Some(Link::Sync(bad_id)) = parse_link(
            "intentic://sync?url=https%3A%2F%2Fx&pair=tok&project=my-app&sandbox=a%2Fb",
            APP,
        ) else {
            panic!("expected a sync link");
        };
        assert_eq!(bad_id.project.as_deref(), Some("my-app"));
        assert_eq!(bad_id.sandbox_id, None);

        // An id with no project beside it is not carried.
        let Some(Link::Sync(plain)) = parse_link(
            "intentic://sync?url=https%3A%2F%2Fx&pair=tok&sandbox=sbx_7",
            APP,
        ) else {
            panic!("expected a sync link");
        };
        assert_eq!(plain.project, None);
        assert_eq!(plain.sandbox_id, None);
    }

    /// A link that names a project is that project's or nothing: read without its project it would sync the folder
    /// with the sandbox's whole `/work`. A name that is not a project folder's, or a project on a ports-only pairing
    /// (which has no folder to be one), drops the link rather than falling back to a plain enrollment.
    #[test]
    fn a_sync_link_naming_a_project_it_may_not_is_no_link() {
        for link in [
            "intentic://sync?url=https%3A%2F%2Fx&pair=tok&project=..%2Fetc&sandbox=sbx_7",
            "intentic://sync?url=https%3A%2F%2Fx&pair=tok&project=public",
            "intentic://sync?url=https%3A%2F%2Fx&pair=tok&project=-x",
            "intentic://sync?url=https%3A%2F%2Fx&pair=tok&project=a%2Fb",
            "intentic://sync?url=https%3A%2F%2Fx&pair=tok&mirror=1&project=my-app&sandbox=sbx_7",
        ] {
            assert_eq!(parse_link(link, APP), None, "{link}");
        }
        // An empty value is no value, as on every link: the plain enrollment it then is names no project.
        let Some(Link::Sync(empty)) =
            parse_link("intentic://sync?url=https%3A%2F%2Fx&pair=tok&project=", APP)
        else {
            panic!("expected a sync link");
        };
        assert_eq!(empty.project, None);

        // Still the app's own window's alone, project or not.
        assert_eq!(
            parse_link(
                "intentic://sync?url=https%3A%2F%2Fx&pair=tok&project=my-app",
                Source::External
            ),
            None
        );
        assert_eq!(
            parse_link(
                "intentic://sync?url=https%3A%2F%2Fx&pair=tok&project=my-app",
                FILES
            ),
            None
        );
    }

    /// Everything a local window could be made to send that acts beyond its own window: none of it is heard.
    #[test]
    fn a_local_window_is_never_heard_on_a_setup_a_sync_a_recreate_or_a_sign_in() {
        for link in [
            "intentic://setup?code=abc123",
            "intentic://sync?url=https%3A%2F%2Fx&pair=p",
            "intentic://recreate?slug=sandbox-abc",
            "intentic://fix?slug=sandbox-abc",
            "intentic://update",
            "intentic://launcher",
            "intentic://signin",
            "intentic://auth?handoff=h&state=s",
        ] {
            assert_eq!(parse_link(link, FILES), None, "{link}");
        }
    }

    /// And the local verbs belong to local windows alone: the workspace and the outside have no folder to ask about.
    #[test]
    fn the_local_verbs_are_refused_from_the_workspace_and_from_outside() {
        assert_eq!(parse_link("intentic://local?do=open-folder", APP), None);
        assert_eq!(
            parse_link("intentic://local?do=open-folder", Source::External),
            None
        );
    }
}
