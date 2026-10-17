#!/usr/bin/env bash
# Put what the desktop app's windows on local folders run where the bundlers can see them:
#
#   • intentic-files, the sidecar that serves a folder to those windows (_devices/local-files), compiled with bun
#     for each Rust target triple asked for, as src-tauri/binaries/intentic-files-<triple>[.exe] — the name
#     tauri.conf.json's `externalBin` looks for, and which the installer puts beside the app as intentic-files;
#   • the ONLYOFFICE editor page (_extensions/onlyoffice/dist/editor), which tauri.conf.json's `resources` carry;
#   • ripgrep, which a folder's search runs, into src-tauri/binaries/search/ (`resources` again; see stage_search);
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

# ripgrep, what a folder's search runs (_devices/local-files/src/ripgrep.ts), into src-tauri/binaries/search/, which
# tauri.conf.json's `resources` carry and the app names to the sidecar (sidecar.rs `--search-tools`). Windows gets its
# own rg.exe and, as rg-linux, a static Linux rg that runs inside a WSL distro for a folder that lives there; Linux gets
# its own rg. Pinned to a release and checked against the sha256 GitHub publishes for each asset; downloaded once into
# a cache. Without it the sidecar reads a folder itself, which across a WSL share takes 37 s where rg in the distro
# takes 0.13 s (measured 2026-10-17).
RG_VERSION=15.2.0
RG_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/intentic/ripgrep/$RG_VERSION"
SEARCH="$BINARIES/search"

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

# stage_rg <asset> <sha256> <name in search/>: the release asset's rg, unpacked as <name>.
stage_rg() {
    local asset="$1" sha="$2" name="$3" archive="$RG_CACHE/$1" inner="${1%.zip}"
    inner="${inner%.tar.gz}"
    mkdir -p "$RG_CACHE"
    if [ ! -f "$archive" ] || [ "$(sha256_of "$archive")" != "$sha" ]; then
        echo "==> ripgrep $RG_VERSION: $asset"
        curl -fsSL --retry 3 -o "$archive.part" "https://github.com/BurntSushi/ripgrep/releases/download/$RG_VERSION/$asset"
        if [ "$(sha256_of "$archive.part")" != "$sha" ]; then
            echo "error: $asset does not match its pinned sha256 ($sha); refusing to ship it." >&2
            rm -f "$archive.part"
            exit 1
        fi
        mv "$archive.part" "$archive"
    fi
    case "$asset" in
        *.zip)
            if command -v unzip >/dev/null 2>&1; then
                unzip -p "$archive" "$inner/rg.exe" >"$SEARCH/$name"
            else
                python3 -c 'import sys, zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))' "$archive" "$inner/rg.exe" >"$SEARCH/$name"
            fi
            ;;
        *) tar -xzOf "$archive" "$inner/rg" >"$SEARCH/$name" ;;
    esac
    chmod +x "$SEARCH/$name"
    # The licence travels with the binary (ripgrep is MIT or Unlicense, at the user's choice).
    case "$asset" in
        *.zip) unzip -p "$archive" "$inner/LICENSE-MIT" >"$SEARCH/ripgrep-LICENSE-MIT" 2>/dev/null || true ;;
        *) tar -xzOf "$archive" "$inner/LICENSE-MIT" >"$SEARCH/ripgrep-LICENSE-MIT" ;;
    esac
}

stage_search() {
    case "$1" in
        x86_64-pc-windows-msvc)
            stage_rg "ripgrep-$RG_VERSION-x86_64-pc-windows-msvc.zip" 71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5 rg.exe
            bash "$ROOT/_tools/scripts/build/sign-windows.sh" "$SEARCH/rg.exe"
            stage_rg "ripgrep-$RG_VERSION-x86_64-unknown-linux-musl.tar.gz" 33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c rg-linux
            ;;
        x86_64-unknown-linux-gnu)
            stage_rg "ripgrep-$RG_VERSION-x86_64-unknown-linux-musl.tar.gz" 33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c rg
            ;;
        aarch64-unknown-linux-gnu)
            stage_rg "ripgrep-$RG_VERSION-aarch64-unknown-linux-gnu.tar.gz" a740b91c82eaf9914cfedd353572f2791cbe0162c84101ee0951058f4dcbc90d rg
            ;;
    esac
}

mkdir -p "$BINARIES"
# Emptied first, so no tools staged for another target's build ship beside this one's.
rm -rf "$SEARCH"
mkdir -p "$SEARCH"
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
    stage_search "$triple"
    if [ "$triple" = "x86_64-pc-windows-msvc" ]; then
        stage_explorer_menu
    fi
done
