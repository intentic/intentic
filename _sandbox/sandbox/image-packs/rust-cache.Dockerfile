# One compiler cache for every conversation's Rust builds, so a new checkout's first build reuses what earlier builds compiled.
# 2026-11-17, the shinobi-society audit: every conversation builds in its own checkout from an empty target/, and
# without a shared cache each one compiled its few hundred dependencies again, at the build queue's 7 GiB price; about
# 25 conversations ran another checkout's binaries instead of waiting. The daemon composes this pack whenever the
# overlay installs a Rust toolchain and sets no RUSTC_WRAPPER of its own (environment/packs/rust-cache-pack.ts), so a Rust
# recipe needs no cache lines; no published profile bakes it, since only Rust sandboxes use it.
# sccache keys a crate by its sources, flags and toolchain, not by the target directory, so every checkout reads and
# fills the same cache on /history (which outlives a restart, where /tmp does not), capped by SCCACHE_CACHE_SIZE and
# counted in Settings -> Storage as a build cache. It caches library crates only: proc-macros, build scripts, binaries
# and the workspace's own incrementally compiled crates still compile in each checkout.
# The wrapper starts one sccache server per mount namespace, on a socket named for it. An isolated conversation sees
# its own checkout at /work and the server runs rustc with the paths it sees, so one server shared over TCP (the
# environment skill's recipe until this pack) built whichever checkout started it: measured that day, a second
# namespace's build failed with "extern location for itoa does not exist", its dependency written into the first one's
# target/. It also closes fds 7, 8 and 9, the build queue's gate and slot locks (bin/queue-run): the server outlives the
# build by its idle timeout (10 minutes), and one started holding a lock kept it from every build queued behind it. Fd 9
# held a build slot (shinobi, 2026-11-05); fd 8, the gate's `running` side, kept every quiet run waiting its whole
# 10-minute wait for "the heavy commands let in before it" while no new heavy command could start (shinobi, 2026-11-24),
# and a server started under a quiet run would have held the gate exclusive for 10 minutes after the benchmark ended.
# RUSTC_WRAPPER names the wrapper through a link called `sccache` (/usr/local/lib/rust-cache/sccache, off the PATH, so
# the wrapper's own `sccache` is still the real one): the cc crate reuses RUSTC_WRAPPER for the C and C++ a build script
# compiles only when the wrapper's file is named sccache, cachepot, buildcache or kache (cc 1.11 rustc_wrapper_fallback).
# Named `rustc-cached`, every checkout and every offload tree compiled a bundled C++ library from scratch: measured
# 2026-11-17 on shinobi-society, whose `duckdb` (features `bundled`) is the build its agents were told never to start at
# the workspace root because it exhausts memory.
RUN set -eu; v=0.10.0; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x86_64; sha=1fbb35e135660d04a2d5e42b59c7874d39b3deb17de56330b25b713ec59f849b ;; \
      arm64) arch=aarch64; sha=d6a1ce4acd02b937cd61bc675a8be029a60f7bc167594c33d75732bbc0a07400 ;; \
      *) echo "rust-cache: sccache publishes no build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    name="sccache-v$v-$arch-unknown-linux-musl"; \
    curl -fsSL "https://github.com/mozilla/sccache/releases/download/v$v/$name.tar.gz" -o /tmp/sccache.tar.gz; \
    echo "$sha  /tmp/sccache.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/sccache.tar.gz --no-same-owner -C /usr/local/bin --strip-components=1 "$name/sccache"; \
    rm -f /tmp/sccache.tar.gz; \
    printf '%s\n' '#!/bin/sh' \
        '# rustc through sccache (the rust-cache pack): one compiler cache on the history volume for every checkout.' \
        '# Plain rustc where that cache cannot be used: no sccache, a fenced turn that sees no /history, or an image build,' \
        '# where the volume is absent and a cache made in the layer would only grow the image.' \
        'dir=${SCCACHE_DIR:-}' \
        'rest=${dir#/}' \
        'volume=/${rest%%/*}' \
        'command -v sccache >/dev/null 2>&1 && [ -n "$dir" ] || exec "$@"' \
        '[ -d "$dir" ] || { [ -d "$volume" ] && mkdir -p "$dir" 2>/dev/null; } || exec "$@"' \
        '[ -w "$dir" ] || exec "$@"' \
        '# One server per mount namespace, on a socket named for it: an isolated conversation sees its own checkout at' \
        '# /work and the server runs rustc with the paths it sees, so a server shared across namespaces builds another tree.' \
        'ns=$(readlink /proc/self/ns/mnt 2>/dev/null) || exec "$@"' \
        'ns=${ns#mnt:?}' \
        'ns=${ns%?}' \
        '[ -n "$ns" ] || exec "$@"' \
        '# Without fds 7, 8 and 9, the build queue gate and slot locks: the server this call may start outlives the build' \
        '# by its idle timeout. The build itself keeps them: Cargo holds its own copies.' \
        'SCCACHE_SERVER_UDS="/tmp/sccache-$ns.sock" exec sccache "$@" 7>&- 8>&- 9>&-' \
        > /usr/local/bin/rustc-cached; \
    chmod 755 /usr/local/bin/rustc-cached; \
    mkdir -p /usr/local/lib/rust-cache; \
    ln -sf /usr/local/bin/rustc-cached /usr/local/lib/rust-cache/sccache; \
    sccache --version
ENV RUSTC_WRAPPER=/usr/local/lib/rust-cache/sccache \
    SCCACHE_DIR=/history/cache/sccache \
    SCCACHE_CACHE_SIZE=30G
