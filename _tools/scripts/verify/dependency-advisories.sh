#!/usr/bin/env bash
# Known security advisories against what the lockfiles pin: pnpm-lock.yaml and every tracked Cargo.lock, read by
# osv-scanner against OSV.dev, which carries GitHub's advisories for npm and RustSec's for crates. One pinned binary
# reads both kinds of lockfile as they are, so neither an install nor `cargo metadata` runs first. (2026-11-24) pnpm
# audit plus cargo-deny was the other option: two tools, one of them compiled by `cargo install` on a cold runner,
# and cargo-deny resolving every one of the twelve crates' metadata before it can read an advisory.
#
# REPORTED, NOT FAILED, for now: ci.yml's `advisories` job and nightly.yml's run it with continue-on-error, so a new
# advisory against a pinned version is a red line in the run and a table in its step summary, never a blocked merge.
# Exit 0 when nothing matched, 1 when something did, 2 when the scan itself could not run.
#
# EXCEPTIONS are osv-scanner's own: an `osv-scanner.toml` beside the lockfile it speaks for (the Tauri app's, today),
# which is also the file the OpenSSF Scorecard workflow reads. Each [[IgnoredVulns]] entry names the advisory `id`, a
# `reason` and the date it is looked at again (`effectiveUntil`, or the older `ignoreUntil`); this script refuses an
# entry missing either, so an exception cannot be a bare id nobody can judge.
#
# Pinned by sha256, checked against the release's own SHA256SUMS when this was written, and kept in the fleet's shared
# cache like lint-workflows.sh's linters: a mount that is absent falls back to .cache/ in the checkout, cold, never
# broken. Re-verify the hash against the release's SHA256SUMS when bumping the version.
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"
cd "$(repo_root)"

OSV_SCANNER_VERSION=2.7.1
OSV_SCANNER_SHA256=fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8

CACHE_ROOT="${DEPENDENCY_SCANNER_DIR:-/ci-cache/dependency-scanners}"
mkdir -p "$CACHE_ROOT" 2>/dev/null || CACHE_ROOT="$(repo_root)/.cache/dependency-scanners"
mkdir -p "$CACHE_ROOT"
SCANNER="$CACHE_ROOT/osv-scanner-$OSV_SCANNER_VERSION/osv-scanner"

# Fetch, verify, publish by rename, so runners racing on one cache never run a half-written binary.
if [ ! -x "$SCANNER" ]; then
    work="$(mktemp -d "$CACHE_ROOT/.osv-scanner.XXXXXX")"
    trap 'rm -rf "$work"' EXIT
    echo "fetch osv-scanner $OSV_SCANNER_VERSION"
    curl -fsSL --retry 3 --retry-delay 2 -o "$work/osv-scanner" \
        "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_linux_amd64" \
        || { echo "osv-scanner $OSV_SCANNER_VERSION: download failed" >&2; exit 2; }
    echo "$OSV_SCANNER_SHA256  $work/osv-scanner" | sha256sum --check --status \
        || { echo "osv-scanner $OSV_SCANNER_VERSION: sha256 mismatch, the release asset is not the bytes this file pins" >&2; exit 2; }
    chmod +x "$work/osv-scanner"
    mkdir -p "$work/staged"
    mv "$work/osv-scanner" "$work/staged/osv-scanner"
    mv -T "$work/staged" "$(dirname "$SCANNER")" 2>/dev/null || true
    [ -x "$SCANNER" ] || { echo "osv-scanner $OSV_SCANNER_VERSION: install did not land at $SCANNER" >&2; exit 2; }
fi

# Every exception says why and until when.
status=0
while IFS= read -r config; do
    bad="$(awk '
        function judge() { if (open && (!reason || !until)) printf "%s:%d  [[IgnoredVulns]] %s needs a reason and an effectiveUntil date\n", FILENAME, line, id }
        /^\[\[IgnoredVulns\]\]/ { judge(); open = 1; line = NR; reason = 0; until = 0; id = "(no id)"; next }
        /^\[/ { judge(); open = 0; next }
        open && /^id *=/ { id = $3 }
        open && /^reason *= *"[^"]+"/ { reason = 1 }
        open && /^(effectiveUntil|ignoreUntil) *=/ { until = 1 }
        END { judge() }
    ' "$config")"
    if [ -n "$bad" ]; then
        echo "$bad" >&2
        status=1
    fi
done < <(git ls-files ':(glob)osv-scanner.toml' ':(glob)**/osv-scanner.toml')

lockfiles=()
while IFS= read -r lockfile; do
    lockfiles+=(--lockfile "$lockfile")
done < <(git ls-files ':(glob)pnpm-lock.yaml' ':(glob)**/pnpm-lock.yaml' ':(glob)Cargo.lock' ':(glob)**/Cargo.lock')
if [ "${#lockfiles[@]}" -eq 0 ]; then
    echo "no pnpm-lock.yaml or Cargo.lock is tracked: nothing to scan" >&2
    exit 2
fi

report="$(mktemp)"
scan=0
"$SCANNER" scan source --format markdown "${lockfiles[@]}" >"$report" || scan=$?
cat "$report"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    { echo "### Dependency advisories (reported, not failed)"; echo; cat "$report"; echo; } >>"$GITHUB_STEP_SUMMARY"
fi
rm -f "$report"
# osv-scanner exits 1 when it matched an advisory and 128 when it found no lockfile; anything else is the scan failing.
case "$scan" in
    0) exit "$status" ;;
    1)
        if [ "${GITHUB_ACTIONS:-}" = true ]; then
            echo "::warning title=dependency advisories::a pinned dependency has a known advisory; the step summary lists each one with the version that fixes it"
        fi
        exit 1
        ;;
    *) echo "osv-scanner exited $scan: the scan did not complete" >&2; exit 2 ;;
esac
