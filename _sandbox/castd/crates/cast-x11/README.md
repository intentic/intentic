# cast-x11

The X11 platform for cast-core: XDamage and MIT-SHM capture, RandR resizing, XTEST input, the cursor and the clipboard, on Xvfb or a real X server.

## Key files

- [src/capture.rs](src/capture.rs) — the screen as BGRX, driven by XDamage; `X11Screen`, the screen source.
- [src/screen.rs](src/screen.rs) — RandR resizing and fitting the windows that covered the old screen.
- [src/input.rs](src/input.rs) — XTEST keys, text, buttons and scrolling, per viewer: cast-core's input sink.
- [src/keys.rs](src/keys.rs) — DOM key names to X keysyms.
- [src/desktop.rs](src/desktop.rs) — the cursor's shape and the two-way clipboard.
- [src/connect.rs](src/connect.rs) — connecting to a display, with a cookie file a daemon found (`set_authority`) rather
  than `$XAUTHORITY`.

## How it reads the screen

Three ways, picked when a capture opens, the same pixels from each (tests/capture.rs holds them to one another on an
Xvfb of its own):

- **In place**: an Xvfb started `-shmem` keeps its framebuffer in a SysV segment, which castd attaches read-only and
  reads with no copy at all. Only looked for when the display's server is an Xvfb (its lock file's pid), and trusted
  only once a strip of it matches what the server reports.
- **MIT-SHM GetImage**: any local X server, a person's own Xorg `:0` among them; each damaged band is fetched into a
  segment castd shares with the server.
- **Plain GetImage**: a server that cannot attach castd's segment (a display across the network), or `CASTD_NO_SHM`.

Pixels are 32-bit BGRX at depth 24 or 32; a server that lays them out otherwise is refused with words rather than read
wrong.

## Conventions & gotchas

- RandR modes belong to the client that made them, so `screen::Screen` keeps its connection for the process's life.
  Xvfb offers only the mode it started with, which is also its largest size: start it at the largest a viewer may ask
  for. A daemon streaming a person's own monitor opens no `Screen` (its size is theirs), and the capture follows
  whatever RandR changes they make.
- Keys are typed as the characters the viewer's own layout produced: a keysym the display's keymap lacks goes onto a
  spare keycode, remapped on the fly and noted in a file so a crash's remaps are undone on the next start.
- The cursor is hidden on the display (XFixes) and sent to viewers instead, who draw it themselves. On a person's own
  session (`desktop::spawn_with(…, false)`) it stays drawn: the server leaves it out of GetImage anyway.

The code is voxl's X11 backend (MIT, v0.4.0 at 21f194f; castd's [LICENSE](../../LICENSE)), with castd's additions
listed in [castd's README](../../README.md).
