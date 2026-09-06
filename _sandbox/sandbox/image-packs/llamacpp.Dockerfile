# llama.cpp's llama-server for the local-model capability — one pinned build serving an OpenAI-compatible /v1
# for one GGUF file (capabilities/handlers/localmodel.ts starts it per entry; the weights are NOT here, they
# download into the workspace cache on add, the whisper-pack precedent). CPU build: the GPU variant is the
# separate llamacpp-cuda pack, overlay-only, because its CUDA runtime is hundreds of MB.
# In the `standard` profile so adding a local model on the published image never asks for a rebuild.
#
# This image ships an amd64 and an arm64 half, each built natively on its own runner, and the same fragment is
# what the daemon composes into an environment overlay on a user's machine — an Apple-silicon Docker host
# builds it arm64. Both have to work, and both now take the same path.
#
# UPSTREAM'S PREBUILT RELEASE, NOT A BUILD FROM SOURCE, and the second reason matters more.
#
# The first reason is cost: compiling this took 158s cold and ~12s with a warm ccache, against 4s to fetch and
# unpack 16MB. It is also the one llama.cpp artifact a rebuild could not avoid paying for, because unlike the
# CUDA pack it rides the published image.
#
# The second reason is CORRECTNESS, and it was a latent bug. A source build here defaults to GGML_NATIVE=ON,
# which compiles ggml with `-march=native` — the instruction set of whatever machine ran the build. That is
# fine for `pnpm build:sandbox` on your own box, and wrong for a PUBLISHED image: an image built on a runner
# newer than the user's hardware ships a llama-server that dies with SIGILL on their CPU, and nothing in the
# pipeline would catch it. Upstream's releases are built with runtime dispatch instead — 14 `libggml-cpu-*.so`
# variants from sse42 up to zen4 and sapphirerapids on x64, eight from armv8.0 up to armv9.2 on arm64, probed
# by the loader on startup — so one artifact per architecture is correct on every host of it. Verified:
# identical completions to the source build on the same weights, and the loader really does probe the
# variants at run time.
#
# The cost of that portability is size: 38MB of binary-plus-libraries against a 15MB static binary, because
# the CPU variants are most of it. Worth 23MB not to ship an image that can crash on somebody's CPU.
#
# THE arm64 HALF WAS A SOURCE BUILD UNTIL THE BASE MOVED TO DEBIAN TRIXIE, and that move is the whole reason
# it is gone. Upstream builds the arm64 release on a newer Ubuntu than the x64 one: the binary asks for
# GLIBC_2.38 and GLIBCXX_3.4.32, bookworm carried glibc 2.36 and libstdc++ from GCC 12, so the tarball fetched,
# the digest checked, the files installed — and then `llama-server --version` answered `not found` for both.
# The x64 asset, built on an older runner, needs no more than glibc 2.34, which is why one half of the same
# release was fine here and the other was not. Trixie carries glibc 2.41 and libstdc++ from GCC 14
# (GLIBCXX_3.4.33), clearing both floors, so the branch and everything it dragged with it — a cmake/ccache
# install, a computed job count to keep ~250 parallel g++ processes from killing the arm64 runner outright,
# five minutes of build time on every image and on every laptop this fragment composes an overlay on — is now
# the same two lines x64 always used.
# ponytail: a base that moves BACKWARDS below glibc 2.38 has to bring that source build back with it.
#
# LAYOUT: everything lands in /opt/llamacpp together, because the prebuilt binary's RUNPATH is `$ORIGIN` — it
# finds its own libraries next to itself, so no ld.so.conf entry and no LD_LIBRARY_PATH are needed.
# /usr/local/bin holds a symlink, which resolves $ORIGIN to the real directory. The CUDA pack deletes that
# symlink before installing its own binary there (see there for why it must), and one layout means one thing
# to delete.
#
# Both sha256s are pinned, which the image's other pinned downloads (cloudflared, yq) do not do. A prebuilt
# BINARY is a different trust proposition from source this image compiles itself: a moved release asset would
# otherwise be executed unnoticed. ponytail: bump all three pins together, each digest belongs to the version.
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
ARG LLAMACPP_SHA256_ARM64=2606bc598c670977e235ed9dd17d27d2cdc3fea07a3e7de5de640b0d7a1356e9
# libgomp1 is ggml's OpenMP runtime and libssl3 is the server's TLS: both are pulled in today by g++ and curl
# in the core image, and both are named here anyway so this pack does not depend on another layer's dependency
# graph. The `--version` at the end is the gate both architectures answer to: an unrunnable binary is the exact
# failure this pack has shipped, and it is invisible until asked.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends libgomp1 libssl3 \
    && install -d /opt/llamacpp \
    && case "$(dpkg --print-architecture)" in \
    amd64) asset=x64; sha="${LLAMACPP_SHA256_X64}" ;; \
    arm64) asset=arm64; sha="${LLAMACPP_SHA256_ARM64}" ;; \
    *) echo "llamacpp pack: unsupported architecture $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/ggml-org/llama.cpp/releases/download/${LLAMACPP_VERSION}/llama-${LLAMACPP_VERSION}-bin-ubuntu-${asset}.tar.gz" -o /tmp/llamacpp.tgz \
    && echo "${sha}  /tmp/llamacpp.tgz" | sha256sum -c - \
    && tar xzf /tmp/llamacpp.tgz -C /tmp \
    && install -m 0755 "/tmp/llama-${LLAMACPP_VERSION}/llama-server" /opt/llamacpp/ \
    && install -m 0644 "/tmp/llama-${LLAMACPP_VERSION}"/lib*.so* /opt/llamacpp/ \
    && install -m 0644 "/tmp/llama-${LLAMACPP_VERSION}/LICENSE" /opt/llamacpp/LICENSE.llama.cpp \
    && rm -rf /tmp/llamacpp.tgz "/tmp/llama-${LLAMACPP_VERSION}" \
    && ln -s /opt/llamacpp/llama-server /usr/local/bin/llama-server \
    && llama-server --version
