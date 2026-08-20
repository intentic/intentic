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
#   xz-utils                  tar shells out to it, and the zig tarball below is the only .tar.xz here
#   osslsigncode              Authenticode signing FROM LINUX (_tools/scripts/sign-windows.sh). The Windows
#                             installer is cross-built here, so `signtool.exe` does not exist and never will;
#                             this is the tool that signs from a .pfx. The other supported signer is `jsign`,
#                             for a key that lives in a cloud service (Azure Trusted Signing and friends) —
#                             it is Java and is deliberately NOT baked in until that provider is chosen, since
#                             a JRE is ~90 MB in an image every desktop job pulls. Adding it is two lines:
#                             `default-jre-headless` here, and the jsign .deb from its GitHub release.
#                             docs/windows-code-signing.md has the whole decision.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf \
        build-essential libssl-dev pkg-config nsis lld llvm clang xdg-utils file p7zip-full rpm xz-utils \
        osslsigncode \
    && rm -rf /var/lib/apt/lists/*

# Rust, in the image rather than in $CARGO_HOME: the jobs point CARGO_HOME at the shared /ci-cache store for the
# registry, and a toolchain living there would be re-downloaded by any job whose PATH does not already have it.
# Splitting them is what makes the toolchain immutable-and-free and the registry shared-and-warm.
#   --profile minimal + rustfmt/clippy = exactly what desktop-check invokes, nothing else.
#   the msvc target + cargo-xwin = the Windows cross-build the release job runs; cargo-xwin from source is a
#   ~200-crate compile, which belongs in a rebuilt-on-change image and not in a release.
#   the musl + apple targets + cargo-zigbuild = the same trade for the other four `ic` binaries the release
#   attaches (build-ic.sh), and the same reason: a from-source compile does not belong in a release.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --no-modify-path --default-toolchain stable --profile minimal --component rustfmt,clippy \
    && rustup target add x86_64-pc-windows-msvc \
        x86_64-unknown-linux-musl aarch64-unknown-linux-musl x86_64-apple-darwin aarch64-apple-darwin \
    && cargo install --locked cargo-xwin cargo-zigbuild \
    && rm -rf "$CARGO_HOME/registry" "$CARGO_HOME/git"

# zig — the C compiler and linker cargo-zigbuild drives for those four targets: static musl for linux, because
# the connect one-liner runs on whatever distro the user has, and Mach-O for darwin. No Apple SDK is involved
# and none is needed — zig links ic against its own libSystem stub, and the Mach-O comes out with the macOS
# platform load command and the ad-hoc signature that dyld is the thing actually checking for.
#
# Baked because the release job proved the runtime fallback cannot work here: build-ic.sh installs zig with
# `pip3 install ziglang`, and this image carries python3 (node-gyp's) but no pip. prepareCmd died on "zig is
# required for the linux/darwin cross-builds" two and a half minutes in, with every desktop bundle already
# built and the version already computed — every release since the ic CLI landed failed there.
# Version and checksum pinned, like every other tool in these two images.
# ponytail: both shasums come from https://ziglang.org/download/index.json — bump them together.
RUN case "$(dpkg --print-architecture)" in \
        amd64) zig_arch=x86_64 zig_sha=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00 ;; \
        arm64) zig_arch=aarch64 zig_sha=ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17 ;; \
        *) echo "no zig tarball for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://ziglang.org/download/0.16.0/zig-$zig_arch-linux-0.16.0.tar.xz" -o /tmp/zig.tar.xz \
    && echo "$zig_sha  /tmp/zig.tar.xz" | sha256sum -c - \
    && mkdir -p /usr/local/zig \
    && tar -xJf /tmp/zig.tar.xz -C /usr/local/zig --strip-components=1 \
    && rm /tmp/zig.tar.xz \
    && ln -s /usr/local/zig/zig /usr/local/bin/zig

# Fail the image build, not some pipeline three days later, if any of the baked tooling is missing.
RUN cargo --version && rustc --version && cargo fmt --version && cargo clippy --version \
    && cargo xwin --version && cargo-zigbuild --version && zig version \
    && for t in x86_64-pc-windows-msvc x86_64-unknown-linux-musl aarch64-unknown-linux-musl \
                x86_64-apple-darwin aarch64-apple-darwin; do \
        rustup target list --installed | grep -qx "$t" || { echo "missing rust target $t" >&2; exit 1; }; \
    done \
    && pkg-config --exists webkit2gtk-4.1 && command -v makensis && command -v xdg-mime \
    && command -v file && command -v 7z && command -v rpm2archive \
    && node --version && pnpm --version && docker --version
