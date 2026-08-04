#!/usr/bin/env bash
# Single source of truth for what the PUBLIC GitHub mirror (github.com/intentic/intentic) contains. Sourced by
# publish-github.sh (the per-release export) and verify-mirror.sh (the merge-request guard) — one list, so the
# tree that gets published is byte-for-byte the tree that was proven to install and type-check.
#
# The mirror is a SNAPSHOT, not a filtered history: every release materialises the current working tree into a
# scratch dir and lands it as one commit. Nothing about a file's past is exported, so a credential committed
# and removed 200 commits ago can never surface publicly. That property is the reason this is a manifest of
# paths rather than a `git filter-repo` path set.
#
# The cut follows the dependency graph, not taste: `PUBLIC` is the workspace closure of everything we ship
# (the npm packages, the sandbox image, the desktop app, the extensions) and `PRIVATE` is everything that
# closure never reaches. Adding a workspace dependency from a public package to a private one breaks the
# export — verify-mirror.sh is what says so, on the merge request, before it can reach a release.

# Exported verbatim from the WORKING TREE (tracked files only — so the release's stamped package.json versions
# ride along, and nothing ignored ever can). Directories are exported whole; PRIVATE below prunes from inside.
PUBLIC=(
    # The machine agents + everything they are: the daemon, the CLIs, the desktop app.
    _apps/acp-bridge _apps/cli _apps/desktop _apps/host _apps/iq _apps/lsp _apps/sandbox _apps/sync
    # The install/connect scripts. Not site content that happens to live here — the desktop app BUNDLES them
    # as tauri resources (src-tauri/tauri.conf.json) and _libs/sandbox-run asserts on them in its tests, so
    # the mirror does not build or pass without this directory.
    _apps/site/public/scripts
    _extensions
    _libs
    _tools/ci-base _tools/constants _tools/dind-host _tools/examples _tools/extension-example _tools/registry _tools/scripts _tools/tsconfig
    # The iq Claude Code plugin's marketplace manifest — it points at _apps/iq/plugin, which is public, so the
    # plugin becomes installable straight from the mirror.
    .claude-plugin
    # ARCHITECTURE.md documents the WHOLE monorepo, platform included — exported anyway, because the trust
    # model it explains (why the platform cannot reach your code) is the one thing a reader of a public
    # sandbox most needs to be able to check. Its links into the private half don't resolve here; the mirror's
    # README says so rather than a rewritten copy of the doc drifting from this one.
    AGENTS.md ARCHITECTURE.md CONTRIBUTING.md LICENSE SECURITY.md docs/architecture docs/deploy-engine.md
    .dockerignore .editorconfig .gitignore .npmrc .oxlintrc.json .prettierignore .prettierrc.json
    pnpm-workspace.yaml tsconfig.libs.json turbo.json
    # Exported as a SEED, not as the answer: it still carries the private packages' importers and the root's
    # release-only devDependencies. Both callers run `pnpm install --lockfile-only` right after materialising
    # to reconcile it against the subset — which is what lets GitHub Actions use --frozen-lockfile — and
    # seeding from the full lockfile keeps every resolution that survives byte-identical.
    pnpm-lock.yaml
)

# Pruned from inside the PUBLIC entries above. The five libs are the platform's half of _libs; the two scripts
# drive the platform's own images and its Komodo rollout, and name deploy topology no reader outside needs.
PRIVATE=(
    _libs/api-contract _libs/astro-integrations _libs/capability-catalog _libs/prisma _libs/site-content
    _tools/scripts/deploy-platform.sh _tools/scripts/docker-release.sh
    # The mirror's own overlay (below) — it describes the export, it is not part of it.
    _tools/scripts/public
)

# Files the mirror has that the monorepo does not: its root package.json (no platform scripts, no
# semantic-release, repository pointing at GitHub), its README, and the GitHub Actions workflow that publishes
# to npm. Laid over the export root, so `_tools/scripts/public/.github/…` lands as `.github/…`.
# It sits under _tools/scripts/ rather than _tools/ on purpose: pnpm-workspace.yaml globs `_tools/*`, and a
# package.json one level up would make the overlay a workspace package of the monorepo it describes.
PUBLIC_OVERLAY=_tools/scripts/public

# Materialise the mirror into <dest> (created if missing, must be empty of anything you care about).
materialize_public() {
    local dest="${1:?usage: materialize_public <dest-dir>}"
    local root
    root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

    local -a files=()
    local f p keep
    # git ls-files, not `cp -r`: it yields exactly the TRACKED files, so dist/, node_modules/, .env and every
    # other ignored artefact are excluded by construction rather than by a second ignore list that can drift.
    while IFS= read -r -d '' f; do
        keep=1
        for p in "${PRIVATE[@]}"; do
            [[ "$f" == "$p" || "$f" == "$p"/* ]] && { keep=0; break; }
        done
        [ "$keep" -eq 1 ] && files+=("$f")
    done < <(cd "$root" && git ls-files -z -- "${PUBLIC[@]}")

    mkdir -p "$dest"
    (cd "$root" && printf '%s\0' "${files[@]}" | tar --null --files-from=- -cf -) | tar -xf - -C "$dest"
    cp -R "$root/$PUBLIC_OVERLAY/." "$dest/"

    echo "  export   ${#files[@]} files + overlay -> $dest"
}
