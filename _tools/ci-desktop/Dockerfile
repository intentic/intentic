# The desktop jobs' image (ghcr.io/intentic/ci-desktop) — desktop-check, desktop-verify and
# release run in this. Same reason ci-base exists, one layer further out: every one of those three jobs opened by
# apt-installing the Tauri build inputs and curl|sh-ing rustup, measured at 2m53s + 41s in release job
# 15686372011 and repeated per job per pipeline. Baked once here, all of it becomes free.
#
# Why a SEPARATE image rather than more lines in ci-base: webkit2gtk's dev headers, clang/llvm and the Windows
# cross-toolchain are ~1.5 GB that the verify, images and images-platform jobs have no use for.
# ci-base stays the small image every job pulls; this one is pulled by the three that build Rust.
#
# ponytail: FROM tracks ci-base's mutable `latest`, so the ci-desktop job below rebuilds when EITHER
# _tools/ci-base or _tools/ci-desktop changes — otherwise this image would silently pin a stale base.
# The base is wherever ci-base was just published — GHCR, which is where the pipeline puts it.
FROM ghcr.io/intentic/ci-base:latest

LABEL org.opencontainers.image.source=https://github.com/intentic/intentic

# The Tauri Linux build inputs, plus the ones that are bundle inputs rather than compiler inputs — the same list
# build-desktop.sh installs at runtime, which is now its fallback path for a developer machine:
#   libwebkit2gtk-4.1-dev …   what tauri/wry compile and link against
#   nsis                      makensis, for the Windows installer the cross-build produces
#   lld llvm clang            cargo-xwin's cross-linker (clang-cl + lld-link)
#   xdg-utils                 the AppImage bundler COPIES the host's xdg-mime into the AppDir; absent host ⇒
#                             "failed to bundle project: xdg-mime binary not found"
#   file                      appimagetool refuses to start without it, surfacing as a contentless
#                             "failed to run linuxdeploy"
#   p7zip-full rpm            not build inputs: verify-desktop-bundle.sh reads back the rpm and the NSIS
#                             installer it just produced, and a verifier that skips when its tool is missing
#                             reports "verified" for a bundle nobody opened
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf \
        build-essential libssl-dev pkg-config nsis lld llvm clang xdg-utils file p7zip-full rpm \
    && rm -rf /var/lib/apt/lists/*

# Rust, in the image rather than in $CARGO_HOME: the jobs point CARGO_HOME at the shared /ci-cache store for the
# registry, and a toolchain living there would be re-downloaded by any job whose PATH does not already have it.
# Splitting them is what makes the toolchain immutable-and-free and the registry shared-and-warm.
#   --profile minimal + rustfmt/clippy = exactly what desktop-check invokes, nothing else.
#   the msvc target + cargo-xwin = the Windows cross-build the release job runs; cargo-xwin from source is a
#   ~200-crate compile, which belongs in a rebuilt-on-change image and not in a release.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --no-modify-path --default-toolchain stable --profile minimal --component rustfmt,clippy \
    && rustup target add x86_64-pc-windows-msvc \
    && cargo install --locked cargo-xwin \
    && rm -rf "$CARGO_HOME/registry" "$CARGO_HOME/git"

# Fail the image build, not some pipeline three days later, if any of the baked tooling is missing.
RUN cargo --version && rustc --version && cargo fmt --version && cargo clippy --version \
    && cargo xwin --version && rustup target list --installed | grep -q x86_64-pc-windows-msvc \
    && pkg-config --exists webkit2gtk-4.1 && command -v makensis && command -v xdg-mime \
    && command -v file && command -v 7z && command -v rpm2archive \
    && node --version && pnpm --version && docker --version
