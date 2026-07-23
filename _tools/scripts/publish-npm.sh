#!/usr/bin/env bash
# Publish the first-party npm packages at <version>, idempotently — versions already on npm are SKIPPED.
# This makes the release safe to re-run, and safe when packages were published from a developer's
# authenticated PC (npm can't create packages from CI without a per-package trusted publisher). In that
# case CI simply skips them here and continues to images + tag + GitLab release.
#   bash _tools/scripts/publish-npm.sh 1.15.1
set -euo pipefail
VERSION="${1:?usage: publish-npm.sh <version>}"
cd "$(dirname "$0")/../.."

# Full public dependency-closure, in topological order (deps first).
PUB=(_tools/constants _apps/sync _libs/graph _libs/resources _libs/engine _libs/need-resolver _libs/providers \
     _libs/extension-api _libs/sandbox-contract _apps/acp-bridge _libs/scaffold _libs/state-resolver _apps/cli \
     _libs/workspace-ignore _libs/iq-engine _libs/iq-recall _apps/iq _libs/sdk)

# npm trusted publishing, exchanged by hand: pnpm's built-in OIDC exchange 401s with an empty body on the
# project's runner while the raw exchange endpoint accepts the same id token (HTTP 201), so swap the GitLab
# id token (NPM_ID_TOKEN) for a 15-minute registry token per package and hand it to pnpm via ~/.npmrc.
# A non-201 prints npm's actual response — typically a missing trusted publisher for that package on npmjs.org.
exchange_token() {
  local pkg="${1/\//%2f}" resp code body
  resp=$(curl -sS -w $'\n%{http_code}' -X POST -H "Authorization: Bearer $NPM_ID_TOKEN" \
    "https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/$pkg")
  code="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  if [ "$code" != "201" ]; then
    echo "  token exchange for $1 failed (HTTP $code): $body" >&2
    return 1
  fi
  printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token))'
}

for d in "${PUB[@]}"; do
  name=$(grep -m1 '"name"' "$d/package.json" | sed -E 's/.*"name"[^"]*"([^"]+)".*/\1/')
  if pnpm view "$name@$VERSION" version >/dev/null 2>&1; then
    echo "  skip     $name@$VERSION (already on npm)"
  else
    echo "  publish  $name@$VERSION"
    if [ -n "${NPM_ID_TOKEN:-}" ]; then
      echo "//registry.npmjs.org/:_authToken=$(exchange_token "$name")" > "$HOME/.npmrc"
    fi
    # NPM_ID_TOKEN must be hidden from pnpm: seeing it, pnpm ≥11.10 runs its own broken OIDC exchange and on
    # failure publishes unauthenticated (E404) instead of falling back to the ~/.npmrc token written above.
    env -u NPM_ID_TOKEN pnpm --dir "$d" publish --access public --no-git-checks
  fi
done
