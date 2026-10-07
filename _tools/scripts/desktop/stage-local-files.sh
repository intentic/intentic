#!/usr/bin/env bash
# Put what the desktop app's windows on local folders run where the bundlers can see them:
#
#   • intentic-files, the sidecar that serves a folder to those windows (_devices/local-files), compiled with bun
#     for each Rust target triple asked for, as src-tauri/binaries/intentic-files-<triple>[.exe] — the name
#     tauri.conf.json's `externalBin` looks for, and which the installer puts beside the app as intentic-files;
#   • the ONLYOFFICE editor page (_extensions/onlyoffice/dist/editor), which tauri.conf.json's `resources` carry;
#   • for a Windows triple, "Open with Intentic" in Windows 11's context menu (_editor/desktop-app/explorer-menu): its
#     DLL, and when this build signs Windows binaries and knows its certificate's subject (WINDOWS_SIGN_PUBLISHER),
#     the identity package it registers, signed (explorer-menu-msix.mjs). Both land in src-tauri/binaries/explorer-menu/,
#     which tauri.windows.conf.json puts beside the app. Without the package the DLL signs one on the user's PC
#     instead, behind one UAC prompt (explorer-menu/README.md).
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

# "Open with Intentic" for Windows 11's own context menu: the DLL always, the release-signed package when there is a
# certificate to sign it with. A package left from an earlier signed build is removed first, so an unsigned build
# never ships a package whose signature it did not make.
stage_explorer_menu() {
    local crate="$ROOT/_editor/desktop-app/explorer-menu" out="$BINARIES/explorer-menu" target_dir
    target_dir="${CARGO_TARGET_DIR:-$crate/target}"
    rm -rf "$out"
    mkdir -p "$out"
    echo "==> explorer menu DLL"
    case "$(uname -s)" in
        MINGW* | MSYS* | CYGWIN*) cargo build --release --manifest-path "$crate/Cargo.toml" --target x86_64-pc-windows-msvc ;;
        *) cargo xwin build --release --manifest-path "$crate/Cargo.toml" --target x86_64-pc-windows-msvc ;;
    esac
    cp "$target_dir/x86_64-pc-windows-msvc/release/intentic_explorer_menu.dll" "$out/"
    bash "$ROOT/_tools/scripts/build/sign-windows.sh" "$out/intentic_explorer_menu.dll"
    if [ -n "${WINDOWS_SIGN_TOOL:-}" ] && [ -n "${WINDOWS_SIGN_PUBLISHER:-}" ]; then
        echo "==> explorer menu package, signed for ${WINDOWS_SIGN_PUBLISHER}"
        node "$ROOT/_tools/scripts/desktop/explorer-menu-msix.mjs" \
            --publisher "$WINDOWS_SIGN_PUBLISHER" --version "$VERSION" --out "$out/intentic-explorer-menu.msix"
        bash "$ROOT/_tools/scripts/build/sign-windows.sh" "$out/intentic-explorer-menu.msix"
    else
        echo "==> no signed explorer menu package (needs WINDOWS_SIGN_TOOL and WINDOWS_SIGN_PUBLISHER); the DLL signs one on the PC"
    fi
}

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
    if [ "$triple" = "x86_64-pc-windows-msvc" ]; then
        stage_explorer_menu
    fi
done
