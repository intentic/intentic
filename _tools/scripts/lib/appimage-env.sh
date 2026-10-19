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

# Tauri 2.12.3 downloads these without retrying DNS errors. Seed its cache before compiling/bundling, using the
# release assets' checksums, so a resolver outage retries the download rather than the entire AppImage build.
appimage_fetch_tool() {
    local name="$1" url="$2" sha="$3" cache dest partial
    cache="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
    mkdir -p "$cache"
    dest="$cache/$name"
    if [ -f "$dest" ] && printf '%s  %s\n' "$sha" "$dest" | sha256sum -c - >/dev/null 2>&1; then
        return 0
    fi
    partial="$(mktemp "$cache/$name.XXXXXX")"
    if ! curl -fsSL --retry 5 --retry-all-errors --retry-max-time 180 --connect-timeout 15 --max-time 120 -o "$partial" "$url"; then
        rm -f "$partial"
        return 1
    fi
    if ! printf '%s  %s\n' "$sha" "$partial" | sha256sum -c -; then
        rm -f "$partial"
        return 1
    fi
    chmod +x "$partial"
    mv -f "$partial" "$dest"
}

appimage_fetch_tools() {
    local arch linuxdeploy_arch apprun_sha linuxdeploy_sha
    arch="$(uname -m)"
    linuxdeploy_arch="$arch"
    # ponytail: tools pinned by tauri-cli 2.12.3 (linux/appimage/linuxdeploy.rs); hashes from binary-releases.
    case "$arch" in
        x86_64)
            apprun_sha=f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f
            linuxdeploy_sha=36a2d7e274d12e1050d0e9ecfe11d339ed54720b2bec464c286d53f8b07f5c62 ;;
        aarch64)
            apprun_sha=072f17c0895a85c490282fe5395c5007e5fc75da727e553b3b8fb680feb11578
            linuxdeploy_sha=556ab80baa98e600aa80f0dcedfb70bca0e1ce7e9f147fb345be3fcc3e91b2b1 ;;
        i686)
            linuxdeploy_arch=i386
            apprun_sha=a573a682b1a4a3e9b5dddbd1f5785749b7bba6013149b51ae99d0f123fe11691
            linuxdeploy_sha=fab919e3f88ec4460631f744ed5205bb7965ab4bc2c276227e12db81543afe9a ;;
        arm*)
            arch=armhf
            linuxdeploy_arch=armhf
            apprun_sha=b14d89f0762bcf09fc6af2359d936675928b8833ff52a1aeda68cb28a309f6ba
            linuxdeploy_sha=2dad604a3b8110ff81f6f754d6fe1ba50b92bb75303385ab080966edddee28dd ;;
        *) echo "error: no AppImage tool pins for $arch" >&2; return 1 ;;
    esac
    appimage_fetch_tool "AppRun-$arch" "https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-$arch" "$apprun_sha"
    appimage_fetch_tool "linuxdeploy-07333c6-$linuxdeploy_arch.AppImage" "https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy-07333c6/linuxdeploy-$linuxdeploy_arch.AppImage" "$linuxdeploy_sha"
}
