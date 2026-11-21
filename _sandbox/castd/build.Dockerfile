# syntax=docker/dockerfile:1
# castd for the sandbox image's browser pack, with the two patched libraries it is fastest with, compiled on the
# image's own Debian release (trixie) and exported as one tree, /opt/castd:
#   bin/castd, bin/castd-bench   the daemon and its bench client
#   bin/Xvfb                     Xvfb whose XTEST pointer has scroll axes (patches/xorg-server-xtest-scroll.patch)
#   lib/libx264.so.164           x264 that skips unchanged macroblocks (patches/x264), castd's rpath points here
# The context is castd's own directory; browser-wire (_sandbox/netd/crates/browser-wire) comes beside it as a named
# context, laid out as in the repository:
#   docker buildx build --file _sandbox/castd/build.Dockerfile \
#     --build-context browser-wire=_sandbox/netd/crates/browser-wire \
#     --output type=local,dest=.image-out/castd _sandbox/castd
# The browser pack then copies the tree in and installs image/runtime-packages.txt (the stock libraries castd also
# links: libyuv, Opus, PulseAudio, and Debian's libx264 as the fallback).
FROM rust:1.98.1-slim-trixie@sha256:f47a8de237dcbb0b0ce1099901e60a89728e3d51f24e664b40e947171538ade7 AS build
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git make patch xz-utils nasm pkg-config clang libclang-dev \
        libx264-dev libyuv-dev libopus-dev libpulse-dev \
        meson ninja-build x11proto-dev xtrans-dev xfonts-utils x11-xkb-utils libpixman-1-dev libxkbfile-dev \
        libxfont-dev libfontenc-dev libfreetype-dev libxcvt-dev libxau-dev libxdmcp-dev libxcb1-dev libxshmfence-dev \
        libgcrypt20-dev libbsd-dev libmd-dev libepoxy-dev libssl-dev mesa-common-dev libgl-dev
COPY image /src/_sandbox/castd/image
COPY patches /src/_sandbox/castd/patches
# The patched libraries first: they change only when their recipe or patches do, so this layer outlives castd edits.
RUN /src/_sandbox/castd/image/build-x264.sh && /src/_sandbox/castd/image/build-xvfb.sh
# NVENC's API headers (ffnvcodec) for the default `nvenc` feature: headers only, the driver's library is opened at
# runtime. A layer of its own, after the libraries above, so adding it did not rebuild them.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends libffmpeg-nvenc-dev
COPY --from=browser-wire . /src/_sandbox/netd/crates/browser-wire
WORKDIR /src/_sandbox/castd
COPY . .
# PKG_CONFIG_PATH puts the patched x264 ahead of Debian's; build.rs embeds /opt/castd/lib as castd's rpath. The image
# gets the binaries stripped (the release profile keeps line tables, for profiling a local build). str0m comes from git
# (Cargo.toml's [patch.crates-io], pinned by rev in Cargo.lock), fetched beside the registry and cached the same way.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/_sandbox/castd/target \
    PKG_CONFIG_PATH=/opt/castd/lib/pkgconfig cargo build --release --locked --bins \
    && install -s -D -m 0755 target/release/castd /opt/castd/bin/castd \
    && install -s -D -m 0755 target/release/castd-bench /opt/castd/bin/castd-bench \
    && rm -rf /opt/castd/include /opt/castd/lib/pkgconfig /opt/castd/share

FROM scratch
COPY --from=build /opt/castd /opt/castd
