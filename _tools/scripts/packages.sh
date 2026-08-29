#!/usr/bin/env bash
# Single source of truth for the first-party release set. Sourced by set-versions.sh (stamps the release
# version), publish-npm.sh (publishes to npm), and publish-catchup.sh (manual catch-up). Keeping ONE list here
# is what stops the release's version-bump set and its publish set from drifting apart — that drift shipped
# @intentic/acp-bridge at its repo version 0.0.0 and 403'd the release. Package.json versions stay 0.0.0 in
# git; the real version is the git tag that semantic-release stamps onto these transiently, in CI only.

# npm-published packages, topological order (deps first) so a publish never references an unpublished dep.
# The manifest/api split reordered the middle: extension-manifest is depended on by registry-scan and
# sandbox-contract, and extension-api now depends on sandbox-contract — so the chain is
# extension-manifest → registry → sandbox-contract → extension-api, where extension-api used to come first.
# base leads the list: it depends on no workspace package, and moving the when-expressions into it made it a
# runtime dependency of extension-manifest — publishing that one without this one ships a dead specifier.
PUB=(_tools/base _tools/constants _sandbox/sandbox-run _deploy/graph _deploy/resources _deploy/engine _deploy/need-resolver _deploy/providers \
     _sandbox/extension-manifest _sandbox/registry _sandbox/sandbox-contract _sandbox/extension-api _editor/extension-ui _computers/local-agent _sandbox/sync _computers/desktop _computers/browser _computers/host _sandbox/acp-bridge _sandbox/gate _sandbox/scaffold _deploy/state-resolver _deploy/cli \
     _sandbox/workspace-ignore _search/iq-engine _search/iq-recall _search/iq _deploy/sdk _tools/registry-scan)

# Every dir that carries the release version = the published set plus the two private packages that put the
# version into an artifact rather than onto a registry: the sandbox image bakes it, and the browser extension
# derives its manifest version from it (stamp-manifest.mjs) — which the Chrome Web Store then holds it to, since
# an upload must be strictly newer than the published one. Stamped before build so artifacts see it.
VERSIONED=("${PUB[@]}" _sandbox/sandbox _computers/webext)
