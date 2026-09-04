#!/usr/bin/env bash
# The three things about the migration history that nothing else in this pipeline can see.
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
#   2. A NEW MIGRATION CAN RUN ON A DATABASE THAT HAS ROWS. `ADD COLUMN … NOT NULL` with no `DEFAULT` is the
#      one statement Postgres refuses on any table that is not empty — the existing rows would need a value it
#      never supplies — so a migration carrying it is not "risky on production", it is a migration that can
#      only ever apply where there is nothing to lose. Which is precisely the database check 3 builds, and
#      every database a developer resets. THIS IS NOT HYPOTHETICAL EITHER: 20260831120000_ingress_reachability
#      added `tunnelId` that way, green here, and stopped dead on the live database with "column tunnelId of
#      relation sandbox contains null values". Prisma records a failure as a WALL, not a skip — `migrate
#      deploy` answers P3009 for every later migration too — so the api's boot chain never reached its second
#      step and the platform served nothing until it was fixed forward by hand
#      (20260901190000_tunnel_id_backfill). Add the column nullable, fill it, then constrain it.
#
#   3. THE MIGRATIONS AND THE SCHEMA AGREE. Replay the whole history into an empty database and diff the result
#      against schema.prisma. Catches the other half of the same class — a schema.prisma edited with no
#      migration written for it — which is equally invisible to a suite whose client is generated from the very
#      file being checked. Skipped, loudly, when no database is offered, so a developer can run 1 and 2 alone.
#
# Together they hold the invariant the deployed database actually depends on: the migration list is append-only,
# every entry on it can apply to a database that has been in use, and replaying the lot produces the schema the
# code is compiled against. The API image re-checks the last one against its OWN database at boot (see
# _platform/api/Dockerfile) — this is the check that keeps that one from ever having something to say.
#
# The clock starts at the commit that added this file. 20260802140000_desktop_handoff still carries the edit
# that caused all of the above, because reverting it would itself be a modified migration — and a check whose
# first act is to exempt something is not a check. Its column is added forward, by
# 20260815120000_desktop_handoff_challenge, which is what every database ends up agreeing on.
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"

ROOT="$(repo_root)"
MIGRATIONS="_platform/prisma/migrations"
cd "$ROOT"

# WHAT THIS IS COMPARED AGAINST, and why it is not simply "main". Work lands on main by DIRECT PUSH here, not
# only through pull requests — so a base of `origin/main` would, on the very push that matters, resolve to the
# commit being pushed: merge-base(HEAD, HEAD) is HEAD, every file would be compared with itself, and the check
# would pass by construction on the one event it exists to police. The caller passes the real predecessor —
# the pull request's base, or the push's `before` — and only the local default falls back to origin/main,
# where a developer comparing their branch to main is exactly right.
BASE="${1:-origin/${GITHUB_BASE_REF:-main}}"

failed=0

# A first push to a branch or a force-push has no predecessor to compare against. Say so and check what can
# still be checked, rather than failing on the shape of the event or — worse — passing in silence.
if [ "$BASE" = "0000000000000000000000000000000000000000" ] || [ -z "$BASE" ]; then
    echo "==> applied migrations are immutable"
    echo "  ↓ skipped — this push has no predecessor commit to compare against."
    MERGE_BASE=""
else
    echo "==> applied migrations are immutable (against $BASE)"
    if ! git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
        echo "error: cannot resolve base ref '$BASE'. In CI, check out with fetch-depth: 0." >&2
        exit 1
    fi
    # The merge base, not the base tip: on a branch that is simply behind, the tip carries migrations this
    # branch has never seen, and every one of them would read as "deleted here".
    MERGE_BASE="$(git merge-base "$BASE" HEAD)"
    if [ "$MERGE_BASE" = "$(git rev-parse HEAD)" ]; then
        echo "error: the base resolves to HEAD itself, so this check would compare every migration with its own" >&2
        echo "  copy and pass whatever the push contains. Pass the predecessor commit — on a push, the SHA the" >&2
        echo "  branch pointed at before it." >&2
        exit 1
    fi
fi

# Keyed by migration NAME (the directory), never by repo path — the directory name is what Prisma records and
# compares, so a tree-wide move that keeps the names is not the failure this check is for, and one that changes
# them is.
name_of() { basename "$(dirname "$1")"; }

while IFS= read -r path; do
    [ -n "$path" ] || continue
    [ -n "$MERGE_BASE" ] || continue
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
done < <([ -n "$MERGE_BASE" ] && git ls-tree -r --name-only "$MERGE_BASE" -- "$MIGRATIONS" | grep '/migration\.sql$' || true)

if [ -n "$MERGE_BASE" ] && [ "$failed" -eq 0 ]; then
    echo "  ✓ all $(git ls-tree -r --name-only "$MERGE_BASE" -- "$MIGRATIONS" | grep -c '/migration\.sql$') migrations on $BASE are unchanged here"
fi

# NEW MIGRATIONS ONLY. History is not re-litigated: the migration that taught this check its lesson is on main
# and stays there byte for byte (check 1 says why), and what it should have said is said forward, by
# 20260901190000_tunnel_id_backfill. Nothing is exempted — a file simply stops being new once it is on the base
# ref, which is the same clock check 1 runs on.
echo "==> new migrations can run on a database that has rows"
if [ -z "$MERGE_BASE" ]; then
    echo "  ↓ skipped — with no predecessor commit, nothing here can be told apart from history."
else
    # A COLUMN CLAUSE is what gets judged, not a statement: `ALTER TABLE x DROP COLUMN a, ADD COLUMN b TEXT NOT
    # NULL` is one statement carrying two, and only the second is the problem. Split on commas at paren depth 0,
    # so a `NUMERIC(10,2)` stays in one piece, and drop `--` comments first — a migration's rationale quotes SQL
    # often enough that scanning it would flag the explanation rather than the code.
    scan_clauses() {
        awk '
            function judge(clause,   upper) {
                upper = toupper(clause)
                if (upper ~ /ADD +COLUMN/ && upper ~ /NOT +NULL/ && upper !~ /DEFAULT/) {
                    gsub(/^ +| +$/, "", clause)
                    print clause
                }
            }
            { line = $0; sub(/--.*/, "", line); gsub(/[ \t]+/, " ", line); sql = sql " " line }
            END {
                depth = 0
                for (i = 1; i <= length(sql); i++) {
                    c = substr(sql, i, 1)
                    if (c == "(") { depth++ } else if (c == ")") { depth-- }
                    if ((c == "," || c == ";") && depth == 0) { judge(clause); clause = "" } else { clause = clause c }
                }
                judge(clause)
            }
        ' "$1"
    }
    fresh=0
    for path in "$MIGRATIONS"/*/migration.sql; do
        [ -f "$path" ] || continue
        if git cat-file -e "$MERGE_BASE:$path" 2>/dev/null; then
            continue
        fi
        name="$(name_of "$path")"
        fresh=$((fresh + 1))
        while IFS= read -r clause; do
            [ -n "$clause" ] || continue
            echo "  ✗ $name — $clause" >&2
            echo "      Postgres accepts this on an EMPTY table only: every row already there would need the" >&2
            echo "      value the statement never gives it. So it passes here, where the database is built" >&2
            echo "      fresh, and stops the deploy on the one that has been in use — where a FAILED migration" >&2
            echo "      also blocks every migration after it (P3009) until someone resolves it by hand." >&2
            echo "      Write the three steps instead: ADD COLUMN nullable, UPDATE it to the value each" >&2
            echo "      existing row implies, ALTER COLUMN … SET NOT NULL. A column no existing row implies a" >&2
            echo "      value for wants a DEFAULT, which fills them for you." >&2
            failed=1
        done < <(scan_clauses "$path")
    done
    if [ "$failed" -eq 0 ]; then
        echo "  ✓ $fresh new migration(s), none adding a column a used database would have to invent a value for"
    fi
fi

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
