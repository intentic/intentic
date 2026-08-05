# intentic-desktop (src-tauri)

The Rust half of the desktop app — the native window, the tray, and the permissions the webview is allowed.

## Responsibilities

- Own the window and the system tray.
- Declare which Tauri capabilities the webview may use, and nothing beyond them.
- Bridge the few things a browser cannot do to the TypeScript side.

## Key files

- [src](src) — the Rust entry point and commands.
- [tauri.conf.json](tauri.conf.json) — the app's identity, windows and bundle configuration.
- [capabilities](capabilities) — what the webview is permitted; the security surface of the desktop app.
- [Cargo.toml](Cargo.toml) — the Rust dependencies.

## How it fits

The parent package `_editor/desktop-app` is the TypeScript side — the updater, the installer flows, and the UI. This
directory is what makes it a native application rather than a website.

The interface it shows belongs to the design system; nothing here draws anything.

## Conventions & gotchas

- **`capabilities/` is a denylist by omission.** A permission not declared is not available, which is the intended
  posture — widening it is a security decision, not a build fix.
- Building this needs a Rust toolchain, which the ordinary `pnpm verify` path does not use.
