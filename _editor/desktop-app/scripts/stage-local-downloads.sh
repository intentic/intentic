#!/usr/bin/env bash
# Build the desktop installers from this checkout and stage them into _site/site/public/desktop/
# (gitignored) under the release-stable names — so the LOCAL site serves them and the web app's
# dev "Get it" links (http://localhost:4321/desktop/…) download your local build instead of a
# release. The deployed worker prefers these same asset paths too, so nothing forks between envs.
#
#   pnpm --filter @intentic/desktop-app stage:downloads               # Linux bundles (deb/rpm/AppImage)
#   pnpm --filter @intentic/desktop-app stage:downloads -- --windows  # + Windows NSIS via cargo-xwin
#   pnpm --filter @intentic/desktop-app stage:downloads -- --stage-only  # just copy what's already built
#
# Each bundle is built independently and failures don't abort the rest — whatever succeeded is
# staged, so a missing AppImage prerequisite never blocks the .deb/.rpm downloads.
# Linux bundles need the system webkit2gtk/gtk dev packages (see README) + xdg-utils for AppImage;
# the Windows cross-build needs rustup target x86_64-pc-windows-msvc + cargo-xwin + clang/lld/llvm + nsis.
set -uo pipefail

WINDOWS=0
STAGE_ONLY=0
for arg in "$@"; do
    case "$arg" in
        --windows) WINDOWS=1 ;;
        --stage-only) STAGE_ONLY=1 ;;
        *)
            echo "unknown flag: $arg (use --windows, --stage-only)" >&2
            exit 1
            ;;
    esac
done

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
APP="$ROOT/_editor/desktop-app"
LINUX_BUNDLES="$APP/src-tauri/target/release/bundle"
WIN_BUNDLES="$APP/src-tauri/target/x86_64-pc-windows-msvc/release/bundle"
STAGE="$ROOT/_site/site/public/desktop"

# A configured updater pubkey makes `tauri build` demand the private key — local builds skip
# updater artifacts unless the signing env is present (same guard as _tools/scripts/build-desktop.sh).
CONFIG='{}'
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    CONFIG='{"bundle":{"createUpdaterArtifacts":false}}'
fi

# AppImage bundling on a modern dev box needs three accommodations (each verified on Arch/WSL2):
#  • linuxdeploy is itself an AppImage and FUSE-mounts by default — self-extract instead (no libfuse2).
#  • linuxdeploy's bundled (old) strip chokes on RELR relocations (`unknown type [0x13] section
#    '.relr.dyn'`) in modern distro libs — skip stripping; distro libs ship pre-stripped anyway.
#  • gdk-pixbuf ≥2.44 builds its loaders in, so the pkg-config-advertised external module dir does
#    not exist and the gtk plugin's unconditional copy_tree dies — guard it (patched below).
export APPIMAGE_EXTRACT_AND_RUN=1
export NO_STRIP=true

patch_gtk_plugin() {
    local plugin="$HOME/.cache/tauri/linuxdeploy-plugin-gtk.sh"
    if [ -f "$plugin" ] && grep -q '^copy_tree "\$gdk_pixbuf_binarydir" "\$APPDIR/"$' "$plugin"; then
        perl -i -pe 's{^copy_tree "\$gdk_pixbuf_binarydir" "\$APPDIR/"$}{# intentic: modern gdk-pixbuf builds loaders in (no external module dir) — create the target so the cache write below succeeds\nif [ -d "\$gdk_pixbuf_binarydir" ]; then copy_tree "\$gdk_pixbuf_binarydir" "\$APPDIR/"; else mkdir -p "\$APPDIR\$gdk_pixbuf_binarydir"; fi}' "$plugin"
        echo "==> patched cached linuxdeploy-plugin-gtk.sh for builtin-loaders gdk-pixbuf"
    fi
}

failed=()
build_bundle() {
    local bundle="$1"
    shift
    echo "==> building $bundle"
    if ! pnpm exec tauri build --config "$CONFIG" --bundles "$bundle" "$@"; then
        failed+=("$bundle")
    fi
}

if [ "$STAGE_ONLY" -eq 0 ]; then
    cd "$APP"
    build_bundle deb
    build_bundle rpm
    # linuxdeploy's desktop integration shells into xdg-mime; without it the bundler dies late.
    if command -v xdg-mime >/dev/null 2>&1; then
        patch_gtk_plugin
        build_bundle appimage
    else
        echo "==> skipping AppImage: xdg-mime not found — install xdg-utils (pacman -S xdg-utils / apt-get install xdg-utils)"
        failed+=("appimage")
    fi
    if [ "$WINDOWS" -eq 1 ]; then
        build_bundle nsis --runner cargo-xwin --target x86_64-pc-windows-msvc
    fi
fi

mkdir -p "$STAGE"
staged=0
stage() {
    local pattern="$1" name="$2" source
    # shellcheck disable=SC2086 -- the pattern is meant to glob
    source="$(ls -t $pattern 2>/dev/null | head -1 || true)"
    if [ -n "$source" ]; then
        cp "$source" "$STAGE/$name"
        staged=$((staged + 1))
        echo "staged: $name  ←  ${source#"$ROOT"/}"
    else
        echo "skipped: $name (no bundle at ${pattern#"$ROOT"/})"
    fi
}
stage "$LINUX_BUNDLES/appimage/*.AppImage" "Intentic.AppImage"
stage "$LINUX_BUNDLES/deb/*.deb" "Intentic.deb"
stage "$LINUX_BUNDLES/rpm/*.rpm" "Intentic.rpm"
stage "$WIN_BUNDLES/nsis/*-setup.exe" "Intentic-setup.exe"

if [ "${#failed[@]}" -gt 0 ]; then
    echo
    echo "note: these bundles did not build this run: ${failed[*]} — the staged ones above still serve."
fi
if [ "$staged" -eq 0 ]; then
    echo "error: nothing was staged — fix the build errors above and re-run." >&2
    exit 1
fi

echo
echo "Serve them with the local site (pnpm --filter @intentic-dev/site dev) — the web app's dev"
echo "download links point at http://localhost:4321/desktop/<file>."
