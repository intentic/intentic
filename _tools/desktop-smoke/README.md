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

## What one run asserts

| | |
| --- | --- |
| install | apt resolves every declared dependency on a host that has none of them |
| on disk | the executable, the `.desktop` entry, and the bundled `scripts/` the launcher spawns |
| registration | `xdg-mime query default x-scheme-handler/intentic` resolves — the AppImage's is checked *after* launch, since it has no installer and registers itself at runtime |
| launch | the process survives startup and maps its workspace window |
| deep link | a real `xdg-open intentic://setup?code=…` opens the Sandbox Manager, in the instance that was already running |

Assertions read **window titles** through `xdotool`, not a test hook — the app has none and should not grow
one. The window appearing is the behaviour a user is promised, so it is the thing worth asserting.

## Not covered here

The Windows NSIS installer — running it needs Windows. Its *contents* are checked by
`verify-desktop-bundle.sh` (7z reads the NSIS archive), and its install belongs to the Windows runner tier.

The hosted SPA does not load here either: `INTENTIC_APP_URL` points at a stub baked into the image, which keeps
this tier hermetic. Whether the real app renders in WebKitGTK is the nightly tier's job
(`_apps/desktop/src/../../..` → `e2e:nightly`).
