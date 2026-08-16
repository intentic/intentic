#!/usr/bin/env bash
# The two things about the migration history that nothing else in this pipeline can see.
#
#   check-migrations.sh [<base ref>]        # default: origin/${GITHUB_BASE_REF:-main}
#
# WHY THIS EXISTS. A desktop sign-in returned "Internal server error" for a week because `challenge` was added
# to schema.prisma and written INTO an existing migration file — one every deployed database had already
# applied. Prisma keys _prisma_migrations by migration NAME, so an edited file never re-runs: `migrate deploy`
# said "No pending migrations to apply" over a table that was missing a column, and the API only found out by
# throwing on the INSERT. Nothing was red anywhere. Every database CI builds is created fresh from the edited
# file, so the fresh ones were correct and the deployed one was not — a divergence no test on a fresh database
# can express, because both halves of it are consistent with themselves.
#
#   1. APPLIED MIGRATIONS ARE IMMUTABLE. A migration that exists on the base ref must be byte-identical here.
#      Modified, renamed and deleted alike: renaming a directory is how the same file becomes a second
#      migration that re-runs somewhere and is skipped elsewhere. New directories are the only allowed change,
#      and are what a schema change is supposed to add.
#
#   2. THE MIGRATIONS AND THE SCHEMA AGREE. Replay the whole history into an empty database and diff the result
#      against schema.prisma. Catches the other half of the same class — a schema.prisma edited with no
#      migration written for it — which is equally invisible to a suite whose client is generated from the very
#      file being checked. Skipped, loudly, when no database is offered, so a developer can run check 1 alone.
#
# Together they hold the invariant the deployed database actually depends on: the migration list is append-only,
# and replaying it produces the schema the code is compiled against. The API image re-checks the second one
# against its OWN database at boot (see _platform/api/Dockerfile) — this is the check that keeps that one from
# ever having something to say.
#
# The clock starts at the commit that added this file. 20260802140000_desktop_handoff still carries the edit
# that caused all of the above, because reverting it would itself be a modified migration — and a check whose
# first act is to exempt something is not a check. Its column is added forward, by
# 20260815120000_desktop_handoff_challenge, which is what every database ends up agreeing on.
set -euo pipefail
. "$(dirname "$0")/repo-root.sh"

ROOT="$(repo_root)"
MIGRATIONS="_platform/prisma/migrations"
BASE="${1:-origin/${GITHUB_BASE_REF:-main}}"
cd "$ROOT"

failed=0

echo "==> applied migrations are immutable (against $BASE)"
if ! git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
    echo "error: cannot resolve base ref '$BASE'. In CI, check out with fetch-depth: 0." >&2
    exit 1
fi

# The merge base, not the base tip: on a branch that is simply behind, the tip carries migrations this branch
# has never seen, and every one of them would read as "deleted here".
MERGE_BASE="$(git merge-base "$BASE" HEAD)"

# Keyed by migration NAME (the directory), never by repo path — the directory name is what Prisma records and
# compares, so a tree-wide move that keeps the names is not the failure this check is for, and one that changes
# them is.
name_of() { basename "$(dirname "$1")"; }

while IFS= read -r path; do
    [ -n "$path" ] || continue
    name="$(name_of "$path")"
    here="$MIGRATIONS/$name/migration.sql"
    if [ ! -f "$here" ]; then
        echo "  ✗ $name — deleted or renamed. Every database that already applied it keeps it forever; the row" >&2
        echo "      in _prisma_migrations is what makes it un-re-runnable, and the name is the whole key." >&2
        failed=1
        continue
    fi
    if ! git show "$MERGE_BASE:$path" | diff -q - "$here" >/dev/null 2>&1; then
        echo "  ✗ $name — modified after it was applied. Deployed databases will NEVER re-run it, so this edit" >&2
        echo "      reaches fresh databases only, and the two silently diverge. Write a new migration instead:" >&2
        echo "      pnpm migrate:dev --name <what-it-does>" >&2
        git show "$MERGE_BASE:$path" | diff -u - "$here" | sed 's/^/      /' >&2 || true
        failed=1
    fi
done < <(git ls-tree -r --name-only "$MERGE_BASE" -- "$MIGRATIONS" | grep '/migration\.sql$' || true)

[ "$failed" -eq 0 ] && echo "  ✓ every migration on $BASE is unchanged here"

echo "==> the migration history replays into schema.prisma"
SHADOW="${MIGRATION_CHECK_DATABASE_URL:-${DATABASE_URL:-}}"
if [ -z "$SHADOW" ]; then
    echo "  ↓ skipped — set MIGRATION_CHECK_DATABASE_URL to an EMPTY, DISPOSABLE postgres to run it."
    echo "    Locally: pnpm db:up, then MIGRATION_CHECK_DATABASE_URL=postgresql://app:app@localhost:5440/app"
else
    # Replayed into the database rather than diffed straight from the directory: `migrate diff
    # --from-migrations` wants a shadow database of its own, so this would need one either way — and doing it
    # by deploy means the history is also proven to APPLY, in order, from empty. Both halves of the boot the
    # API image performs.
    (cd _platform/prisma && DATABASE_URL="$SHADOW" pnpm exec prisma migrate deploy >/dev/null)
    # --exit-code: 0 empty, 2 a difference, 1 the tool itself failing — which must not read as "no drift".
    set +e
    (cd _platform/prisma && DATABASE_URL="$SHADOW" pnpm exec prisma migrate diff \
        --from-config-datasource --to-schema ./schema.prisma --exit-code)
    diff_status=$?
    set -e
    case "$diff_status" in
        0) echo "  ✓ replaying every migration produces exactly schema.prisma" ;;
        2)
            echo "  ✗ schema.prisma and the migrations describe different databases. The listing above reads" >&2
            echo "      FROM the replayed migrations TO schema.prisma — so '[+] Added column' means the column" >&2
            echo "      is in the schema and no migration creates it. Write that migration." >&2
            failed=1
            ;;
        *)
            echo "  ✗ the drift check itself failed (exit $diff_status) — the database above must be empty and reachable." >&2
            failed=1
            ;;
    esac
fi

exit "$failed"
