#!/usr/bin/env bash
# Put a released editor into its edge copy (the Worker `intentic-app-edge`, worker.ts): the files of the web image
# `ghcr.io/intentic/web:<version>`, with index.html and assets/js/env.js taken from the live origin instead, since the
# container rewrites both at start (../entrypoint.sh) and the image's are placeholders. Run by ship-web.sh once the
# platform stack is rolled onto that version and seen serving it, so the copy is always the build the origin serves.
#
# Usage: deploy-edge.sh <version>             the release's web image (docker)
#        deploy-edge.sh --dist <dir> [label]  a directory holding a build instead: `_editor/web/dist`, or a mirror of
#                                             the live site. Its /assets/ must be the build the origin serves (checked).
#
# Inert without CLOUDFLARE_API_TOKEN, as deploy-platform.sh is without its stack: the copy stays what it was.
# CLOUDFLARE_ACCOUNT_ID is optional (wrangler.jsonc names the account). EDGE_ORIGIN is where the live files are read
# (default https://app.intentic.dev), EDGE_CHECK_URL where the new copy is read back (default the workers.dev address).
# EDGE_DRY_RUN=1 builds the copy and checks it with `wrangler deploy --dry-run`, uploads nothing, needs no token, and
# leaves the directory it built for reading.
set -euo pipefail
DRY_RUN="${EDGE_DRY_RUN:-0}"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ "$DRY_RUN" != 1 ]; then
    echo "No CLOUDFLARE_API_TOKEN — skipping the editor's edge copy (it stays on whatever release it last had)."
    exit 0
fi

# A workflow passes a secret it does not have as an empty string; wrangler.jsonc names the account then.
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || unset CLOUDFLARE_ACCOUNT_ID

DIST=""
if [ "${1:-}" = "--dist" ]; then
    DIST="${2:?usage: deploy-edge.sh --dist <dir> [label]}"
    VERSION="${3:-dist}"
else
    VERSION="${1:?usage: deploy-edge.sh <version> | deploy-edge.sh --dist <dir> [label]}"
    VERSION="${VERSION#v}"
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$DIR"
until [ -f "$ROOT/pnpm-workspace.yaml" ]; do
    [ "$ROOT" != / ] || { echo >&2 "error: no pnpm-workspace.yaml above $DIR"; exit 1; }
    ROOT="$(dirname "$ROOT")"
done
ORIGIN="${EDGE_ORIGIN:-https://app.intentic.dev}"
CHECK_URL="${EDGE_CHECK_URL:-https://intentic-app-edge.radarsu.workers.dev}"
REGISTRIES="${REGISTRIES:-ghcr.io/intentic}"
IMAGE="${REGISTRIES%% *}/web:$VERSION"

WORK="$(mktemp -d)"
CONTAINER=""
cleanup() {
    [ -z "$CONTAINER" ] || docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    [ "$DRY_RUN" = 1 ] || rm -rf "$WORK"
}
trap cleanup EXIT
ASSETS="$WORK/assets"
mkdir -p "$ASSETS"

# 1. The release's files. EXPECTED is the build the image says it is (WEB_BUILD, served back as X-Web-Build): the live
# files below must come from a container of that same build.
EXPECTED=""
if [ -n "$DIST" ]; then
    [ -f "$DIST/index.html" ] || { echo >&2 "error: $DIST has no index.html — not an editor build"; exit 1; }
    echo "==> the editor's edge copy from $DIST ($VERSION)"
    cp -R "$DIST/." "$ASSETS/"
else
    echo "==> the editor's edge copy from $IMAGE"
    docker pull -q "$IMAGE" >/dev/null
    EXPECTED="$(docker image inspect "$IMAGE" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^WEB_BUILD=//p' | head -1)"
    if [ -z "$EXPECTED" ] || [ "$EXPECTED" = "unreleased" ]; then
        echo >&2 "error: $IMAGE carries no WEB_BUILD, so the live files cannot be matched to it (docker-release.sh bakes it)."
        exit 1
    fi
    CONTAINER="$(docker create "$IMAGE")"
    docker cp "$CONTAINER:/usr/share/nginx/html/." "$ASSETS/" >/dev/null
fi
# The image's precompressed twins (its Dockerfile writes a .br and a .gz beside each text file for nginx): Cloudflare
# compresses what the Worker sends, so they would only be thousands of files uploaded for nothing.
find "$ASSETS" -type f \( -name '*.br' -o -name '*.gz' \) -print0 | while IFS= read -r -d '' twin; do
    [ ! -f "${twin%.*}" ] || rm -f "$twin"
done

# 2. What the container rewrote at start, read off the live origin. Refused when an answer is the edge copy itself
# (once the route is attached, a dead origin is answered by it) or a container of another build.
live() {
    local path="$1" out="$2" headers="$WORK/headers"
    curl -fsS --max-time 20 -H 'accept: text/html,*/*' -D "$headers" -o "$out" "$ORIGIN$path"
    local served_by build
    served_by="$(tr -d '\r' < "$headers" | awk 'tolower($1) == "x-intentic-served-by:" { print $2 }' | tail -1)"
    build="$(tr -d '\r' < "$headers" | awk 'tolower($1) == "x-web-build:" { print $2 }' | tail -1)"
    if [ -n "$served_by" ]; then
        echo >&2 "error: $ORIGIN$path was answered by $served_by, not the origin; the copy is taken only from a live container."
        exit 1
    fi
    if [ -n "$EXPECTED" ] && [ "$build" != "$EXPECTED" ]; then
        echo >&2 "error: $ORIGIN$path is build ${build:-(none)}, not $EXPECTED from $IMAGE; the copy would mix two builds."
        exit 1
    fi
    LIVE_BUILD="$build"
}
LIVE_BUILD=""
live / "$ASSETS/index.html"
cp "$WORK/headers" "$WORK/shell.headers"
mkdir -p "$ASSETS/assets/js"
live /assets/js/env.js "$ASSETS/assets/js/env.js"
# The Android app's Digital Asset Links, written at start from ANDROID_APP_FINGERPRINTS: a 404 there means none.
links="$(curl -sS --max-time 20 -o "$WORK/assetlinks.json" -w '%{http_code}' "$ORIGIN/.well-known/assetlinks.json")"
case "$links" in
    200) mkdir -p "$ASSETS/.well-known" && cp "$WORK/assetlinks.json" "$ASSETS/.well-known/assetlinks.json" ;;
    404) rm -f "$ASSETS/.well-known/assetlinks.json" ;;
    *) echo >&2 "error: $ORIGIN/.well-known/assetlinks.json answered $links"; exit 1 ;;
esac

# Every chunk the live shell names must be in the copy: a --dist build that is not the one the origin serves would
# otherwise ship a shell whose scripts all 404 at the edge.
missing="$({ grep -oE '"/assets/[^"?#]+' "$ASSETS/index.html" || true; } | cut -c2- | sort -u | while IFS= read -r path; do
    [ -f "$ASSETS$path" ] || echo "$path"
done)"
if [ -n "$missing" ]; then
    echo >&2 "error: the live shell names files the copy does not have — not the build the origin serves:"
    printf '%s\n' "$missing" | head -10 | sed 's/^/  /' >&2
    exit 1
fi

# 3. The live shell's security headers, by name, for the Worker to send with every answer from the copy (worker.ts
# SHELL_META). Read off the response rather than written down, so they cannot drift from nginx.conf; a shell missing
# one is refused, since a copy weaker than the origin is not one to fail over to.
mkdir -p "$ASSETS/__edge"
node -e '
    const [file, version, build] = process.argv.slice(1);
    const wanted = ["content-security-policy", "strict-transport-security", "x-frame-options", "referrer-policy",
        "permissions-policy", "x-content-type-options"];
    const headers = {};
    for (const line of require("node:fs").readFileSync(file, "utf8").split(/\r?\n/)) {
        const at = line.indexOf(":");
        const name = line.slice(0, at).trim().toLowerCase();
        if (at > 0 && wanted.includes(name)) headers[name] = line.slice(at + 1).trim();
    }
    const absent = wanted.filter((name) => !(name in headers));
    if (absent.length > 0) {
        console.error(`error: the live shell sent no ${absent.join(", ")}`);
        process.exit(1);
    }
    process.stdout.write(JSON.stringify({ version, build, headers }, null, 4) + "\n");
' "$WORK/shell.headers" "$VERSION" "${EXPECTED:-$LIVE_BUILD}" > "$ASSETS/__edge/shell.json"

# 4. The upload. The workspace's own wrangler where the job installed it (release.yml); the same pinned version from
# npm where it did not (rollback.yml checks out the repo and installs nothing).
WRANGLER=("$ROOT/_site/site/node_modules/.bin/wrangler")
if [ ! -x "${WRANGLER[0]}" ]; then
    pin="$(sed -n 's/^  wrangler: *//p' "$ROOT/pnpm-workspace.yaml" | head -1)"
    WRANGLER=(npx --yes "wrangler@${pin:?no wrangler pin in pnpm-workspace.yaml}")
fi
if [ "$DRY_RUN" = 1 ]; then
    (cd "$DIR" && "${WRANGLER[@]}" deploy --config "$DIR/wrangler.jsonc" --assets "$ASSETS" --dry-run --outdir "$WORK/bundle")
    echo "dry run: the copy of $VERSION (${EXPECTED:-$LIVE_BUILD}) is in $ASSETS, and nothing was uploaded"
    exit 0
fi
echo "==> uploading $(find "$ASSETS" -type f | wc -l | tr -d ' ') files (build ${EXPECTED:-$LIVE_BUILD})"
(cd "$DIR" && "${WRANGLER[@]}" deploy --config "$DIR/wrangler.jsonc" --assets "$ASSETS" --message "editor $VERSION (${EXPECTED:-$LIVE_BUILD})")

# 5. And read it back: the copy's shell must be the one just captured, through the Worker's own test hook.
want="$(sha256sum < "$ASSETS/index.html" | cut -d' ' -f1)"
deadline=$((SECONDS + 90))
until [ "$(curl -fsS --max-time 10 -H 'x-intentic-edge-fallback: force' "$CHECK_URL/" 2>/dev/null | sha256sum | cut -d' ' -f1)" = "$want" ]; do
    if [ "$SECONDS" -ge "$deadline" ]; then
        echo >&2 "error: $CHECK_URL is not serving the copy just uploaded 90s after the deploy."
        exit 1
    fi
    sleep 5
done
echo "the editor's edge copy is $VERSION (${EXPECTED:-$LIVE_BUILD}), read back from $CHECK_URL"
