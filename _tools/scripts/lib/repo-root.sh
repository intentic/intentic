#!/usr/bin/env bash
# Source this and call repo_root to find pnpm-workspace.yaml by walking upward, rather than counting parent directories.
# Scripts share ../lib/ as their only layout dependency; a broken source path fails before any release action.
# _tools/checks/path-literals.mjs prevents depth-counted root paths from returning.

# RESOLVED AT SOURCE TIME, not at call time. `$0` is usually RELATIVE to the directory the script was invoked
# from, so a script that cd's before calling repo_root would have it resolve against the new location — which
# is precisely the class of bug this file exists to remove. Snapshotting here means the answer is fixed before
# any script body runs. `$0` is the SOURCING script under both bash and sh (sourcing does not rebind it), so
# this is that script's own directory.
_REPO_ROOT_FROM="$(cd "$(dirname "$0")" 2>/dev/null && pwd || printf '%s' "$PWD")"

repo_root() {
    _dir="$_REPO_ROOT_FROM"
    while [ "$_dir" != "/" ] && [ -n "$_dir" ]; do
        if [ -f "$_dir/pnpm-workspace.yaml" ]; then
            printf '%s\n' "$_dir"
            return 0
        fi
        _dir="$(dirname "$_dir")"
    done
    echo "repo-root.sh: no pnpm-workspace.yaml above $_REPO_ROOT_FROM — is this a complete checkout?" >&2
    return 1
}
