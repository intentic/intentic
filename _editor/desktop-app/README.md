# @intentic/desktop-app

The no-terminal way to run an intentic sandbox on your own computer.

A Windows and Linux desktop app that installs the sandbox, and the thing that updates it afterwards. Install it,
sign in, click **Run on this computer**.

```
        ONE WINDOW, TWO SCREENS — whichever is up takes the other's frame

┌─ Intentic ────────────────────────────┐   ┌─ Intentic — Setting up your sandbox ──┐
│  app.intentic.dev — the hosted SPA    │ ⇄ │  ⚡ pulling the sandbox image…        │
│  no IPC · intentic:// links only      │   │  ● work    ▶ ■  update  logs         │
└───────────────────────────────────────┘   └──────────────────────────────────────┘
                    │                                       │
                    └──────────── Rust shell ───────────────┘
                         windows · tray · deep link · updater
                                       │
                        sh connect.sh / recreate.sh / cleanup.sh
                        powershell connect.ps1 / recreate.ps1 / cleanup.ps1
```

## What it is — and is not

The app **preserves the product model**: a sandbox is still a Docker container, the UI is still
`@intentic-app/web` talking to the daemon directly, and the browser path keeps working on the same sandbox
from any device. The app adds no third plane. It is three thin native things around the existing product:

1. **A shell for the hosted SPA.** The workspace screen loads `https://app.intentic.dev`
   (override: `INTENTIC_APP_URL`, or settings). It gets **no IPC at all** — its capability list is empty, and
   its only channel into the app is an `intentic://` navigation the window intercepts in Rust.
2. **A script runner.** Every machine operation is one of the scripts the copy-paste one-liners already run,
   spawned as a child process with its output streamed into the app's own screen.
3. **A lifecycle manager.** Setup progress, then status, logs, start/stop, update, rebuild, remove — plus what
   **desktop sync** is doing here, read by spawning `intentic-sync status --json` exactly as the lifecycle
   actions spawn their scripts, and rendered with `@intentic/ui`'s `MachineDetail` (the same component the web
   app's Computers tab uses, so the two cannot describe one machine differently).

   That third item was the app's largest blind spot: `SYNC_DIR` rides the setup link into `connect.sh` and was
   never heard from again, so the window that exists to be the no-terminal way to run a sandbox could show a
   container as up and say nothing whatsoever about the sync the same setup had just configured. The only
   rendering of those facts was `intentic-sync status`, in a terminal.

## Two webviews, one window

There have to be two webviews: Tauri scopes capabilities by window **label**, so giving the hosted SPA the
same label as the local UI would hand `app.intentic.dev` that UI's permissions. What the user is owed, though,
is not one webview but one **window** — and the first version of this app did not deliver it. Clicking *Set up
on this computer* in the SPA opened a second, differently-titled window ("Sandbox Manager") on top of the one
being read, which is where first-time users stopped.

So `windows.rs` keeps exactly one of them on screen: whichever screen is being shown first takes the other's
position and size, then the other hides. The title follows the content (`App.vue` sets it), the frame does
not, and clicking a handoff reads as the window changing screens. Two consequences worth knowing:

- **A cold start with the SPA's own link opens no workspace first.** `intentic://setup` in argv means the setup
  screen is what appears — otherwise the app would load the SPA only to cover it a frame later.
- **A parked setup runs on arrival — when the SPA's own window asked for it.** That button is the consent;
  asking again on a screen the user did not open is what made the handoff feel like a second, unrelated
  installer. It is also the *only* direction that consent covers, which is what [the link's
  source](#a-link-from-outside-is-not-a-link-from-us) is about.
- **Closing the workspace face asks what to do; by default it hides and the app lives in the tray.** The window
  is hidden rather than destroyed, so reopening is instant and the webview keeps the session it signed in with.
  Closing the launcher face is a step back to the workspace.

  The cost of that model is a process the user cannot see, and it has already been paid once: nobody found the
  tray icon, and the app was met instead as the uninstaller's *"Intentic is running"* prompt. Windows is why —
  it files new tray icons behind the overflow arrow by default and no app can promote itself out of there. Two
  things answer it, and neither is optional to the design: the **×** raises the app's own confirmation before
  anything moves, and the uninstaller **closes the app itself** instead of asking
  ([`installer-hooks.nsh`](src-tauri/installer-hooks.nsh), which `installer.nsi` inserts ahead of its own
  running-app check).

### The × is a question — `confirm-close`

The first answer to the invisible-process problem was a notice *after* the fact: the window vanished and an OS
message box reported that Intentic was "still running". It reported rather than asked, so the only gesture it
left was **OK** to something already done — and every native message box carries an icon, which is what makes
Windows play the alert chime at it. A window closing exactly as designed sounded like a fault.

So the close asks first, and the dialog is a **third window label** ([`windows.rs`](src-tauri/src/windows.rs),
`ask_before_closing` → [`CloseConfirm.vue`](src/CloseConfirm.vue)) rather than a native box. Being this app's
own window is not decoration: it is the only way to draw the thing silently, and the only way to offer more
than one button. Three things follow from it:

- **It is a dialog, not a third face.** Off the taskbar, owned by the frame it is about, centred over it, and
  destroyed on answer — so the one-window rule the smoke tier asserts still holds. It is titled `Close
  Intentic?`, which deliberately does not start with the workspace title those assertions match on.
- **Two answers, and remembering one retires the question.** *Keep it in the tray* and *Quit Intentic*, with
  **always do this** storing the choice in `close-action.json` — outside `Settings`, which the launcher UI
  overwrites wholesale, so changing an origin there cannot put the question back. Escape, Cancel and the
  dialog's own × mean the window stays; there is no command for that, because nothing happens.
- **It answers off its own IPC callback** (`commands.rs`), because answering destroys the webview that called
  — the same WebView2 COM re-entrancy the workspace's navigation handler steps around.

## Why it runs the scripts instead of reimplementing them

The first attempt at this app (archived 2026-07-19, revived here) put the machine work in Rust: an
environment probe engine, a reconcile plan, a docker-run builder, the `/setup/claim` call, tunnel
provisioning, the sandbox lifecycle. That is ~1,400 lines whose only job is to stay bit-identical to
`connect.sh` — a lockstep that has never held anywhere in this repo (see `@intentic/sandbox-run`'s header for
the last time it broke), and the reason the experiment was shelved.

Spawning the scripts makes parity structural: the desktop path and the terminal path are the same file, and a
fix to the flow reaches desktop users without anyone porting it. The scripts themselves are bootstrap shims
now — the flow lives in the `ic` host-side CLI (`_sandbox/ic`), which each shim fetches from the release and
hands over to — so the app, the pasted one-liner and a hand-typed `ic` all run one implementation. What is
left in Rust here is the three things a script cannot do for itself — find itself, get the elevation it
needs, and say what it is doing to a window instead of a terminal
([`src-tauri/src/scripts.rs`](src-tauri/src/scripts.rs)).

| Action | What it spawns |
| --- | --- |
| A handed-over setup (runs on arrival) | `connect.sh` (through `pkexec` only when Docker is missing) / `connect.ps1` |
| Update · Rebuild | `recreate.sh <slug> [<sha256>]` / `recreate.ps1 -Slug … [-Hash …]` |
| Remove | `cleanup.sh <slug> -y` / `cleanup.ps1 -Slug … -Yes` |
| Start · Stop · Logs | `docker` directly — there is no script that lists or tails |
| The desktop-sync panel | `intentic-sync status --json` (its own install under `~/.intentic/sync/bin` first, then PATH) |

The scripts are **bundled as resources** from `_site/site/public/scripts/` (`tauri.conf.json` globs the whole
directory, so a script added to the site is bundled by construction). A release of the app is cut from one
commit, so `Intentic 1.2.0` ships `connect.sh@1.2.0`; the shims fetch the newest released `ic` at run time,
which is how flow fixes reach app users between app updates.

## Sign-in never happens in the webview

Google refuses OAuth authorization from an embedded webview, and Google Identity Services is FedCM-based,
which WebKitGTK does not implement. The archived version answered both with a Safari user-agent spoof; that is
a workaround with an expiry date nobody controls, on the one screen a new user cannot get past.

So the app never asks Google for anything. It opens the platform's own page in the **default browser** and
picks the result up over the deep link it already intercepts:

```
app      opener    →  app.intentic.dev/desktop-auth?state=<nonce>     (in the real browser)
browser  signs in  →  platform parks {one-time token, Google ID token} for ONE pickup
browser  redirect  →  intentic://auth?handoff=<id>&state=<nonce>
app      navigate  →  app.intentic.dev/desktop-auth/complete?handoff=<id>   (in the webview)
```

The last step is why nothing is injected from Rust: the webview fetches that URL itself, redeems the row, and
spends the Better Auth one-time token at `/api/auth/one-time-token/verify` — whose `Set-Cookie` lands in the
webview's own jar exactly as it would in a browser. The Google ID token is spent once at the daemon's
`system.session` for a daemon session that renews silently, so Google reappears only when that cannot renew.
Credentials never ride the deep link: a deep link is delivered as a process argument, readable by anything
else on the machine, so only the row's id travels that way.

## The link surface

Four actions, and it is the whole channel between the SPA and the app
([`src-tauri/src/setup_link.rs`](src-tauri/src/setup_link.rs), built browser-side in
[`_editor/web/src/environments/desktop.ts`](../web/src/environments/desktop.ts)):

| Link | From | What it does |
| --- | --- | --- |
| `intentic://setup?code=…` | Setup step 3 | run this setup code's sandbox here |
| `intentic://recreate?slug=…[&hash=…]` | the Update / Environment cards | update, or build the approved overlay |
| `intentic://signin` | the login screen | sign in, in the user's real browser |
| `intentic://auth?handoff=…&state=…` | the browser, after sign-in | the credential coming back |

Each one works from an external browser too, where the OS routes it to the installed app — with the one
difference the next section is about.

### A link from outside is not a link from us

`intentic://` is a public scheme. Any page can navigate to one, and what the user is shown before the OS hands
it over is *"Open Intentic?"* — a question about opening an app, not about what the link then does. So
`setup_link.rs` records which of the three directions a link arrived from, and the app believes an external one
less:

- **`platform` and `cfToken` are dropped** from an external setup link. `platform` names the server the setup
  code is redeemed against, and that server's answer decides the new sandbox's connect token, the tunnel that
  publishes it, and **which account owns it** — so a stranger's copy stands up a sandbox on this machine that
  answers to them. Nothing real is lost: the SPA sets `platform` only against a localhost platform in local
  dev, and `cfToken` was already documented as riding the in-app webview only (that was enforced on the
  sending side alone, which is no enforcement against a sender who is not us).
- **An external setup asks first**, in the OS's own dialog, naming the container, the fact that it is published
  on the internet, and the folder `syncDir` would mirror into it. Cancel is the default. It is the same shape
  as the `state` nonce on an auth handoff: a request this process cannot tie to something it started is not one
  it acts on.

**How a link gets in** depends on whether the app is already running, and the two paths share nothing but the
url. If it is, the OS starts a second copy and `tauri-plugin-single-instance` forwards that copy's argv to the
first over DBus. If it is not, the OS starts the app *with* the link in argv — which is the path a first-time
user takes (install, click **Set up on this computer**, nothing running yet) and it needs two things the warm
path does not:

- **`%u` on the installed entry's `Exec`.** A handler without a field code is launched with no arguments at all
  (desktop-entry spec), so it wins the lookup and then drops every link it wins. Tauri's bundler writes the
  `MimeType` line but no field code, so the deb and rpm entries come from
  [`src-tauri/main.desktop`](src-tauri/main.desktop) instead of its built-in template.
- **Reading the url back in `setup()`.** `tauri-plugin-deep-link` captures argv during its own plugin setup and
  emits it there — before the app's `on_open_url` listener exists — and nothing replays it. `setup()` asks for
  what it captured (`deep_link().get_current()`) rather than waiting for an event that has already been sent.

Neither is exercised by firing a link at a running app, which is why the smoke tier fires one at a stopped one
too.

## Layout

- `src/` — the app's own UI (Vue + `@intentic/ui`): the setup screen and the sandbox manager, switched on
  whether a setup is in hand. Two components and one bridge module; the archived three-persona wizard is not
  here.
- `src-tauri/src/` — the Tauri 2 shell. `windows.rs` (the one-window swap + link interception), `scripts.rs`
  (the script runner), `commands.rs` (the UI's backend), `auth.rs` (the sign-in handoff), `state.rs`,
  `setup_link.rs`.
- `scripts/stage-local-downloads.sh` — build installers from this checkout into `_site/site/public/desktop/`
  (gitignored), so the local site serves them and the web app's dev download links get your own build.

## Release & update

The release workflow computes the version, cross-builds its Windows NSIS candidate once, and executes that file
on Windows before publication. `release-prepare.sh` then runs `_tools/scripts/build-desktop.sh` for the Linux
`deb`/`rpm`/AppImage and stages the already-tested Windows candidate beside them; it does not rebuild it.
`latest.json` and the artifacts land in `dist-bin/`, and `publish-github.sh` attaches them to the **GitHub
Release**, exactly like `intentic-sync` and `intentic-host`.

Updater artifacts are minisign-signed when `TAURI_SIGNING_PRIVATE_KEY` is set in CI (generate a pair with
`pnpm --filter @intentic/desktop-app exec tauri signer generate`; the pubkey is committed in
`tauri.conf.json`). Without it the build still produces plain installers and skips `latest.json`.

## How it is tested

Eight tiers, ordered by cost. Each proves something the one before it cannot, and the split is driven by one
fact: **this app is cross-built on Linux and its Windows conventions first execute on a user's machine.**

| Tier | Runs | Proves |
| --- | --- | --- |
| `cargo test` | per PR (`desktop-check`) | the argv/env each flow assembles — for **both** hosts, since `Host` is a value rather than a `cfg!` read, so the `.ps1` named-parameter conventions are covered on a Linux runner |
| `_tools/scripts/verify-desktop-bundle.sh` | every build (called by `build-desktop.sh`) | the bundled scripts are present and byte-identical **to the ones the commit carries** (not to the working tree, which on a runner shared by six jobs can drift under a six-minute build), and the `.desktop` entry both registers `intentic://` and carries the `%u` that delivers it. Reads the deb, rpm, AppImage **and the NSIS installer** — the only automated look inside the Windows artifact |
| `_tools/scripts/verify-desktop-install.sh` | main + nightly (`desktop-verify`) | the artifacts install on a **bare** Debian, launch under Xvfb, and answer a real `xdg-open intentic://` — with the app running *and* with it closed, which are different mechanisms — see [`_tools/desktop-smoke`](../../_tools/desktop-smoke/README.md) |
| `@intentic/desktop-smoke-windows install` | desktop changes on main + every release candidate | the real NSIS installer runs on Windows; the installed app handles cold and warm OS links, renders loopback WebView content, and uninstalls while running. A release publishes the same installer bytes this tier passed |
| `_tools/scripts/verify-desktop-setup.sh` | nightly | the `connect.sh` **extracted from the installer** brings a sandbox up on a clean Docker host, hermetically (no Cloudflare, no Google, no platform) |
| `@intentic/desktop-smoke-windows setup` | nightly | the installed `connect.ps1`, Windows PowerShell 5.1 conventions, Docker Desktop's Linux-container mode, and a sandbox answering health |
| `@intentic/desktop-smoke-windows agents` | nightly when the account volume exists | the host loopback route and control-token gate, followed by one real model reply read from that conversation's transcript |
| `_tools/scripts/verify-images-public.sh` | nightly | the images those scripts pull are readable **without a credential**. The only tier that runs logged out — the setup tiers carry the runner's `ghcr.io` login, so a package published private is invisible to them and surfaces first as a user's install dying at `error from registry: unauthorized` |

Run the last two locally against your own build:

```sh
pnpm --filter @intentic/desktop-app stage:downloads
bash _tools/scripts/verify-desktop-bundle.sh _site/site/public/desktop
bash _tools/scripts/verify-desktop-install.sh _site/site/public/desktop   # needs Docker
```

**Not covered:** the setup-code claim round trip, which needs a Cloudflare pool and so belongs with the gated
nightly suites. Whether every extension view renders is the browser tier's job
([`_tools/e2e/specs/extension-views.spec.ts`](../../_tools/e2e/specs/extension-views.spec.ts)) — the workspace
screen is an unmodified webview onto the hosted SPA with no IPC, so that is a browser property, not a
desktop one.

## Developing it

```sh
pnpm --filter @intentic/desktop-app dev         # the app's own UI alone, in a browser
pnpm --filter @intentic/desktop-app tauri:dev   # the full app
INTENTIC_APP_URL=https://localhost:47145 pnpm --filter @intentic/desktop-app tauri:dev   # against a local web
INTENTIC_DISABLE_UPDATE_CHECK=1 pnpm --filter @intentic/desktop-app tauri:dev            # fully offline
```

- **Linux builds need system packages** — `webkit2gtk-4.1`, `gtk-3`, `libayatana-appindicator3`, `librsvg2`
  (dev packages), plus `patchelf` and `xdg-utils` for AppImage. In a sandbox, that is the
  `.intentic/environment.d/rust-tauri.Dockerfile` overlay.
- **Verifying the Windows target without a Windows box:** `cargo xwin check --target x86_64-pc-windows-msvc`
  (needs clang-cl / lld-link / llvm-rc).
- **`Cargo.lock` regenerates on the first build** — the archived one referenced a crate that no longer exists
  and was removed with it.
- The staging script self-handles the three AppImage quirks (FUSE, RELR stripping, builtin-loaders
  gdk-pixbuf); its header says which and why.
