#!/usr/bin/env bash
# What the installed app does when intentic is down, on Linux: the half of @intentic/desktop-smoke-windows' `outage` tier
# (src/tier-outage.ts, src/outage.ts) this bare host can stage. Reached by overriding the image's entrypoint, with the
# artifact kind as its one argument (deb only: the app's behaviour is the same in both, and the install is not).
#
# Two shapes of outage, each launched in a config, data and cache directory of its own, with the Rust side's calls sent
# to a dead proxy and the platform on a `.test` name, so nothing reaches intentic:
#   1. nothing answers at the workspace's address (a refused connection; the same road through the app as a name that
#      does not resolve, WebKitGTK's load-failed);
#   2. the address answers a Cloudflare-style 530, which is what a dead host behind Cloudflare actually sends, and which
#      the app used to show and stop at.
# The face (this computer's own sandboxes) is the fallback only on a computer that hosts sandboxes, which this one never
# does (no engine), so both fall back to the offline page here, and the offline page is the thing proved.
#
# THE WITNESS IS THE ADDRESS. WebKitGTK in a release build has no debugger to ask which page the window holds, and the
# frame is titled "Intentic" whichever page it is. So the workspace's address is a stub that logs every request
# (outage_stub.py), and each scenario is proved by what only the offline page does: it keeps checking whether the
# address answers, and goes back to it the moment it does. An app that showed WebKit's error page, or the 530 page,
# and stopped there never asks again, so "loaded again once it answered" fails it; an offline page that went back to an
# address still answering 530 shows up as loads while it is held.
set -euo pipefail
. /usr/local/lib/desktop-artifacts.sh

KIND="${1:-deb}"
DISPLAY_NUM=99
export DISPLAY=":${DISPLAY_NUM}"
export LANG=C.UTF-8
# The same WebKit-in-a-container accommodations smoke.sh explains: properties of this host, not of the app.
export WEBKIT_DISABLE_SANDBOX=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export LIBGL_ALWAYS_SOFTWARE=1
export INTENTIC_DISABLE_UPDATE_CHECK=1
# The Rust side (the account check, the updater, the probe of the workspace's address) goes through reqwest, which reads
# these: anything not on loopback is sent to a port nothing listens on, so it fails at once, as it would in an outage.
export HTTPS_PROXY=http://127.0.0.1:9
export HTTP_PROXY=http://127.0.0.1:9
export NO_PROXY=127.0.0.1,localhost,::1
PLATFORM_URL="https://api.e2e.test"
STUB=/usr/local/bin/outage_stub.py
LOG=/tmp/intentic-app.log

# How long the offline page is held at an address that still answers 530: four of its five-second rounds.
HOLD_SECONDS=20

failures=0
pass() { echo "  ✓ $1"; }
fail() {
    echo "  ✗ $1" >&2
    failures=$((failures + 1))
}
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
workspace_window() { xdotool search --onlyvisible --name '^Intentic$'; }
app_log() {
    echo "--- app output ---" >&2
    tail -n 40 "$LOG" >&2 || true
}
stub_log() {
    echo "--- what the window asked the address for ---" >&2
    python3 "$STUB" tail "$1" >&2 || true
}
loads() { python3 "$STUB" loads "$1"; }
more_loads_than() { [ "$(loads "$1")" -gt "$2" ]; }
reported() { [ -n "$(python3 "$STUB" reports "$1")" ]; }

echo "==> smoke: outage (${KIND})"

# 1. install, as smoke.sh does: the package's own Depends on a bare host.
[ "$KIND" = "deb" ] || {
    echo "error: the outage tier runs the deb (got '$KIND')" >&2
    exit 1
}
artifact="$(desktop_artifact /artifacts deb)"
[ -n "$artifact" ] || {
    echo "error: no $(desktop_artifact_glob deb) in /artifacts" >&2
    exit 1
}
apt-get update -qq
apt-get install -y -qq "$artifact" >/dev/null
PACKAGE="$(dpkg-deb -f "$artifact" Package)"
DESKTOP_ENTRY="$(dpkg -L "$PACKAGE" | grep -E '\.desktop$' | head -1 || true)"
EXEC_PROGRAM="$(sed -n 's/^Exec="\{0,1\}\([^" ]*\).*/\1/p' "$DESKTOP_ENTRY" | head -1)"
BINARY="$(dpkg -L "$PACKAGE" | grep -Fx "/usr/bin/${EXEC_PROGRAM##*/}" || true)"
[ -x "$BINARY" ] || {
    echo "error: no executable for $PACKAGE" >&2
    exit 1
}
pass "installed $PACKAGE ($BINARY)"
# A Docker that answers "no" at once: this computer hosts no sandboxes, and nothing waits on an engine.
printf '#!/bin/sh\nexit 1\n' >/usr/local/bin/docker
chmod +x /usr/local/bin/docker

# 2. a display and a session bus
Xvfb ":${DISPLAY_NUM}" -screen 0 1600x1000x24 >/tmp/xvfb.log 2>&1 &
until_true 20 "Xvfb is up on ${DISPLAY}" xdpyinfo -display "$DISPLAY" || exit 1
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID

STUB_PID=""
APP_PID=""
stop_all() {
    [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
    pkill -f intentic-desktop 2>/dev/null || true
    [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null || true
    APP_PID=""
    STUB_PID=""
    until_true 20 "the app closed" bash -c '! xdotool search --name "Intentic" >/dev/null 2>&1' || true
}

# A scenario's own directories, with the files the app decides a bare launch by: the workspace face, at this
# scenario's address, on a computer that hosts no sandboxes (hermetic.ts `launchState` on Windows says why each).
fresh_home() {
    local app_url="$2" home="/tmp/outage-${1}"
    rm -rf "$home"
    export XDG_CONFIG_HOME="$home/config" XDG_DATA_HOME="$home/data" XDG_CACHE_HOME="$home/cache"
    local config="$XDG_CONFIG_HOME/dev.intentic.desktop"
    mkdir -p "$config" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
    printf '{\n  "appUrl": "%s",\n  "platformUrl": "%s"\n}\n' "$app_url" "$PLATFORM_URL" >"$config/settings.json"
    printf '"workspace"' >"$config/last-face.json"
    printf 'false' >"$config/hosts-sandboxes.json"
}

start_stub() {
    local port="$1" mode_file="$2" log="$3"
    python3 "$STUB" serve --port "$port" --mode-file "$mode_file" --log "$log" &
    STUB_PID=$!
    until_true 10 "the stub answers on $port" python3 -c "import urllib.request,sys
try: urllib.request.urlopen('http://127.0.0.1:$port/__report?probe=1')
except Exception as e: sys.exit(0 if hasattr(e, 'code') else 1)"
}

launch() {
    setsid "$BINARY" >"$LOG" 2>&1 &
    APP_PID=$!
    until_true 60 "the workspace window opened" workspace_window || app_log
}

alive() {
    if kill -0 "$APP_PID" 2>/dev/null; then
        pass "the app is still running"
    else
        fail "the app exited during the scenario"
        app_log
    fi
}

no_face_offered() {
    local log="$1"
    until_true 20 "the workspace page reported what the app told it" reported "$log" || return 0
    if python3 "$STUB" reports "$log" | grep -qx true; then
        fail "the page was told this computer's sandboxes are on offer, on a computer that hosts none"
    else
        pass "no sandbox face was offered on a computer that hosts no sandboxes"
    fi
}

# 3. nothing answers at the address
echo
echo "==> nothing answers at the workspace's address"
PORT=8201
MODE=/tmp/outage-unreachable.mode
STUB_LOG=/tmp/outage-unreachable.log
rm -f "$STUB_LOG"
echo ready >"$MODE"
fresh_home unreachable "http://127.0.0.1:${PORT}"
launch
# Past the app's own four-second probe and WebKit's refused load, so the fallback has been taken.
sleep 12
alive
start_stub "$PORT" "$MODE" "$STUB_LOG"
if until_true 40 "once the address answered, the window went back to the workspace (the offline page was up and checking)" more_loads_than "$STUB_LOG" 0; then
    no_face_offered "$STUB_LOG"
else
    stub_log "$STUB_LOG"
    app_log
fi
stop_all

# 4. the address answers 530
echo
echo "==> intentic's host down behind Cloudflare: the address answers 530"
PORT=8202
MODE=/tmp/outage-530.mode
STUB_LOG=/tmp/outage-530.log
rm -f "$STUB_LOG"
echo 530 >"$MODE"
fresh_home error-page "http://127.0.0.1:${PORT}"
start_stub "$PORT" "$MODE" "$STUB_LOG"
launch
if until_true 60 "the workspace window asked the address for its page" more_loads_than "$STUB_LOG" 0; then
    # Long enough for the app to see the status and leave the error page for the offline page.
    sleep 8
    held="$(loads "$STUB_LOG")"
    sleep "$HOLD_SECONDS"
    again="$(loads "$STUB_LOG")"
    if [ "$again" -eq "$held" ]; then
        pass "it did not load the 530 again in ${HOLD_SECONDS}s while the address still answered 530"
    else
        fail "the window loaded an address still answering 530 $((again - held)) more time(s) in ${HOLD_SECONDS}s: the offline page is bouncing back to it"
        stub_log "$STUB_LOG"
    fi
    echo "    the address was checked $(python3 "$STUB" checks "$STUB_LOG") time(s) without a load"
    echo ready >"$MODE"
    # What tells the offline page apart from an app that showed the 530 and stopped: only the first goes back.
    if until_true 45 "once the address answered, the window went back to the workspace (it had left the 530 for the offline page)" more_loads_than "$STUB_LOG" "$again"; then
        no_face_offered "$STUB_LOG"
    else
        stub_log "$STUB_LOG"
        app_log
    fi
else
    stub_log "$STUB_LOG"
    app_log
fi
alive
stop_all

echo
if [ "$failures" -gt 0 ]; then
    echo "==> outage: $failures failed assertion(s)" >&2
    exit 1
fi
echo "==> outage: the app falls back when intentic is down, and comes back when it answers"
