# @intentic/desktop-smoke

The image that meets a desktop installer the way a user's machine does: a bare Debian with a virtual display
and **no GUI libraries pre-installed**. Driven by `_tools/scripts/verify-desktop-install.sh`.

```sh
pnpm --filter @intentic/desktop-app stage:downloads          # build the artifacts
bash _tools/scripts/verify-desktop-bundle.sh                 # what is INSIDE them (seconds, no Docker)
bash _tools/scripts/verify-desktop-install.sh                # that they INSTALL and RUN (needs Docker)
```

## What the bare image is for

`apt-get install ./Intentic.deb` has to resolve `libwebkit2gtk`, `libgtk-3` and the rest from the package's own
`Depends` field. The Tauri bundler generates that field, nothing else in the pipeline reads it, and the machine
that built the package necessarily already has those libraries — so an incomplete `Depends` is green all the
way to a user's first launch, where it is a linker error they cannot act on. Pre-seeding the libraries here
would hide exactly the bug this exists to catch. The AppImage is the mirror case: it vendors its libraries, so
anything it failed to vendor is missing on this host too.

One line is drawn explicitly, in `smoke.sh` and only for the AppImage tier: `linuxdeploy` applies the AppImage
project's **excludelist**, which by design does not bundle the libraries every graphical Linux install already
carries (`libfribidi`, `libharfbuzz`, `libasound`, `libEGL`, `libgbm`). An AppImage is self-contained above
that line and host-dependent below it; a host with no graphical stack at all is below it, so those five are
installed for that tier — never in the image, which has to stay bare for the deb's `Depends`.

## What one run asserts

| | |
| --- | --- |
| install | apt resolves every declared dependency on a host that has none of them |
| on disk | the executable, the `.desktop` entry, and the bundled `scripts/` the launcher spawns |
| registration | `xdg-mime query default x-scheme-handler/intentic` resolves — the AppImage's is checked *after* launch, since it has no installer and registers itself at runtime |
| launch | the process survives startup and maps its workspace window |
| deep link, app running | a real `xdg-open intentic://setup?code=…` opens the Sandbox Manager, in the instance that was already running |
| deep link, app not running | the same link **starts** the app and still opens the Sandbox Manager — fired at the deb *before its first launch*, so the package's own entry is the handler, and at the AppImage *after it has been run and quit*, since nothing installs an AppImage's entry and it registers itself at runtime |

The two deep-link rows share the link and nothing else. A running app is reached by starting a second copy whose
argv the single-instance plugin forwards over DBus; a stopped one is reached by the OS starting it *with* the
link in argv, which the app has to notice at startup. The second is the state a machine is in when someone
installs the app and clicks "set up" — and it was broken in both halves (a shipped `Exec` with no `%u`, and a
startup that never read the url back) for as long as only the first row was asserted.

When the app is found dead, the failure names the signal that killed it (`wait` yields the status, 128+n is a
signal) and prints the container's cgroup memory counters — an OOM kill and a segfault are otherwise the same
empty log.

Assertions read **window titles** through `xdotool`, not a test hook — the app has none and should not grow
one. The window appearing is the behaviour a user is promised, so it is the thing worth asserting. Two host
properties that costs: `LANG=C.UTF-8` (X transcodes window names into the client's locale, and the launcher's
title has an em dash in it), and `XDG_CURRENT_DESKTOP` (so `xdg-open` delegates the handler lookup to `gio`,
as it does on every desktop this app ships to, instead of falling back to a shell reimplementation that cannot
resolve a quoted `Exec=` — which is what the deep-link plugin writes when it registers the scheme at runtime).

## Not covered here

The Windows NSIS installer — running it needs Windows. Its *contents* are checked by
`verify-desktop-bundle.sh` (7z reads the NSIS archive), and its install belongs to the Windows runner tier.

The hosted SPA does not load here either: `INTENTIC_APP_URL` points at a stub baked into the image, which keeps
this tier hermetic. Whether the real app renders in WebKitGTK is the nightly tier's job
(`_apps/desktop/src/../../..` → `e2e:nightly`).
