#!/usr/bin/env bash
# Prove the public mirror still builds — on every merge request, before anything can be published.
#
# The mirror (public.sh) is a SUBSET of this workspace, and a subset breaks in ways the monorepo never notices:
# a public package growing a workspace dependency on a private one, a root devDependency the export doesn't
# carry, a lockfile that cannot reconcile against the packages that remain. None of that fails `pnpm typecheck`
# here, because here everything exists. So the export is materialised into a scratch tree and checked in the
# only place the answer is real: from a fresh install, in a tree with the private half missing.
#
# This is the whole safety argument for exporting straight from the release: main cannot reach the release job
# with an export that does not install and type-check, because this job is what let it reach main.
#   bash _tools/scripts/verify-mirror.sh [dest-dir]
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/public.sh"

dest="${1:-$(mktemp -d)}"
materialize_public "$dest"
cd "$dest"

# The seeded lockfile is the monorepo's; reconciling it here is exactly what publish-github.sh does before it
# commits, so a resolution that cannot be pruned to the subset fails on the merge request instead of mid-release.
store=()
if [ -n "${PNPM_STORE:-}" ]; then store=(--store-dir "$PNPM_STORE"); fi

pnpm install --lockfile-only --ignore-scripts
pnpm install --frozen-lockfile "${store[@]}"
pnpm typecheck
