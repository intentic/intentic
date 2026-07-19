# @intentic-app/desktop

The Windows/Linux desktop app — the smooth-onboarding replacement for the `curl | sudo sh` one-liner.
Install it, sign in, click **Run on this computer**: the app verifies the machine, reconciles whatever is
missing (Docker on Linux, WSL2 + a managed distro on Windows — never Docker Desktop), runs the sandbox
container + its cloudflared sidecar with full `connect.sh` parity, and opens the workspace. The remote
path (paste one command on a server) stays available unchanged inside the same window.

## What it is — and is not

The desktop app **preserves the product model**: a sandbox is still a Docker container running somewhere,
and the UI is still `@intentic-app/web` talking to the daemon directly. The app adds no third plane — it is
three thin native things around the existing product:

1. **A shell for the hosted SPA.** The workspace window loads `https://app.intentic.dev` (override:
   `INTENTIC_APP_URL` or settings). Sign-in (Better Auth cookie), the Google ID token for the daemon
   (GIS), sandbox discovery (`sandbox.list`) — all exactly the browser flow, cookies persisted by the OS
   webview. If webview sign-in ever misbehaves, the launcher's "Open in your browser" escape hatch keeps
   onboarding unblocked — a locally-run sandbox announces itself to the platform, so any browser works.
2. **An environment reconciler.** A typed probe→plan→fix loop per platform (see below) with live progress,
   replacing "install Docker yourself".
3. **A sandbox lifecycle manager.** Claims the same short-lived setup code (`POST /setup/claim`), then
   `docker run`s the sandbox + `cloudflare/cloudflared` sidecar with the exact `connect.sh` argument set
   (same names, volumes, network, env contract, health gate), and manages it after: status, logs,
   start/stop, update (pull `stable` + recreate with env replay, like `rebuild.sh`), remove (like
   `cleanup.sh`).

## The setup handoff

The SPA's `/setup` wizard stays the source of truth for naming, reachability, and code minting. The desktop
injects itself via a Tauri **initialization script** (`window.__INTENTIC_DESKTOP__`) into the workspace
window; `Setup.vue` detects it and, on the desktop, offers **Run on this computer** next to the existing
command display. The button invokes the `desktop_setup` Tauri command (allowed for the app origin through a
`remote` capability) with `{ code, mode, name, cfToken? }` — the same setup code a server would redeem. An
`intentic://setup?...` deep link covers the "clicked from an external browser" case (single-instance
forwards it to the running app).

Reachability modes map 1:1 onto the existing targets:

- **intentic-provided tunnel** (default) — claim returns `TUNNEL_TOKEN` + `SANDBOX_HOSTNAME`; run sidecar.
- **own Cloudflare** — claim returns `ZONE` + `SUBDOMAIN`; the app provisions the tunnel exactly like
  `connect.sh` (`docker run --rm --entrypoint intentic … sandbox-tunnel`), with the CF token passed through
  the IPC call (never the platform).
- **local-only** (new `SetupCodeTarget` mode `local`) — no tunnel at all: ports published on
  `127.0.0.1:8787/5173`, `SANDBOX_PUBLIC_URL=http://127.0.0.1:8787` announced to the platform, so the SPA
  drives the daemon over loopback. Auth model unchanged (Google ID token + TOFU owner bind).

After the container passes `/health`, the SPA's existing step-4 poll sees `lastSeenAt` advance and opens the
workspace — the desktop adds no discovery mechanism of its own.

## Environment reconciliation

`probe()` produces a typed report; every gap is either `fixable` (one click, native progress) or `manual`
(honest instructions, e.g. virtualization disabled in BIOS). The engine abstraction keeps every Docker
operation identical across strategies:

| Platform | Engine | Reconcile steps |
| --- | --- | --- |
| Linux | `host-docker` | install Docker (pkexec + get.docker.com / distro package manager) → start daemon (pkexec systemctl) → fix socket permission (usermod -aG docker + `sg docker` re-exec, no re-login) |
| Windows, Docker Desktop present | `host-docker` (docker.exe) | start Docker Desktop if stopped — never installed by us |
| Windows, default | `wsl` (managed distro) | enable WSL2 (`wsl --install --no-distro`, elevated, reboot-aware) → import the `intentic-machine` distro from the released rootfs (Alpine + dockerd, ~50 MB download with progress) → boot `dockerd` inside it |

All container operations go through the selected engine (`docker …` vs `wsl -d intentic-machine -u root
docker …`); named volumes keep the WSL path free of host-path translation, and WSL2's localhost forwarding
makes `127.0.0.1:8787` reachable from Windows for the local-only mode.

## Layout

- `src/` — the launcher UI (Vue + `@intentic-app/ui`): environment checklist, setup progress stream,
  sandbox manager. Served as the app's local window; the workspace window is the hosted SPA.
- `src-tauri/` — the Tauri 2 shell: windows, tray, deep-link, single-instance, updater, and the
  `desktop_*` command surface. Thin — every operation delegates to the core crate.
- `src-tauri/core/` — `intentic-desktop-core`, a pure-Rust crate (no Tauri/GTK deps): probes, reconcile
  steps, engines, claim/tunnel/sandbox lifecycle, rootfs download. Unit-testable anywhere — `cargo test
  -p intentic-desktop-core` needs no webkit, so it runs on machines without the Linux GUI toolchain.
- `scripts/release-build.sh` — CI: Linux bundles (deb/rpm/AppImage), Windows NSIS via `cargo-xwin`
  (cross-compiled on the Linux release runner, same pattern as the sync binaries), the WSL rootfs image
  (`scripts/machine-rootfs/`), and the updater `latest.json`.

## Release & update

Artifacts ride the existing semantic-release flow: `release-build.sh` runs in `prepareCmd`,
`@semantic-release/gitlab` attaches the installers, rootfs, and `latest.json` under the release's
`/desktop/*` direct-asset links. The updater endpoint is the GitLab "latest release" permalink
(`…/-/releases/permalink/latest/downloads/desktop/latest.json`) — the same convention `sync.sh` uses for
its binaries. Updater artifacts are minisign-signed when `TAURI_SIGNING_PRIVATE_KEY` is set in CI (see
`scripts/release-build.sh` header for generating the keypair); without it the build still produces plain
installers and skips `latest.json`.

Dev: `pnpm --filter @intentic-app/desktop dev` (launcher UI only) or `pnpm --filter @intentic-app/desktop
tauri:dev` (full app; point the workspace at a local web via `INTENTIC_APP_URL=https://localhost:47145`,
trusting the `_tools/localhost-https` CA system-wide). Linux builds need
`webkit2gtk-4.1`/`libappindicator3`/`librsvg` dev packages; the core crate alone does not.
