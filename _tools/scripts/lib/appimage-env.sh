#!/usr/bin/env bash
# What the AppImage bundler (tauri, which runs linuxdeploy) needs from the environment, said once for every
# script that runs it: build-desktop.sh, verify-desktop-update.sh and the desktop app's stage-local-downloads.sh.
#
#   • APPIMAGE_EXTRACT_AND_RUN: linuxdeploy is itself an AppImage and FUSE-mounts by default. CI containers have
#     no FUSE and a modern dev box often has no libfuse2, so it self-extracts instead.
#   • NO_STRIP: linuxdeploy's bundled strip predates RELR relocations (`unknown type [0x13] section '.relr.dyn'`)
#     in modern distro libraries, which ship pre-stripped anyway.
#   • PATCHELF: linuxdeploy sets an rpath on every ELF in the AppDir, and by default does it with the patchelf
#     bundled inside it, which is 0.8. On a bun 1.4.3 `--compile` binary (intentic-files, stage-local-files.sh)
#     that rewrite leaves a file the loader cannot map: `ldd` exits 1, which is how the gtk plugin's second
#     linuxdeploy pass died ("Failed to run ldd: exited with code 1", nightly run 38128740282), and the sidecar
#     itself segfaults on start. bun 1.4.2's output survived the same rewrite, so nothing failed until the bump.
#     A current patchelf (0.18, Debian's, in the ci-desktop image) rewrites the same binary into one that loads
#     and runs, and linuxdeploy uses whichever patchelf $PATCHELF names.
#
# Source this and call appimage_env. It fails when there is no patchelf on PATH, rather than letting linuxdeploy
# fall back to the one that breaks the sidecar without a word: the bundle would still build.
appimage_env() {
    export APPIMAGE_EXTRACT_AND_RUN=1
    export NO_STRIP=true
    local patchelf
    patchelf="$(command -v patchelf || true)"
    if [ -z "$patchelf" ]; then
        echo "error: no patchelf on PATH. linuxdeploy would fall back to its bundled 0.8, which corrupts the bun-compiled intentic-files sidecar; install patchelf (apt-get install patchelf / pacman -S patchelf)." >&2
        return 1
    fi
    export PATCHELF="$patchelf"
}
