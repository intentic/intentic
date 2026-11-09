#!/usr/bin/env bash
# Put the hosted editor (app.intentic.dev) on a release: `web:<version>`, built by the release pipeline from the same
# commit as that release's sandbox image, becomes `web:latest` and `web:stable`, and the platform stack is rolled onto
# it and checked serving it (deploy-platform.sh).
#
# THE EDITOR SHIPS WITH THE RELEASE, NEVER AHEAD OF IT. A push to main used to move `web:latest` while a new sandbox
# booted `sandbox:stable`, the last release, so every sandbox created between a contract change landing and the next
# release was older than the page that opened it, and greeted its owner with "Some parts of this page may not work".
# Now a push to main publishes the editor under its commit and `main` only (ci.yml images-platform), and this script
# is the one way `latest` moves: run by the release after `stable` moved (release.yml publish), and by a rollback
# after `stable` moved back (rollback-stable.sh). A brand-new sandbox and the page it opens are then the same build.
#
# Usage: ship-web.sh <version>. Without PLATFORM_DEPLOY_STACK the tags still move and the roll is skipped, as
# deploy-platform.sh skips it; a release older than this script has no `web:<version>`, which fails here, before
# anything moved.
#
# Once the origin serves the release, its copy at the edge follows (_editor/web/edge/deploy-edge.sh): the Worker in
# front of app.intentic.dev that answers when the origin cannot. Inert without CLOUDFLARE_API_TOKEN.
set -euo pipefail
VERSION="${1:?usage: ship-web.sh <version>}"
VERSION="${VERSION#v}"
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/../lib/repo-root.sh"
REGISTRIES="${REGISTRIES:-ghcr.io/intentic}"
IMAGE="${REGISTRIES%% *}/web"

if ! docker buildx imagetools inspect "$IMAGE:$VERSION" >/dev/null 2>&1; then
    echo >&2 "error: no $IMAGE:$VERSION to ship. The release pipeline builds it (release.yml images-amd64); a release"
    echo >&2 "  from before the editor shipped with releases has none, and the hosted editor stays where it is."
    exit 1
fi

echo "==> the hosted editor goes onto ${VERSION}"
bash "$DIR/../image/promote-image-tag.sh" web "$VERSION" latest stable
DEPLOY_VERSION="$VERSION" PLATFORM_WEB_IMAGE="$IMAGE:latest" bash "$DIR/deploy-platform.sh"

# THE EDGE COPY, ONLY AFTER THE ORIGIN SERVES THE RELEASE: deploy-edge.sh reads index.html and env.js off the live
# origin and refuses them from any other build, so without the roll (no PLATFORM_DEPLOY_STACK) there is nothing of this
# release to copy, and the copy stays on the release the origin still serves. A failed copy is a warning, not a failed
# release: the editor itself has shipped, and the copy left on the release before is still an editor that opens
# sandboxes, the page-older side every sandbox handles.
if [ -z "${PLATFORM_DEPLOY_STACK:-}" ]; then
    echo "==> the origin was not rolled, so the editor's edge copy stays where it is"
elif ! REGISTRIES="$REGISTRIES" bash "$(repo_root)/_editor/web/edge/deploy-edge.sh" "$VERSION"; then
    echo "::warning title=Editor edge copy not updated::the hosted editor is on ${VERSION}, but its copy at the edge (intentic-app-edge) is still the release before. Re-run _editor/web/edge/deploy-edge.sh ${VERSION} with CLOUDFLARE_API_TOKEN set."
fi
