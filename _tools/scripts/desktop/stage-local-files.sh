#!/usr/bin/env bash
# Put what the desktop app's windows on local folders run where the bundlers can see them:
#
#   • intentic-files, the sidecar that serves a folder to those windows (_devices/local-files), compiled with bun
#     for each Rust target triple asked for, as src-tauri/binaries/intentic-files-<triple>[.exe] — the name
#     tauri.conf.json's `externalBin` looks for, and which the installer puts beside the app as intentic-files;
#   • the ONLYOFFICE editor page (_extensions/onlyoffice/dist/editor), which tauri.conf.json's `resources` carry.
#
#   stage-local-files.sh                          # this host's triple
#   stage-local-files.sh x86_64-pc-windows-msvc   # a cross build's
#
# Every cargo command against the app needs both (tauri-build copies the external binary and checks the resource
# glob), so the app's Rust scripts run this first, as they run stage-desktop-scripts.sh. INTENTIC_VERSION stamps
# the binary the way build-agent-binaries.sh stamps the machine agent; unset, it reports the working tree's 0.0.0.
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"

ROOT="$(repo_root)"
BINARIES="$ROOT/_editor/desktop-app/src-tauri/binaries"
VERSION="${INTENTIC_VERSION:-0.0.0}"

if [ ! -f "$ROOT/_extensions/onlyoffice/dist/editor/editor.js" ]; then
    echo "==> building the ONLYOFFICE editor page"
    pnpm --filter @intentic/ext-onlyoffice build
fi

triples=("$@")
if [ "${#triples[@]}" -eq 0 ]; then
    triples=("$(rustc -vV | sed -n 's/^host: //p')")
fi

mkdir -p "$BINARIES"
for triple in "${triples[@]}"; do
    ext=""
    case "$triple" in
        x86_64-unknown-linux-gnu) target=bun-linux-x64 ;;
        aarch64-unknown-linux-gnu) target=bun-linux-arm64 ;;
        x86_64-pc-windows-msvc)
            target=bun-windows-x64
            ext=".exe"
            ;;
        *)
            echo "error: intentic-files has no build for $triple; add its bun target here first." >&2
            exit 1
            ;;
    esac
    out="$BINARIES/intentic-files-$triple$ext"
    echo "==> intentic-files for $triple"
    (cd "$ROOT/_devices/local-files" && bun build src/cli.ts --compile --target="$target" --conditions=@intentic/src \
        --define "INTENTIC_AGENT_VERSION=\"$VERSION\"" --outfile "$out")
    # Shipped inside the installer and run by the app, so it faces the same publisher question as the app itself.
    if [ "$ext" = ".exe" ]; then
        bash "$ROOT/_tools/scripts/build/sign-windows.sh" "$out"
    fi
done
