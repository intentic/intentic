# intentic-sway-ipc

sway's IPC, i3's framing over a Unix socket, for the few messages Intentic OS's desktop needs: the one copy `ic` and
the desktop app share.

- The desktop app's shell (`src-tauri/src/shell/`) follows sway's binding, window and workspace events to move its
  editor between Spaces. `ic os screen serve` (`../src/os/screen.rs`) follows window events to hold sandbox windows to
  their rules: never fullscreen, and gone when their sandbox may no longer draw. Each used to be the place for its own
  copy of the framing; now a fix reaches both.
- Run a command list, read the tree or the workspaces, subscribe to events. The caller names the socket: the app is
  started inside the session and reads `SWAYSOCK`, while `ic` may run from a service that has none and finds it
  (`../src/os/sway.rs`).
- Frames are checked before anything is allocated: a wrong magic, a length past 16 MiB or a cut-off frame is an error,
  never a large buffer.
- A member of [ic](..)'s Cargo workspace (like [bounded](../bounded)) and a path dependency of the desktop app's Tauri
  crate. Unix only; on other platforms the crate is empty.

## Key files

- [src/lib.rs](src/lib.rs) — the framing, the message and event types, and the request, command and subscribe calls.
- [Cargo.toml](Cargo.toml) — why it takes `serde_json` and nothing else.
