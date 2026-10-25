# Pinned CPU-only llama-server for amd64/arm64; weights download separately and GPUs use host endpoints.
# Upstream runtime CPU dispatch avoids -march=native SIGILL. arm64 needs glibc >=2.38 and GLIBCXX_3.4.32; older bases need a source build.
# Keep binary and libraries together in /opt/llamacpp for $ORIGIN; expose the executable through a symlink.
# Bump version and both digests together. Pins must accept typeless tool schemas; server API changes can break local-model tool calls.
ARG LLAMACPP_VERSION=b11146
ARG LLAMACPP_SHA256_X64=c150306eb16b5ab696f76a8bdf810c35fd98a24e82158742e6fa28f420ff8410
ARG LLAMACPP_SHA256_ARM64=4aeda6fe68831547e49b7fa87607383ca5352b3d72ca5f70d52ed265f58c131f
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
