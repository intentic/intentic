# @intentic-app/desktop

The Windows/Linux desktop app — the no-terminal way to run an intentic sandbox on your own computer, and the
thing that updates it afterwards. Install it, sign in, click **Run on this computer**.

```
┌─ Intentic (workspace window) ─────────┐   ┌─ Sandbox Manager (launcher) ──┐
│  app.intentic.dev — the hosted SPA    │   │  ▸ Set up on this computer    │
│  no IPC · intentic:// links only      │   │    pulling the sandbox image… │
│                                       │   │  ● work    ▶ ■  update  logs  │
└───────────────────────────────────────┘   └───────────────────────────────┘
                    │                                      │
                    └──────────── Rust shell ──────────────┘
                         windows · tray · deep link · updater
                                       │
                        sh connect.sh / recreate.sh / cleanup.sh
                        powershell connect.ps1 / recreate.ps1 / cleanup.ps1
```

## What it is — and is not

The app **preserves the product model**: a sandbox is still a Docker container, the UI is still
`@intentic-app/web` talking to the daemon directly, and the browser path keeps working on the same sandbox
from any device. The app adds no third plane. It is three thin native things around the existing product:

1. **A shell for the hosted SPA.** The workspace window loads `https://app.intentic.dev`
   (override: `INTENTIC_APP_URL`, or settings). It gets **no IPC at all** — its capability list is empty, and
   its only channel into the app is an `intentic://` navigation the window intercepts in Rust.
2. **A script runner.** Every machine operation is one of the scripts the copy-paste one-liners already run,
   spawned as a child process with its output streamed into the launcher.
3. **A lifecycle manager.** The launcher window: setup progress, then status, logs, start/stop, update,
   rebuild, remove.

## Why it runs the scripts instead of reimplementing them

The first attempt at this app (archived 2026-07-19, revived here) put the machine work in Rust: an
environment probe engine, a reconcile plan, a docker-run builder, the `/setup/claim` call, tunnel
provisioning, the sandbox lifecycle. That is ~1,400 lines whose only job is to stay bit-identical to
`connect.sh` — a lockstep that has never held anywhere in this repo (see `@intentic/sandbox-run`'s header for
the last time it broke), and the reason the experiment was shelved.

Spawning the scripts makes parity structural: the desktop path and the terminal path are the same file, and a
fix to `connect.sh` reaches desktop users on the app's next release without anyone porting it. What is left in
Rust is the three things a script cannot do for itself — find itself, get the elevation it needs, and say what
it is doing to a window instead of a terminal ([`src-tauri/src/scripts.rs`](src-tauri/src/scripts.rs)).

| Launcher action | What it spawns |
| --- | --- |
| Set up on this computer | `connect.sh` (through `pkexec` only when Docker is missing) / `connect.ps1` |
| Update · Rebuild | `recreate.sh <slug> [<sha256>]` / `recreate.ps1 -Slug … [-Hash …]` |
| Remove | `cleanup.sh <slug> -y` / `cleanup.ps1 -Slug … -Yes` |
| Start · Stop · Logs | `docker` directly — there is no script that lists or tails |

The scripts are **bundled as resources** from `_apps/site/public/scripts/` (`tauri.conf.json` globs the whole
directory, so a script added to the site is bundled by construction). A release of the app is cut from one
commit, so `Intentic 1.2.0` ships `connect.sh@1.2.0`, and the updater is what keeps them fresh.

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
[`_apps/web/src/environments/desktop.ts`](../web/src/environments/desktop.ts)):

| Link | From | What it does |
| --- | --- | --- |
| `intentic://setup?code=…` | Setup step 3 | run this setup code's sandbox here |
| `intentic://recreate?slug=…[&hash=…]` | the Update / Environment cards | update, or build the approved overlay |
| `intentic://signin` | the login screen | sign in, in the user's real browser |
| `intentic://auth?handoff=…&state=…` | the browser, after sign-in | the credential coming back |

Each one works identically from an external browser, where the OS routes it to the installed app.

## Layout

- `src/` — the launcher UI (Vue + `@intentic-app/ui`): setup progress and the sandbox manager. Two components
  and one bridge module; the archived three-persona wizard is not here.
- `src-tauri/src/` — the Tauri 2 shell. `windows.rs` (two windows + link interception), `scripts.rs` (the
  script runner), `commands.rs` (the launcher's backend), `auth.rs` (the sign-in handoff), `state.rs`,
  `setup_link.rs`.
- `scripts/stage-local-downloads.sh` — build installers from this checkout into `_apps/site/public/desktop/`
  (gitignored), so the local site serves them and the web app's dev download links get your own build.

## Release & update

`_tools/scripts/build-desktop.sh` runs in `release-prepare.sh`: Linux `deb`/`rpm`/AppImage natively, the
Windows NSIS installer via `cargo-xwin` on the same Linux runner, and `latest.json`. The artifacts land in
`dist-bin/` and `publish-agent-binaries.sh` ships them — to the **public generic Package Registry**, exactly
like `intentic-sync` and `intentic-host`, and for the same reason: this project's Releases feature is
member-only, so a release-asset download 404s for the anonymous visitor who just clicked Download on the site.

Updater artifacts are minisign-signed when `TAURI_SIGNING_PRIVATE_KEY` is set in CI (generate a pair with
`pnpm --filter @intentic-app/desktop exec tauri signer generate`; the pubkey is committed in
`tauri.conf.json`). Without it the build still produces plain installers and skips `latest.json`.

## Developing it

```sh
pnpm --filter @intentic-app/desktop dev         # the launcher UI alone, in a browser
pnpm --filter @intentic-app/desktop tauri:dev   # the full app
INTENTIC_APP_URL=https://localhost:47145 pnpm --filter @intentic-app/desktop tauri:dev   # against a local web
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
