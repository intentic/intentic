# The `cli-proxy-api` binary — CLIProxyAPI, the translator that lets the Claude Code harness drive
# Codex/Grok/Kimi/Google models on the user's SUBSCRIPTION OAuth: agent/translator.ts spawns it as the server
# (a routed turn's ANTHROPIC_BASE_URL points at it), and its Management/device flows connect the
# subscriptions. A prebuilt Go release, pinned like the npm CLIs.
# ponytail: bump the pin deliberately; a wire-API or Management-endpoint change surfaces as a translator-only
# failure (native-harness turns never touch it).
# CLIProxyAPI names its arm build `linux_aarch64` where dpkg (and every other asset) says `arm64` — mapped
# below, verified against the release's asset list.
# 7.2.140 is the floor for a REASON, not a routine bump: every earlier pin strips `prompt_cache_retention` in
# each Codex executor separately and misses the compaction call, which is the one request a long turn makes at
# its very end. Upstream moved the strip into the shared request converter, so no Codex path can forward a
# parameter this sandbox never sets. Never pin below it.
RUN version=7.2.140 \
    && arch="$(dpkg --print-architecture)" \
    && case "$arch" in arm64) arch="aarch64" ;; esac \
    && mkdir -p /tmp/cliproxy \
    && curl -fsSL "https://github.com/router-for-me/CLIProxyAPI/releases/download/v${version}/CLIProxyAPI_${version}_linux_${arch}.tar.gz" | tar -xz -C /tmp/cliproxy \
    && install -m 0755 "$(find /tmp/cliproxy -type f -name cli-proxy-api | head -n1)" /usr/local/bin/cli-proxy-api \
    && test -x /usr/local/bin/cli-proxy-api \
    && rm -rf /tmp/cliproxy
