# Archived experiment: the Tauri desktop app

**Status: frozen (2026-07-19).** A working Windows/Linux desktop app (Tauri 2) that replaced the
`curl | sudo sh` onboarding — environment reconciliation (Docker on Linux, WSL2 + a managed distro
on Windows), one-click local sandboxes with `connect.sh` parity, a lifecycle manager, cross-compiled
NSIS builds on the Linux release runner, and GitLab release/updater wiring. Shelved because it
over-complicated core functionality and the dev-testing cycle; kept here in case the idea returns.

This directory is intentionally **outside** the pnpm workspace and excluded from turbo, oxlint,
knip, and prettier — nothing in here builds, lints, or loads into agent context. Do not import from
it.

## Layout

- `app/` — the whole `_apps/desktop` package as it last worked: Vue launcher (wizard → setup →
  manager personas), `src-tauri/` shell (windows, tray, deep-link, updater, intercepted
  `intentic://` handoff), `src-tauri/core/` (pure-Rust probes/engines/sandbox lifecycle, 21 unit
  tests), build/staging scripts, icons, committed `Cargo.lock`.
- `web-integration/desktop.ts` — lived at `_apps/web/src/environments/desktop.ts` (desktop
  detection + deep-link builder + download links).
- `integration.patch` — every change the experiment made OUTSIDE `_apps/desktop`, diffed
  `4718974..2a9e8ca`: Setup.vue's desktop path + `local` reachability mode, the api-contract
  `{mode:"local"}` target + its api route, the site worker's `/desktop/*` downloads, the
  `desktop:check` CI job + release-job cargo cache, `.releaserc.json` assets/prepareCmd, and the
  knip/oxlint/gitignore/pnpm-catalog entries.

## To revive

1. `git mv _archive/desktop-tauri/app _apps/desktop` and
   `git mv _archive/desktop-tauri/web-integration/desktop.ts _apps/web/src/environments/desktop.ts`.
2. `git apply _archive/desktop-tauri/integration.patch` (drop this directory's hunks if any), then
   `pnpm install`.
3. Machine notes: the updater signing keypair sits at `~/.intentic-desktop-updater.key` (pubkey is
   committed in `app/src-tauri/tauri.conf.json`); CI needs it as `TAURI_SIGNING_PRIVATE_KEY` and the
   GitLab project needs publicly accessible Releases. Local Linux builds need webkit2gtk/gtk dev
   packages + `xdg-utils`; the staging script self-handles FUSE (`APPIMAGE_EXTRACT_AND_RUN`), RELR
   (`NO_STRIP`), and the builtin-loaders gdk-pixbuf quirk. Windows-target verification without a
   Windows box: `cargo xwin check/clippy --target x86_64-pc-windows-msvc` (needs clang-cl/lld-link/
   llvm-rc, e.g. the toolchain under `~/.local/llvm-msvc`).
