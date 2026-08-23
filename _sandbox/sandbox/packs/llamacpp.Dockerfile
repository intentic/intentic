# llama.cpp's llama-server for the local-model capability — one pinned build serving an OpenAI-compatible /v1
# for one GGUF file (capabilities/handlers/localmodel.ts starts it per entry; the weights are NOT here, they
# download into the workspace cache on add, the whisper-pack precedent). CPU build: the GPU variant is the
# separate llamacpp-cuda pack, overlay-only, because its CUDA runtime is hundreds of MB.
# In the `standard` profile so adding a local model on the published image never asks for a rebuild.
#
# TWO WAYS IN, ONE PER ARCHITECTURE, AND THE SPLIT IS NOT A PREFERENCE. This image ships an amd64 and an arm64
# half, each built natively on its own runner, and the same fragment is what the daemon composes into an
# environment overlay on a user's machine — an Apple-silicon Docker host builds it arm64. Both have to work.
#
# ON amd64: UPSTREAM'S PREBUILT RELEASE, NOT A BUILD FROM SOURCE, and the second reason matters more.
#
# The first reason is cost: compiling this took 158s cold and ~12s with a warm ccache, against 4s to fetch and
# unpack 16MB. It is also the one llama.cpp artifact a rebuild could not avoid paying for, because unlike the
# CUDA pack it rides the published image.
#
# The second reason is CORRECTNESS, and it was a latent bug. A source build here defaults to GGML_NATIVE=ON,
# which compiles ggml with `-march=native` — the instruction set of whatever machine ran the build. That is
# fine for `pnpm build:sandbox` on your own box, and wrong for a PUBLISHED image: an image built on a runner
# newer than the user's hardware ships a llama-server that dies with SIGILL on their CPU, and nothing in the
# pipeline would catch it. Upstream's release is built with runtime dispatch instead — 14 `libggml-cpu-*.so`
# variants from sse42 up to zen4 and sapphirerapids, probed by the loader on startup — so one artifact is
# correct on every x86-64 host. Verified: identical completions to the source build on the same weights, and
# the loader really does probe the variants at run time.
#
# The cost of that portability is size: 38MB of binary-plus-libraries against a 15MB static binary, because
# the CPU variants are most of it. Worth 23MB not to ship an image that can crash on somebody's CPU.
#
# ON arm64: SOURCE, BECAUSE UPSTREAM'S arm64 ASSET CANNOT RUN ON THIS BASE. There is a matching
# `…-bin-ubuntu-arm64.tar.gz`, and taking it looks like it works: the tarball fetches, the digest checks, the
# files install. Then `llama-server --version` reports `GLIBC_2.38 not found` and `GLIBCXX_3.4.32 not found`.
# Upstream builds the arm64 release on a newer Ubuntu than this image's Debian bookworm base (glibc 2.36,
# libstdc++ from GCC 12), and the x64 release, built on an older one, needs no more than glibc 2.34 — which is
# why one half of the same release is fine here and the other is not. ponytail: when the base moves to a
# distribution with glibc ≥ 2.38, this whole branch collapses into the download above with `asset=arm64`.
#
# GGML_NATIVE=OFF IS THE POINT OF THE FLAG LIST, not a detail of it: it is what keeps the SIGILL story above
# from coming back through this door. The published arm64 half is compiled on a GitHub arm runner, and a
# `-march=native` binary from one is not safe on every arm64 machine that pulls the image. Off, ggml targets
# the armv8-a baseline: slower than a dispatched build on a newer core, and correct on all of them. The rest
# mirrors whisper.Dockerfile, for its reasons — only cmake and ccache are purged after, because g++/make/git
# are baked into this image on purpose and a pack that removes them breaks native installs in /work.
#
# THE JOB COUNT IS COMPUTED, AND THAT IS THE DIFFERENCE BETWEEN THIS BUILDING AND THIS KILLING THE MACHINE
# IT BUILDS ON. `cmake --build -j` with no number forwards a bare `-j` to make, and a bare `-j` means
# UNLIMITED — not "one per core". Checked, because it is the kind of thing everyone assumes the other way: a
# 200-file library built with `-j` starts 200 compilers, and with `-j 4` it starts 4. whisper.Dockerfile
# spells it the bare way and gets away with it, whisper.cpp being a handful of translation units. llama.cpp is
# one per model, ~250 of them, all independent objects of the same target — so make starts the lot, each a g++
# holding several hundred MB. What that did to the arm64 runner that shipped it is in the log: a wall of
# `Building CXX object` inside 30 seconds, five minutes of silence, then `The runner has received a shutdown
# signal`. The HOST died, not the build, so there is no compiler error to find and the job simply stops. A
# 4-vCPU/16GB hosted arm runner cannot hold that, and neither can the laptop this same fragment composes an
# environment overlay on.
#
# So: one job per core, and never more jobs than there is memory to hold them (2 GiB each, comfortably above
# what the widest of these translation units takes). Both halves of that minimum earn their place — cores
# alone still overcommits a small-memory machine, and memory alone would oversubscribe a big machine's cores.
#
# LAYOUT: everything lands in /opt/llamacpp together, because the prebuilt binary's RUNPATH is `$ORIGIN` — it
# finds its own libraries next to itself, so no ld.so.conf entry and no LD_LIBRARY_PATH are needed.
# /usr/local/bin holds a symlink, which resolves $ORIGIN to the real directory. The source build is static and
# needs none of that, and still installs to the same two paths: the CUDA pack deletes that symlink before
# installing its own binary there (see there for why it must), and one layout means one thing to delete.
#
# The sha256 is pinned, which the image's other pinned downloads (cloudflared, yq, zrok) do not do. A prebuilt
# BINARY is a different trust proposition from source this image compiles itself: a moved release asset would
# otherwise be executed unnoticed. ponytail: bump the two pins together, the digest belongs to the version.
#
# WHY THE PIN IS WHERE IT IS, and the class of bug that moves it. llama-server converts every tool's JSON
# schema into a grammar before it will serve a request, and it used to REFUSE a property that names no type
# ({"description": "…"}, which JSON Schema reads as "any value"): "Unrecognized schema", HTTP 500, whole turn
# dead. The harness sends one of those in its own tool set, so nothing the user could pick or configure avoided
# it — every tool-carrying turn against a local model failed on the first request, while the retry watchdog made
# it look like a turn that was merely thinking. Upstream now treats a typeless schema as the free-form value it
# is, which is the floor this pack has to clear: a local model is only useful to an agent that can call tools.
# ponytail: bump the pin deliberately; a llama.cpp server-API change surfaces as a local-model-only failure.
ARG LLAMACPP_VERSION=b10581
ARG LLAMACPP_SHA256_X64=b93bf39a66ce02170417ca03ff2ce4721970594b9b959941a862f45f96cb8c91
# libgomp1 is ggml's OpenMP runtime and libssl3 is the server's TLS: both are pulled in today by g++ and curl
# in the core image, and both are named here anyway so this pack does not depend on another layer's dependency
# graph — the same reason the source build named libgomp1. The `--version` at the end is the gate both branches
# answer to: an unrunnable binary is the exact failure this pack has shipped, and it is invisible until asked.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,target=/root/.cache/ccache \
    apt-get update && apt-get install -y --no-install-recommends libgomp1 libssl3 \
    && install -d /opt/llamacpp \
    && case "$(dpkg --print-architecture)" in \
    amd64) \
        curl -fsSL "https://github.com/ggml-org/llama.cpp/releases/download/${LLAMACPP_VERSION}/llama-${LLAMACPP_VERSION}-bin-ubuntu-x64.tar.gz" -o /tmp/llamacpp.tgz \
        && echo "${LLAMACPP_SHA256_X64}  /tmp/llamacpp.tgz" | sha256sum -c - \
        && tar xzf /tmp/llamacpp.tgz -C /tmp \
        && install -m 0755 "/tmp/llama-${LLAMACPP_VERSION}/llama-server" /opt/llamacpp/ \
        && install -m 0644 "/tmp/llama-${LLAMACPP_VERSION}"/lib*.so* /opt/llamacpp/ \
        && install -m 0644 "/tmp/llama-${LLAMACPP_VERSION}/LICENSE" /opt/llamacpp/LICENSE.llama.cpp \
        && rm -rf /tmp/llamacpp.tgz "/tmp/llama-${LLAMACPP_VERSION}" \
        ;; \
    arm64) \
        apt-get install -y --no-install-recommends cmake ccache g++ make \
        && git clone --depth 1 --branch "${LLAMACPP_VERSION}" https://github.com/ggml-org/llama.cpp /tmp/llama.cpp \
        && cmake -S /tmp/llama.cpp -B /tmp/llama.cpp/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
            -DGGML_NATIVE=OFF -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF \
            -DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache \
        && jobs="$(awk -v cpus="$(nproc)" '/^MemTotal:/ { fits = int($2 / (2 * 1024 * 1024)); if (fits < 1) fits = 1; print (fits < cpus ? fits : cpus) }' /proc/meminfo)" \
        && echo "llamacpp pack: compiling llama.cpp with -j${jobs}" \
        && cmake --build /tmp/llama.cpp/build -j "${jobs}" --target llama-server \
        && ccache --show-stats \
        && install -m 0755 /tmp/llama.cpp/build/bin/llama-server /opt/llamacpp/ \
        && install -m 0644 /tmp/llama.cpp/LICENSE /opt/llamacpp/LICENSE.llama.cpp \
        && rm -rf /tmp/llama.cpp \
        && apt-get purge -y cmake ccache && apt-get autoremove -y \
        ;; \
    *) echo "llamacpp pack: unsupported architecture $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
    && ln -s /opt/llamacpp/llama-server /usr/local/bin/llama-server \
    && llama-server --version
