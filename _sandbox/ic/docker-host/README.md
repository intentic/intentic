# docker-host

What docker's refusals mean and where Docker Desktop lives on a PC: the readings `ic` and the desktop app share, so the two binaries answer those questions the same way.

- A member of `ic`'s Cargo workspace (like [bounded](../bounded)), and a path dependency of the desktop app's
  `src-tauri`. Standard library only, since `ic` is downloaded on every run of a bootstrap shim.
- It spawns nothing. Each caller runs its own probe under its own deadline and hands the answer in, so the crate is
  pure readings that test on the Linux runner which cross-builds both binaries.
- A refusal is one of three kinds: the engine is erroring (it answers with errors, so no start fixes it), it denied
  this account (a group membership, never a longer wait), or it is down or unrecognised (start it). Before this crate
  `ic` and the desktop each classified on their own, and the desktop could not tell a broken engine from a slow one.
- Docker Desktop is found two ways: one full probe (registry, uninstall entry, the CLI on `PATH`, Start-menu shortcuts)
  for flows that ask once, and a cheap list of default install folders, Program Files, x86 and per-user, for a path that
  runs before every `docker` call. Paths found from inside WSL are translated through `/etc/wsl.conf`'s automount root
  rather than assumed to sit at `/mnt/c`.

## Key files

- [src/refusal.rs](src/refusal.rs) — the three kinds of engine refusal, read off what the docker CLI printed.
- [src/desktop_app.rs](src/desktop_app.rs) — the one Docker Desktop discovery script, the default install folders, and
  WSL path translation.
- [src/powershell.rs](src/powershell.rs) — the `-EncodedCommand` form both binaries hand a script to PowerShell in.
- [src/lib.rs](src/lib.rs) — why the crate exists, and what stays with each caller.
