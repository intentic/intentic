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
#      installed app and watching the setup screen appear exercises all four.
#      Twice, because a link finds the app in one of TWO states and they share almost no mechanism. Running: the
#      OS starts a second copy, whose argv the single-instance plugin forwards over DBus to the first. NOT
#      running: the OS starts the app WITH the link in argv, and the app has to notice it at startup. The second
#      is the first-time user's path — the state a machine is in the moment someone installs and clicks — and it
#      is the one that was broken in both halves (no `%u` on the shipped Exec, no read-back at startup) while
#      the running-app assertion passed on every build.
#
# Assertions are made against WINDOW TITLES via xdotool rather than against anything the app was modified to
# emit: there is no test hook in this app, and there should not be one — the window appearing IS the behaviour
# a user is promised.
#
# The app shows ONE window and swaps two screens through it (windows.rs), so the title is what says which
# screen is up — and it is load-bearing here for a reason a count could not carry. The failure this tier exists
# to catch is a link that is WON and then dropped: the OS starts the app, the app sees no url, and it opens on
# the workspace. A window would appear either way. Only its title says whether the link arrived.
set -euo pipefail

KIND="${1:?usage: smoke.sh deb|appimage}"
DISPLAY_NUM=99
export DISPLAY=":${DISPLAY_NUM}"
# A UTF-8 locale, because the assertions read WINDOW TITLES and they carry an em dash ("Intentic — Setting up
# your sandbox").
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
# Mapped windows only — `hide()` unmaps, which is how the two screens take turns in one frame. Without
# `--onlyvisible` xdotool finds the one that stepped aside and "there is only ever one window" never fails.
mapped_windows() { xdotool search --onlyvisible --name "^Intentic"; }

# The link every tier fires. A setup link, because it is the one a first-time user meets and the only one whose
# arrival is VISIBLE without a test hook: it parks a pending setup and raises the setup screen.
LINK="intentic://setup?code=smoke-test-code&name=Smoke"
# What that screen calls itself. Matched on the distinctive half rather than the whole title, so the assertion
# survives the copy being reworded around it.
SETUP_TITLE="Setting up"

# A deep link fired at a machine where the app is NOT running — a different mechanism from the one a running
# instance gets, and the one a first-time user meets. The OS has to start the app AND hand it the url in argv;
# the app then has to read that url back at startup, from a plugin that captured it before any listener of ours
# existed. Neither half is exercised by firing a link at an app that is already up.
cold_link() {
    xdg-open "$LINK" >/tmp/xdg-open-cold.log 2>&1 || true
    until_true 60 "$1" window_titled "$SETUP_TITLE" || {
        echo "--- xdg-open output ---" >&2
        cat /tmp/xdg-open-cold.log >&2 || true
    }
}

# Leave no window behind — and ASSERT it, because this is the precondition the cold tiers rest on. Every
# assertion here reads the X tree by title: a setup screen left over from the phase before satisfies the next
# search instantly, and a cold-start tier that never actually started anything cold reports a pass. Matched on the
# binary name rather than "$BINARY", which for an AppImage is the bundle path and not what the extracted process
# is running under.
quit_app() {
    pkill -f intentic-desktop 2>/dev/null || true
    until_true 20 "the app closed" bash -c '! xdotool search --name "Intentic" >/dev/null 2>&1' || true
}

# Where a container's OOM kill is recorded: not in the app's output (there is none — the kernel does not ask),
# not in dmesg (that is the host's). Without this an OOM and a segfault are the same empty log.
memory_report() {
    if [ -r /sys/fs/cgroup/memory.events ]; then
        echo "--- container memory ---" >&2
        for stat in memory.max memory.peak memory.current memory.events; do
            if [ -r "/sys/fs/cgroup/$stat" ]; then
                sed "s/^/    ${stat}: /" "/sys/fs/cgroup/$stat" >&2
            fi
        done
    fi
    return 0
}

# The app is gone and we are the shell that started it, so its status is still ours to collect — `wait` yields
# it even after the process is reaped, and bash spells "killed by signal n" as 128+n. Which signal it was IS the
# diagnosis: a crash (SIGSEGV), the kernel reclaiming memory (SIGKILL) and a clean exit are three different
# bugs, and a bare "it died" tells a CI log's reader none of them. Runs in this shell, never a subshell — `wait`
# in one knows nothing of this shell's jobs.
app_died() {
    local status
    wait "$APP_PID"
    status=$?
    if [ "$status" -gt 128 ]; then
        fail "$1 (killed by SIG$(kill -l "$((status - 128))"))"
    else
        fail "$1 (exit status $status)"
    fi
    echo "--- app output ---" >&2
    cat "$LOG" >&2 || true
    memory_report
}

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

# ── 4. the deep link a FRESH INSTALL gets, before the app has ever run ─────────────────────────────────────────
# Deb only, and FIRST — this is the one moment the package's OWN .desktop entry is the handler. The app rewrites
# that registration on its first run (register_all in lib.rs, with an Exec of its own), so every assertion made
# after a single launch tests the app's handler and none of them test the shipped one. Which is how an entry
# that registers the scheme and then drops every link it wins can sit in a release: correct in the archive,
# correct once the app has run, dead for exactly the user who just installed it and clicked "set up".
if [ "$KIND" = "deb" ]; then
    cold_link "the setup link started the app straight onto the setup screen"
    quit_app
fi

# ── 5. launch ─────────────────────────────────────────────────────────────────────────────────────────────────
setsid "${LAUNCH[@]}" >"$LOG" 2>&1 &
APP_PID=$!

if until_true 60 "the workspace window opened" window_titled "^Intentic$"; then
    :
else
    echo "--- app output ---" >&2
    cat "$LOG" >&2 || true
fi

if kill -0 "$APP_PID" 2>/dev/null; then
    pass "the process survived startup (pid $APP_PID)"
else
    app_died "the process exited during startup"
fi

# ── 6. the registration an AppImage does for itself ───────────────────────────────────────────────────────────
# The AppImage has no installer, so lib.rs registers the scheme itself on first run. That is the fallback the
# whole AppImage deep-link path rests on, and it is best-effort in the code — so assert it actually happened.
if [ "$KIND" = "appimage" ]; then
    if until_true 20 "the app registered x-scheme-handler/intentic at runtime" \
        bash -c '[ -n "$(xdg-mime query default x-scheme-handler/intentic 2>/dev/null)" ]'; then
        :
    fi
fi

# ── 7. the deep link, into the app that is already running ────────────────────────────────────────────────────
# xdg-open, not a direct argv call: this is the route a link takes from an external browser, and it exercises
# the MIME entry and the handler lookup along with the app's own forwarding.
xdg-open "$LINK" >/tmp/xdg-open.log 2>&1 || true

until_true 45 "the setup link opened the setup screen" window_titled "$SETUP_TITLE" || {
    echo "--- xdg-open output ---" >&2
    cat /tmp/xdg-open.log >&2 || true
    echo "--- app output ---" >&2
    cat "$LOG" >&2 || true
}

# ...IN the workspace's frame, not beside it. This is the whole window model as one assertion, and the reason
# it is worth an assertion is that the failure it guards is invisible to every other one here: a setup screen
# that opens as a SECOND window still satisfies the search above, and what the user gets is an unasked-for
# window in front of the one they were reading. The count is taken after the search, so the swap has landed.
until_true 15 "the workspace stepped aside — one window, not two" \
    bash -c '[ "$(xdotool search --onlyvisible --name "^Intentic" | wc -l)" -eq 1 ]' || {
    echo "--- mapped windows ---" >&2
    mapped_windows | while read -r id; do echo "$id $(xdotool getwindowname "$id" 2>/dev/null)" >&2; done
}

# Single instance: the link must be handled by the app that was already running, not by a second copy of it.
if kill -0 "$APP_PID" 2>/dev/null; then
    pass "the original instance handled the link and is still running (pid $APP_PID)"
else
    app_died "the original instance died while handling the link"
fi

# ── 8. the deep link an AppImage gets once it has been run and quit ────────────────────────────────────────────
# The AppImage's own tier of section 4, and it has to come last: nothing installs an AppImage's .desktop entry,
# so until the app has run once and registered itself there is no handler at all and a link goes nowhere. This
# is the state a user leaves it in — downloaded, run, closed — and the next link they click has to start it
# again and still arrive.
if [ "$KIND" = "appimage" ]; then
    quit_app
    cold_link "the setup link restarted the app straight onto the setup screen"
fi

kill "$APP_PID" 2>/dev/null || true

echo
if [ "$failures" -gt 0 ]; then
    echo "==> ${KIND}: $failures failed assertion(s)" >&2
    exit 1
fi
echo "==> ${KIND}: installed, launched and answered a deep link"
