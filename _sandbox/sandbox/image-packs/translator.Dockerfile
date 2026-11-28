# The `cli-proxy-api` binary — CLIProxyAPI, the translator that lets the Claude Code harness drive
# Codex/Grok/Kimi/Google models on the user's SUBSCRIPTION OAuth: agent/translator.ts spawns it as the server
# (a routed turn's ANTHROPIC_BASE_URL points at it), and its Management/device flows connect the
# subscriptions. A prebuilt Go release, pinned like the npm CLIs.
# ponytail: bump the pin deliberately; a wire-API or Management-endpoint change surfaces as a translator-only
# failure (native-harness turns never touch it).
# CLIProxyAPI names its arm build `linux_aarch64` where dpkg (and every other asset) says `arm64` — mapped
# below, verified against the release's asset list.
# Each build's sha256 is recorded with the version, the same two engines.json carries for the daemon's own installs,
# and _tools/scripts/engines/bump-engines.mjs moves them with it; a download that differs fails the build. GitHub's
# own per-asset digest is no substitute: an asset uploaded again gets a new one.
# 7.2.140 is the floor for a REASON, not a routine bump: every earlier pin strips `prompt_cache_retention` in
# each Codex executor separately and misses the compaction call, which is the one request a long turn makes at
# its very end. Upstream moved the strip into the shared request converter, so no Codex path can forward a
# parameter this sandbox never sets. Never pin below it.
RUN version=8.1.8 \
    && case "$(dpkg --print-architecture)" in \
        amd64) arch=amd64; sha=3043da238fe86cd336dc8d30eed727a0ce3e0d30c7f9ee014a50576b2f11c6c8 ;; \
        arm64) arch=aarch64; sha=e0e3da2c044b26639165970d4486650477fd39ec492351542c3dc354944f8b41 ;; \
        *) echo "translator: CLIProxyAPI publishes no Linux build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
    && mkdir -p /tmp/cliproxy \
    && curl -fsSL "https://github.com/router-for-me/CLIProxyAPI/releases/download/v${version}/CLIProxyAPI_${version}_linux_${arch}.tar.gz" -o /tmp/cliproxy.tar.gz \
    && echo "${sha}  /tmp/cliproxy.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/cliproxy.tar.gz --no-same-owner -C /tmp/cliproxy \
    && install -m 0755 "$(find /tmp/cliproxy -type f -name cli-proxy-api | head -n1)" /usr/local/bin/cli-proxy-api \
    && test -x /usr/local/bin/cli-proxy-api \
    && rm -rf /tmp/cliproxy /tmp/cliproxy.tar.gz
