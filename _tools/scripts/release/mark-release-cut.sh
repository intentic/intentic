#!/usr/bin/env bash
# Record that semantic-release ACTUALLY cut a release, for the six steps that publish what it cut.
#
#   bash _tools/scripts/release/mark-release-cut.sh 1.223.0
#
# WHY THIS EXISTS. `publish` waits on five build jobs, and by the time it runs an hour of commits has landed on
# main. semantic-release then says
#
#   ℹ  The local branch main is behind the remote one, therefore a new version won't be published.
#
# and exits 0 having released nothing. At this repository's commit rate that is the ORDINARY outcome, not an
# error. Every step after it was written as though a release had always happened: dispatch-publish.sh asked
# GitHub to start a workflow at a tag nobody pushed, got a 422, and turned a 90-minute pipeline red with
# nothing wrong. Three of the ten most recent red runs were that exact sequence (docs/ci-failure-audit.md,
# class D), and the noise is the smaller half of the cost — a real publish failure had come to look identical
# to the routine one.
#
# THE `success` STEP IS THE SIGNAL, and the reason it is this rather than something simpler:
#
#   • semantic-release runs `success` only after a publish it actually performed, so this file exists if and
#     only if a release happened. Nothing else it prints is machine-readable.
#   • THE TAG IS NOT THE SIGNAL. `publish` checks out with `clean: false` onto a workspace six runner processes
#     share, and fetches with `fetch-depth: 0`, so `v1.223.0` can be sitting in .git from an earlier run that
#     died after tagging. A tag test would answer yes to a question nobody asked.
#   • Writing to $GITHUB_OUTPUT straight from .releaserc.json would be one line and would break the moment
#     semantic-release ran anywhere without it, at the `success` step, AFTER everything had been published.
#     That is the worst place in the lifecycle to learn a variable was unset.
#
# So: a marker in the workspace, written here, read by the step that ran semantic-release. Fatal if it cannot
# be written — a release that published and then could not say so would skip its own npm publish and its own
# attestations, which is the silent half-release this whole path exists to prevent.
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"
cd "$(repo_root)"

VERSION="${1:?usage: mark-release-cut.sh <version>}"

# The name is shared with release.yml, which deletes it before semantic-release runs and reads it after.
printf '%s\n' "$VERSION" > .release-cut
echo "  cut      $VERSION"
