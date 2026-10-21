# Grok Build, xAI's `grok` CLI, which the daemon spawns as `grok agent stdio` to serve a Grok turn on the CLI's own loop
# over the Agent Client Protocol (runtimes/grok-build/). Its source is Apache-2.0 (xai-org/grok-build); the binary is
# xAI's own build, fetched from xAI's CDN as its installer does (https://x.ai/cli/install.sh), never re-hosted. A pack
# rather than part of the standard profile because only a sandbox that signs an xAI account into it runs it, and the
# binary is ~170 MB: Connect installs this pin into the engine store, and once an account is on disk the owner's overlay
# bakes the same copy (runtimes/grok-build `packs`). The daemon sets GROK_DISABLE_AUTOUPDATER, so the pin is what runs.
# xAI names its builds `linux-x86_64` and `linux-aarch64`, the kernel's own words, so `uname -m` maps straight across.
# ponytail: engines.json blesses this pin; bump-engines.mjs moves both.
RUN version=1.0.62 \
    && arch="$(uname -m)" \
    && case "$arch" in arm64) arch="aarch64" ;; esac \
    && curl -fsSL "https://x.ai/cli/grok-${version}-linux-${arch}.gz" | gzip -dc > /usr/local/bin/grok \
    && chmod 0755 /usr/local/bin/grok \
    && grok --version
