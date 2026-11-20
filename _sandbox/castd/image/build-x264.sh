#!/bin/sh
# Builds libx264 with the patches in ../patches/x264 into $PREFIX (default /opt/castd), for castd to link instead of
# Debian's libx264-dev. The patches skip the work x264 does on macroblocks castd's damage map marks unchanged: a frame
# where a small area changed encodes in about 40% less time, and the stream comes out bit for bit as stock x264 codes
# it. 0007 lets a reconfigure set the VBV buffer's fill (`rc.f_vbv_buffer_init` above 0), which stock x264 ignores, so
# castd still builds and runs against a stock x264 (the fallback: `apt-get install libx264-dev`): its keyframes and new
# pages then get no more room than the steady buffer.
#
# Pinned to 31e19f92, the commit Debian trixie's libx264-164 is cut from, so the patched library keeps that package's
# soname (libx264.so.164) and a castd built against either runs against either.
set -eu

PREFIX=${PREFIX:-/opt/castd}
X264_REPO=${X264_REPO:-https://code.videolan.org/videolan/x264.git}
X264_COMMIT=${X264_COMMIT:-31e19f92f00c7003fa115047ce50978bc98c3a0d}
PATCHES=$(cd "$(dirname "$0")/../patches/x264" && pwd)
WORK=${WORK:-$(mktemp -d)}
mkdir -p "$WORK"

# nasm: x264's assembly, without which it is several times slower.
command -v nasm >/dev/null || { echo "build-x264: nasm is required" >&2; exit 1; }

git clone --filter=blob:none --no-checkout "$X264_REPO" "$WORK/x264"
cd "$WORK/x264"
git checkout -q "$X264_COMMIT"
for patch in "$PATCHES"/*.patch; do
    git apply "$patch"
done
./configure --prefix="$PREFIX" --enable-shared --enable-pic --disable-cli --disable-lavf --disable-swscale \
    --disable-ffms --disable-gpac --disable-lsmash --disable-opencl
make -j"$(nproc)"
make install
echo "build-x264: patched libx264 installed under $PREFIX/lib"
