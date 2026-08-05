#!/usr/bin/env bash
# Assert that the images an end user's machine pulls are readable WITHOUT a credential.
#
# This is the one check in the pipeline that runs credential-free, and it exists because everything else here
# does not: every job in ci.yml and nightly.yml opens with a `docker login ghcr.io`, so no other job can tell a
# public package from a private one. That blindness shipped — ghcr.io/intentic/sandbox was published private
# (GHCR package visibility is separate from repository visibility and defaults to private; see
# publish-images.sh), CI stayed green throughout, and every `irm https://intentic.dev/connect.ps1 | iex` died at
# `error from registry: unauthorized` on the first pull. Even nightly's desktop-setup tier, which runs the
# SHIPPED connect.sh on a clean host, hands its runner login through and so cannot catch this.
#
# It asks the registry's token endpoint rather than running `docker pull`: the docker CLI would present
# whatever login the runner's shared config holds, which is precisely the blindness being fixed. ghcr.io issues
# an anonymous pull token only for a public package, and the manifest request that follows proves the tag
# behind it actually exists — a public package with no `stable` in it fails a user's install just as hard.
set -euo pipefail

# Exactly the references the connect scripts pull unauthenticated on a user's machine — `stable` for the
# sandbox (the moving release tag), `latest` for the dind-host that the Windows self-host path stands up.
IMAGES="${IMAGES:-ghcr.io/intentic/sandbox:stable ghcr.io/intentic/dind-host:latest}"

failed=0
for ref in $IMAGES; do
    repo="${ref%:*}"
    tag="${ref##*:}"
    path="${repo#ghcr.io/}"

    # Status and body together, so a refusal is reported in the FAIL block below rather than as a stray curl
    # error line above it (the trailing %{http_code} is the last line; everything before it is the body).
    answer="$(curl -sS -w '\n%{http_code}' "https://ghcr.io/token?scope=repository:${path}:pull&service=ghcr.io" 2>/dev/null)"
    token="$(printf '%s' "${answer%$'\n'*}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
    if [ -z "$token" ]; then
        echo "FAIL ${ref}" >&2
        echo "     ghcr.io answered ${answer##*$'\n'} and issued no anonymous pull token for ${path}, so the package" >&2
        echo "     is PRIVATE and every user's installer fails at its first pull. Make it public at" >&2
        echo "     https://github.com/orgs/intentic/packages -> ${path##*/} -> Package settings -> Change visibility." >&2
        failed=1
        continue
    fi

    status="$(curl -sS -o /dev/null -w '%{http_code}' \
        -H "Authorization: Bearer ${token}" \
        -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
        "https://ghcr.io/v2/${path}/manifests/${tag}")"
    if [ "$status" != 200 ]; then
        echo "FAIL ${ref}" >&2
        echo "     the package is public, but ghcr.io answered ${status} for the ${tag} tag — nothing has been" >&2
        echo "     published under it. Check that the release pushed its images (see publish-images.sh)." >&2
        failed=1
        continue
    fi

    echo "ok   ${ref} — public, and the tag resolves."
done

exit "$failed"
