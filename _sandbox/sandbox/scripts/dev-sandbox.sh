#!/bin/sh
# intentic dev-sandbox recreate — swap the running sandbox container over to a freshly built
# `intentic-sandbox:dev` image, WITHOUT re-running connect.sh's tunnel/auth wizard. Called by the watch loop
# (the sibling dev-sandbox.mjs) after each `pnpm build:sandbox`, and usable by hand:
#
#   sh dev-sandbox.sh            # the one sandbox on this machine
#   sh dev-sandbox.sh <slug>     # THAT sandbox, when this machine runs several
#
# The image (`pnpm build:sandbox`) is shared by every dev sandbox here; only the container swap is per-sandbox,
# which is what the slug names.
#
# A thin wrapper: the recreate itself — env replay, overlay re-base, the run command the image emits — is
# recreate.sh's dev mode (one flow with rebuild/update, which is exactly what this script used to duplicate;
# its hand-copied run block was the LAST of six to gain --cap-add=SYS_ADMIN, and being the dogfood rebuild,
# that meant two "recreate to restore isolation" rebuilds went through the one door still missing the flag).
# The only dev-specific ingredient prepared here is the compiled-tree bind mounts, because they need the
# checkout this script lives in (dev-mounts.mjs) — a served script has no checkout to read.
set -eu

SCRIPT_DIR="$(dirname "$0")"

# The checkout, found by walking up to the workspace marker. Inline rather than sourced from
# _tools/scripts/lib/repo-root.sh, because reaching that file from here would itself need the counted `../../../`
# this is removing. Everything below is then named from the root, so no path depends on how deep this script
# sits. (A sibling like dev-mounts.mjs stays $SCRIPT_DIR-relative — same directory is not a depth claim.)
ROOT="$(cd "$SCRIPT_DIR" && pwd)"
while [ "$ROOT" != "/" ] && [ ! -f "$ROOT/pnpm-workspace.yaml" ]; do ROOT="$(dirname "$ROOT")"; done

# Bind the compiled JS from the working tree over the copies baked into the image, so a later daemon edit
# needs only `tsgo` + `docker restart` (dev-reload.sh, seconds) instead of a full image rebuild (minutes).
# Skipped silently when node isn't on PATH or nothing is compiled yet — the container then runs the baked
# copies, which is exactly the old behaviour. See dev-mounts.mjs for what is mounted and why node_modules
# never is.
INTENTIC_DEV_MOUNTS=""
if command -v node >/dev/null 2>&1; then
    INTENTIC_DEV_MOUNTS="$(node "$SCRIPT_DIR/dev-mounts.mjs" 2>/dev/null || true)"
    [ -n "$INTENTIC_DEV_MOUNTS" ] &&
        echo "intentic: mounting $(printf '%s\n' "$INTENTIC_DEV_MOUNTS" | grep -c .) compiled tree(s) from the working tree — daemon edits reload with dev-reload.sh."
fi
export INTENTIC_DEV_MOUNTS

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
