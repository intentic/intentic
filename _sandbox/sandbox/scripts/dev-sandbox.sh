#!/bin/sh
# Recreate the selected dev sandbox on the shared intentic-sandbox:dev image after pnpm build:sandbox; optional argument is its slug.
# Delegate env replay, overlay rebase and container creation to recreate.sh's dev mode so production and dev share the same run shape.
# Only prepare checkout-specific compiled-tree bind mounts here via dev-mounts.mjs; served scripts have no checkout to read.
set -eu

SCRIPT_DIR="$(dirname "$0")"

# The checkout, found by walking up to the workspace marker. Inline rather than sourced from
# _tools/scripts/lib/repo-root.sh, because reaching that file from here would itself need the counted `../../../`
# this is removing. Everything below is then named from the root, so no path depends on how deep this script
# sits. (A sibling like dev-mounts.mjs stays $SCRIPT_DIR-relative — same directory is not a depth claim.)
ROOT="$(cd "$SCRIPT_DIR" && pwd)"
while [ "$ROOT" != "/" ] && [ ! -f "$ROOT/pnpm-workspace.yaml" ]; do ROOT="$(dirname "$ROOT")"; done

# Bind the compiled JS from the working tree over the copies baked into the image, so a later daemon edit
# needs only `tsc` + `docker restart` (dev-restart.sh, seconds) instead of a full image rebuild (minutes).
# Skipped silently when node isn't on PATH or nothing is compiled yet — the container then runs the baked
# copies, which is exactly the old behaviour. See dev-mounts.mjs for what is mounted and why node_modules
# never is.
INTENTIC_DEV_MOUNTS=""
if command -v node >/dev/null 2>&1; then
    INTENTIC_DEV_MOUNTS="$(node "$SCRIPT_DIR/dev-mounts.mjs" 2>/dev/null || true)"
    [ -n "$INTENTIC_DEV_MOUNTS" ] &&
        echo "intentic: mounting $(printf '%s\n' "$INTENTIC_DEV_MOUNTS" | grep -c .) compiled tree(s) from the working tree — daemon edits restart with dev-restart.sh."
fi
export INTENTIC_DEV_MOUNTS

# Tell the daemon WHERE those mounts came from. It cannot see a host path from inside the container, and knowing
# it is what lets the Sandbox page's restart button run dev-restart.sh out here (through this machine's own device
# connection) instead of printing the command for someone to paste. Delivered through the run contract's escape
# hatch, so it is replayed by every later recreate like any other allowlisted var (REPLAY_ENV in
# @intentic/sandbox-run); appended, never assigned, so a caller's own INTENTIC_SET_ENV survives.
INTENTIC_SET_ENV="${INTENTIC_SET_ENV:+$INTENTIC_SET_ENV
}SANDBOX_DEV_ROOT=$ROOT"
export INTENTIC_SET_ENV

# The dogfood loop should exercise the checkout's OWN ic (the host-side CLI recreate.sh shims to), not a
# released download — a flow change and its CLI change land in one commit and are tested together. Skipped
# when cargo isn't on PATH; the shim then downloads the released binary, which is the old behaviour.
if [ -z "${IC_BIN:-}" ] && command -v cargo >/dev/null 2>&1; then
    echo "intentic: building the checkout's ic CLI…"
    if cargo build --quiet --manifest-path "$ROOT/_sandbox/ic/Cargo.toml"; then
        IC_BIN="$ROOT/_sandbox/ic/target/debug/ic"
        export IC_BIN
    else
        echo "intentic: warning — the checkout's ic build failed; falling back to the released ic." >&2
    fi
fi

exec sh "$ROOT/_site/site/public/scripts/recreate.sh" --dev "$@"
