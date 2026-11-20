#!/bin/sh
# Builds an Xvfb whose XTEST pointer has a vertical and a horizontal scroll axis (../patches/xorg-server-xtest-scroll.patch),
# into $PREFIX/bin/Xvfb (default /opt/castd). castd finds those axes at startup and injects a trackpad's scrolling as
# smooth XI2 scroll motion, pixel for pixel; on a stock Xvfb it falls back to wheel clicks (120 units each), carrying
# what a click could not express to the next scroll event, so nothing is lost, only quantised.
#
# The source is Debian's own xorg-server package when deb-src is enabled (it carries Debian's security fixes), else the
# upstream release of the same version. Only the Xvfb target is built; it uses the system's xkbcomp and keymaps, and
# links nothing the stock `xvfb` package's dependencies do not already bring (install that package beside it).
#
# With GLX, as Debian's own Xvfb has it (2026-11-20): without it Chromium's GPU process exits at start ("GLX is not
# present"), so a person's window on a sandbox with WSL2's GPU (the daemon's window-gpu.ts) could not draw on it and had
# no WebGL at all. Measured on rog: WebGL on the GPU at 60 fps on 0.31 cores at 2560x1600, and a window without a GPU
# scrolling as before (0.20 cores against 0.22). Building it needs Mesa's and libglvnd's headers (mesa-common-dev,
# libgl-dev); it links libGL from libglvnd, which the `xvfb` package depends on anyway.
set -eu

PREFIX=${PREFIX:-/opt/castd}
XORG_VERSION=${XORG_VERSION:-21.1.16}
PATCH=$(cd "$(dirname "$0")/../patches" && pwd)/xorg-server-xtest-scroll.patch
WORK=${WORK:-$(mktemp -d)}
mkdir -p "$WORK"

cd "$WORK"
if apt-get source -qq --only-source xorg-server >/dev/null 2>&1; then
    SRC=$(find . -maxdepth 1 -type d -name 'xorg-server-*' | head -1)
else
    curl -sSfL "https://www.x.org/releases/individual/xserver/xorg-server-$XORG_VERSION.tar.xz" | tar xJ
    SRC=./xorg-server-$XORG_VERSION
fi
cd "$SRC"
patch -p1 < "$PATCH"
meson setup build --prefix="$PREFIX" --buildtype=release \
    -Dxorg=false -Dxephyr=false -Dxnest=false -Dxwin=false -Dxvfb=true -Dxquartz=false \
    -Dglamor=false -Dglx=true -Ddri1=false -Ddri2=false -Ddri3=false -Ddrm=false \
    -Dudev=false -Dudev_kms=false -Dsystemd_logind=false -Dhal=false -Dlibunwind=false -Dsecure-rpc=false \
    -Ddocs=false -Ddevel-docs=false -Dxkb_dir=/usr/share/X11/xkb -Dxkb_bin_dir=/usr/bin \
    -Dxkb_output_dir=/var/lib/xkb
ninja -C build hw/vfb/Xvfb
install -D -m 0755 build/hw/vfb/Xvfb "$PREFIX/bin/Xvfb"
echo "build-xvfb: patched Xvfb installed as $PREFIX/bin/Xvfb"
