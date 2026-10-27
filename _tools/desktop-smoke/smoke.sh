#!/usr/bin/env bash
# Exercise deb/AppImage installation, startup and real xdg-open deep links on the bare smoke host, with artifacts under /artifacts.
# Test both running and stopped app states: single-instance forwarding and startup argv use different paths.
# Confirm external-link prompts and the setup's local CLI invocation; a window count cannot distinguish a dropped link from success.
# Keep the host bare so the deb's Depends and AppImage's bundled libraries must satisfy runtime dependencies.
set -euo pipefail
# Placed next to the artifacts by verify-desktop-install.sh — see its `docker cp`. The artifact names carry a
# version this script is never told, so it asks for one by kind instead of spelling a name it would have to
# keep in step with the builder.
. /usr/local/lib/desktop-artifacts.sh

KIND="${1:?usage: smoke.sh deb|appimage}"
DISPLAY_NUM=99
export DISPLAY=":${DISPLAY_NUM}"
# A UTF-8 locale, because the assertions read window titles, which can contain non-ASCII characters.
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
export INTENTIC_PLATFORM_URL="$INTENTIC_APP_URL"
# The background agent pre-install must not fetch a real release while this tier exercises local setup only.
export AGENT_BIN=/bin/false
# The other half of hermetic, and it stopped being optional the moment the app started ACTING on what it finds.
# What used to be one harmless GET is now a background download of the current release — around 100 MB of
# AppImage, twenty seconds into a tier that is about installing and deep-linking and cares about neither.
# Left on, this tier would spend a release's bandwidth per run, fail on any network hiccup for a reason
# unrelated to anything it asserts, and install an unrelated build over the artifact under test when the app
# quits. The Windows tier has always set it (desktop-smoke-windows/src/hermetic.ts); update.sh, beside this
# file, is where the updater is deliberately let loose against a release endpoint of its own.
export INTENTIC_DISABLE_UPDATE_CHECK=1
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
# Mapped windows only: the main window can run a setup while hidden. The app's own windows end in its name;
# the confirmation does not. Counting hidden windows would reject the background setup the app is meant to run.
APP_WINDOW='Intentic$'
mapped_windows() { xdotool search --onlyvisible --name "$APP_WINDOW"; }

# Like the Windows install tier, run only a local CLI stand-in: a confirmed setup runs in the background,
# without opening a setup screen. Its invocation proves the answer reached the setup, without redeeming a code
# or downloading the real CLI. A docker command keeps connect.sh from installing Docker on this bare host.
SETUP_MARKER=/tmp/intentic-smoke-setup-started
export IC_BIN=/tmp/intentic-smoke-ic
cat >"$IC_BIN" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" > /tmp/intentic-smoke-setup-started
exit 1
EOF
chmod +x "$IC_BIN"
printf '#!/bin/sh\nexit 0\n' >/usr/local/bin/docker
chmod +x /usr/local/bin/docker

LINK="intentic://setup?code=smoke-test-code&name=Smoke"
setup_started() { [ -f "$SETUP_MARKER" ] && grep -Fxq 'smoke-test-code' "$SETUP_MARKER"; }

# Every link goes through the external OS handler path, so the app must ask before running it.
CONFIRM_TITLE="Set up a sandbox on this device"

# Activate the actual affirmative button through the native accessibility tree, independent of focus or geometry.
activate_setup_button() {
    timeout 10 python3 - "$CONFIRM_TITLE" >/tmp/intentic-confirm.log 2>&1 <<'PY'
import sys
import pyatspi

desktop = pyatspi.Registry.getDesktop(0)

def is_setup_dialog(node):
    if node.getRole() not in (pyatspi.ROLE_DIALOG, pyatspi.ROLE_ALERT):
        return False
    # GtkMessageDialog can keep its generic accessible name ("Warning") when rfd sets its window title later.
    # The primary message label carries the setup question in either case.
    return pyatspi.findDescendant(node, lambda child: child.getRole() == pyatspi.ROLE_LABEL and sys.argv[1] in child.name) is not None

dialog = pyatspi.findDescendant(desktop, is_setup_dialog)
if dialog is None:
    dialogs = pyatspi.findAllDescendants(desktop, lambda node: node.getRole() in (pyatspi.ROLE_DIALOG, pyatspi.ROLE_ALERT))
    print("Native dialogs:", [(node.getRoleName(), node.name) for node in dialogs], file=sys.stderr)
    sys.exit("The native setup confirmation is not in the accessibility tree yet.")
button = pyatspi.findDescendant(dialog, lambda node: node.getRole() == pyatspi.ROLE_PUSH_BUTTON and node.name == "Set up")
if button is None or not button.queryAction().doAction(0):
    sys.exit("The native Set up button could not be activated.")
PY
}

confirmation_closed() { ! window_titled "$CONFIRM_TITLE"; }
answer_confirm() {
    until_true 30 "the native Set up button was activated" activate_setup_button || {
        cat /tmp/intentic-confirm.log >&2 || true
        return 1
    }
    until_true 15 "the setup confirmation closed after accepting it" confirmation_closed
}

setup_diagnostics() {
    local transcript
    for transcript in "$HOME"/.intentic/logs/desktop-setup-*.log; do
        [ -f "$transcript" ] || continue
        echo "--- setup transcript: $transcript ---" >&2
        cat "$transcript" >&2
    done
    if [ -f "$SETUP_MARKER" ]; then
        echo "--- local CLI arguments ---" >&2
        cat "$SETUP_MARKER" >&2
    fi
}

# A deep link fired at a machine where the app is NOT running — a different mechanism from the one a running
# instance gets, and the one a first-time user meets. The OS has to start the app AND hand it the url in argv;
# the app then has to read that url back at startup, from a plugin that captured it before any listener of ours
# existed. Neither half is exercised by firing a link at an app that is already up.
cold_link() {
    rm -f "$SETUP_MARKER"
    xdg-open "$LINK" >/tmp/xdg-open-cold.log 2>&1 || true
    until_true 60 "the setup link reached the app, which asked before running it" window_titled "$CONFIRM_TITLE" || {
        echo "--- xdg-open output ---" >&2
        cat /tmp/xdg-open-cold.log >&2 || true
        return 1
    }
    answer_confirm
    until_true 120 "$1" setup_started || {
        cat /tmp/xdg-open-cold.log >&2 || true
        setup_diagnostics
        return 1
    }
}

# Leave no window behind — and ASSERT it, because this is the precondition the cold tiers rest on. Every
# window left over from the phase before can satisfy the next search instantly. Matched on the
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
    local status=0
    wait "$APP_PID" || status=$?
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

# 1. install
case "$KIND" in
    deb)
        artifact="$(desktop_artifact /artifacts deb)"
        [ -n "$artifact" ] || { echo "error: no $(desktop_artifact_glob deb) in /artifacts" >&2; exit 1; }
        apt-get update -qq
        # Let apt resolve the package's OWN Depends — the whole point of the bare image. A missing runtime
        # library fails HERE, loudly, instead of at launch with a linker error.
        apt-get install -y -qq "$artifact" >/dev/null
        pass "installed, and apt resolved every dependency the package declares"

        # Read the package name off the archive rather than assuming the bundler's productName transform.
        PACKAGE="$(dpkg-deb -f "$artifact" Package)"
        DESKTOP_ENTRY="$(dpkg -L "$PACKAGE" | grep -E '\.desktop$' | head -1 || true)"
        # The program the package's own desktop entry starts, which is what a launcher and the link handler run,
        # rather than the first file under /usr/bin: the deb installs the intentic-files sidecar (tauri externalBin)
        # there too, and the smoke launched that instead, which printed its usage and exited 2 (desktop-verify in
        # run 36693968498). Only the first word of Exec, unquoted, and only the name, looked up in the package.
        EXEC_PROGRAM=""
        if [ -n "$DESKTOP_ENTRY" ] && [ -f "$DESKTOP_ENTRY" ]; then
            EXEC_PROGRAM="$(sed -n 's/^Exec="\{0,1\}\([^" ]*\).*/\1/p' "$DESKTOP_ENTRY" | head -1)"
        fi
        BINARY="$(dpkg -L "$PACKAGE" | grep -Fx "/usr/bin/${EXEC_PROGRAM##*/}" || true)"
        SCRIPTS_DIR="$(dpkg -L "$PACKAGE" | grep -E '/scripts/connect\.sh$' | head -1 || true)"
        SCRIPTS_DIR="${SCRIPTS_DIR%/connect.sh}"
        LAUNCH=("$BINARY")
        ;;
    appimage)
        artifact="$(desktop_artifact /artifacts appimage)"
        [ -n "$artifact" ] || { echo "error: no $(desktop_artifact_glob appimage) in /artifacts" >&2; exit 1; }
        # The excludelist baseline, and nothing above it. linuxdeploy applies the AppImage project's
        # excludelist, which deliberately does NOT bundle the libraries every graphical Linux install already
        # carries — so an AppImage is self-contained ABOVE that line and host-dependent below it. This image has
        # no graphical stack at all, so the line has to be drawn explicitly: these are what the bundle resolves
        # against the host, and they are installed HERE rather than in the image so the deb tier keeps meeting a
        # host with no GUI libraries and has to name its own dependencies.
        #
        # The list is (excludelist ∩ what the binary's libraries need) minus what this image already carries,
        # and it grows when the build base does: trixie's webkit pulls libgcrypt and a gssapi stack, whose
        # libgpg-error and libcom_err are BOTH on the excludelist. Missing, the AppImage died in the loader at
        # `libgpg-error.so.0: cannot open shared object file` with a ✗ on "the workspace window opened" — a
        # correct bundle on a host that was not what an AppImage assumes (run 34049900600, desktop-verify).
        apt-get update -qq
        # curl is the setup shim's prerequisite. The deb declares it; an AppImage uses the host's copy.
        apt-get install -y -qq --no-install-recommends \
            libfribidi0 libharfbuzz0b libasound2 libegl1 libgbm1 libgpg-error0 libcom-err2 curl >/dev/null
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

# 2. what the install put on disk
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

# 3. a display, a session bus, and something to load
Xvfb ":${DISPLAY_NUM}" -screen 0 1600x1000x24 >/tmp/xvfb.log 2>&1 &
until_true 20 "Xvfb is up on ${DISPLAY}" xdpyinfo -display "$DISPLAY" || exit 1

eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID

python3 -m http.server 8099 --directory /srv/stub >/tmp/stub.log 2>&1 &
until_true 15 "stub workspace origin is serving" \
    python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8099').read()" || exit 1

# 4. the deep link a FRESH INSTALL gets, before the app has ever run
# Deb only, and FIRST — this is the one moment the package's OWN .desktop entry is the handler. The app rewrites
# that registration on its first run (register_all in lib.rs, with an Exec of its own), so every assertion made
# after a single launch tests the app's handler and none of them test the shipped one. Which is how an entry
# that registers the scheme and then drops every link it wins can sit in a release: correct in the archive,
# correct once the app has run, dead for exactly the user who just installed it and clicked "set up".
if [ "$KIND" = "deb" ]; then
    # A DOCKER THAT IS THERE AND DOES NOT ANSWER, because that is the machine this whole section is about and
    # a bare host is not it. Somebody installing Intentic and clicking "set up" overwhelmingly has Docker
    # INSTALLED AND NOT RUNNING, and `docker info` against a daemon that is not listening does not fail: it
    # sits on the socket for tens of seconds. On a host with no `docker` at all — which is what this image is
    # everywhere else, deliberately, and rightly — the same probe returns instantly, so the wait it can impose
    # was never once exercised here.
    #
    # It shipped, twice. The launcher used to ask that question before it drew anything, from a sync command
    # (which Tauri dispatches on the main thread), so the window this link builds stayed empty and untitled
    # for the length of the probe. Every assertion below passed anyway on a fast runner, where a stub-less
    # `docker info` costs nothing, and failed on a slow one — a test that reports the runner's mood rather
    # than the build's. With this, the wait is a property of the tier instead of a property of the day.
    printf '#!/bin/sh\nsleep 60\nexit 1\n' >/usr/local/bin/docker
    chmod +x /usr/local/bin/docker
    cold_link "the setup link started the app and ran only the local CLI stand-in"
    quit_app
    printf '#!/bin/sh\nexit 0\n' >/usr/local/bin/docker
fi

# 5. launch
setsid "${LAUNCH[@]}" >"$LOG" 2>&1 &
APP_PID=$!

if until_true 60 "the workspace window opened" window_titled "$APP_WINDOW"; then
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

# 6. the registration an AppImage does for itself
# The AppImage has no installer, so lib.rs registers the scheme itself on first run. That is the fallback the
# whole AppImage deep-link path rests on, and it is best-effort in the code — so assert it actually happened.
if [ "$KIND" = "appimage" ]; then
    if until_true 20 "the app registered x-scheme-handler/intentic at runtime" \
        bash -c '[ -n "$(xdg-mime query default x-scheme-handler/intentic 2>/dev/null)" ]'; then
        :
    fi
fi

# 7. the deep link, into the app that is already running
# xdg-open, not a direct argv call: this is the route a link takes from an external browser, and it exercises
# the MIME entry and the handler lookup along with the app's own forwarding.
WORKSPACE_WINDOW=$(mapped_windows | head -1 || true)
rm -f "$SETUP_MARKER"
xdg-open "$LINK" >/tmp/xdg-open.log 2>&1 || true

if until_true 45 "the setup link reached the running app, which asked before running it" window_titled "$CONFIRM_TITLE"; then
    # ONE LINK, ONE QUESTION — the row this tier did not have, and the reason a duplicate shipped. A running
    # app is reached by a second copy whose argv the single-instance plugin forwards, and tauri-plugin-deep-link
    # turns that same argv into `on_open_url`: a lib.rs that also dispatched argv itself asked twice, and a
    # user who answered both prompts redeemed one setup code twice. Every other verb hides that behind a
    # take-once park, so this dialog is the only place it is visible at all. The settle is not optional: the
    # duplicate lands a moment after the one the search above stopped at, so counting immediately finds one.
    sleep 3
    asked=$(window_titled "$CONFIRM_TITLE" | grep -c .)
    if [ "$asked" -eq 1 ]; then
        pass "the link was asked about exactly once"
    else
        fail "one setup link raised $asked confirmations — external links are being handled more than once"
    fi
    answer_confirm
    until_true 120 "answering the link ran only the local CLI stand-in" setup_started || {
        echo "--- app output ---" >&2
        cat "$LOG" >&2 || true
        setup_diagnostics
    }
else
    echo "--- xdg-open output ---" >&2
    cat /tmp/xdg-open.log >&2 || true
    echo "--- app output ---" >&2
    cat "$LOG" >&2 || true
fi

# The setup runs out of sight: the workspace stays in its original window. Check identity as well as count,
# so a setup that replaces the workspace with another face cannot pass by showing just one window.
workspace_kept() {
    local ids count
    ids=$(mapped_windows)
    count=$(printf '%s\n' "$ids" | grep -c .)
    [ "$count" -eq 1 ] || return 1
    [ -n "$WORKSPACE_WINDOW" ] && [ "$ids" = "$WORKSPACE_WINDOW" ] || return 1
    [ "$(xdotool getwindowname "$ids" 2>/dev/null)" = "Intentic" ]
}
until_true 15 "the setup ran out of sight, leaving the workspace its original window" workspace_kept || {
    echo "--- mapped windows ---" >&2
    # A vanished window is the most useful failure to diagnose. Do not let the empty search's
    # status escape through pipefail before the process-survival check below can report it.
    (mapped_windows || true) | while read -r id; do
        echo "$id $(xdotool getwindowname "$id" 2>/dev/null) $(xdotool getwindowgeometry --shell "$id" 2>/dev/null | tr '\n' ' ')" >&2
    done
}

# Single instance: the link must be handled by the app that was already running, not by a second copy of it.
if kill -0 "$APP_PID" 2>/dev/null; then
    pass "the original instance handled the link and is still running (pid $APP_PID)"
else
    app_died "the original instance died while handling the link"
fi

# 8. the deep link an AppImage gets once it has been run and quit
# The AppImage's own tier of section 4, and it has to come last: nothing installs an AppImage's .desktop entry,
# so until the app has run once and registered itself there is no handler at all and a link goes nowhere. This
# is the state a user leaves it in — downloaded, run, closed — and the next link they click has to start it
# again and still arrive.
if [ "$KIND" = "appimage" ]; then
    quit_app
    cold_link "the setup link restarted the app and ran only the local CLI stand-in"
fi

kill "$APP_PID" 2>/dev/null || true

echo
if [ "$failures" -gt 0 ]; then
    echo "==> ${KIND}: $failures failed assertion(s)" >&2
    exit 1
fi
echo "==> ${KIND}: installed, launched and answered a deep link"
