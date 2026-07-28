# rtk (rtk-ai/rtk, Apache-2.0) — the alternate output-cleaner backend, benchmarked head-to-head against the
# native filter via the `filterBackend` setting. When that setting is "rtk", the agent's PreToolUse hook rewrites
# each Bash command to `rtk <cmd>` (the native filter is turned off), so rtk runs the command and compresses its
# output. This fragment bakes the binary into the sandbox image overlay; the owner approves + rebuilds out-of-band.
#
# Pin RTK_VERSION to a release you trust and confirm the tarball asset name against
# https://github.com/rtk-ai/rtk/releases before enabling this extension.
ENV RTK_VERSION=0.44.0
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64) target="x86_64-unknown-linux-musl" ;; \
      aarch64) target="aarch64-unknown-linux-gnu" ;; \
      *) echo "rtk: unsupported arch $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/rtk-${target}.tar.gz" -o /tmp/rtk.tar.gz; \
    tar -xzf /tmp/rtk.tar.gz -C /usr/local/bin rtk; \
    rm /tmp/rtk.tar.gz; \
    chmod +x /usr/local/bin/rtk; \
    rtk --version
