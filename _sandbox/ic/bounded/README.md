# intentic-bounded

Run a child process with a time limit and keep everything it printed: the one copy `ic` and the desktop app share.

- Both binaries wait on short commands (`docker inspect`, `docker run --rm`, `ic sandbox list`) that must not hang
  the flow waiting on them. Each used to carry its own copy, and a fix reached only one: ic's killed only the child it
  spawned, the desktop's killed the whole tree.
- The caller chooses what the deadline kills. `Tree` gives the child a process group of its own and kills the group
  (`taskkill /T` on Windows), for a shell or a CLI that starts helpers. `Child` kills only the child and leaves it in
  its parent's group, so a Ctrl-C at the terminal still reaches it.
- What it printed before the deadline is kept, untrimmed, beside the exit code and whether the deadline ended it.
- A member of [ic](..)'s Cargo workspace (like [docker-host](../docker-host)) and a path dependency of the desktop
  app's Tauri crate. Standard library only: `ic` is downloaded on every run of a bootstrap shim, so its size is
  something users see.

## Key files

- [src/lib.rs](src/lib.rs) — the capture, the two reaches, and the process-group and window helpers.
- [Cargo.toml](Cargo.toml) — why the crate takes no dependencies.
- [../Cargo.toml](../Cargo.toml) — the workspace that holds it, and why it is a crate of its own.
