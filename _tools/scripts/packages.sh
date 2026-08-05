#!/usr/bin/env bash
# Single source of truth for the first-party release set. Sourced by set-versions.sh (stamps the release
# version), publish-npm.sh (publishes to npm), and publish-catchup.sh (manual catch-up). Keeping ONE list here
# is what stops the release's version-bump set and its publish set from drifting apart — that drift shipped
# @intentic/acp-bridge at its repo version 0.0.0 and 403'd the release. Package.json versions stay 0.0.0 in
# git; the real version is the git tag that semantic-release stamps onto these transiently, in CI only.

# npm-published packages, topological order (deps first) so a publish never references an unpublished dep.
PUB=(_tools/constants _sandbox/sync _deploy/graph _deploy/resources _deploy/engine _deploy/need-resolver _deploy/providers \
     _sandbox/extension-api _sandbox/registry _sandbox/sandbox-contract _computers/desktop _computers/browser _computers/host _sandbox/acp-bridge _sandbox/scaffold _deploy/state-resolver _deploy/cli \
     _sandbox/workspace-ignore _search/iq-engine _search/iq-recall _search/iq _deploy/sdk _tools/registry-scan)

# Every dir that carries the release version = the published set plus the private sandbox image, which is not
# published to npm but bakes its version into the built image. Stamped before build so artifacts see it.
VERSIONED=("${PUB[@]}" _sandbox/sandbox)
