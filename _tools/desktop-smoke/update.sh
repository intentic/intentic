#!/usr/bin/env bash
# Does the app actually REPLACE ITSELF with the release that was published — and still start afterwards?
#
#   update.sh          # /artifacts holds: from.AppImage, to.AppImage, latest.json
#
# The thing no unit test can tell you, and the thing this app got wrong for its whole life so far: every
# release up to and including v1.213.0 shipped an app that checked once at startup, drew a notice reading "it
# installs the next time you quit", and then installed nothing, on any path, ever. Nothing failed. Nothing was
# red. The mechanism was simply absent, and the sentence on screen is the reason nobody went looking.
#
# So this asserts OUTCOMES, in the order they matter:
#
#   1. the bytes arrive with nobody pressing anything — the schedule fires, the manifest is fetched, the
#      minisign signature is verified against the pubkey compiled into this build, the download is staged;
#   2. the banner's button applies it — a page in the workspace webview navigating to `intentic://update`,
#      which is the whole channel from the SPA into the app and the only direction that link is honoured from;
#   3. the file the app runs from is now, byte for byte, the newer release;
#   4. it starts again — an updater that swaps the bytes and cannot boot is strictly WORSE than one that never
#      ran, because the machine is left with no working app instead of an old one;
#   5. and it now considers itself current, which is the only assertion that proves the app really MOVED
#      rather than rewriting itself with something that merely differs.
#
# WHICH CALLER THIS EXERCISES, and which it does not. `install()` has two callers: this one, and the exit
# handler that applies a staged update on quit (update.rs `install_on_exit`) — the silent path, and the one
# that makes a launch always be the newest version. They are the same call with `restart` flipped. The quit
# path is not driven here because ending a GTK app CLEANLY needs a window manager to deliver WM_DELETE_WINDOW,
# and this container deliberately has none: `xdotool windowclose` destroys the X window out from under GTK,
# which aborts the process on a BadDrawable before any exit handler runs. That is a fact about the test host,
# and faking a quit that a user never performs would prove nothing about the one they do.
#
# WHAT IS REAL AND WHAT IS THE HARNESS'S. The whole chain is real: a scheduled check, an HTTP fetch, a
# signature verification, a staged download, an in-place rewrite, a relaunch. Two things are staged, and both
# are BUILD-TIME config set by verify-desktop-update.sh rather than a runtime override: the signing KEY (a
# throwaway pair — the release key is not on this machine and must not be) and the ENDPOINT (a local server —
# the real one serves the real releases). Deliberately not an environment variable: a test hook that ships is a
# test hook something else can reach.
#
# The AppImage runs through the runtime's own self-extract (`APPIMAGE_EXTRACT_AND_RUN`), because a container
# has no FUSE. The runtime still exports `APPIMAGE`, which is what the updater plugin reads to find the bundle
# file — so the rewrite targets the .AppImage rather than the binary extracted out of it. If that ever stops
# being true, assertion 3 is where it shows up.
set -euo pipefail

DISPLAY_NUM=99
export DISPLAY=":${DISPLAY_NUM}"
export LANG=C.UTF-8
# Hermetic: the manifest, the artifact and the page in the workspace window are all served from inside this
# container, so nothing in this tier can fail on the network.
export INTENTIC_APP_URL="http://127.0.0.1:8099"
# The same three WebKit-in-a-container accommodations smoke.sh explains at length — properties of this test
# host, which has no GPU and no user namespaces, rather than of the app.
export WEBKIT_DISABLE_SANDBOX=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export LIBGL_ALWAYS_SOFTWARE=1
export APPIMAGE_EXTRACT_AND_RUN=1

# Where the installed app lives for this run, and the file assertion 3 is about.
INSTALLED=/opt/Intentic.AppImage
# The app's own staging directory, by the identifier in tauri.conf.json. Read rather than inferred from
# behaviour, because it is what tells "it never downloaded" apart from "it downloaded and did not install" —
# two different bugs that look identical from outside.
STAGING_DIR="$HOME/.cache/dev.intentic.desktop/updates"
# The page the workspace window loads. Its own directory rather than the image's /srv/stub, which the install
# tier's assertions depend on being inert.
STUB=/tmp/update-stub

failures=0
pass() { echo "  ✓ $1"; }
fail() {
    echo "  ✗ $1" >&2
    failures=$((failures + 1))
}

# Everything here is asynchronous — a scheduled check, a download, a window map, an installer replacing the
# process — so every assertion carries a deadline of its own rather than a fixed sleep that is either flaky or
# slow.
until_true() {
    local seconds="$1" description="$2"
    shift 2
    local deadline=$((SECONDS + seconds))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if "$@" >/dev/null 2>&1; then
            pass "$description"
            return 0
        fi
        sleep 1
    done
    fail "$description (waited ${seconds}s)"
    return 1
}

staged_download() { compgen -G "$STAGING_DIR/*" >/dev/null; }
workspace_window() { xdotool search --onlyvisible --name "^Intentic$"; }
hash_of() { sha256sum "$1" | cut -d' ' -f1; }
app_log() {
    echo "--- app output ---" >&2
    cat /tmp/intentic-app.log >&2 || true
}

echo "==> smoke: update"

for required in from.AppImage to.AppImage latest.json; do
    [ -f "/artifacts/$required" ] || {
        echo "error: /artifacts/$required is missing — verify-desktop-update.sh builds and stages all three" >&2
        exit 1
    }
done

# The excludelist baseline this deliberately bare image does not carry — the same five smoke.sh installs in its
# AppImage tier, for the same reason: an AppImage is self-contained above that line and host-dependent below it.
apt-get update -qq
apt-get install -y -qq --no-install-recommends libfribidi0 libharfbuzz0b libasound2 libegl1 libgbm1 >/dev/null

install -m 0755 /artifacts/from.AppImage "$INSTALLED"
BEFORE="$(hash_of "$INSTALLED")"
AFTER_EXPECTED="$(hash_of /artifacts/to.AppImage)"
[ "$BEFORE" != "$AFTER_EXPECTED" ] || {
    echo "error: the two builds are byte-identical — this tier would pass without updating anything" >&2
    exit 1
}

# THE BANNER, REDUCED TO WHAT IT DOES. The real one is a card in the notification lane that appears when the app
# tells the page an update is downloaded and navigates to `intentic://update` when pressed
# (web/src/composables/notificationSources.ts, drawn by web/src/shell/NotificationHost.vue).
# Standing the hosted SPA up in here would test Vue; what needs testing is that a NAVIGATION from this window
# is honoured while the same link from the OS handler is not. So the page waits for `press` to appear beside it
# — same origin, so no CORS — and then navigates, which is the button reduced to its one effect.
mkdir -p "$STUB"
cat >"$STUB/index.html" <<'PAGE'
<!doctype html><title>stub workspace</title><h1>stub</h1>
<script>
(async function waitForPress() {
    try {
        if ((await fetch(`press`, { cache: `no-store` })).ok) {
            location.href = `intentic://update`;
            return;
        }
    } catch (ignored) {}
    setTimeout(waitForPress, 500);
})();
</script>
PAGE

python3 -m http.server 8098 --directory /artifacts >/tmp/releases.log 2>&1 &
python3 -m http.server 8099 --directory "$STUB" >/tmp/stub.log 2>&1 &
until_true 15 "the release endpoint is serving" \
    python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8098/latest.json').read()" || exit 1

Xvfb ":${DISPLAY_NUM}" -screen 0 1600x1000x24 >/tmp/xvfb.log 2>&1 &
until_true 20 "Xvfb is up on ${DISPLAY}" xdpyinfo -display "$DISPLAY" || exit 1
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID

# ── 1. it downloads without being asked ───────────────────────────────────────────────────────────────────────
setsid "$INSTALLED" >/tmp/intentic-app.log 2>&1 &
until_true 60 "the app started" workspace_window || app_log

# The first check is deliberately delayed so it never competes with a window painting or an install starting
# (update.rs FIRST_CHECK_AFTER); the download itself is a copy across loopback.
if ! until_true 120 "the update downloaded on its own, and its signature verified" staged_download; then
    app_log
    echo "--- what the release endpoint was asked for ---" >&2
    cat /tmp/releases.log >&2 || true
fi

# ── 2. the banner's button applies it ─────────────────────────────────────────────────────────────────────────
# Harmless to leave in place afterwards: a page that navigates here again meets an app that is already current,
# and `intentic://update` does nothing in any state but `ready` (update.rs `act`).
: >"$STUB/press"

# ── 3. the file it runs from IS the newer release ─────────────────────────────────────────────────────────────
if ! until_true 120 "the update installed over the running app" \
    bash -c "[ \"\$(sha256sum $INSTALLED | cut -d' ' -f1)\" = \"$AFTER_EXPECTED\" ]"; then
    AFTER="$(hash_of "$INSTALLED")"
    if [ "$AFTER" = "$BEFORE" ]; then
        fail "the AppImage on disk is still the old build — nothing was installed"
    else
        fail "the AppImage changed into something that is neither build (${AFTER:0:12})"
    fi
    app_log
fi

# ── 4. and it still starts ────────────────────────────────────────────────────────────────────────────────────
# The half that makes an update worth having at all. A swap that boots into nothing trades a machine that was
# merely out of date for one with no working app — the outcome `intentic-machine upgrade` rolls back for, and the
# reason this is asserted rather than assumed. Installing relaunches the app itself (update.rs), so this waits
# for the window to come back rather than starting anything.
until_true 90 "the updated app is running" workspace_window || app_log

# ── 5. …and knows it is current ───────────────────────────────────────────────────────────────────────────────
# The assertion that closes the loophole in 3: identical bytes would satisfy a hash check too. This one passes
# only if the running app's own version now outranks the manifest, so it declines the update it just took
# instead of taking it again forever.
rm -rf "${STAGING_DIR:?}"
sleep 90
if staged_download; then
    fail "the updated app downloaded the same release again — it does not believe it moved"
else
    pass "the updated app reports itself current against the same manifest"
fi

pkill -f intentic-desktop 2>/dev/null || true

echo
if [ "$failures" -eq 0 ]; then
    echo "==> update smoke passed"
else
    echo "==> update smoke FAILED ($failures)" >&2
fi
exit "$failures"
