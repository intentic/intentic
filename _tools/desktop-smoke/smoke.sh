#!/usr/bin/env bash
# Does the artifact we are about to ship INSTALL, LAUNCH, and answer a deep link?
#
#   smoke.sh deb|appimage        # artifact mounted at /artifacts, runs inside the image next to this file
#
# The three things no amount of `cargo test` can tell you, in the order a user meets them:
#
#   1. INSTALL. `apt-get install ./Intentic.deb` on a host with no GUI libraries at all — so the package's own
#      Depends field has to name everything the binary links against. Tauri's bundler generates that field and
#      nothing else in the pipeline reads it; when it is wrong the build is green, the install is clean, and the
#      app dies on first launch with a linker error the user cannot act on.
#   2. LAUNCH. The process survives startup and maps its workspace window. This is where a missing library, a
#      broken resource path or a panic in `setup()` actually surfaces.
#   3. THE DEEP LINK. `intentic://` is the whole channel from the SPA into the app. The chain has four links —
#      the .desktop MIME entry, the OS handler lookup, the second instance's argv, and the single-instance
#      plugin's forward — and every one of them is invisible to a unit test. Firing a real `xdg-open` at a real
#      installed app and watching the launcher window appear exercises all four.
#
# Assertions are made against WINDOW TITLES via xdotool rather than against anything the app was modified to
# emit: there is no test hook in this app, and there should not be one — the window appearing IS the behaviour
# a user is promised.
set -euo pipefail

KIND="${1:?usage: smoke.sh deb|appimage}"
DISPLAY_NUM=99
export DISPLAY=":${DISPLAY_NUM}"
# A UTF-8 locale, because the assertions read WINDOW TITLES and one of them is "Intentic — Sandbox Manager".
# X11 window names are transcoded into the client's locale charset, so under the container's default C locale
# xdotool reads that title as "(failure in conversion from UTF8_STRING to ANSI_X3.4-1968)" — the window is
# there, correct and mapped, and every search for it misses. C.UTF-8 is built into glibc; no locales package.
export LANG=C.UTF-8
# Declare a desktop, so xdg-open routes the link through `gio` the way it does on every desktop this app ships
# to. Its no-desktop FALLBACK is a shell reimplementation that word-splits the .desktop `Exec` line and looks
# the first word up with `which` — which cannot resolve the QUOTED program path the deep-link plugin writes
# when it registers the scheme at runtime (Exec="/usr/bin/intentic-desktop" %u, quoting the desktop-entry spec
# explicitly allows). The result is xdg-open failing on a registration that is correct, in a mode no desktop
# session actually uses. The lookup itself is still exercised — gio reads the same mimeapps.list entry.
export XDG_CURRENT_DESKTOP=GNOME
# The stub SPA (baked into the image) rather than app.intentic.dev: this tier is hermetic, and the workspace
# window opening at its CONFIGURED origin is what is being asserted, not that the hosted app renders.
export INTENTIC_APP_URL="http://127.0.0.1:8099"
LOG=/tmp/intentic-app.log

# WebKitGTK inside a container, with no GPU. Its web process sandboxes itself with bubblewrap, which needs user
# namespaces a default Docker seccomp profile denies, and its renderer defaults to a DMA-BUF path Xvfb cannot
# provide — both surface as a window that opens and then renders nothing, or a web process that dies on start.
# These are properties of the TEST HOST, not of the app: a real desktop has both. Keeping them here (rather
# than loosening the container's security profile) means the smoke runs unprivileged.
export WEBKIT_DISABLE_SANDBOX=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1
# Software rendering: no GPU exists here, and libgl's default probe is slow to give up.
export LIBGL_ALWAYS_SOFTWARE=1

failures=0
pass() { echo "  ✓ $1"; }
fail() {
    echo "  ✗ $1" >&2
    failures=$((failures + 1))
}

# Poll until a predicate holds or the deadline passes. Everything here is asynchronous — an app start, a window
# map, a link delivered through a second process — so every assertion needs a deadline of its own rather than a
# fixed sleep that is either flaky or slow.
until_true() {
    local seconds="$1" description="$2"
    shift 2
    local deadline=$((SECONDS + seconds))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if "$@" >/dev/null 2>&1; then
            pass "$description"
            return 0
        fi
        sleep 0.5
    done
    fail "$description (waited ${seconds}s)"
    return 1
}

window_titled() { xdotool search --name "$1"; }

echo "==> smoke: ${KIND}"

# ── 1. install ────────────────────────────────────────────────────────────────────────────────────────────────
case "$KIND" in
    deb)
        artifact=/artifacts/Intentic.deb
        [ -f "$artifact" ] || { echo "error: $artifact not mounted" >&2; exit 1; }
        apt-get update -qq
        # Let apt resolve the package's OWN Depends — the whole point of the bare image. A missing runtime
        # library fails HERE, loudly, instead of at launch with a linker error.
        apt-get install -y -qq "$artifact" >/dev/null
        pass "installed, and apt resolved every dependency the package declares"

        # Read the package name off the archive rather than assuming the bundler's productName transform.
        PACKAGE="$(dpkg-deb -f "$artifact" Package)"
        BINARY="$(dpkg -L "$PACKAGE" | grep -E '^/usr/bin/' | head -1 || true)"
        DESKTOP_ENTRY="$(dpkg -L "$PACKAGE" | grep -E '\.desktop$' | head -1 || true)"
        SCRIPTS_DIR="$(dpkg -L "$PACKAGE" | grep -E '/scripts/connect\.sh$' | head -1 || true)"
        SCRIPTS_DIR="${SCRIPTS_DIR%/connect.sh}"
        LAUNCH=("$BINARY")
        ;;
    appimage)
        artifact=/artifacts/Intentic.AppImage
        [ -f "$artifact" ] || { echo "error: $artifact not mounted" >&2; exit 1; }
        # The excludelist baseline, and nothing above it. linuxdeploy applies the AppImage project's
        # excludelist, which deliberately does NOT bundle the libraries every graphical Linux install already
        # carries — so an AppImage is self-contained ABOVE that line and host-dependent below it. This image has
        # no graphical stack at all, so the line has to be drawn explicitly: these five are what the bundle
        # resolves against the host, and they are installed HERE rather than in the image so the deb tier keeps
        # meeting a host with no GUI libraries and has to name its own dependencies.
        apt-get update -qq
        apt-get install -y -qq --no-install-recommends \
            libfribidi0 libharfbuzz0b libasound2 libegl1 libgbm1 >/dev/null
        chmod +x "$artifact"
        # No FUSE in a container; the runtime's own self-extract is how CI runs an AppImage.
        export APPIMAGE_EXTRACT_AND_RUN=1
        pass "artifact is executable"
        BINARY="$artifact"
        # An AppImage installs nothing — its .desktop entry lives inside the image and its scheme registration
        # happens at runtime (lib.rs). Both are asserted after launch instead.
        DESKTOP_ENTRY=""
        SCRIPTS_DIR=""
        LAUNCH=("$artifact")
        ;;
    *)
        echo "error: unknown artifact kind '$KIND' (expected deb or appimage)" >&2
        exit 1
        ;;
esac

# ── 2. what the install put on disk ───────────────────────────────────────────────────────────────────────────
if [ -n "$BINARY" ] && [ -x "$BINARY" ]; then
    pass "executable at $BINARY"
else
    fail "no executable found for the installed package"
fi

if [ "$KIND" = "deb" ]; then
    if [ -n "$DESKTOP_ENTRY" ] && [ -f "$DESKTOP_ENTRY" ]; then
        pass "desktop entry at $DESKTOP_ENTRY"
    else
        fail "the package installed no .desktop entry — nothing would register the scheme"
    fi
    # The bundled scripts are the app's entire native capability; a launcher button whose script is missing
    # fails only when a user presses it.
    if [ -n "$SCRIPTS_DIR" ] && [ -f "$SCRIPTS_DIR/connect.sh" ] && [ -f "$SCRIPTS_DIR/cleanup.sh" ]; then
        pass "bundled scripts installed at $SCRIPTS_DIR"
    else
        fail "the bundled scripts are not on disk after install"
    fi
    # The OS-level half of the deep link: an entry exists, and the handler lookup resolves to it. Not guarded
    # with `|| true` — a missing update-desktop-database would otherwise be indistinguishable from a package
    # that registers nothing, which is the exact failure this line exists to tell apart.
    update-desktop-database /usr/share/applications
    handler="$(xdg-mime query default x-scheme-handler/intentic 2>/dev/null || true)"
    if [ -n "$handler" ]; then
        pass "x-scheme-handler/intentic resolves to $handler"
    else
        fail "no handler registered for x-scheme-handler/intentic — every intentic:// link would go nowhere"
    fi
fi

# ── 3. a display, a session bus, and something to load ────────────────────────────────────────────────────────
Xvfb ":${DISPLAY_NUM}" -screen 0 1600x1000x24 >/tmp/xvfb.log 2>&1 &
until_true 20 "Xvfb is up on ${DISPLAY}" xdpyinfo -display "$DISPLAY" || exit 1

eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID

python3 -m http.server 8099 --directory /srv/stub >/tmp/stub.log 2>&1 &
until_true 15 "stub workspace origin is serving" \
    python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8099').read()" || exit 1

# ── 4. launch ─────────────────────────────────────────────────────────────────────────────────────────────────
setsid "${LAUNCH[@]}" >"$LOG" 2>&1 &
APP_PID=$!

if until_true 60 "the workspace window opened" window_titled "Intentic"; then
    :
else
    echo "--- app output ---" >&2
    cat "$LOG" >&2 || true
fi

if kill -0 "$APP_PID" 2>/dev/null; then
    pass "the process survived startup (pid $APP_PID)"
else
    fail "the process exited during startup"
    echo "--- app output ---" >&2
    cat "$LOG" >&2 || true
fi

# The AppImage has no installer, so lib.rs registers the scheme itself on first run. That is the fallback the
# whole AppImage deep-link path rests on, and it is best-effort in the code — so assert it actually happened.
if [ "$KIND" = "appimage" ]; then
    if until_true 20 "the app registered x-scheme-handler/intentic at runtime" \
        bash -c '[ -n "$(xdg-mime query default x-scheme-handler/intentic 2>/dev/null)" ]'; then
        :
    fi
fi

# ── 5. the deep link, through the real OS path ────────────────────────────────────────────────────────────────
# xdg-open, not a direct argv call: this is the route a link takes from an external browser, and it exercises
# the MIME entry and the handler lookup along with the app's own forwarding.
xdg-open "intentic://setup?code=smoke-test-code&name=Smoke" >/tmp/xdg-open.log 2>&1 || true

until_true 45 "the setup link opened the Sandbox Manager" window_titled "Sandbox Manager" || {
    echo "--- xdg-open output ---" >&2
    cat /tmp/xdg-open.log >&2 || true
    echo "--- app output ---" >&2
    cat "$LOG" >&2 || true
}

# Single instance: the link must be handled by the app that was already running, not by a second copy of it.
if kill -0 "$APP_PID" 2>/dev/null; then
    pass "the original instance handled the link and is still running (pid $APP_PID)"
else
    fail "the original instance died while handling the link"
fi

kill "$APP_PID" 2>/dev/null || true

echo
if [ "$failures" -gt 0 ]; then
    echo "==> ${KIND}: $failures failed assertion(s)" >&2
    exit 1
fi
echo "==> ${KIND}: installed, launched and answered a deep link"
