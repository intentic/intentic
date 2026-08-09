#!/usr/bin/env bash
# The monorepo root, FOUND rather than counted — the shell half of @intentic/constants/node's repoRoot().
#
# Every script in this directory used to spell its own way home: `cd "$(dirname "$0")/../.."`, `ROOT="$(cd
# "$(dirname "$0")/../.." && pwd)"`, sometimes four levels for the ones that ship elsewhere. The count is right
# only for the script's current location, and nothing checks it — move a script one directory and it silently
# cd's somewhere else, which in a release script means publishing from the wrong tree.
#
# Walking up until pnpm-workspace.yaml appears has no such coupling. Source this and call `repo_root`:
#
#   . "$(dirname "$0")/repo-root.sh"      # the one relative path left, and it never changes: a sibling file
#   cd "$(repo_root)"
#
# Sourcing still needs `dirname "$0"`, which is fine: a sibling in the SAME directory is not a depth claim, and
# it stays correct however deep this directory is moved.

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
